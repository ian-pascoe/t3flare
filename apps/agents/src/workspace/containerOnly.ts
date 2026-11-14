// Container-only paths (the prod bug of 2026-11-11): a repo's submodules live on its Container's disk alone, like
// `node_modules`, never in the Workspace DO's files. t3flare's own `t3code` submodule is 31,946 files: t3's worktree
// creation (`git submodule update --init --recursive`) and the agent checked it out, computer pulled every file into the
// DO (revision 37,474, minutes of sync), and the DO's later git work over them ran past its CPU limit.
//
// computer's Container backend takes its ignore patterns once, at the Container's start (`MOUNT_IGNORE`), so the
// backend is made again whenever the patterns a start needs differ: the static `CONTAINER_IGNORE`, the submodules'
// git directories (`.git/modules`), and each path `.gitmodules` names (read from the DO's files at each start).
// @effect-diagnostics asyncFunction:off
import type { WorkspaceBackend } from "@cloudflare/computer";

import { REPO_ROOT, WORKSPACE_ROOT } from "./constants.ts";

/** The repo, as computer's ignore patterns name it (from the mount root, `/workspace`). */
const REPO_PATTERN = REPO_ROOT.slice(WORKSPACE_ROOT.length);

/** The submodules' own repos (`git submodule` clones them under the superproject's `.git/modules`). */
export const SUBMODULE_GIT_DIRS = `${REPO_PATTERN}/.git/modules`;

/**
 * The repo's own linked worktrees' admin directories (parity G7): only t3's scratch checkouts, which live on the
 * Container's disk; their index and HEAD never reach the Workspace DO.
 */
export const WORKTREE_GIT_DIRS = `${REPO_PATTERN}/.git/worktrees`;

/** The paths a `.gitmodules` file names (`path = …` of each `[submodule "…"]`), in order, without duplicates. */
export const submodulePaths = (gitmodules: string): ReadonlyArray<string> => {
  const paths: Array<string> = [];
  for (const line of gitmodules.split(/\r?\n/)) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const path = match[1]!.replace(/^"(.*)"$/, "$1").replace(/^\/+|\/+$/g, "");
    if (path !== "" && !paths.includes(path)) paths.push(path);
  }
  return paths;
};

/**
 * computer's ignore pattern for a submodule at `path` (repo-relative): what is under it, not the directory itself, which
 * git checks out empty and wants to find (a Container started afresh without it sees the submodule as deleted, and the
 * worktree as dirty). Undefined when the pattern syntax cannot say it (glob characters, a comma, `.`/`..` segments):
 * that submodule then syncs as any directory does.
 */
export const submodulePattern = (path: string): string | undefined => {
  if (/[{}[\]?\\,*!]/.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return `${REPO_PATTERN}/${path}/**`;
};

/**
 * A script line making the submodules' (empty) directories in a Container that started without them: computer's
 * pattern keeps the directory itself local too, and git sees a submodule whose directory is missing as deleted. Its
 * exit status is not the command's: the command follows on its own line.
 */
export const submoduleDirsScript = (patterns: ReadonlyArray<string>): string => {
  const dirs = patterns.flatMap((pattern) =>
    pattern.startsWith(`${REPO_PATTERN}/`) && pattern.endsWith("/**") ? [`${WORKSPACE_ROOT}${pattern.slice(0, -3)}`] : [],
  );
  // Only in a repo: a clone starts by removing the repo, which a directory made here (computer mounts the Container's
  // own disk on it) would make fail.
  return dirs.length === 0 ? "" : `[ -e ${REPO_ROOT}/.git ] && mkdir -p -- ${dirs.map((dir) => `'${dir}'`).join(" ")} 2>/dev/null\n`;
};

/** The ignore patterns a Container starts with: the static ones, the submodules' git directories, then each submodule. */
export const containerPatterns = (base: ReadonlyArray<string>, submodules: ReadonlyArray<string>): ReadonlyArray<string> => {
  const extra = [SUBMODULE_GIT_DIRS, WORKTREE_GIT_DIRS, ...submodules.flatMap((path) => submodulePattern(path) ?? [])];
  // The base list ends with its re-includes (`!/.t3flare…`): the last matching pattern wins, so ours go before them.
  const firstInclude = base.findIndex((pattern) => pattern.startsWith("!"));
  const at = firstInclude === -1 ? base.length : firstInclude;
  return [...base.slice(0, at), ...extra.filter((pattern) => !base.includes(pattern)), ...base.slice(at)];
};

const samePatterns = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((pattern, at) => pattern === right[at]);

/** A backend computer can connect, made for one set of ignore patterns (computer's `ContainerBackend`). */
export interface PatternedBackend extends WorkspaceBackend {
  handleFetch(request: Request): Promise<Response>;
}

/**
 * The Workspace's Container backend under computer, made again for each start whose patterns differ. A running
 * Container started with other patterns (an older deploy's, or a `.gitmodules` that changed) is refused by computer
 * (`ContainerIgnoreMismatchError`); it is stopped and started again once, with the patterns now needed.
 */
export interface ContainerOnlyOptions {
  readonly make: (patterns: ReadonlyArray<string>) => PatternedBackend;
  /** The patterns the next start needs. */
  readonly patterns: () => Promise<ReadonlyArray<string>>;
  /** The patterns before any `.gitmodules` is read (the first backend's). */
  readonly initial: ReadonlyArray<string>;
  /** Stops the running Container (its patterns are not the ones needed). */
  readonly stop: () => Promise<void>;
  readonly log?: (event: Record<string, unknown>) => void;
  /**
   * Runs after every connect, with the Container's runtime id, before computer gets the handle: the Workspace DO keeps
   * it as the key of the Global mise config's lay-down (SPI-1150), which each active command waits for. It never throws.
   */
  readonly connected?: (handle: { readonly runtimeId?: string | undefined }) => Promise<void>;
}

export class ContainerOnlyBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly #options: ContainerOnlyOptions;
  #current: { readonly patterns: ReadonlyArray<string>; readonly backend: PatternedBackend };

  constructor(options: ContainerOnlyOptions) {
    this.#options = options;
    const backend = options.make(options.initial);
    this.#current = { patterns: options.initial, backend };
    this.id = backend.id;
    this.type = backend.type;
    this.description = backend.description ?? "";
  }

  /** The patterns of the backend computer connects through now: the Container-only paths the agent's tools route there. */
  get patterns(): ReadonlyArray<string> {
    return this.#current.patterns;
  }

  /** The Container's egress and computerd's callbacks, to the backend that is connecting. */
  handleFetch(request: Request): Promise<Response> {
    return this.#current.backend.handleFetch(request);
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): ReturnType<WorkspaceBackend["connect"]> {
    const patterns = await this.#options.patterns();
    if (!samePatterns(patterns, this.#current.patterns)) {
      this.#options.log?.({ t3flare: "container-patterns", from: this.#current.patterns.length, to: patterns.length, patterns });
      this.#current = { patterns, backend: this.#options.make(patterns) };
    }
    const backend = this.#current.backend;
    let handle: Awaited<ReturnType<WorkspaceBackend["connect"]>>;
    try {
      handle = await backend.connect(host);
    } catch (error) {
      if (!(error instanceof Error && error.name === "ContainerIgnoreMismatchError")) throw error;
      this.#options.log?.({ t3flare: "container-patterns-restart", error: String(error).slice(0, 300) });
      await this.#options.stop();
      handle = await backend.connect(host);
    }
    await this.#options.connected?.(handle).catch(() => undefined);
    return handle;
  }
}
