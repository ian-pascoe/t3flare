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

/** git subcommands that reach the remote: the router gives them the Workspace's Container token (step 2a M4). */
const NETWORK = new Set(["push", "fetch", "pull", "ls-remote"]);

/** Whether this git argv talks to the remote, so it needs the repo's token in `T3FLARE_GIT_TOKEN` (the credential helper reads it). */
export const needsRemoteToken = (args: ReadonlyArray<string>): boolean => {
  const { name, rest } = subcommandOf(args);
  if (name === null) return false;
  if (NETWORK.has(name)) return true;
  return (name === "remote" && rest[0] === "update") || (name === "submodule" && rest.includes("update"));
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
