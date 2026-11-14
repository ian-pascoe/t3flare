// Model endpoints (SPI-1162; draft ADR-0034): the owner's own ways to reach models, set in the Harness panel. Each is an
// API pi-ai speaks at a base URL, with an API key or none, optional headers, and the models it serves. The entity holds no
// secret: an endpoint's key is sealed apart from it (the Environment's credentials store) and read only at use time.
//
// A model is named `<endpointId>/<modelId>` everywhere: in t3's picker, in a Session's pi-ai `ModelRef` (the endpoint is
// its provider), and for the model relay and the credential broker that build on this (SPI-1164, SPI-1167). An endpoint's
// id never changes, so a slug stays valid as long as the endpoint keeps the model. A model id may itself hold a `/`
// (OpenRouter's `anthropic/claude-…`): the slug splits at its first one.

/** The pi-ai APIs an endpoint may speak with an API key (or none). OAuth sign-ins' APIs are SPI-1164's. */
export const ENDPOINT_APIS = ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai", "mistral-conversations"] as const;
export type EndpointApi = (typeof ENDPOINT_APIS)[number];

export type EndpointAuth = "api-key" | "none";

/** What a model costs, in dollars per million tokens (pi-ai's `ModelCost` without its tiers). */
export interface EndpointModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** One model an endpoint serves, with the metadata a Session and the picker need. */
export interface EndpointModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ReadonlyArray<"text" | "image">;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: EndpointModelCost;
  /** pi-ai's catalog knew it: its metadata is pi-ai's (the owner's own fields win). */
  readonly known: boolean;
  /** pi-ai's per-model thinking levels (`ThinkingLevelMap`), when its catalog has them. */
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  /** pi-ai's compatibility overrides for this API (`Model.compat`), when its catalog has them for the same API. */
  readonly compat?: Readonly<Record<string, unknown>>;
}

export interface ModelEndpoint {
  /** Immutable: a slug names it, and a CLI keeps it in its rollouts. */
  readonly id: string;
  readonly label: string;
  readonly api: EndpointApi;
  readonly baseUrl: string;
  readonly auth: EndpointAuth;
  /** Sent with every request; never a credential (those go in the sealed key). */
  readonly headers: Readonly<Record<string, string>>;
  readonly models: ReadonlyArray<EndpointModel>;
}

/** The entity: every endpoint, in the owner's order, and its own revision. */
export interface ModelEndpoints {
  readonly revision: number;
  readonly endpoints: ReadonlyArray<ModelEndpoint>;
}

export const EMPTY_ENDPOINTS: ModelEndpoints = { revision: 0, endpoints: [] };

/** 1–32 of a–z, 0–9 and `-`, starting and ending with a letter or digit. */
export const ENDPOINT_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/**
 * Ids an endpoint may not take: `anthropic` names the Model proxy's models (`anthropic/<id>`) until the hard cut
 * (SPI-1176), and `default` is t3's word for the default model.
 */
export const RESERVED_ENDPOINT_IDS: ReadonlyArray<string> = ["anthropic", "default"];
export const MAX_ENDPOINTS = 32;
export const MAX_ENDPOINT_MODELS = 200;
const MAX_HEADERS = 16;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Headers that carry a credential: the key goes in its sealed field, never here. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "proxy-authorization", "cookie", "cf-aig-authorization"]);

/** A model's slug: `<endpointId>/<modelId>`. */
export const endpointSlug = (endpointId: string, modelId: string): string => `${endpointId}/${modelId}`;

/** A slug's endpoint and model, split at the first `/`; undefined without one. */
export const parseEndpointSlug = (slug: string): { readonly endpointId: string; readonly modelId: string } | undefined => {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return undefined;
  return { endpointId: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
};

/** A model of `endpoints` by its slug, with its endpoint. */
export const findEndpointModel = (endpoints: ModelEndpoints, slug: string): { readonly endpoint: ModelEndpoint; readonly model: EndpointModel } | undefined => {
  const parsed = parseEndpointSlug(slug);
  if (parsed === undefined) return undefined;
  const endpoint = endpoints.endpoints.find((entry) => entry.id === parsed.endpointId);
  const model = endpoint?.models.find((entry) => entry.id === parsed.modelId);
  return endpoint === undefined || model === undefined ? undefined : { endpoint, model };
};

/** A preset fills the panel's form; the owner may change any field before saving. */
export interface EndpointPreset {
  readonly preset: string;
  readonly title: string;
  readonly id: string;
  readonly label: string;
  readonly api: EndpointApi;
  readonly baseUrl: string;
  readonly auth: EndpointAuth;
}

export const ENDPOINT_PRESETS: ReadonlyArray<EndpointPreset> = [
  { preset: "anthropic", title: "Anthropic API", id: "anthropic-api", label: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "api-key" },
  { preset: "openai", title: "OpenAI API", id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key" },
  { preset: "openrouter", title: "OpenRouter", id: "openrouter", label: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", auth: "api-key" },
  { preset: "custom", title: "Custom (OpenAI-compatible)", id: "", label: "", api: "openai-completions", baseUrl: "", auth: "api-key" },
];

/** A model as the owner gives it: its id, and any metadata of its own (which wins over pi-ai's). */
export interface EndpointModelInput {
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly input?: ReadonlyArray<"text" | "image">;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

/** An endpoint as the panel's API takes it, before its models' metadata is filled in. */
export interface EndpointInput {
  readonly id: string;
  readonly label: string;
  readonly api: EndpointApi;
  readonly baseUrl: string;
  readonly auth: EndpointAuth;
  readonly headers: Readonly<Record<string, string>>;
  readonly models: ReadonlyArray<EndpointModelInput>;
}

/**
 * Where an endpoint's key goes: its API, base URL and headers. A saved key is sent only to the target it was saved with
 * (a gateway may route by a header, so headers count). Every check of that rule goes through `sameTarget`.
 */
export interface EndpointTarget {
  readonly api: EndpointApi;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export const targetOf = (endpoint: EndpointTarget): EndpointTarget => ({ api: endpoint.api, baseUrl: endpoint.baseUrl, headers: { ...endpoint.headers } });

/** Headers as compared: names lowercased, sorted. */
const headerList = (headers: Readonly<Record<string, string>>): string =>
  JSON.stringify(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)));

/** A target as one string: equal for the same API, base URL and headers (names case-insensitive). */
export const targetKey = (target: EndpointTarget): string => JSON.stringify([target.api, target.baseUrl, headerList(target.headers)]);

/** Whether two targets are the same: the same API, base URL and headers (names case-insensitive). */
export const sameTarget = (a: EndpointTarget, b: EndpointTarget): boolean => targetKey(a) === targetKey(b);

/**
 * An endpoint's key as the Environment answers a Session (`endpointCredential`): the key, or null with why.
 * - `unreadable`: a key is stored but this Environment's credentials key does not open it (the key changed, or the
 *   record is damaged).
 * - `changed`: the endpoint's target is no longer the one the Session holds; the key is not given for the old one.
 */
export interface EndpointCredential {
  readonly apiKey: string | null;
  readonly unreadable?: boolean;
  readonly changed?: boolean;
}

/** A Session's request for an endpoint's key: the endpoint, and the target it will send the key to. */
export interface EndpointCredentialRequest {
  readonly endpointId: string;
  readonly target: EndpointTarget;
}

/** What pi-ai's catalog knows of a model (`known.ts`). */
export type KnownModel = Omit<EndpointModel, "id" | "known">;

/** The limits of a model nothing is known of. */
export const UNKNOWN_MODEL_LIMITS = { contextWindow: 128_000, maxTokens: 16_384 } as const;

/** `input`'s model with its metadata: the owner's fields, else pi-ai's (`known`), else defaults with no price. */
export const endpointModelOf = (input: EndpointModelInput, known: KnownModel | undefined): EndpointModel => ({
  id: input.id,
  name: input.name ?? known?.name ?? input.id,
  reasoning: input.reasoning ?? known?.reasoning ?? false,
  input: [...(input.input ?? known?.input ?? ["text"])],
  contextWindow: input.contextWindow ?? known?.contextWindow ?? UNKNOWN_MODEL_LIMITS.contextWindow,
  maxTokens: input.maxTokens ?? known?.maxTokens ?? UNKNOWN_MODEL_LIMITS.maxTokens,
  cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  known: known !== undefined,
  ...(known?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: known.thinkingLevelMap }),
  ...(known?.compat === undefined ? {} : { compat: known.compat }),
});

/** A JSON object (not an array, not null). */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000_000;

const modelInputOf = (value: unknown): EndpointModelInput | string => {
  if (typeof value === "string") value = { id: value };
  if (!isRecord(value)) return "each model is { id, name?, reasoning?, input?, contextWindow?, maxTokens? }";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (id === "" || id.length > 200 || /\s/.test(id)) return `a model id is 1–200 characters without spaces (${JSON.stringify(value.id)})`;
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 200)) return `${id}: name is a text of up to 200 characters`;
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") return `${id}: reasoning is true or false`;
  if (value.input !== undefined && (!Array.isArray(value.input) || value.input.length === 0 || !value.input.every((entry) => entry === "text" || entry === "image"))) {
    return `${id}: input is a list of "text" and "image"`;
  }
  if (value.contextWindow !== undefined && !positive(value.contextWindow)) return `${id}: contextWindow is a positive whole number`;
  if (value.maxTokens !== undefined && !positive(value.maxTokens)) return `${id}: maxTokens is a positive whole number`;
  return {
    id,
    ...(typeof value.name === "string" && value.name.trim() !== "" ? { name: value.name.trim() } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(Array.isArray(value.input) ? { input: [...new Set(value.input as Array<"text" | "image">)] } : {}),
    ...(positive(value.contextWindow) ? { contextWindow: value.contextWindow } : {}),
    ...(positive(value.maxTokens) ? { maxTokens: value.maxTokens } : {}),
  };
};

/**
 * The base URL as stored, or why not: https, a public host name (no IP literal, `localhost` or `.internal`, as a direct
 * MCP server's URL, harness-registry's `directUrlProblem`), no credentials, query or fragment, no trailing slash. The key
 * goes there, from a Worker.
 */
const baseUrlOf = (value: unknown): { readonly url: string } | { readonly problem: string } => {
  if (typeof value !== "string") return { problem: "baseUrl is an https URL" };
  // `URL` drops a bare `?` or `#`: refuse them as written.
  if (value.includes("?") || value.includes("#")) return { problem: "baseUrl has no credentials, query or fragment" };
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { problem: "baseUrl is an https URL" };
  }
  if (url.protocol !== "https:") return { problem: "baseUrl is https only" };
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return { problem: "baseUrl has no credentials, query or fragment" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { problem: "baseUrl's host is a public host name, not an address" };
  }
  return { url: url.toString().replace(/\/+$/, "") };
};

/** Checks an endpoint as the panel's API receives it. */
export const validateEndpoint = (value: unknown): { readonly ok: true; readonly endpoint: EndpointInput } | { readonly ok: false; readonly error: string } => {
  if (!isRecord(value)) return { ok: false, error: "the endpoint is { id, label, api, baseUrl, auth, headers?, models }" };
  const id = typeof value.id === "string" ? value.id : "";
  if (!ENDPOINT_ID.test(id)) return { ok: false, error: "id is 1–32 of a–z, 0–9 and -, starting and ending with a letter or digit" };
  if (RESERVED_ENDPOINT_IDS.includes(id)) return { ok: false, error: `the id ${id} is reserved` };
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (label === "" || label.length > 60) return { ok: false, error: "label is 1–60 characters" };
  if (typeof value.api !== "string" || !(ENDPOINT_APIS as ReadonlyArray<string>).includes(value.api)) return { ok: false, error: `api is one of ${ENDPOINT_APIS.join(", ")}` };
  const base = baseUrlOf(value.baseUrl);
  if ("problem" in base) return { ok: false, error: base.problem };
  const baseUrl = base.url;
  const auth = value.auth ?? "api-key";
  if (auth !== "api-key" && auth !== "none") return { ok: false, error: "auth is api-key or none" };
  const headers: Record<string, string> = {};
  const given = value.headers ?? {};
  if (!isRecord(given)) return { ok: false, error: "headers is an object of names to values" };
  if (Object.keys(given).length > MAX_HEADERS) return { ok: false, error: `at most ${MAX_HEADERS} headers` };
  const names = new Set<string>();
  for (const [name, text] of Object.entries(given)) {
    if (!HEADER_NAME.test(name)) return { ok: false, error: `the header name ${JSON.stringify(name)} is 1–64 of A–Z, a–z, 0–9 and -` };
    if (names.has(name.toLowerCase())) return { ok: false, error: `the header ${name} is given twice (header names ignore case)` };
    names.add(name.toLowerCase());
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) return { ok: false, error: `${name} carries a credential: put the key in the API key field, which is sealed` };
    if (typeof text !== "string" || text.length > 1024 || /[\r\n]/.test(text)) return { ok: false, error: `the header ${name}'s value is one line of up to 1024 characters` };
    headers[name] = text;
  }
  const listed = value.models ?? [];
  if (!Array.isArray(listed)) return { ok: false, error: "models is a list" };
  if (listed.length > MAX_ENDPOINT_MODELS) return { ok: false, error: `at most ${MAX_ENDPOINT_MODELS} models` };
  const models: Array<EndpointModelInput> = [];
  for (const entry of listed) {
    const model = modelInputOf(entry);
    if (typeof model === "string") return { ok: false, error: model };
    if (models.some((other) => other.id === model.id)) return { ok: false, error: `the model ${model.id} is listed twice` };
    models.push(model);
  }
  return { ok: true, endpoint: { id, label, api: value.api as EndpointApi, baseUrl, auth, headers, models } };
};
