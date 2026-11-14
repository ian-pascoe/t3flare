// The Model endpoints' store (SPI-1162; draft ADR-0034): the owner's endpoints as their own entity in the Environment DO's
// storage, under their own key with their own revision, apart from the Harness settings and the Environment settings
// (ADR-0032), so a change to one never makes another's readers take it again. Sessions take a new revision at a turn's
// start; the Pi Durable picker reads it at once.
//
// The entity holds no secret. An endpoint's API key is sealed apart from it (credentials/sealed.ts), write-only: what
// the panel shows is that it is set, when, and its fingerprint. `resolve` gives an endpoint with its key to a caller in
// this object that uses it (a Session's credential request; the model relay, SPI-1167).
import {
  EMPTY_ENDPOINTS,
  endpointModelOf,
  type EndpointInput,
  type EndpointModel,
  type EndpointModelInput, MAX_ENDPOINTS, type ModelEndpoint, type ModelEndpoints, validateEndpoint } from "@t3flare/models/endpoints";
import { knownModel } from "@t3flare/models/known";

import { CredentialsKeyMissing, type SealedMark, type SealedStore } from "../credentials/sealed.ts";
import type { KvStorage } from "../harness/store.ts";

export const ENDPOINTS_KEY = "t3flare:endpoints:settings";

/** The sealed name of an endpoint's API key. */
export const endpointKeyName = (id: string): string => `endpoint/${id}/api-key`;

export type EndpointSave =
  | { readonly ok: true; readonly endpoints: ModelEndpoints; readonly endpoint: ModelEndpoint; readonly before: ModelEndpoint | undefined; readonly added: boolean; readonly key: SealedMark }
  | { readonly ok: false; readonly error: string };

export type EndpointRemove = { readonly ok: true; readonly endpoints: ModelEndpoints; readonly removed: ModelEndpoint } | { readonly ok: false; readonly error: string };

export interface EndpointStore {
  /** Whether the Environment has a credentials key, without which no API key is stored. */
  readonly sealing: boolean;
  load(): ModelEndpoints;
  /**
   * Adds the endpoint, or edits the one with its id (ids never change). `apiKey`: a value replaces the key, absent (or
   * empty) keeps it. An API-key endpoint must end with a key; one with no auth keeps none.
   */
  save(input: unknown, key: { readonly apiKey?: string }): Promise<EndpointSave>;
  remove(id: string): EndpointRemove;
  keyMark(id: string): SealedMark;
  apiKey(id: string): Promise<string | undefined>;
  /** An endpoint with its key, for a caller here that uses it. */
  resolve(id: string): Promise<{ readonly endpoint: ModelEndpoint; readonly apiKey: string | undefined } | undefined>;
}

/** Each model with its metadata, pi-ai's where its catalog knows the model (the owner's own fields win). */
export const modelsWithMetadata = (endpoint: { readonly api: string; readonly baseUrl: string }, models: ReadonlyArray<EndpointModelInput>): Array<EndpointModel> =>
  models.map((model) => endpointModelOf(model, knownModel(model.id, endpoint)));

/** The endpoint as stored. */
const withMetadata = (input: EndpointInput): ModelEndpoint => ({ ...input, models: modelsWithMetadata(input, input.models) });

export const endpointStore = (kv: KvStorage, sealed: SealedStore): EndpointStore => {
  const load = (): ModelEndpoints => kv.get<ModelEndpoints>(ENDPOINTS_KEY) ?? EMPTY_ENDPOINTS;
  const keyMark = (id: string) => sealed.mark(endpointKeyName(id));
  return {
    sealing: sealed.available,
    load,
    keyMark,
    save: async (input, { apiKey }) => {
      const valid = validateEndpoint(input);
      if (!valid.ok) return valid;
      const current = load();
      const before = current.endpoints.find((entry) => entry.id === valid.endpoint.id);
      if (before === undefined && current.endpoints.length >= MAX_ENDPOINTS) return { ok: false, error: `at most ${MAX_ENDPOINTS} endpoints` };
      const given = apiKey === undefined || apiKey === "" ? undefined : apiKey;
      if (valid.endpoint.auth === "none" && given !== undefined) return { ok: false, error: "an endpoint with no auth takes no API key" };
      if (valid.endpoint.auth === "api-key" && given === undefined && !keyMark(valid.endpoint.id).set) return { ok: false, error: "an API-key endpoint needs its API key" };
      if (given !== undefined) {
        if (given.length > 4096 || /\s/.test(given)) return { ok: false, error: "the API key is one word of up to 4096 characters" };
        try {
          await sealed.put(endpointKeyName(valid.endpoint.id), given);
        } catch (error) {
          if (error instanceof CredentialsKeyMissing) return { ok: false, error: error.message };
          throw error;
        }
      }
      if (valid.endpoint.auth === "none") sealed.remove(endpointKeyName(valid.endpoint.id));
      const endpoint = withMetadata(valid.endpoint);
      const endpoints: ModelEndpoints = {
        revision: current.revision + 1,
        endpoints: before === undefined ? [...current.endpoints, endpoint] : current.endpoints.map((entry) => (entry.id === endpoint.id ? endpoint : entry)),
      };
      kv.put(ENDPOINTS_KEY, endpoints);
      return { ok: true, endpoints, endpoint, before, added: before === undefined, key: keyMark(endpoint.id) };
    },
    remove: (id) => {
      const current = load();
      const removed = current.endpoints.find((entry) => entry.id === id);
      if (removed === undefined) return { ok: false, error: `no endpoint ${id}` };
      const endpoints: ModelEndpoints = { revision: current.revision + 1, endpoints: current.endpoints.filter((entry) => entry.id !== id) };
      kv.put(ENDPOINTS_KEY, endpoints);
      sealed.remove(endpointKeyName(id));
      return { ok: true, endpoints, removed };
    },
    apiKey: (id) => sealed.open(endpointKeyName(id)),
    resolve: async (id) => {
      const endpoint = load().endpoints.find((entry) => entry.id === id);
      if (endpoint === undefined) return undefined;
      return { endpoint, apiKey: endpoint.auth === "none" ? undefined : await sealed.open(endpointKeyName(id)) };
    },
  };
};
