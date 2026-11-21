// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Refuses a pnpm command whose NPM_CONFIG_WORKSPACE_DIR is another checkout's (ADR-0030's SPI-1290 refinement). `pnpm run check` runs it
// before vp's tasks. Plain node, no dependencies: in a fresh worktree nothing is installed yet. No install hook runs
// it, because pnpm runs the root `preinstall` in the target checkout with INIT_CWD, PWD and the working directory all
// that checkout's root, so the directory the command was typed in is unknowable there.
//
//   node scripts/workspace-guard.ts    exit 1, naming both paths and the fix, on a mismatch; exit 0 otherwise, with
//                                      one stderr line when the variable is set but no checkout could be found
//
// The checkout is the one the command was typed in: pnpm's INIT_CWD, else the working directory.
import * as fs from "node:fs";

import { checkoutRootOf, workspaceDirsOf, workspaceGuard } from "./lib/workspaceGuard.ts";

const realpath = (dir: string) => {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
};

const typedIn = process.env.INIT_CWD || process.cwd();
const checkout = checkoutRootOf(typedIn);
const decision = workspaceGuard(
  workspaceDirsOf(process.env, typedIn).map((entry) => ({ ...entry, dir: realpath(entry.dir) })),
  "root" in checkout ? { root: realpath(checkout.root) } : checkout,
);
if (!decision.ok) {
  console.error(decision.message);
  process.exit(1);
}
if (decision.warning) console.error(decision.warning);
