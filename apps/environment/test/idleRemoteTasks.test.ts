// SPI-1061 M2 (plan §5.3, D7): an open Remote task is work. While the machine it runs on answers, the Environment stays up
// to follow it; while it does not, the Environment may reset, and one alarm brings it back after 5, 15, then every 30
// minutes, with the retry state in DO storage. The reads of t3's tables fail safe (U2, U48).
import { describe, expect, it } from "vitest";

import * as Idle from "../src/host/idle.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const now = new Date("2026-11-13T12:00:00.000Z");
const minutes = (n: number) => n * 60_000;

/** t3's tables the idle check reads, in the columns it reads. */
const t3Tables = () => {
  const sql = nodeSqlStorage();
  sql.exec("CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_provider_sessions (session_id TEXT, status TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_effect_outbox (effect_id TEXT, status TEXT, available_at TEXT)");
  sql.exec("CREATE TABLE scheduled_tasks (task_id TEXT, enabled INTEGER, next_run_at TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_subagents (thread_id TEXT, subagent_id TEXT, origin TEXT, child_thread_id TEXT, payload_json TEXT)");
  sql.exec("CREATE TABLE peer_environment_links (environment_id TEXT PRIMARY KEY, last_reached_at TEXT, last_error TEXT)");
  return sql;
};

type Sql = ReturnType<typeof t3Tables>;

/** A delegated task as t3 records one: app-owned, no child thread here, a `remoteChild` naming the other machine. */
const task = (sql: Sql, id: string, payload: Record<string, unknown>, extra: { origin?: string; child?: string | null } = {}) =>
  sql.exec(
    "INSERT INTO orchestration_v2_projection_subagents VALUES ('parent', ?, ?, ?, ?)",
    id,
    extra.origin ?? "app_owned",
    extra.child ?? null,
    JSON.stringify(payload),
  );
const remote = (environmentId: string, more: Record<string, unknown> = {}) => ({ environmentId, threadId: "there", ...more });
const link = (sql: Sql, environmentId: string, lastError: string | null) =>
  sql.exec("INSERT INTO peer_environment_links VALUES (?, '2026-11-13T11:00:00.000Z', ?)", environmentId, lastError);
const idle = () => Object.assign(Idle.activity, { sockets: 0, inFlight: 0, idleSince: now.getTime() - 120_000, unreadableUntil: 0 });

describe("open Remote tasks", () => {
  it("counts open tasks as t3's getOpenRemoteDelegatedTasks reads them, split by whether their machine answers", () => {
    const sql = t3Tables();
    link(sql, "laptop", null);
    link(sql, "asleep", "The linked environment stopped answering.");
    task(sql, "open-answering", { result: null, status: "running", remoteChild: remote("laptop") });
    task(sql, "open-asleep", { result: null, status: "running", remoteChild: remote("asleep") });
    // Ended here but still owes a stop there: open, as t3 follows it.
    task(sql, "owes-stop", { result: "x", status: "cancelled", remoteChild: remote("laptop", { stoppedThere: false }) });
    // A link this Environment no longer has: nothing answers for it.
    task(sql, "forgotten", { result: null, status: "running", remoteChild: remote("gone") });
    // Not open: finished and stopped there, a local task, an agent-owned one, one with a child thread here.
    task(sql, "done", { result: "ok", status: "completed", remoteChild: remote("laptop", { stoppedThere: true }) });
    task(sql, "local", { result: null, status: "running" });
    task(sql, "agent-owned", { result: null, status: "running", remoteChild: remote("laptop") }, { origin: "provider" });
    task(sql, "child-here", { result: null, status: "running", remoteChild: remote("laptop") }, { child: "c1" });
    expect(Idle.openWork(sql, now)).toEqual({
      openRuns: 0,
      openProviderSessions: 0,
      claimableEffects: 0,
      remoteTasksAnswering: 2,
      remoteTasksUnanswered: 2,
    });
  });

  it("holds the Environment up while a Remote task's machine answers", () => {
    const sql = t3Tables();
    link(sql, "laptop", null);
    task(sql, "t1", { result: null, status: "running", remoteChild: remote("laptop") });
    idle();
    const verdict = Idle.idleVerdict(sql, now);
    expect(verdict.reset).toBe(false);
    expect(verdict).toMatchObject({ why: expect.stringContaining("remoteTasksAnswering"), work: { remoteTasksAnswering: 1 } });
  });

  it("lets the Environment reset while no Remote task's machine answers, saying so", () => {
    const sql = t3Tables();
    link(sql, "laptop", "The linked environment stopped answering.");
    task(sql, "t1", { result: null, status: "running", remoteChild: remote("laptop") });
    idle();
    const verdict = Idle.idleVerdict(sql, now);
    expect(verdict).toMatchObject({ reset: true, work: { remoteTasksAnswering: 0, remoteTasksUnanswered: 1 } });
  });

  it("does not reset when the subagent or link table cannot be read (U2, U48)", () => {
    for (const table of ["orchestration_v2_projection_subagents", "peer_environment_links"]) {
      const sql = t3Tables();
      sql.exec(`DROP TABLE ${table}`);
      idle();
      expect(Idle.idleVerdict(sql, now)).toMatchObject({ reset: false, unreadable: expect.stringContaining(table) });
    }
  });
});

describe("the retry alarm", () => {
  it("backs off 5, 15, then 30 minutes, staying at 30", () => {
    const at = now.getTime();
    const first = Idle.nextRemoteRetry(undefined, at);
    expect(first).toEqual({ attempt: 0, at: at + minutes(5) });
    const second = Idle.nextRemoteRetry(first, at);
    expect(second).toEqual({ attempt: 1, at: at + minutes(15) });
    const third = Idle.nextRemoteRetry(second, at);
    expect(third).toEqual({ attempt: 2, at: at + minutes(30) });
    expect(Idle.nextRemoteRetry(third, at)).toEqual({ attempt: 3, at: at + minutes(30) });
    expect(Idle.nextRemoteRetry({ attempt: 40, at: 0 }, at)).toEqual({ attempt: 41, at: at + minutes(30) });
  });

  it("plans the reset: a retry only while a task waits on a machine that does not answer, merged into one alarm", () => {
    const at = now.getTime();
    const work = (unanswered: number): Idle.OpenWork => ({ openRuns: 0, openProviderSessions: 0, claimableEffects: 0, remoteTasksAnswering: 0, remoteTasksUnanswered: unanswered });
    // Nothing remote: no retry state, the alarm is t3's or the sweep's.
    expect(Idle.planReset(work(0), { t3Due: at + minutes(60), sweep: at + minutes(90), retry: { attempt: 2, at: 0 } }, at)).toEqual({ retry: undefined, alarm: at + minutes(60) });
    // Unanswered: the next retry, the earlier of it and t3's own due time.
    expect(Idle.planReset(work(1), { t3Due: at + minutes(60), sweep: at + minutes(90), retry: undefined }, at)).toEqual({ retry: { attempt: 0, at: at + minutes(5) }, alarm: at + minutes(5) });
    expect(Idle.planReset(work(1), { t3Due: at + minutes(2), sweep: at + minutes(90), retry: { attempt: 0, at: 0 } }, at)).toEqual({ retry: { attempt: 1, at: at + minutes(15) }, alarm: at + minutes(2) });
    // Never sooner than a second from now.
    expect(Idle.planReset(work(0), { t3Due: at - 5000, sweep: at + minutes(90), retry: undefined }, at).alarm).toBe(at + 1000);
  });

  it("wakes from the alarm for a due retry, or for an open Remote task with no retry pending (a deploy or an eviction)", () => {
    const at = now.getTime();
    expect(Idle.remoteWakeAt({ attempt: 0, at: at + minutes(5) }, 1)).toBe(at + minutes(5));
    expect(Idle.remoteWakeAt(undefined, 1)).toBe(0);
    expect(Idle.remoteWakeAt(undefined, 0)).toBeNull();
    // A retry left over after the tasks ended wakes nothing.
    expect(Idle.remoteWakeAt({ attempt: 0, at: at + minutes(5) }, 0)).toBeNull();
  });

  it("keeps an alarm standing while a Remote task is open and the Environment is up", () => {
    const at = now.getTime();
    expect(Idle.standingAlarm(null, 1, at)).toBe(at + Idle.REMOTE_STANDING_ALARM_MS);
    expect(Idle.standingAlarm(at + minutes(60), 1, at)).toBe(at + Idle.REMOTE_STANDING_ALARM_MS);
    // An earlier alarm already stands: keep it.
    expect(Idle.standingAlarm(at + minutes(1), 1, at)).toBeUndefined();
    expect(Idle.standingAlarm(null, 0, at)).toBeUndefined();
  });
});
