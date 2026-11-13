// `pnpm run bump`: move t3code to its newest nightly tag and prove it on a deployed stage (ADR-0017).
//
//   pnpm run bump [--tag <tag>] [--skip-if-current] [--commit] [--destroy] [--report <file>]
//                 [--stage <stage>]      deploy and test this throwaway stage instead of `bump`
//                 [--no-deploy]          stop after the check: no Docker, deploy or acceptance (no secrets needed)
//                 [--fail-at <step>]     fail the step whose name starts so, to prove the rollback
//
//  1. Find the newest `v*-nightly.<yyyymmdd>.<run>` tag on t3code's origin (or take --tag).
//  2. Move the submodule to it.
//  3. Regenerate the workspace and the lock from t3's pnpm-workspace.yaml and pnpm-lock.yaml (scripts/relock.ts), and
//     check that t3's importers install exactly what t3's lock installs, with a single `effect` (ADR-0030).
//  4. `pnpm run check`, the whole of it: every Patch applies (`git apply --check`), typecheck, lint, tests.
//  5. `test:docker` (step 4a): the pinned Codex and pi in Docker, launched by our profiles and guard against the new
//     t3, on the model proxy.
//  6. Build the Worker and the web client, deploy the `bump` stage, and run the acceptance test against it
//     (scripts/acceptance.ts: pairing, a /ws client, turn-item fixtures and t3's heavy queries, and since step 2a
//     `--real-turn`: a Durable agent turn on a fresh clone of the fixture, both Workers and the Container image;
//     `--terminal --worktree` (step 2b): a terminal, a worktree thread's setup script, its removal, the sweep's dry run;
//     `--peer` (step 3): a Peer link from the harness, a forwarded launch, the link fence F1–F12; `--codex --pi`
//     (step 4a): a Codex and a Pi turn with approvals, resumed after their Containers stopped), then a stock t3
//     from npm at its newest nightly as the laptop: it links to the stage and forwards a launch (version skew, review C6).
//  7. Report. On any failure the submodule and PINNED_FILES go back to the last good pin and a frozen install
//     restores node_modules, so the pin is unchanged (the report's `rollback` says whether that worked); on success
//     they stay (and are committed with --commit).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const t3 = path.join(root, "t3code");
const environment = path.join(root, "apps/environment");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const reportFile = option("report") ?? path.join(root, "bump-report.json");
const stage = option("stage") ?? "bump";
const failAt = option("fail-at");
// Every pnpm command belongs to this workspace, never t3code's (AGENTS.md; review M3).
process.env.NPM_CONFIG_WORKSPACE_DIR = root;

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly detail?: string;
}

const steps: Array<Step> = [];

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

const step = (name: string, run: () => { ok: boolean; detail?: string }): boolean => {
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
  steps.push({ name, ok: result.ok, seconds, ...(result.detail === undefined ? {} : { detail: result.detail.slice(-4000) }) });
  console.log(`== ${name}: ${result.ok ? "ok" : "FAILED"} (${seconds} s)`);
  return result.ok;
};

/** `v<version>-nightly.<yyyymmdd>.<run>`, ordered by date then run. */
const NIGHTLY = /^v[\d.]+-nightly\.(\d{8})\.(\d+)$/;
const newestNightly = (tags: Array<string>) =>
  tags
    .filter((tag) => NIGHTLY.test(tag))
    .sort((a, b) => {
      const [, da, ra] = NIGHTLY.exec(a)!;
      const [, db, rb] = NIGHTLY.exec(b)!;
      return da === db ? Number(ra) - Number(rb) : da!.localeCompare(db!);
    })
    .at(-1);

let lockLine: string | undefined;
let rollbackResult: { ok: boolean; t3code: string; pinnedFiles: string; install: string } | undefined;
const PINNED_FILES = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "mise.toml"];
const from = sh("git", ["describe", "--tags", "--exact-match", "HEAD"], t3, { quiet: true }).output.trim() || sh("git", ["rev-parse", "HEAD"], t3, { quiet: true }).output.trim();
const fromCommit = sh("git", ["rev-parse", "HEAD"], t3, { quiet: true }).output.trim();

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
    rollback: rollbackResult ?? null,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
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
  step(`move t3code to ${to}`, () => {
    const result = sh("git", ["checkout", "--quiet", to!], t3);
    return { ok: result.ok, detail: result.output };
  }) &&
  // gen-workspace, seed-lock, `pnpm install --no-frozen-lockfile` (CI defaults to frozen; review H3). An unused or
  // unappliable patch fails here now (U20, T9).
  step("regenerate the workspace and install", () => {
    const result = sh(process.execPath, ["scripts/relock.ts"], root);
    return { ok: result.ok, detail: result.output };
  }) &&
  step("lock matches t3's, one effect", () => {
    const result = sh(process.execPath, ["scripts/verify-lock.ts"], root);
    lockLine = result.output.split("\n").find((line) => line.startsWith("{"));
    return { ok: result.ok, detail: result.output };
  }) &&
  // The whole check, as prod's deploy runs it (D9; closes U27): the patches apply, typecheck, lint, tests.
  step("check (pnpm run check: patches, typecheck, lint, test)", () => {
    const result = sh("pnpm", ["run", "check"], root);
    return { ok: result.ok, detail: result.output.slice(-4000) };
  }) &&
  (flag("no-deploy") ||
  step("the CLI agents in Docker (test:docker: the pinned Codex and pi, launched as the Workspace launches them)", () => {
    const result = sh("pnpm", ["run", "test:docker"], environment, { quiet: true });
    return { ok: result.ok, detail: result.output.slice(-4000) };
  }) &&
  step(`deploy the ${stage} stage (build, web client)`, () => {
    const result = sh(process.execPath, ["scripts/stage.ts", "deploy", stage, "--web"], environment);
    return { ok: result.ok, detail: result.output };
  }) &&
  step(`acceptance test against the ${stage} stage`, () => {
    const out = path.join(environment, "dist/bump-acceptance.json");
    fs.rmSync(out, { force: true });
    const result = sh(process.execPath, ["scripts/stage.ts", "run", stage, "acceptance", "--threads", "12", "--runs", "4", "--real-turn", "--terminal", "--worktree", "--peer", "--codex", "--pi", "--claude", "--opencode", "--out", out], environment, { quiet: true });
    return { ok: result.ok, detail: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : result.output };
  }) &&
  step(`a stock t3 nightly from npm links to the ${stage} stage and forwards a launch`, () => {
    // stdout alone, outside the workspace (npm warns about workspaces on stderr there).
    const nightly = (spawnSync("npm", ["view", "t3", "dist-tags.nightly"], { cwd: os.tmpdir(), encoding: "utf8" }).stdout ?? "").trim();
    if (nightly === "") return { ok: false, detail: "npm has no nightly t3" };
    const result = sh(process.execPath, ["scripts/stage.ts", "run", stage, "peer-laptop", "--version", nightly, "--skip-repo", "--out", path.join(environment, "dist/bump-peer-laptop.json")], environment, { quiet: true });
    return { ok: result.ok, detail: `t3@${nightly}\n${result.output.slice(-3000)}` };
  }));

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
    const commit = sh("git", ["commit", "--quiet", "-m", `chore: bump t3code to ${to}`], root);
    return { ok: add.ok && commit.ok, detail: commit.output };
  });
}
finish(true, to === from ? `already at the newest nightly; re-proved${flag("no-deploy") ? " through the check" : ` on the ${stage} stage`}` : undefined);
