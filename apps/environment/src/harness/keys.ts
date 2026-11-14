// The Environment DO's own keys and their encoding: base64url (RFC 4648 §5, no padding) for tokens and ids, and the
// random keys the DO keeps in its KV storage, made on first use (the panel's CSRF key, the Settings server's token key).

/** The Durable Object's synchronous key-value storage. */
export interface KvStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

/** `bytes` as base64url without padding. */
export const base64Url = (bytes: Uint8Array | ArrayBuffer): string =>
  btoa(String.fromCharCode(...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** The bytes of base64url `text` (padded or not), or undefined when it is not base64url. */
export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/** The 32-byte key kept under `name`, made on first use. */
export const keptKey = (kv: KvStorage, name: string): Uint8Array<ArrayBuffer> => {
  const kept = kv.get<ArrayBuffer>(name);
  if (kept !== undefined) return new Uint8Array(kept);
  const key = crypto.getRandomValues(new Uint8Array(32));
  kv.put(name, key.buffer);
  return key;
};
