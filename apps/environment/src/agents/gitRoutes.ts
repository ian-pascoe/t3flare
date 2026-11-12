// The rules of the Environment's process router (step 2a plan, section 2), kept pure for tests: which `git` argv may
// start a Workspace's Container, how t3's clone becomes a Workspace, and how paths cross into a Workspace.
import { REPO_ROOT, normalize, toWorkspace } from "@t3flare/workspace-client";

/** git's global options that take a value as the next word (`git -C <dir> …`, `git -c k=v …`). */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** The subcommand of a git argv, after its global options, and the subcommand's own arguments. */
export const subcommandOf = (args: ReadonlyArray<string>): { readonly name: string | null; readonly rest: ReadonlyArray<string> } => {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (GLOBAL_WITH_VALUE.has(arg)) i += 2;
    else if (arg.startsWith("-")) i += 1;
    else return { name: arg, rest: args.slice(i + 1) };
  }
  return { name: null, rest: [] };
};

/**
 * Reads t3 runs on its own (status polls, branch lists, diffs for the UI): they never start a stopped Container, so a
 * Workspace nobody works in costs nothing. Everything else is a person's or an agent's action and may start it.
 */
const PASSIVE = new Set([
  "status",
  "rev-parse",
  "diff",
  "log",
  "ls-files",
  "show",
  "for-each-ref",
  "check-ignore",
  "symbolic-ref",
  "cat-file",
  "merge-base",
  "rev-list",
  "show-ref",
  "describe",
  "name-rev",
  "count-objects",
  "var",
  "remote",
  "config",
  "branch",
  "worktree",
  "stash",
  "ls-tree",
  "diff-tree",
  "diff-index",
  "diff-files",
  "grep",
]);

/** Subcommands in PASSIVE that also have writing forms; those forms may start the Container. */
const writes = (name: string, rest: ReadonlyArray<string>): boolean => {
  switch (name) {
    case "remote":
      return rest.length > 0 && !["-v", "--verbose", "show", "get-url"].includes(rest[0]!);
    case "config":
      return !rest.some((arg) => arg.startsWith("--get") || arg === "--list" || arg === "-l" || arg === "get");
    case "branch": {
      const writing = ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "--force", "--delete", "--move", "--copy", "--set-upstream-to", "-u", "--unset-upstream", "--track", "--no-track", "--edit-description"];
      if (rest.some((arg) => writing.includes(arg) || arg.startsWith("--set-upstream-to="))) return true;
      const listing = ["--list", "-l", "--show-current"];
      if (rest.some((arg) => listing.includes(arg) || /^--(no-)?(contains|merged|points-at)/.test(arg))) return false;
      // A branch name (before or after `--`) creates one: `git branch -- <name>`, as t3 sends it.
      const dashdash = rest.indexOf("--");
      return rest.some((arg, at) => (dashdash >= 0 && at > dashdash) || (!arg.startsWith("-") && (dashdash < 0 || at < dashdash)));
    }
    case "worktree":
      return rest[0] !== "list";
    case "stash":
      return rest[0] !== "list" && rest[0] !== "show";
    case "symbolic-ref":
      return rest.filter((arg) => !arg.startsWith("-")).length > 1;
    default:
      return false;
  }
};

/**
 * What t3's `git push` is about to update (SPI-992, review M2), for the push gateway's expectation. The forms t3 sends
 * at the pin: `push -- <remote> HEAD:refs/heads/<b>` and bare `push` (`GitVcsDriverCore` pushCurrentBranch), and the
 * stack rebase's `push --quiet --force-with-lease=… origin <sha>:refs/heads/<b>`; deletes too. Anything else is
 * `unparsed`: no expectation, and the gateway's policy decides (asked or refused while the Workspace is tainted).
 * `src` null is a delete.
 */
export type PushPlan =
  | { readonly kind: "not-push" }
  | { readonly kind: "unparsed" }
  | { readonly kind: "current" }
  | { readonly kind: "refspecs"; readonly remote: string; readonly refspecs: ReadonlyArray<{ readonly src: string | null; readonly dst: string }> };

const FULL_REF = /^refs\/(?:heads|tags)\/[^\s:+*?[\\^~]+$/;
const PUSH_SOURCE = /^(?:HEAD|[0-9a-f]{40}|[0-9a-f]{64}|refs\/heads\/[^\s:+*?[\\^~]+)$/;

export const pushPlanOf = (args: ReadonlyArray<string>): PushPlan => {
  const { name, rest } = subcommandOf(args);
  if (name !== "push") return { kind: "not-push" };
  let deleting = false;
  const words: Array<string> = [];
  let dashdash = false;
  for (const arg of rest) {
    if (!dashdash && arg === "--") dashdash = true;
    else if (!dashdash && (arg === "--quiet" || arg === "-q" || arg === "--force-with-lease" || arg.startsWith("--force-with-lease="))) continue;
    else if (!dashdash && (arg === "--delete" || arg === "-d")) deleting = true;
    else if (!dashdash && arg.startsWith("-")) return { kind: "unparsed" };
    else words.push(arg);
  }
  if (words.length === 0) return deleting ? { kind: "unparsed" } : { kind: "current" };
  const [remote, ...specs] = words as [string, ...Array<string>];
  if (specs.length === 0 || !/^[A-Za-z0-9._-]+$/.test(remote)) return { kind: "unparsed" };
  const refspecs: Array<{ src: string | null; dst: string }> = [];
  for (const spec of specs) {
    if (deleting) {
      if (!FULL_REF.test(spec)) return { kind: "unparsed" };
      refspecs.push({ src: null, dst: spec });
      continue;
    }
    const at = spec.indexOf(":");
    if (at < 0) return { kind: "unparsed" };
    const src = spec.slice(0, at);
    const dst = spec.slice(at + 1);
    if (!FULL_REF.test(dst) || (src !== "" && !PUSH_SOURCE.test(src))) return { kind: "unparsed" };
    refspecs.push({ src: src === "" ? null : src, dst });
  }
  return { kind: "refspecs", remote, refspecs };
};

/** Where git's push URLs point (the image's system gitconfig, `pushInsteadOf`, review M5). */
export const GATEWAY_URL_PREFIX = "http://computer.internal/t3flare/git/";

/** t3 is shown `https://github.com/…` where git shows the push gateway: `remote` and `ls-remote --get-url` output only. */
export const gatewayUrlsToGitHub = (args: ReadonlyArray<string>, stdout: string): string => {
  const { name, rest } = subcommandOf(args);
  if (name !== "remote" && !(name === "ls-remote" && rest.includes("--get-url"))) return stdout;
  return stdout.split(GATEWAY_URL_PREFIX).join("https://github.com/");
};

/** Whether this git argv may start a stopped Container (the router's allow-list). */
export const mayStartContainer = (args: ReadonlyArray<string>): boolean => {
  const { name, rest } = subcommandOf(args);
  if (name === null) return false;
  return !PASSIVE.has(name) || writes(name, rest);
};

/** Passive reads whose answer depends only on `.git` (refs, config, objects), not on the working tree's files. */
const GIT_DIR_ONLY = new Set([
  "rev-parse",
  "symbolic-ref",
  "for-each-ref",
  "remote",
  "worktree",
  "config",
  "show-ref",
  "merge-base",
  "rev-list",
  "branch",
  "log",
  "cat-file",
  "ls-tree",
  "describe",
  "name-rev",
  "diff-tree",
]);

/**
 * What a passive read's cached answer depends on (the Workspace DO's read cache): `git-dir` when only `.git`, so an
 * edit to a file does not make t3's branch and ref reads run again; `repo` otherwise (status, diffs, ls-files).
 */
export const readScopeOf = (args: ReadonlyArray<string>): "git-dir" | "repo" => {
  const { name } = subcommandOf(args);
  return name !== null && GIT_DIR_ONLY.has(name) ? "git-dir" : "repo";
};

export interface CloneRequest {
  /** The Workspace id: the directory name t3 asked for. */
  readonly id: string;
  readonly url: string;
}

/** t3's `git clone --progress -- <url> <name>` with cwd `/w`; null for any other argv or cwd. */
export const cloneRequestOf = (args: ReadonlyArray<string>, cwd: string | undefined): CloneRequest | null => {
  if (cwd === undefined || normalize(cwd) !== "/w") return null;
  const { name, rest } = subcommandOf(args);
  if (name !== "clone") return null;
  const words = rest.filter((arg) => arg !== "--" && !arg.startsWith("-"));
  if (words.length !== 2) return null;
  return { url: words[0]!, id: words[1]! };
};

export interface RemoteRepo {
  /** An https URL with no credentials. */
  readonly https: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/** A GitHub-style clone URL (https, ssh or scp form) as https, and its owner and name; null when it is not one. */
export const remoteRepoOf = (url: string): RemoteRepo | null => {
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  const match = full ?? scp;
  if (match === null) return null;
  const [, host, owner, name] = match as unknown as [string, string, string, string];
  return { https: `https://${host}/${owner}/${name}.git`, host: host.toLowerCase(), owner, name };
};

/** A t3 path in Workspace `id` as the Workspace's own path; other words unchanged. */
export const intoWorkspace = (id: string, word: string): string => {
  if (!word.startsWith("/w/")) return word;
  const at = toWorkspace(word);
  return at !== null && at.id === id ? at.inner : word;
};

/** Environment variables that reach git in the Container: git's own, translated; never the DO's HOME or PATH. */
export const gitEnvOf = (id: string, env: Readonly<Record<string, unknown>> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    if (key.startsWith("GIT_") || key === "LANGUAGE" || key === "LC_ALL") {
      // The trace2 monitor writes to a file on the Environment's side; git in the Container cannot.
      if (key.startsWith("GIT_TRACE2")) continue;
      out[key] = intoWorkspace(id, value);
    }
  }
  return out;
};

export { REPO_ROOT };

// ---------------------------------------------------------------------------------------------------------------------
// Worktrees (step 2b, plan section 3.5): t3's `git worktree …` in a project, given their cloud meaning.

export type WorktreeCommand =
  | { readonly verb: "add"; readonly path: string; readonly ref: string | null; readonly detach: boolean; readonly newBranch: string | null }
  | { readonly verb: "list"; readonly porcelain: boolean; readonly z: boolean }
  | { readonly verb: "remove"; readonly path: string; readonly force: boolean }
  | { readonly verb: "prune" }
  | { readonly verb: "unsupported"; readonly name: string };

/** Options of `git worktree add` that take a value. */
const ADD_WITH_VALUE = new Set(["-b", "-B", "--reason", "--orphan"]);

/** t3's `git … worktree <verb> …` argv; null when it is not a worktree command. */
export const worktreeCommandOf = (args: ReadonlyArray<string>): WorktreeCommand | null => {
  const { name, rest } = subcommandOf(args);
  if (name !== "worktree") return null;
  const [verb, ...tail] = rest;
  switch (verb) {
    case "add": {
      const words: Array<string> = [];
      let detach = false;
      let newBranch: string | null = null;
      for (let i = 0; i < tail.length; i++) {
        const arg = tail[i]!;
        if (arg === "--") {
          words.push(...tail.slice(i + 1));
          break;
        }
        if (arg === "--detach" || arg === "-d") detach = true;
        else if (ADD_WITH_VALUE.has(arg)) {
          if (arg === "-b" || arg === "-B") newBranch = tail[i + 1] ?? null;
          i++;
        } else if (!arg.startsWith("-")) words.push(arg);
      }
      if (words.length === 0) return { verb: "unsupported", name: "add" };
      return { verb: "add", path: words[0]!, ref: words[1] ?? null, detach, newBranch };
    }
    case "list":
      return { verb: "list", porcelain: tail.includes("--porcelain"), z: tail.includes("-z") };
    case "remove": {
      const words = tail.filter((arg) => !arg.startsWith("-"));
      const force = tail.includes("--force") || tail.includes("-f");
      return words.length === 1 ? { verb: "remove", path: words[0]!, force } : { verb: "unsupported", name: "remove" };
    }
    case "prune":
      return { verb: "prune" };
    default:
      return { verb: "unsupported", name: verb ?? "" };
  }
};

/**
 * Where a project's worktree may go: `/w/.wt/<the cwd's project dir>/<one segment>` (t3 builds it from the basename of
 * the project's cwd and the branch). Answers the worktree Workspace's id, or the reason it is refused.
 */
export const worktreeDestinationOf = (cwd: string, path: string): { readonly id: string } | { readonly refused: string } => {
  const project = toWorkspace(cwd);
  const target = toWorkspace(path);
  const dir = normalize(cwd).split("/").at(-1) ?? "";
  if (project === null || project.id.startsWith(".wt/")) return { refused: "fatal: t3flare: worktrees are made from a project in /w" };
  if (target === null || !target.id.startsWith(".wt/") || target.inner !== REPO_ROOT || target.id.split("/")[1] !== (project.inner === REPO_ROOT ? project.id : dir)) {
    return {
      refused: `fatal: t3flare: worktrees live under /w/.wt in the Cloud Environment; clear Settings → Worktrees → Location (asked for '${path}')`,
    };
  }
  return { id: target.id };
};

export interface WorktreeListEntry {
  readonly path: string;
  readonly head: string | null;
  /** `refs/heads/<name>`, or null when detached. */
  readonly branch: string | null;
}

/** `git worktree list --porcelain [-z]`, as git writes it. */
export const worktreeListPorcelain = (entries: ReadonlyArray<WorktreeListEntry>, z: boolean): string => {
  const end = z ? "\0" : "\n";
  return entries
    .map((entry) =>
      [`worktree ${entry.path}`, ...(entry.head === null ? [] : [`HEAD ${entry.head}`]), entry.branch === null ? "detached" : `branch ${entry.branch}`]
        .map((line) => `${line}${end}`)
        .join(""),
    )
    .map((record) => `${record}${end}`)
    .join("");
};

/** The entries of a real `git worktree list --porcelain [-z]` answer. */
export const parseWorktreeList = (text: string, z: boolean): ReadonlyArray<WorktreeListEntry> => {
  const records = text.split(z ? "\0\0" : "\n\n").filter((record) => record.trim() !== "");
  return records.map((record) => {
    const lines = record.split(z ? "\0" : "\n");
    const value = (key: string) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
    return { path: value("worktree") ?? "", head: value("HEAD"), branch: value("branch") };
  });
};
