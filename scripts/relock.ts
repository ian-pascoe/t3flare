// Regenerates the workspace and the lock from the pinned t3code (ADR-0030), the one way to change either:
//
//   node scripts/relock.ts        (pnpm run relock)
//
//  1. gen-workspace.ts writes pnpm-workspace.yaml (t3's patches limited to what the current lock installs);
//  2. seed-lock.ts seeds pnpm-lock.yaml from t3's lock;
//  3. `pnpm install --no-frozen-lockfile` resolves our packages against it (CI defaults to frozen, review H3);
//  4. again from 1 while gen-workspace.ts changes pnpm-workspace.yaml: what our packages install can bring a t3 patch
//     into play (alchemy) or out of it. Two rounds settle it; a third means the two disagree, and fails.
//  5. verify-lock.ts.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Every pnpm command here belongs to this workspace, never t3code's (AGENTS.md; review M3).
const env = { ...process.env, NPM_CONFIG_WORKSPACE_DIR: root };

const run = (command: string, args: Array<string>) => {
  console.log(`$ ${[path.basename(command), ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`relock: ${path.basename(command)} ${args.join(" ")} failed (exit ${result.status})`);
    process.exit(1);
  }
};
const workspaceFile = path.join(root, "pnpm-workspace.yaml");
const read = () => (fs.existsSync(workspaceFile) ? fs.readFileSync(workspaceFile, "utf8") : "");

for (let round = 1; ; round++) {
  const before = read();
  run(process.execPath, ["scripts/gen-workspace.ts"]);
  if (round > 1 && read() === before) break;
  if (round > 2) {
    console.error("relock: pnpm-workspace.yaml still changes after two installs");
    process.exit(1);
  }
  run(process.execPath, ["scripts/seed-lock.ts"]);
  run("pnpm", ["install", "--no-frozen-lockfile"]);
}
run(process.execPath, ["scripts/verify-lock.ts"]);
