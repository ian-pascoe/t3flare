// The Owner's acts on a Workspace (ADR-0044 §2–4): Purge now with its cascade and whole-set refusal,
// Restore and Stop, each audited under `workspaces`; a refusal is not. The page, the admin routes and the Settings
// server call these.
// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vitest";

import type { PurgeReport } from "../src/agents/deletion.ts";
import { purgeNow, restore, stop, type WorkspaceActionsDeps } from "../src/agents/workspaceActions.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import type { AuditEntry } from "../src/harness/store.ts";
import { record, t3Tables, viewDeps } from "./fixtures/workspaces.ts";

const NOW = Date.UTC(2026, 10, 21, 12);
const actor = { caller: "owner:owner-sub" };

const fixture = (rows: Array<WorkspaceRecord>, options: Parameters<typeof viewDeps>[1] & { readonly failPurge?: string } = {}) => {
  const calls: Array<{ readonly op: string; readonly id: string; readonly threads?: ReadonlyArray<string> }> = [];
  const audit: Array<AuditEntry> = [];
  const deps: WorkspaceActionsDeps = {
    ...viewDeps(rows, options),
    purge: async (id, threads): Promise<PurgeReport> => {
      calls.push({ op: "purge", id, threads: threads.map((thread) => thread.threadId) });
      if (id === options.failPurge) return { id, sessionsDestroyed: [], destroyed: false, error: "Workspace DO unreachable" };
      rows.splice(rows.findIndex((row) => row.id === id), 1);
      return { id, sessionsDestroyed: threads.map((thread) => thread.threadId), destroyed: true };
    },
    restore: async (id) => {
      calls.push({ op: "restore", id });
      const row = rows.find((ws) => ws.id === id)!;
      return { ...row, state: "ready", deletedAt: null, purgeAfter: null };
    },
    stop: async (id) => void calls.push({ op: "stop", id }),
    audit: (entry) => void audit.push(entry),
    now: () => NOW,
  };
  return { deps, calls, audit };
};

/** A deleted project with two Worktree Workspaces (one a Tombstone), an unrelated project, and two deleted threads. */
const deletedProject = () => {
  const sql = t3Tables();
  sql.exec("INSERT INTO projection_projects VALUES ('p-acme', 'Acme', '/w/acme', '2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z', NULL)");
  sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'p-acme', 'Feature A', '2026-06-01T00:00:00Z', NULL, '{"worktreePath":"/w/.wt/acme/feat-a"}')`);
  sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t0', 'p-acme', 'Plain', '2026-06-01T00:00:00Z', NULL, '{"worktreePath":null}')`);
  const rows = [
    record({ id: "acme" }),
    record({ id: ".wt/acme/feat-a", kind: "worktree", parent: "acme", branch: "feat-a" }),
    record({ id: ".wt/acme/feat-b", kind: "worktree", parent: "acme", branch: "feat-b", state: "tombstoned", deletedAt: NOW, purgeAfter: NOW }),
    record({ id: "other" }),
  ];
  return { sql, rows };
};

describe("Purge now (ADR-0044 §2–3)", () => {
  it("purges a project's Worktree Workspaces first, then the project, each with its deleted threads' Sessions once; audited as one entry", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql });
    const outcome = await purgeNow(deps, "acme", { force: false, actor });
    expect(outcome).toMatchObject({ ok: true, ids: [".wt/acme/feat-a", ".wt/acme/feat-b", "acme"], sessions: 2 });
    expect(calls).toEqual([
      { op: "purge", id: ".wt/acme/feat-a", threads: ["t1"] },
      { op: "purge", id: ".wt/acme/feat-b", threads: [] },
      // t1's Session went with its worktree; the project's own deleted threads go with it.
      { op: "purge", id: "acme", threads: ["t0"] },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["other"]);
    expect(audit).toEqual([
      { at: NOW, entity: "workspaces", caller: "owner:owner-sub", action: "workspace.purge", target: "acme", after: { purged: [".wt/acme/feat-a", ".wt/acme/feat-b", "acme"], sessions: 2 } },
    ]);
  });

  it("leaves a Session the Sweep already destroyed, and records the ones it destroys", async () => {
    const { sql, rows } = deletedProject();
    const swept = new Set(["t1"]);
    const { deps, calls, audit } = fixture(rows, { sql });
    const outcome = await purgeNow({ ...deps, sweptSessions: { has: (thread) => swept.has(thread), add: (thread) => void swept.add(thread) } }, "acme", { force: false, actor });
    expect(outcome).toMatchObject({ ok: true, sessions: 1 });
    expect(calls.map((call) => call.threads)).toEqual([[], [], ["t0"]]);
    expect([...swept].toSorted()).toEqual(["t0", "t1"]);
    expect(audit).toMatchObject([{ after: { sessions: 1 } }]);
  });

  it("leaves a failed purge's Sessions unrecorded, so its retry counts them", async () => {
    const { sql, rows } = deletedProject();
    const swept = new Set<string>();
    const { deps } = fixture(rows, { sql });
    const failing: WorkspaceActionsDeps = {
      ...deps,
      sweptSessions: { has: (thread) => swept.has(thread), add: (thread) => void swept.add(thread) },
      // The Workspace DO's destroy fails after its Sessions went.
      purge: async (id, threads) => ({ id, sessionsDestroyed: threads.map((thread) => thread.threadId), destroyed: false, error: "Workspace DO unreachable" }),
    };
    expect(await purgeNow(failing, ".wt/acme/feat-a", { force: false, actor })).toMatchObject({ ok: false, status: 502 });
    expect([...swept]).toEqual([]);
  });

  it("purges a worktree row alone", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql });
    expect(await purgeNow(deps, ".wt/acme/feat-b", { force: false, actor })).toMatchObject({ ok: true, ids: [".wt/acme/feat-b"], sessions: 0 });
    expect(calls.map((call) => call.id)).toEqual([".wt/acme/feat-b"]);
    expect(audit).toMatchObject([{ action: "workspace.purge", target: ".wt/acme/feat-b", after: { purged: [".wt/acme/feat-b"], sessions: 0 } }]);
  });

  it("refuses the whole set when one worktree is referenced, naming every reference; nothing is purged or audited", async () => {
    const { sql, rows } = deletedProject();
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t9', 'p-elsewhere', 'Still working', NULL, NULL, '{"worktreePath":"/w/.wt/acme/feat-a"}')`);
    const { deps, calls, audit } = fixture(rows, { sql, terminals: { ".wt/acme/feat-a": 1 } });
    const outcome = await purgeNow(deps, "acme", { force: false, actor });
    expect(outcome).toMatchObject({ ok: false, status: 409, references: { ".wt/acme/feat-a": ["thread “Still working”", "1 open terminals"] } });
    expect(outcome.ok ? "" : outcome.error).toBe(
      "acme is referenced, so nothing was purged: .wt/acme/feat-a by thread “Still working”, 1 open terminals. Delete the project or thread in t3 first.",
    );
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
    expect(rows).toHaveLength(4);
  });

  it("refuses a referenced project itself", async () => {
    const sql = t3Tables();
    sql.exec("INSERT INTO projection_projects VALUES ('p-live', 'Live', '/w/live', '2026-03-01T00:00:00Z', NULL, NULL)");
    const { deps, calls } = fixture([record({ id: "live" })], { sql });
    expect(await purgeNow(deps, "live", { force: false, actor })).toMatchObject({ ok: false, status: 409, references: { live: ["project “Live”"] } });
    expect(calls).toEqual([]);
  });

  it("refuses an unknown id", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql });
    expect(await purgeNow(deps, "nope", { force: false, actor })).toEqual({ ok: false, status: 404, error: "no Workspace nope" });
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("with force (the admin route's alone) purges a referenced set, and says so in its entry", async () => {
    const sql = t3Tables();
    sql.exec("INSERT INTO projection_projects VALUES ('p-live', 'Live', '/w/live', '2026-03-01T00:00:00Z', NULL, NULL)");
    const { deps, calls, audit } = fixture([record({ id: "live" })], { sql });
    expect(await purgeNow(deps, "live", { force: true, actor: { caller: "admin" } })).toMatchObject({ ok: true, ids: ["live"] });
    expect(calls.map((call) => call.id)).toEqual(["live"]);
    expect(audit).toMatchObject([{ caller: "admin", after: { purged: ["live"], sessions: 0, force: true } }]);
  });

  it("with force, a Workspace DO that cannot say whether its Terminals are open is recorded, not fatal", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql });
    const broken = { ...deps, terminals: async (id: string) => (id === ".wt/acme/feat-a" ? Promise.reject(new Error("no answer")) : 0) };
    const outcome = await purgeNow(broken, "acme", { force: true, actor: { caller: "admin" } });
    expect(outcome).toMatchObject({ ok: true, ids: [".wt/acme/feat-a", ".wt/acme/feat-b", "acme"], unread: [{ id: ".wt/acme/feat-a", error: "Error: no answer" }] });
    expect(calls.map((call) => call.id)).toEqual([".wt/acme/feat-a", ".wt/acme/feat-b", "acme"]);
    expect(audit).toMatchObject([{ caller: "admin", after: { force: true, unread: [{ id: ".wt/acme/feat-a", error: "Error: no answer" }] } }]);
  });

  it("stops at a purge that fails, leaving the rest for the Owner or the Sweep, and audits what went", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql, failPurge: ".wt/acme/feat-b" });
    const outcome = await purgeNow(deps, "acme", { force: false, actor });
    expect(outcome).toMatchObject({ ok: false, status: 502 });
    expect(outcome.ok ? "" : outcome.error).toContain(".wt/acme/feat-b could not be purged: Workspace DO unreachable");
    expect(calls.map((call) => call.id)).toEqual([".wt/acme/feat-a", ".wt/acme/feat-b"]);
    expect(audit).toMatchObject([{ action: "workspace.purge", target: "acme", after: { purged: [".wt/acme/feat-a"], sessions: 1, failed: { id: ".wt/acme/feat-b", error: "Workspace DO unreachable" } } }]);
  });

  it("fails without purging when the reference read fails, and says so", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql });
    const outcome = await purgeNow({ ...deps, terminals: async () => Promise.reject(new Error("no answer")) }, "acme", { force: false, actor });
    expect(outcome).toMatchObject({ ok: false, status: 503 });
    expect(outcome.ok ? "" : outcome.error).toBe("the Workspace's references could not be read, so nothing was purged: Error: no answer");
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
  });
});

describe("Restore and Stop (ADR-0044 §1)", () => {
  it("restores a Tombstone only, audited", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql });
    expect(await restore(deps, "acme", { actor })).toEqual({ ok: false, status: 409, error: "acme is not a Tombstone" });
    expect(await restore(deps, "nope", { actor })).toEqual({ ok: false, status: 404, error: "no Workspace nope" });
    expect(await restore(deps, ".wt/acme/feat-b", { actor })).toMatchObject({ ok: true, restored: { id: ".wt/acme/feat-b", state: "ready" } });
    expect(calls).toEqual([{ op: "restore", id: ".wt/acme/feat-b" }]);
    expect(audit).toEqual([{ at: NOW, entity: "workspaces", caller: "owner:owner-sub", action: "workspace.restore", target: ".wt/acme/feat-b", before: { state: "tombstoned" }, after: { state: "ready" } }]);
  });

  it("stops a ready Workspace's Container only, audited", async () => {
    const { sql, rows } = deletedProject();
    const { deps, calls, audit } = fixture(rows, { sql });
    expect(await stop(deps, ".wt/acme/feat-b", { actor })).toEqual({ ok: false, status: 409, error: ".wt/acme/feat-b is not ready: tombstoned" });
    expect(await stop(deps, "nope", { actor })).toEqual({ ok: false, status: 404, error: "no Workspace nope" });
    expect(await stop(deps, "other", { actor })).toEqual({ ok: true, stopped: "other" });
    expect(calls).toEqual([{ op: "stop", id: "other" }]);
    expect(audit).toEqual([{ at: NOW, entity: "workspaces", caller: "owner:owner-sub", action: "workspace.stop", target: "other", after: { stopped: true } }]);
  });
});
