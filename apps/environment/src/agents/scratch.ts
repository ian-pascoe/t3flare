// Scratch checkouts (parity G7, SPI-998): t3's PR review guide reads the change from a detached worktree it makes in its
// worktrees directory (`PullRequestReviewGuideService.checkoutHead`): a temporary directory from `FileSystem`
// (`makeTempDirectoryScoped({ directory: worktreesDir })`), then `git worktree add --detach <dir>/checkout <sha>` in the
// project, `merge-base` and `diff` in the checkout, an investigating text generation with the checkout as its cwd, and
// `git worktree remove --force` when the run's scope closes.
//
// In the Cloud Environment every other worktree is a Workspace of its own (ADR-0008, step 2b), too heavy for this. A
// scratch checkout is instead a real detached worktree inside the project's Container, at t3's own path (the Container
// sees `/w/...` paths as t3 does: the process channel mounts the repo at `/w/<id>`, and the scratch directory is plain
// Container disk). It never reaches the Workspace DO: its files are outside `/workspace`, and the repo's
// `.git/worktrees` is Container-only (`apps/agents/src/workspace/containerOnly.ts`).
//
// This registry names the scratch directories t3 made and, once `git worktree add` ran, the project each belongs to, so
// the process router and the process channel send a command whose cwd is in one to that project's Container. It lives
// in the Environment DO's memory: a reset ends the run that used it.
import { WORKTREES_ROOT, isWorkspaceId, normalize } from "@t3flare/workspace-client";

interface Scratch {
  /** The project Workspace whose Container holds the checkout; null until `git worktree add` names it. */
  project: string | null;
  readonly createdAt: number;
}

const scratches = new Map<string, Scratch>();

/** A scratch directory is forgotten this long after it was made, if t3 never removed it (a run's fetches and investigation take at most 25 min). */
export const SCRATCH_TTL_MS = 2 * 60 * 60_000;

/** A prefix t3 may give: the review guide's `review-guide-`. */
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

const sweep = (now: number) => {
  for (const [name, scratch] of scratches) if (now - scratch.createdAt > SCRATCH_TTL_MS) scratches.delete(name);
};

/** The scratch directory's name of a path in it (`/w/.wt/<name>[/...]`), when that name is registered. */
const nameOf = (path: string): { readonly name: string; readonly rest: string } | undefined => {
  const match = /^\/w\/\.wt\/([^/]+)(\/.*)?$/.exec(normalize(path));
  if (match === null || !scratches.has(match[1]!)) return undefined;
  return { name: match[1]!, rest: match[2] ?? "" };
};

/**
 * Makes a scratch directory in t3's worktrees directory: answers its path, or undefined when `directory` is not that
 * directory or the prefix is not one t3 sends. Nothing is written: `git worktree add` makes the directory in the
 * Container.
 */
export const makeScratchDir = (directory: string, prefix: string | undefined, now: number, random: () => string): string | undefined => {
  if (normalize(directory) !== WORKTREES_ROOT) return undefined;
  const head = prefix ?? "scratch-";
  if (!PREFIX.test(head)) return undefined;
  sweep(now);
  const name = `${head}${random()}`;
  if (!isWorkspaceId(name) || scratches.has(name)) return undefined;
  scratches.set(name, { project: null, createdAt: now });
  return `${WORKTREES_ROOT}/${name}`;
};

/** Whether `path` is a scratch directory itself (what t3 removes when its scope closes). */
export const isScratchDir = (path: string): boolean => {
  const at = nameOf(path);
  return at !== undefined && at.rest === "";
};

/** Forgets a scratch directory (t3 removed it). */
export const dropScratchDir = (path: string): void => {
  const at = nameOf(path);
  if (at !== undefined && at.rest === "") scratches.delete(at.name);
};

/**
 * Binds the checkout `path` (one segment below a scratch directory) to `project`, for `git worktree add --detach` in
 * that project. Answers the refusal's reason when the path is not such a checkout, or is bound to another project.
 */
export const bindScratchCheckout = (path: string, project: string): { readonly ok: true } | { readonly refused: string } => {
  const at = nameOf(path);
  if (at === undefined) return { refused: "not in a scratch directory t3 made" };
  if (!/^\/[^/]+$/.test(at.rest)) return { refused: "a scratch checkout is one directory directly in its scratch directory" };
  const scratch = scratches.get(at.name)!;
  if (scratch.project !== null && scratch.project !== project) return { refused: `the scratch directory belongs to the project ${scratch.project}` };
  scratch.project = project;
  return { ok: true };
};

/** The project whose Container holds the scratch checkout `path` is in (or is), once bound. */
export const scratchProjectOf = (path: string): string | undefined => {
  const at = nameOf(path);
  if (at === undefined || at.rest === "") return undefined;
  return scratches.get(at.name)?.project ?? undefined;
};

/** For tests. */
export const clearScratches = (): void => scratches.clear();
