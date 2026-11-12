// @effect-diagnostics globalDate:off
// The harness panel's CSRF token (ADR-0026, plan §6.4 with the review's LOW item): an HMAC, under a key only the
// Environment DO holds, of the owner's Access subject and the hour. Bound to the owner's Access session, useless to
// another origin (which cannot read the page to learn it), and accepted for the current and the previous hour so a page
// left open across the hour still works.
import { timingSafeEqual } from "../access.ts";

const HOUR_MS = 60 * 60 * 1000;

const base64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const hmac = async (key: Uint8Array<ArrayBuffer>, text: string): Promise<string> => {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text)));
};

const hourOf = (nowMs: number) => Math.floor(nowMs / HOUR_MS);

/** The token for `subject` this hour. */
export const csrfToken = (key: Uint8Array<ArrayBuffer>, subject: string, nowMs: number = Date.now()): Promise<string> =>
  hmac(key, `harness:${subject}:${hourOf(nowMs)}`);

/** Whether `token` is `subject`'s for this hour or the previous one. */
export const csrfValid = async (key: Uint8Array<ArrayBuffer>, subject: string, token: string | null, nowMs: number = Date.now()): Promise<boolean> => {
  if (token === null || token === "" || subject === "") return false;
  const hour = hourOf(nowMs);
  for (const at of [hour, hour - 1]) {
    if (timingSafeEqual(token, await hmac(key, `harness:${subject}:${at}`))) return true;
  }
  return false;
};
