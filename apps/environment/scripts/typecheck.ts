// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// `pnpm --filter @t3flare/environment run typecheck`: `effect-tsgo tsrs --noEmit`, failing only on errors in t3flare's
// own files (fragility U10, `lib/typecheckFilter.ts`). Errors in t3's files are printed under a heading, and pass.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { typecheckVerdict } from "./lib/typecheckFilter.ts";

const cwd = path.resolve(import.meta.dirname, "..");
const t3Root = path.resolve(cwd, "../../t3code");
const result = spawnSync("effect-tsgo", ["tsrs", "--noEmit", "--pretty", "false", ...process.argv.slice(2)], {
  cwd,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
if (result.error !== undefined) {
  console.error(`typecheck: could not run effect-tsgo: ${String(result.error)}`);
  process.exit(1);
}
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const verdict = typecheckVerdict(result.status, output, cwd, t3Root);
for (const diagnostic of verdict.ours) console.log(diagnostic.text);
if (verdict.t3Errors.length > 0) {
  console.log(`\n${verdict.t3Errors.length} error(s) in t3's own files, which only this program's configuration sees (fragility U10); not failing:`);
  for (const diagnostic of verdict.t3Errors) console.log(diagnostic.text);
}
if (!verdict.ok) {
  if (verdict.reason !== undefined) console.error(`typecheck: ${verdict.reason}\n${output}`);
  process.exit(1);
}
