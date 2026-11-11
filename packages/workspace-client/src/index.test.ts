import { describe, expect, it } from "vitest";

import { fromWorkspace, fromWorkspaceText, isAnyWorkspaceId, isUnderW, isWorkspaceId, isWorktreeId, toWorkspace, worktreeDirOf } from "./index.ts";

describe("path translation", () => {
  it("maps /w/<id>/… to the repo inside the Workspace and back", () => {
    expect(toWorkspace("/w/fixture/src/a.ts")).toEqual({ id: "fixture", inner: "/workspace/repo/src/a.ts" });
    expect(toWorkspace("/w/fixture")).toEqual({ id: "fixture", inner: "/workspace/repo" });
    expect(toWorkspace("/w/fixture/")).toEqual({ id: "fixture", inner: "/workspace/repo" });
    expect(toWorkspace("/w")).toBeNull();
    expect(toWorkspace("/w/../etc")).toBeNull();
    expect(toWorkspace("/w/fixture/../../etc/passwd")).toBeNull();
    expect(toWorkspace("/t3/home")).toBeNull();
    expect(fromWorkspace("fixture", "/workspace/repo/src/a.ts")).toBe("/w/fixture/src/a.ts");
    expect(fromWorkspace("fixture", "/workspace/repo")).toBe("/w/fixture");
    expect(fromWorkspace("fixture", "/workspace/.t3flare/x")).toBe("/workspace/.t3flare/x");
  });
  it("rewrites git's printed paths", () => {
    expect(fromWorkspaceText("f", "/workspace/repo\n/workspace/repo/.git\n")).toBe("/w/f\n/w/f/.git\n");
    expect(fromWorkspaceText("f", "/workspace/repository")).toBe("/workspace/repository");
  });
  it("knows /w paths", () => {
    expect(isUnderW("/w")).toBe(true);
    expect(isUnderW("/w/x/y")).toBe(true);
    expect(isUnderW("/wx")).toBe(false);
  });
});

describe("worktree Workspaces (step 2b)", () => {
  it("are addressed by their path below /w, `.wt/<project dir>/<dir>`", () => {
    expect(toWorkspace("/w/.wt/fixture/feature-x-0123456789abcdef/src/a.ts")).toEqual({
      id: ".wt/fixture/feature-x-0123456789abcdef",
      inner: "/workspace/repo/src/a.ts",
    });
    expect(toWorkspace("/w/.wt/fixture/dir")).toEqual({ id: ".wt/fixture/dir", inner: "/workspace/repo" });
    expect(fromWorkspace(".wt/fixture/dir", "/workspace/repo/a")).toBe("/w/.wt/fixture/dir/a");
    expect(fromWorkspaceText(".wt/p/d", "worktree /workspace/repo\n")).toBe("worktree /w/.wt/p/d\n");
  });

  it("are not the directories above them, and never escape", () => {
    expect(toWorkspace("/w/.wt")).toBeNull();
    expect(toWorkspace("/w/.wt/fixture")).toBeNull();
    expect(toWorkspace("/w/.wt/.hidden/dir")).toBeNull();
    expect(toWorkspace("/w/.wt/fixture/..")).toBeNull();
    expect(worktreeDirOf("/w/.wt")).toEqual({ project: null });
    expect(worktreeDirOf("/w/.wt/fixture/")).toEqual({ project: "fixture" });
    expect(worktreeDirOf("/w/.wt/fixture/dir")).toBeNull();
    expect(worktreeDirOf("/w/fixture")).toBeNull();
  });

  it("take any one segment t3 makes from a branch name", () => {
    expect(isWorktreeId(".wt/p/feat-ü-ß-0123456789abcdef")).toBe(true);
    expect(isWorktreeId(".wt/p/a b")).toBe(true);
    expect(isWorktreeId(".wt/p/..")).toBe(false);
    expect(isWorktreeId(".wt/p/a\nb")).toBe(false);
    expect(isWorktreeId(`.wt/p/${"x".repeat(101)}`)).toBe(false);
    expect(isWorktreeId(".wt/p")).toBe(false);
    expect(isWorkspaceId(".wt")).toBe(false);
    expect(isAnyWorkspaceId("fixture")).toBe(true);
  });
});
