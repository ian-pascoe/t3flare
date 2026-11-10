import { describe, expect, it } from "vitest";

import { fromWorkspace, fromWorkspaceText, isUnderW, toWorkspace } from "./index.ts";

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
