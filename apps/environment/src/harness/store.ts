// @effect-diagnostics globalConsole:off
// The Settings page's two entities and its audit log in the Environment DO's storage: the Harness settings (ADR-0026) and
// the Environment settings (ADR-0032), each under its own key with its own revision, so a change to one never makes the
// other's readers take it again. Sessions take a new Harness revision at a turn's start; Workspace DOs take a new
// Environment revision before a Container start. One audit log for both, append-only, 1 000 entries kept, each with its
// `entity`; it holds no secret value (parts 2-4's secrets are masked before an entry is written).
import { EMPTY_ENVIRONMENT, EMPTY_HARNESS, type GlobalMiseReport, globalMiseReport, type StoredEnvironment, type StoredHarness, type T3ToolListing, t3ToolListing } from "@t3flare/harness-registry";

import { keptKey, type KvStorage } from "./keys.ts";

export const SETTINGS_KEY = "t3flare:harness:settings";
export const ENVIRONMENT_KEY = "t3flare:environment:settings";
export const AUDIT_KEY = "t3flare:harness:audit";
const CSRF_KEY = "t3flare:harness:csrf-key";
const READ_KEY = "t3flare:harness:last-read";
const ENVIRONMENT_READ_KEY = "t3flare:environment:last-read";
const GLOBAL_MISE_KEY = "t3flare:environment:global-mise";
const T3_TOOLS_KEY = "t3flare:harness:t3-tools";
export const AUDIT_KEPT = 1_000;

/**
 * Which entity on the panel's page a change was to: an open set, `"harness"` and `"environment"` today (the Model
 * endpoints, SPI-1162, add theirs). An entry written before SPI-1149 has none and was to the Harness settings.
 */
export type AuditEntity = "harness" | "environment" | (string & {});

/**
 * Who made a change and through which door (plan D15). Every field but `caller` is optional; an entry without `via` was
 * made on the panel.
 */
export interface AuditActor {
  /** `owner:<sub>`, `service-token`, `agent:<thread>` or `oauth`. */
  readonly caller: string;
  readonly via?: "panel" | "mcp";
  /** The calling thread and its agent kind (t3flare's own agents). */
  readonly thread?: string;
  readonly agent?: string;
  /** An Owner client's own label, unverified. */
  readonly client?: { readonly name: string; readonly source: string };
  readonly tier?: "free" | "asked";
  /** The Open change's Elicitation mode, for an asked change. */
  readonly mode?: "card" | "browser" | "native" | "model";
  /** What answered an asked change. */
  readonly answeredBy?: "card" | "page" | "client" | "agent";
  /** The Open change's id. */
  readonly change?: string;
}

export interface AuditEntry extends AuditActor {
  readonly at: number;
  readonly entity: AuditEntity;
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
  /**
   * A Workspace DO's Global mise lay-down (SPI-1150): kept when it is a well-formed report, the last one only, across
   * all Workspaces. Answers whether it was kept.
   */
  noteGlobalMise(report: unknown): boolean;
  lastGlobalMise(): GlobalMiseReport | undefined;
  /** t3's tools as a Session last listed them (the t3-code card's list): kept when well-formed. Answers whether it was kept. */
  noteT3Tools(listing: unknown): boolean;
  lastT3Tools(): T3ToolListing | undefined;
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
    console.log(
      JSON.stringify({
        t3flare: "harness-change",
        entity: entry.entity,
        caller: entry.caller.split(":")[0],
        action: entry.action,
        target: entry.target,
        via: entry.via,
        tier: entry.tier,
        mode: entry.mode,
        answeredBy: entry.answeredBy,
      }),
    );
  },
  auditLog: (limit) =>
    (kv.get<Array<Omit<AuditEntry, "entity"> & { readonly entity?: AuditEntity }>>(AUDIT_KEY) ?? [])
      .slice(-limit)
      .reverse()
      .map((entry) => ({ ...entry, entity: entry.entity ?? "harness" })),
  csrfKey: () => keptKey(kv, CSRF_KEY),
  noteRead: (revision, at) => kv.put(READ_KEY, { revision, at }),
  lastRead: () => kv.get<LastRead>(READ_KEY),
  noteEnvironmentRead: (revision, at) => kv.put(ENVIRONMENT_READ_KEY, { revision, at }),
  noteGlobalMise: (report) => {
    const valid = globalMiseReport(report);
    if (valid === undefined) return false;
    kv.put(GLOBAL_MISE_KEY, valid);
    return true;
  },
  lastGlobalMise: () => globalMiseReport(kv.get<unknown>(GLOBAL_MISE_KEY)),
  noteT3Tools: (listing) => {
    const valid = t3ToolListing(listing);
    if (valid === undefined) return false;
    // The latest listing wins: a Session waking on an older catalog does not replace a newer thread's.
    const kept = t3ToolListing(kv.get<unknown>(T3_TOOLS_KEY));
    if (kept !== undefined && kept.listedAt >= valid.listedAt) return false;
    kv.put(T3_TOOLS_KEY, valid);
    return true;
  },
  lastT3Tools: () => t3ToolListing(kv.get<unknown>(T3_TOOLS_KEY)),
  lastEnvironmentRead: () => kv.get<LastRead>(ENVIRONMENT_READ_KEY),
});
