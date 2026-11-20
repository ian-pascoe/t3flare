// SPI-1175: the Model endpoints a stage, the acceptance test and CI set up through the Settings page's API, as one
// setting: `T3FLARE_MODEL_ENDPOINT` (in ~/.config/t3flare/dev.env, or the GitHub secret of that name), a JSON object
//
//   {"id": "commissary", "label": "Commissary", "api": "anthropic-messages", "baseUrl": "https://…", "apiKey": "…",
//    "headers": {}, "models": ["claude-haiku-5-5"], "match": "^claude-"}
//
// or a list of them, one per API the stage's agents need (`[{…anthropic-messages…}, {…openai-responses…}]`): Claude Code
// needs Anthropic Messages, Codex OpenAI Responses (`cliCoverage`). The first is the stage's own endpoint (its small model
// runs the real turn). Ids are unique.
//
// `id`, `baseUrl` and `apiKey` are required. `label` defaults to the id, `api` to `anthropic-messages`, `headers` to none.
// Without `models` the endpoint's own list is read, keeping the ids `match` (a regular expression) matches when given.
// The panel validates the rest as it does the owner's form.
//
// Without it there is nothing to set up: a deploy skips the setup and says so (a stage then starts in the setup state,
// its providers needing an endpoint). `infra/github.ts` (`ci:setup`) reads the same setting. No dependency: both read
// this file.
//
// No message here repeats the value: it holds a key. In CI each of its secrets is masked by value (`maskCommands`, run by
// `mask-endpoint.ts` as the workflows' first step), because GitHub masks only the whole JSON string.

export const MODEL_ENDPOINT_VAR = "T3FLARE_MODEL_ENDPOINT";

/**
 * The APIs an endpoint may speak: `ENDPOINT_APIS` of `@t3flare/models/endpoints`, restated so `infra` can read this file
 * without that package (modelEndpointSetup.test.ts checks the two are the same).
 */
export const SPEC_APIS = ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai", "mistral-conversations"] as const;
export type SpecApi = (typeof SPEC_APIS)[number];

export interface ModelEndpointSpec {
  readonly id: string;
  readonly label: string;
  readonly api: SpecApi;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The model ids to save; without them, the endpoint's own list, filtered by `match`. */
  readonly models?: ReadonlyArray<string>;
  readonly match?: string;
}

export type ModelEndpointSpecResult =
  /** `specs`: every endpoint given, in order; `spec`: the first. */
  | { readonly ok: true; readonly spec: ModelEndpointSpec; readonly specs: ReadonlyArray<ModelEndpointSpec>; readonly source: typeof MODEL_ENDPOINT_VAR }
  /** `invalid`: the setting is there but unusable (a failure); otherwise there is nothing to set up (a skip). */
  | { readonly ok: false; readonly invalid: boolean; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const invalid = (why: string): ModelEndpointSpecResult => ({ ok: false, invalid: true, reason: `${MODEL_ENDPOINT_VAR} ${why}` });

type One = { readonly ok: true; readonly spec: ModelEndpointSpec } | { readonly ok: false; readonly invalid: true; readonly reason: string };

const parse = (text: string): ModelEndpointSpecResult => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("is not JSON");
  }
  if (!Array.isArray(value)) {
    const one = parseOne(value);
    return one.ok ? { ok: true, source: MODEL_ENDPOINT_VAR, spec: one.spec, specs: [one.spec] } : one;
  }
  if (value.length === 0) return invalid("is an empty list");
  const specs: Array<ModelEndpointSpec> = [];
  for (const [index, item] of value.entries()) {
    const one = parseOne(item);
    if (!one.ok) return { ...one, reason: one.reason.replace(MODEL_ENDPOINT_VAR, `${MODEL_ENDPOINT_VAR}[${index}]`) };
    if (specs.some((spec) => spec.id === one.spec.id)) return invalid(`has the id ${JSON.stringify(one.spec.id)} twice`);
    specs.push(one.spec);
  }
  return { ok: true, source: MODEL_ENDPOINT_VAR, spec: specs[0]!, specs };
};

const parseOne = (value: unknown): One => {
  const failed = (why: string): One => ({ ok: false, invalid: true, reason: `${MODEL_ENDPOINT_VAR} ${why}` });
  if (!isRecord(value)) return failed("is not a JSON object or a list of them");
  const { id, label, api, baseUrl, apiKey, headers, models, match } = value;
  if (!isText(id)) return failed("has no id");
  if (!isText(baseUrl)) return failed("has no baseUrl");
  if (!isText(apiKey)) return failed("has no apiKey");
  if (label !== undefined && !isText(label)) return failed("has a label that is not text");
  if (api !== undefined && !SPEC_APIS.includes(api as SpecApi)) return failed(`has an api that is not one of ${SPEC_APIS.join(", ")}`);
  if (headers !== undefined && !(isRecord(headers) && Object.values(headers).every((header) => typeof header === "string"))) return failed("has headers that are not names to text");
  if (models !== undefined && !(Array.isArray(models) && models.every(isText))) return failed("has models that are not a list of ids");
  if (match !== undefined) {
    if (!isText(match)) return failed("has a match that is not text");
    try {
      new RegExp(match);
    } catch {
      return failed("has a match that is not a regular expression");
    }
  }
  return {
    ok: true,
    spec: {
      id,
      label: label ?? id,
      api: (api ?? "anthropic-messages") as SpecApi,
      baseUrl,
      apiKey,
      headers: (headers ?? {}) as Record<string, string>,
      ...(models === undefined ? {} : { models: models as Array<string> }),
      ...(match === undefined ? {} : { match }),
    },
  };
};

/** The value of `T3FLARE_MODEL_ENDPOINT` that describes `specs` (what `ci:setup` stores as the secret): one object, or a list. */
export const modelEndpointSecret = (specs: ReadonlyArray<ModelEndpointSpec>): string => JSON.stringify(specs.length === 1 ? specs[0] : specs);

/** The CLI agents the acceptance test runs (`--codex`, `--pi`, `--claude`, `--opencode`), and the APIs each runs on. */
export const CLI_APIS: Readonly<Record<"codex" | "pi" | "claude" | "opencode", ReadonlyArray<SpecApi>>> = {
  codex: ["openai-responses"],
  claude: ["anthropic-messages"],
  opencode: ["anthropic-messages", "openai-responses", "openai-completions"],
  pi: SPEC_APIS,
};

/**
 * Of `clis`, each one no endpoint of `specs` serves, with what it needs: the acceptance test fails on these before it
 * runs them (an uncovered CLI is refused at spawn, SPI-1176), never skipping one silently.
 */
export const cliCoverage = (clis: ReadonlyArray<keyof typeof CLI_APIS>, specs: ReadonlyArray<Pick<ModelEndpointSpec, "api">>): ReadonlyArray<{ readonly cli: string; readonly needs: string }> =>
  clis.filter((cli) => !specs.some((spec) => CLI_APIS[cli].includes(spec.api))).map((cli) => ({ cli, needs: `an endpoint speaking ${CLI_APIS[cli].join(" or ")} in ${MODEL_ENDPOINT_VAR}` }));

/** The endpoint to set up from `env`: `T3FLARE_MODEL_ENDPOINT` when set, else nothing, with the reason. */
export const modelEndpointSpec = (env: Readonly<Record<string, string | undefined>>): ModelEndpointSpecResult => {
  const given = env[MODEL_ENDPOINT_VAR];
  if (given !== undefined && given.trim() !== "") return parse(given);
  return { ok: false, invalid: false, reason: `${MODEL_ENDPOINT_VAR} is not set` };
};

/** The stages' rule (stage.ts and acceptance.ts), the same on a laptop and in CI. */
export const stageEndpointSpec = (env: Readonly<Record<string, string | undefined>>): ModelEndpointSpecResult => modelEndpointSpec(env);

/** Shorter values are not masked or scrubbed: no credential is that short, and masking one would garble every log line. */
export const MIN_SECRET_LENGTH = 4;

/** The values of `spec` no log, report or artifact may carry: its key and every header's value. */
export const secretsOf = (spec: Pick<ModelEndpointSpec, "apiKey" | "headers">): ReadonlyArray<string> =>
  [spec.apiKey, ...Object.values(spec.headers)].flatMap((value) => value.split(/\r?\n/)).map((value) => value.trim()).filter((value) => value.length >= MIN_SECRET_LENGTH);

/** `text` with each of `secrets` replaced. For plain text; a value to serialize goes through `scrubValue` first. */
export const scrubSecrets = (text: string, secrets: ReadonlyArray<string>): string =>
  [...secrets].sort((a, b) => b.length - a.length).reduce((scrubbed, secret) => scrubbed.split(secret).join("[redacted]"), text);

/**
 * `value` with `secrets` replaced in every string in it (keys included), before it is serialized: scrubbing the JSON text
 * instead would break it (a header value `true` would rewrite `"ok": true`) and miss a key holding `"` or `\`.
 */
export const scrubValue = (value: unknown, secrets: ReadonlyArray<string>): unknown => {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubSecrets(key, secrets), scrubValue(item, secrets)]));
  return value;
};

/**
 * A report as kept (the acceptance test's, `bump-report.json`: an artifact), as indented JSON with the stage's Model
 * endpoint's key and header values scrubbed from it (`stageEndpointSpec(env)`), and the Owner's email (a secret in CI,
 * docs/deploy.md).
 */
export const keptReportJson = (report: unknown, env: Readonly<Record<string, string | undefined>>): string => {
  const endpoint = stageEndpointSpec(env);
  const ownerEmail = (env.T3FLARE_OWNER_EMAIL ?? "").trim();
  const secrets = [...(endpoint.ok ? endpoint.specs.flatMap(secretsOf) : []), ...(ownerEmail.length >= MIN_SECRET_LENGTH ? [ownerEmail] : [])];
  return JSON.stringify(scrubValue(report, secrets), null, 2);
};

/**
 * GitHub's workflow commands that mask `T3FLARE_MODEL_ENDPOINT`'s key and header values, each on its own, for the rest of
 * the job. Nothing when it is unset or not an endpoint: the whole value is masked by GitHub already.
 */
export const maskCommands = (env: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> => {
  const given = env[MODEL_ENDPOINT_VAR];
  if (given === undefined || given.trim() === "") return [];
  const parsed = parse(given);
  return parsed.ok ? parsed.specs.flatMap(secretsOf).map((secret) => `::add-mask::${secret}`) : [];
};
