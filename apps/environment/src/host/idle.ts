// @effect-diagnostics globalDate:off extendsNativeError:off
// Idle reset (ADR-0003). t3 keeps timers running, so left alone the Environment DO would never be evicted.
// When there is no client socket, no request in flight, no open run or provider session and no claimable
// outbox effect for IDLE_AFTER_MS, the host reads the next due time from t3's tables, sets one alarm for
// it and calls `ctx.abort()`. The alarm (or the next request) boots t3 again.
// An open Remote task (SPI-1061 D7) is work while its machine answers; while it does not, the Environment may reset,
// and the one alarm also carries the task's retry (5, 15, then every 30 minutes; its state in DO storage).
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
  /** Open Remote tasks whose machine answered t3's last call (SPI-1061 D7): work, as an open run is. */
  readonly remoteTasksAnswering: number;
  /** Open Remote tasks whose machine did not answer (asleep, its Route gone) or is no longer linked: not work. */
  readonly remoteTasksUnanswered: number;
}

/**
 * t3's open Remote tasks (`ProjectionStoreV2.getOpenRemoteDelegatedTasks`, which `RemoteDelegation.start` follows), each
 * with whether its machine answered t3's last call: `PeerMcpClient` records every call's outcome in
 * `peer_environment_links.last_error`, NULL after an answer (U48). Throws `UnreadableTables`.
 */
const openRemoteTasks = (sql: SqlStorage): { readonly answering: number; readonly unanswered: number } => {
  // Both tables must be readable: an unreadable link table would read every task as unanswered and reset under it.
  rows(sql, "peer_environment_links", "SELECT environment_id, last_error FROM peer_environment_links LIMIT 0");
  const counted = rows<{ answering: number | null; unanswered: number | null }>(
    sql,
    "orchestration_v2_projection_subagents",
    `SELECT
       SUM(CASE WHEN l.environment_id IS NOT NULL AND l.last_error IS NULL THEN 1 ELSE 0 END) AS answering,
       SUM(CASE WHEN l.environment_id IS NULL OR l.last_error IS NOT NULL THEN 1 ELSE 0 END) AS unanswered
     FROM orchestration_v2_projection_subagents s
     LEFT JOIN peer_environment_links l ON l.environment_id = json_extract(s.payload_json, '$.remoteChild.environmentId')
     WHERE s.origin = 'app_owned'
       AND s.child_thread_id IS NULL
       AND json_type(s.payload_json, '$.remoteChild') = 'object'
       AND (
         json_type(s.payload_json, '$.result') = 'null'
         OR (
           json_extract(s.payload_json, '$.status') IN ('cancelled', 'interrupted')
           AND json_type(s.payload_json, '$.remoteChild.stoppedThere') IS NOT 'true'
         )
         OR json_type(s.payload_json, '$.remoteChild.stoppedThere') = 'false'
       )`,
  )[0];
  return { answering: counted?.answering ?? 0, unanswered: counted?.unanswered ?? 0 };
};

/** The work that keeps t3 resident, read from its projection, outbox and link tables. Throws `UnreadableTables`. */
export const openWork = (sql: SqlStorage, now: Date): OpenWork => {
  const count = (table: string, where: string, ...params: Array<unknown>) =>
    rows<{ n: number }>(sql, table, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)[0]?.n ?? 0;
  const openRuns = count("orchestration_v2_projection_runs", `status NOT IN (${list(SETTLED_RUN_STATUSES)})`);
  const openProviderSessions = count("orchestration_v2_projection_provider_sessions", `status NOT IN (${list(SETTLED_SESSION_STATUSES)})`);
  const claimableEffects = count("orchestration_v2_effect_outbox", `status IN ('pending', 'running') AND available_at <= ?`, now.toISOString());
  const remote = openRemoteTasks(sql);
  return {
    openRuns,
    openProviderSessions,
    claimableEffects,
    remoteTasksAnswering: remote.answering,
    remoteTasksUnanswered: remote.unanswered,
  };
};

export const hasOpenWork = (work: OpenWork) =>
  work.openRuns + work.openProviderSessions + work.claimableEffects + work.remoteTasksAnswering > 0;

/** The open Remote tasks, answering or not. */
export const openRemoteTaskCount = (sql: SqlStorage): number => {
  const remote = openRemoteTasks(sql);
  return remote.answering + remote.unanswered;
};

/**
 * The retry of open Remote tasks whose machine does not answer (SPI-1061 D7), in DO storage, since a reset clears
 * memory: which retry this is, and when it is due (ms since epoch).
 */
export interface RemoteRetry {
  readonly attempt: number;
  readonly at: number;
}

export const REMOTE_RETRY_KEY = "t3flare:remote-task-retry";
/** The retry's back-off: 5, 15, then every 30 minutes. No give-up: the task ends as t3 ends it. */
export const REMOTE_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
/** While a Remote task is open and the Environment is up, an alarm stands at most this far ahead (a deploy, an eviction). */
export const REMOTE_STANDING_ALARM_MS = 5 * 60_000;

/** The retry after `previous` (none: the first), from `now`. */
export const nextRemoteRetry = (previous: RemoteRetry | undefined, now: number): RemoteRetry => {
  const attempt = previous === undefined ? 0 : previous.attempt + 1;
  return { attempt, at: now + REMOTE_RETRY_DELAYS_MS[Math.min(attempt, REMOTE_RETRY_DELAYS_MS.length - 1)]! };
};

/**
 * What a reset leaves behind: the retry state (none unless a Remote task waits on a machine that does not answer), and
 * the one alarm, the earliest of t3's own due time, the sweep and the retry, never sooner than a second from now.
 */
export const planReset = (
  work: OpenWork,
  due: { readonly t3Due: number | null; readonly sweep: number; readonly retry: RemoteRetry | undefined },
  now: number,
): { readonly retry: RemoteRetry | undefined; readonly alarm: number } => {
  const retry = work.remoteTasksUnanswered > 0 ? nextRemoteRetry(due.retry, now) : undefined;
  const at = Math.min(due.t3Due ?? Number.POSITIVE_INFINITY, due.sweep, retry?.at ?? Number.POSITIVE_INFINITY);
  return { retry, alarm: Math.max(at, now + 1000) };
};

/**
 * When an alarm with t3 down should boot it for Remote tasks: at the retry; at once when a task is open with no retry
 * pending (the Environment was held up for it, then a deploy or an eviction reset it); never with none open.
 */
export const remoteWakeAt = (retry: RemoteRetry | undefined, openRemote: number): number | null =>
  openRemote === 0 ? null : (retry?.at ?? 0);

/** The alarm to set while t3 is up with a Remote task open, if the one standing (`current`) is later or none. */
export const standingAlarm = (current: number | null, openRemote: number, now: number): number | undefined => {
  if (openRemote === 0) return undefined;
  const at = now + REMOTE_STANDING_ALARM_MS;
  return current === null || current > at ? at : undefined;
};

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
  | { readonly reset: false; readonly why: string; readonly unreadable?: string; readonly work?: OpenWork }
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
    if (hasOpenWork(work)) return { reset: false, why: `open work ${JSON.stringify(work)}`, work };
    return { reset: true, work, due: nextDue(sql, now) };
  } catch (error) {
    if (!(error instanceof UnreadableTables)) throw error;
    activity.unreadableUntil = now.getTime() + UNREADABLE_BACKOFF_MS;
    return { reset: false, why: "t3's tables are unreadable", unreadable: error.message };
  }
};
