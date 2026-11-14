// @effect-diagnostics globalConsole:off
// t3's temporary git material, bridged into a Workspace (SPI-1186). t3 builds some git state in its own temp
// directory (the Environment's State directory), which the Container cannot see:
//
// - a commit draft (`GitVcsDriverCore.prepareCommitContext`): `GIT_INDEX_FILE` (a copy of the repo's index) and
//   `GIT_OBJECT_DIRECTORY` (an empty folder for the blobs its staging writes), in `t3code-commit-index-*`;
// - the review totals (`readUnifiedWorkingTreeReviewDiff`): `GIT_INDEX_FILE` alone, `t3code-review-index-*`.
//
// The first git command naming one gets a copy in the Workspace's harness `tmp/` (an index with t3's bytes, an object
// folder empty), and the variable points there; the draft's later commands reuse it, and from then on the Container's
// git owns it (t3 hands it back to git, never reads it). t3 removes its own copy when the draft's scope ends; the
// bridge then removes the Workspace's (`reap`), so a draft in flight keeps its folders. A Workspace's leftovers from an
// earlier isolate (the bridge's map is in memory) are swept on its first draft in this one.
import { HARNESS_ROOT } from "@t3flare/workspace-client";

import type { FsOp } from "./rpc.ts";

export interface GitBridgeDeps {
  /** One file operation on Workspace `id`'s files (never starts its Container). */
  readonly fs: (id: string, op: FsOp) => Promise<unknown>;
  /** The State directory's entry at a t3 path. */
  readonly stateEntry: (path: string) => { readonly kind: string } | undefined;
  readonly readStateFile: (path: string) => Uint8Array;
  readonly log?: (line: Record<string, unknown>) => void;
}

interface Bridge {
  readonly id: string;
  /** t3's path: the variable's value. */
  readonly t3Path: string;
  /** What shows t3's draft is still in flight: t3's path, or its folder when t3 made no file there. */
  readonly watch: string;
  /** The value git in the Container gets. */
  readonly value: string;
  /** The folder in the Workspace's harness `tmp/` this bridge made, removed with it. */
  readonly folder: string;
  /** Resolves once the folder is ready for git. */
  readonly ready: Promise<void>;
}

export const BRIDGE_TMP = `${HARNESS_ROOT}/tmp`;
/** The bridge's own folders in `tmp/`: `index-<digest>` and `objects-<digest>`. */
const BRIDGED_FOLDER = /^(index|objects)-[0-9a-f]{24}$/;

const digestOf = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

export const makeGitBridge = (deps: GitBridgeDeps) => {
  /** Whether a variable's value is t3's own: a path in the State directory, or a file t3 has yet to make in a folder there. */
  const onT3Side = (value: string | undefined): value is string =>
    value !== undefined && value.startsWith("/") && value !== "/w" && !value.startsWith("/w/") && (deps.stateEntry(value) ?? deps.stateEntry(parentOf(value))) !== undefined;

  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const bridges = new Map<string, Bridge>();
  const swept = new Map<string, Promise<void>>();
  const pending = new Set<Promise<unknown>>();

  const keyOf = (id: string, t3Path: string) => `${id}\0${t3Path}`;

  /** Removes this Workspace's bridged folders that no live bridge holds (left by an earlier isolate). */
  const sweep = async (id: string) => {
    const listed = (await deps.fs(id, { op: "readdir", path: BRIDGE_TMP }).catch(() => undefined)) as { ok?: ReadonlyArray<{ name: string }> } | undefined;
    const held = () => new Set([...bridges.values()].filter((entry) => entry.id === id).map((entry) => entry.folder));
    const stale = (listed?.ok ?? []).map((entry) => `${BRIDGE_TMP}/${entry.name}`).filter((folder) => BRIDGED_FOLDER.test(folder.slice(BRIDGE_TMP.length + 1)));
    // Checked against the live bridges at removal time: a draft that started meanwhile registered its folder first.
    const removed = stale.filter((folder) => !held().has(folder));
    await Promise.all(removed.map((folder) => deps.fs(id, { op: "remove", path: folder, options: { recursive: true, force: true } }).catch(() => undefined)));
    if (removed.length > 0) log({ t3flare: "git-bridge-swept", id, removed: removed.length });
  };

  const open = async (id: string, t3Path: string, kind: "index" | "objects"): Promise<Bridge> => {
    const key = keyOf(id, t3Path);
    const known = bridges.get(key);
    if (known !== undefined) return known;
    const name = await digestOf(key);
    // Another command of the same draft may have opened it while the digest was computed.
    const raced = bridges.get(key);
    if (raced !== undefined) return raced;
    const folder = `${BRIDGE_TMP}/${kind}-${name}`;
    const value = kind === "index" ? `${folder}/index` : folder;
    const watch = deps.stateEntry(t3Path) === undefined ? parentOf(t3Path) : t3Path;
    // Registered before anything is made, so a sweep never takes it.
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => (settle = resolve));
    const entry: Bridge = { id, t3Path, watch, value, folder, ready };
    bridges.set(key, entry);
    try {
      if (!swept.has(id)) swept.set(id, sweep(id).catch(() => undefined));
      await swept.get(id);
      await deps.fs(id, { op: "remove", path: folder, options: { recursive: true, force: true } });
      if (kind === "index") {
        await deps.fs(id, { op: "mkdir", path: folder, recursive: true });
        const state = deps.stateEntry(t3Path);
        if (state !== undefined && state.kind === "file") await deps.fs(id, { op: "write", path: value, data: deps.readStateFile(t3Path) });
      } else {
        // Empty, as t3 made it; the marker keeps the folder in the Container's copy of the Workspace's files.
        await deps.fs(id, { op: "mkdir", path: `${folder}/info`, recursive: true });
        await deps.fs(id, { op: "write", path: `${folder}/info/t3flare-draft`, data: `${t3Path}\n` });
      }
    } catch (error) {
      // Not made: the next command of the draft makes it again.
      bridges.delete(key);
      throw error;
    } finally {
      settle();
    }
    return entry;
  };

  return {
    /** `env` (already translated by `gitEnvOf`) with t3's temporary index and object directory bridged into Workspace `id`. */
    bridge: async (id: string, env: Record<string, string>): Promise<Record<string, string>> => {
      const out = { ...env };
      const index = env.GIT_INDEX_FILE;
      const objects = env.GIT_OBJECT_DIRECTORY;
      const opened = await Promise.all([
        onT3Side(index) ? open(id, index, "index") : undefined,
        onT3Side(objects) ? open(id, objects, "objects") : undefined,
      ]);
      // A command of the same draft that found the bridge opening waits for its folder.
      await Promise.all(opened.map((entry) => entry?.ready ?? Promise.resolve()));
      if (opened[0] !== undefined) out.GIT_INDEX_FILE = opened[0].value;
      if (opened[1] !== undefined) out.GIT_OBJECT_DIRECTORY = opened[1].value;
      return out;
    },

    /**
     * Removes the bridged folders of every draft whose t3 copy is gone (t3's scope ended), and forgets them; a draft
     * still in flight keeps its own. Answers the folders removed.
     */
    reap: async (): Promise<ReadonlyArray<string>> => {
      const ended = [...bridges.entries()].filter(([, entry]) => deps.stateEntry(entry.watch) === undefined);
      for (const [key] of ended) bridges.delete(key);
      const run = Promise.all(
        ended.map(async ([, entry]) => {
          await entry.ready;
          await deps.fs(entry.id, { op: "remove", path: entry.folder, options: { recursive: true, force: true } }).catch(() => undefined);
          return entry.folder;
        }),
      );
      pending.add(run);
      try {
        return await run;
      } finally {
        pending.delete(run);
      }
    },

    /** The live bridges, for the admin trace and tests. */
    live: () => [...bridges.values()].map((entry) => ({ id: entry.id, t3Path: entry.t3Path, bridged: entry.value })),

    /** Resolves when every reap and sweep started so far has finished (tests). */
    settled: async () => {
      await Promise.all([...pending, ...swept.values()]);
    },
  };
};

export type GitBridge = ReturnType<typeof makeGitBridge>;
