// A Model endpoint's failed answer, classified by the endpoint's API and auth (SPI-1172; the step-2a2 plan's §3 table as
// the starting point). Pure: the Session classifies each failed response once, when it is recorded (Durable turns and
// compaction), text generation classifies its one request, and the relay logs the class of what it passes back. The
// result is t3's failure class, a code, the reset when the vendor gave one, and whether a retry can help.
//
// The table reads what each vendor documents as machine-readable: the status, the error's `type` and `code`, the reset
// headers and body fields. It never reads a message's prose (an Anthropic spend cap's "You will regain access on …" is
// not a reset). Rows are tried in order, the first match wins; a row may be for some APIs and some auths, so a new
// API or sign-in kind adds rows rather than branches. Sources, with their read dates, are in
// packages/models/test/fixtures/vendors.json; how each row is tested, in apps/environment/test/modelFailures.test.ts.
import { type EndpointApi, type EndpointAuth, endpointLabel, SIGN_INS, signInOf } from "./endpoints.ts";

/** A failed answer as recorded: the HTTP status (200 for an error inside a stream that had begun), headers, body or pi-ai's text. */
export interface FailedAnswer {
  readonly status: number;
  /** The answer's headers, lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The error body as received (bounded), or pi-ai's error text for an error inside a stream. */
  readonly body: string;
  /** When the answer came (epoch ms): a relative reset counts from here. */
  readonly at: number;
}

/** What the classifier reads of the endpoint: its API and auth (and its id, for messages). */
export interface FailedEndpoint {
  readonly id: string;
  readonly api: EndpointApi;
  readonly auth: EndpointAuth;
}

/**
 * - `usage_limit`: a subscription's or plan's usage window (Anthropic's unified limit, ChatGPT's `usage_limit_reached`,
 *   plan usage's `subscription_sharing_usage_limit_exceeded`); `workspace_limit`: one a workspace admin set.
 * - `spend_limit`: quota, credits, a spend cap or billing: no retry clears it.
 * - `throttled`: a 429 rate limit.
 * - `key_refused`, `sign_in_refused`, `credential_needed` (no auth, refused): a 401 or 403, by the endpoint's auth.
 * - `plan_not_eligible`: the plan or user cannot use this route.
 * - `unsupported_request`: plan usage refused a capability of the request.
 * - `overloaded`, `server_error`, `unavailable`: passing, retried.
 *
 * No code the Session stops on matches pi-ai's retry patterns (`rate.?limit`, `overloaded`, `server.?error`, a status,
 * …), so it can leave the code in the error text to stop pi-durable's retries (hence `throttled`, not `rate_limited`).
 */
export type ModelFailureCode =
  | "usage_limit"
  | "workspace_limit"
  | "spend_limit"
  | "throttled"
  | "key_refused"
  | "sign_in_refused"
  | "credential_needed"
  | "plan_not_eligible"
  | "unsupported_request"
  | "overloaded"
  | "server_error"
  | "unavailable";

export interface ModelFailure {
  /** t3's failure class. */
  readonly class: "usage_limit" | "permission_error" | "provider_error";
  readonly code: ModelFailureCode;
  /** When the limit resets (epoch ms), when the vendor said. */
  readonly resetAt?: number;
  /** Whether the same request can succeed later (t3's `retryable`). */
  readonly retryable: boolean;
  /** Whether the Session stops pi-durable's retries of it: none can succeed before the reset, or ever. */
  readonly stop: boolean;
}

/** An API's family: the shapes its vendor answers in. */
type Family = "anthropic" | "openai" | "other";

const FAMILY: Readonly<Record<EndpointApi, Family>> = {
  "anthropic-messages": "anthropic",
  "openai-responses": "openai",
  "openai-completions": "openai",
  "google-generative-ai": "other",
  "mistral-conversations": "other",
};

/** What the rows read of an answer. */
interface Read {
  /** The HTTP status, or the one an error inside a stream implies; undefined when nothing says. */
  readonly status: number | undefined;
  /** The error's `type` (Anthropic's, OpenAI's) and `code` (OpenAI's), Anthropic's `details.error_code`. */
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly detailCode: string | undefined;
  /** The error object's fields (ChatGPT's `resets_at`, `resets_in_seconds`). */
  readonly error: Readonly<Record<string, unknown>>;
  readonly header: (name: string) => string | undefined;
  readonly at: number;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The first JSON object in `text`: a body, or one inside pi-ai's text (`429 {…}`, `Error: {…}`). */
const jsonIn = (text: string): Readonly<Record<string, unknown>> | undefined => {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The status an error type implies, for an error inside a stream (Anthropic's types; OpenAI's codes). */
const IMPLIED_STATUS: Readonly<Record<string, number>> = {
  rate_limit_error: 429,
  overloaded_error: 529,
  authentication_error: 401,
  permission_error: 403,
  billing_error: 402,
  api_error: 500,
  insufficient_quota: 429,
  rate_limit_exceeded: 429,
  server_is_overloaded: 503,
  server_error: 500,
};

const read = (answer: FailedAnswer): Read => {
  const headers = new Map(Object.entries(answer.headers).map(([name, value]) => [name.toLowerCase(), value]));
  const json = jsonIn(answer.body);
  const error = isRecord(json?.error) ? json.error : {};
  const details = isRecord(error.details) ? error.details : {};
  const type = str(error.type);
  let code = str(error.code);
  // pi-ai's text for a Responses `response.failed` or `error` event: `<code>: <message>`, `Error Code <code>: <message>`.
  if (json === undefined) {
    const coded = /^(?:Error Code )?([a-z][a-z0-9_]{2,}):/.exec(answer.body.trim());
    if (coded !== null) code = coded[1];
  }
  const inStream = answer.status < 400;
  const implied = (code !== undefined ? IMPLIED_STATUS[code] : undefined) ?? (type !== undefined ? IMPLIED_STATUS[type] : undefined);
  return {
    status: inStream ? implied : answer.status,
    type,
    code,
    detailCode: str(details.error_code),
    error,
    header: (name) => headers.get(name),
    at: answer.at,
  };
};

// Reading an answer ------------------------------------------------------------------------------------------------

/** How much of an error answer's body is read: vendors' error bodies are a few hundred bytes. */
export const ERROR_BODY_BYTES = 16 * 1024;

/** The headers a failure's class reads: `retry-after*`, Anthropic's unified limit, OpenAI's `x-ratelimit-*`. */
const FAILURE_HEADER = /^(?:retry-after(?:-ms)?|anthropic-ratelimit-unified-[a-z0-9-]+|x-ratelimit-[a-z-]+)$/;

/** An answer's headers the classifier reads, lowercase. */
export const failureHeaders = (headers: Headers): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [name, value] of headers) if (FAILURE_HEADER.test(name)) kept[name] = value;
  return kept;
};

/**
 * An error answer's body, at most `ERROR_BODY_BYTES`, read from a copy so its reader still gets the answer whole; the
 * rest is cancelled, never read. Undefined when it cannot be read.
 */
export const errorBodyOf = async (response: Response): Promise<string | undefined> => {
  try {
    const body = response.clone().body;
    if (body === null) return "";
    const reader = body.getReader();
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    try {
      while (size < ERROR_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(Math.min(size, ERROR_BODY_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, bytes.byteLength - offset);
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

// Resets ------------------------------------------------------------------------------------------------------------

/** `retry-after-ms`, else `retry-after` in seconds or as an HTTP date, from the answer's time. */
const retryAfter = (r: Read): number | undefined => {
  const ms = Number.parseFloat(r.header("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return r.at + ms;
  const value = r.header("retry-after")?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return r.at + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
};

/** Epoch seconds as ms, when the value is one. */
const epochSeconds = (value: unknown): number | undefined => {
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
  return seconds === undefined || seconds <= 0 ? undefined : seconds * 1000;
};

const UNITS: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

/** A Go duration (`1s`, `6m0s`, `20ms`, `1h2m3.5s`) in ms, as OpenAI's `x-ratelimit-reset-*` give it. */
const goDuration = (text: string): number | undefined => {
  if (!/^(\d+(\.\d+)?(h|ms|m|s))+$/.test(text)) return undefined;
  let ms = 0;
  for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) ms += Number(value) * UNITS[unit!]!;
  return ms;
};

/** Anthropic's unified limit: the reset of the claim that refused (`anthropic-ratelimit-unified-reset`, epoch seconds). */
const unifiedReset = (r: Read): number | undefined => epochSeconds(r.header("anthropic-ratelimit-unified-reset"));

/** ChatGPT's `resets_at` (epoch seconds), else `resets_in_seconds` from the answer's time, else `retry-after`. */
const chatgptReset = (r: Read): number | undefined => {
  const at = epochSeconds(r.error.resets_at);
  if (at !== undefined) return at;
  const seconds = r.error.resets_in_seconds;
  if (typeof seconds === "number" && seconds > 0) return r.at + seconds * 1000;
  return retryAfter(r);
};

/** OpenAI's: `retry-after` first, else the later of the `x-ratelimit-reset-*` whose remaining count is 0 (all, when none says). */
const openaiReset = (r: Read): number | undefined => {
  const after = retryAfter(r);
  if (after !== undefined) return after;
  const windows = ["requests", "tokens", "project-tokens"].flatMap((name) => {
    const reset = r.header(`x-ratelimit-reset-${name}`);
    const ms = reset === undefined ? undefined : goDuration(reset.trim());
    return ms === undefined ? [] : [{ ms, exhausted: r.header(`x-ratelimit-remaining-${name}`)?.trim() === "0" }];
  });
  const used = windows.some((window) => window.exhausted) ? windows.filter((window) => window.exhausted) : windows;
  return used.length === 0 ? undefined : r.at + Math.max(...used.map((window) => window.ms));
};

// The table ---------------------------------------------------------------------------------------------------------

interface Row {
  /** The API families it reads, or every one. */
  readonly families: ReadonlyArray<Family> | "any";
  /** The auths it is for, or every one. */
  readonly auths?: ReadonlyArray<EndpointAuth>;
  readonly when: (r: Read) => boolean;
  readonly code: ModelFailureCode;
  /** The reset, when the vendor gives one. */
  readonly reset?: (r: Read) => number | undefined;
}

const named = (r: Read, ...names: ReadonlyArray<string>): boolean => names.includes(r.type ?? "") || names.includes(r.code ?? "");
const status = (r: Read, ...statuses: ReadonlyArray<number>): boolean => r.status !== undefined && statuses.includes(r.status);

const OPENAI_SPEND = ["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"];

const ROWS: ReadonlyArray<Row> = [
  // Anthropic Messages (platform.claude.com/docs/en/api/errors, /rate-limits; Claude Code's unified headers).
  { families: ["anthropic"], when: (r) => status(r, 429) && r.header("anthropic-ratelimit-unified-status") === "rejected", code: "usage_limit", reset: unifiedReset },
  { families: ["anthropic"], when: (r) => r.detailCode === "enforced_spend_limit_reached" || named(r, "billing_error") || status(r, 402), code: "spend_limit" },
  { families: ["anthropic"], when: (r) => named(r, "overloaded_error") || status(r, 529), code: "overloaded" },
  // ChatGPT's Codex backend (codex-rs api_bridge.rs) and plan usage (developers.openai.com/siwc/…/errors-and-recovery).
  { families: ["openai"], when: (r) => named(r, "usage_limit_reached"), code: "usage_limit", reset: chatgptReset },
  { families: ["openai"], when: (r) => named(r, "usage_not_included"), code: "plan_not_eligible" },
  { families: ["openai"], when: (r) => named(r, "subscription_sharing_usage_limit_exceeded"), code: "usage_limit" },
  { families: ["openai"], when: (r) => named(r, "subscription_sharing_workplace_individual_usage_limit_exceeded"), code: "workspace_limit" },
  {
    families: ["openai"],
    when: (r) => named(r, "subscription_sharing_user_not_eligible", "subscription_sharing_route_not_supported", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"),
    code: "plan_not_eligible",
  },
  { families: ["openai"], when: (r) => named(r, "subscription_sharing_invalid_user"), code: "sign_in_refused" },
  { families: ["openai"], when: (r) => named(r, "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"), code: "unavailable" },
  { families: ["openai"], when: (r) => named(r, "subscription_sharing_unsupported_capability"), code: "unsupported_request" },
  // OpenAI's API (platform.openai.com/docs/guides/error-codes, /rate-limits).
  { families: ["openai"], when: (r) => named(r, ...OPENAI_SPEND), code: "spend_limit" },
  { families: ["openai"], when: (r) => status(r, 429), code: "throttled", reset: openaiReset },
  { families: ["openai"], when: (r) => named(r, "server_is_overloaded"), code: "overloaded" },
  // Every API: a 429's retry-after; a refused credential by the endpoint's auth; overload and server errors.
  { families: "any", when: (r) => status(r, 429), code: "throttled", reset: retryAfter },
  { families: "any", auths: ["api-key"], when: (r) => status(r, 401, 403), code: "key_refused" },
  { families: "any", auths: SIGN_INS, when: (r) => status(r, 401, 403), code: "sign_in_refused" },
  { families: "any", auths: ["none"], when: (r) => status(r, 401, 403), code: "credential_needed" },
  { families: "any", when: (r) => status(r, 503, 529), code: "overloaded" },
  { families: "any", when: (r) => r.status !== undefined && r.status >= 500, code: "server_error" },
];

/** Each code's class, whether a retry can help, and whether one is worth making before the reset (or at all). */
const KINDS: Readonly<Record<ModelFailureCode, { readonly class: ModelFailure["class"]; readonly retryable: boolean; readonly stop: "always" | "with-reset" | "never" }>> = {
  usage_limit: { class: "usage_limit", retryable: true, stop: "always" },
  workspace_limit: { class: "usage_limit", retryable: false, stop: "always" },
  spend_limit: { class: "usage_limit", retryable: false, stop: "always" },
  throttled: { class: "usage_limit", retryable: true, stop: "with-reset" },
  key_refused: { class: "permission_error", retryable: false, stop: "always" },
  sign_in_refused: { class: "permission_error", retryable: false, stop: "always" },
  credential_needed: { class: "permission_error", retryable: false, stop: "always" },
  plan_not_eligible: { class: "permission_error", retryable: false, stop: "always" },
  unsupported_request: { class: "provider_error", retryable: false, stop: "always" },
  overloaded: { class: "provider_error", retryable: true, stop: "never" },
  server_error: { class: "provider_error", retryable: true, stop: "never" },
  unavailable: { class: "provider_error", retryable: true, stop: "never" },
};

/** The endpoint's failure, or undefined for an answer that is none of the known ones (a 400 the request caused, a 404). */
export const classifyModelFailure = (answer: FailedAnswer, endpoint: FailedEndpoint): ModelFailure | undefined => {
  const r = read(answer);
  const family = FAMILY[endpoint.api];
  const row = ROWS.find((entry) => (entry.families === "any" || entry.families.includes(family)) && (entry.auths === undefined || entry.auths.includes(endpoint.auth)) && entry.when(r));
  if (row === undefined) return undefined;
  const kind = KINDS[row.code];
  const resetAt = row.reset?.(r);
  const stop = kind.stop === "always" || (kind.stop === "with-reset" && resetAt !== undefined);
  return { class: kind.class, code: row.code, ...(resetAt === undefined ? {} : { resetAt }), retryable: kind.retryable, stop };
};

/** The failure's text for t3: fixed by its code, naming the endpoint; never the vendor's body. */
export const modelFailureMessage = (failure: ModelFailure, endpoint: Pick<FailedEndpoint, "id" | "auth">, status?: number): string => {
  const name = endpointLabel(endpoint.id);
  const signIn = signInOf(endpoint.auth);
  const http = status === undefined || status < 400 ? "" : ` (HTTP ${status})`;
  switch (failure.code) {
    case "usage_limit":
      return signIn === undefined ? `${name} reached its usage limit.` : `${name} reached its ${signIn.title} usage limit.`;
    case "workspace_limit":
      return `${name} reached the usage limit its workspace's admin set${signIn === undefined ? "" : ` for ${signIn.title}`}; only the admin can raise it.`;
    case "spend_limit":
      return `${name}'s account is out of quota, credit or its spend limit: raise it with the vendor.`;
    case "throttled":
      return `${name} is rate-limited${http}.`;
    case "key_refused":
      return `${name} refused its API key${http}: check it in the Harness panel.`;
    case "sign_in_refused":
      return signIn === undefined ? `${name} refused its sign-in${http}: sign in again in the Harness panel.` : `${name} refused its ${signIn.title} sign-in${http}: ${signIn.refused}`;
    case "credential_needed":
      return `${name} refused the request without a credential${http}: check its auth in the Harness panel.`;
    case "plan_not_eligible":
      return signIn === undefined
        ? `${name}'s account or plan cannot be used for this request${http}.`
        : `${name}'s ${signIn.title} account cannot use its plan for this request${http}: ${signIn.refused}`;
    case "unsupported_request":
      return `${name} refused a capability of the request${http}${signIn === undefined ? "" : ` (${signIn.title} plan usage)`}.`;
    case "overloaded":
      return `${name} is overloaded${http}.`;
    case "server_error":
      return `${name} failed${http}.`;
    case "unavailable":
      return `${name} is temporarily unavailable${http}.`;
  }
};

/**
 * The error text the Session leaves in pi-durable for a failure it stops the retries of: no retry pattern of pi-ai's
 * matches it (the codes avoid them), so the run ends after this one request.
 */
export const MODEL_FAILURE_PREFIX = "t3flare model endpoint: ";
export const modelFailureDetail = (failure: ModelFailure): string => `${MODEL_FAILURE_PREFIX}${failure.code}`;
