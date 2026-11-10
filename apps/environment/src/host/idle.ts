// @effect-diagnostics globalDate:off
// Idle reset (ADR-0003). t3 keeps timers running, so left alone the Environment DO would never be evicted.
// When there is no client socket, no request in flight, no open run or provider session and no claimable
// outbox effect for IDLE_AFTER_MS, the host reads the next due time from t3's tables, sets one alarm for
// it and calls `ctx.abort()`. The alarm (or the next request) boots t3 again.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export const IDLE_AFTER_MS = 60_000;
/** How often the host checks whether it has gone idle. */
export const IDLE_CHECK_EVERY_MS = 10_000;

/** What keeps the Environment awake, counted by the host. Module state: the DO is the only one in its isolate. */
export const activity = {
  sockets: 0,
  inFlight: 0,
  /** When the last socket closed or the last request ended (ms since epoch). */
  idleSince: Date.now(),
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

/** The run and provider-session statuses that mean a turn is live (t3's OrchestrationV2RunStatus). */
const OPEN_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];
const OPEN_SESSION_STATUSES = ["starting", "running", "waiting"];

const list = (values: ReadonlyArray<string>) => values.map((v) => `'${v}'`).join(", ");

/** Runs a query over t3's tables; a table t3 has not created (or renamed on a bump) counts as empty. */
const tryRows = <T extends Record<string, string | number | ArrayBuffer | null>>(sql: SqlStorage, query: string, ...params: Array<unknown>): Array<T> => {
  try {
    return sql.exec<T>(query, ...params).toArray();
  } catch {
    return [];
  }
};

export interface OpenWork {
  readonly openRuns: number;
  readonly openProviderSessions: number;
  readonly claimableEffects: number;
}

/** The work that keeps t3 resident, read from its projection and outbox tables. */
export const openWork = (sql: SqlStorage, now: Date): OpenWork => {
  const count = (query: string, ...params: Array<unknown>) => tryRows<{ n: number }>(sql, query, ...params)[0]?.n ?? 0;
  return {
    openRuns: count(`SELECT COUNT(*) AS n FROM orchestration_v2_projection_runs WHERE status IN (${list(OPEN_RUN_STATUSES)})`),
    openProviderSessions: count(
      `SELECT COUNT(*) AS n FROM orchestration_v2_projection_provider_sessions WHERE status IN (${list(OPEN_SESSION_STATUSES)})`,
    ),
    claimableEffects: count(
      `SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox WHERE status IN ('pending', 'running') AND available_at <= ?`,
      now.toISOString(),
    ),
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
 * when its snooze ends).
 */
export const nextDue = (sql: SqlStorage, now: Date = new Date()): NextDue => {
  const outbox = tryRows<{ at: string | null }>(
    sql,
    `SELECT MIN(available_at) AS at FROM orchestration_v2_effect_outbox WHERE status = 'pending'`,
  )[0]?.at;
  const scheduled = tryRows<{ at: string | null }>(
    sql,
    `SELECT MIN(next_run_at) AS at FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL`,
  )[0]?.at;
  const nowIso = now.toISOString();
  const limits = tryRows<{ reset_ms: number | null; snooze_ms: number | null }>(
    sql,
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
  | { readonly reset: false; readonly why: string }
  | { readonly reset: true; readonly work: OpenWork; readonly due: NextDue };

/** Whether the Environment should reset now. */
export const idleVerdict = (sql: SqlStorage, now: Date, idleAfterMs = IDLE_AFTER_MS): IdleVerdict => {
  if (activity.sockets > 0) return { reset: false, why: `${activity.sockets} client sockets` };
  if (activity.inFlight > 0) return { reset: false, why: `${activity.inFlight} requests in flight` };
  if (now.getTime() - activity.idleSince < idleAfterMs) return { reset: false, why: "not idle long enough" };
  const work = openWork(sql, now);
  if (hasOpenWork(work)) return { reset: false, why: `open work ${JSON.stringify(work)}` };
  return { reset: true, work, due: nextDue(sql, now) };
};
