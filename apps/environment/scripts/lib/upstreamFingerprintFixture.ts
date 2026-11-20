// @effect-diagnostics nodeBuiltinImport:off
// The upstream fingerprint's fixture (SPI-1011, fragility T2), dependency-free: `scripts/land-check.ts` reads it on a
// trusted runner with plain Node, where no parser is installed. The regions and hashes are `upstreamFingerprint.ts`'s.
import { createHash } from "node:crypto";

/** The fixture, from the repository root. */
export const FIXTURE_PATH = "apps/environment/test/fixtures/upstream-fingerprint.json";
/** The command that records the pin's hashes once our files are reviewed. */
export const UPDATE_COMMAND = "node apps/environment/scripts/upstream-fingerprint.ts --update";
/** Set by `scripts/bump.ts` for its `pnpm run check`: the fingerprint test is skipped, and the bump reports changes instead. */
export const REPORT_ONLY_ENV = "T3FLARE_UPSTREAM_FINGERPRINT";

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

/** `git hash-object` of a file's text. */
export const blobId = (text: string): string => {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
