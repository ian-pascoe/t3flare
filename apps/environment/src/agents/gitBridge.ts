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
// bridge then removes the Workspace's (`reap`). A Workspace's leftovers from an earlier isolate (the bridge's map is in
// memory) are swept on its first draft in this one.
//
// What "in flight" means here is t3's scope, not git's process: a draft whose scope t3 ended early (interrupted) may
// still have a git command running in the Container when its folders go, and that command fails. Likewise the sweep
// cannot see the bridges of another isolate: during a deploy, an older isolate's live draft in the same Workspace can
// lose its folders to a newer isolate's first draft there.
import { HARNESS_ROOT } from "@t3flare/workspace-client";

import type { FsOp } from "./rpc.ts";

export interface GitBridgeDeps {
  /** One file operation on Workspace `id`'s files (never starts its Container); answers `{ ok }` or `{ error }`. */
  readonly fs: (id: string, op: FsOp) => Promise<unknown>;
  /** Whether a path is t3's own: one the Container cannot see (the same predicate `gitEnvOf` drops alternates by). */
  readonly onT3Side: (path: string) => boolean;
  /** The State directory's entry at a t3 path. */
  readonly stateEntry: (path: string) => { readonly kind: string } | undefined;
  readonly readStateFile: (path: string) => Uint8Array;
  /** Whether Workspace `id`'s files still exist (listed, not being deleted): a deleted one's bridges are forgotten. */
  readonly workspaceExists: (id: string) => boolean;
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
  /** Settles once the folder is ready for git; rejects when it could not be made. */
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

/** A file operation's answer that is not `{ ok }` (the Workspace DO answers errors, it does not throw them). */
const failureOf = (answer: unknown): string | undefined =>
  answer !== null && typeof answer === "object" && "ok" in answer ? undefined : `${(answer as { error?: string } | undefined)?.error ?? "no answer"}: ${(answer as { message?: string } | undefined)?.message ?? ""}`.trim();

export const makeGitBridge = (deps: GitBridgeDeps) => {
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const bridges = new Map<string, Bridge>();
  const reaping = new Set<string>();
  const swept = new Map<string, Promise<void>>();
  const pending = new Set<Promise<unknown>>();

  const keyOf = (id: string, t3Path: string) => `${id}\0${t3Path}`;
  const isT3Path = (value: string | undefined): value is string => value !== undefined && deps.onT3Side(value);

  /** One file operation that must succeed: throws git's kind of failure otherwise. */
  const must = async (id: string, op: FsOp) => {
    const failure = failureOf(await deps.fs(id, op));
    if (failure !== undefined) throw new Error(`t3flare: ${op.op} ${op.path} in Workspace ${id}: ${failure}`);
  };

  /** Removes a folder of Workspace `id`'s files (a missing one counts as removed); whether it is gone. */
  const removeFolder = async (id: string, path: string): Promise<boolean> =>
    failureOf(await deps.fs(id, { op: "remove", path, options: { recursive: true, force: true } }).catch((error: unknown) => ({ error: String(error) }))) === undefined;

  /**
   * Removes this Workspace's bridged folders that no live bridge of this isolate holds (left by an earlier isolate). It
   * cannot see another isolate's bridges: see the header.
   */
  const sweep = async (id: string) => {
    const listed = (await deps.fs(id, { op: "readdir", path: BRIDGE_TMP }).catch(() => undefined)) as { ok?: ReadonlyArray<{ name: string }> } | undefined;
    const held = () => new Set([...bridges.values()].filter((entry) => entry.id === id).map((entry) => entry.folder));
    const stale = (listed?.ok ?? []).map((entry) => `${BRIDGE_TMP}/${entry.name}`).filter((folder) => BRIDGED_FOLDER.test(folder.slice(BRIDGE_TMP.length + 1)));
    // Checked against the live bridges at removal time: a draft that started meanwhile registered its folder first.
    const removed = stale.filter((folder) => !held().has(folder));
    const results = await Promise.all(removed.map((folder) => removeFolder(id, folder)));
    if (removed.length > 0) log({ t3flare: "git-bridge-swept", id, removed: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length });
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
    let settle!: (error?: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => (settle = (error) => (error === undefined ? resolve() : reject(error))));
    // Waiters see the failure; nobody else must.
    ready.catch(() => undefined);
    const entry: Bridge = { id, t3Path, watch, value, folder, ready };
    bridges.set(key, entry);
    try {
      if (!swept.has(id)) swept.set(id, sweep(id).catch(() => undefined));
      await swept.get(id);
      if (!(await removeFolder(id, folder))) throw new Error(`t3flare: remove ${folder} in Workspace ${id} failed`);
      if (kind === "index") {
        await must(id, { op: "mkdir", path: folder, recursive: true });
        const state = deps.stateEntry(t3Path);
        if (state !== undefined && state.kind === "file") await must(id, { op: "write", path: value, data: deps.readStateFile(t3Path) });
      } else {
        // Empty, as t3 made it; the marker keeps the folder in the Container's copy of the Workspace's files.
        await must(id, { op: "mkdir", path: `${folder}/info`, recursive: true });
        await must(id, { op: "write", path: `${folder}/info/t3flare-draft`, data: `${t3Path}\n` });
      }
      settle();
    } catch (error) {
      // Not made: unregistered, so the next command of the draft makes it again; a partly made folder goes too (best
      // effort: one left behind is the next isolate's sweep's).
      // Removed before the entry goes, so a command of the draft arriving meanwhile joins the failing entry rather than
      // making a folder this remove would take.
      await removeFolder(id, folder);
      bridges.delete(key);
      settle(error);
      throw error;
    }
    return entry;
  };

  return {
    /** `env` (already translated by `gitEnvOf`) with t3's temporary index and object directory bridged into Workspace `id`. */
    bridge: async (id: string, env: Record<string, string>): Promise<Record<string, string>> => {
      const out = { ...env };
      const index = env.GIT_INDEX_FILE;
      const objects = env.GIT_OBJECT_DIRECTORY;
      const opened = await Promise.all([isT3Path(index) ? open(id, index, "index") : undefined, isT3Path(objects) ? open(id, objects, "objects") : undefined]);
      // A command of the same draft that found the bridge opening waits for its folder (and fails with it).
      await Promise.all(opened.map((entry) => entry?.ready ?? Promise.resolve()));
      if (opened[0] !== undefined) out.GIT_INDEX_FILE = opened[0].value;
      if (opened[1] !== undefined) out.GIT_OBJECT_DIRECTORY = opened[1].value;
      return out;
    },

    /**
     * Removes the bridged folders of every draft whose t3 copy is gone (t3's scope ended) and forgets them; a draft whose
     * scope is open keeps its own. A folder that could not be removed stays known, logged, for the next reap. Answers
     * the folders removed. "Ended" is t3's scope: see the header for an interrupted draft's git still running.
     */
    reap: async (): Promise<ReadonlyArray<string>> => {
      const ended = [...bridges.entries()].filter(([key, entry]) => !reaping.has(key) && deps.stateEntry(entry.watch) === undefined);
      for (const [key] of ended) reaping.add(key);
      const run = Promise.all(
        ended.map(async ([key, entry]) => {
          try {
            await entry.ready.catch(() => undefined);
            // A deleted Workspace's files went with it, and its DO must not be asked again.
            if (!deps.workspaceExists(entry.id)) {
              if (bridges.get(key) === entry) bridges.delete(key);
              return undefined;
            }
            if (await removeFolder(entry.id, entry.folder)) {
              if (bridges.get(key) === entry) bridges.delete(key);
              return entry.folder;
            }
            log({ t3flare: "git-bridge-reap-failed", id: entry.id, folder: entry.folder });
            return undefined;
          } finally {
            reaping.delete(key);
          }
        }),
      ).then((folders) => folders.filter((folder): folder is string => folder !== undefined));
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
