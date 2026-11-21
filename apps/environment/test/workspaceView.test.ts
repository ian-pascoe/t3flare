// The Workspaces section's read (ADR-0044 §1): every Workspace with its status, its references named by
// their t3 titles, its purge date and the Sweep's plan for it, a project's Worktree Workspaces under it, and what may be
// done to it; and the dry Sweep's preview. Over t3's tables on real SQLite and a registry of fixed rows.
// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vitest";

import type { SweepReport } from "../src/agents/deletion.ts";
import { confirmNameOf, sweepPreview, workspacesView } from "../src/agents/workspaceView.ts";
import { DAY, GRACE, record, t3Tables, viewDeps } from "./fixtures/workspaces.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const NOW = 200 * DAY;

/** A deleted project "Acme" (an older deleted project at the same root too), with a worktree thread deleted and a Tombstone. */
const deletedProject = () => {
  const sql = t3Tables();
  // Deleted before the Sweep marked them (NOW - 2 days), so the marks rule their dates.
  const deleted = new Date(NOW - 5 * DAY).toISOString();
  sql.exec(`INSERT INTO projection_projects VALUES ('p-old', 'Acme (old)', '/w/acme', '1970-01-01T00:00:00Z', '${new Date(NOW - 50 * DAY).toISOString()}', NULL)`);
  sql.exec(`INSERT INTO projection_projects VALUES ('p-acme', 'Acme', '/w/acme', '1970-01-02T00:00:00Z', '${deleted}', NULL)`);
  sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'p-acme', 'Feature A', '${deleted}', NULL, '{"worktreePath":"/w/.wt/acme/feat-a"}')`);
  const rows = [
    record({ id: "acme", unreferencedSince: NOW - 2 * DAY }),
    record({ id: ".wt/acme/feat-a", kind: "worktree", parent: "acme", branch: "feat-a", unreferencedSince: NOW - 2 * DAY }),
    record({ id: ".wt/acme/feat-b", kind: "worktree", parent: "acme", branch: "t3/feat-b", state: "tombstoned", deletedAt: NOW - 3 * DAY, purgeAfter: NOW + 4 * DAY, lastError: "uncommitted work (--force)" }),
  ];
  return { sql, rows };
};

describe("the Workspaces view (ADR-0044 §1)", () => {
  it("a deleted project with two worktrees, one a Tombstone: titles, statuses, purge dates, the Sweep's plan and what may be done", async () => {
    const { sql, rows } = deletedProject();
    const view = await workspacesView(viewDeps(rows, { sql, purgingSince: 0 }), NOW);
    expect(view).toMatchObject({ purging: true, graceDays: 7, graceMs: GRACE, overridden: false, purgingSince: 0 });
    expect(view.rows.map((row) => row.id)).toEqual(["acme"]);
    const [project] = view.rows;
    expect(project).toMatchObject({
      kind: "project",
      title: "Acme",
      repo: "acme/app",
      status: "unreferenced",
      references: [],
      purgeDue: NOW - 2 * DAY + GRACE,
      planned: { action: "skip" },
      confirmName: "acme",
      sessions: 1,
      can: { purge: true, restore: false, stop: true },
    });
    expect(project!.worktrees.map((row) => [row.id, row.title, row.status])).toEqual([
      [".wt/acme/feat-a", "feat-a", "unreferenced"],
      [".wt/acme/feat-b", "t3/feat-b", "tombstone"],
    ]);
    const [a, b] = project!.worktrees;
    expect(a).toMatchObject({ purgeDue: NOW - 2 * DAY + GRACE, sessions: 1, confirmName: "feat-a", can: { purge: true, restore: false, stop: true }, worktrees: [] });
    expect(b).toMatchObject({ purgeDue: NOW - 3 * DAY + GRACE, deletedAt: NOW - 3 * DAY, lastError: "uncommitted work (--force)", confirmName: "feat-b", can: { purge: true, restore: true, stop: false } });
  });

  it("dates a stale mark from the later deletion of a thread that took the Workspace before any Sweep cleared it (ADR-0043 §2)", async () => {
    const sql = t3Tables();
    const deleted = NOW - DAY;
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t5', 'p-x', 'Took it', '${new Date(deleted).toISOString()}', NULL, '{"worktreePath":"/w/.wt/acme/feat-a"}')`);
    const rows = [record({ id: ".wt/acme/feat-a", kind: "worktree", parent: "acme", branch: "feat-a", unreferencedSince: NOW - GRACE })];
    const [row] = (await workspacesView(viewDeps(rows, { sql }), NOW)).rows;
    expect(row).toMatchObject({ purgeDue: deleted + GRACE, planned: { action: "skip" } });
  });

  it("dates nothing before one Grace after purging was turned on, and a Sweep that has not run since counts from now", async () => {
    const { sql, rows } = deletedProject();
    expect((await workspacesView(viewDeps(rows, { sql, purgingSince: NOW - DAY }), NOW)).rows[0]!.purgeDue).toBe(NOW - DAY + GRACE);
    expect((await workspacesView(viewDeps(rows, { sql, purgingSince: null }), NOW)).rows[0]!.purgeDue).toBe(NOW + GRACE);
  });

  it("a referenced project is in use, its references named by their titles, with no date and no Purge; a referenced worktree holds its project's Purge", async () => {
    const sql = t3Tables();
    sql.exec("INSERT INTO projection_projects VALUES ('p-live', 'Live app', '/w/live', '2026-03-01T00:00:00Z', NULL, '2026-04-01T00:00:00Z')");
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t2', 'p-live', 'Fix the bug', NULL, NULL, '{"worktreePath":null}')`);
    sql.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('t2', 'running')");
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t3', 'p-gone', 'Still open', NULL, NULL, '{"worktreePath":"/w/.wt/gone/keep"}')`);
    const rows = [
      record({ id: "gone", unreferencedSince: NOW - DAY }),
      record({ id: ".wt/gone/keep", kind: "worktree", parent: "gone", branch: "keep" }),
      record({ id: "live", unreferencedSince: NOW - 30 * DAY }),
      record({ id: "terminal", name: null, owner: null }),
    ];
    const view = await workspacesView(viewDeps(rows, { sql, terminals: { terminal: 2 } }), NOW);
    const byId = new Map(view.rows.map((row) => [row.id, row]));
    expect(byId.get("live")).toMatchObject({
      title: "Live app",
      status: "in use",
      references: ["project “Live app” (archived)", "thread “Fix the bug”", "open run in thread “Fix the bug”"],
      purgeDue: null,
      planned: { action: "clear-unreferenced" },
      can: { purge: false, restore: false, stop: true },
    });
    expect(byId.get("terminal")).toMatchObject({ title: "terminal", repo: null, status: "in use", references: ["2 open terminals"], can: { purge: false } });
    expect(byId.get("gone")).toMatchObject({ status: "unreferenced", can: { purge: false } });
    expect(byId.get("gone")!.worktrees[0]).toMatchObject({ status: "in use", references: ["thread “Still open”"], can: { purge: false } });
  });

  it("with purging off, dates nothing and says so in each plan; an overridden Grace is reported", async () => {
    const { sql, rows } = deletedProject();
    const view = await workspacesView(viewDeps(rows, { sql, settings: { purging: false, graceMs: 180_000, graceDays: 9, overridden: true }, purgingSince: null }), NOW);
    expect(view).toMatchObject({ purging: false, graceDays: 9, graceMs: 180_000, overridden: true, purgingSince: null });
    const all = [view.rows[0]!, ...view.rows[0]!.worktrees];
    expect(all.map((row) => row.purgeDue)).toEqual([null, null, null]);
    for (const row of all) expect(row.planned.why).toContain("purging is off");
    // The Owner's own Purge does not wait for the setting.
    expect(all.map((row) => row.can.purge)).toEqual([true, true, true]);
  });

  it("names every other state: kept Tombstone, purging, provisioning, failed; a worktree whose project is gone is a row of its own", async () => {
    const rows = [
      record({ id: ".wt/old/kept", kind: "worktree", parent: "old", branch: "kept", state: "tombstoned", deletedAt: NOW - DAY, purgeAfter: null }),
      record({ id: "deleting", state: "deleting" }),
      record({ id: "new", state: "provisioning", createdAt: NOW - 60_000 }),
      record({ id: "broken", state: "failed", lastError: "clone failed" }),
    ];
    const view = await workspacesView(viewDeps(rows), NOW);
    expect(view.rows.map((row) => [row.id, row.status, row.purgeDue, row.can])).toEqual([
      [".wt/old/kept", "tombstone (kept)", null, { purge: true, restore: true, stop: false }],
      ["broken", "failed", null, { purge: true, restore: false, stop: false }],
      ["deleting", "purging", null, { purge: true, restore: false, stop: false }],
      ["new", "provisioning", null, { purge: true, restore: false, stop: false }],
    ]);
  });

  it("fails when a read fails: t3's tables, or a Workspace that cannot say whether its Terminals are open", async () => {
    const rows = [record({ id: "acme" })];
    await expect(workspacesView({ ...viewDeps(rows), sql: nodeSqlStorage() }, NOW)).rejects.toThrow();
    await expect(workspacesView({ ...viewDeps(rows), terminals: async () => Promise.reject(new Error("no answer")) }, NOW)).rejects.toThrow("no answer");
  });
});

describe("the typed name (ADR-0044 §4)", () => {
  it("is a project's folder name and a worktree's last path segment", () => {
    expect(confirmNameOf("acme")).toBe("acme");
    expect(confirmNameOf(".wt/acme/feat-a")).toBe("feat-a");
  });
});

describe("the dry Sweep's preview (ADR-0044 §1)", () => {
  const report = (overrides: Partial<SweepReport>): SweepReport => ({
    at: new Date(NOW).toISOString(),
    dry: true,
    purging: true,
    graceMs: GRACE,
    purgingSince: null,
    ok: true,
    actions: [],
    purged: [],
    sessions: [],
    costGuard: [],
    nextDue: new Date(NOW + DAY).toISOString(),
    ...overrides,
  });

  it("lists each Workspace's action with its reason, the Sessions it would destroy and the Containers it would stop", () => {
    const preview = sweepPreview(
      report({
        actions: [
          { id: "acme", action: "purge", why: "unreferenced since 2026-01-01T00:00:00.000Z" },
          { id: "live", action: "skip", why: "project p-live" },
          { id: "new", action: "mark-unreferenced", why: "nothing references it" },
        ],
        sessions: ["t1", "t2"],
        costGuard: [{ holder: "abc123", action: "would stop" }],
      }),
    );
    expect(preview).toEqual({
      ok: true,
      purging: true,
      summary: "The Sweep would purge 1 Workspace, destroy 2 Sessions and stop 1 Container.",
      rows: [
        { id: "acme", action: "purge", why: "unreferenced since 2026-01-01T00:00:00.000Z" },
        { id: "live", action: "skip", why: "project p-live" },
        { id: "new", action: "mark-unreferenced", why: "nothing references it" },
      ],
      sessions: ["t1", "t2"],
      containers: ["abc123"],
    });
  });

  it("says nothing would be purged when purging is off, and carries a failed read's error", () => {
    expect(sweepPreview(report({ purging: false, actions: [{ id: "acme", action: "skip", why: "unreferenced; purging is off" }] })).summary).toBe(
      "Purging is off: the Sweep would purge nothing and destroy no Session.",
    );
    expect(sweepPreview(report({ purging: false, costGuard: [{ holder: "a", action: "would stop" }, { holder: "b", action: "would stop" }] })).summary).toBe(
      "Purging is off: the Sweep would purge nothing and destroy no Session. It would stop 2 Containers no Workspace holds.",
    );
    // A Purge already under way is finished with purging off too (ADR-0043 §4): the preview says so.
    expect(sweepPreview(report({ purging: false, actions: [{ id: "gone", action: "purge", why: "left in deleting" }, { id: "acme", action: "skip", why: "unreferenced; purging is off" }] })).summary).toBe(
      "Purging is off: the Sweep would start no Purge and destroy no Session on its own; it would finish purging 1 Workspace left purging, with its deleted threads' Sessions.",
    );
    expect(sweepPreview(report({ ok: false, error: "the sweep read failed, nothing done: boom" }))).toMatchObject({ ok: false, summary: "the sweep read failed, nothing done: boom" });
  });
});
