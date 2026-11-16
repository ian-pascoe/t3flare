// Credentials taken out of error text (SPI-1172), before it reaches t3 or a log: a vendor's error body can echo the key
// it was sent (OpenAI's "Incorrect API key provided: sk-…"), a gateway's can echo a header, and a sign-in's refusal can
// echo its token. Pure, by shape: vendor keys, bearer and basic credentials, JWT-shaped values, key headers and query
// parameters, and any value the caller knows (an endpoint's own key, whatever its shape). The one list every redactor
// uses: the Session, text generation, the model relay and the Environment's redacting Console.
//
// JSON stays JSON: a value is replaced only inside a string, never across a quote or a backslash, and a key's JSON
// value is replaced only when it is a string (`"api_key": null` stays), so a CLI still parses a vendor's error body the
// relay has redacted, and an escaped body inside a string (`\"sk-…\"`) keeps its escapes.

/** What a redacted value becomes: no quote, backslash or control character, so it is safe inside any JSON string. */
export const REDACTED = "[redacted]";

/** A known value shorter than this is not hunted for: it would cut ordinary words. */
const MIN_KNOWN = 8;

/** The names whose value is a credential, whatever its shape. */
const KEY_NAMES = String.raw`(?:x-api-key|x-goog-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret)`;
/** Not a value already redacted (this module's or an older `<redacted>`). */
const FRESH = String.raw`(?![<[]redacted[>\]])`;

/** The shapes, each replaced whole, or (with `keep`) the value after its first group. */
const SHAPES: ReadonlyArray<{ readonly pattern: RegExp; readonly keep?: true }> = [
  // A key's JSON string value: `"api_key":"…"`, and the same escaped inside a string (`\"api_key\":\"…\"`).
  { pattern: new RegExp(String.raw`("${KEY_NAMES}"\s*:\s*")${FRESH}(?:[^"\\]|\\.)+(?=")`, "gi"), keep: true },
  { pattern: new RegExp(String.raw`(\\"${KEY_NAMES}\\"\s*:\s*\\")${FRESH}[^"\\]+(?=\\")`, "gi"), keep: true },
  // A header or parameter in plain text (`x-api-key: …`, `api_key=…`): never a JSON literal, never past a quote or a backslash.
  { pattern: new RegExp(String.raw`(\b${KEY_NAMES}\s*[:=]\s*)${FRESH}(?!(?:null|true|false)\b|-?\d)[^\s"'\\,;&)}\]]+`, "gi"), keep: true },
  // A URL's credential parameter (`?key=…`, `#token=…`, `&credential=…`).
  { pattern: new RegExp(String.raw`([?#&](?:key|token|credential|sig|signature)=)${FRESH}[^\s"'\\&#)]+`, "gi"), keep: true },
  // A bearer or basic credential of any shape.
  { pattern: /((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keep: true },
  // Vendor keys: Anthropic's (`sk-ant-…`, its OAuth `sk-ant-oat…`), OpenAI's (`sk-proj-…`, `sk-…`), masked echoes (`sk-proj-****…`), OpenRouter's.
  { pattern: /\bsk-[A-Za-z0-9_*-]{12,}/g },
  // xAI's and Groq's keys.
  { pattern: /\bxai-[A-Za-z0-9_-]{20,}/g },
  { pattern: /\bgsk_[A-Za-z0-9]{20,}/g },
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

/** Whether `text` holds anything `redactSecrets` would take out. */
export const holdsSecrets = (text: string, known: ReadonlyArray<string> = []): boolean => redactSecrets(text, known) !== text;
