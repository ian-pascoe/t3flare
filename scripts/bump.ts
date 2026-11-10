// `bun run bump`: move t3code to its newest nightly tag and prove it on a deployed stage (ADR-0017).
//
//   bun run bump [--tag <tag>] [--skip-if-current] [--commit] [--destroy] [--report <file>]
//
//  1. Find the newest `v*-nightly.<yyyymmdd>.<run>` tag on t3code's origin (or take --tag).
//  2. Move the submodule to it.
//  3. Regenerate the workspace from t3's pnpm-workspace.yaml and pnpm-lock.yaml, install, and check that
//     Bun's resolution matches t3's lock with a single `effect` (ADR-0019).
//  4. `git apply --check` every Patch against the new tree.
//  5. Typecheck, lint and test (`bun run check` minus the patch step already done).
//  6. Build the Worker and the web client, deploy the `bump` stage, and run the acceptance test against it
//     (scripts/acceptance.ts: pairing, a /ws client, turn-item fixtures and t3's heavy queries).
//  7. Report. On any failure the submodule, package.json, bunfig.toml and bun.lock go back to the last good pin,
//     so the pin is unchanged; on success they stay (and are committed with --commit).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const t3 = path.join(root, "t3code");
const environment = path.join(root, "apps/environment");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const reportFile = option("report") ?? path.join(root, "bump-report.json");

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

const PINNED_FILES = ["package.json", "bunfig.toml", "bun.lock", "scripts/lock-pins.report.md"];
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
    lockPins: fs.existsSync(path.join(root, "scripts/lock-pins.report.md"))
      ? fs.readFileSync(path.join(root, "scripts/lock-pins.report.md"), "utf8").split("\n")[1]
      : null,
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
  sh("bun", ["install"], root, { quiet: true });
};

const ok =
  step(`move t3code to ${to}`, () => {
    const result = sh("git", ["checkout", "--quiet", to!], t3);
    return { ok: result.ok, detail: result.output };
  }) &&
  step("regenerate the workspace and install", () => {
    const gen = sh("bun", ["scripts/gen-workspace.ts"], root);
    if (!gen.ok) return { ok: false, detail: gen.output };
    const install = sh("bun", ["install"], root);
    return { ok: install.ok, detail: install.output.split("\n").filter((l) => !l.includes("no longer applies")).join("\n") };
  }) &&
  step("lock matches t3's, one effect", () => {
    const result = sh("bun", ["scripts/verify-lock.ts"], root);
    return { ok: result.ok, detail: result.output };
  }) &&
  step("patches apply (git apply --check)", () => {
    const result = sh("bun", ["build.ts", "--check"], environment);
    return { ok: result.ok, detail: result.output };
  }) &&
  step("typecheck, lint, test", () => {
    const typecheck = sh("bun", ["run", "typecheck"], environment);
    const lint = sh("bun", ["run", "lint"], environment);
    const test = sh("bun", ["run", "test"], environment);
    return { ok: typecheck.ok && lint.ok && test.ok, detail: [typecheck, lint, test].filter((r) => !r.ok).map((r) => r.output).join("\n") };
  }) &&
  step("deploy the bump stage (build, web client)", () => {
    const result = sh("bun", ["scripts/stage.ts", "deploy", "bump", "--web"], environment);
    return { ok: result.ok, detail: result.output };
  }) &&
  step("acceptance test against the bump stage", () => {
    const out = path.join(environment, "dist/bump-acceptance.json");
    fs.rmSync(out, { force: true });
    const result = sh("bun", ["scripts/stage.ts", "run", "bump", "acceptance", "--threads", "12", "--runs", "4", "--out", out], environment, { quiet: true });
    return { ok: result.ok, detail: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : result.output };
  });

if (!ok) {
  rollback();
  finish(false, "pin unchanged");
}

if (flag("destroy")) step("destroy the bump stage", () => sh("bun", ["scripts/stage.ts", "destroy", "bump"], environment));

if (flag("commit") && to !== from) {
  step("commit the new pin", () => {
    const add = sh("git", ["add", "t3code", ...PINNED_FILES], root);
    const commit = sh("git", ["commit", "--quiet", "-m", `chore: bump t3code to ${to}`], root);
    return { ok: add.ok && commit.ok, detail: commit.output };
  });
}
finish(true, to === from ? "already at the newest nightly; re-proved on the bump stage" : undefined);
