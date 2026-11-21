// @effect-diagnostics globalConsole:off globalTimers:off
// A Session's Model endpoints (SPI-1162): the endpoints it last took, kept secret-free in its storage so a restart has
// the same providers; their providers installed in the Session's models in place; and their keys, asked of the
// Environment at use time (ADR-0018) and kept in memory only, never in storage. A sign-in endpoint's access token
// (SPI-1164) comes the same way, from the Credential broker, and is kept no later than shortly before its expiry, and
// dropped on a 401 or the endpoint's sign-out. Each request for a key names the target the Session will send it to
// (API, base URL, headers), and the Environment gives it only for the endpoint's target now: a Session still holding an
// endpoint the owner moved gets no key for the old target.
import { type AssistantMessage, createModels, type FetchFunction, type MutableModels } from "@earendil-works/pi-ai";
import {
  EMPTY_ENDPOINTS,
  type EndpointCredential,
  type EndpointCredentialRequest,
  type EndpointTarget,
  type ModelEndpoint,
  type ModelEndpoints,
  targetKey,
  targetOf,
} from "@t3flare/models/endpoints";
import type { LimitReading } from "@t3flare/models/limits";
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
  /** Each answer on an endpoint, as a usage record of the Durable agent in this Session (SPI-1173). */
  readonly usage: { readonly session: () => string; readonly record: (entry: UsageEntry) => void };
  /** Each answer's limit windows on an endpoint, for t3's limit meters (SPI-1174). */
  readonly limits: (reading: LimitReading) => void;
}

export class SessionEndpoints {
  readonly #options: SessionEndpointsOptions;
  /** The endpoints whose providers the models have, by id. */
  #endpoints: ReadonlyMap<string, ModelEndpoint> = new Map();
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

  /** Every answer on an endpoint, as a usage record of the Durable agent in this Session (SPI-1173). */
  #answered(message: AssistantMessage, endpointId: string): void {
    const { usage, now = Date.now } = this.#options;
    const entry = usageOfPiAnswer(message, { agent: "durable", endpointId, session: usage.session(), now: now() });
    if (entry !== undefined) usage.record(entry);
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
      answered: (message, endpointId) => this.#answered(message, endpointId),
      limits: this.#options.limits,
    });
    const next = new Map(endpoints.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    for (const id of this.#endpoints.keys()) if (!next.has(id)) this.#options.models.deleteProvider(id);
    for (const provider of providers) this.#options.models.setProvider(provider);
    this.#endpoints = next;
    this.#keys.clear();
  }

  /** The endpoints the Session last took (secret-free): the default model and the model settings resolve over them. */
  current(): ModelEndpoints {
    return this.#options.kv.get<ModelEndpoints>(ENDPOINTS_KEY) ?? EMPTY_ENDPOINTS;
  }

  /**
   * Models apart from the turns' (prompt suggestions): a
   * provider per endpoint the Session holds, its key from the same memory, each answer a usage record, but no recording
   * fetch, so a failed answer never lands in a turn's record.
   */
  sideModels(): MutableModels {
    const models = createModels();
    for (const provider of endpointProviders(this.current(), {
      credential: (id, target) => this.#credential(id, target),
      refused: (id) => void this.drop(id),
      answered: (message, endpointId) => this.#answered(message, endpointId),
    })) {
      models.setProvider(provider);
    }
    return models;
  }

  /** An installed endpoint's credential for its target now (`web_search`'s, SPI-1176), as a model request asks for it. */
  credential(endpoint: ModelEndpoint): Promise<EndpointCredential> {
    return this.#credential(endpoint.id, targetOf(endpoint));
  }

  /**
   * The installed endpoint a model's provider names (secret-free), for classifying its failed answers by its API and
   * auth (SPI-1172); undefined for an endpoint no longer installed.
   */
  endpoint(id: string): ModelEndpoint | undefined {
    return this.#endpoints.get(id);
  }

  /** The credentials held for `endpointId` now (keys or tokens, in memory only), for redacting its error text (SPI-1172). */
  secrets(endpointId: string): ReadonlyArray<string> {
    return [...this.#keys.values()].flatMap((kept) => (kept.endpointId === endpointId && kept.credential.apiKey !== null ? [kept.credential.apiKey] : []));
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
