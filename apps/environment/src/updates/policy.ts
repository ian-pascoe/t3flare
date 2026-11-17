// The server Update's target policy (ADR-0037; in-app updates plan D6): an exact t3 nightly version, strictly newer than
// the running one by t3's own semver compare. A track switch (`channel`) or a staged update (`stageOnly`) is refused:
// the Cloud Environment follows t3's nightly track and lands what it proves. The bump pins exactly the client's tag, as
// the client then waits for `serverVersion` to equal its target.
import type { ServerSelfUpdateInput } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

import { NIGHTLY_VERSION } from "./pins.ts";

/** Why the Cloud Environment refuses to update to `input`'s target from `current`, or undefined to accept it. */
export const serverUpdateRefusal = (input: ServerSelfUpdateInput, current: string): string | undefined => {
  if (input.channel !== undefined) return "The Cloud Environment follows t3's nightly track; it does not switch update tracks.";
  if (input.stageOnly === true) return "The Cloud Environment does not stage updates; its update is proven and landed by CI.";
  const target = input.targetVersion.trim();
  if (!NIGHTLY_VERSION.test(target)) return `'${target}' is not an exact t3 nightly version.`;
  if (compareSemverVersions(target, current) <= 0) return `t3@${target} is not newer than this Environment's t3@${current}.`;
  return undefined;
};

/** The t3 tag a nightly version is published as. */
export const tagOf = (version: string): string => `v${version}`;
