// @effect-diagnostics globalDate:off extendsNativeError:off
// Idle reset (ADR-0003). t3 keeps timers running, so left alone the Environment DO would never be evicted.
// When there is no client socket, no request in flight, no open run or provider session and no claimable
// outbox effect for IDLE_AFTER_MS, the host reads the next due time from t3's tables, sets one alarm for
// it and calls `ctx.abort()`. The alarm (or the next request) boots t3 again.
// The reads of t3's private tables fail safe (fragility U2): a read that fails means "don't know", never
// "no work", so the Environment stays up rather than reset under a turn or skip a wake.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export const IDLE_AFTER_MS = 60_000;
/** How often the host checks whether it has gone idle. */
export const IDLE_CHECK_EVERY_MS = 10_000;
/** After a failed read of t3's tables, how long the idle check waits before reading them again. */
export const UNREADABLE_BACKOFF_MS = 10 * 60_000;

/** What keeps the Environment awake, counted by the host. Module state: the DO is the only one in its isolate. */
export const activity = {
  sockets: 0,
  inFlight: 0,
  /** When the last socket closed or the last request ended (ms since epoch). */
  idleSince: Date.now(),
  /** Until when the idle check backs off after t3's tables could not be read (ms since epoch; 0 for none). */
  unreadableUntil: 0,
};

/**
 * How long a capped hold (a publish to T3 Connect still pending, step 3+) keeps the Environment up after its last
 * request or socket: t3's worst case is five retries with 10 s timeouts (about 91 s), past the 60 s idle delay.
 */
export const PUBLISH_HOLD_CAP_MS = 120_000;

/**
 * Holds on the idle reset, by name, each until a time (ms since epoch): the T3 Connect sign-in's poll while its code
 * is valid, and each publish still pending (capped). Module state, cleared when the object is constructed.
 */
export const holds = new Map<string, { readonly until: number; readonly capped: boolean }>();

/** The T3 Connect sign-in's hold (connect/service.ts): while it lasts, t3 must not restart in place. */
export const CONNECT_SIGN_IN_HOLD = "connect-sign-in";

export const hold = (name: string, until: number, options: { readonly capped?: boolean } = {}) => {
  holds.set(name, { until, capped: options.capped === true });
};

export const release = (name: string) => {
  holds.delete(name);
};

/** The holds that keep the Environment up now; expired ones are dropped. */
export const activeHolds = (now: number): Array<string> => {
  const active: Array<string> = [];
  for (const [name, { until, capped }] of holds) {
    if (until <= now) holds.delete(name);
    else if (!capped || now - activity.idleSince < PUBLISH_HOLD_CAP_MS) active.push(name);
  }
  return active;
};

export const socketOpened = () => {
  activity.sockets++;
};

export const socketClosed = () => {
  activity.sockets = Math.max(0, activity.sockets - 1);
  if (activity.sockets === 0 && activity.inFlight === 0) activity.idleSince = Date.now();
};

export const requestStarted = () => {
  activity.inFlight++;
};

export const requestEnded = () => {
  activity.inFlight = Math.max(0, activity.inFlight - 1);
  if (activity.sockets === 0 && activity.inFlight === 0) activity.idleSince = Date.now();
};

/**
 * The run and provider-session statuses that mean nothing is live (t3's `OrchestrationV2RunStatus` and
 * `OrchestrationV2ProviderSession.status`). Every other status counts as open, so a status a nightly adds keeps
 * the Environment up rather than read as idle.
 */
const SETTLED_RUN_STATUSES = ["completed", "interrupted", "failed", "cancelled", "rolled_back"];
const SETTLED_SESSION_STATUSES = ["ready", "stopped", "error"];

const list = (values: ReadonlyArray<string>) => values.map((v) => `'${v}'`).join(", ");

/** A read of t3's tables failed (a table or column renamed or gone on a bump): whether work is open is unknown. */
export class UnreadableTables extends Error {
  constructor(table: string, cause: unknown) {
    super(`${table}: ${String(cause).slice(0, 300)}`, { cause });
    this.name = "UnreadableTables";
  }
}

/** Runs a query over one of t3's tables; any error is `UnreadableTables`, never "no rows". */
const rows = <T extends Record<string, string | number | ArrayBuffer | null>>(
  sql: SqlStorage,
  table: string,
  query: string,
  ...params: Array<unknown>
): Array<T> => {
  try {
    return sql.exec<T>(query, ...params).toArray();
  } catch (cause) {
    throw new UnreadableTables(table, cause);
  }
};

export interface OpenWork {
  readonly openRuns: number;
  readonly openProviderSessions: number;
  readonly claimableEffects: number;
}

/** The work that keeps t3 resident, read from its projection and outbox tables. Throws `UnreadableTables`. */
export const openWork = (sql: SqlStorage, now: Date): OpenWork => {
  const count = (table: string, where: string, ...params: Array<unknown>) =>
    rows<{ n: number }>(sql, table, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)[0]?.n ?? 0;
  return {
    openRuns: count("orchestration_v2_projection_runs", `status NOT IN (${list(SETTLED_RUN_STATUSES)})`),
    openProviderSessions: count("orchestration_v2_projection_provider_sessions", `status NOT IN (${list(SETTLED_SESSION_STATUSES)})`),
    claimableEffects: count("orchestration_v2_effect_outbox", `status IN ('pending', 'running') AND available_at <= ?`, now.toISOString()),
  };
};

export const hasOpenWork = (work: OpenWork) => work.openRuns + work.openProviderSessions + work.claimableEffects > 0;

export interface NextDue {
  readonly at: Date | null;
  readonly sources: Record<string, string | null>;
}

const parseTime = (value: string | number | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The next time t3 has work due: the earliest pending outbox effect (`nextClaimableAt`), the earliest enabled
 * scheduled task, and the earliest usage-limit recovery (the query of t3's
 * `ProjectionStoreV2.getLimitRecoveryWakeAt`: a usage-limited thread set to resume when its limit resets, or
 * when its snooze ends). Throws `UnreadableTables`.
 */
export const nextDue = (sql: SqlStorage, now: Date = new Date()): NextDue => {
  const outbox = rows<{ at: string | null }>(
    sql,
    "orchestration_v2_effect_outbox",
    `SELECT MIN(available_at) AS at FROM orchestration_v2_effect_outbox WHERE status = 'pending'`,
  )[0]?.at;
  const scheduled = rows<{ at: string | null }>(
    sql,
    "scheduled_tasks",
    `SELECT MIN(next_run_at) AS at FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL`,
  )[0]?.at;
  const nowIso = now.toISOString();
  const limits = rows<{ reset_ms: number | null; snooze_ms: number | null }>(
    sql,
    "orchestration_v2_projection_threads",
    `SELECT
       MIN(CASE WHEN julianday(reset_at) > julianday(?) THEN (julianday(reset_at) - 2440587.5) * 86400000 END) AS reset_ms,
       MIN(CASE WHEN julianday(snoozed_until) > julianday(?) THEN (julianday(snoozed_until) - 2440587.5) * 86400000 END) AS snooze_ms
     FROM (
       SELECT json_extract(payload_json, '$.limitRecovery.resetAt') AS reset_at,
         json_extract(payload_json, '$.snoozedUntil') AS snoozed_until
       FROM orchestration_v2_projection_threads
       WHERE deleted_at IS NULL AND json_extract(payload_json, '$.limitRecovery.autoResume') = 1
     )`,
    nowIso,
    nowIso,
  )[0];
  const limitWakes = [limits?.reset_ms, limits?.snooze_ms].filter((v): v is number => v !== null && v !== undefined);
  const usageLimit = limitWakes.length === 0 ? null : new Date(Math.round(Math.min(...limitWakes)));
  const candidates = [parseTime(outbox), parseTime(scheduled), usageLimit].filter((d): d is Date => d !== null);
  const at = candidates.length === 0 ? null : new Date(Math.min(...candidates.map((d) => d.getTime())));
  return {
    at,
    sources: { outbox: outbox ?? null, scheduledTasks: scheduled ?? null, usageLimitResets: usageLimit?.toISOString() ?? null },
  };
};

export type IdleVerdict =
  | { readonly reset: false; readonly why: string; readonly unreadable?: string }
  | { readonly reset: true; readonly work: OpenWork; readonly due: NextDue };

/**
 * Whether the Environment should reset now. When t3's tables cannot be read it does not reset, and reads them
 * again only after `UNREADABLE_BACKOFF_MS` (the verdict's `unreadable` says what failed; the caller logs it).
 */
export const idleVerdict = (sql: SqlStorage, now: Date, idleAfterMs = IDLE_AFTER_MS): IdleVerdict => {
  if (activity.sockets > 0) return { reset: false, why: `${activity.sockets} client sockets` };
  if (activity.inFlight > 0) return { reset: false, why: `${activity.inFlight} requests in flight` };
  if (now.getTime() - activity.idleSince < idleAfterMs) return { reset: false, why: "not idle long enough" };
  const held = activeHolds(now.getTime());
  if (held.length > 0) return { reset: false, why: `held: ${held.join(", ")}` };
  if (now.getTime() < activity.unreadableUntil) {
    return { reset: false, why: `t3's tables were unreadable; next read after ${new Date(activity.unreadableUntil).toISOString()}` };
  }
  try {
    const work = openWork(sql, now);
    if (hasOpenWork(work)) return { reset: false, why: `open work ${JSON.stringify(work)}` };
    return { reset: true, work, due: nextDue(sql, now) };
  } catch (error) {
    if (!(error instanceof UnreadableTables)) throw error;
    activity.unreadableUntil = now.getTime() + UNREADABLE_BACKOFF_MS;
    return { reset: false, why: "t3's tables are unreadable", unreadable: error.message };
  }
};
