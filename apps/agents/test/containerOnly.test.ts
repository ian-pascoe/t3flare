// @effect-diagnostics nodeBuiltinImport:off
// Container-only submodules (the prod bug of 2026-11-11): the patterns a Container starts with, and the backend made
// again when they change.
import * as fs from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTAINER_IGNORE } from "../src/workspace/constants.ts";
import { containerPatterns, ContainerOnlyBackend, type PatternedBackend, submoduleDirsScript, submodulePaths } from "../src/workspace/containerOnly.ts";

describe("the patterns a Container starts with", () => {
  it("names t3flare's own submodule from its .gitmodules", () => {
    const gitmodules = fs.readFileSync(join(import.meta.dirname, "../../../.gitmodules"), "utf8");
    expect(submodulePaths(gitmodules)).toEqual(["t3code"]);
  });

  it("reads every submodule's path, quoted or nested, once", () => {
    const text = '[submodule "a"]\n\tpath = vendor/a\n\turl = x\n[submodule "b"]\n  path = "libs/b"\n[submodule "a2"]\n\tpath = vendor/a\n';
    expect(submodulePaths(text)).toEqual(["vendor/a", "libs/b"]);
  });

  it("keeps submodules and their git directories on the Container's disk, before the harness's re-includes", () => {
    const patterns = containerPatterns(CONTAINER_IGNORE, ["t3code", "vendor/a", "we,ird", "../escape", "glob*"]);
    expect(patterns.slice(-5)).toEqual(["/repo/.git/modules", "/repo/t3code/**", "/repo/vendor/a/**", "!/.t3flare", "!/.t3flare/**"]);
    expect(patterns.filter((pattern) => /we,ird|escape|glob/.test(pattern))).toEqual([]);
  });

  it("makes the submodules' empty directories a fresh Container lacks, and nothing else", () => {
    expect(submoduleDirsScript(containerPatterns(CONTAINER_IGNORE, ["t3code", "vendor/a"]))).toBe(
      "[ -e /workspace/repo/.git ] && mkdir -p -- '/workspace/repo/t3code' '/workspace/repo/vendor/a' 2>/dev/null\n",
    );
    expect(submoduleDirsScript(containerPatterns(CONTAINER_IGNORE, []))).toBe("");
  });

  it("a repo without submodules still keeps `.git/modules` local", () => {
    expect(containerPatterns(CONTAINER_IGNORE, [])).toEqual([...CONTAINER_IGNORE.slice(0, -2), "/repo/.git/modules", ...CONTAINER_IGNORE.slice(-2)]);
  });
});

describe("the Container backend made again when the patterns change", () => {
  const harness = (needed: Array<ReadonlyArray<string>>, failFirst?: string) => {
    const made: Array<ReadonlyArray<string>> = [];
    const connects: Array<ReadonlyArray<string>> = [];
    let stops = 0;
    let failures = failFirst === undefined ? 0 : 1;
    const backend = new ContainerOnlyBackend({
      initial: ["/a"],
      patterns: () => Promise.resolve(needed.shift() ?? ["/a"]),
      stop: () => {
        stops++;
        return Promise.resolve();
      },
      make: (patterns): PatternedBackend => {
        made.push(patterns);
        return {
          id: "container-shell",
          type: "cloudflare-container",
          description: "a container",
          handleFetch: () => Promise.resolve(new Response(patterns.join(","))),
          connect: () => {
            if (failures > 0) {
              failures--;
              const error = new Error("Container MOUNT_IGNORE does not match `ignore`");
              error.name = failFirst!;
              return Promise.reject(error);
            }
            connects.push(patterns);
            return Promise.resolve({ rpc: {} as never, close: () => Promise.resolve() });
          },
        };
      },
    });
    return { backend, made, connects, stops: () => stops };
  };

  it("connects with the patterns each start needs, making a backend only when they change", async () => {
    const h = harness([["/a"], ["/a", "/repo/t3code"], ["/a", "/repo/t3code"]]);
    expect(h.backend.id).toBe("container-shell");
    for (let at = 0; at < 3; at++) await h.backend.connect({} as never);
    expect(h.connects).toEqual([["/a"], ["/a", "/repo/t3code"], ["/a", "/repo/t3code"]]);
    expect(h.made).toEqual([["/a"], ["/a", "/repo/t3code"]]);
    expect(h.backend.patterns).toEqual(["/a", "/repo/t3code"]);
    expect(await (await h.backend.handleFetch(new Request("http://x/"))).text()).toBe("/a,/repo/t3code");
  });

  it("a running Container started with other patterns is stopped and started again, once", async () => {
    const h = harness([["/a", "/b"]], "ContainerIgnoreMismatchError");
    await h.backend.connect({} as never);
    expect(h.stops()).toBe(1);
    expect(h.connects).toEqual([["/a", "/b"]]);
  });

  it("any other connect failure is the caller's", async () => {
    const h = harness([["/a"]], "WorkspaceTransportError");
    await expect(h.backend.connect({} as never)).rejects.toThrow(/MOUNT_IGNORE/);
    expect(h.stops()).toBe(0);
  });
});
