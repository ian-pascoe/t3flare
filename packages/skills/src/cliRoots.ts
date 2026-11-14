// The CLI agents' roots (SPI-1151 §1 and §2): where each pinned CLI finds a repository's Skills and commands, as its
// M0 probe found them (`docs/steps/spi-1151/m0-roots.json`; `apps/environment/test/docker/skills.docker.test.ts`
// re-runs it, so a CLI bump that moves a root fails there). The CLIs are pinned in `apps/sandbox-image/src/clis.ts`.
// Repo-level only: a CLI's own home is built fresh per process and holds none of the repository's.

/** The CLI agents, by t3's driver kind's short name. */
export type CliAgent = "codex" | "pi" | "claude" | "opencode";

export const CLI_AGENTS: ReadonlyArray<CliAgent> = ["codex", "pi", "claude", "opencode"];

/** A directory of commands: Markdown files named for their Slash command. */
export interface CommandSource {
  readonly directory: string;
  /** Subdirectories count, their names joined to the command's with `:` (`sub/x.md` is `/sub:x`, Claude Code's). */
  readonly nested: boolean;
}

/** A Skill root: a path a directory's Skills are below, and whether only the cwd's counts (else each from the cwd up to the repo root). */
export interface SkillRoot {
  readonly directory: string;
  readonly cwdOnly: boolean;
  /**
   * SPI-1153: what the CLI does with a Skill here and an Environment skill of the same name (its M0 probe, one root at a
   * time: `docs/steps/env-skills-cli/m0-probe.json`). The CLI's own rule, which can differ by root (OpenCode's); only
   * pi's is t3flare's choice, by its flags' order. Absent: SPI-1147's Pi Durable roots, where the Environment wins.
   */
  readonly environment?: EnvironmentPrecedence;
}

export interface CliRoots {
  /** Skill roots in each directory from the cwd up to the repo root, in the CLI's precedence order (first name wins). */
  readonly skills: ReadonlyArray<SkillRoot>;
  /** Command directories at the cwd. */
  readonly commands: ReadonlyArray<CommandSource>;
}

/** Who wins a same-named Repo and Environment skill in a CLI; `both`: the CLI lists both and a bare mention picks neither. */
export type EnvironmentPrecedence = "environment" | "repo" | "both";

/** A root that walks from the cwd up to the repo root, and its winner against an Environment skill. */
const up = (directory: string, environment: EnvironmentPrecedence): SkillRoot => ({ directory, cwdOnly: false, environment });

/**
 * Each CLI's roots (M0, 2026-11-13). Codex 0.167.2: `.agents/skills` and `.codex/skills`, which it lists both of a
 * same-named pair from; no repo commands. pi 1.5.2: `.pi/skills` at the cwd, then `.agents/skills` up to the repo root
 * (`dist/core/package-manager.js`), and `.pi/prompts`, loaded through the profile's `--skill` and `--prompt-template`
 * (trust stays off). The probe ran at the repo root, so where the other CLIs look from a cwd below it is unprobed: they
 * walk up, as SPI-1147's discovery does. Claude Code 2.1.322: `.claude/skills` and
 * `.claude/commands` with its subdirectories. OpenCode 2.2.7: `.opencode/skills`, `.opencode/skill`, `.agents/skills`
 * (`.claude/` is off: `OPENCODE_DISABLE_CLAUDE_CODE`), and `.opencode/command` and `.opencode/commands`. SPI-1153 adds
 * each root's winner against an Environment skill (M0, 2026-11-14, one root at a time).
 */
export const CLI_ROOTS: Readonly<Record<CliAgent, CliRoots>> = {
  codex: { skills: [up(".agents/skills", "both"), up(".codex/skills", "both")], commands: [] },
  pi: { skills: [{ directory: ".pi/skills", cwdOnly: true, environment: "environment" }, up(".agents/skills", "environment")], commands: [{ directory: ".pi/prompts", nested: false }] },
  claude: { skills: [up(".claude/skills", "environment")], commands: [{ directory: ".claude/commands", nested: true }] },
  opencode: {
    skills: [up(".opencode/skills", "repo"), up(".opencode/skill", "repo"), up(".agents/skills", "environment")],
    commands: [
      { directory: ".opencode/command", nested: false },
      { directory: ".opencode/commands", nested: false },
    ],
  },
};

export const isCliAgent = (value: unknown): value is CliAgent => typeof value === "string" && (CLI_AGENTS as ReadonlyArray<string>).includes(value);

/**
 * SPI-1153: the winner between a CLI's Repo skill at `filePath` and an Environment skill of its name, by the root it is
 * in (the deepest root `filePath` is below); a path in none of the CLI's roots is the Environment's.
 */
export const environmentPrecedenceOf = (agent: CliAgent, filePath: string): EnvironmentPrecedence => {
  let found: { readonly at: number; readonly root: SkillRoot } | undefined;
  for (const root of CLI_ROOTS[agent].skills) {
    const at = filePath.lastIndexOf(`/${root.directory}/`);
    if (at !== -1 && (found === undefined || at > found.at)) found = { at, root };
  }
  return found?.root.environment ?? "environment";
};
