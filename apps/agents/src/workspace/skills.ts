// @effect-diagnostics globalConsole:off
// The Workspace DO's side of Repo skills and Prompt templates (SPI-1147 §1): discovery run next to its own files, so a
// request is one RPC and never starts the Container (ADR-0009). The Environment skill set is SPI-1148's; until then
// it is empty.
import type { ReadEnv } from "@t3flare/computer-env";
import { discoverPrompts, discoverSkills, type PromptTemplate, type Skill, type SkillDiscovery, type SkillFiles } from "@t3flare/skills";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** `env`'s file reads as discovery takes them: hidden names listed, git's ignore rules not applied, `node_modules` not walked. */
export const skillFilesOf = (env: ReadEnv): SkillFiles => ({
  list: async (directory, maxEntries) => {
    if (env.listFiles === undefined) return [];
    const listing = await env.listFiles(directory, { hidden: true, gitignore: false, exclude: ["node_modules"], maxEntries }, BACKGROUND_CONTEXT);
    if (listing.ok) return listing.value.entries;
    if (listing.error.code === "not_found" || listing.error.code === "not_directory") return [];
    throw new Error(`Cannot list skills in ${directory}: ${listing.error.message}`);
  },
  read: async (path) => {
    const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
    return read.ok ? read.value : undefined;
  },
});

/** The Skills of a thread in `env`'s cwd, logging one line when any was skipped. */
export const workspaceSkills = async (env: ReadEnv, root: string, environment: ReadonlyArray<Skill>): Promise<SkillDiscovery> => {
  const found = await discoverSkills(skillFilesOf(env), { cwd: env.cwd, root, environment });
  if (found.skipped.length > 0) {
    console.log(
      JSON.stringify({ t3flare: "skills", cwd: env.cwd, skills: found.skills.length, omitted: found.omitted, skipped: found.skipped.slice(0, 20), skippedCount: found.skipped.length }),
    );
  }
  return found;
};

/** The Prompt templates of a thread in `env`'s cwd. */
export const workspacePrompts = (env: ReadEnv): Promise<ReadonlyArray<PromptTemplate>> => discoverPrompts(skillFilesOf(env), env.cwd);
