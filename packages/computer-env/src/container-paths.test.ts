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

  it("read a pattern's slashes at either end as one", () => {
    expect(isContainerOnly("/workspace/target/x", ["///target///"])).toBe(true);
    expect(isContainerOnly("/workspace/repo/target/x", ["///target///"])).toBe(false);
    expect(isContainerOnly("/workspace/a", ["/a", "!//a//"])).toBe(false);
    expect(isContainerOnly("/workspace/a", ["////"])).toBe(false);
  });

  it("compile a pattern with a long run of slashes inside it in linear time", () => {
    // A run of slashes inside a pattern becomes that many literal `/`s in its regex, which stops compiling past about
    // 32_000 (V8's "Regular expression too large"): too small for the old quadratic trim to take 10s alone (~1.3s), and
    // compiling such a regex costs ~50ms itself, so a fixed bound would flake on a loaded runner. The guard is relative:
    // nine such patterns, against compiling and running the same nine regexes with no trim. A loaded runner slows both
    // alike; the old trim made it ~25 times slower. One round can still land a spike on one side only (seen under a
    // full `pnpm run check`), so each side keeps its fastest of three rounds, each with patterns of its own: V8 caches
    // a compiled regex by its source, and a repeat would time the cache.
    const round = (index: number) => {
      const patterns = Array.from({ length: 9 }, (_, each) => `a${"/".repeat(30_000)}${index}-${each}`);
      const baselineStarted = performance.now();
      for (const pattern of patterns) new RegExp(`^${pattern}$`).test("a/b");
      const baseline = Math.max(performance.now() - baselineStarted, 1);
      const started = performance.now();
      expect(isContainerOnly("/workspace/a/b", patterns)).toBe(false);
      return { baseline, took: performance.now() - started };
    };
    const rounds = [0, 1, 2].map(round);

    expect(Math.min(...rounds.map((each) => each.took))).toBeLessThan(Math.min(...rounds.map((each) => each.baseline)) * 8);
  });
});
