// Copied from cloudpid@ae5a7b73:packages/computer-env/src/container-paths.test.ts.
import { describe, expect, it } from "vitest";
import { isContainerOnly, withHarnessKept } from "./container-paths.ts";

/** A launch's Container-only paths: some built-in ones, then an Environment's own. */
const LAUNCH = ["**/node_modules", "/target", "/*/target", "**/.cache", "!**/keep/.cache"];

describe("Container-only paths", () => {
  it("are every path outside the Workspace, whatever the launch's patterns", () => {
    expect(isContainerOnly("/tmp/x.log", LAUNCH)).toBe(true);
    expect(isContainerOnly("/root/.npmrc", undefined)).toBe(true);
    expect(isContainerOnly("/workspaces/other", [])).toBe(true);
  });

  it("are never the Workspace root itself, nor any of its paths when the launch has no patterns", () => {
    expect(isContainerOnly("/workspace", LAUNCH)).toBe(false);
    expect(isContainerOnly("/workspace/repo/node_modules", undefined)).toBe(false);
  });

  it("are the Workspace's paths a pattern names, and everything below them", () => {
    expect(isContainerOnly("/workspace/repo/node_modules", LAUNCH)).toBe(true);
    expect(isContainerOnly("/workspace/repo/node_modules/effect/package.json", LAUNCH)).toBe(true);
    expect(isContainerOnly("/workspace/node_modules", LAUNCH)).toBe(true);
    expect(isContainerOnly("/workspace/repo/src/index.ts", LAUNCH)).toBe(false);
    expect(isContainerOnly("/workspace/repo/node_modules_old/x", LAUNCH)).toBe(false);
  });

  it("anchor a pattern starting with / at the Workspace root, with * matching one segment", () => {
    expect(isContainerOnly("/workspace/target/debug/app", LAUNCH)).toBe(true);
    expect(isContainerOnly("/workspace/repo/target/debug/app", LAUNCH)).toBe(true);
    expect(isContainerOnly("/workspace/repo/src/target/notes.md", LAUNCH)).toBe(false);
  });

  it("let the last pattern that covers a path decide, so a later ! takes a path back", () => {
    expect(isContainerOnly("/workspace/repo/.cache/x", LAUNCH)).toBe(true);
    expect(isContainerOnly("/workspace/repo/keep/.cache/x", LAUNCH)).toBe(false);
    expect(isContainerOnly("/workspace/a", ["!/a", "/a"])).toBe(true);
  });

  it("keep the harness's own directory synced whatever the Environment adds", () => {
    const launch = withHarnessKept(["**/node_modules", "/.t3flare", "**/tmp"]);

    expect(isContainerOnly("/workspace/.t3flare", launch)).toBe(false);
    expect(isContainerOnly("/workspace/.t3flare/tmp/tmp-1/out.log", launch)).toBe(false);
    expect(isContainerOnly("/workspace/.t3flare/uploads/s1/a.png", launch)).toBe(false);
    expect(isContainerOnly("/workspace/repo/tmp/x", launch)).toBe(true);
    expect(isContainerOnly("/workspace/repo/node_modules", launch)).toBe(true);
  });

  it("append the harness's patterns once, after the launch's", () => {
    expect(withHarnessKept(["!/.t3flare", "**/node_modules", "!/.t3flare/**"])).toEqual([
      "**/node_modules",
      "!/.t3flare",
      "!/.t3flare/**",
    ]);
  });
});
