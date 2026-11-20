// @effect-diagnostics globalDate:off
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
 * - `rate_limited`: a 429 rate limit.
 * - `key_refused`, `sign_in_refused`, `credential_needed` (no auth, refused): a 401 or 403, by the endpoint's auth.
 * - `plan_not_eligible`: the plan or user cannot use this route.
 * - `unsupported_request`: plan usage refused a capability of the request.
 * - `overloaded`, `server_error`, `unavailable`: passing, retried.
 *
 * The Session leaves pi-durable a text by the failure (`modelFailureDetail`): for one it stops on, a text no retry
 * pattern of pi-ai's matches (it names the class, never the code: `rate_limited` would match `rate.?limit`); for one it
 * retries, a text one of them matches.
 */
export type ModelFailureCode =
  | "usage_limit"
  | "workspace_limit"
  | "spend_limit"
  | "rate_limited"
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

/** An API's family: the shapes its vendor answers in. The other APIs get only the rows for every API. */
type Family = "anthropic" | "openai";

const FAMILY: Readonly<Partial<Record<EndpointApi, Family>>> = {
  "anthropic-messages": "anthropic",
  "openai-responses": "openai",
  "openai-completions": "openai",
};

/** What the rows read of an answer. */
interface Read {
  /** The HTTP status, or the one an error inside a stream implies; undefined when nothing says. */
  readonly status: number | undefined;
  /** The error's `type` (Anthropic's, OpenAI's) and `code` (OpenAI's), Anthropic's `details.error_code`. */
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly detailCode: string | undefined;
  /** The error's message: read by one row only, Anthropic's owner-set spend limit, whose docs name its opening words. */
  readonly message: string;
  /** The error object's fields (ChatGPT's `resets_at`). */
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
    message: str(error.message) ?? "",
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

/** An error answer's body, at most `limit` bytes (`readBody`), for classifying it. Undefined when it cannot be read. */
export const errorBodyOf = async (response: Response, limit = ERROR_BODY_BYTES): Promise<string | undefined> => {
  return (await readBody(response, limit))?.text;
};

/**
 * Up to `limit` bytes of an answer's body, read from a copy so its reader still gets the answer whole, and whether there
 * was more (the rest is cancelled, never read). Undefined when it cannot be read.
 */
export const readBody = async (response: Response, limit: number): Promise<{ readonly text: string; readonly over: boolean } | undefined> => {
  try {
    const body = response.clone().body;
    if (body === null) return { text: "", over: false };
    const reader = body.getReader();
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    try {
      while (size <= limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, bytes.byteLength - offset);
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return { text: new TextDecoder().decode(bytes), over: size > limit };
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

/** Anthropic's unified limit's reset, else the answer's `retry-after`. */
const unifiedOrRetryAfter = (r: Read): number | undefined => unifiedReset(r) ?? retryAfter(r);

/** ChatGPT's `resets_at` (epoch seconds; codex-rs `UsageErrorBody`), else `retry-after`. */
const chatgptReset = (r: Read): number | undefined => epochSeconds(r.error.resets_at) ?? retryAfter(r);

/**
 * OpenAI's: `retry-after` first, else the later reset of the windows whose remaining count is 0. OpenAI's rate-limit
 * guide (platform.openai.com/docs/guides/rate-limits, "Rate limits in headers", read 2026-11-16): `x-ratelimit-reset-*`
 * is the time until that window "resets to its initial state", and `x-ratelimit-remaining-*` what it still permits; only
 * an exhausted window refuses. With none at 0 there is no reset to wait for: a short rate limit, retried.
 */
const openaiReset = (r: Read): number | undefined => {
  const after = retryAfter(r);
  if (after !== undefined) return after;
  const exhausted = ["requests", "tokens", "project-tokens"].flatMap((name) => {
    if (r.header(`x-ratelimit-remaining-${name}`)?.trim() !== "0") return [];
    const reset = r.header(`x-ratelimit-reset-${name}`);
    const ms = reset === undefined ? undefined : goDuration(reset.trim());
    return ms === undefined ? [] : [ms];
  });
  return exhausted.length === 0 ? undefined : r.at + Math.max(...exhausted);
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
  { families: ["anthropic"], when: (r) => status(r, 429) && r.header("anthropic-ratelimit-unified-status") === "rejected", code: "usage_limit", reset: unifiedOrRetryAfter },
  { families: ["anthropic"], when: (r) => r.detailCode === "enforced_spend_limit_reached" || named(r, "billing_error") || status(r, 402), code: "spend_limit" },
  // An owner-set spend limit: 400 `invalid_request_error`, which the rate-limits page tells apart only by the message's
  // documented opening ("You have reached your specified API usage limits", or "… workspace API usage limits").
  { families: ["anthropic"], when: (r) => status(r, 400) && named(r, "invalid_request_error") && /^You have reached your specified (?:workspace )?API usage limits/.test(r.message), code: "spend_limit" },
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
  { families: ["openai"], when: (r) => named(r, ...OPENAI_SPEND) || status(r, 402), code: "spend_limit" },
  { families: ["openai"], when: (r) => status(r, 429), code: "rate_limited", reset: openaiReset },
  { families: ["openai"], when: (r) => named(r, "server_is_overloaded"), code: "overloaded" },
  // Every API: a 429's retry-after; a refused credential by the endpoint's auth; overload and server errors.
  { families: "any", when: (r) => status(r, 429), code: "rate_limited", reset: retryAfter },
  { families: "any", auths: ["api-key"], when: (r) => status(r, 401, 403), code: "key_refused" },
  { families: "any", auths: SIGN_INS, when: (r) => status(r, 401, 403), code: "sign_in_refused" },
  { families: "any", auths: ["none"], when: (r) => status(r, 401, 403), code: "credential_needed" },
  // 501 Not Implemented: the endpoint does not do what was asked; no retry changes that.
  { families: "any", when: (r) => status(r, 501), code: "unsupported_request" },
  { families: "any", when: (r) => status(r, 503, 529), code: "overloaded" },
  { families: "any", when: (r) => r.status !== undefined && r.status >= 500, code: "server_error" },
];

/**
 * The longest reset a rate limit is retried through within the run: pi-durable's default retries (3, 2 s doubling:
 * `DEFAULT_RETRY_POLICY` and pi-ai's `retryDelayMs`) span 2 + 4 + 8 = 14 s, so a 429 that resets within that is met by
 * one of them; a later reset is out of their reach and pauses the thread until it at once, with one request.
 */
export const SHORT_RESET_MS = 14_000;

/** The least time after now a usage limit's reset is held to: t3 arms no resume for one not after the turn's end. */
export const MIN_RESET_MS = 30_000;

/** A usage limit's reset as t3 takes it (ISO, at least `MIN_RESET_MS` after `now`), or null for another class or none. */
export const heldReset = (failure: { readonly class: string; readonly resetAt?: number }, now: number): string | null =>
  failure.class === "usage_limit" && failure.resetAt !== undefined ? new Date(Math.max(failure.resetAt, now + MIN_RESET_MS)).toISOString() : null;

/** Each code's class, whether a retry can help, and whether one is worth making before the reset (or at all). */
const KINDS: Readonly<Record<ModelFailureCode, { readonly class: ModelFailure["class"]; readonly retryable: boolean; readonly stop: "always" | "long-reset" | "never" }>> = {
  usage_limit: { class: "usage_limit", retryable: true, stop: "always" },
  workspace_limit: { class: "usage_limit", retryable: false, stop: "always" },
  spend_limit: { class: "usage_limit", retryable: false, stop: "always" },
  rate_limited: { class: "usage_limit", retryable: true, stop: "long-reset" },
  key_refused: { class: "permission_error", retryable: false, stop: "always" },
  sign_in_refused: { class: "permission_error", retryable: false, stop: "always" },
  credential_needed: { class: "permission_error", retryable: false, stop: "always" },
  plan_not_eligible: { class: "permission_error", retryable: false, stop: "always" },
  unsupported_request: { class: "provider_error", retryable: false, stop: "always" },
  overloaded: { class: "provider_error", retryable: true, stop: "never" },
  server_error: { class: "provider_error", retryable: true, stop: "never" },
  unavailable: { class: "provider_error", retryable: true, stop: "never" },
};

/**
 * A code's failure as the table's rows give it, for a failure known without an answer to read (the model relay's own
 * refusal of a sign-in that gave no token, SPI-1171): its class, retryability and whether retries stop. No reset.
 */
export const modelFailureOf = (code: ModelFailureCode): ModelFailure => {
  const kind = KINDS[code];
  return { class: kind.class, code, retryable: kind.retryable, stop: kind.stop === "always" };
};

/** The endpoint's failure, or undefined for an answer that is none of the known ones (a 400 the request caused, a 404). */
export const classifyModelFailure = (answer: FailedAnswer, endpoint: FailedEndpoint): ModelFailure | undefined => {
  const r = read(answer);
  const family = FAMILY[endpoint.api];
  const row = ROWS.find((entry) => (entry.families === "any" || (family !== undefined && entry.families.includes(family))) && (entry.auths === undefined || entry.auths.includes(endpoint.auth)) && entry.when(r));
  if (row === undefined) return undefined;
  const kind = KINDS[row.code];
  const resetAt = row.reset?.(r);
  const stop = kind.stop === "always" || (kind.stop === "long-reset" && resetAt !== undefined && resetAt - answer.at > SHORT_RESET_MS);
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
    case "rate_limited":
      return `${name} is rate-limited${http}.`;
    case "key_refused":
      return `${name} refused its API key${http}: check it in the Settings page.`;
    case "sign_in_refused":
      return signIn === undefined ? `${name} refused its sign-in${http}: sign in again in the Settings page.` : `${name} refused its ${signIn.title} sign-in${http}: ${signIn.refused}`;
    case "credential_needed":
      return `${name} refused the request without a credential${http}: check its auth in the Settings page.`;
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

/** A classified failure with the text t3 shows for it. */
export interface DescribedFailure extends ModelFailure {
  readonly message: string;
}

/** The answer classified by the endpoint's API and auth, with its text (`modelFailureMessage`); undefined when unknown. */
export const describeFailure = (answer: FailedAnswer, endpoint: FailedEndpoint): DescribedFailure | undefined => {
  const failure = classifyModelFailure(answer, endpoint);
  return failure === undefined ? undefined : { ...failure, message: modelFailureMessage(failure, endpoint, answer.status) };
};

/** A usage limit's reset as one sentence ("It resets at <ISO>."), or "" for another class or no reset. */
export const resetSentence = (failure: Pick<ModelFailure, "class" | "resetAt">): string =>
  failure.class === "usage_limit" && failure.resetAt !== undefined ? ` It resets at ${new Date(failure.resetAt).toISOString()}.` : "";

/**
 * The error text the Session leaves in pi-durable for a classified failure. One it stops the retries of matches no retry
 * pattern of pi-ai's (the codes avoid them), so the run ends after this one request; one that is retried carries words
 * that one of pi-ai's patterns matches, so pi-durable retries it whatever the vendor's text said (a bare 529 or 521).
 */
export const MODEL_FAILURE_PREFIX = "t3flare model endpoint: ";

/** The words of a retried failure's text: each matches one of pi-ai's retry patterns. */
const retriedWords = (code: ModelFailureCode): string | undefined => {
  switch (code) {
    case "rate_limited":
      return "rate limit";
    case "overloaded":
      return "overloaded";
    case "server_error":
      return "server error";
    case "unavailable":
      return "service unavailable";
    case "usage_limit":
    case "workspace_limit":
    case "spend_limit":
    case "key_refused":
    case "sign_in_refused":
    case "credential_needed":
    case "plan_not_eligible":
    case "unsupported_request":
      return undefined;
  }
};

export const modelFailureDetail = (failure: ModelFailure): string => {
  const words = failure.stop ? undefined : retriedWords(failure.code);
  return words === undefined ? `${MODEL_FAILURE_PREFIX}${failure.class}, not retried` : `${MODEL_FAILURE_PREFIX}${failure.code} (${words}, retried)`;
};
