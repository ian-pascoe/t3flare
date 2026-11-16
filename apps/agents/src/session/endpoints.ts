// @effect-diagnostics globalConsole:off globalTimers:off globalDate:off
// A Session's Model endpoints (SPI-1162): the endpoints it last took, kept secret-free in its storage so a restart has the
// same providers; their providers installed in the Session's models in place; and their keys, asked of the Environment at
// use time (ADR-0018) and kept in memory only, never in storage. A sign-in endpoint's access token (SPI-1164) comes the
// same way, from the Credential broker, and is kept no later than shortly before its expiry, and dropped on a 401 or the
// endpoint's sign-out. Each request for a key names the target the Session will send it to (API, base URL, headers), and
// the Environment gives it only for the endpoint's target now: a Session still holding an endpoint the owner moved gets no
// key for the old target.
import type { MutableModels, FetchFunction } from "@earendil-works/pi-ai";
import {
  EMPTY_ENDPOINTS,
  type EndpointCredential,
  type EndpointCredentialRequest,
  type EndpointTarget,
  type ModelEndpoints,
  targetKey,
} from "@t3flare/models/endpoints";
import { type UsageEntry, usageOfPiAnswer } from "@t3flare/models/usage";
import type { EndpointCredentialFailure } from "@t3flare/session-protocol";

import { endpointProviders } from "./models.ts";

/** The Model endpoints the Session last took, secret-free. */
export const ENDPOINTS_KEY = "t3flare:model-endpoints";
/** How long an endpoint's key is kept in memory before it is asked for again. */
export const ENDPOINT_KEY_TTL_MS = 5 * 60 * 1000;
/**
 * A sign-in's access token is kept no later than this before its expiry (SPI-1164): the broker renews one with less than
 * five minutes left, so the next ask after this gets the renewed token.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 2 * 60 * 1000;

/** The Environment's answers (`EnvironmentRpc`). */
export interface EndpointSource {
  modelEndpoints(): Promise<ModelEndpoints>;
  endpointCredential(input: EndpointCredentialRequest): Promise<EndpointCredential>;
}

export interface SessionEndpointsOptions {
  readonly kv: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
  readonly models: MutableModels;
  /** A fresh stub per call. */
  readonly source: () => EndpointSource;
  readonly fetch?: FetchFunction;
  /** How long a turn's start waits for the endpoints. */
  readonly readMs: number;
  readonly now?: () => number;
  /**
   * A credential request failed (the typed failure), or one that had failed succeeded again (undefined): the Session
   * records it on the running turn for the differ (SPI-1164). Called on a change only.
   */
  readonly onCredential?: (failure: EndpointCredentialFailure | undefined) => void;
  /** SPI-1173: each answer on an endpoint, as a usage record of the Durable agent in this Session. */
  readonly usage?: { readonly session: () => string; readonly record: (entry: UsageEntry) => void };
}

export class SessionEndpoints {
  readonly #options: SessionEndpointsOptions;
  /** The endpoints whose providers the models have. */
  #ids: ReadonlySet<string> = new Set();
  /**
   * Keys in memory only, by endpoint and target: an answer for an old target (one that lands after a newer install) is
   * never used for another.
   */
  readonly #keys = new Map<string, { readonly credential: EndpointCredential; readonly until: number; readonly endpointId: string }>();
  /** The endpoints whose last credential request failed. */
  readonly #failing = new Set<string>();

  constructor(options: SessionEndpointsOptions) {
    this.#options = options;
    this.#install(options.kv.get<ModelEndpoints>(ENDPOINTS_KEY) ?? EMPTY_ENDPOINTS);
  }

  /** One provider per endpoint, in place: a removed endpoint's goes, so its models fail as unavailable. */
  #install(endpoints: ModelEndpoints): void {
    const providers = endpointProviders(endpoints, {
      credential: (id, target) => this.#credential(id, target),
      refused: (id) => void this.drop(id),
      outcome: (failure, id) => {
        if (failure !== undefined) {
          this.#failing.add(id);
          this.#options.onCredential?.(failure);
        } else if (this.#failing.delete(id)) this.#options.onCredential?.(undefined);
      },
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      ...(this.#options.usage === undefined ? {} : { answered: (message, endpointId) => this.#answered(message, endpointId) }),
    });
    const next = new Set(providers.map((provider) => provider.id));
    for (const id of this.#ids) if (!next.has(id)) this.#options.models.deleteProvider(id);
    for (const provider of providers) this.#options.models.setProvider(provider);
    this.#ids = next;
    this.#keys.clear();
  }

  #answered(message: Parameters<typeof usageOfPiAnswer>[0], endpointId: string): void {
    const usage = this.#options.usage;
    if (usage === undefined) return;
    const entry = usageOfPiAnswer(message, { agent: "durable", endpointId, session: usage.session(), now: (this.#options.now ?? Date.now)() });
    if (entry !== undefined) usage.record(entry);
  }

  /** An endpoint's key for `target`, from memory while fresh, else from the Environment (a refusal is never kept). */
  async #credential(endpointId: string, target: EndpointTarget): Promise<EndpointCredential> {
    const now = this.#options.now ?? Date.now;
    const cacheKey = JSON.stringify([endpointId, targetKey(target)]);
    const kept = this.#keys.get(cacheKey);
    if (kept !== undefined && now() < kept.until) return kept.credential;
    const credential = await this.#options.source().endpointCredential({ endpointId, target });
    if (credential.apiKey !== null) {
      // A sign-in's token is kept no later than shortly before it expires; a key, for the TTL.
      const until = Math.min(now() + ENDPOINT_KEY_TTL_MS, credential.expiresAt === undefined ? Number.POSITIVE_INFINITY : credential.expiresAt - TOKEN_EXPIRY_MARGIN_MS);
      this.#keys.set(cacheKey, { credential, until, endpointId });
    }
    return credential;
  }

  /**
   * Drops what is kept for `endpointId` (its sign-out, or a 401 on its token, SPI-1164): its next request asks the
   * Environment again. Whether anything was kept.
   */
  drop(endpointId: string): boolean {
    let dropped = false;
    for (const [key, kept] of this.#keys) {
      if (kept.endpointId !== endpointId) continue;
      this.#keys.delete(key);
      dropped = true;
    }
    return dropped;
  }

  /**
   * The Environment's endpoints at a turn's start: a new revision is kept (secret-free) and its providers installed, so
   * a changed model list or a removed endpoint is in force from this turn. Bounded; on failure the Session keeps what it
   * has. Never throws.
   */
  async take(): Promise<void> {
    try {
      const endpoints = await Promise.race([
        this.#options.source().modelEndpoints(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), this.#options.readMs)),
      ]);
      if (endpoints === undefined) return console.warn(JSON.stringify({ t3flare: "model-endpoints-timeout" }));
      if ((this.#options.kv.get<ModelEndpoints>(ENDPOINTS_KEY) ?? EMPTY_ENDPOINTS).revision === endpoints.revision) return;
      this.#options.kv.put(ENDPOINTS_KEY, endpoints);
      this.#install(endpoints);
      console.log(JSON.stringify({ t3flare: "model-endpoints", revision: endpoints.revision, endpoints: endpoints.endpoints.length }));
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "model-endpoints-failed", error: String(error).slice(0, 300) }));
    }
  }
}
