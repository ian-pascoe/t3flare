// What the Workspace DO gives each Container command; no Node imports, so the agents Worker can import it.
/** The image's base mise config: the Toolchains it preinstalls (`image/mise.toml`). */
export const BASE_MISE_CONFIG = "/usr/local/share/cloudpid/mise.toml";

/**
 * What every Container command's environment carries besides PATH (computerd passes only PATH and HOME): mise's base
 * config, so git, gh, node and the rest resolve from the image's preinstalled Toolchains, and git never prompts.
 */
export const COMMAND_ENV: Readonly<Record<string, string>> = {
  MISE_GLOBAL_CONFIG_FILE: BASE_MISE_CONFIG,
  MISE_TRUSTED_CONFIG_PATHS: "/usr/local/share/cloudpid:/workspace",
  MISE_YES: "1",
  GIT_TERMINAL_PROMPT: "0",
  BASH_ENV: "/usr/local/share/cloudpid/command.bash",
};
