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

export interface CliRoots {
  /** Skill roots in each directory from the cwd up to the repo root, in the CLI's precedence order (first name wins). */
  readonly skills: ReadonlyArray<string>;
  /** Command directories at the cwd. */
  readonly commands: ReadonlyArray<CommandSource>;
}

/**
 * Each CLI's roots (M0, 2026-11-13). Codex 0.167.2: `.agents/skills` and `.codex/skills`, which it lists both of a
 * same-named pair from; no repo commands. pi 1.5.2: `.pi/skills` then `.agents/skills` and `.pi/prompts`, loaded
 * through the profile's `--skill` and `--prompt-template` (trust stays off). Claude Code 2.1.322: `.claude/skills` and
 * `.claude/commands` with its subdirectories. OpenCode 2.2.7: `.opencode/skills`, `.opencode/skill`, `.agents/skills`
 * (`.claude/` is off: `OPENCODE_DISABLE_CLAUDE_CODE`), and `.opencode/command` and `.opencode/commands`.
 */
export const CLI_ROOTS: Readonly<Record<CliAgent, CliRoots>> = {
  codex: { skills: [".agents/skills", ".codex/skills"], commands: [] },
  pi: { skills: [".pi/skills", ".agents/skills"], commands: [{ directory: ".pi/prompts", nested: false }] },
  claude: { skills: [".claude/skills"], commands: [{ directory: ".claude/commands", nested: true }] },
  opencode: {
    skills: [".opencode/skills", ".opencode/skill", ".agents/skills"],
    commands: [
      { directory: ".opencode/command", nested: false },
      { directory: ".opencode/commands", nested: false },
    ],
  },
};

export const isCliAgent = (value: unknown): value is CliAgent => typeof value === "string" && (CLI_AGENTS as ReadonlyArray<string>).includes(value);
