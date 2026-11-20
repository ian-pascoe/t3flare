// Refuses a pnpm command whose NPM_CONFIG_WORKSPACE_DIR is another checkout's (SPI-1290). `pnpm run check` runs it
// before vp's tasks, and the root `preinstall` before `pnpm install` changes anything. Plain node, no dependencies:
// it runs before the install it guards.
//
//   node scripts/workspace-guard.ts    exit 1, naming both paths and the fix, on a mismatch
//
// The checkout is the one the command was typed in: pnpm's INIT_CWD, else the working directory.
import * as fs from "node:fs";
import * as path from "node:path";

import { checkoutRootOf, workspaceGuard } from "./lib/workspaceGuard.ts";

const realpath = (dir: string) => {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
};

const workspaceDir = process.env.NPM_CONFIG_WORKSPACE_DIR;
const typedIn = process.env.INIT_CWD || process.cwd();
const checkoutRoot = checkoutRootOf(typedIn);
const decision = workspaceGuard(workspaceDir ? realpath(workspaceDir) : undefined, checkoutRoot === undefined ? undefined : realpath(checkoutRoot));
if (!decision.ok) {
  console.error(decision.message);
  process.exit(1);
}
