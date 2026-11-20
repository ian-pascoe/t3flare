// The server Update's target policy (ADR-0037, ADR-0041; in-app updates plan D6): an exact t3 release on the
// Deployment's t3 track, strictly newer than the running one by t3's own semver compare. A track switch (`channel`) or
// a staged update (`stageOnly`) is refused: the t3 track is a Deployment setting, and the Cloud Environment lands what CI
// proves. The bump pins exactly the client's tag, as the client then waits for `serverVersion` to equal its target.
import type { ServerSelfUpdateInput } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

import { type T3Track, trackOfVersion } from "./pins.ts";

/**
 * Why the Cloud Environment refuses to update to `input`'s target from `current`, or undefined to accept it. `track` is
 * the t3 track this build was made for (build.ts stamps it); a build without one takes no Update.
 */
export const serverUpdateRefusal = (input: ServerSelfUpdateInput, current: string, track: T3Track | undefined): string | undefined => {
  if (input.channel !== undefined) return "The Cloud Environment's t3 track is a Deployment setting (T3FLARE_T3_TRACK); it does not switch update tracks.";
  if (input.stageOnly === true) return "The Cloud Environment does not stage updates; its update is proven and landed by CI.";
  if (track === undefined) return "This Cloud Environment was built with no t3 track, so it takes no Update; deploy it again.";
  const target = input.targetVersion.trim();
  const targetTrack = trackOfVersion(target);
  if (targetTrack === undefined) return `'${target}' is not an exact t3 release.`;
  if (targetTrack !== track) {
    return `This Cloud Environment follows t3's ${track} releases (a Deployment setting); t3@${target} is a ${targetTrack} build. Put this client on the ${track} update track.`;
  }
  if (compareSemverVersions(target, current) <= 0) return `t3@${target} is not newer than this Environment's t3@${current}.`;
  return undefined;
};

/** The t3 tag a release version is published as. */
export const tagOf = (version: string): string => `v${version}`;
