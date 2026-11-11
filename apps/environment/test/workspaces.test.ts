// The Workspace registry (step 2b, plan section 3.5) on real SQLite: step 2a's table migrated in place, worktree
// Workspaces registered with their project's remote, and which states resolve for t3's paths.
// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vitest";

import { migrateWorkspaceRegistry, workspaceRegistry } from "../src/agents/workspaces.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const STEP_2A_TABLE = `CREATE TABLE t3flare_workspaces (
  id TEXT PRIMARY KEY, host TEXT, owner TEXT, name TEXT, clone_url TEXT, created_at INTEGER NOT NULL, state TEXT NOT NULL,
  workflows INTEGER NOT NULL DEFAULT 0
)`;

describe("the Workspace registry", () => {
  it("migrates step 2a's table in place, keeping its rows, and readies a New project's empty folder", () => {
    const sql = nodeSqlStorage();
    sql.exec(STEP_2A_TABLE);
    sql.exec("INSERT INTO t3flare_workspaces VALUES ('fixture', 'github.com', 'me', 'repo', 'https://github.com/me/repo.git', 1, 'ready', 1)");
    sql.exec("INSERT INTO t3flare_workspaces VALUES ('scratch', NULL, NULL, NULL, NULL, 2, 'provisioning', 0)");
    const registry = workspaceRegistry(sql);
    expect(registry.get("fixture")).toMatchObject({ id: "fixture", kind: "project", parent: null, state: "ready", workflows: true, cloneUrl: "https://github.com/me/repo.git" });
    expect(registry.get("scratch")?.state).toBe("ready");
    // Idempotent: a second migration changes nothing (and does not ready a new `provisioning` row again).
    registry.setState("scratch", "provisioning");
    migrateWorkspaceRegistry(sql);
    expect(registry.get("scratch")?.state).toBe("provisioning");
  });

  it("registers a worktree with its project's remote and opt-in, and lists it under the project only", () => {
    const registry = workspaceRegistry(nodeSqlStorage());
    registry.create({ id: "fixture", host: "github.com", owner: "Me", name: "repo", cloneUrl: "https://github.com/me/repo.git" });
    registry.setState("fixture", "ready");
    registry.setWorkflows("fixture", true);
    const parent = registry.get("fixture")!;
    const worktree = registry.createWorktree({ id: ".wt/fixture/feat-0123", parent, branch: "feat" });
    expect(worktree).toMatchObject({ kind: "worktree", parent: "fixture", branch: "feat", owner: "me", name: "repo", workflows: true, state: "provisioning" });
    expect(registry.projects().map((ws) => ws.id)).toEqual(["fixture"]);
    expect(registry.worktreesOf("fixture").map((ws) => ws.id)).toEqual([".wt/fixture/feat-0123"]);
    expect(() => registry.createWorktree({ id: ".wt/fixture/feat-0123", parent, branch: "feat" })).toThrow(/exists/);
    expect(() => registry.createWorktree({ id: "fixture-2", parent, branch: "feat" })).toThrow(/not a worktree/);
    expect(() => registry.create({ id: ".wt" })).toThrow(/not a Workspace name/);
  });

  it("resolves only provisioning and ready Workspaces for t3's paths", () => {
    const registry = workspaceRegistry(nodeSqlStorage());
    registry.create({ id: "a" });
    for (const state of ["provisioning", "ready", "failed", "deleting", "tombstoned"] as const) {
      registry.setState("a", state);
      expect(registry.resolve("a") !== undefined, state).toBe(state === "provisioning" || state === "ready");
    }
    registry.setState("a", "tombstoned", { deletedAt: 10, purgeAfter: 20, lastError: "dirty" });
    expect(registry.get("a")).toMatchObject({ deletedAt: 10, purgeAfter: 20, lastError: "dirty" });
  });
});
