// The Environment ↔ Workspace contract (ADR-0008, ADR-0009; step 2a plan, section 2). Plain types and the path
// translation: t3 sees a Workspace's repo at `/w/<id>`; inside the Workspace (its Durable Object's files, the Worker
// Shell, the Container) the repo is at `/workspace/repo`, because `@cloudflare/computer` fixes `/workspace`.

/** t3's root of every Workspace. */
export const W_ROOT = "/w";
/** Inside a Workspace: computer's root, the repo, and the harness's own files beside it. */
export const WORKSPACE_ROOT = "/workspace";
export const REPO_ROOT = "/workspace/repo";
export const HARNESS_ROOT = "/workspace/.t3flare";

/** A Workspace id: the one path segment under `/w` (ADR-0008). */
export const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const isWorkspaceId = (value: string): boolean => WORKSPACE_ID.test(value) && value !== "." && value !== "..";

/** `/w/<id>/rest` → `{ id, inner: "/workspace/repo/rest" }`; null for a path outside one Workspace. */
export const toWorkspace = (path: string): { readonly id: string; readonly inner: string } | null => {
  const match = /^\/w\/([^/]+)(\/.*)?$/.exec(normalize(path));
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
  | { readonly ran: true; readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly ms: number; readonly cached?: boolean }
  | { readonly ran: false; readonly reason: "container_stopped" | "container_refused"; readonly detail: string };

export interface CloneInput {
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
}
