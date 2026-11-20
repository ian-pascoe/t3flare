// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// The Server version (in-app updates plan D1; ADR-0041): the t3 pin's tag without its `v`. t3's release CI writes the
// release version into `apps/server/package.json` before it builds (`t3code/scripts/update-release-package-versions.ts`);
// we build from the tag's raw source, whose manifest says `0.1.10`, so the build stamps the version itself: `build.ts`
// serves t3's server manifest with it (every reader of `packageJson.version`), and `scripts/stage.ts` hands it to the web
// build as `APP_VERSION`. t3 promotes a nightly's commit to a stable release, so one commit can carry a tag on each t3
// track: the Deployment's track names it (`pinTagOf`), never git's pick between the two. Off a release tag (a hand-moved
// submodule), the manifest's own version stands, and a prod deploy refuses.
//
//   node apps/environment/serverVersion.ts version|tag   prints the pin's Server version or tag (T3FLARE_T3_TRACK)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { requireSetting } from "./scripts/lib/deploymentSettings.ts";
import { pinTagOf, type T3Track, t3TrackOf } from "./src/updates/pins.ts";

export const T3_ROOT = path.resolve(import.meta.dirname, "../../t3code");
export const T3_SERVER_MANIFEST = path.join(T3_ROOT, "apps/server/package.json");

export interface ServerVersion {
  readonly version: string;
  /** The submodule is at a release tag exactly; else `version` is the manifest's. */
  readonly exact: boolean;
  /** The tag, when `exact`. */
  readonly tag: string | null;
}

/** The version from the tags on the pin's commit (`git tag --points-at HEAD`), the Deployment's track, and the manifest's. */
export const serverVersionOf = (tags: ReadonlyArray<string>, track: T3Track, manifestVersion: string): ServerVersion => {
  const tag = pinTagOf(tags, track);
  return tag === undefined ? { version: manifestVersion, exact: false, tag: null } : { version: tag.slice(1), exact: true, tag };
};

/** The pinned t3's Server version on `track`, read from the submodule now. */
export const t3ServerVersion = (track: T3Track, root: string = T3_ROOT): ServerVersion => {
  const result = spawnSync("git", ["-C", root, "tag", "--points-at", "HEAD"], { encoding: "utf8" });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps/server/package.json"), "utf8")) as { version: string };
  const tags = result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()) : [];
  return serverVersionOf(tags, track, manifest.version);
};

/** The Deployment's t3 track from the environment (`T3FLARE_T3_TRACK`); throws its setting's message when unset. */
export const t3TrackSetting = (env: Readonly<Record<string, string | undefined>> = process.env): T3Track =>
  t3TrackOf(requireSetting(env, "T3FLARE_T3_TRACK"))!;

/** t3's server manifest's text with `version` stamped in, as the bundle reads it. */
export const stampedManifest = (text: string, version: string): string =>
  `${JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), version }, null, 2)}\n`;

if (import.meta.main) {
  const what = process.argv[2];
  const serverVersion = t3ServerVersion(t3TrackSetting());
  if ((what !== "version" && what !== "tag") || !serverVersion.exact) {
    console.error(what !== "version" && what !== "tag" ? "usage: node serverVersion.ts version|tag" : "t3code is not at a t3 release tag");
    process.exit(2);
  }
  console.log(what === "tag" ? serverVersion.tag : serverVersion.version);
}
