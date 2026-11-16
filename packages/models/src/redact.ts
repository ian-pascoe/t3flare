// Credentials taken out of error text (SPI-1172), before it reaches t3 or a log: a vendor's error body can echo the key
// it was sent (OpenAI's "Incorrect API key provided: sk-…"), a gateway's can echo a header, and a sign-in's refusal can
// echo its token. Pure, by shape: vendor keys, bearer tokens, JWT-shaped values, key headers and query parameters, and
// any value the caller knows (an endpoint's own key, whatever its shape). Each is replaced in place, so JSON stays JSON
// and a CLI still reads a vendor's error body after the relay has redacted it.

/** What a redacted value becomes. */
export const REDACTED = "[redacted]";

/** A known value shorter than this is not hunted for: it would cut ordinary words. */
const MIN_KNOWN = 8;

/** The shapes, each replaced whole (or, where the first group is a name, the value after it). */
const SHAPES: ReadonlyArray<{ readonly pattern: RegExp; readonly keep?: true }> = [
  // A header or parameter that carries a key, whatever the value's shape (a value already redacted, `<redacted>` or
  // `[redacted]`, is left as it is): `x-api-key: …`, `"api_key":"…"`, `key=…`.
  { pattern: /((?:x-api-key|x-goog-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret)"?\s*[:=]\s*"?)(?![<[]redacted[>\]])[^\s"',;&)]+/gi, keep: true },
  { pattern: /([?&](?:key|token|credential|sig|signature)=)(?![<[]redacted[>\]])[^\s"'&#)]+/gi, keep: true },
  // A bearer token of any shape.
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keep: true },
  // Vendor keys: Anthropic's (`sk-ant-…`, its OAuth `sk-ant-oat…`), OpenAI's (`sk-proj-…`, `sk-…`), masked echoes (`sk-proj-****…`), OpenRouter's.
  { pattern: /\bsk-[A-Za-z0-9_*-]{12,}/g },
  // Google's API keys.
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  // GitHub's tokens.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  // A JWT: three base64url parts, the first two JSON objects (`eyJ`). The signature may be empty (`alg: none`).
  { pattern: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g },
  // OpenAI's opaque access tokens (`ac.1.…`, SPI-1164's scans).
  { pattern: /\bac\.1\.[A-Za-z0-9._-]{16,}/g },
];

/** `text` with every credential-shaped value, and each of `known`, replaced by `REDACTED`. */
export const redactSecrets = (text: string, known: ReadonlyArray<string> = []): string => {
  let out = text;
  for (const value of known) if (value.length >= MIN_KNOWN) out = out.split(value).join(REDACTED);
  for (const { pattern, keep } of SHAPES) out = out.replace(pattern, (...match) => (keep === true ? `${String(match[1])}${REDACTED}` : REDACTED));
  return out;
};
