// @effect-diagnostics globalDate:off
// The Harness panel's Model endpoints routes (SPI-1162), answered after panel.ts has applied its guards (Access, then for
// a change JSON, Origin, Sec-Fetch-Site and the owner's CSRF token):
//
//   GET  /api/endpoints            the entity, each endpoint with its key's mark (never the key), the presets and APIs
//   POST /api/endpoints            { op: "save", endpoint, apiKey? } or { op: "remove", id }
//   POST /api/endpoints/discover   { endpoint, apiKey? }: the endpoint's model list with pi-ai's metadata, read with the
//                                  key given, else the saved endpoint's own, but only at its saved API and base URL
//
// Every change bumps the endpoints' own revision and is audited under the entity `endpoints`, with the key's mark and the
// headers' names only.
import { ENDPOINT_APIS, ENDPOINT_PRESETS, isRecord, type ModelEndpoint, validateEndpoint } from "@t3flare/models/endpoints";

import type { SealedMark } from "../credentials/sealed.ts";
import type { AuditEntry } from "../harness/store.ts";
import type { Discovery } from "./discover.ts";
import { type EndpointStore, modelsWithMetadata, sameTarget } from "./store.ts";

export interface EndpointsApiDeps {
  readonly store: EndpointStore;
  /** Reads an endpoint's model list (discover.ts). */
  readonly discover: (target: Pick<ModelEndpoint, "api" | "baseUrl" | "headers">, apiKey: string | undefined) => Promise<Discovery>;
  /** The endpoints changed: the Pi Durable picker reads them again. */
  readonly changed?: () => void;
}

export type EndpointsAnswer = { readonly status: number; readonly json: unknown } | { readonly status: number; readonly text: string };

export const ENDPOINTS_PATHS = { list: "/api/endpoints", discover: "/api/endpoints/discover" } as const;

/** An endpoint as audited: no key, and its headers' names only. */
const audited = (endpoint: ModelEndpoint | undefined, key?: SealedMark) =>
  endpoint === undefined
    ? null
    : {
        label: endpoint.label,
        api: endpoint.api,
        baseUrl: endpoint.baseUrl,
        auth: endpoint.auth,
        headers: Object.keys(endpoint.headers),
        models: endpoint.models.map((model) => model.id),
        ...(key === undefined || !key.set ? {} : { key }),
      };

/** The entity as the panel shows it: each key's mark, with whether it still opens. */
export const endpointsOverview = async (deps: Pick<EndpointsApiDeps, "store">) => {
  const { revision, endpoints } = deps.store.load();
  return {
    revision,
    credentialsKey: deps.store.sealing,
    endpoints: await Promise.all(endpoints.map(async (endpoint) => ({ ...endpoint, key: await deps.store.keyStatus(endpoint.id) }))),
    presets: ENDPOINT_PRESETS,
    apis: ENDPOINT_APIS,
  };
};

/** A change to the endpoints, `audit`ed. */
export const endpointsChange = async (deps: EndpointsApiDeps, body: Record<string, unknown>, audit: (entry: Omit<AuditEntry, "at" | "caller" | "entity">) => void): Promise<EndpointsAnswer> => {
  if (body.op === "remove") {
    const id = typeof body.id === "string" ? body.id : "";
    const removed = deps.store.remove(id);
    if (!removed.ok) return { status: 404, text: removed.error };
    audit({ action: "endpoint.remove", target: id, before: audited(removed.removed) });
    deps.changed?.();
    return { status: 200, json: { ok: true, revision: removed.endpoints.revision } };
  }
  if (body.op !== "save") return { status: 400, text: "the body is { op: \"save\", endpoint, apiKey? } or { op: \"remove\", id }" };
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") return { status: 400, text: "apiKey is a string" };
  const saved = await deps.store.save(body.endpoint, typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {});
  if (!saved.ok) return { status: 400, text: saved.error };
  audit({ action: saved.added ? "endpoint.add" : "endpoint.change", target: saved.endpoint.id, before: audited(saved.before), after: audited(saved.endpoint, saved.key) });
  deps.changed?.();
  return { status: 200, json: { ok: true, revision: saved.endpoints.revision, endpoint: saved.endpoint, key: saved.key } };
};

/** The model list of an endpoint being edited, with pi-ai's metadata: nothing is saved or audited. */
export const endpointsDiscover = async (deps: EndpointsApiDeps, body: Record<string, unknown>): Promise<EndpointsAnswer> => {
  const given = isRecord(body.endpoint) ? body.endpoint : {};
  // The list is read before the endpoint has models or a final id: validate it with a stand-in for each.
  const valid = validateEndpoint({ ...given, id: typeof given.id === "string" && given.id !== "" ? given.id : "unsaved", label: typeof given.label === "string" && given.label.trim() !== "" ? given.label : "unsaved", models: [] });
  if (!valid.ok) return { status: 400, text: valid.error };
  const typed = typeof body.apiKey === "string" && body.apiKey !== "" ? body.apiKey : undefined;
  let apiKey: string | undefined;
  if (valid.endpoint.auth === "api-key") {
    if (typed !== undefined) apiKey = typed;
    else {
      // The saved key goes only to the API and base URL it was saved with.
      const saved = await deps.store.resolve(valid.endpoint.id);
      if (saved === undefined || saved.endpoint.auth === "none" || !sameTarget(saved.endpoint, valid.endpoint)) {
        return { status: 400, text: "type the API key: a saved key is sent only to the API and base URL it was saved with" };
      }
      if (saved.apiKey === undefined) return { status: 400, text: "the saved API key cannot be read: enter it again" };
      apiKey = saved.apiKey;
    }
  }
  const found = await deps.discover(valid.endpoint, apiKey);
  if (!found.ok) return { status: 200, json: found };
  return { status: 200, json: { ok: true, models: modelsWithMetadata(valid.endpoint, found.models) } };
};
