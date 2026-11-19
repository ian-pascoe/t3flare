// `pnpm run bump`: move t3code to its newest nightly tag and prove it on a deployed stage (ADR-0017).
//
//   pnpm run bump [--tag <tag>] [--skip-if-current] [--commit] [--destroy] [--report <file>]
//                 [--gate full|update]   which gate proves the pin (ADR-0037; default full)
//                 [--stage <stage>]      deploy and test this throwaway stage instead of `bump`
//                 [--no-deploy]          stop after the check: no Docker, deploy or acceptance (no secrets needed)
//                 [--fail-at <step>]     fail the step whose name starts so, to prove the rollback
//
//  1. Find the newest `v*-nightly.<yyyymmdd>.<run>` tag on t3code's origin (or take --tag).
//  2. Move the submodule to it.
//  3. Regenerate the workspace and the lock from t3's pnpm-workspace.yaml and pnpm-lock.yaml (scripts/relock.ts), and
//     check that t3's importers install exactly what t3's lock installs, with a single `effect` (ADR-0030).
//  4. `pnpm run check`, the whole of it: every Patch applies (`git apply --check`), typecheck, lint, tests.
//  5. `test:docker` (step 4a): the pinned CLIs in Docker, launched by our profiles against the new t3, on a stand-in
//     model relay (the real-model turns are the acceptance test's, on the stage's Model endpoint).
//  6. Build the Worker and the web client, deploy the `bump` stage, turn its safe mode off (a new build starts fresh),
//     and run the acceptance test against it
//     (scripts/acceptance.ts: pairing, a /ws client, turn-item fixtures and t3's heavy queries, and since step 2a
//     `--real-turn`: a Durable agent turn on a fresh clone of the fixture, both Workers and the Container image;
//     `--terminal --worktree` (step 2b): a terminal, a worktree thread's setup script, its removal, the sweep's dry run;
//     `--peer` (step 3): a Peer link from the harness, a forwarded launch, the link fence F1–F12; `--codex --pi`
//     (step 4a): a Codex and a Pi turn with approvals, resumed after their Containers stopped), then a stock t3
//     from npm at its newest nightly as the laptop: it links to the stage and forwards a launch (version skew, review C6).
//     On the Full gate a failed acceptance test runs once more; a pass on the second attempt still passes, and the report's
//     `acceptanceRetry` keeps the first attempt's failures (a pass that may be luck: the PR says so, U18).
//
// The Update gate (`--gate update`, in-app updates plan D4; about 5 minutes): what a stock client's Update waits on. It
// keeps steps 3, 4 and 6 with the acceptance test's core (pairing, /ws, the SQL adapter, the heavy queries, the boot
// twice in one isolate, migrations on the stage's database) and `--real-turn`'s one Durable agent turn, and drops
// test:docker, the CLI turns, terminal and worktree, the Peer link and its fence, and the stock npm nightly's link. The
// Full gate (the default) is all of it; a landed Update gets the Full gate afterwards as its verify run (D18).
//
//  7. Report. On any failure the submodule and PINNED_FILES go back to the last good pin and a frozen install
//     restores node_modules, so the pin is unchanged (the report's `rollback` says whether that worked); on success
//     they stay (and are committed with --commit).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DETERMINISTIC_STEPS } from "../apps/environment/scripts/lib/land.ts";
import { keptReportJson } from "../apps/environment/scripts/lib/modelEndpointSpec.ts";
import { T3_ERRORS_COUNT } from "../apps/environment/scripts/lib/typecheckFilter.ts";
import { newestNightly, PINNED_FILES } from "../apps/environment/src/updates/pins.ts";

const root = path.resolve(import.meta.dirname, "..");
const t3 = path.join(root, "t3code");
const environment = path.join(root, "apps/environment");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const reportFile = option("report") ?? path.join(root, "bump-report.json");
const stage = option("stage") ?? "bump";
const failAt = option("fail-at");
const gate = option("gate") ?? "full";
if (gate !== "full" && gate !== "update") {
  console.error(`bump: --gate is full or update, not ${gate}`);
  process.exit(2);
}
const fullGate = gate === "full";
/** The acceptance test's arguments for the gate: the Update gate keeps the core and one Durable agent turn. */
const ACCEPTANCE_ARGS = {
  full: ["--threads", "12", "--runs", "4", "--real-turn", "--terminal", "--worktree", "--peer", "--codex", "--pi", "--claude", "--opencode"],
  update: ["--threads", "12", "--runs", "4", "--real-turn"],
} as const;
// Every pnpm command belongs to this workspace, never t3code's (AGENTS.md; review M3).
process.env.NPM_CONFIG_WORKSPACE_DIR = root;

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly detail?: string;
}

const steps: Array<Step> = [];
/** The tail of a failed step's output the report keeps. */
const DETAIL_CHARS = 4000;
/** test:docker's and the acceptance test's failures each carry a long record; 4000 characters held barely one. */
const LONG_DETAIL_CHARS = 24_000;

const sh = (command: string, commandArgs: Array<string>, cwd: string, options: { quiet?: boolean; env?: Record<string, string> } = {}) => {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", ...options.env },
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!options.quiet) process.stdout.write(output);
  return { ok: result.status === 0, output };
};

const step = (name: string, run: () => { ok: boolean; detail?: string }, detailChars = DETAIL_CHARS): boolean => {
  const started = performance.now();
  console.log(`\n== ${name}`);
  let result: { ok: boolean; detail?: string };
  try {
    result = run();
  } catch (error) {
    result = { ok: false, detail: String(error) };
  }
  if (failAt !== undefined && name.startsWith(failAt)) result = { ok: false, detail: `forced to fail by --fail-at ${failAt}` };
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  steps.push({ name, ok: result.ok, seconds, ...(result.detail === undefined ? {} : { detail: result.detail.slice(-detailChars) }) });
  console.log(`== ${name}: ${result.ok ? "ok" : "FAILED"} (${seconds} s)`);
  return result.ok;
};


let lockLine: string | undefined;
/** The descriptor flags the new pin has and `capabilities.ts` does not classify: stripped until classified (U4). */
let unclassifiedCapabilities: Array<string> | undefined;
/** Type errors in t3's own files the typecheck passed over (U10): not ours to fix, but a new one is worth a look. */
let t3TypeErrors: number | undefined;
/** The first acceptance attempt's result, when it failed and a second ran. */
let acceptanceRetry: { readonly firstFailures: unknown; readonly firstDetail: string } | undefined;
let rollbackResult: { ok: boolean; t3code: string; pinnedFiles: string; install: string } | undefined;
const from = sh("git", ["describe", "--tags", "--exact-match", "HEAD"], t3, { quiet: true }).output.trim() || sh("git", ["rev-parse", "HEAD"], t3, { quiet: true }).output.trim();
const fromCommit = sh("git", ["rev-parse", "HEAD"], t3, { quiet: true }).output.trim();
/** The commit of t3flare this run tested: the plan job skips an hourly retry of a failure nothing has changed since. */
const base = sh("git", ["rev-parse", "HEAD"], root, { quiet: true }).output.trim();

let to: string | undefined;
step("find the newest nightly tag", () => {
  const fetched = sh("git", ["fetch", "--tags", "--force", "--quiet", "origin"], t3, { quiet: true });
  if (!fetched.ok) return { ok: false, detail: fetched.output };
  to = option("tag") ?? newestNightly(sh("git", ["tag", "-l", "v*-nightly.*"], t3, { quiet: true }).output.split("\n").map((t) => t.trim()));
  return to === undefined ? { ok: false, detail: "no nightly tag" } : { ok: true, detail: `${from} → ${to}` };
});

const finish = (ok: boolean, note?: string) => {
  const report = {
    ok,
    gate,
    base,
    from,
    to: to ?? null,
    changed: to !== undefined && to !== from,
    note: note ?? null,
    at: new Date().toISOString(),
    steps,
    acceptance: fs.existsSync(path.join(environment, "dist/bump-acceptance.json"))
      ? JSON.parse(fs.readFileSync(path.join(environment, "dist/bump-acceptance.json"), "utf8"))
      : null,
    lock: lockLine ?? null,
    unclassifiedCapabilities: unclassifiedCapabilities ?? null,
    t3TypeErrors: t3TypeErrors ?? 0,
    acceptanceRetry: acceptanceRetry ?? null,
    rollback: rollbackResult ?? null,
  };
  // SPI-1175: the report is an artifact; the Model endpoint's key and header values never reach it, even where a step's
  // output repeated one (the workflow masks them in the log, not in files).
  fs.writeFileSync(reportFile, `${keptReportJson(report, process.env)}\n`);
  console.log(`\nbump ${ok ? "PASSED" : "FAILED"}: ${from} → ${to ?? "?"}${note ? ` (${note})` : ""}; report in ${path.relative(root, reportFile)}`);
  for (const s of steps) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.seconds} s)`);
  process.exit(ok ? 0 : 1);
};

if (to === undefined) finish(false);
if (to === from && flag("skip-if-current")) {
  console.log(`t3code is already at the newest nightly, ${to}`);
  finish(true, "already at the newest nightly; nothing deployed");
}

const rollback = () => {
  console.log(`\n== rolling back to ${from}`);
  sh("git", ["checkout", "--quiet", fromCommit], t3);
  sh("git", ["checkout", "--", ...PINNED_FILES], root);
  // The last good pin's lock, as committed: a frozen install must take it as is.
  const install = sh("pnpm", ["install", "--frozen-lockfile"], root, { quiet: true });
  const t3Status = sh("git", ["status", "--porcelain"], t3, { quiet: true }).output.trim();
  const t3Head = sh("git", ["rev-parse", "HEAD"], t3, { quiet: true }).output.trim();
  const pinned = sh("git", ["status", "--porcelain", "--", ...PINNED_FILES], root, { quiet: true }).output.trim();
  rollbackResult = {
    ok: install.ok && t3Status === "" && t3Head === fromCommit && pinned === "",
    t3code: t3Head === fromCommit && t3Status === "" ? `clean at ${from}` : `at ${t3Head}, ${t3Status === "" ? "clean" : "dirty"}`,
    pinnedFiles: pinned === "" ? "unchanged" : pinned,
    install: install.ok ? "frozen install passed" : install.output.slice(-2000),
  };
  console.log(`== rollback ${rollbackResult.ok ? "ok" : "FAILED"}: ${JSON.stringify(rollbackResult)}`);
};

const ok =
  step(`${DETERMINISTIC_STEPS.move} ${to}`, () => {
    const result = sh("git", ["checkout", "--quiet", to!], t3);
    return { ok: result.ok, detail: result.output };
  }) &&
  // gen-workspace, seed-lock, `pnpm install --no-frozen-lockfile` (CI defaults to frozen; review H3). An unused or
  // unappliable patch fails here now (U20, T9).
  step("regenerate the workspace and install", () => {
    const result = sh(process.execPath, ["scripts/relock.ts"], root);
    return { ok: result.ok, detail: result.output };
  }) &&
  step(DETERMINISTIC_STEPS.lock, () => {
    const result = sh(process.execPath, ["scripts/verify-lock.ts"], root);
    lockLine = result.output.split("\n").find((line) => line.startsWith("{"));
    return { ok: result.ok, detail: result.output };
  }) &&
  // The whole check, as prod's deploy runs it (D9; closes U27): the patches apply, typecheck, lint, tests.
  step(DETERMINISTIC_STEPS.check, () => {
    const result = sh("pnpm", ["run", "check"], root);
    const t3Errors = T3_ERRORS_COUNT.exec(result.output)?.[1];
    if (t3Errors !== undefined) t3TypeErrors = Number(t3Errors);
    return { ok: result.ok, detail: result.output };
  }) &&
  // Never fails the bump: a new flag is stripped until classified (U4). The report and the PR name each one.
  step("capability flags not yet classified (stripped until they are)", () => {
    const result = sh(process.execPath, ["scripts/capabilities-unclassified.ts"], environment, { quiet: true });
    try {
      const parsed: unknown = JSON.parse(result.output.trim().split("\n").at(-1) ?? "");
      if (Array.isArray(parsed) && parsed.every((key) => typeof key === "string")) unclassifiedCapabilities = parsed;
    } catch {
      // Unread: the report says null, and the bump goes on.
    }
    return { ok: true, detail: unclassifiedCapabilities === undefined ? `unread: ${result.output.slice(-1000)}` : JSON.stringify(unclassifiedCapabilities) };
  }) &&
  (flag("no-deploy") ||
  (!fullGate || step("the CLI agents in Docker (test:docker: the pinned Codex and pi, launched as the Workspace launches them)", () => {
    // In the log whole, and a long tail in the report.
    const result = sh("pnpm", ["run", "test:docker"], environment);
    return { ok: result.ok, detail: result.output };
  }, LONG_DETAIL_CHARS)) &&
  step(`deploy the ${stage} stage (build, web client)`, () => {
    const result = sh(process.execPath, ["scripts/stage.ts", "deploy", stage, "--web"], environment);
    return { ok: result.ok, detail: result.output };
  }) &&
  // A new build on CI's own stage starts fresh: boots the last build failed (safe mode after three, which only the owner
  // or this turns off; GLOSSARY: Safe mode) say nothing about this one.
  step(`the ${stage} stage starts its new build fresh (safe mode off)`, () => {
    // Just after a deploy the admin routes can refuse for a moment (a 404, as the panel's endpoint save also met): retried.
    let output = "";
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) spawnSync("sleep", ["5"]);
      const result = sh(process.execPath, ["scripts/stage.ts", "run", stage, "admin", "POST", "/_t3flare/safe-mode?on=0"], environment);
      output = result.output;
      if (result.ok && /^200 /m.test(output)) return { ok: true, detail: `attempt ${attempt + 1}: ${output}` };
    }
    return { ok: false, detail: output };
  }) &&
  step(`acceptance test against the ${stage} stage (${gate} gate)`, () => {
    const out = path.join(environment, "dist/bump-acceptance.json");
    const attempt = () => {
      fs.rmSync(out, { force: true });
      return sh(process.execPath, ["scripts/stage.ts", "run", stage, "acceptance", ...ACCEPTANCE_ARGS[gate], "--out", out], environment, { quiet: true });
    };
    let result = attempt();
    // Once more, on the Full gate: most acceptance failures that were not t3's were races and timeouts that passed on the
    // next run. Not on the Update gate, whose run must fail within 20 minutes (D7); the owner can press Update again.
    if (!result.ok && fullGate) {
      const first = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : result.output;
      let firstFailures: unknown = null;
      try {
        firstFailures = (JSON.parse(first) as { failures?: unknown }).failures ?? null;
      } catch {
        // Not the acceptance test's JSON: the detail keeps the output.
      }
      acceptanceRetry = { firstFailures, firstDetail: first.slice(-DETAIL_CHARS) };
      console.log("== acceptance failed; running it once more");
      result = attempt();
    }
    // A failed start answers every route with one line; the boot record says why.
    const health = result.ok ? "" : `\n${sh(process.execPath, ["scripts/stage.ts", "run", stage, "health", "bootRecord,safeMode,runtime"], environment, { quiet: true }).output}`;
    return { ok: result.ok, detail: `${fs.existsSync(out) ? fs.readFileSync(out, "utf8") : result.output}${health}` };
  }, LONG_DETAIL_CHARS) &&
  (!fullGate || step(`a stock t3 nightly from npm links to the ${stage} stage and forwards a launch`, () => {
    // stdout alone, outside the workspace (npm warns about workspaces on stderr there).
    const nightly = (spawnSync("npm", ["view", "t3", "dist-tags.nightly"], { cwd: os.tmpdir(), encoding: "utf8" }).stdout ?? "").trim();
    if (nightly === "") return { ok: false, detail: "npm has no nightly t3" };
    const result = sh(process.execPath, ["scripts/stage.ts", "run", stage, "peer-laptop", "--version", nightly, "--skip-repo", "--out", path.join(environment, "dist/bump-peer-laptop.json")], environment, { quiet: true });
    return { ok: result.ok, detail: `t3@${nightly}\n${result.output.slice(-3000)}` };
  })));

if (!ok) {
  rollback();
  finish(false, "pin unchanged");
}

if (flag("destroy") && !flag("no-deploy")) {
  step(`destroy the ${stage} stage`, () => sh(process.execPath, ["scripts/stage.ts", "destroy", stage], environment));
}

if (flag("commit") && to !== from) {
  step("commit the new pin", () => {
    const add = sh("git", ["add", "t3code", ...PINNED_FILES], root);
    const notes = [
      `Proven by the ${gate} gate${acceptanceRetry === undefined ? "" : ", the acceptance test passing on its second attempt"}.`,
      ...(unclassifiedCapabilities !== undefined && unclassifiedCapabilities.length > 0
        ? [`Capability flags stripped until classified in apps/environment/src/t3/capabilities.ts: ${unclassifiedCapabilities.join(", ")}.`]
        : []),
      ...(t3TypeErrors !== undefined && t3TypeErrors > 0 ? [`The typecheck passed over ${t3TypeErrors} type error(s) in t3's own files (fragility U10).`] : []),
    ];
    const commit = sh("git", ["commit", "--quiet", "-m", `chore: bump t3code to ${to}`, ...notes.flatMap((note) => ["-m", note])], root);
    return { ok: add.ok && commit.ok, detail: commit.output };
  });
}
finish(true, to === from ? `already at the newest nightly; re-proved${flag("no-deploy") ? " through the check" : ` on the ${stage} stage`}` : undefined);
