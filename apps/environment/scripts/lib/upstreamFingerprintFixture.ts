// @effect-diagnostics nodeBuiltinImport:off
// The upstream fingerprint's fixture (SPI-1011, fragility T2), dependency-free: `scripts/land-check.ts` reads it on a
// trusted runner with plain Node, where no parser is installed. The regions and hashes are `upstreamFingerprint.ts`'s.
import { spawnSync } from "node:child_process";

/** The fixture, from the repository root. */
export const FIXTURE_PATH = "apps/environment/test/fixtures/upstream-fingerprint.json";
/** The command that lists what changed since the last review, with our file to review for each. */
export const LIST_COMMAND = "node apps/environment/scripts/upstream-fingerprint.ts";
/** The command that records the pin's hashes once our files are reviewed. */
export const UPDATE_COMMAND = `${LIST_COMMAND} --update`;
/** Set to REPORT_ONLY by `scripts/bump.ts` for its `pnpm run check`: the fingerprint test is skipped, and the bump reports changes instead. */
export const REPORT_ONLY_ENV = "T3FLARE_UPSTREAM_FINGERPRINT";
/** REPORT_ONLY_ENV's value that skips the fingerprint test; any other value, or none, runs it. */
export const REPORT_ONLY = "report";

export interface RegionSpec {
  readonly symbol: string;
  /**
   * Leave out the object's plain `key: true` properties. For the descriptor's capabilities: t3 adds flags every week,
   * and a new flag is stripped until classified rather than failing the bump (fragility U4); a changed condition on
   * a flag, or a new conditional flag, still changes the hash.
   */
  readonly omitTrueFlags?: boolean;
}

/** Paths are relative to `t3code/`, ours to the repository root; `entry` is the register entry in docs/upstream-fragility.md. */
export interface WatchedRegion extends RegionSpec {
  readonly file: string;
  readonly hash: string;
  readonly ourFile: string;
  readonly entry: string;
}

export interface WatchedLiteral {
  readonly file: string;
  readonly literal: string;
  readonly ourFile: string;
  readonly entry: string;
}

export interface Fingerprint {
  /** The t3code commit the fixture was last reviewed at. */
  readonly reviewedCommit: string;
  readonly regions: ReadonlyArray<WatchedRegion>;
  readonly literals: ReadonlyArray<WatchedLiteral>;
  /** Each watched file's git blob id at `reviewedCommit`: what the land check compares, without a parser. */
  readonly files: Readonly<Record<string, string>>;
}

/** The t3 files the regions and literals are in, sorted. */
export const watchedFiles = (fingerprint: Pick<Fingerprint, "regions" | "literals">): Array<string> =>
  [...new Set([...fingerprint.regions, ...fingerprint.literals].map((watched) => watched.file))].toSorted();

/**
 * Each watched file's git blob id at HEAD of the t3code checkout `t3Dir` (`git rev-parse HEAD:<file>`), undefined when
 * the file is not there. The land check, `--update` and the test all read blob ids this way, so they agree. Throws when
 * git cannot be run.
 */
export const gitBlobOf =
  (t3Dir: string) =>
  (file: string): string | undefined => {
    const result = spawnSync("git", ["-C", t3Dir, "rev-parse", "--verify", "--quiet", `HEAD:${file}`], { encoding: "utf8" });
    if (result.error !== undefined) throw new Error(`upstream fingerprint: git could not be run: ${result.error.message}`);
    const id = result.stdout.trim();
    return result.status === 0 && /^[0-9a-f]{40}$/.test(id) ? id : undefined;
  };

/** What changed since the last review. */
export type Finding =
  /** A watched region whose hash moved, or that is gone. */
  | { readonly kind: "changed" | "gone"; readonly file: string; readonly symbol: string; readonly ourFile: string; readonly entry: string }
  /** A literal t3's source no longer contains. */
  | { readonly kind: "missing"; readonly file: string; readonly literal: string; readonly ourFile: string; readonly entry: string }
  /** A watched file whose bytes moved with no finding above: nothing of ours to review, but the land check holds the pin. */
  | { readonly kind: "moved"; readonly file: string };
