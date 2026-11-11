// The `.git`-only passive reads that may run for real once, and are primed (step 2b; root's ruling on M2's deviation,
// recorded as an ADR-0009 refinement). Step 2a ruled that a passive read never starts a stopped Container: it gets its
// last answer, patched where it can be. A worktree launch is an explicit action, but t3 asks the project a few `.git`
// reads before anything else starts its Container, and a read never answered before has no last answer. So:
//
// - only the reads below may start the Container when they have no answer at all (each is logged in the router trace);
// - whenever the Container is up (a clone, a worktree's provisioning, a routed action), they are answered then
//   (`primeScript`), so a later launch finds real answers and starts nothing;
// - their cache key ignores the command's env and a `--git-dir` naming the Workspace's own repo, so primed answers match.

export const UPSTREAM_FORMAT = "--format=%(refname)\t%(upstream:remotename)\t%(upstream:remoteref)";

export interface AllowedRead {
  readonly name: string;
  /** The t3 code that sends it. */
  readonly caller: string;
  readonly matches: (args: ReadonlyArray<string>) => boolean;
}

const equals = (args: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  args.length === expected.length && args.every((arg, at) => arg === expected[at]);

export const FIRST_READ_ALLOWED: ReadonlyArray<AllowedRead> = [
  {
    name: "git-common-dir",
    caller: "GitVcsDriverCore.readGitCommonDir (createWorktree's directory hash, the shared-config lock)",
    matches: (args) => equals(args, ["rev-parse", "--git-common-dir"]),
  },
  {
    name: "remotes",
    caller: "GitVcsDriverCore.listRemoteNames (resolveWorktreeBaseRemote; also emulated from the DO's files)",
    matches: (args) => equals(args, ["remote"]),
  },
  {
    name: "base-upstream",
    caller: "GitVcsDriverCore.resolveWorktreeBaseRemote (a worktree launch's base branch and its upstream)",
    matches: (args) => args.length === 3 && args[0] === "for-each-ref" && args[1] === UPSTREAM_FORMAT && args[2]!.startsWith("refs/heads/"),
  },
  {
    name: "remote-commit",
    caller: "GitVcsDriverCore.fetchWorktreeBaseCommit (the launch's base commit after its fetch)",
    matches: (args) => args.length === 4 && equals(args.slice(0, 3), ["rev-parse", "--verify", "--quiet"]) && /^refs\/remotes\/.+\^\{commit\}$/.test(args[3]!),
  },
  {
    name: "checkout-workers",
    caller: "GitVcsDriverCore.createWorktree (readConfigValue checkout.workers)",
    matches: (args) => equals(args, ["config", "--get", "checkout.workers"]),
  },
];

/** The argv without a `--git-dir` naming the Workspace's own repo (t3 sends both forms). */
export const withoutOwnGitDir = (args: ReadonlyArray<string>, repo: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "--git-dir" && args[at + 1] === `${repo}/.git`) at++;
    else if (args[at] === `--git-dir=${repo}/.git`) continue;
    else out.push(args[at]!);
  }
  return out;
};

/** The allow-listed read `args` is, if any. */
export const allowedRead = (args: ReadonlyArray<string>, repo: string): AllowedRead | undefined => {
  const plain = withoutOwnGitDir(args, repo);
  return FIRST_READ_ALLOWED.find((read) => read.matches(plain));
};

/** What a passive read does: answered from the cache, served stale, or run (and whether that run starts the Container). */
export type PassiveDecision = "cache" | "stale" | "run" | "run-starting-container";

/**
 * The rule, kept pure: a cached answer at the current revision wins; a running Container answers; a stopped one is
 * started only by an allow-listed `.git` read with no answer at all. Everything else gets its last answer (stale).
 */
export const passiveDecision = (input: {
  readonly cachedNow: boolean;
  readonly running: boolean;
  readonly hasLastAnswer: boolean;
  readonly allowed: boolean;
  readonly emulated: boolean;
}): PassiveDecision => {
  if (input.cachedNow) return "cache";
  if (input.running) return "run";
  if (!input.hasLastAnswer && input.allowed && !input.emulated) return "run-starting-container";
  return "stale";
};

/** The allow-listed reads to answer now, for the repo's branches and remote-tracking refs. */
export const primeArgvs = (refs: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => [
  ["rev-parse", "--git-common-dir"],
  ["remote"],
  ["config", "--get", "checkout.workers"],
  ...refs.filter((ref) => ref.startsWith("refs/heads/")).slice(0, 100).map((ref) => ["for-each-ref", UPSTREAM_FORMAT, ref]),
  ...refs
    .filter((ref) => ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
    .slice(0, 100)
    .map((ref) => ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
];

const word = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** One script answering every argv: `T3P <index> <exit> <stdout base64>` per read. */
export const primeScript = (argvs: ReadonlyArray<ReadonlyArray<string>>): string =>
  [
    "t=$(mktemp)",
    ...argvs.map((argv, index) => `git ${argv.map(word).join(" ")} >"$t" 2>/dev/null; echo "T3P ${index} $? $(base64 -w0 <"$t")"`),
    'rm -f "$t"',
  ].join("\n");

export const parsePrimed = (stdout: string): ReadonlyArray<{ readonly index: number; readonly exitCode: number; readonly stdout: string }> =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("T3P "))
    .map((line) => {
      const [, index, exit, data = ""] = line.split(" ");
      return { index: Number(index), exitCode: Number(exit), stdout: new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0))) };
    });
