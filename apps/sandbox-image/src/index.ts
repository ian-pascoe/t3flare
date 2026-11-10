// @effect-diagnostics nodeBuiltinImport:off
// The Container image (copied from cloudpid@ae5a7b73:apps/sandbox-image, trimmed; step 2a plan, section 5).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Docker build context of the image: the directory with its Dockerfile. The stack builds the Workspace DO's Container from it. */
export const sandboxImageContext = join(dirname(fileURLToPath(import.meta.url)), "..", "image");

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
