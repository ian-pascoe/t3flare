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

describe("workspaceGuard", () => {
  it("allows a shell without NPM_CONFIG_WORKSPACE_DIR", () => {
    assert.deepEqual(workspaceGuard([], worktree), { ok: true });
  });

  it("allows a workspace dir that is the checkout's root", () => {
    assert.deepEqual(workspaceGuard([upper("/src/t3flare/.worktrees/x")], worktree), { ok: true });
  });

  it("refuses another checkout's workspace dir, naming both paths and the fix", () => {
    const decision = workspaceGuard([upper("/src/t3flare")], worktree);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.match(decision.message, /NPM_CONFIG_WORKSPACE_DIR is \/src\/t3flare\b/);
    assert.match(decision.message, /checkout at \/src\/t3flare\/\.worktrees\/x\b/);
    assert.match(decision.message, /export NPM_CONFIG_WORKSPACE_DIR=\/src\/t3flare\/\.worktrees\/x$/m);
  });

  it("refuses when either of two set values is another checkout's", () => {
    const decision = workspaceGuard([upper("/src/t3flare/.worktrees/x"), lower("/src/t3flare")], worktree);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.match(decision.message, /npm_config_workspace_dir is \/src\/t3flare,/);
    assert.match(decision.message, /export npm_config_workspace_dir=\/src\/t3flare\/\.worktrees\/x$/m);
  });

  it("allows a command typed outside any git checkout, saying why it could not check", () => {
    const decision = workspaceGuard([upper("/src/t3flare")], { reason: "/tmp is not in a git checkout" });
    assert.deepEqual(decision, { ok: true, warning: "workspace guard: could not check NPM_CONFIG_WORKSPACE_DIR: /tmp is not in a git checkout" });
  });

  it("stays quiet outside a checkout when nothing is set", () => {
    assert.deepEqual(workspaceGuard([], { reason: "/tmp is not in a git checkout" }), { ok: true });
  });
});

describe("workspaceDirsOf", () => {
  it("reads NPM_CONFIG_WORKSPACE_DIR and pnpm's lowercase npm_config_workspace_dir, ignoring empty values", () => {
    assert.deepEqual(workspaceDirsOf({}, "/w"), []);
    assert.deepEqual(workspaceDirsOf({ NPM_CONFIG_WORKSPACE_DIR: "" }, "/w"), []);
    assert.deepEqual(workspaceDirsOf({ npm_config_workspace_dir: "/src/t3flare" }, "/w"), [lower("/src/t3flare")]);
    assert.deepEqual(workspaceDirsOf({ NPM_CONFIG_WORKSPACE_DIR: "/a", npm_config_workspace_dir: "/b" }, "/w"), [upper("/a"), lower("/b")]);
  });

  it("resolves a relative value against the directory the command was typed in, as pnpm does", () => {
    assert.deepEqual(workspaceDirsOf({ NPM_CONFIG_WORKSPACE_DIR: "../.." }, "/src/t3flare/.worktrees/x"), [upper("/src/t3flare")]);
    assert.deepEqual(workspaceDirsOf({ npm_config_workspace_dir: "." }, "/src/t3flare/.worktrees/x"), [lower("/src/t3flare/.worktrees/x")]);
  });

  it("refuses a stale lowercase value", () => {
    const decision = workspaceGuard(workspaceDirsOf({ npm_config_workspace_dir: "/src/t3flare" }, worktree.root), worktree);
    assert.equal(decision.ok, false);
  });
});

describe("checkoutRootOf", () => {
  it("is the checkout's root from anywhere in it", () => {
    assert.deepEqual(checkoutRootOf(repo), { root: repo });
    assert.deepEqual(checkoutRootOf(path.join(repo, "scripts/lib")), { root: repo });
  });

  it("is the superproject's root from inside the t3code submodule", () => {
    assert.deepEqual(checkoutRootOf(path.join(repo, "t3code")), { root: repo });
    assert.deepEqual(checkoutRootOf(path.join(repo, "t3code/apps")), { root: repo });
  });

  it("gives a reason outside any git checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-guard-"));
    try {
      assert.deepEqual(checkoutRootOf(dir), { reason: `${dir} is not in a git checkout` });
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("gives a reason for a directory that does not exist", () => {
    const dir = path.join(os.tmpdir(), "workspace-guard-missing", "x");
    assert.deepEqual(checkoutRootOf(dir), { reason: `${dir} does not exist` });
  });

  it("gives a reason when git cannot run", () => {
    const result = checkoutRootOf(repo, "git-that-does-not-exist");
    assert.ok("reason" in result && result.reason.startsWith("git could not run"), JSON.stringify(result));
  });
});
