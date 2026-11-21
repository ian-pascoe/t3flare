// @effect-diagnostics nodeBuiltinImport:off
// Whether a pnpm command may act on NPM_CONFIG_WORKSPACE_DIR (ADR-0030's SPI-1290 refinement). mise exports it once, in the checkout a shell
// started in; a shell that then cd's into a worktree keeps that path, and pnpm installs and checks the other checkout.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type WorkspaceGuardDecision =
  | { readonly ok: true; readonly warning?: string }
  | { readonly ok: false; readonly message: string };

/** A workspace dir pnpm was given, and the variable that gave it. */
export type WorkspaceDir = { readonly variable: string; readonly dir: string };

/** The root of the checkout the command was typed in, or why there is none. */
export type Checkout = { readonly root: string } | { readonly reason: string };

/**
 * `workspaceDirs` are the realpaths of every workspace dir pnpm was given (workspaceDirsOf), `checkout` the realpath
 * of the root of the checkout the command was typed in. With no checkout there is nothing to compare: allow, and say so.
 */
export const workspaceGuard = (workspaceDirs: ReadonlyArray<WorkspaceDir>, checkout: Checkout): WorkspaceGuardDecision => {
  if (workspaceDirs.length === 0) return { ok: true };
  if ("reason" in checkout) {
    return { ok: true, warning: `workspace guard: could not check ${workspaceDirs.map((entry) => entry.variable).join(" and ")}: ${checkout.reason}` };
  }
  const other = workspaceDirs.find((entry) => entry.dir !== checkout.root);
  if (other === undefined) return { ok: true };
  return {
    ok: false,
    message: [
      `workspace guard: ${other.variable} is ${other.dir}, but this command was typed in the checkout at ${checkout.root}.`,
      "pnpm would install and check the other checkout, not this one. Point it at this checkout and run the command again:",
      "",
      `  export ${other.variable}=${checkout.root}`,
    ].join("\n"),
  };
};

/**
 * The workspace dir pnpm reads: NPM_CONFIG_WORKSPACE_DIR, else its lowercase npm_config_workspace_dir (pnpm ignores the
 * lowercase one when the uppercase is set), resolved against the directory the command was typed in, as pnpm resolves it.
 */
export const workspaceDirsOf = (env: Readonly<Record<string, string | undefined>>, typedIn: string): Array<WorkspaceDir> => {
  const variable = ["NPM_CONFIG_WORKSPACE_DIR", "npm_config_workspace_dir"].find((name) => env[name]);
  return variable === undefined ? [] : [{ variable, dir: path.resolve(typedIn, env[variable]!) }];
};

const gitRevParse = (dir: string, flag: string, git: string) => spawnSync(git, ["rev-parse", flag], { cwd: dir, encoding: "utf8" });

/** The root of the git checkout holding `dir`; inside the t3code submodule, its superproject's. */
export const checkoutRootOf = (dir: string, git = "git"): Checkout => {
  if (!fs.existsSync(dir)) return { reason: `${dir} does not exist` };
  for (const flag of ["--show-superproject-working-tree", "--show-toplevel"]) {
    const result = gitRevParse(dir, flag, git);
    if (result.error) return { reason: `git could not run (${result.error.message})` };
    const root = result.status === 0 ? result.stdout.trim() : "";
    if (root !== "") return { root };
  }
  return { reason: `${dir} is not in a git checkout` };
};
