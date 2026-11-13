// The Workspace's repo read and written with isomorphic-git (ADR-0009 items 1–2; step 2a plan, M3): checkpoints
// (capture as a commit of the working tree under a ref, with HEAD as its parent, as t3's `captureCheckpoint` makes),
// the trees a checkpoint diff compares, and the facts the stale git reads are patched with (`./staleReads.ts`). Written
// against an isomorphic-git file system, so the Node tests run it on a real repo next to real git.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as git from "isomorphic-git";

import type { RepoFacts } from "./staleReads.ts";
import { asOutput, byPath, type FileChange, fileNumstat, filePatch, treeChanges, type TreeEntry } from "./gitPatch.ts";

export type GitFs = git.PromiseFsClient;

/** isomorphic-git's parse cache, shared by the calls of one operation. */
export type GitCache = object;

export interface Repo {
  readonly fs: GitFs;
  readonly dir: string;
  readonly cache: GitCache;
  /**
   * The sizes of the files under `dir` (the Workspace DO reads them from computer's VFS in one query). Absent, the guard
   * does not check file sizes.
   */
  readonly fileSizes?: () => { readonly largest: number; readonly worktreeBytes: number };
}

/** The most tracked files the DO handles itself (cloudpid's guard); past it, a capture needs the Container's git. */
export const MAX_TRACKED_FILES = 2_000;
/** The most bytes of packs the DO reads itself. */
export const MAX_PACK_BYTES = 16 * 1024 * 1024;
/**
 * The largest file the DO's git reads itself (SPI-1050). isomorphic-git holds a whole file, and a capture a few copies of
 * it, so peak memory runs at 5–8 times the file: about 33 MiB for 4 MiB, against the isolate's 128 MB (a 100 MiB file
 * took 400+ MiB). Past it, a capture uses the Container's git and a stale read gets its last answer.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/**
 * The most bytes of working-tree files the DO's git reads itself (SPI-1050 review): `statusMatrix` walks concurrently
 * and holds the files it hashes at once (30 modified 4 MiB files peaked at 84 MiB), and a capture may hash every
 * tracked file whose stat the index does not match.
 */
export const MAX_WORKTREE_BYTES = 32 * 1024 * 1024;

/** t3's checkpoint commit identity (`GitVcsDriver.checkpoints.captureCheckpoint`). */
const CHECKPOINT_AUTHOR = { name: "T3 Code", email: "t3code@users.noreply.github.com" } as const;

const isNotFound = (cause: unknown): boolean => {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === "NotFoundError" || code === "ENOENT";
};

/** The commit `ref` names (a ref, `HEAD`, or an id; `^{commit}` allowed), or null when there is none. */
export const resolveCommit = async (repo: Repo, ref: string): Promise<string | null> => {
  const name = ref.endsWith("^{commit}") ? ref.slice(0, -"^{commit}".length) : ref;
  try {
    const oid = /^[0-9a-f]{40}$/.test(name) ? name : await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: name });
    const read = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache }).catch(() => null);
    if (read !== null) return oid;
    const tag = await git.readTag({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache }).catch(() => null);
    return tag !== null && tag.tag.type === "commit" ? tag.tag.object : null;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
};

/**
 * The id `ref` names (a ref, `HEAD`, or an id; `^{commit}` allowed), or null when there is none, reading refs only and
 * no object: unlike `resolveCommit`, it does not check that the id is a commit, nor peel a tag.
 */
export const resolveRefOnly = async (repo: Repo, ref: string): Promise<string | null> => {
  const name = ref.endsWith("^{commit}") ? ref.slice(0, -"^{commit}".length) : ref;
  if (/^[0-9a-f]{40}$/.test(name)) return name;
  try {
    return await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: name });
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
};

/** The resolver for a repo within the guard (`resolveCommit`) or above it (`resolveRefOnly`). */
export const resolverFor =
  (repo: Repo, within: boolean) =>
  (ref: string): Promise<string | null> =>
    within ? resolveCommit(repo, ref) : resolveRefOnly(repo, ref);

/** Every file of commit `oid`'s tree, by path. */
export const flatTree = async (repo: Repo, commit: string | null): Promise<Map<string, TreeEntry>> => {
  const out = new Map<string, TreeEntry>();
  if (commit === null) return out;
  const { commit: parsed } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid: commit, cache: repo.cache });
  const walk = async (tree: string, prefix: string): Promise<void> => {
    const { tree: entries } = await git.readTree({ fs: repo.fs, dir: repo.dir, oid: tree, cache: repo.cache });
    for (const entry of entries) {
      const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`;
      if (entry.type === "tree") await walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  await walk(parsed.tree, "");
  return out;
};

/** The index's files, by path (stage 0 only); its submodules' paths (gitlinks) go to `gitlinks` when given. */
export const indexEntries = async (repo: Repo, gitlinks?: Set<string>): Promise<Map<string, TreeEntry>> => {
  const out = new Map<string, TreeEntry>();
  await git.walk({
    fs: repo.fs,
    dir: repo.dir,
    cache: repo.cache,
    trees: [git.STAGE()],
    map: async (path, [entry]) => {
      if (entry === null || entry === undefined || path === ".") return true;
      const type = await entry.type();
      if (type === "commit") gitlinks?.add(path);
      if (type !== "blob") return true;
      const mode = (await entry.mode()).toString(8);
      out.set(path, { mode: mode.padStart(6, "0"), oid: await entry.oid() });
      return true;
    },
  });
  return out;
};

/**
 * Whether the repo is within the guard: few enough tracked files, and its packs, its working tree and every file small
 * enough for the DO. Above it, read no object in the DO (`resolveRef`, not `resolveCommit`): isomorphic-git loads a whole
 * pack to read one object from it.
 */
export const withinGuard = async (repo: Repo): Promise<boolean> => {
  if (repo.fileSizes !== undefined) {
    const sizes = repo.fileSizes();
    if (sizes.largest > MAX_FILE_BYTES || sizes.worktreeBytes > MAX_WORKTREE_BYTES) return false;
  }
  const tracked = await git.listFiles({ fs: repo.fs, dir: repo.dir, cache: repo.cache });
  if (tracked.length > MAX_TRACKED_FILES) return false;
  const packDir = `${repo.dir}/.git/objects/pack`;
  let bytes = 0;
  try {
    for (const name of (await repo.fs.promises.readdir(packDir)) as Array<string>) {
      if (name.endsWith(".pack")) bytes += ((await repo.fs.promises.stat(`${packDir}/${name}`)) as { size: number }).size;
    }
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
  return bytes <= MAX_PACK_BYTES;
};

/** The working tree's side of a file: its mode and bytes (a symlink's target as its bytes), or null when absent. */
export const worktreeFile = async (repo: Repo, path: string): Promise<{ readonly mode: string; readonly bytes: Uint8Array } | null> => {
  const absolute = `${repo.dir}/${path}`;
  try {
    const stat = (await repo.fs.promises.lstat(absolute)) as { mode: number; isSymbolicLink(): boolean; isDirectory(): boolean };
    if (stat.isDirectory()) return null;
    if (stat.isSymbolicLink()) {
      const target = (await repo.fs.promises.readlink!(absolute)) as string;
      return { mode: "120000", bytes: new TextEncoder().encode(target) };
    }
    const data = (await repo.fs.promises.readFile(absolute)) as Uint8Array;
    return { mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644", bytes: new Uint8Array(data) };
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
};

/**
 * What `git add -A` would stage on a fresh index from HEAD: HEAD's files, each changed one as the working tree has it,
 * the deleted ones gone, and the untracked files that are not ignored added. `write` stores the new blobs.
 */
export const worktreeTree = async (repo: Repo, head: string | null, write: boolean): Promise<Map<string, TreeEntry>> => {
  const tree = await flatTree(repo, head);
  const rows = await git.statusMatrix({ fs: repo.fs, dir: repo.dir, cache: repo.cache, refresh: false, ...(head === null ? { ref: "HEAD" } : {}) });
  for (const [path, , workdir] of rows) {
    if (workdir === 0) {
      tree.delete(path);
      continue;
    }
    if (workdir === 1) continue;
    const file = await worktreeFile(repo, path);
    if (file === null) {
      tree.delete(path);
      continue;
    }
    const oid = write
      ? await git.writeBlob({ fs: repo.fs, dir: repo.dir, blob: file.bytes })
      : (await git.hashBlob({ object: file.bytes })).oid;
    tree.set(path, { mode: file.mode, oid });
  }
  return tree;
};

/** Writes the trees of `files` (by path) bottom-up and returns the root tree's id. */
export const writeTrees = async (repo: Repo, files: ReadonlyMap<string, TreeEntry>): Promise<string> => {
  type Dir = { files: Array<{ name: string; entry: TreeEntry }>; dirs: Map<string, Dir> };
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ name: parts.at(-1)!, entry });
  }
  const write = async (dir: Dir): Promise<string> => {
    const tree: Array<{ mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" }> = [];
    for (const [name, child] of dir.dirs) tree.push({ mode: "040000", path: name, oid: await write(child), type: "tree" });
    for (const { name, entry } of dir.files) {
      tree.push({ mode: entry.mode, path: name, oid: entry.oid, type: entry.mode === "160000" ? "commit" : "blob" });
    }
    return git.writeTree({ fs: repo.fs, dir: repo.dir, tree });
  };
  return write(root);
};

/** Captures the working tree as a commit under `ref`, HEAD its parent (t3's checkpoint). Returns the commit. */
export const captureCheckpoint = async (repo: Repo, ref: string, nowSeconds: number): Promise<string> => {
  const head = await resolveCommit(repo, "HEAD");
  const files = await worktreeTree(repo, head, true);
  const tree = await writeTrees(repo, files);
  const person = { ...CHECKPOINT_AUTHOR, timestamp: nowSeconds, timezoneOffset: 0 };
  const commit = await git.writeCommit({
    fs: repo.fs,
    dir: repo.dir,
    commit: { message: `t3 checkpoint ref=${ref}\n`, tree, parent: head === null ? [] : [head], author: person, committer: person },
  });
  await git.writeRef({ fs: repo.fs, dir: repo.dir, ref, value: commit, force: true });
  return commit;
};

/** The parents of a checkpoint commit (HEAD when it was captured). */
export const parentsOf = async (repo: Repo, commit: string): Promise<ReadonlyArray<string>> =>
  (await git.readCommit({ fs: repo.fs, dir: repo.dir, oid: commit, cache: repo.cache })).commit.parent;

export const deleteRef = async (repo: Repo, ref: string): Promise<void> => {
  try {
    await git.deleteRef({ fs: repo.fs, dir: repo.dir, ref });
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
};

/** git's diff of two commits' trees, as t3's `diffCheckpoints` asks for it (patch, or numstat with `-z`). */
export const diffCommits = async (
  repo: Repo,
  from: string,
  to: string,
  options: { readonly format: "patch" | "numstat"; readonly filePaths?: ReadonlyArray<string> | undefined; readonly maxOutputBytes?: number | undefined },
): Promise<string> => {
  const wanted = options.filePaths === undefined ? undefined : new Set(options.filePaths);
  const changes = treeChanges(await flatTree(repo, from), await flatTree(repo, to)).filter(
    (change) => wanted === undefined || wanted.has(change.oldPath) || wanted.has(change.newPath),
  );
  const blob = async (oid: string) => (await git.readBlob({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache })).blob;
  let out = "";
  const limit = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  for (const change of changes) {
    const full: FileChange = {
      oldPath: change.oldPath,
      newPath: change.newPath,
      old: change.old === null ? null : { ...change.old, bytes: await blob(change.old.oid) },
      new: change.new === null ? null : { ...change.new, bytes: await blob(change.new.oid) },
    };
    out += options.format === "numstat" ? fileNumstat(full) : filePatch(full);
    if (out.length >= limit) break;
  }
  return asOutput(out.length > limit ? out.slice(0, limit) : out);
};

export { byPath };

/** The facts the stale reads are patched with (`./staleReads.ts`), read once per patch; `base` is the diff's base commit. */
export const repoFacts = async (repo: Repo, base = "HEAD"): Promise<RepoFacts> => {
  const head = await resolveCommit(repo, base);
  const headTree = await flatTree(repo, head);
  const gitlinks = new Set<string>();
  const index = await indexEntries(repo, gitlinks);
  const trackedDirs = new Set<string>();
  for (const path of [...index.keys(), ...gitlinks]) {
    const parts = path.split("/");
    for (let at = 1; at < parts.length; at++) trackedDirs.add(parts.slice(0, at).join("/"));
  }
  const ignored = (path: string) => git.isIgnored({ fs: repo.fs, dir: repo.dir, filepath: path });
  return {
    facts: async (path) => {
      const file = await worktreeFile(repo, path);
      const worktree = file === null ? null : { ...file, oid: (await git.hashBlob({ object: file.bytes })).oid };
      return {
        head: headTree.get(path) ?? null,
        index: index.get(path) ?? null,
        worktree,
        ignored: index.has(path) || file === null ? false : await ignored(path),
      };
    },
    submodules: [...gitlinks],
    headBytes: async (oid) => (await git.readBlob({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache })).blob,
    trackedUnder: (dir) => trackedDirs.has(dir),
    untrackedUnder: async (dir) => {
      const out: Array<string> = [];
      const walk = async (relative: string): Promise<void> => {
        let names: Array<string>;
        try {
          names = (await repo.fs.promises.readdir(`${repo.dir}/${relative}`)) as Array<string>;
        } catch {
          return;
        }
        for (const name of names) {
          const path = `${relative}/${name}`;
          if (name === ".git" || gitlinks.has(path) || (await ignored(path))) continue;
          const stat = (await repo.fs.promises.lstat(`${repo.dir}/${path}`)) as { isDirectory(): boolean };
          if (stat.isDirectory()) await walk(path);
          else if (!index.has(path)) out.push(path);
        }
      };
      await walk(dir);
      return out;
    },
  };
};
