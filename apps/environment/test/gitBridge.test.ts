// SPI-1186: t3's temporary git material (a commit draft's index and object directory, a review's index), made in the
// Environment's State directory, bridged into the Workspace's harness `tmp/` for the Container's git, and removed
// once t3's own copy is gone.
import { describe, expect, it } from "vitest";

import { makeGitBridge } from "../src/agents/gitBridge.ts";
import type { FsOp } from "../src/agents/rpc.ts";

const TMP = "/workspace/.t3flare/tmp";
const DRAFT = "/tmp/t3code-commit-index-abc";

/** A bridge over a fake State directory (`state`) and fake Workspaces' files, recording each file operation. */
const harness = (state: Map<string, "file" | "dir"> = new Map([[DRAFT, "dir"], [`${DRAFT}/index`, "file"], [`${DRAFT}/objects`, "dir"]])) => {
  const ops: Array<{ readonly id: string } & FsOp> = [];
  const files = new Map<string, Set<string>>();
  const logs: Array<Record<string, unknown>> = [];
  /** File operations the fake Workspace DO answers with an error, as the real one does (it does not throw). */
  const failing = new Set<string>();
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const bridge = makeGitBridge({
    fs: async (id, op) => {
      ops.push({ id, ...op });
      if (failing.has(`${op.op} ${op.path}`) || failing.has(op.op)) return { error: "EIO", message: "the Workspace refused" };
      const own = files.get(id) ?? new Set<string>();
      files.set(id, own);
      if (op.op === "readdir") {
        const names = [...own].filter((name) => name.startsWith(`${op.path}/`)).map((name) => name.slice(op.path.length + 1).split("/")[0]!);
        return { ok: [...new Set(names)].map((name) => ({ name, kind: "dir" })) };
      }
      if (op.op === "mkdir" || op.op === "write") own.add(op.path);
      // Deleting the entry being visited is safe in a Set's iteration.
      if (op.op === "remove") for (const name of own) if (name === op.path || name.startsWith(`${op.path}/`)) own.delete(name);
      return { ok: null };
    },
    // processRouter's rule, over the fake State directory.
    onT3Side: (path) => path.startsWith("/") && !path.startsWith("/w/") && (state.has(path) || (parentOf(path) !== "/" && state.has(parentOf(path)))),
    stateEntry: (path) => {
      const kind = state.get(path);
      return kind === undefined ? undefined : { kind };
    },
    readStateFile: (path) => new TextEncoder().encode(`index of ${path}`),
    log: (line) => logs.push(line),
  });
  return { bridge, ops, files, state, failing, logs };
};

const draftEnv = {
  GIT_INDEX_FILE: `${DRAFT}/index`,
  GIT_OBJECT_DIRECTORY: `${DRAFT}/objects`,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '"/workspace/repo/.git/objects"',
};

describe("the git bridge", () => {
  it("maps a GIT_OBJECT_DIRECTORY outside /w to a folder in the harness tmp/, made once per draft", async () => {
    const { bridge, ops } = harness();
    const env = await bridge.bridge("a", draftEnv);
    expect(env.GIT_OBJECT_DIRECTORY).toMatch(new RegExp(`^${TMP}/objects-[0-9a-f]{24}$`));
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe('"/workspace/repo/.git/objects"');
    const made = ops.filter((op) => op.op !== "readdir" && op.path.startsWith(env.GIT_OBJECT_DIRECTORY!));
    // A fresh folder, with a file in it so the Container's copy has it even if empty folders do not travel.
    expect(made.map((op) => op.op)).toEqual(["remove", "mkdir", "write"]);
    ops.splice(0);
    // The draft's later commands reuse it: no file operation.
    expect(await bridge.bridge("a", draftEnv)).toEqual(env);
    expect(ops).toEqual([]);
  });

  it("gives each draft and each Workspace its own folder", async () => {
    const { bridge, state } = harness();
    state.set("/tmp/t3code-commit-index-def", "dir").set("/tmp/t3code-commit-index-def/objects", "dir");
    const one = await bridge.bridge("a", draftEnv);
    const other = await bridge.bridge("a", { GIT_OBJECT_DIRECTORY: "/tmp/t3code-commit-index-def/objects" });
    const elsewhere = await bridge.bridge("b", draftEnv);
    expect(new Set([one.GIT_OBJECT_DIRECTORY, other.GIT_OBJECT_DIRECTORY, elsewhere.GIT_OBJECT_DIRECTORY]).size).toBe(3);
  });

  it("bridges GIT_INDEX_FILE as before: t3's copy written once to index-<digest>/index", async () => {
    const { bridge, ops } = harness();
    const env = await bridge.bridge("a", { GIT_INDEX_FILE: `${DRAFT}/index` });
    // The digest is SHA-256 of `<id>\0<t3 path>`, its first 12 bytes in hex (unchanged since step 2a).
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`a\0${DRAFT}/index`)))]
      .slice(0, 12)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(env).toEqual({ GIT_INDEX_FILE: `${TMP}/index-${digest}/index` });
    const own = ops.filter((op) => op.op !== "readdir");
    expect(own.map((op) => [op.op, op.path])).toEqual([
      ["remove", `${TMP}/index-${digest}`],
      ["mkdir", `${TMP}/index-${digest}`],
      ["write", `${TMP}/index-${digest}/index`],
    ]);
    expect(new TextDecoder().decode((own[2] as Extract<FsOp, { op: "write" }>).data as Uint8Array)).toBe(`index of ${DRAFT}/index`);
    ops.splice(0);
    expect(await bridge.bridge("a", { GIT_INDEX_FILE: `${DRAFT}/index` })).toEqual(env);
    expect(ops).toEqual([]);
  });

  it("leaves Workspace paths, relative paths and other variables alone", async () => {
    const { bridge, ops } = harness();
    const env = { GIT_INDEX_FILE: "/workspace/repo/.git/index", GIT_OBJECT_DIRECTORY: "objects", GIT_OPTIONAL_LOCKS: "0" };
    expect(await bridge.bridge("a", env)).toEqual(env);
    expect(await bridge.bridge("a", { GIT_INDEX_FILE: "/w/a/.git/index" })).toEqual({ GIT_INDEX_FILE: "/w/a/.git/index" });
    expect(ops).toEqual([]);
  });

  it("removes a draft's index and object folder once t3's own temporary directory is gone, and never an in-flight one", async () => {
    const { bridge, files, state } = harness();
    state.set("/tmp/t3code-commit-index-def", "dir").set("/tmp/t3code-commit-index-def/objects", "dir");
    const ended = await bridge.bridge("a", draftEnv);
    const inFlight = await bridge.bridge("a", { GIT_OBJECT_DIRECTORY: "/tmp/t3code-commit-index-def/objects" });
    expect(await bridge.reap()).toEqual([]);
    // t3's scope ends: its temporary directory is removed from the State directory.
    for (const path of state.keys()) if (path.startsWith(DRAFT)) state.delete(path);
    const removed = await bridge.reap();
    expect(removed.toSorted()).toEqual([ended.GIT_INDEX_FILE!.replace(/\/index$/, ""), ended.GIT_OBJECT_DIRECTORY!].toSorted());
    const left = [...files.get("a")!];
    expect(left.some((path) => path.startsWith(ended.GIT_OBJECT_DIRECTORY!))).toBe(false);
    expect(left.some((path) => path.startsWith(ended.GIT_INDEX_FILE!.replace(/\/index$/, "")))).toBe(false);
    expect(left.some((path) => path.startsWith(inFlight.GIT_OBJECT_DIRECTORY!))).toBe(true);
    expect(bridge.live()).toEqual([{ id: "a", t3Path: "/tmp/t3code-commit-index-def/objects", bridged: inFlight.GIT_OBJECT_DIRECTORY }]);
    expect(await bridge.reap()).toEqual([]);
  });

  it("follows the draft's directory when t3 made no index file (a repo with no index yet)", async () => {
    const { bridge, state } = harness(new Map([[DRAFT, "dir"], [`${DRAFT}/objects`, "dir"]]));
    await bridge.bridge("a", draftEnv);
    expect(await bridge.reap()).toEqual([]);
    state.clear();
    expect(await bridge.reap()).toHaveLength(2);
  });

  it("sweeps a Workspace's leftover bridged folders on its first draft, and nothing else in tmp/", async () => {
    const { bridge, files } = harness();
    // Left by an earlier isolate (the map is in memory), beside the Workspace's own bundles.
    files.set("a", new Set([`${TMP}/index-000000000000000000000000/index`, `${TMP}/objects-111111111111111111111111/info/t3flare-draft`, `${TMP}/seed.bundle`, `${TMP}/wt-x.bundle`]));
    const env = await bridge.bridge("a", draftEnv);
    await bridge.settled();
    const left = [...files.get("a")!];
    expect(left.some((path) => path.includes("000000000000000000000000") || path.includes("111111111111111111111111"))).toBe(false);
    expect(left).toEqual(expect.arrayContaining([`${TMP}/seed.bundle`, `${TMP}/wt-x.bundle`, env.GIT_INDEX_FILE]));
    expect(left.some((path) => path.startsWith(env.GIT_OBJECT_DIRECTORY!))).toBe(true);
  });

  it("fails a command whose folder the Workspace refused, and makes it again on the draft's next command", async () => {
    const { bridge, failing, ops } = harness();
    failing.add("write");
    await expect(bridge.bridge("a", draftEnv)).rejects.toThrow(/write .* EIO/);
    // Not registered: nothing live, so nothing points git at a folder that is not there.
    expect(bridge.live()).toEqual([]);
    failing.clear();
    ops.splice(0);
    const env = await bridge.bridge("a", draftEnv);
    expect(env.GIT_OBJECT_DIRECTORY).toMatch(new RegExp(`^${TMP}/objects-`));
    expect(ops.filter((op) => op.op === "write").map((op) => op.path)).toEqual(expect.arrayContaining([env.GIT_INDEX_FILE, `${env.GIT_OBJECT_DIRECTORY}/info/t3flare-draft`]));
    expect(bridge.live()).toHaveLength(2);
  });

  it("fails on a refused mkdir too", async () => {
    const { bridge, failing } = harness();
    failing.add("mkdir");
    await expect(bridge.bridge("a", { GIT_OBJECT_DIRECTORY: `${DRAFT}/objects` })).rejects.toThrow(/mkdir .* EIO/);
    expect(bridge.live()).toEqual([]);
  });

  it("keeps a bridge whose folder could not be removed, logs it, and removes it at the next reap", async () => {
    const { bridge, failing, files, logs, state } = harness();
    const env = await bridge.bridge("a", { GIT_OBJECT_DIRECTORY: `${DRAFT}/objects` });
    state.clear();
    failing.add(`remove ${env.GIT_OBJECT_DIRECTORY}`);
    expect(await bridge.reap()).toEqual([]);
    expect(bridge.live()).toHaveLength(1);
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ t3flare: "git-bridge-reap-failed", folder: env.GIT_OBJECT_DIRECTORY })]));
    failing.clear();
    expect(await bridge.reap()).toEqual([env.GIT_OBJECT_DIRECTORY]);
    expect(bridge.live()).toEqual([]);
    expect([...files.get("a")!].some((path) => path.startsWith(env.GIT_OBJECT_DIRECTORY!))).toBe(false);
  });
});
