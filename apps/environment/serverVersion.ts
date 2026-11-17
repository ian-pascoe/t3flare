// @effect-diagnostics nodeBuiltinImport:off
// The Server version (in-app updates plan D1): the t3 pin without its `v`. t3's release CI writes the release version
// into `apps/server/package.json` before it builds (`t3code/scripts/update-release-package-versions.ts`); we build from
// the tag's raw source, whose manifest says `0.1.10`, so the build stamps the version itself: `build.ts` serves t3's
// server manifest with it (every reader of `packageJson.version`), and `scripts/stage.ts` hands it to the web build as
// `APP_VERSION`. Off an exact tag (a hand-moved submodule), the manifest's own version stands, and a prod deploy refuses.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const T3_ROOT = path.resolve(import.meta.dirname, "../../t3code");
export const T3_SERVER_MANIFEST = path.join(T3_ROOT, "apps/server/package.json");

export interface ServerVersion {
  readonly version: string;
  /** The submodule is at a tag exactly; else `version` is the manifest's. */
  readonly exact: boolean;
  /** The tag, when `exact`. */
  readonly tag: string | null;
}

/** The version from `git describe --tags --exact-match HEAD`'s answer (`undefined` when it failed) and the manifest's. */
export const serverVersionOf = (describe: string | undefined, manifestVersion: string): ServerVersion => {
  const tag = describe?.trim();
  const match = tag === undefined ? null : /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  return match === null ? { version: manifestVersion, exact: false, tag: null } : { version: match[1]!, exact: true, tag: tag! };
};

/** The pinned t3's Server version, read from the submodule now. */
export const t3ServerVersion = (root: string = T3_ROOT): ServerVersion => {
  const result = spawnSync("git", ["-C", root, "describe", "--tags", "--exact-match", "HEAD"], { encoding: "utf8" });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps/server/package.json"), "utf8")) as { version: string };
  return serverVersionOf(result.status === 0 ? result.stdout : undefined, manifest.version);
};

/** t3's server manifest's text with `version` stamped in, as the bundle reads it. */
export const stampedManifest = (text: string, version: string): string =>
  `${JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), version }, null, 2)}\n`;
