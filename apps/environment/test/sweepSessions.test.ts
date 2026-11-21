// @effect-diagnostics globalDate:off
// The Sweep's Purges of a deleted project and its worktree (ADR-0044 §4, found on the purge Stage): a deleted worktree
// thread is under both Workspaces, so its Session is destroyed once, and only one `sweep.purge` entry counts it, as a
// Purge now's set does (workspaceActions.ts).
import { afterEach, describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { sweep, type PurgeReport } from "../src/agents/deletion.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import { DAY, record, t3Tables } from "./fixtures/workspaces.ts";

const NOW = 30 * DAY;
const GRACE_MS = 3 * 60_000;

/** A namespace whose objects answer `methods`, each `get` by the name it was asked for. */
const namespace = (methods: (name: string) => Record<string, unknown>) => ({
  idFromName: (name: string) => name,
  get: (name: string) => methods(name),
});

const servicesWith = (rows: Array<WorkspaceRecord>, destroyedSessions: Array<string>, workspaceDestroy: () => Promise<unknown> = async () => undefined) => {
  const registry = {
    list: () => rows,
    get: (id: string) => rows.find((row) => row.id === id),
    setState: (id: string, state: WorkspaceRecord["state"]) => {
      const at = rows.findIndex((row) => row.id === id);
      rows[at] = { ...rows[at]!, state };
    },
    setLastError: () => undefined,
    setUnreferencedSince: () => undefined,
    remove: (id: string) => void rows.splice(rows.findIndex((row) => row.id === id), 1),
  };
  // SAFETY: a stand-in for the few registry and namespace methods the Sweep calls, not the whole EnvironmentServices.
  bindEnvironmentServices({
    workspaces: registry,
    agents: {
      SESSIONS: namespace((name) => ({ destroy: async () => void destroyedSessions.push(name) })),
      WORKSPACES: namespace(() => ({ terminalState: async () => ({ keys: [] }), destroy: workspaceDestroy })),
    },
  } as unknown as EnvironmentServices);
};

// The binding outlives each test: unbind it, so the default access finds no services.
// SAFETY: `undefined` is the binding's unset state, which its type does not name.
afterEach(() => bindEnvironmentServices(undefined as unknown as EnvironmentServices));

describe("the Sweep's Purge of a deleted project with a worktree thread", () => {
  it("destroys the worktree thread's Session once, and counts it in one sweep.purge entry", async () => {
    const sql = t3Tables();
    const deletedAt = new Date(NOW - 10 * 60_000).toISOString();
    sql.exec("INSERT INTO projection_projects (project_id, title, workspace_root, created_at, deleted_at) VALUES ('p1', 'app', '/w/app', ?, ?)", deletedAt, deletedAt);
    sql.exec(
      "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, deleted_at, payload_json) VALUES ('t1', 'p1', 'wt thread', ?, ?)",
      deletedAt,
      JSON.stringify({ worktreePath: "/w/.wt/app/t3-1" }),
    );
    const marked = NOW - 5 * 60_000;
    const rows = [
      record({ id: "app", unreferencedSince: marked }),
      record({ id: ".wt/app/t3-1", kind: "worktree", parent: "app", branch: "t3-1", unreferencedSince: marked }),
    ];
    const destroyedSessions: Array<string> = [];
    servicesWith(rows, destroyedSessions);
    const entries: Array<PurgeReport> = [];
    const report = await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, dry: false },
      NOW,
      undefined,
      { get: () => NOW - DAY, set: () => undefined },
      (purged) => void entries.push(purged),
    );
    expect(report.ok).toBe(true);
    expect(entries.map((entry) => entry.id).toSorted()).toEqual([".wt/app/t3-1", "app"]);
    expect(destroyedSessions).toEqual(["thread:t1"]);
    expect(entries.flatMap((entry) => entry.sessionsDestroyed)).toEqual(["t1"]);
  });

  it("leaves a Session an earlier run already destroyed, and records the ones it destroys", async () => {
    const sql = t3Tables();
    const deletedAt = new Date(NOW - 10 * 60_000).toISOString();
    sql.exec("INSERT INTO projection_projects (project_id, title, workspace_root, created_at, deleted_at) VALUES ('p1', 'app', '/w/app', ?, ?)", deletedAt, deletedAt);
    for (const [thread, worktree] of [
      ["t1", "/w/.wt/app/t3-1"],
      ["t2", null],
    ] as const) {
      sql.exec(
        "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, deleted_at, payload_json) VALUES (?, 'p1', 'a thread', ?, ?)",
        thread,
        deletedAt,
        JSON.stringify({ worktreePath: worktree }),
      );
    }
    const marked = NOW - 5 * 60_000;
    const rows = [
      record({ id: "app", unreferencedSince: marked }),
      record({ id: ".wt/app/t3-1", kind: "worktree", parent: "app", branch: "t3-1", unreferencedSince: marked }),
    ];
    const destroyedSessions: Array<string> = [];
    servicesWith(rows, destroyedSessions);
    // t1's Session went in an earlier run (its date comes a few seconds before its Workspaces').
    const swept = new Set(["t1"]);
    const entries: Array<PurgeReport> = [];
    await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, dry: false },
      NOW,
      { has: (thread) => swept.has(thread), add: (thread) => void swept.add(thread) },
      { get: () => NOW - DAY, set: () => undefined },
      (purged) => void entries.push(purged),
    );
    expect(destroyedSessions).toEqual(["thread:t2"]);
    expect(entries.flatMap((entry) => entry.sessionsDestroyed)).toEqual(["t2"]);
    expect([...swept].toSorted()).toEqual(["t1", "t2"]);
  });

  it("counts a failed purge's Sessions in the run's Session pass, not lost to its record", async () => {
    const sql = t3Tables();
    const deletedAt = new Date(NOW - 10 * 60_000).toISOString();
    sql.exec("INSERT INTO projection_projects (project_id, title, workspace_root, created_at, deleted_at) VALUES ('p1', 'app', '/w/app', ?, ?)", deletedAt, deletedAt);
    sql.exec(
      "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, deleted_at, payload_json) VALUES ('t2', 'p1', 'a thread', ?, ?)",
      deletedAt,
      JSON.stringify({ worktreePath: null }),
    );
    const rows = [record({ id: "app", unreferencedSince: NOW - 5 * 60_000 })];
    // The Workspace DO's destroy fails after its Sessions went: the row stays `deleting`.
    servicesWith(rows, [], async () => Promise.reject(new Error("Workspace DO unreachable")));
    const swept = new Set<string>();
    const report = await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, dry: false },
      NOW,
      { has: (thread) => swept.has(thread), add: (thread) => void swept.add(thread) },
      { get: () => NOW - DAY, set: () => undefined },
    );
    expect(rows[0]?.state).toBe("deleting");
    expect(report.sessions).toEqual(["t2"]);
  });
});
