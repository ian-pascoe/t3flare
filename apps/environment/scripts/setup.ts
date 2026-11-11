// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 2b M3: setup scripts in worktree threads, through t3's own RPCs (a headless stock-protocol client):
//
//   bun scripts/stage.ts run <stage> setup scripts --project <project id> --command '<setup command>' [--blocking]
//       [--settle '<settle command>']   sets the project's scripts where t3's project settings keep them
//   bun scripts/stage.ts run <stage> setup inspect --thread <thread id> [--out file.json]   a worktree thread launched
//       from the web client: its setup stages (t3's WorktreeSetupTracker), the setup terminal's scrollback, its files
import * as fs from "node:fs";

import { pair, projectionOf, readDoText, sleep, threadWindow, updateSettings, wsFirst } from "./lib/client.ts";
import { attachTerminal, stripAnsi } from "./lib/terminal.ts";

const [scenario = "launch", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const report: Record<string, unknown> = { scenario, at: new Date().toISOString() };
const failures: Array<string> = [];
const cookie = await pair();


if (scenario === "scripts") {
  // Only sets the project's scripts (a thread is then launched from the web client).
  const projectId = arg("project")!;
  const scripts = [
    { id: "setup", name: "Setup", command: arg("command")!, icon: "configure", runOnWorktreeCreate: true, ...(args.includes("--blocking") ? { async: false } : {}) },
    ...(arg("settle") === undefined ? [] : [{ id: "settle", name: "Settle", command: arg("settle")!, icon: "configure", runOnWorktreeCreate: false, runOnSettle: true }]),
  ];
  await updateSettings(cookie, { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: scripts } } });
  report.scripts = scripts;
}

if (scenario === "inspect") {
  // A thread launched from the web client: its worktree, the setup terminal's scrollback, the files the script made.
  const threadId = arg("thread")!;
  const projection = projectionOf(await threadWindow(cookie, threadId));
  const worktreePath: string | null = projection?.thread?.worktreePath ?? projection?.worktreePath ?? null;
  report.threadId = threadId;
  report.worktreePath = worktreePath;
  const terminal = await attachTerminal(cookie, { threadId, terminalId: arg("terminal") ?? "setup-setup", resume: true }).catch(() => undefined);
  await sleep(3000);
  report.setupTerminal = terminal === undefined ? null : stripAnsi(terminal.output()).split("\n").filter((line) => line.trim() !== "").slice(-40);
  await terminal?.detach();
  if (worktreePath !== null) {
    const id = worktreePath.replace(/^\/w\//, "");
    report.envInWorktree = await readDoText(id, "/workspace/repo/.env");
    report.viewInWorktree = await readDoText(id, "/workspace/.t3flare/project-root/.env");
  }
  // t3's own record of the launch's stages (WorktreeSetupTracker), as the thread's setup card shows them.
  report.worktreeSetup = await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch((error: unknown) => String(error).slice(0, 300));
  const text = JSON.stringify(projection ?? {});
  report.setupMentions = [...new Set(text.match(/[^"]{0,80}(?:[Ss]etup script|setup-script|exited with)[^"]{0,120}/g) ?? [])].slice(0, 12);
}

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
const out = arg("out");
if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
console.log(text);
process.exit(0);
