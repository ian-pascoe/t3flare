// The Environment ↔ Workspace contract (ADR-0008, ADR-0009; step 2a plan, section 2). Plain types and the path
// translation: t3 sees a Workspace's repo at `/w/<id>`; inside the Workspace (its Durable Object's files, the Worker
// Shell, the Container) the repo is at `/workspace/repo`, because `@cloudflare/computer` fixes `/workspace`.

/** t3's root of every Workspace. */
export const W_ROOT = "/w";
/** Inside a Workspace: computer's root, the repo, and the harness's own files beside it. */
export const WORKSPACE_ROOT = "/workspace";
export const REPO_ROOT = "/workspace/repo";
export const HARNESS_ROOT = "/workspace/.t3flare";

/** A project Workspace id: the one path segment under `/w` (ADR-0008). */
export const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const isWorkspaceId = (value: string): boolean => WORKSPACE_ID.test(value) && value !== "." && value !== "..";

/** Where worktree Workspaces live (t3's `worktreesDir`, step 2b): `/w/.wt/<project dir>/<worktree dir>`. */
export const WORKTREES_SEGMENT = ".wt";
export const WORKTREES_ROOT = `${W_ROOT}/${WORKTREES_SEGMENT}`;

/** One path segment t3 may make from a branch name: no `/`, NUL or control character, not `.`/`..`, at most 100 bytes. */
export const isWorktreeDir = (value: string): boolean =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  // oxlint-disable-next-line no-control-regex
  !/[/\x00-\x1f\x7f]/.test(value) &&
  new TextEncoder().encode(value).byteLength <= 100;

/** A worktree Workspace id: its path below `/w`, `.wt/<project dir>/<dir>` (step 2b). */
export const isWorktreeId = (value: string): boolean => {
  const parts = value.split("/");
  return parts.length === 3 && parts[0] === WORKTREES_SEGMENT && isWorkspaceId(parts[1]!) && isWorktreeDir(parts[2]!);
};

/** Any Workspace id: a project's or a worktree's. */
export const isAnyWorkspaceId = (value: string): boolean => isWorkspaceId(value) || isWorktreeId(value);

/** The directories t3 sees above worktree Workspaces (`/w/.wt`, `/w/.wt/<project dir>`), which hold no files of their own. */
export const worktreeDirOf = (path: string): { readonly project: string | null } | null => {
  const normal = normalize(path);
  if (normal === WORKTREES_ROOT) return { project: null };
  const match = /^\/w\/\.wt\/([^/]+)$/.exec(normal);
  return match !== null && isWorkspaceId(match[1]!) ? { project: match[1]! } : null;
};

/**
 * `/w/<id>/rest` → `{ id, inner: "/workspace/repo/rest" }`, for a project (`/w/<p>/…`) or a worktree
 * (`/w/.wt/<p>/<dir>/…`, id `.wt/<p>/<dir>`); null for a path outside one Workspace.
 */
export const toWorkspace = (path: string): { readonly id: string; readonly inner: string } | null => {
  const normal = normalize(path);
  const worktree = /^\/w\/(\.wt\/[^/]+\/[^/]+)(\/.*)?$/.exec(normal);
  if (worktree !== null) {
    if (!isWorktreeId(worktree[1]!)) return null;
    return { id: worktree[1]!, inner: `${REPO_ROOT}${worktree[2] ?? ""}` };
  }
  const match = /^\/w\/([^/]+)(\/.*)?$/.exec(normal);
  if (match === null || !isWorkspaceId(match[1]!)) return null;
  const rest = match[2] ?? "";
  return { id: match[1]!, inner: `${REPO_ROOT}${rest === "/" ? "" : rest}` };
};

/** `/workspace/repo/rest` in Workspace `id` → `/w/<id>/rest`; other paths are returned unchanged. */
export const fromWorkspace = (id: string, inner: string): string =>
  inner === REPO_ROOT || inner.startsWith(`${REPO_ROOT}/`) ? `${W_ROOT}/${id}${inner.slice(REPO_ROOT.length)}` : inner;

/** Replaces every `/workspace/repo` path prefix in `text` with `/w/<id>` (git's printed paths). */
export const fromWorkspaceText = (id: string, text: string): string =>
  text.replace(/\/workspace\/repo(?=\/|$|\s|"|')/g, `${W_ROOT}/${id}`);

/** POSIX normalization: `.` and `..` resolved, duplicate slashes removed. */
export const normalize = (path: string): string => {
  const out: Array<string> = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};

export const isUnderW = (path: string): boolean => {
  const normal = normalize(path);
  return normal === W_ROOT || normal.startsWith(`${W_ROOT}/`);
};

// ---------------------------------------------------------------------------------------------------------------------
// RPC shapes (methods of WorkspaceDO); paths here are inside the Workspace.

export type FileKind = "file" | "directory" | "symlink";

export interface FileStat {
  readonly kind: FileKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

export interface DirEntry {
  readonly name: string;
  readonly kind: FileKind;
}

export interface FsError {
  readonly error: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL" | "EIO";
  readonly message: string;
}

export type FsAnswer<A> = { readonly ok: A } | FsError;

export interface FoundEntry {
  readonly path: string;
  readonly kind: FileKind;
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface GitRun {
  readonly argv: ReadonlyArray<string>;
  /** Inside the Workspace. */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** May start a stopped Container (the router's allow-list); else a passive read, answered from the read cache when it can. */
  readonly startContainer: boolean;
  /** What a passive read's answer depends on: `.git` alone, or the whole repo (working tree included). */
  readonly readScope?: "git-dir" | "repo";
}

export type GitAnswer =
  | {
      readonly ran: true;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly ms: number;
      readonly cached?: boolean;
      /** A passive read answered while the Container was stopped: the last real answer, patched with the write journal where its shape allows. */
      readonly stale?: "patched" | "last-answer";
      /** Step 2b: an allow-listed `.git` read with no answer at all started the stopped Container (its name). */
      readonly startedContainer?: string;
    }
  | { readonly ran: false; readonly reason: "container_stopped" | "container_refused"; readonly detail: string };

export interface CloneInput {
  /** The Workspace's id, which the object keeps (the credential helper asks for its repo's token by it). */
  readonly id?: string;
  /** An https URL with no credentials; the token goes in the command's environment. */
  readonly url: string;
  readonly token: string | null;
  readonly timeoutMs?: number;
}

export interface ProvisionInfo {
  readonly provisioned: boolean;
  readonly repo: boolean;
  readonly containerRunning: boolean;
  /** The repo's revision in the Workspace's change log, and how many passive reads are kept (diagnosis). */
  readonly revision?: number;
  readonly gitRevision?: number;
  readonly cachedReads?: number;
  /** The Workspace id the object knows itself by (the credential helper's token is for its repo). */
  readonly id?: string | null;
  /** Step 2b: purged (`destroy()`); every RPC but provisioning refuses. */
  readonly destroyed?: boolean;
}

/** t3's checkpoint operations (`VcsCheckpointOps`), answered by the Workspace DO (ADR-0009; step 2a M3). Refs are git refs. */
export type CheckpointOp =
  | { readonly op: "capture"; readonly ref: string }
  | { readonly op: "has"; readonly ref: string }
  | {
      readonly op: "diff";
      readonly from: string;
      readonly to: string;
      readonly fallbackFromToHead: boolean;
      readonly ignoreWhitespace: boolean;
      readonly format: "patch" | "numstat";
      readonly filePaths?: ReadonlyArray<string>;
      readonly maxOutputBytes?: number;
    }
  | { readonly op: "authored"; readonly from: string; readonly to: string }
  | { readonly op: "delete"; readonly refs: ReadonlyArray<string> }
  | { readonly op: "restore"; readonly ref: string; readonly fallbackToHead: boolean };

/** A checkpoint operation's answer, and which side made it (the DO's isomorphic-git, or the Container's git). */
export type CheckpointAnswer =
  | { readonly ok: true; readonly value: unknown; readonly by: "do" | "container" | "alias" }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------------------------------------------------
// Terminals (step 2b, ADR-0021): the Environment's PTY adapter ⇄ the Workspace DO's terminal host. Keys are made by the
// adapter (`term-<hex>`), and are also the shell's marker in the Container.

export interface TerminalOpenInput {
  readonly key: string;
  /** t3's path of the Workspace's repo (`/w/<id>`) and t3's cwd at or below it. */
  readonly t3Path: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  /** Already allowlisted by the adapter. */
  readonly env: Readonly<Record<string, string>>;
  /** A worktree's project (`/w/<project>`): linked to the worktree's project-root view in its Container (step 2b). */
  readonly projectRoot?: string;
}

/** Every answer names the Workspace DO instance (its epoch): a new epoch means the old one's terminals are gone. */
export interface TerminalAnswer {
  readonly epoch: string;
  /** Keys this instance does not hold (an exited or unknown terminal). */
  readonly unknown: ReadonlyArray<string>;
}

/** One terminal's output, in order (`seq`); `busy` is the foreground's state after the data; `exit` ends it. */
export interface TerminalFrame {
  readonly key: string;
  readonly seq: number;
  readonly data?: string;
  readonly busy?: boolean;
  readonly exit?: { readonly code: number };
}

/** A batch of frames a Workspace DO pushes to the Environment DO. */
export interface TerminalPush {
  readonly workspace: string;
  readonly epoch: string;
  readonly frames: ReadonlyArray<TerminalFrame>;
}

/** The Environment's answer: keys it does not know (it restarted, or the terminal was closed): kill them. */
export interface TerminalPushAnswer {
  readonly unknown: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The process channel (step 4a, ADR-0015's refinement): t3's spawns of `codex app-server` and `pi --mode rpc` run in a
// Workspace's Container under the platform's non-PTY exec. The Environment's spawner ⇄ the Workspace DO's process host.
// Keys are made by the spawner (`proc-<uuid>`) and are also the process's marker in the Container (`T3FLARE_EXEC`).
// Data is bytes end to end (review F6): JSON lines split across frames are joined by t3's own line decoder.

/** The CLI a process runs; `probe` is M1's test program, refused unless the stage allows faults. */
export type ProcessCli = "codex" | "pi" | "probe" | "claude" | "opencode";

export interface ProcessStartInput {
  readonly key: string;
  /** The Environment DO's boot counter (durable): processes of any other epoch in this Workspace are killed first. */
  readonly environmentEpoch: number;
  readonly cli: ProcessCli;
  /** t3's path of the Workspace's repo (`/w/<id>`) and t3's cwd at or below it: the launcher makes them resolve. */
  readonly t3Path: string;
  readonly cwd: string;
  /** The binary (absolute, in the image) and its arguments, as the CLI profile built them. */
  readonly argv: ReadonlyArray<string>;
  /** The profile's allowlisted environment; the host adds `T3FLARE_EXEC` and the key nonce. */
  readonly env: Readonly<Record<string, string>>;
  /** Files the profile writes on the Container's own disk before the start (the CLI's home), by absolute path. */
  readonly files?: ReadonlyArray<{ readonly path: string; readonly text: string; readonly mode?: number }>;
  /** Symbolic links made before the start (Codex's `sessions/` into the synced directory). */
  readonly links?: ReadonlyArray<{ readonly path: string; readonly target: string }>;
  /** Session retention: files under `dir` untouched for `days` are removed before the start. */
  readonly prune?: ReadonlyArray<{ readonly dir: string; readonly days: number }>;
  /** t3's thread, for linked work (D1) and the logs. */
  readonly thread?: string;
  /** The thread came through a peer link: its pushes ask, while the process lives (review F8). */
  readonly linked?: boolean;
}

/** Every answer names the Workspace DO's boot counter: another value means the processes it held are gone. */
export interface ProcessAnswer {
  readonly epoch: number;
  readonly unknown: ReadonlyArray<string>;
}

export type ProcessStartAnswer =
  | {
      readonly ok: true;
      readonly epoch: number;
      /** Whether bubblewrap works in this Container (probed at each Container start, review F5): Codex's sandbox. */
      readonly sandbox?: boolean;
    }
  | { readonly ok: false; readonly epoch: number; readonly reason: string };

/** One process's output in order (`seq`, one counter per process across both streams); `exit` comes last. */
export interface ProcessFrame {
  readonly key: string;
  readonly seq: number;
  readonly stream: "stdout" | "stderr" | "exit";
  readonly data?: Uint8Array;
  readonly code?: number;
}

/**
 * The Environment's read of a Workspace's output (a long poll; the channel pulls, it never pushes: a push answered
 * inside the Environment's own calls nests one level deeper per round trip, up to the platform's subrequest depth
 * limit). `keys` are the Environment's live processes there (the read is their heartbeat); `ack` is the last batch it
 * received, so a batch whose answer was lost is sent again.
 */
export interface ProcessReadInput {
  readonly keys: ReadonlyArray<string>;
  readonly ack: number;
  readonly waitMs: number;
}

export interface ProcessReadAnswer extends ProcessAnswer {
  /** 0 when no frames came. */
  readonly batch: number;
  readonly frames: ReadonlyArray<ProcessFrame>;
}

/** `processInput`'s answer: `gap` and `failed` end the process (a write is never skipped, review F6). */
export type ProcessInputAnswer = ProcessAnswer & { readonly accepted: "written" | "duplicate" | "gap" | "failed" | "unknown" };

