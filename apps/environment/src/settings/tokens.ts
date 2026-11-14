// The Owner-client endpoint's signed tokens (ADR-0034, plan D11), M5a (SPI-1200): the 2025 session id, the 2026
// `requestState`, and the 2025 elicitation request's id. Each is `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA-256)>`
// under a key only the Environment DO holds (`t3flare:settings:state-key`, made on first use as the panel's CSRF key is).
//
// Every payload names its `kind`, the Access `sub` it was issued to and when it expires, so one kind cannot stand in for
// another, another identity's token is refused, and none lives forever. A token says only what the server wrote into
// it; the server still reads the Open change it names before it does anything (MRTR: `requestState` is attacker input).
import type { KvStorage } from "../harness/store.ts";

/** Where the DO keeps the key. */
export const STATE_KEY = "t3flare:settings:state-key";

export type TokenKind = "session" | "state" | "elicit";

export interface TokenPayload {
  readonly kind: TokenKind;
  /** The caps' key of the caller it was issued to: the Access `sub`, or `service-token`. */
  readonly sub: string;
  /** Milliseconds since the epoch. */
  readonly exp: number;
  readonly [field: string]: unknown;
}

export type TokenRefusal = "malformed" | "bad-signature" | "wrong-kind" | "other-sub" | "expired";

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const hmacKey = (key: Uint8Array<ArrayBuffer>, usage: "sign" | "verify") => crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/** The DO's key, made on first use. */
export const settingsStateKey = (kv: KvStorage): Uint8Array<ArrayBuffer> => {
  const kept = kv.get<ArrayBuffer>(STATE_KEY);
  if (kept !== undefined) return new Uint8Array(kept);
  const key = crypto.getRandomValues(new Uint8Array(32));
  kv.put(STATE_KEY, key.buffer);
  return key;
};

/** `payload`, signed. */
export const signToken = async (key: Uint8Array<ArrayBuffer>, payload: TokenPayload): Promise<string> => {
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), encoder.encode(`v1.${body}`)));
  return `v1.${body}.${base64Url(signature)}`;
};

/** `token`'s payload when it is ours, of `kind`, issued to `sub` and not expired at `now`; else why not. */
export const verifyToken = async (
  key: Uint8Array<ArrayBuffer>,
  token: unknown,
  expected: { readonly kind: TokenKind; readonly sub: string; readonly now: number },
): Promise<{ readonly ok: true; readonly payload: TokenPayload } | { readonly ok: false; readonly reason: TokenRefusal }> => {
  if (typeof token !== "string" || token.length > 8192) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
  const signature = fromBase64Url(parts[2]!);
  const body = fromBase64Url(parts[1]!);
  if (signature === undefined || body === undefined) return { ok: false, reason: "malformed" };
  // The signature first (constant time, by WebCrypto), and only then anything the payload says.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), signature, encoder.encode(`v1.${parts[1]}`)))) return { ok: false, reason: "bad-signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "malformed" };
  const fields = payload as Record<string, unknown>;
  if (fields.kind !== expected.kind) return { ok: false, reason: "wrong-kind" };
  if (fields.sub !== expected.sub) return { ok: false, reason: "other-sub" };
  if (typeof fields.exp !== "number" || fields.exp <= expected.now) return { ok: false, reason: "expired" };
  return { ok: true, payload: fields as TokenPayload };
};
