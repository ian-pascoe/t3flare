// @effect-diagnostics globalFetch:off globalDate:off globalTimers:off
// SPI-1175: sets up a stage's Model endpoint (modelEndpointSpec.ts) through the Settings page's own API, the way a script
// reaches it (the stage's Access service token plus its admin token, so no CSRF token and no new route):
//
//   GET  /_t3flare/settings/api/endpoints            is it there already?
//   POST /_t3flare/settings/api/endpoints/discover   its model list, when the spec names no models
//   POST /_t3flare/settings/api/endpoints            { op: "save", endpoint, apiKey }: sealed and audited by the panel
//
// `stage.ts deploy` runs it after a deploy, and `acceptance.ts` before its turns. On prod (`overwrite: false`) an endpoint
// already there is kept as the owner left it; a test stage saves it again. Text generation needs no call: while the owner
// has picked no model, its setting follows the endpoints' default (SPI-1163), the small model this returns as `turnModel`.
//
// No message here holds the key or a header's value: an answer that repeats one has it replaced.
import { defaultTextModel, endpointSlug, type ModelEndpoint } from "@t3flare/models/endpoints";

import { type ModelEndpointSpec, scrubSecrets, secretsOf } from "./modelEndpointSpec.ts";

/** One call of the panel's API as a script makes it: the path, and the JSON body of a change. */
export type AdminCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ readonly status: number; readonly text: string }>;

export type EnsureResult =
  | { readonly ok: true; readonly outcome: "created" | "updated" | "kept"; readonly id: string; readonly models: number; readonly turnModel: string }
  | { readonly ok: false; readonly error: string };

export interface EnsureOptions {
  /** Save the endpoint even when one with its id is there (test stages); else keep that one (prod). */
  readonly overwrite: boolean;
  /** How long to wait for a freshly deployed stage's panel to answer (Access admits a new service token late). */
  readonly waitMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const PANEL = "/_t3flare/settings/api";
const RETRY_MS = 5_000;

/** The admin calls of a deployed stage: its URL, admin token and Access service token's credentials. */
export const adminClient = (stage: { readonly url: string; readonly adminToken: string; readonly clientId: string; readonly clientSecret: string }): AdminCall => async (method, path, body) => {
  const response = await fetch(new URL(path, stage.url), {
    method,
    redirect: "manual",
    headers: {
      "cf-access-client-id": stage.clientId,
      "cf-access-client-secret": stage.clientSecret,
      authorization: `Bearer ${stage.adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
};

const parsed = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The endpoint the turns and text generation use: its small model (SPI-1163's rule), else its first. */
const turnModelOf = (endpoint: ModelEndpoint): string => defaultTextModel({ revision: 0, endpoints: [endpoint] }) ?? endpointSlug(endpoint.id, endpoint.models[0]?.id ?? "");

export const ensureModelEndpoint = async (admin: AdminCall, spec: ModelEndpointSpec, options: EnsureOptions): Promise<EnsureResult> => {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const secrets = secretsOf(spec);
  const clean = (text: string) => scrubSecrets(text, secrets).trim().slice(0, 500);
  const fail = (error: string): EnsureResult => ({ ok: false, error: clean(error) });

  const list = async (): Promise<{ readonly endpoints: ReadonlyArray<ModelEndpoint> } | { readonly error: string }> => {
    const deadline = now() + options.waitMs;
    for (;;) {
      const answer = await admin("GET", `${PANEL}/endpoints`).catch((error: unknown) => ({ status: 0, text: String(error) }));
      const json = answer.status === 200 ? parsed(answer.text) : undefined;
      if (Array.isArray(json?.endpoints)) return { endpoints: json.endpoints };
      if (now() >= deadline) return { error: `the Settings page did not answer GET ${PANEL}/endpoints (${answer.status === 0 ? clean(answer.text) : `HTTP ${answer.status}`})` };
      await sleep(RETRY_MS);
    }
  };

  const before = await list();
  if ("error" in before) return fail(before.error);
  const existing = before.endpoints.find((endpoint) => endpoint.id === spec.id);
  if (existing !== undefined && !options.overwrite) return { ok: true, outcome: "kept", id: spec.id, models: existing.models.length, turnModel: turnModelOf(existing) };

  const endpoint = { id: spec.id, label: spec.label, api: spec.api, baseUrl: spec.baseUrl, auth: "api-key", headers: spec.headers, models: [] as ReadonlyArray<string> };
  let models = spec.models;
  if (models === undefined) {
    const found = await admin("POST", `${PANEL}/endpoints/discover`, { endpoint, apiKey: spec.apiKey });
    const json = found.status === 200 ? parsed(found.text) : undefined;
    if (json?.ok !== true || !Array.isArray(json.models)) {
      return fail(`the Model endpoint "${spec.id}"'s model list could not be read (HTTP ${found.status}): ${typeof json?.error === "string" ? json.error : found.text}`);
    }
    const listed: Array<string> = json.models.map((model: { id: string }) => model.id);
    const match = spec.match === undefined ? undefined : new RegExp(spec.match);
    models = match === undefined ? listed : listed.filter((id) => match.test(id));
    if (models.length === 0) return fail(`the Model endpoint "${spec.id}" lists no model${match === undefined ? "" : ` matching ${spec.match}`} (${listed.length} listed)`);
  }

  const saved = await admin("POST", `${PANEL}/endpoints`, { op: "save", endpoint: { ...endpoint, models }, apiKey: spec.apiKey });
  const json = saved.status === 200 ? parsed(saved.text) : undefined;
  if (json?.ok !== true || json.endpoint === undefined) return fail(`the Settings page refused the Model endpoint "${spec.id}" (HTTP ${saved.status}): ${saved.text}`);
  const result: ModelEndpoint = json.endpoint;
  return { ok: true, outcome: existing === undefined ? "created" : "updated", id: spec.id, models: result.models.length, turnModel: turnModelOf(result) };
};
