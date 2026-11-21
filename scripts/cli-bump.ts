// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// `pnpm run cli-bump --cli pi|codex|claude`: move one CLI agent's pin in the Workspace image to its newest version and
// prove it (ADR-0037; in-app updates plan D22). `cli-bump.yml` runs it for t3's provider-update button.
//
//   pnpm run cli-bump --cli <cli> [--version <v>] [--commit] [--no-deploy] [--report <file>] [--stage <stage>]
//                                  [--fail-at <step>]
//
//  1. Resolve the newest version (latest only): npm's `@openai/codex` (its versions are Codex's `rust-v*` releases),
//     `@earendil-works/pi-coding-agent`, `@agentclientprotocol/claude-agent-acp`. The pin already there: unchanged, done.
//  2. Edit the pin:
//     - Codex: the Dockerfile's CODEX_VERSION and CODEX_SHA256 (the musl release tarball, downloaded and hashed here),
//       and clis.ts (with the arm64 tarball's hash, which test:docker builds with on an arm64 host);
//     - pi: image/cli's package.json and its npm lock;
//     - Claude: image/claude's package.json (the adapter) and its npm lock; the SDK follows the adapter's range, and
//       Claude Code's version is the SDK's npm `claudeCodeVersion`;
//     - all three: apps/sandbox-image/src/clis.ts (test/cliManifest.test.ts keeps it equal to the Dockerfile and checks
//       it against t3's compatibility manifest).
//  3. `pnpm run check`.
//  4. Deploy the `bump` stage with the new image, its safe mode off, and the acceptance test's core plus that CLI's
//     sub-test. The full test:docker and every CLI's sub-test run in the verify run after the land (D18).
//  5. Report. On any failure the edited files go back; with --commit a passing pin is committed.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { keptReportJson } from "../apps/environment/scripts/lib/modelEndpointSpec.ts";
import { applyCliPin, CLI_PIN_FILES, defaultPinIo, latestPackageOf } from "../apps/environment/scripts/lib/cliPins.ts";
import { isUpdatableCli, pinVersionOf, type UpdatableCli } from "../apps/environment/src/updates/pins.ts";
import { CLIS } from "../apps/sandbox-image/src/clis.ts";

const root = path.resolve(import.meta.dirname, "..");
const environment = path.join(root, "apps/environment");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const reportFile = option("report") ?? path.join(root, "cli-bump-report.json");
const stage = option("stage") ?? "bump";
const failAt = option("fail-at");
const cli = option("cli");
// Every pnpm command belongs to this workspace, never t3code's (AGENTS.md).
process.env.NPM_CONFIG_WORKSPACE_DIR = root;

if (!isUpdatableCli(cli)) {
  console.error("usage: pnpm run cli-bump --cli pi|codex|claude [--version <v>] [--commit] [--no-deploy] [--report <file>]");
  process.exit(2);
}
const which: UpdatableCli = cli;

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly detail?: string;
}
const steps: Array<Step> = [];
const DETAIL_CHARS = 4000;
const LONG_DETAIL_CHARS = 24_000;

const sh = (command: string, commandArgs: Array<string>, cwd: string, options: { quiet?: boolean } = {}) => {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" }, maxBuffer: 256 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!options.quiet) process.stdout.write(output);
  return { ok: result.status === 0, output };
};

const step = async (name: string, run: () => { ok: boolean; detail?: string } | Promise<{ ok: boolean; detail?: string }>, detailChars = DETAIL_CHARS): Promise<boolean> => {
  const started = performance.now();
  console.log(`\n== ${name}`);
  let result: { ok: boolean; detail?: string };
  try {
    result = await run();
  } catch (error) {
    result = { ok: false, detail: String(error) };
  }
  if (failAt !== undefined && name.startsWith(failAt)) result = { ok: false, detail: `forced to fail by --fail-at ${failAt}` };
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  steps.push({ name, ok: result.ok, seconds, ...(result.detail === undefined ? {} : { detail: result.detail.slice(-detailChars) }) });
  console.log(`== ${name}: ${result.ok ? "ok" : "FAILED"} (${seconds} s)`);
  return result.ok;
};

/** The pin now, as the branch names it: Codex's and pi's version, the Claude adapter's. */
const from = pinVersionOf(which, CLIS);
let to: string | undefined = option("version");
let changedTo: Record<string, string> = {};

const finish = (ok: boolean, note?: string): never => {
  const report = {
    ok,
    cli: which,
    gate: "update",
    // The pin as the branch names it, before and after (`from`, `to`).
    from,
    to: to ?? null,
    changed: to !== undefined && to !== from,
    pins: changedTo,
    note: note ?? null,
    at: new Date().toISOString(),
    steps,
    acceptance: fs.existsSync(path.join(environment, "dist/cli-bump-acceptance.json")) ? JSON.parse(fs.readFileSync(path.join(environment, "dist/cli-bump-acceptance.json"), "utf8")) : null,
  };
  fs.writeFileSync(reportFile, `${keptReportJson(report, process.env)}\n`);
  console.log(`\ncli-bump ${ok ? "PASSED" : "FAILED"}: ${which} ${from} → ${to ?? "?"}${note ? ` (${note})` : ""}; report in ${path.relative(root, reportFile)}`);
  for (const s of steps) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.seconds} s)`);
  process.exit(ok ? 0 : 1);
};

const rollback = () => {
  console.log("\n== rolling back the CLI pins");
  sh("git", ["checkout", "--", ...CLI_PIN_FILES], root);
};

const resolved = await step(`resolve ${which}'s newest version`, () => {
  if (to !== undefined) return { ok: true, detail: `given: ${to}` };
  const pkg = latestPackageOf(which);
  to = defaultPinIo.npmView(`${pkg}@latest`, "version") || undefined;
  return to === undefined ? { ok: false, detail: `npm has no latest ${pkg}` } : { ok: true, detail: `${from} → ${to}` };
});
if (!resolved) finish(false);
if (to === from) finish(true, "unchanged: the pin is already the newest version");

const ok =
  (await step(`pin ${which} ${to}`, async () => {
    changedTo = await applyCliPin(root, which, to!);
    return { ok: true, detail: JSON.stringify(changedTo) };
  })) &&
  (await step("check (pnpm run check: patches, typecheck, lint, test; the CLI manifest)", () => {
    const result = sh("pnpm", ["run", "check"], root);
    return { ok: result.ok, detail: result.output };
  })) &&
  (flag("no-deploy") ||
    ((await step(`deploy the ${stage} stage (build, web client, the new Workspace image)`, () => {
      const result = sh(process.execPath, ["scripts/stage.ts", "deploy", stage, "--web"], environment);
      return { ok: result.ok, detail: result.output };
    })) &&
      (await step(`the ${stage} stage starts its new build fresh (safe mode off)`, () => {
        let output = "";
        for (let attempt = 0; attempt < 12; attempt++) {
          if (attempt > 0) spawnSync("sleep", ["5"]);
          const result = sh(process.execPath, ["scripts/stage.ts", "run", stage, "admin", "POST", "/_t3flare/safe-mode?on=0"], environment);
          output = result.output;
          if (result.ok && /^200 /m.test(output)) return { ok: true, detail: `attempt ${attempt + 1}: ${output}` };
        }
        return { ok: false, detail: output };
      })) &&
      (await step(
        `acceptance test against the ${stage} stage (core and ${which})`,
        () => {
          const out = path.join(environment, "dist/cli-bump-acceptance.json");
          fs.rmSync(out, { force: true });
          const result = sh(process.execPath, ["scripts/stage.ts", "run", stage, "acceptance", "--threads", "12", "--runs", "4", `--${which}`, "--out", out], environment, { quiet: true });
          return { ok: result.ok, detail: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : result.output };
        },
        LONG_DETAIL_CHARS,
      ))));

if (!ok) {
  rollback();
  finish(false, "pin unchanged");
}

if (flag("commit")) {
  await step("commit the new pin", () => {
    const add = sh("git", ["add", ...CLI_PIN_FILES], root);
    const commit = sh("git", ["commit", "--quiet", "-m", `chore: bump ${which} to ${to}`, "-m", "Proven by the update gate."], root);
    return { ok: add.ok && commit.ok, detail: commit.output };
  });
}
finish(true);
