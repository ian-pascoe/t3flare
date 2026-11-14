// A CLI agent's Workspace takes the Environment skill set (SPI-1153, hand-off A1 of SPI-1148): before its process starts
// (`agents/cliProcess.ts`), so a CLI that reads its Skills at start reads the current set, and before each of its turns
// (`wrapCliAdapter`'s `takeEnvironmentSkills`), so the set is current in the Container when the turn runs. The take is
// the one a Pi Durable turn's Session runs (`takeSkillsForTurn`): bounded, never failing the spawn or the turn, and when
// the hash is the Workspace's already, one call that changes nothing. Whether a running CLI then sees a changed set is
// its own (docs/steps/env-skills-cli.md, "When a CLI catches up").
import { type SkillsTaker, takeSkillsForTurn } from "@t3flare/skills";
import * as Effect from "effect/Effect";

import { environmentServices } from "../../agents/bindings.ts";
import { locate } from "../../agents/workspaceClient.ts";

export interface CliSkillsTakeAccess {
  /** The Environment skill set's hash now; undefined when the store cannot be read. */
  readonly hash: () => string | undefined;
  /** The Workspace t3 path `cwd` is in; undefined outside one. */
  readonly workspace: (cwd: string) => SkillsTaker | undefined;
}

/** The Environment's own: its store's hash, the registry's Workspaces. */
export const environmentSkillsTakeAccess = (): CliSkillsTakeAccess => ({
  hash: () => {
    try {
      return environmentServices().environmentSkills().hash();
    } catch {
      return undefined;
    }
  },
  workspace: (cwd) => locate(cwd)?.rpc,
});

/** Has the Workspace of t3 path `cwd` take the Environment skill set now, at most `waitMs`; never fails. */
export const takeEnvironmentSkillsAt = (cwd: string | null | undefined, access: CliSkillsTakeAccess = environmentSkillsTakeAccess(), waitMs?: number): Effect.Effect<void> =>
  cwd === null || cwd === undefined
    ? Effect.void
    : Effect.promise(async () => {
        let workspace: SkillsTaker | undefined;
        try {
          workspace = access.workspace(cwd);
        } catch {
          workspace = undefined;
        }
        await takeSkillsForTurn(access.hash(), workspace, waitMs);
      });
