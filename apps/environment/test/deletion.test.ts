// Deleting Workspaces (step 2b, plan section 5): what references a Workspace, read from t3's tables on real SQLite and
// failing closed (review F3), and the sweep's plan for each state and its grace.
// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vitest";

import { planSweep, referencesFrom, STALE_PROVISIONING_MS } from "../src/agents/deletion.ts";
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

describe("the sweep's plan", () => {
  const DAY = 24 * 60 * 60_000;
  const now = 100 * DAY;
  const grace = 7 * DAY;
  const plan = (record: WorkspaceRecord, referenced = false) =>
    planSweep([record], referenced ? new Map([[record.id, ["thread t1"]]]) : new Map(), now, grace)[0]!;

  it("marks, waits out the grace, then purges an unreferenced Workspace; a reference clears the mark", () => {
    expect(plan(row({}))).toMatchObject({ action: "mark-unreferenced" });
    expect(plan(row({ unreferencedSince: now - grace + 1 }))).toMatchObject({ action: "skip" });
    expect(plan(row({ unreferencedSince: now - grace }))).toMatchObject({ action: "purge" });
    expect(plan(row({ unreferencedSince: now - 30 * DAY }), true)).toMatchObject({ action: "clear-unreferenced", why: "thread t1" });
    expect(plan(row({}), true)).toMatchObject({ action: "skip" });
  });

  it("drives a deleting row again, purges a tombstone after its grace, and keeps one whose removal could not check", () => {
    expect(plan(row({ state: "deleting" }))).toMatchObject({ action: "purge" });
    expect(plan(row({ state: "tombstoned", purgeAfter: now + 1 }))).toMatchObject({ action: "skip" });
    expect(plan(row({ state: "tombstoned", purgeAfter: now }))).toMatchObject({ action: "purge" });
    expect(plan(row({ state: "tombstoned", purgeAfter: now }), true)).toMatchObject({ action: "skip" });
    expect(plan(row({ state: "tombstoned", purgeAfter: null }))).toMatchObject({ action: "skip", why: expect.stringContaining("could not run") });
  });

  it("purges provisioning and failed rows only after an hour", () => {
    expect(plan(row({ state: "provisioning", createdAt: now - STALE_PROVISIONING_MS + 1 }))).toMatchObject({ action: "skip" });
    expect(plan(row({ state: "failed", createdAt: now - STALE_PROVISIONING_MS }))).toMatchObject({ action: "purge" });
  });
});
