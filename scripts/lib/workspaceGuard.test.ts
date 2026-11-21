// @effect-diagnostics nodeBuiltinImport:off
// The workspace guard's decision (SPI-1290): `node --test`, so the root scripts need no test dependency.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { checkoutRootOf, workspaceDirsOf, workspaceGuard } from "./workspaceGuard.ts";

const repo = fs.realpathSync(path.resolve(import.meta.dirname, "../.."));
const worktree = { root: "/src/t3flare/.worktrees/x" };
const upper = (dir: string) => ({ variable: "NPM_CONFIG_WORKSPACE_DIR", dir });
const lower = (dir: string) => ({ variable: "npm_config_workspace_dir", dir });

await describe("workspaceGuard", () => {
  void it("allows a shell without NPM_CONFIG_WORKSPACE_DIR", () => {
    assert.deepEqual(workspaceGuard([], worktree), { ok: true });
  });

  void it("allows a workspace dir that is the checkout's root", () => {
    assert.deepEqual(workspaceGuard([upper("/src/t3flare/.worktrees/x")], worktree), { ok: true });
  });

  void it("refuses another checkout's workspace dir, naming both paths and the fix", () => {
    const decision = workspaceGuard([upper("/src/t3flare")], worktree);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.match(decision.message, /NPM_CONFIG_WORKSPACE_DIR is \/src\/t3flare\b/);
    assert.match(decision.message, /checkout at \/src\/t3flare\/\.worktrees\/x\b/);
    assert.match(decision.message, /export NPM_CONFIG_WORKSPACE_DIR=\/src\/t3flare\/\.worktrees\/x$/m);
  });

  void it("refuses when either of two set values is another checkout's", () => {
    const decision = workspaceGuard([upper("/src/t3flare/.worktrees/x"), lower("/src/t3flare")], worktree);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.match(decision.message, /npm_config_workspace_dir is \/src\/t3flare,/);
    assert.match(decision.message, /export npm_config_workspace_dir=\/src\/t3flare\/\.worktrees\/x$/m);
  });

  void it("allows a command typed outside any git checkout, saying why it could not check", () => {
    const decision = workspaceGuard([upper("/src/t3flare")], { reason: "/tmp is not in a git checkout" });
    assert.deepEqual(decision, { ok: true, warning: "workspace guard: could not check NPM_CONFIG_WORKSPACE_DIR: /tmp is not in a git checkout" });
  });

  void it("stays quiet outside a checkout when nothing is set", () => {
    assert.deepEqual(workspaceGuard([], { reason: "/tmp is not in a git checkout" }), { ok: true });
  });
});

await describe("workspaceDirsOf", () => {
  void it("reads NPM_CONFIG_WORKSPACE_DIR, else pnpm's lowercase npm_config_workspace_dir, ignoring empty values", () => {
    assert.deepEqual(workspaceDirsOf({}, "/w"), []);
    assert.deepEqual(workspaceDirsOf({ NPM_CONFIG_WORKSPACE_DIR: "" }, "/w"), []);
    assert.deepEqual(workspaceDirsOf({ npm_config_workspace_dir: "/src/t3flare" }, "/w"), [lower("/src/t3flare")]);
    assert.deepEqual(workspaceDirsOf({ NPM_CONFIG_WORKSPACE_DIR: "/a", npm_config_workspace_dir: "/b" }, "/w"), [upper("/a")]);
    assert.deepEqual(workspaceDirsOf({ NPM_CONFIG_WORKSPACE_DIR: "", npm_config_workspace_dir: "/b" }, "/w"), [lower("/b")]);
  });

  void it("resolves a relative value against the directory the command was typed in, as pnpm does", () => {
    assert.deepEqual(workspaceDirsOf({ NPM_CONFIG_WORKSPACE_DIR: "../.." }, "/src/t3flare/.worktrees/x"), [upper("/src/t3flare")]);
    assert.deepEqual(workspaceDirsOf({ npm_config_workspace_dir: "." }, "/src/t3flare/.worktrees/x"), [lower("/src/t3flare/.worktrees/x")]);
  });

  void it("refuses a stale lowercase value", () => {
    const decision = workspaceGuard(workspaceDirsOf({ npm_config_workspace_dir: "/src/t3flare" }, worktree.root), worktree);
    assert.equal(decision.ok, false);
  });
});

await describe("checkoutRootOf", () => {
  void it("is the checkout's root from anywhere in it", () => {
    assert.deepEqual(checkoutRootOf(repo), { root: repo });
    assert.deepEqual(checkoutRootOf(path.join(repo, "scripts/lib")), { root: repo });
  });

  void it("is the superproject's root from inside the t3code submodule", () => {
    assert.deepEqual(checkoutRootOf(path.join(repo, "t3code")), { root: repo });
    assert.deepEqual(checkoutRootOf(path.join(repo, "t3code/apps")), { root: repo });
  });

  void it("gives a reason outside any git checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-guard-"));
    try {
      assert.deepEqual(checkoutRootOf(dir), { reason: `${dir} is not in a git checkout` });
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  void it("gives a reason for a directory that does not exist", () => {
    const dir = path.join(os.tmpdir(), "workspace-guard-missing", "x");
    assert.deepEqual(checkoutRootOf(dir), { reason: `${dir} does not exist` });
  });

  void it("gives a reason when git cannot run", () => {
    const result = checkoutRootOf(repo, "git-that-does-not-exist");
    assert.ok("reason" in result && result.reason.startsWith("git could not run"), JSON.stringify(result));
  });
});
