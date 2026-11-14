// What the Workspace DO gives each Container command; no Node imports, so the agents Worker can import it.
/** The image's base mise config: the Toolchains it preinstalls (`image/mise.toml`). mise's system config. */
export const BASE_MISE_CONFIG = "/usr/local/share/cloudpid/mise.toml";

/** Where the Global mise config's lay-down keeps its files: the Container's own disk, outside `/workspace` (SPI-1150). */
export const GLOBAL_MISE_DIR = "/var/lib/t3flare/mise";

/**
 * mise's global config: the owner's Global mise config, laid down at each Container start when git and gh run under it
 * (`globalMise.ts`, ADR-0032's Global mise config refinement). Absent when there is none, and mise then resolves as from the base file alone.
 */
export const GLOBAL_MISE_CONFIG = `${GLOBAL_MISE_DIR}/config.toml`;

/**
 * What every Container command's environment carries besides PATH (computerd passes only PATH and HOME): mise's configs,
 * so git, gh, node and the rest resolve from the image's preinstalled Toolchains under the owner's global config and a
 * repo's own (system < global < project), and git never prompts.
 *
 * mise sends no GitHub token (SPI-1150): gh's `hosts.yml` (an agent's `gh auth login`), git's credential helper (the
 * Workspace's one-repo token) and a config's `credential_command` are turned off here, and an environment variable beats
 * every config file's setting. A token that could fail an install that works without one is never sent. The two empty
 * values hold `disable_tools` and `disable_backends` at none, so no file can remove git or gh by them.
 */
export const COMMAND_ENV: Readonly<Record<string, string>> = {
  MISE_SYSTEM_CONFIG_FILE: BASE_MISE_CONFIG,
  MISE_GLOBAL_CONFIG_FILE: GLOBAL_MISE_CONFIG,
  MISE_TRUSTED_CONFIG_PATHS: "/usr/local/share/cloudpid:/workspace",
  MISE_YES: "1",
  MISE_GITHUB_GH_CLI_TOKENS: "false",
  MISE_GITHUB_USE_GIT_CREDENTIALS: "false",
  MISE_GITHUB_CREDENTIAL_COMMAND: "",
  MISE_DISABLE_TOOLS: "",
  MISE_DISABLE_BACKENDS: "",
  GIT_TERMINAL_PROMPT: "0",
  BASH_ENV: "/usr/local/share/cloudpid/command.bash",
};
