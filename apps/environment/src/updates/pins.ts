// The pins an Update moves, named once (ADR-0037): the t3 pin's nightly tags, the CLI pins, the files each kind of bump
// may change, the `bump/*` branch names, and the proof a trusted job records on a proven commit. Dependency-free: the
// Environment DO, `scripts/bump.ts`, `scripts/cli-bump.ts`, and the trusted CI jobs (`scripts/updates-ci.ts`,
// `scripts/land-check.ts`, run with plain Node and no install) all import it.

/** A t3 nightly's tag: `v<x.y.z>-nightly.<yyyymmdd>.<run>`; group 1 is its version, 2 its date, 3 its run. */
export const NIGHTLY_TAG = /^v(\d+\.\d+\.\d+-nightly\.(\d{8})\.(\d+))$/;
/** A t3 nightly's version, the tag without its `v`. */
export const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
/** An exact `x.y.z` version (a CLI pin). */
export const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/** A full git commit id. */
export const COMMIT = /^[0-9a-f]{40}$/;

/** The newest of `tags` by nightly date, then run; undefined when none is a nightly. */
export const newestNightly = (tags: ReadonlyArray<string>): string | undefined =>
  tags
    .filter((tag) => NIGHTLY_TAG.test(tag))
    .sort((a, b) => {
      const [, , da, ra] = NIGHTLY_TAG.exec(a)!;
      const [, , db, rb] = NIGHTLY_TAG.exec(b)!;
      return da === db ? Number(ra) - Number(rb) : da!.localeCompare(db!);
    })
    .at(-1);

/** What a t3 bump commits besides the `t3code` gitlink: the files `scripts/relock.ts` regenerates. */
export const PINNED_FILES = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "mise.toml"] as const;
export const T3_PIN_FILES = ["t3code", ...PINNED_FILES] as const;

/** The CLI agents an Update can move: the one list (`cli-bump.yml`'s choices are checked against it). */
export const UPDATABLE_CLIS = ["pi", "codex", "claude"] as const;
export type UpdatableCli = (typeof UPDATABLE_CLIS)[number];
export const isUpdatableCli = (value: unknown): value is UpdatableCli => typeof value === "string" && (UPDATABLE_CLIS as ReadonlyArray<string>).includes(value);

/** The files a CLI bump may change. */
export const CLI_PIN_FILES = [
  "apps/sandbox-image/image/Dockerfile",
  "apps/sandbox-image/image/cli/package.json",
  "apps/sandbox-image/image/cli/package-lock.json",
  "apps/sandbox-image/image/claude/package.json",
  "apps/sandbox-image/image/claude/package-lock.json",
  "apps/sandbox-image/src/clis.ts",
] as const;

/** A CLI's pin version as its bump names it: Codex's and pi's own version, Claude's ACP adapter's. */
export const pinVersionOf = (
  cli: UpdatableCli,
  clis: { readonly codex: { readonly version: string }; readonly pi: { readonly version: string }; readonly claude: { readonly packageVersion: string } },
): string => (cli === "claude" ? clis.claude.packageVersion : clis[cli].version);

/** What a bump proposes: a t3 tag, or one CLI at one version. */
export type Pin = { readonly kind: "t3"; readonly tag: string } | { readonly kind: "cli"; readonly cli: UpdatableCli; readonly version: string };

/** `pin`, validated: a nightly tag, or an updatable CLI at an exact version; else why not. */
export const pinOf = (input: { readonly kind?: string; readonly tag?: string; readonly cli?: string; readonly version?: string }): Pin | string => {
  if (input.kind === "t3") return input.tag !== undefined && NIGHTLY_TAG.test(input.tag) ? { kind: "t3", tag: input.tag } : `not a nightly tag: ${JSON.stringify(input.tag)}`;
  if (input.kind === "cli") {
    if (!isUpdatableCli(input.cli)) return `not an updatable CLI: ${JSON.stringify(input.cli)}`;
    return input.version !== undefined && EXACT_VERSION.test(input.version) ? { kind: "cli", cli: input.cli, version: input.version } : `not an exact version: ${JSON.stringify(input.version)}`;
  }
  return `not a kind of pin: ${JSON.stringify(input.kind)}`;
};

/** The branch a proven pin is pushed to: `bump/<tag>`, `bump/cli-<cli>-<version>`. */
export const branchOf = (pin: Pin): string => (pin.kind === "t3" ? `bump/${pin.tag}` : `bump/cli-${pin.cli}-${pin.version}`);

/** The pin a `bump/*` branch name holds, or undefined for any other name. */
export const pinOfBranch = (branch: string): Pin | undefined => {
  if (!branch.startsWith("bump/")) return undefined;
  const rest = branch.slice("bump/".length);
  if (NIGHTLY_TAG.test(rest)) return { kind: "t3", tag: rest };
  const match = /^cli-([a-z]+)-(\d+\.\d+\.\d+)$/.exec(rest);
  return match !== null && isUpdatableCli(match[1]) ? { kind: "cli", cli: match[1], version: match[2]! } : undefined;
};

const numbers = (version: string) => version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
/** Orders two versions of the same kind (exact, or nightly by its numbers). */
export const compareVersions = (a: string, b: string): number => {
  const [left, right] = [numbers(a), numbers(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [x, y] = [left[index], right[index]];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    return typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
  }
  return 0;
};

/** The `bump/*` branches of `landed`'s kind (and CLI) at or below its version: what a land deletes. Others are kept. */
export const landedBranches = (landed: Pin, branches: ReadonlyArray<string>): ReadonlyArray<string> =>
  branches.filter((branch) => {
    const pin = pinOfBranch(branch);
    if (pin === undefined || pin.kind !== landed.kind) return false;
    if (pin.kind === "t3" && landed.kind === "t3") return compareVersions(pin.tag.slice(1), landed.tag.slice(1)) <= 0;
    return pin.kind === "cli" && landed.kind === "cli" && pin.cli === landed.cli && compareVersions(pin.version, landed.version) <= 0;
  });

/** The commit status a trusted job sets on a proven pin's commit (A1): Container tokens cannot set statuses. */
export const PROVEN_CONTEXT = "t3flare/proven";
export type Gate = "update" | "full";
export const provenDescription = (gate: Gate): string => `gate=${gate}`;

/** The gate a commit's statuses prove it passed: the newest `t3flare/proven` success set by GitHub Actions, if any. */
export const provenGate = (
  statuses: ReadonlyArray<{ readonly context?: string; readonly state?: string; readonly description?: string | null; readonly creator?: { readonly login?: string } | null }>,
): Gate | undefined => {
  // GitHub lists a commit's statuses newest first.
  const status = statuses.find((candidate) => candidate.context === PROVEN_CONTEXT);
  if (status === undefined || status.state !== "success" || status.creator?.login !== "github-actions[bot]") return undefined;
  return status.description === "gate=full" ? "full" : status.description === "gate=update" ? "update" : undefined;
};
