// @effect-diagnostics globalDate:off
// Direct MCP servers' secrets (ADR-0012's refinement, decision (b): MCP servers only): a header value the owner typed in
// the harness panel, kept in the Environment DO's secret store namespace (`t3flare/secret/…`, apart from SQL, ADR-0010),
// write-only: no route, page, log, push, Session or Container gets it back. What is shown is that it is set, when, and a
// fingerprint: an HMAC under a key only this object holds (review LOW: owner-typed values may be low-entropy).
import type { KvStorage } from "./store.ts";

const keyOf = (server: string, field: string) => `t3flare/secret/harness/mcp/${server}/${field}`;
const FINGERPRINT_KEY = "t3flare:harness:fingerprint-key";

export interface SecretMark {
  readonly set: boolean;
  readonly setAt: number | null;
  readonly fingerprint: string | null;
}

export interface HarnessSecrets {
  put(server: string, field: string, value: string): Promise<SecretMark>;
  read(server: string, field: string): string | undefined;
  mark(server: string, field: string): SecretMark;
  remove(server: string, fields: ReadonlyArray<string>): void;
  /** The HMAC of `value` under the fingerprint key (the leak scans' hash of a secret, never the value). */
  hmac(value: string): Promise<string>;
}

export const harnessSecrets = (kv: KvStorage & { delete(key: string): unknown }, now: () => number = Date.now): HarnessSecrets => {
  const fingerprintKey = () => {
    const kept = kv.get<ArrayBuffer>(FINGERPRINT_KEY);
    if (kept !== undefined) return new Uint8Array(kept);
    const key = crypto.getRandomValues(new Uint8Array(32));
    kv.put(FINGERPRINT_KEY, key.buffer);
    return key;
  };
  const hmac = async (value: string) => {
    const key = await crypto.subtle.importKey("raw", fingerprintKey(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const mark = (server: string, field: string): SecretMark => {
    const stored = kv.get<{ value: string; setAt: number; fingerprint: string }>(keyOf(server, field));
    return stored === undefined ? { set: false, setAt: null, fingerprint: null } : { set: true, setAt: stored.setAt, fingerprint: stored.fingerprint };
  };
  return {
    hmac,
    mark,
    read: (server, field) => kv.get<{ value: string }>(keyOf(server, field))?.value,
    put: async (server, field, value) => {
      const fingerprint = (await hmac(value)).slice(0, 4);
      kv.put(keyOf(server, field), { value, setAt: now(), fingerprint });
      return mark(server, field);
    },
    remove: (server, fields) => {
      for (const field of fields) kv.delete(keyOf(server, field));
    },
  };
};
