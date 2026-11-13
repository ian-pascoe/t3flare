// SPI-1151's skills probe fixture, shared by the Docker probe (`skills.docker.test.ts`, which runs the pinned CLIs over
// it) and the unit test that binds discovery to what they loaded (`cliSkills.test.ts`, over the recorded
// `docs/steps/spi-1151/m0-roots.json`).

/** Repo-level candidate skill roots: each gets a marker named for it and, at the cwd, a `dup`. */
export const REPO_SKILL_CANDIDATES: Readonly<Record<string, string>> = {
  ".claude/skills": "r-claude-skills",
  ".agents/skills": "r-agents-skills",
  ".codex/skills": "r-codex-skills",
  ".pi/skills": "r-pi-skills",
  ".opencode/skills": "r-opencode-skills",
  ".opencode/skill": "r-opencode-skill",
  // Below the cwd: whether a CLI looks into subdirectories.
  "sub/.agents/skills": "r-sub-agents-skills",
  "sub/.claude/skills": "r-sub-claude-skills",
};

/** Roots with a second same-named Skill (`dup2`): OpenCode's after its first. */
export const DUP2_ROOTS: ReadonlyArray<string> = [".agents/skills", ".opencode/skill"];

/** Repo-level candidate command files, by path. */
export const REPO_COMMAND_CANDIDATES: Readonly<Record<string, string>> = {
  ".claude/commands/r-claude-cmd.md": "r-claude-cmd",
  ".claude/commands/sub/r-claude-nested.md": "r-claude-nested",
  ".pi/prompts/r-pi-prompt.md": "r-pi-prompt",
  ".opencode/command/r-oc-command.md": "r-oc-command",
  ".opencode/commands/r-oc-commands.md": "r-oc-commands",
  ".agents/commands/r-agents-cmd.md": "r-agents-cmd",
  ".codex/prompts/r-codex-prompt.md": "r-codex-prompt",
};

export const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nProbe marker ${name}.\n`;
export const commandMd = (name: string) => `---\ndescription: Probe command ${name}\n---\n\nSay ${name}.\n`;

/** The repo's files, by path relative to the repo. */
export const repoFixture = (): Readonly<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const [root, name] of Object.entries(REPO_SKILL_CANDIDATES)) {
    files[`${root}/${name}/SKILL.md`] = skillMd(name, `Probe marker for ${root}`);
    if (!root.startsWith("sub/")) files[`${root}/dup/SKILL.md`] = skillMd("dup", `dup from ${root}`);
  }
  for (const root of DUP2_ROOTS) files[`${root}/dup2/SKILL.md`] = skillMd("dup2", `dup2 from ${root}`);
  for (const [file, name] of Object.entries(REPO_COMMAND_CANDIDATES)) files[file] = commandMd(name);
  return files;
};

/** What one CLI reported: skills (name, description, path when told) and commands. */
export interface Loaded {
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string | null; readonly path: string | null; readonly scope?: string | null }>;
  readonly commands: ReadonlyArray<string>;
}

/** The CLIs and the report key each one's skills and commands are read from. */
export const PROBED: Readonly<Record<"codex" | "pi" | "claude" | "opencode", { readonly skills: string; readonly commands: string }>> = {
  codex: { skills: "codex", commands: "codex" },
  // t3flare's profile: the repo's skills through `--skill`, its templates through `--prompt-template` (M2).
  pi: { skills: "pi", commands: "pi" },
  // Claude Code lists its Skills among its commands; the fixture's commands are those with a `-cmd`/`-nested` name.
  claude: { skills: "claude", commands: "claude" },
  // OpenCode lists no Skills over ACP: its server's `GET /api/skill`.
  opencode: { skills: "opencode (GET /api/skill)", commands: "opencode" },
};

const isRepoName = (name: string) => /^(r-|dup|sub:r-)/.test(name);
const isCommandName = (name: string) => /-(cmd|nested|prompt|command|commands)$/.test(name);
/** Claude Code's descriptions end with where it found the entry; the file's own description is before it. */
const fileDescription = (description: string | null) => (description ?? "").replace(/ \((project|user)\)$/, "");

/**
 * The repo-level part of what a CLI loaded: each Skill name with every description it was listed with (Codex lists a
 * same-named Skill once per root), and the command names, sorted.
 */
export const repoView = (skills: Loaded, commands: Loaded) => ({
  skills: Object.fromEntries(
    [...new Set(skills.skills.map((skill) => skill.name).filter((name) => isRepoName(name) && !isCommandName(name)))]
      .sort()
      .map((name) => [name, [...new Set(skills.skills.filter((skill) => skill.name === name).map((skill) => fileDescription(skill.description)))].sort()]),
  ),
  commands: [...new Set(commands.commands.filter((name) => isRepoName(name) && isCommandName(name)))].sort(),
});
