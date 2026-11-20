// The workspace guard's decision (SPI-1290): `node --test`, so the root scripts need no test dependency.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { checkoutRootOf, workspaceGuard } from "./workspaceGuard.ts";

const repo = fs.realpathSync(path.resolve(import.meta.dirname, "../.."));

describe("workspaceGuard", () => {
  it("allows a shell without NPM_CONFIG_WORKSPACE_DIR, or with it empty", () => {
    assert.deepEqual(workspaceGuard(undefined, "/src/t3flare/.worktrees/x"), { ok: true });
    assert.deepEqual(workspaceGuard("", "/src/t3flare/.worktrees/x"), { ok: true });
  });

  it("allows a workspace dir that is the checkout's root", () => {
    assert.deepEqual(workspaceGuard("/src/t3flare/.worktrees/x", "/src/t3flare/.worktrees/x"), { ok: true });
  });

  it("refuses another checkout's workspace dir, naming both paths and the fix", () => {
    const decision = workspaceGuard("/src/t3flare", "/src/t3flare/.worktrees/x");
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.match(decision.message, /NPM_CONFIG_WORKSPACE_DIR is \/src\/t3flare\b/);
    assert.match(decision.message, /checkout at \/src\/t3flare\/\.worktrees\/x\b/);
    assert.match(decision.message, /export NPM_CONFIG_WORKSPACE_DIR=\/src\/t3flare\/\.worktrees\/x$/m);
  });

  it("allows a command typed outside any git checkout, which it cannot judge", () => {
    assert.deepEqual(workspaceGuard("/src/t3flare", undefined), { ok: true });
  });
});

describe("checkoutRootOf", () => {
  it("is the checkout's root from anywhere in it", () => {
    assert.equal(checkoutRootOf(repo), repo);
    assert.equal(checkoutRootOf(path.join(repo, "scripts/lib")), repo);
  });

  it("is the superproject's root from inside the t3code submodule", () => {
    assert.equal(checkoutRootOf(path.join(repo, "t3code")), repo);
    assert.equal(checkoutRootOf(path.join(repo, "t3code/apps")), repo);
  });

  it("is undefined outside any git checkout", () => {
    assert.equal(checkoutRootOf(path.parse(repo).root), undefined);
  });
});
