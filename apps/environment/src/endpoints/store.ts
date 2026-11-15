// The Model endpoints' store (SPI-1162; draft ADR-0034): the owner's endpoints as their own entity in the Environment DO's
// storage, under their own key with their own revision, apart from the Harness settings and the Environment settings
// (ADR-0032), so a change to one never makes another's readers take it again. Sessions take a new revision at a turn's
// start; the Pi Durable picker reads it at once.
//
// The entity holds no secret. An endpoint's API key is sealed apart from it (credentials/sealed.ts), write-only: what
// the panel shows is that it is set, when, its fingerprint, and whether it still opens. A saved key goes only to the
// target it was saved with (API, base URL and headers, `sameTarget`): an edit that moves any of them must give the key
// again. A sealed key exists only beside its endpoint: every check runs before a key is sealed, and a key left without
// one is removed. `resolve` gives an endpoint with its key to a caller in this object that uses it (a Session's
// credential request; the model relay, SPI-1167); the endpoint it returns is the key's target.
import {
  EMPTY_ENDPOINTS,
  type EndpointApi,
  type EndpointCredential,
  type EndpointCredentialRequest,
  endpointModelOf,
  type EndpointInput,
  type EndpointModel,
  type EndpointModelInput,
  MAX_ENDPOINTS,
  type ModelEndpoint,
  type ModelEndpoints,
  sameTarget,
  validateEndpoint,
} from "@t3flare/models/endpoints";
import { knownModel } from "@t3flare/models/known";

import { CredentialsKeyMissing, type SealedMark, type SealedStore } from "../credentials/sealed.ts";
import type { KvStorage } from "../harness/keys.ts";

export const ENDPOINTS_KEY = "t3flare:endpoints:settings";

/** The sealed name of an endpoint's API key. */
export const endpointKeyName = (id: string): string => `endpoint/${id}/api-key`;

export type EndpointSave =
  | { readonly ok: true; readonly endpoints: ModelEndpoints; readonly endpoint: ModelEndpoint; readonly before: ModelEndpoint | undefined; readonly added: boolean; readonly key: SealedMark }
  | { readonly ok: false; readonly error: string };

export type EndpointRemove = { readonly ok: true; readonly endpoints: ModelEndpoints; readonly removed: ModelEndpoint } | { readonly ok: false; readonly error: string };

/** An endpoint with its key; `unreadable` when a key is stored that this Environment's credentials key no longer opens. */
export interface ResolvedEndpoint {
  readonly endpoint: ModelEndpoint;
  readonly apiKey: string | undefined;
  readonly unreadable: boolean;
}

export interface EndpointStore {
  /** Whether the Environment has a credentials key, without which no API key is stored. */
  readonly sealing: boolean;
  load(): ModelEndpoints;
  /**
   * Adds the endpoint, or edits the one with its id (ids never change). `apiKey`: a value replaces the key; absent (or
   * empty) keeps it, unless the edit moves the target (API, base URL or headers), which is refused without a new key. An
   * API-key endpoint must end with a key; one with no auth keeps none. A new endpoint always needs its key given.
   */
  save(input: unknown, key: { readonly apiKey?: string }): Promise<EndpointSave>;
  remove(id: string): EndpointRemove;
  /** The key's mark, with whether it still opens. */
  keyStatus(id: string): Promise<SealedMark>;
  /** An endpoint with its key, for a caller here that uses it: the endpoint returned is the key's target. */
  resolve(id: string): Promise<ResolvedEndpoint | undefined>;
  /**
   * A Session's request for a key it will send to `target`: the key only when that is the endpoint's target now
   * (`changed` otherwise, as for an endpoint that is gone).
   */
  credential(request: EndpointCredentialRequest): Promise<EndpointCredential>;
}

/** Each model with its metadata, pi-ai's where its catalog knows the model (the owner's own fields win). */
export const modelsWithMetadata = (endpoint: { readonly api: EndpointApi; readonly baseUrl: string }, models: ReadonlyArray<EndpointModelInput>): Array<EndpointModel> =>
  models.map((model) => endpointModelOf(model, knownModel(model.id, endpoint)));

/** The endpoint as stored. */
const withMetadata = (input: EndpointInput): ModelEndpoint => ({ ...input, models: modelsWithMetadata(input, input.models) });

/** The save in flight, per storage. */
const saving = new WeakMap<object, Promise<unknown>>();

export const endpointStore = (kv: KvStorage, sealed: SealedStore): EndpointStore => {
  const load = (): ModelEndpoints => kv.get<ModelEndpoints>(ENDPOINTS_KEY) ?? EMPTY_ENDPOINTS;
  const keyMark = (id: string) => sealed.mark(endpointKeyName(id));
  const save = async (input: unknown, { apiKey }: { readonly apiKey?: string }): Promise<EndpointSave> => {
    const valid = validateEndpoint(input);
    if (!valid.ok) return valid;
    const { id } = valid.endpoint;
    const given = apiKey === undefined || apiKey === "" ? undefined : apiKey;
    // Every check runs before anything is sealed: a refused save leaves no key behind.
    const refusal = (): string | undefined => {
      const current = load();
      const seen = current.endpoints.find((entry) => entry.id === id);
      if (seen === undefined && current.endpoints.length >= MAX_ENDPOINTS) return `at most ${MAX_ENDPOINTS} endpoints`;
      if (valid.endpoint.auth === "none") return given === undefined ? undefined : "an endpoint with no auth takes no API key";
      if (given !== undefined) return given.length > 4096 || /\s/.test(given) ? "the API key is one word of up to 4096 characters" : undefined;
      // Keyless: only an existing API-key endpoint keeps its key, and only at the same target.
      if (seen === undefined || seen.auth === "none" || !keyMark(id).set) return "an API-key endpoint needs its API key";
      if (!sameTarget(seen, valid.endpoint)) return "a new API, base URL or header needs the API key entered again: the saved key goes only where it was saved for";
      return undefined;
    };
    const before = refusal();
    if (before !== undefined) return { ok: false, error: before };
    if (given !== undefined) {
      // A new endpoint's id may hold a key left from a refused or interleaved save: it is replaced here.
      try {
        await sealed.put(endpointKeyName(id), given);
      } catch (error) {
        if (error instanceof CredentialsKeyMissing) return { ok: false, error: error.message };
        throw error;
      }
    }
    // From here on nothing awaits: the checks run again on the entity as it is now, then it is read, bumped and written
    // in one step, so interleaved saves never write from a stale copy.
    const after = refusal();
    const current = load();
    const previous = current.endpoints.find((entry) => entry.id === id);
    if (after !== undefined) {
      // An endpoint that does not exist keeps no key.
      if (previous === undefined) sealed.remove(endpointKeyName(id));
      return { ok: false, error: after };
    }
    if (valid.endpoint.auth === "none") sealed.remove(endpointKeyName(id));
    const endpoint = withMetadata(valid.endpoint);
    const endpoints: ModelEndpoints = {
      revision: current.revision + 1,
      endpoints: previous === undefined ? [...current.endpoints, endpoint] : current.endpoints.map((entry) => (entry.id === id ? endpoint : entry)),
    };
    kv.put(ENDPOINTS_KEY, endpoints);
    return { ok: true, endpoints, endpoint, before: previous, added: previous === undefined, key: keyMark(id) };
  };
  return {
    sealing: sealed.available,
    load,
    keyStatus: (id) => sealed.inspect(endpointKeyName(id)),
    // One save at a time per storage: its checks, its seal and its write are never interleaved with another's.
    save: (input, key) => {
      const next = (saving.get(kv) ?? Promise.resolve()).then(() => save(input, key));
      saving.set(kv, next.catch(() => undefined));
      return next;
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
    resolve: async (id) => {
      const endpoint = load().endpoints.find((entry) => entry.id === id);
      if (endpoint === undefined) return undefined;
      if (endpoint.auth === "none") return { endpoint, apiKey: undefined, unreadable: false };
      const apiKey = await sealed.open(endpointKeyName(id));
      return { endpoint, apiKey, unreadable: apiKey === undefined && keyMark(id).set };
    },
    credential: async ({ endpointId, target }) => {
      const endpoint = load().endpoints.find((entry) => entry.id === endpointId);
      if (endpoint === undefined || !sameTarget(endpoint, target)) return { apiKey: null, changed: true };
      if (endpoint.auth === "none") return { apiKey: null };
      const apiKey = await sealed.open(endpointKeyName(endpointId));
      return apiKey === undefined ? { apiKey: null, ...(keyMark(endpointId).set ? { unreadable: true } : {}) } : { apiKey };
    },
  };
};
