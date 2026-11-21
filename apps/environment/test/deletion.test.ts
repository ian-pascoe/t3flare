// Deleting Workspaces (step 2b, plan section 5): what references a Workspace, read from t3's tables on real SQLite and
// failing closed (review F3), the purge date (ADR-0043), and the sweep's plan for each state, its Grace and purging off.
// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vitest";

import { ENVIRONMENT_SETTINGS } from "@t3flare/harness-registry";

import {
  DELETING_RETRY_MS,
  nextSweepAt,
  planSweep,
  purgeDue,
  purgeSubjectOf,
  referencesFrom,
  STALE_PROVISIONING_MS,
  SWEEP_EVERY_MS,
  sweepSettingsOf,
} from "../src/agents/deletion.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const t3Tables = () => {
  const sql = nodeSqlStorage();
  sql.exec("CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT, archived_at TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, deleted_at TEXT, archived_at TEXT, payload_json TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)");
  return sql;
};

describe("references", () => {
  it("match by Workspace id: projects (archived too, in a subdirectory too), live threads' worktrees, open runs", () => {
    const sql = t3Tables();
    sql.exec("INSERT INTO projection_projects VALUES ('p1', '/w/mono/packages/app', NULL, '2026-01-01')");
    sql.exec("INSERT INTO projection_projects VALUES ('p2', '/w/gone', '2026-01-01', NULL)");
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'p1', NULL, NULL, '{"worktreePath":"/w/.wt/app/feat-1"}')`);
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t2', 'p1', '2026-01-02', NULL, '{"worktreePath":"/w/.wt/app/feat-2"}')`);
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t3', 'p2', NULL, NULL, '{"worktreePath":null}')`);
    sql.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('t3', 'running')");
    const references = referencesFrom(sql);
    expect(references.byWorkspace.get("mono")).toEqual(["project p1 (archived)", "thread t1"]);
    expect(references.byWorkspace.get(".wt/app/feat-1")).toEqual(["thread t1"]);
    // A deleted thread references nothing; its Session goes with the purge.
    expect(references.byWorkspace.has(".wt/app/feat-2")).toBe(false);
    expect(references.deletedThreads.get(".wt/app/feat-2")).toEqual([{ threadId: "t2", deletedAt: "2026-01-02" }]);
    // A deleted project's live thread with an open run still holds the project's Workspace.
    expect(references.byWorkspace.get("gone")).toEqual(["thread t3", "open run in thread t3"]);
  });

  it("date each Workspace's release: the latest deleted_at of a deleted project or thread that referenced it", () => {
    const sql = t3Tables();
    sql.exec("INSERT INTO projection_projects VALUES ('p1', '/w/acme', '2026-01-05T00:00:00Z', NULL)");
    sql.exec("INSERT INTO projection_projects VALUES ('p0', '/w/acme', '2026-01-01T00:00:00Z', NULL)");
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'p1', '2026-01-03T00:00:00Z', NULL, '{"worktreePath":"/w/.wt/acme/feat"}')`);
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t2', 'p1', '2026-01-09T00:00:00Z', NULL, '{"worktreePath":"/w/.wt/acme/feat"}')`);
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t3', 'p1', 'not a date', NULL, '{"worktreePath":"/w/.wt/acme/other"}')`);
    const { released } = referencesFrom(sql);
    expect(released.get(".wt/acme/feat")).toBe(Date.parse("2026-01-09T00:00:00Z"));
    // The project's Workspace: its own deletion, or a deleted thread in it, whichever is later.
    expect(released.get("acme")).toBe(Date.parse("2026-01-09T00:00:00Z"));
    expect(released.has(".wt/acme/other")).toBe(false);
  });

  it("fail closed: a table t3 renamed or dropped throws instead of answering nothing", () => {
    const sql = nodeSqlStorage();
    sql.exec("CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT, archived_at TEXT)");
    expect(() => referencesFrom(sql)).toThrow();
  });
});

const row = (overrides: Partial<WorkspaceRecord>): WorkspaceRecord => ({
  id: "x",
  host: null,
  owner: null,
  name: null,
  cloneUrl: null,
  createdAt: 0,
  state: "ready",
  workflows: false,
  kind: "worktree",
  parent: "p",
  branch: "b",
  unreferencedSince: null,
  deletedAt: null,
  purgeAfter: null,
  lastError: null,
  ...overrides,
});

const DAY = 24 * 60 * 60_000;

describe("the purge date (ADR-0043 §2)", () => {
  const grace = 7 * DAY;
  const at = 50 * DAY;
  const clock = (purgingSince: number | null) => ({ graceMs: grace, purgingSince });

  it("an unreferenced Workspace is due its mark plus the Grace, no sooner than one Grace after purging was turned on", () => {
    expect(purgeDue({ kind: "unreferenced", since: at }, clock(null))).toBe(at + grace);
    expect(purgeDue({ kind: "unreferenced", since: at }, clock(at - DAY))).toBe(at + grace);
    expect(purgeDue({ kind: "unreferenced", since: at }, clock(at + DAY))).toBe(at + DAY + grace);
  });

  it("a Tombstone with a date is due its deletion plus the Grace; one without is never due", () => {
    expect(purgeDue({ kind: "tombstone", deletedAt: at, dated: true }, clock(null))).toBe(at + grace);
    expect(purgeDue({ kind: "tombstone", deletedAt: at, dated: true }, clock(at + 2 * DAY))).toBe(at + 2 * DAY + grace);
    expect(purgeDue({ kind: "tombstone", deletedAt: at, dated: false }, clock(null))).toBeNull();
    expect(purgeDue({ kind: "tombstone", deletedAt: at, dated: false }, clock(at - DAY))).toBeNull();
  });

  it("a deleted thread's Session is due t3's deleted_at plus the Grace; a date it cannot read is never due", () => {
    const deletedAt = new Date(at).toISOString();
    expect(purgeDue({ kind: "session", deletedAt }, clock(null))).toBe(at + grace);
    expect(purgeDue({ kind: "session", deletedAt }, clock(at + 3 * DAY))).toBe(at + 3 * DAY + grace);
    expect(purgeDue({ kind: "session", deletedAt: "not a date" }, clock(null))).toBeNull();
  });

  it("a row's subject counts from the later of its mark (or removal) and the last deletion in t3 that released it (ADR-0043 §2)", () => {
    expect(purgeSubjectOf(row({ unreferencedSince: at }), at + DAY)).toEqual({ kind: "unreferenced", since: at + DAY });
    expect(purgeSubjectOf(row({ unreferencedSince: at }), at - DAY)).toEqual({ kind: "unreferenced", since: at });
    expect(purgeSubjectOf(row({ state: "tombstoned", deletedAt: at, purgeAfter: 1 }), at + DAY)).toEqual({ kind: "tombstone", deletedAt: at + DAY, dated: true });
    expect(purgeSubjectOf(row({}), at + DAY)).toBeUndefined();
  });

  it("a row's subject: ready and marked, a Tombstone dated by purge_after; nothing for any other row", () => {
    expect(purgeSubjectOf(row({ unreferencedSince: at }))).toEqual({ kind: "unreferenced", since: at });
    expect(purgeSubjectOf(row({}))).toBeUndefined();
    expect(purgeSubjectOf(row({ state: "tombstoned", deletedAt: at, purgeAfter: at + 123 }))).toEqual({ kind: "tombstone", deletedAt: at, dated: true });
    expect(purgeSubjectOf(row({ state: "tombstoned", deletedAt: at, purgeAfter: null }))).toEqual({ kind: "tombstone", deletedAt: at, dated: false });
    for (const state of ["deleting", "provisioning", "failed"] as const) expect(purgeSubjectOf(row({ state, unreferencedSince: at }))).toBeUndefined();
  });
});

describe("the Sweep's settings (ADR-0043 §2–3)", () => {
  it("are the stored Grace in days and the purging switch; a Stage's T3FLARE_SWEEP_GRACE_MS overrides the days", () => {
    expect(sweepSettingsOf({ sweepPurges: true, graceDays: 7 }, undefined)).toEqual({ purging: true, graceMs: 7 * DAY, graceDays: 7, overridden: false });
    expect(sweepSettingsOf({ sweepPurges: false, graceDays: 2 }, "")).toEqual({ purging: false, graceMs: 2 * DAY, graceDays: 2, overridden: false });
    expect(sweepSettingsOf({ sweepPurges: true, graceDays: 7 }, "180000")).toEqual({ purging: true, graceMs: 180_000, graceDays: 7, overridden: true });
    for (const junk of ["0", "-5", "soon"]) expect(sweepSettingsOf({ sweepPurges: true, graceDays: 3 }, junk)).toEqual({ purging: true, graceMs: 3 * DAY, graceDays: 3, overridden: false });
  });
});

describe("the sweep's plan", () => {
  const now = 100 * DAY;
  const grace = 7 * DAY;
  const on = { purging: true, graceMs: grace, purgingSince: 0 };
  const plan = (record: WorkspaceRecord, referenced = false, sweep: Parameters<typeof planSweep>[3] = on) =>
    planSweep([record], referenced ? new Map([[record.id, ["thread t1"]]]) : new Map(), now, sweep, new Map())[0]!;

  it("marks, waits out the grace, then purges an unreferenced Workspace; a reference clears the mark", () => {
    expect(plan(row({}))).toMatchObject({ action: "mark-unreferenced" });
    expect(plan(row({ unreferencedSince: now - grace + 1 }))).toMatchObject({ action: "skip", due: now + 1 });
    expect(plan(row({ unreferencedSince: now - grace }))).toMatchObject({ action: "purge" });
    expect(plan(row({ unreferencedSince: now - 30 * DAY }), true)).toMatchObject({ action: "clear-unreferenced", why: "thread t1" });
    expect(plan(row({}), true)).toMatchObject({ action: "skip" });
  });

  it("a row it marks is due a Grace from now, so a Sweep that only marks comes back on that date (ADR-0043 §5; found on the purge Stage)", () => {
    expect(plan(row({}))).toMatchObject({ action: "mark-unreferenced", due: now + grace });
    // Never before one Grace after purging was turned on (ADR-0043 §4), nor before a later release's Grace (ADR-0043 §2).
    expect(plan(row({}), false, { purging: true, graceMs: grace, purgingSince: now + DAY })).toMatchObject({ action: "mark-unreferenced", due: now + DAY + grace });
    expect(planSweep([row({ id: "wt" })], new Map(), now, on, new Map([["wt", now + 60_000]]))[0]).toMatchObject({ action: "mark-unreferenced", due: now + 60_000 + grace });
    expect(plan(row({}), false, { purging: false, graceMs: grace, purgingSince: null })).not.toHaveProperty("due");
  });

  it("drives a deleting row again, purges a tombstone after its grace, and keeps one whose removal could not check", () => {
    expect(plan(row({ state: "deleting" }))).toMatchObject({ action: "purge" });
    expect(plan(row({ state: "tombstoned", deletedAt: now - grace + 1, purgeAfter: 1 }))).toMatchObject({ action: "skip", due: now + 1 });
    expect(plan(row({ state: "tombstoned", deletedAt: now - grace, purgeAfter: now + 30 * DAY }))).toMatchObject({ action: "purge" });
    expect(plan(row({ state: "tombstoned", deletedAt: now - grace, purgeAfter: 1 }), true)).toMatchObject({ action: "skip" });
    expect(plan(row({ state: "tombstoned", deletedAt: now - 30 * DAY, purgeAfter: null }))).toMatchObject({ action: "skip", why: expect.stringContaining("could not run") });
  });

  it("a stale mark does not purge inside the Grace of a thread that took the Workspace and was deleted before any Sweep ran", () => {
    // Marked at T0; a thread takes the worktree at T0 + 0.9 Grace and is deleted at once, before a Sweep clears the mark.
    const t0 = now - grace;
    const deleted = t0 + 0.9 * grace;
    const marked = row({ id: "wt", unreferencedSince: t0 });
    const [action] = planSweep([marked], new Map(), now, on, new Map([["wt", deleted]]));
    expect(action).toMatchObject({ action: "skip", due: deleted + grace });
    expect(planSweep([marked], new Map(), deleted + grace, on, new Map([["wt", deleted]]))[0]).toMatchObject({ action: "purge" });
  });

  it("purges provisioning and failed rows only after an hour", () => {
    expect(plan(row({ state: "provisioning", createdAt: now - STALE_PROVISIONING_MS + 1 }))).toMatchObject({ action: "skip" });
    expect(plan(row({ state: "failed", createdAt: now - STALE_PROVISIONING_MS }))).toMatchObject({ action: "purge" });
  });

  it("with purging off still marks and clears, purges nothing new, and drives a deleting row on (ADR-0043 §4)", () => {
    const off = { purging: false, graceMs: grace, purgingSince: null };
    expect(plan(row({}), false, off)).toMatchObject({ action: "mark-unreferenced" });
    expect(plan(row({ unreferencedSince: now - 30 * DAY }), true, off)).toMatchObject({ action: "clear-unreferenced" });
    expect(plan(row({ unreferencedSince: now - 30 * DAY }), false, off)).toMatchObject({ action: "skip", why: expect.stringContaining("purging is off") });
    expect(plan(row({ state: "tombstoned", deletedAt: now - 30 * DAY, purgeAfter: 1 }), false, off)).toMatchObject({ action: "skip", why: expect.stringContaining("purging is off") });
    expect(plan(row({ state: "failed", createdAt: 0 }), false, off)).toMatchObject({ action: "skip" });
    expect(plan(row({ state: "deleting" }), false, off)).toMatchObject({ action: "purge" });
    for (const action of planSweep([row({ unreferencedSince: 0 }), row({ state: "tombstoned", deletedAt: 0, purgeAfter: 1 })], new Map(), now, off, new Map())) expect(action).not.toHaveProperty("due");
  });

  it("with a shortened Grace, an old mark is due at once, but not before one Grace after purging was turned on (ADR-0043 §4)", () => {
    const old = row({ unreferencedSince: now - 30 * DAY });
    expect(plan(old, false, { purging: true, graceMs: DAY, purgingSince: now - DAY })).toMatchObject({ action: "purge" });
    expect(plan(old, false, { purging: true, graceMs: DAY, purgingSince: now - DAY + 1 })).toMatchObject({ action: "skip", due: now + 1 });
    // Purging just turned on: a full Grace for everything, a Tombstone with a date included.
    expect(plan(row({ state: "tombstoned", deletedAt: now - 30 * DAY, purgeAfter: 1 }), false, { purging: true, graceMs: DAY, purgingSince: now })).toMatchObject({ action: "skip", due: now + DAY });
    // A deleting row, and a stale provisioning one, are not held by it.
    expect(plan(row({ state: "deleting" }), false, { purging: true, graceMs: DAY, purgingSince: now })).toMatchObject({ action: "purge" });
    expect(plan(row({ state: "provisioning", createdAt: now - 2 * STALE_PROVISIONING_MS }), false, { purging: true, graceMs: DAY, purgingSince: now })).toMatchObject({ action: "purge" });
  });

  it("never purges a ready Workspace younger than a day: its mark cannot precede its creation, and the Grace is a day at least (ADR-0043's Consequences)", () => {
    expect(ENVIRONMENT_SETTINGS.graceDays.schema.minimum).toBe(1);
    const shortest = sweepSettingsOf({ sweepPurges: true, graceDays: ENVIRONMENT_SETTINGS.graceDays.schema.minimum }, undefined);
    for (const age of [0, 60_000, STALE_PROVISIONING_MS, DAY / 2, DAY - 1]) {
      const young = row({ createdAt: now - age, unreferencedSince: now - age });
      expect(plan(young, false, { ...shortest, purgingSince: 0 }), String(age)).toMatchObject({ action: "skip" });
    }
    expect(plan(row({ createdAt: now - DAY, unreferencedSince: now - DAY }), false, { ...shortest, purgingSince: 0 })).toMatchObject({ action: "purge" });
  });
});

describe("the Sweep's next run (ADR-0043 §5)", () => {
  const now = 100 * DAY;

  it("is a day ahead, or sooner at the earliest purge date it skipped, never sooner than a minute ahead", () => {
    expect(nextSweepAt({ now, dues: [], deletingLeft: false })).toBe(now + SWEEP_EVERY_MS);
    expect(nextSweepAt({ now, dues: [now + 3 * DAY], deletingLeft: false })).toBe(now + SWEEP_EVERY_MS);
    expect(nextSweepAt({ now, dues: [now + 2 * 60 * 60_000, now + 5 * 60 * 60_000], deletingLeft: false })).toBe(now + 2 * 60 * 60_000);
    expect(nextSweepAt({ now, dues: [now + 1000], deletingLeft: false })).toBe(now + 60_000);
  });

  it("is five minutes ahead when a deleting row is left", () => {
    expect(nextSweepAt({ now, dues: [], deletingLeft: true })).toBe(now + DELETING_RETRY_MS);
    expect(nextSweepAt({ now, dues: [now + 2 * 60_000], deletingLeft: true })).toBe(now + 2 * 60_000);
  });
});
