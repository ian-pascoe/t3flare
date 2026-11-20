// The pins an Update moves, named once (ADR-0037, ADR-0041): the t3 tracks and their release tags, the CLI pins, the
// files each kind of bump may change, the `bump/*` branch names, and the proof a trusted job records on a proven commit.
// Dependency-free: the Environment DO, `scripts/bump.ts`, `scripts/cli-bump.ts`, and the trusted CI jobs
// (`scripts/updates-ci.ts`, `scripts/land-check.ts`, run with plain Node and no install) all import it.

/**
 * The t3 tracks a Deployment's t3 pin can follow (ADR-0041; the `T3FLARE_T3_TRACK` Deployment setting): t3's stable
 * releases (`v<x.y.z>`) or its nightlies (`v<x.y.z>-nightly.<yyyymmdd>.<run>`). t3's preview builds are not a track here.
 */
export const T3_TRACKS = ["stable", "nightly"] as const;
export type T3Track = (typeof T3_TRACKS)[number];

/** `value` as a t3 track, or undefined when it is not one. */
export const t3TrackOf = (value: string | undefined): T3Track | undefined => ((T3_TRACKS as ReadonlyArray<string | undefined>).includes(value) ? (value as T3Track) : undefined);

/** A t3 release tag on either track; group 1 is its version. */
export const T3_TAG = /^v(\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?)$/;
/** A t3 release's version: the tag without its `v`. */
export const T3_VERSION = /^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/;
/** An exact `x.y.z` version (a CLI pin, and a stable t3 release). */
export const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/** A full git commit id. */
export const COMMIT = /^[0-9a-f]{40}$/;

/** The track of a t3 release's version, or undefined when it is not one (a preview, anything else). */
export const trackOfVersion = (version: string): T3Track | undefined => (!T3_VERSION.test(version) ? undefined : EXACT_VERSION.test(version) ? "stable" : "nightly");

/** The track of a t3 release tag, or undefined when it is not one. */
export const trackOfTag = (tag: string): T3Track | undefined => (tag.startsWith("v") ? trackOfVersion(tag.slice(1)) : undefined);

/** The npm dist-tag t3 publishes each track's newest release under. */
export const NPM_DIST_TAG: Readonly<Record<T3Track, string>> = { stable: "latest", nightly: "nightly" };

/** The newest of `tags` on `track`, by version; undefined when none is on it. */
export const newestOnTrack = (tags: ReadonlyArray<string>, track: T3Track): string | undefined =>
  tags
    .filter((tag) => trackOfTag(tag) === track)
    .sort((a, b) => compareVersions(a.slice(1), b.slice(1)))
    .at(-1);

/**
 * The tag that names a pin, from the release tags on its commit: the newest on `track`, else the newest on the other (a
 * Deployment that switched tracks still runs the old track's pin until the new track passes it); undefined when the commit
 * carries no release tag. t3 promotes a nightly's commit to a stable, so a stable's commit carries a nightly tag too.
 */
export const pinTagOf = (tags: ReadonlyArray<string>, track: T3Track): string | undefined =>
  newestOnTrack(tags, track) ?? newestOnTrack(tags, track === "stable" ? "nightly" : "stable");

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

/** `pin`, validated: a t3 release tag (either track), or an updatable CLI at an exact version; else why not. */
export const pinOf = (input: { readonly kind?: string | undefined; readonly tag?: string | undefined; readonly cli?: string | undefined; readonly version?: string | undefined }): Pin | string => {
  if (input.kind === "t3") return input.tag !== undefined && T3_TAG.test(input.tag) ? { kind: "t3", tag: input.tag } : `not a t3 release tag: ${JSON.stringify(input.tag)}`;
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
  if (T3_TAG.test(rest)) return { kind: "t3", tag: rest };
  const match = /^cli-([a-z]+)-(\d+\.\d+\.\d+)$/.exec(rest);
  return match !== null && isUpdatableCli(match[1]) ? { kind: "cli", cli: match[1], version: match[2]! } : undefined;
};

const identifiers = (part: string) => part.split(".").map((identifier) => (/^\d+$/.test(identifier) ? Number(identifier) : identifier));
const compareIdentifiers = (left: ReadonlyArray<number | string>, right: ReadonlyArray<number | string>): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [x, y] = [left[index], right[index]];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    // Semver: numeric identifiers sort below alphanumeric ones.
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
};
/** Orders two versions as semver does: by `x.y.z`, then a release above its prereleases (`0.1.12` > `0.1.12-nightly.…`). */
export const compareVersions = (a: string, b: string): number => {
  const [coreA, ...preA] = a.split("-");
  const [coreB, ...preB] = b.split("-");
  const core = compareIdentifiers(identifiers(coreA ?? ""), identifiers(coreB ?? ""));
  if (core !== 0) return core;
  if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;
  return compareIdentifiers(identifiers(preA.join("-")), identifiers(preB.join("-")));
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

/** The `t3flare/proven` status a commit carries, as the API lists statuses (newest first). */
export interface ProofStatus {
  readonly context?: string;
  readonly state?: string;
  readonly description?: string | null;
  readonly target_url?: string | null;
  readonly creator?: { readonly login?: string } | null;
}

/** The newest `t3flare/proven` status's gate and the run it names, when GitHub Actions set it as a success. */
export const provenStatus = (statuses: ReadonlyArray<ProofStatus>): { readonly gate: Gate; readonly runId: number; readonly repository: string } | undefined => {
  const status = statuses.find((candidate) => candidate.context === PROVEN_CONTEXT);
  if (status === undefined || status.state !== "success" || status.creator?.login !== "github-actions[bot]") return undefined;
  const gate = status.description === "gate=full" ? "full" : status.description === "gate=update" ? "update" : undefined;
  const run = RUN_URL.exec(status.target_url ?? "");
  return gate === undefined || run === null ? undefined : { gate, runId: Number(run[2]), repository: run[1]! };
};

/** A pin as one string, as the workflows carry it (review A12): `t3:<tag>`, `cli:<cli>:<version>`. */
export const pinText = (pin: Pin): string => (pin.kind === "t3" ? `t3:${pin.tag}` : `cli:${pin.cli}:${pin.version}`);
export const parsePin = (text: string | undefined): Pin | string => {
  const [kind, first, second, ...rest] = (text ?? "").split(":");
  if (rest.length > 0) return `not a pin: ${JSON.stringify(text)}`;
  return kind === "t3" && second === undefined ? pinOf({ kind, tag: first }) : kind === "cli" ? pinOf({ kind, cli: first, version: second }) : `not a pin: ${JSON.stringify(text)}`;
};

/** A workflow run's page: `https://github.com/<owner>/<repo>/actions/runs/<id>`. */
export const RUN_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)$/;

/** The workflows whose trusted publish job may prove a pin. */
export const PROVING_WORKFLOWS = [".github/workflows/bump.yml", ".github/workflows/cli-bump.yml"] as const;

/**
 * Why the run a `t3flare/proven` status names cannot have proven anything, or undefined (review B1): it must be one of
 * this repository's proving workflows, run from `main`, on a schedule or a dispatch. A workflow pushed on another branch
 * can set a status as GitHub Actions, but its own run fails this; what this cannot see is which run set the status
 * (ADR-0037 §6 has the residual).
 */
export const proofRunRefusal = (
  run: { readonly path?: unknown; readonly head_branch?: unknown; readonly event?: unknown; readonly repository?: { readonly full_name?: unknown } | null; readonly head_repository?: { readonly full_name?: unknown } | null },
  repository: string,
): string | undefined => {
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) return "its run is not this repository's";
  if (!(PROVING_WORKFLOWS as ReadonlyArray<unknown>).includes(run.path)) return `its run is ${String(run.path)}, not a proving workflow`;
  if (run.head_branch !== "main") return `its run is on ${String(run.head_branch)}, not main`;
  if (run.event !== "schedule" && run.event !== "workflow_dispatch") return `its run was started by ${String(run.event)}`;
  return undefined;
};
