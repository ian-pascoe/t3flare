// @effect-diagnostics globalConsole:off globalTimers:off globalDate:off
// A Session's Model endpoints (SPI-1162): the endpoints it last took, kept secret-free in its storage so a restart has the
// same providers; their providers installed in the Session's models in place; and their keys, asked of the Environment at
// use time (ADR-0018) and kept in memory only, never in storage.
import type { MutableModels, FetchFunction } from "@earendil-works/pi-ai";
import { EMPTY_ENDPOINTS, type EndpointCredential, type ModelEndpoints } from "@t3flare/models/endpoints";

import { endpointProviders } from "./models.ts";

/** The Model endpoints the Session last took, secret-free. */
export const ENDPOINTS_KEY = "t3flare:model-endpoints";
/** How long an endpoint's key is kept in memory before it is asked for again. */
export const ENDPOINT_KEY_TTL_MS = 5 * 60 * 1000;

/** The Environment's answers (`EnvironmentRpc`). */
export interface EndpointSource {
  modelEndpoints(): Promise<ModelEndpoints>;
  endpointCredential(input: { readonly endpointId: string }): Promise<EndpointCredential>;
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
}

export class SessionEndpoints {
  readonly #options: SessionEndpointsOptions;
  /** The endpoints whose providers the models have. */
  #ids: ReadonlySet<string> = new Set();
  /** Keys in memory only. */
  readonly #keys = new Map<string, { readonly credential: EndpointCredential; readonly at: number }>();

  constructor(options: SessionEndpointsOptions) {
    this.#options = options;
    this.#install(options.kv.get<ModelEndpoints>(ENDPOINTS_KEY) ?? EMPTY_ENDPOINTS);
  }

  /** One provider per endpoint, in place: a removed endpoint's goes, so its models fail as unavailable. */
  #install(endpoints: ModelEndpoints): void {
    const providers = endpointProviders(endpoints, { credential: (id) => this.#credential(id), ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }) });
    const next = new Set(providers.map((provider) => provider.id));
    for (const id of this.#ids) if (!next.has(id)) this.#options.models.deleteProvider(id);
    for (const provider of providers) this.#options.models.setProvider(provider);
    this.#ids = next;
    this.#keys.clear();
  }

  /** An endpoint's key, from memory while fresh, else from the Environment. */
  async #credential(endpointId: string): Promise<EndpointCredential> {
    const now = this.#options.now ?? Date.now;
    const kept = this.#keys.get(endpointId);
    if (kept !== undefined && now() - kept.at < ENDPOINT_KEY_TTL_MS) return kept.credential;
    const credential = await this.#options.source().endpointCredential({ endpointId });
    this.#keys.set(endpointId, { credential, at: now() });
    return credential;
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
