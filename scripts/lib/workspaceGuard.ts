// Whether a pnpm command may act on NPM_CONFIG_WORKSPACE_DIR (SPI-1290). mise exports it once, in the checkout a shell
// started in; a shell that then cd's into a worktree keeps that path, and pnpm installs and checks the other checkout.
import { spawnSync } from "node:child_process";

export type WorkspaceGuardDecision = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * `workspaceDir` is NPM_CONFIG_WORKSPACE_DIR's realpath, `checkoutRoot` the realpath of the root of the checkout the
 * command was typed in, undefined outside any git checkout, where there is nothing to compare.
 */
export const workspaceGuard = (workspaceDir: string | undefined, checkoutRoot: string | undefined): WorkspaceGuardDecision => {
  if (!workspaceDir || checkoutRoot === undefined || workspaceDir === checkoutRoot) return { ok: true };
  return {
    ok: false,
    message: [
      `workspace guard: NPM_CONFIG_WORKSPACE_DIR is ${workspaceDir}, but this command was typed in the checkout at ${checkoutRoot}.`,
      "pnpm would install and check the other checkout, not this one. Point it at this checkout and run the command again:",
      "",
      `  export NPM_CONFIG_WORKSPACE_DIR=${checkoutRoot}`,
    ].join("\n"),
  };
};

const git = (dir: string, flag: string) => {
  const result = spawnSync("git", ["rev-parse", flag], { cwd: dir, encoding: "utf8" });
  const out = result.status === 0 ? result.stdout.trim() : "";
  return out === "" ? undefined : out;
};

/** The root of the git checkout holding `dir`; inside the t3code submodule, its superproject's. */
export const checkoutRootOf = (dir: string): string | undefined =>
  git(dir, "--show-superproject-working-tree") ?? git(dir, "--show-toplevel");
