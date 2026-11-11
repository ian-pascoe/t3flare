// The model proxy's failure answers, classified (step 2a part 2; ADR-0012; docs/model-proxy.md → Usage limits). Pure:
// the Session classifies each failed response once, when it is recorded, and the differ and text generation turn the
// result into t3's failure. The contract is Commissary's (rows of the step 2a part 2 plan, section 1).

export interface ProxyAnswer {
  /** The HTTP status the proxy answered; 200 for an error inside a stream that had begun. */
  readonly status: number;
  /** The answer's `retry-after` header, if any. */
  readonly retryAfter: string | null;
  /** pi-ai's error text (`<status> <body>`, or the body alone), or the body itself. */
  readonly text: string;
  /** When the answer was received (epoch ms): a relative reset counts from here. */
  readonly at: number;
}

/**
 * The codes, chosen so that none matches pi-ai's retry pattern (`rate.?limit`, `overloaded`, a status, …): the Session
 * puts the code in the error text it leaves for pi-durable when it stops the retries.
 */
export type ProxyFailureCode =
  | "proxy_cooldown"
  | "proxy_upstream_limit"
  | "proxy_spend_limit"
  | "proxy_request_rate"
  | "proxy_account_unavailable"
  | "proxy_key_rejected"
  | "proxy_account_rejected"
  | "proxy_no_account"
  | "proxy_overloaded"
  | "proxy_server_error";

export interface ProxyFailure {
  /** t3's failure class. */
  readonly class: "usage_limit" | "permission_error" | "provider_error";
  readonly code: ProxyFailureCode;
  /** The row of the plan's table (section 1) it matched. */
  readonly row: number;
  /** When the limit resets (epoch ms), if the proxy said. */
  readonly resetAt?: number;
  /** Whether the Session stops pi-durable's retries of it (a retry cannot succeed before the reset, or ever). */
  readonly stop: boolean;
}

const seconds = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
};

const UNITS: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, "µs": 0.001, ns: 0.000_001 };

/** A Go duration (`2h3m4s`, `1m30.5s`, `500ms`) in ms, or undefined. */
const goDuration = (text: string): number | undefined => {
  if (!/^(\d+(\.\d+)?(h|ms|m|s|us|µs|ns))+$/.test(text)) return undefined;
  let ms = 0;
  for (const [, value, unit] of text.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) ms += Number(value) * UNITS[unit!]!;
  return ms;
};

/** An error body's status as Anthropic's error types imply it, for an error inside a stream. */
const TYPE_STATUS: Readonly<Record<string, number>> = {
  rate_limit_error: 429,
  overloaded_error: 529,
  authentication_error: 401,
  permission_error: 403,
  api_error: 500,
};

/** The body's status, error type and message: Anthropic's `{type:"error",error:{type,message}}` or a flat `{error}`. */
const parse = (answer: ProxyAnswer) => {
  const prefixed = /^(\d{3}) (.*)$/s.exec(answer.text.trim());
  const body = prefixed?.[2] ?? answer.text.trim();
  let type: string | undefined;
  let message = body;
  let flat = false;
  try {
    const json = JSON.parse(body) as { error?: unknown };
    if (typeof json.error === "string") {
      message = json.error;
      flat = true;
    } else if (typeof json.error === "object" && json.error !== null) {
      const error = json.error as { type?: unknown; message?: unknown };
      if (typeof error.type === "string") type = error.type;
      if (typeof error.message === "string") message = error.message;
    }
  } catch {
    // Not JSON: the text is the message.
  }
  const inStream = answer.status < 400;
  const status = !inStream ? answer.status : prefixed !== null ? Number(prefixed[1]) : type === undefined ? undefined : TYPE_STATUS[type];
  return { status, type, message, flat, inStream };
};

/** The proxy's failure, or undefined for an answer that is not one of its known failures. */
export const classifyProxyFailure = (answer: ProxyAnswer): ProxyFailure | undefined => {
  const { status, type, message, flat, inStream } = parse(answer);
  const after = seconds(answer.retryAfter);
  const at = (ms: number | undefined) => (ms === undefined ? {} : { resetAt: answer.at + ms });
  const row = (own: number) => (inStream ? 10 : own);
  const afterMs = after === undefined ? undefined : after * 1000;
  if (status === 429) {
    if (/are cooling down/.test(message)) {
      const hint = /\(reset after ([^)]+)\)/.exec(message)?.[1];
      const ms = afterMs ?? (hint === undefined ? undefined : goDuration(hint));
      return { class: "usage_limit", code: "proxy_cooldown", row: row(1), ...at(ms), stop: true };
    }
    const spend = /Spend limit .* is reached; it resets at (\S+)/.exec(message);
    if (spend !== null) {
      const named = Date.parse(spend[1]!);
      const resetAt = Number.isFinite(named) ? { resetAt: named } : at(afterMs);
      return { class: "usage_limit", code: "proxy_spend_limit", row: row(3), ...resetAt, stop: true };
    }
    if (flat && /^Rate limit exceeded$/i.test(message)) {
      return { class: "usage_limit", code: "proxy_request_rate", row: row(4), ...at(afterMs), stop: true };
    }
    // An upstream's own 429: without a reset it is retried, and the next answer is Commissary's cooldown with one.
    return { class: "usage_limit", code: "proxy_upstream_limit", row: row(2), ...at(afterMs), stop: afterMs !== undefined };
  }
  if (status === 503 && /no auth available/.test(message)) {
    return afterMs === undefined
      ? { class: "provider_error", code: "proxy_no_account", row: row(8), stop: true }
      : { class: "usage_limit", code: "proxy_account_unavailable", row: row(8), ...at(afterMs), stop: true };
  }
  if (status === 401 || status === 403) {
    // The proxy's own gate answers flat `{"error":"…"}`; an upstream account's refusal comes in Anthropic's shape.
    // Anything else (an HTML page from something in front of the proxy) is neither.
    if (flat) return { class: "permission_error", code: "proxy_key_rejected", row: row(5), stop: true };
    if (type !== undefined) return { class: "permission_error", code: "proxy_account_rejected", row: row(7), stop: true };
    return undefined;
  }
  if (status === 529 || type === "overloaded_error") return { class: "provider_error", code: "proxy_overloaded", row: row(9), stop: false };
  if (status !== undefined && status >= 500) return { class: "provider_error", code: "proxy_server_error", row: row(9), stop: false };
  return undefined;
};

const MESSAGES: Readonly<Record<ProxyFailureCode, string>> = {
  proxy_cooldown: "Every account the model proxy has for this model is at its usage limit.",
  proxy_upstream_limit: "The model provider's usage limit was reached.",
  proxy_spend_limit: "The model proxy's spend limit for this key is reached.",
  proxy_request_rate: "The model proxy's request rate limit for this key was reached.",
  proxy_account_unavailable: "No account the model proxy has for this model is available until one recovers.",
  proxy_key_rejected: "The model proxy refused this Environment's key. Check `MODEL_PROXY_API_KEY`.",
  proxy_account_rejected: "The proxy's account for this model was refused; reconnect it in the proxy.",
  proxy_no_account: "The model proxy has no usable account for this model.",
  proxy_overloaded: "The model provider is overloaded.",
  proxy_server_error: "The model provider or the proxy failed.",
};

/** The failure's text for t3: fixed by its code, never the proxy's body (which can echo request details). */
export const proxyFailureMessage = (failure: ProxyFailure): string => MESSAGES[failure.code];

/**
 * The error text the Session leaves in pi-durable for a failure it stops the retries of: no pattern of pi-ai's
 * retry classification matches it (the codes avoid them), so the run ends after this one request.
 */
export const PROXY_FAILURE_PREFIX = "t3flare model proxy: ";
export const proxyFailureDetail = (failure: ProxyFailure): string => `${PROXY_FAILURE_PREFIX}${failure.code}`;
