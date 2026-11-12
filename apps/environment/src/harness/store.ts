// @effect-diagnostics globalConsole:off
// The harness settings and the panel's audit log in the Environment DO's storage (ADR-0026). Settings carry a revision
// that every change bumps; Sessions take a new one at a turn's start. The audit log is append-only, 1 000 entries kept,
// and holds no secret value (parts 2-4's secrets are masked before an entry is written).
import { EMPTY_HARNESS, type StoredHarness } from "@t3flare/harness-registry";

/** The Durable Object's synchronous key-value storage. */
export interface KvStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

export const SETTINGS_KEY = "t3flare:harness:settings";
export const AUDIT_KEY = "t3flare:harness:audit";
const CSRF_KEY = "t3flare:harness:csrf-key";
const READ_KEY = "t3flare:harness:last-read";
export const AUDIT_KEPT = 1_000;

export interface AuditEntry {
  readonly at: number;
  /** `owner` (with the Access subject) or `service-token`. */
  readonly caller: string;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface HarnessStore {
  load(): StoredHarness;
  save(harness: StoredHarness): void;
  audit(entry: AuditEntry): void;
  auditLog(limit: number): ReadonlyArray<AuditEntry>;
  /** The CSRF HMAC key, made on first use. */
  csrfKey(): Uint8Array<ArrayBuffer>;
  /** A Session took the settings (Status shows when, and which revision). */
  noteRead(revision: number, at: number): void;
  lastRead(): { readonly revision: number; readonly at: number } | undefined;
}

export const harnessStore = (kv: KvStorage): HarnessStore => ({
  load: () => kv.get<StoredHarness>(SETTINGS_KEY) ?? EMPTY_HARNESS,
  save: (harness) => kv.put(SETTINGS_KEY, harness),
  audit: (entry) => {
    const log = kv.get<AuditEntry[]>(AUDIT_KEY) ?? [];
    kv.put(AUDIT_KEY, [...log, entry].slice(-AUDIT_KEPT));
    // One line per change for Workers Logs, never a value.
    console.log(JSON.stringify({ t3flare: "harness-change", caller: entry.caller.split(":")[0], action: entry.action, target: entry.target }));
  },
  auditLog: (limit) => (kv.get<AuditEntry[]>(AUDIT_KEY) ?? []).slice(-limit).reverse(),
  csrfKey: () => {
    const kept = kv.get<ArrayBuffer>(CSRF_KEY);
    if (kept !== undefined) return new Uint8Array(kept);
    const key = crypto.getRandomValues(new Uint8Array(32));
    kv.put(CSRF_KEY, key.buffer);
    return key;
  },
  noteRead: (revision, at) => kv.put(READ_KEY, { revision, at }),
  lastRead: () => kv.get<{ revision: number; at: number }>(READ_KEY),
});
