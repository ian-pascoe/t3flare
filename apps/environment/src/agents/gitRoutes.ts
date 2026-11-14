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
  "count-objects",
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

/** git's C-style escapes (`quote.c`, `unquote_c_style`) that are one letter. */
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };

/**
 * The entries of a `GIT_ALTERNATE_OBJECT_DIRECTORIES` list as git reads it (`parse_alt_odb_entry`): an entry starting
 * with `"` is C-quoted up to its closing quote (so it may hold the `:` separator), any other runs to the next `:`.
 */
const alternateEntries = (value: string): Array<string> => {
  const entries: Array<string> = [];
  let i = 0;
  while (i <= value.length) {
    if (value[i] === '"') {
      const bytes: Array<number> = [];
      i++;
      while (i < value.length && value[i] !== '"') {
        const char = value[i]!;
        if (char === "\\" && i + 1 < value.length) {
          const next = value[i + 1]!;
          const octal = /^[0-3][0-7]{2}/.exec(value.slice(i + 1, i + 4));
          if (octal !== null) {
            bytes.push(Number.parseInt(octal[0], 8));
            i += 4;
            continue;
          }
          if (C_ESCAPES[next] !== undefined) {
            bytes.push(C_ESCAPES[next]);
            i += 2;
            continue;
          }
        }
        bytes.push(...new TextEncoder().encode(char));
        i++;
      }
      entries.push(new TextDecoder().decode(new Uint8Array(bytes)));
      // Past the closing quote and its separator.
      i = value.indexOf(":", i);
      if (i === -1) break;
      i++;
    } else {
      const end = value.indexOf(":", i);
      entries.push(value.slice(i, end === -1 ? value.length : end));
      if (end === -1) break;
      i = end + 1;
    }
  }
  return entries.filter((entry) => entry !== "");
};

/** An entry quoted as t3 quotes it (git 2.11.1+ reads it), so a path holding the separator stays one entry. */
const quoteAlternate = (entry: string) => `"${entry.replace(/[\\"]/g, "\\$&")}"`;

/**
 * A `GIT_ALTERNATE_OBJECT_DIRECTORIES` list into Workspace `id` (SPI-1186): each entry on its own, a t3 path in this
 * Workspace as the Workspace's path (`intoWorkspace`), quoting and the separator kept. An entry `onT3Side` names (in
 * the Environment's State directory, which the Container cannot see) is dropped and reported. t3's commit draft lists
 * the repo's objects (`/w/<id>/.git/objects`) and every alternate the Container's `count-objects -v` reported.
 */
export const alternatesInto = (
  id: string,
  value: string,
  onT3Side: (entry: string) => boolean,
): { readonly value: string | undefined; readonly dropped: ReadonlyArray<string> } => {
  const kept: Array<string> = [];
  const dropped: Array<string> = [];
  for (const entry of alternateEntries(value)) {
    if (entry.startsWith("/w/")) kept.push(intoWorkspace(id, entry));
    else if (onT3Side(entry)) dropped.push(entry);
    else kept.push(entry);
  }
  return { value: kept.length === 0 ? undefined : kept.map(quoteAlternate).join(":"), dropped };
};

/**
 * Environment variables that reach git in the Container: git's own, translated; never the DO's HOME or PATH. The
 * alternates list is translated entry by entry (`alternatesInto`, with `onT3Side`; dropped entries go to `dropped`).
 */
export const gitEnvOf = (
  id: string,
  env: Readonly<Record<string, unknown>> | undefined,
  options: { readonly onT3Side?: (entry: string) => boolean; readonly dropped?: Array<string> } = {},
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    if (key.startsWith("GIT_") || key === "LANGUAGE" || key === "LC_ALL") {
      // The trace2 monitor writes to a file on the Environment's side; git in the Container cannot.
      if (key.startsWith("GIT_TRACE2")) continue;
      if (key === "GIT_ALTERNATE_OBJECT_DIRECTORIES") {
        const translated = alternatesInto(id, value, options.onT3Side ?? (() => false));
        options.dropped?.push(...translated.dropped);
        if (translated.value !== undefined) out[key] = translated.value;
        continue;
      }
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
