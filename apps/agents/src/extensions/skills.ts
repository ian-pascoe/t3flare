// @effect-diagnostics globalConsole:off
// The `skills` extension (SPI-1147 §2; ported from cloudpid@47941c7c `packages/extensions/src/skills.ts`): a `skills`
// system prompt section listing the Skills the agent can read, as pi does (`<available_skills>`: name, description and
// the `SKILL.md` path, which the agent loads with `read` when a task matches). The Workspace DO finds them next to its
// files (`WorkspaceDO.skills`), one RPC that never starts the Container.
//
// The section is read once per context window and then shown as it was (`frozenSection`, as cloudpid's is): a Skill
// can change during a Session, and a changed section would rewrite the system prompt, the head of the provider's cache
// prefix. A first read that finds none freezes as empty, so a Skill written later is not added as a patch; a read that
// fails, or a request without a Workspace, freezes nothing and the next request tries again. The owner's `$name` and
// `/skill:name` expand in the Environment (`provider/attachments.ts`), from a fresh discovery, not from this list.
import type { WireSkillDiscovery } from "@t3flare/computer-env";
import { frozenSection } from "@t3flare/effect-durable";
import { formatSkills } from "@t3flare/skills";
import { defineExtension, type Extension, type PromptInput } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Effect from "effect/Effect";

export const SKILLS_EXTENSION = "skills";

/** An environment that finds its cwd's Skills itself (`ComputerExecutionEnv`, asking the Workspace DO). */
type SkillSource = { readonly discoverSkills: (context: typeof BACKGROUND_CONTEXT) => Promise<WireSkillDiscovery> };

const isSkillSource = (env: object): env is SkillSource => "discoverSkills" in env && typeof env.discoverSkills === "function";

/** The section's text for `env`: the listing in `<skills>`, empty when there is nothing to list, undefined without a Workspace. */
export const skillsSectionText = async (env: PromptInput["env"]): Promise<string | undefined> => {
  if (env === undefined || !isSkillSource(env)) return undefined;
  const listing = formatSkills(await env.discoverSkills(BACKGROUND_CONTEXT));
  return listing === "" ? "" : `<skills>\n${listing}\n</skills>`;
};

/** The `skills` extension: the section, and no tools. */
export const skillsExtension = (): Extension =>
  defineExtension({
    name: SKILLS_EXTENSION,
    sections: [
      Effect.runSync(
        frozenSection(SKILLS_EXTENSION, (input) =>
          // A failed read must not fail the request: the section is left out, unfrozen, and read again next time.
          Effect.promise(() =>
            skillsSectionText(input.env).catch((error: unknown) => {
              console.warn(JSON.stringify({ t3flare: "skills-section-failed", error: String(error).slice(0, 300) }));
              return undefined;
            }),
          ),
        ),
      ),
    ],
  });
