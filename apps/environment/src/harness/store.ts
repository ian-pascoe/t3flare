// @effect-diagnostics globalConsole:off
// The harness panel's two entities and its audit log in the Environment DO's storage: the Harness settings (ADR-0026) and
// the Environment settings (ADR-0032), each under its own key with its own revision, so a change to one never makes the
// other's readers take it again. Sessions take a new Harness revision at a turn's start; Workspace DOs take a new
// Environment revision before a Container start. One audit log for both, append-only, 1 000 entries kept, each with its
// `entity`; it holds no secret value (parts 2-4's secrets are masked before an entry is written).
import { EMPTY_ENVIRONMENT, EMPTY_HARNESS, type StoredEnvironment, type StoredHarness } from "@t3flare/harness-registry";

/** The Durable Object's synchronous key-value storage. */
export interface KvStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

export const SETTINGS_KEY = "t3flare:harness:settings";
export const ENVIRONMENT_KEY = "t3flare:environment:settings";
export const AUDIT_KEY = "t3flare:harness:audit";
const CSRF_KEY = "t3flare:harness:csrf-key";
const READ_KEY = "t3flare:harness:last-read";
const ENVIRONMENT_READ_KEY = "t3flare:environment:last-read";
export const AUDIT_KEPT = 1_000;

/**
 * Which entity on the panel's page a change was to; an entry written before SPI-1149 has none and was to the Harness
 * settings. An open set: a later entity adds its name here (the Model endpoints, SPI-1162).
 */
export type AuditEntity = "harness" | "environment";

export interface AuditEntry {
  readonly at: number;
  readonly entity: AuditEntity;
  /** `owner` (with the Access subject) or `service-token`. */
  readonly caller: string;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** A Session or a Workspace DO took the settings: when, and which revision. */
export interface LastRead {
  readonly revision: number;
  readonly at: number;
}

export interface HarnessStore {
  load(): StoredHarness;
  save(harness: StoredHarness): void;
  loadEnvironment(): StoredEnvironment;
  saveEnvironment(environment: StoredEnvironment): void;
  audit(entry: AuditEntry): void;
  auditLog(limit: number): ReadonlyArray<AuditEntry>;
  /** The CSRF HMAC key, made on first use. */
  csrfKey(): Uint8Array<ArrayBuffer>;
  /** A Session took the Harness settings (Status shows when, and which revision). */
  noteRead(revision: number, at: number): void;
  lastRead(): LastRead | undefined;
  /** A Workspace DO took the Environment settings. */
  noteEnvironmentRead(revision: number, at: number): void;
  lastEnvironmentRead(): LastRead | undefined;
}

export const harnessStore = (kv: KvStorage): HarnessStore => ({
  load: () => kv.get<StoredHarness>(SETTINGS_KEY) ?? EMPTY_HARNESS,
  save: (harness) => kv.put(SETTINGS_KEY, harness),
  loadEnvironment: () => kv.get<StoredEnvironment>(ENVIRONMENT_KEY) ?? EMPTY_ENVIRONMENT,
  saveEnvironment: (environment) => kv.put(ENVIRONMENT_KEY, environment),
  audit: (entry) => {
    const log = kv.get<AuditEntry[]>(AUDIT_KEY) ?? [];
    kv.put(AUDIT_KEY, [...log, entry].slice(-AUDIT_KEPT));
    // One line per change for Workers Logs, never a value.
    console.log(JSON.stringify({ t3flare: "harness-change", entity: entry.entity, caller: entry.caller.split(":")[0], action: entry.action, target: entry.target }));
  },
  auditLog: (limit) =>
    (kv.get<Array<Omit<AuditEntry, "entity"> & { readonly entity?: AuditEntity }>>(AUDIT_KEY) ?? [])
      .slice(-limit)
      .reverse()
      .map((entry) => ({ ...entry, entity: entry.entity ?? "harness" })),
  csrfKey: () => {
    const kept = kv.get<ArrayBuffer>(CSRF_KEY);
    if (kept !== undefined) return new Uint8Array(kept);
    const key = crypto.getRandomValues(new Uint8Array(32));
    kv.put(CSRF_KEY, key.buffer);
    return key;
  },
  noteRead: (revision, at) => kv.put(READ_KEY, { revision, at }),
  lastRead: () => kv.get<LastRead>(READ_KEY),
  noteEnvironmentRead: (revision, at) => kv.put(ENVIRONMENT_READ_KEY, { revision, at }),
  lastEnvironmentRead: () => kv.get<LastRead>(ENVIRONMENT_READ_KEY),
});
