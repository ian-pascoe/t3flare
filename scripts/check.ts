// `bun run check`: everything a change must pass, run at once (ADR-0019).
//
//   - patches: every Patch applies to the pinned t3code (`git apply --check`)
//   - lock: Bun's resolution against t3's pnpm lock, and a single `effect`
//   - typecheck: `effect-tsgo tsrs` per package
//   - lint: oxlint, type-aware through tsrslint
//   - test: Vitest on Node, the `node` and `workerd` projects
import { spawn } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const environment = path.join(root, "apps/environment");
const infra = path.join(root, "infra");
const agents = path.join(root, "apps/agents");
const pkg = (name: string) => path.join(root, "packages", name);

interface Task {
  readonly name: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: Array<string>;
}

const tasks: Array<Task> = [
  { name: "patches", cwd: environment, command: "bun", args: ["build.ts", "--check"] },
  { name: "lock", cwd: root, command: "bun", args: ["scripts/verify-lock.ts"] },
  { name: "typecheck", cwd: environment, command: "bun", args: ["run", "typecheck"] },
  { name: "lint", cwd: environment, command: "bun", args: ["run", "lint"] },
  { name: "typecheck (infra)", cwd: infra, command: "bun", args: ["run", "typecheck"] },
  { name: "lint (infra)", cwd: infra, command: "bun", args: ["run", "lint"] },
  { name: "lint (root scripts)", cwd: root, command: path.join(root, "node_modules/.bin/oxlint"), args: ["scripts"] },
  { name: "test", cwd: environment, command: "bun", args: ["run", "test"] },
  { name: "typecheck (agents)", cwd: agents, command: "bun", args: ["run", "typecheck"] },
  { name: "lint (agents)", cwd: agents, command: "bun", args: ["run", "lint"] },
  { name: "test (agents)", cwd: agents, command: "bun", args: ["run", "test"] },
  { name: "test (infra)", cwd: infra, command: "bun", args: ["run", "test"] },
  { name: "typecheck (codemode-sandbox)", cwd: path.join(root, "apps/codemode-sandbox"), command: "bun", args: ["run", "typecheck"] },
  ...["effect-durable", "computer-env", "github-app", "workspace-client", "harness-registry"].flatMap((name): Array<Task> => [
    { name: `typecheck (${name})`, cwd: pkg(name), command: "bun", args: ["run", "typecheck"] },
    { name: `test (${name})`, cwd: pkg(name), command: "bun", args: ["run", "test"] },
  ]),
];

const run = (task: Task) =>
  new Promise<{ task: Task; code: number; output: string; seconds: number }>((resolve) => {
    const started = performance.now();
    const child = spawn(task.command, task.args, { cwd: task.cwd, env: { ...process.env, FORCE_COLOR: "0" } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("close", (code) => resolve({ task, code: code ?? 1, output, seconds: (performance.now() - started) / 1000 }));
  });

const started = performance.now();
const results = await Promise.all(tasks.map(run));
for (const result of results) {
  const mark = result.code === 0 ? "ok  " : "FAIL";
  console.log(`${mark} ${result.task.name} (${result.seconds.toFixed(1)} s)`);
  if (result.code !== 0) console.log(result.output.trim().split("\n").slice(-40).map((line) => `     ${line}`).join("\n"));
}
const failed = results.filter((r) => r.code !== 0).length;
console.log(`${failed === 0 ? "check passed" : `${failed} failed`} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed === 0 ? 0 : 1);
