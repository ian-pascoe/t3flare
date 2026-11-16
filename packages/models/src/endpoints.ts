// Model endpoints (SPI-1162; draft ADR-0034): the owner's own ways to reach models, set in the Harness panel. Each is an
// API pi-ai speaks at a base URL, with an API key or none, optional headers, and the models it serves. The entity holds no
// secret: an endpoint's key is sealed apart from it (the Environment's credentials store) and read only at use time.
//
// A model is named `<endpointId>/<modelId>` everywhere: in t3's picker, in a Session's pi-ai `ModelRef` (the endpoint is
// its provider), and for the model relay and the credential broker that build on this (SPI-1164, SPI-1167). An endpoint's
// id never changes, so a slug stays valid as long as the endpoint keeps the model. A model id may itself hold a `/`
// (OpenRouter's `anthropic/claude-…`): the slug splits at its first one.

/** The pi-ai APIs an endpoint may speak. A sign-in fixes its endpoint's API (`SIGN_IN_KINDS`). */
export const ENDPOINT_APIS = ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai", "mistral-conversations"] as const;
export type EndpointApi = (typeof ENDPOINT_APIS)[number];

/**
 * The OAuth sign-ins an endpoint may have instead of a key (SPI-1164): the Credential broker (the Environment DO) holds
 * the sign-in's tokens and is their only refresher; a Session asks it for an access token at use time.
 * - `chatgpt`: ChatGPT plan usage through "Sign in with ChatGPT", on OpenAI's public Responses API.
 * - `claude`: a Claude Pro or Max plan through Claude Code's OAuth sign-in, on Anthropic's Messages API (SPI-1165).
 */
export const SIGN_INS = ["chatgpt", "claude"] as const;
export type SignIn = (typeof SIGN_INS)[number];

export type EndpointAuth = "api-key" | "none" | SignIn;

/** Whether an endpoint's auth is a sign-in (its credential is the broker's), not a key or none. */
export const isSignIn = (auth: EndpointAuth): auth is SignIn => (SIGN_INS as ReadonlyArray<string>).includes(auth);

/** A sign-in's own facts: where its tokens may go, and how the panel and a turn's failure name it. */
export interface SignInKind {
  readonly api: EndpointApi;
  readonly baseUrl: string;
  /** The vendor's name as messages use it: "is not signed in to <title>", "Sign in with <title>". */
  readonly title: string;
  /** The title of the panel's note: what the owner should weigh before signing in. */
  readonly noteTitle: string;
  /** The panel's plain note beside the sign-in (what is verified of it, and what it needs). */
  readonly note: string;
  /** What a refused request on it most likely means, after "refused its <title> sign-in (HTTP n): ". */
  readonly refused: string;
  /** What the panel says the sign-in is for. */
  readonly about: string;
  /** What the owner pastes back after approving, and how the panel asks for it. */
  readonly paste: { readonly instructions: string; readonly placeholder: string };
  /**
   * Null when sign-out revokes the grant at the vendor; otherwise the vendor offers no revocation, and this says where the
   * owner removes the grant, which stays on the account until then.
   */
  readonly revocation: string | null;
  /** Headers the vendor needs beside the bearer token to list the sign-in's models. */
  readonly listHeaders: Readonly<Record<string, string>>;
  /**
   * Whether a sign-out keeps the account's email (its subject is always forgotten): true where the next sign-in is
   * hinted with it (OpenAI's `login_hint`, with the client id OpenAI issued); otherwise the account is forgotten whole.
   */
  readonly keepsEmail: boolean;
}

/**
 * Every sign-in's facts, by kind: the one table SPI-1165 and SPI-1166 add to. The endpoint's API and base URL are the
 * sign-in's, never the owner's.
 */
export const SIGN_IN_KINDS: Readonly<Record<SignIn, SignInKind>> = {
  chatgpt: {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    title: "ChatGPT",
    noteTitle: "Unverified",
    note: "ChatGPT plan usage is unverified in t3flare: no working sign-in has been seen yet. OpenAI offers it to ChatGPT Plus or Pro plans, for open-source and locally hosted apps. If it fails, please report it with the message shown.",
    refused: "ChatGPT plan usage needs a Plus or Pro plan; otherwise sign in again in the Harness panel.",
    about: "Use your ChatGPT plan's usage for Pi Durable, on OpenAI's Responses API.",
    paste: {
      instructions: "Open the sign-in and approve. Your browser then lands on a 127.0.0.1 page that does not load: copy its whole address into the field, then Finish.",
      placeholder: "http://127.0.0.1:1455/auth/callback?code=…",
    },
    revocation: null,
    listHeaders: {},
    keepsEmail: true,
  },
  claude: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    title: "Claude",
    noteTitle: "Your risk",
    note: "This signs in as Claude Code, with its OAuth client, as pi-ai does. Anthropic's terms may not allow a Claude plan's usage outside its own apps: that risk is yours, chosen knowingly. It needs a Claude Pro or Max plan. Anthropic offers no revocation to apps, so signing out here does not end the grant: remove it at claude.ai, under Settings, Claude Code.",
    refused: "a Claude Pro or Max plan is needed; otherwise sign in with Claude again in the Harness panel.",
    about: "Use your Claude Pro or Max plan's usage for Pi Durable, on Anthropic's Messages API.",
    paste: {
      instructions: "Open the sign-in and approve. Anthropic then shows a code: copy all of it (it holds a #) into the field, then Finish.",
      placeholder: "code#state",
    },
    revocation: "Anthropic offers no revocation to apps: the grant stays on your Claude account until you remove it at claude.ai, under Settings, Claude Code (Authorization tokens).",
    // Anthropic takes a Claude sign-in's token as a bearer only with its OAuth beta (SPI-1161 Q4).
    listHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    keepsEmail: false,
  },
};

/** The headers that carry a `kind` sign-in's access token to its vendor, for its model list. */
export const signInHeaders = (kind: SignIn, accessToken: string): Readonly<Record<string, string>> => ({
  ...SIGN_IN_KINDS[kind].listHeaders,
  authorization: `Bearer ${accessToken}`,
});

/** An endpoint's sign-in facts, or undefined for a key or no auth. */
export const signInOf = (auth: EndpointAuth): SignInKind | undefined => (isSignIn(auth) ? SIGN_IN_KINDS[auth] : undefined);

// pi-ai's credential types, which the Credential broker implements (type-only: no pi-ai in the Environment's bundle).
export type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";

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

/** The small models' families: `haiku`, `mini`, `nano`, `flash`, `lite`, `small`, `tiny`, as a word of the model id. */
const SMALL_MODEL = /(?:^|[-_./:])(?:haiku|mini|nano|flash|lite|small|tiny)(?:$|[-_.:])/i;

/**
 * Text generation's default model (SPI-1163): a small model of the first endpoint, in the owner's order, that has one.
 * Of that endpoint's small models, the cheapest by its known output price, else the first listed. Undefined when no
 * endpoint has a small model.
 */
export const defaultTextModel = (endpoints: ModelEndpoints): string | undefined => {
  for (const endpoint of endpoints.endpoints) {
    const small = endpoint.models.filter((model) => SMALL_MODEL.test(model.id));
    if (small.length === 0) continue;
    const priced = small.filter((model) => model.known);
    const pick = priced.length === 0 ? small[0]! : priced.reduce((best, model) => (model.cost.output < best.cost.output ? model : best));
    return endpointSlug(endpoint.id, pick.id);
  }
  return undefined;
};

/**
 * One text-generation request on an endpoint's model (SPI-1163): the Environment DO's call of the agents Worker's
 * `EndpointTextGeneration`. Ids only: the agents Worker reads the endpoint (`modelEndpoints`) and asks for its key
 * (`endpointCredential`) for that endpoint's target, as a Session does.
 */
export interface EndpointTextRequest {
  readonly endpointId: string;
  readonly modelId: string;
  readonly prompt: string;
}

/** How a message names an endpoint: `The Model endpoint "<id>"`. */
export const endpointLabel = (endpointId: string): string => `The Model endpoint "${endpointId}"`;

/** A text-generation prompt as sent to a model, on every path: t3's prompt, then the ask for its JSON object only. */
export const jsonOnlyPrompt = (prompt: string): string => `${prompt}\n\nAnswer with the JSON object only.`;

/** Its answer: the model's text, or a failure that names the endpoint and never holds a vendor's body or a key. */
export type EndpointTextAnswer = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

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
  /** A sign-in's access token: when it expires (ms). The Session keeps it no later than shortly before. */
  readonly expiresAt?: number;
  /** A sign-in endpoint that is not signed in (never, signed out, or its renewal refused): sign in again. */
  readonly signedOut?: boolean;
  /** Why a sign-in gave no token, as the broker says it (a fixed text, never a token). */
  readonly problem?: string;
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
  if (auth !== "api-key" && auth !== "none" && !(SIGN_INS as ReadonlyArray<unknown>).includes(auth)) return { ok: false, error: `auth is api-key, none or a sign-in (${SIGN_INS.join(", ")})` };
  if (isSignIn(auth as EndpointAuth)) {
    // A sign-in's tokens go only to its own API at its own base URL, with no header of the owner's.
    const target = SIGN_IN_KINDS[auth as SignIn];
    if (value.api !== target.api || baseUrl !== target.baseUrl) return { ok: false, error: `a ${target.title} sign-in's endpoint is ${target.api} at ${target.baseUrl}` };
    if (isRecord(value.headers) && Object.keys(value.headers).length > 0) return { ok: false, error: `a ${target.title} sign-in's endpoint has no headers of its own` };
  }
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
  return { ok: true, endpoint: { id, label, api: value.api as EndpointApi, baseUrl, auth: auth as EndpointAuth, headers, models } };
};
