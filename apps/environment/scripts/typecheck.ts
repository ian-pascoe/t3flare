// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// `pnpm --filter @t3flare/environment run typecheck`: `effect-tsgo tsrs --noEmit` over two programs, failing only on
// errors in t3flare's own files (fragility U10, `lib/typecheckFilter.ts`). Errors in t3's files are printed under a
// heading, and pass. The package's program (tsconfig.json) checks src, scripts and the Node tests with Node's types; the
// workerd tests' program (test/tsconfig.workerd.json) checks the `workerd` Vitest project's files with the Workers
// globals, which clash with Node's across the rest, so it owns only those files.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { type Diagnostic, t3ErrorsHeading, typecheckVerdict } from "./lib/typecheckFilter.ts";

const cwd = path.resolve(import.meta.dirname, "..");
const t3Root = path.resolve(cwd, "../../t3code");

const programs: ReadonlyArray<{ readonly project: string; readonly isOurs?: (file: string) => boolean }> = [
  { project: "tsconfig.json" },
  { project: "test/tsconfig.workerd.json", isOurs: (file) => /^test\/(.+\.workerd\.test|workerd\.fixture)\.ts$/.test(file) },
];

let ok = true;
const t3Errors = new Map<string, Diagnostic>();
for (const { project, isOurs } of programs) {
  const result = spawnSync("effect-tsgo", ["tsrs", "--noEmit", "--pretty", "false", "-p", project, ...process.argv.slice(2)], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    console.error(`typecheck: could not run effect-tsgo: ${String(result.error)}`);
    process.exit(1);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const verdict = typecheckVerdict(result.status, output, cwd, t3Root, isOurs);
  for (const diagnostic of verdict.ours) console.log(diagnostic.text);
  for (const diagnostic of verdict.t3Errors) t3Errors.set(diagnostic.text, diagnostic);
  if (verdict.elsewhereErrors.length > 0) {
    console.log(`${project}: ${verdict.elsewhereErrors.length} error(s) in files it does not own, which tsconfig.json checks; not failing.`);
  }
  if (!verdict.ok) {
    ok = false;
    if (verdict.reason !== undefined) console.error(`typecheck (${project}): ${verdict.reason}\n${output}`);
  }
}
if (t3Errors.size > 0) {
  console.log(`\n${t3ErrorsHeading(t3Errors.size)}`);
  for (const diagnostic of t3Errors.values()) console.log(diagnostic.text);
}
if (!ok) process.exit(1);
