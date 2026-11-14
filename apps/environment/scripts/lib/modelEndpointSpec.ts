// SPI-1175: the Model endpoint a stage, the acceptance test and CI set up through the Harness panel's API, as one setting:
// `T3FLARE_MODEL_ENDPOINT`, a JSON object (in ~/.config/t3flare/dev.env, or the GitHub secret of that name)
//
//   {"id": "commissary", "label": "Commissary", "api": "anthropic-messages", "baseUrl": "https://…", "apiKey": "…",
//    "headers": {}, "models": ["claude-haiku-5-5"], "match": "^claude-"}
//
// `id`, `baseUrl` and `apiKey` are required. `label` defaults to the id, `api` to `anthropic-messages`, `headers` to none.
// Without `models` the endpoint's own list is read, keeping the ids `match` (a regular expression) matches when given.
// The panel validates the rest as it does the owner's form.
//
// Until the hard cut (SPI-1176), a laptop without it derives a Commissary endpoint from the Model proxy's settings: the
// proxy's URL and key, its Claude models. CI derives nothing (`derive: false`): it has the secret or skips the setup.
// `infra/github.ts` (`ci:setup`) derives the secret the same way. No dependency: both read this file.
//
// No message here repeats the value: it holds a key.

export const MODEL_ENDPOINT_VAR = "T3FLARE_MODEL_ENDPOINT";

export interface ModelEndpointSpec {
  readonly id: string;
  readonly label: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The model ids to save; without them, the endpoint's own list, filtered by `match`. */
  readonly models?: ReadonlyArray<string>;
  readonly match?: string;
}

export type ModelEndpointSpecResult =
  | { readonly ok: true; readonly spec: ModelEndpointSpec; readonly source: typeof MODEL_ENDPOINT_VAR | "MODEL_PROXY_URL" }
  /** `invalid`: the setting is there but unusable (a failure); otherwise there is nothing to set up (a skip). */
  | { readonly ok: false; readonly invalid: boolean; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The Commissary endpoint the Model proxy's settings describe (SPI-1162's evidence endpoint): its Claude models. */
export const commissaryEndpoint = (url: string, apiKey: string): ModelEndpointSpec => ({
  id: "commissary",
  label: "Commissary",
  api: "anthropic-messages",
  baseUrl: url.replace(/\/+$/, ""),
  apiKey,
  headers: {},
  match: "^claude-",
});

const invalid = (why: string): ModelEndpointSpecResult => ({ ok: false, invalid: true, reason: `${MODEL_ENDPOINT_VAR} ${why}` });

const parse = (text: string): ModelEndpointSpecResult => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("is not JSON");
  }
  if (!isRecord(value)) return invalid("is not a JSON object");
  const { id, label, api, baseUrl, apiKey, headers, models, match } = value;
  if (!isText(id)) return invalid("has no id");
  if (!isText(baseUrl)) return invalid("has no baseUrl");
  if (!isText(apiKey)) return invalid("has no apiKey");
  if (label !== undefined && !isText(label)) return invalid("has a label that is not text");
  if (api !== undefined && !isText(api)) return invalid("has an api that is not text");
  if (headers !== undefined && !(isRecord(headers) && Object.values(headers).every((header) => typeof header === "string"))) return invalid("has headers that are not names to text");
  if (models !== undefined && !(Array.isArray(models) && models.every(isText))) return invalid("has models that are not a list of ids");
  if (match !== undefined) {
    if (!isText(match)) return invalid("has a match that is not text");
    try {
      new RegExp(match);
    } catch {
      return invalid("has a match that is not a regular expression");
    }
  }
  return {
    ok: true,
    source: MODEL_ENDPOINT_VAR,
    spec: {
      id,
      label: label ?? id,
      api: api ?? "anthropic-messages",
      baseUrl,
      apiKey,
      headers: (headers ?? {}) as Record<string, string>,
      ...(models === undefined ? {} : { models: models as Array<string> }),
      ...(match === undefined ? {} : { match }),
    },
  };
};

/** The value of `T3FLARE_MODEL_ENDPOINT` that describes `spec` (what `ci:setup` stores as the secret). */
export const modelEndpointSecret = (spec: ModelEndpointSpec): string => JSON.stringify(spec);

/**
 * The endpoint to set up from `env`: `T3FLARE_MODEL_ENDPOINT` when set; else, with `derive`, Commissary from the Model
 * proxy's settings; else nothing, with the reason.
 */
export const modelEndpointSpec = (env: Readonly<Record<string, string | undefined>>, options: { readonly derive: boolean }): ModelEndpointSpecResult => {
  const given = env[MODEL_ENDPOINT_VAR];
  if (given !== undefined && given.trim() !== "") return parse(given);
  if (!options.derive) return { ok: false, invalid: false, reason: `${MODEL_ENDPOINT_VAR} is not set` };
  const url = env.MODEL_PROXY_URL;
  const key = env.MODEL_PROXY_API_KEY;
  if (isText(url) && isText(key)) return { ok: true, source: "MODEL_PROXY_URL", spec: commissaryEndpoint(url, key) };
  return { ok: false, invalid: false, reason: `neither ${MODEL_ENDPOINT_VAR} nor MODEL_PROXY_URL and MODEL_PROXY_API_KEY are set` };
};
