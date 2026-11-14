// @effect-diagnostics globalDate:off extendsNativeError:off
// The sealed credentials store (SPI-1162; step-2a2's design): a credential the Environment keeps for the owner (a Model
// endpoint's API key today; the credential broker's sign-ins next, SPI-1164) is kept in the Environment DO's storage only
// sealed, AES-256-GCM under a key derived (HKDF-SHA256) from the stage's credentials key `T3FLARE_CREDENTIALS_KEY`, with
// the record's name as additional data, so a record moved to another name does not open. DO storage is encrypted by the
// platform too; the seal keeps a storage dump, or a route that shows stored values, from showing a usable key.
//
// Write-only to everything but `open`: what is shown is that a value is set, when, and a fingerprint (an HMAC under a
// second derived key, never the value). Without a credentials key (or with a short one) nothing is stored; a record the
// key cannot open reads as nothing (losing or rotating the key means entering the credentials again).
import type { KvStorage } from "../harness/store.ts";

const PREFIX = "t3flare/sealed/";
const SEAL_INFO = "t3flare/credentials/seal/v1";
const FINGERPRINT_INFO = "t3flare/credentials/fingerprint/v1";
/** The shortest credentials key taken: 128 bits as hex. The stage's is 256 (alchemy.run.ts). */
const MIN_KEY_LENGTH = 32;

export interface SealedMark {
  readonly set: boolean;
  readonly setAt: number | null;
  readonly fingerprint: string | null;
  /**
   * Only from `inspect`: whether this Environment's credentials key opens the value. False for a value set before the
   * key changed, or a damaged record: it must be entered again.
   */
  readonly readable?: boolean;
}

export class CredentialsKeyMissing extends Error {
  constructor() {
    super("this Environment has no credentials key (T3FLARE_CREDENTIALS_KEY), so it stores no credential");
    this.name = "CredentialsKeyMissing";
  }
}

export interface SealedStore {
  /** Whether a credentials key is bound: without one, `put` refuses. */
  readonly available: boolean;
  /** Seals `value` under `name`, replacing any value there. Rejects with `CredentialsKeyMissing` without a key. */
  put(name: string, value: string): Promise<SealedMark>;
  /** The value under `name`, or undefined (none, no key, or one this key does not open). */
  open(name: string): Promise<string | undefined>;
  mark(name: string): SealedMark;
  /** The mark, with whether the value opens (`readable`). */
  inspect(name: string): Promise<SealedMark>;
  remove(name: string): void;
}

interface SealedRecord {
  readonly v: 1;
  readonly iv: string;
  readonly data: string;
  readonly setAt: number;
  readonly fingerprint: string;
}

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unbase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const derive = async (secret: string, info: string, algorithm: AesKeyGenParams | HmacImportParams, usages: Array<KeyUsage>): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(info) }, material, algorithm, false, usages);
};

export const sealedStore = (kv: KvStorage & { delete(key: string): unknown }, credentialsKey: string | undefined, now: () => number = Date.now): SealedStore => {
  const available = credentialsKey !== undefined && credentialsKey.length >= MIN_KEY_LENGTH;
  let keys: Promise<{ readonly seal: CryptoKey; readonly fingerprint: CryptoKey }> | undefined;
  const keysOf = () => {
    if (!available) throw new CredentialsKeyMissing();
    keys ??= Promise.all([
      derive(credentialsKey, SEAL_INFO, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
      derive(credentialsKey, FINGERPRINT_INFO, { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
    ]).then(([seal, fingerprint]) => ({ seal, fingerprint }));
    return keys;
  };
  const mark = (name: string): SealedMark => {
    const record = kv.get<SealedRecord>(PREFIX + name);
    return record === undefined ? { set: false, setAt: null, fingerprint: null } : { set: true, setAt: record.setAt, fingerprint: record.fingerprint };
  };
  const open = async (name: string): Promise<string | undefined> => {
    const record = kv.get<SealedRecord>(PREFIX + name);
    if (record === undefined || !available) return undefined;
    try {
      const { seal } = await keysOf();
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(record.iv), additionalData: encoder.encode(PREFIX + name) }, seal, unbase64(record.data));
      return new TextDecoder().decode(plain);
    } catch {
      return undefined;
    }
  };
  return {
    available,
    mark,
    open,
    inspect: async (name) => {
      const marked = mark(name);
      return marked.set ? { ...marked, readable: (await open(name)) !== undefined } : marked;
    },
    put: async (name, value) => {
      const { seal, fingerprint } = await keysOf();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(PREFIX + name) }, seal, encoder.encode(value)));
      const print = hex(new Uint8Array(await crypto.subtle.sign("HMAC", fingerprint, encoder.encode(value)))).slice(0, 8);
      kv.put<SealedRecord>(PREFIX + name, { v: 1, iv: base64(iv), data: base64(data), setAt: now(), fingerprint: print });
      return mark(name);
    },
    remove: (name) => void kv.delete(PREFIX + name),
  };
};
