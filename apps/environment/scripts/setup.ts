// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 2b M3: setup scripts in worktree threads, through t3's own RPCs (a headless stock-protocol client):
//
//   bun scripts/stage.ts run <stage> setup launch --project <project id> --workspace <project Workspace id>
//       --command '<setup command>' [--blocking] [--settle '<settle command>'] [--out file.json]
//
// Sets the project's scripts (t3's `project.update`, what Settings → project scripts writes), launches a thread in
// "New worktree" mode (`message.dispatch` with a worktree workspace strategy, what the composer sends), follows the
// launch, and reads the setup terminal's scrollback (`terminal.attach` with `resume`) and the worktree's files.
import * as fs from "node:fs";

import { admin, DEFAULT_MODEL, dispatch, pair, projectionOf, runsOf, sleep, threadWindow, updateSettings, uuid, wsFirst } from "./lib/client.ts";
import { attachTerminal, stripAnsi } from "./lib/terminal.ts";

const [scenario = "launch", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const report: Record<string, unknown> = { scenario, at: new Date().toISOString() };
const failures: Array<string> = [];
const _check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 500)}`}`);
  return ok;
};
const cookie = await pair();

const readDoText = async (id: string, path: string): Promise<string | null> => {
  const read = await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, { fs: { op: "read", path } });
  const ok = read.json?.result?.ok;
  if (ok === undefined || ok === null) return null;
  return typeof ok === "string" ? ok : Buffer.from(Object.values(ok as Record<string, number>)).toString("utf8");
};

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

if (scenario === "launch") {
  const projectId = arg("project")!;
  const workspace = arg("workspace")!;
  const command = arg("command")!;
  const blocking = args.includes("--blocking");
  const settle = arg("settle");
  report.command = command;
  report.async = !blocking;
  // Where t3's project settings keep scripts now (`projectSettingsOverrides[<project>].defaultProjectScripts`; the
  // project's own `scripts` are folded into it once).
  const scripts = [
    { id: "setup", name: "Setup", command, icon: "configure", runOnWorktreeCreate: true, ...(blocking ? { async: false } : {}) },
    ...(settle === undefined ? [] : [{ id: "settle", name: "Settle", command: settle, icon: "configure", runOnWorktreeCreate: false, runOnSettle: true }]),
  ];
  await updateSettings(cookie, { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: scripts } } });
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title: `setup ${Date.now().toString(36)}`,
    modelSelection: DEFAULT_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  report.threadId = threadId;
  const started = Date.now();
  await dispatch(cookie, {
    type: "message.dispatch",
    commandId: uuid(),
    threadId,
    messageId: uuid(),
    text: "Reply with the single word done.",
    attachments: [],
    modelSelection: DEFAULT_MODEL,
    dispatchMode: { type: "defer_start", workspaceStrategy: { type: "worktree", baseRef: "main" } },
    createdBy: "user",
    creationSource: "web",
  });
  let projection: any;
  let worktreePath: string | null = null;
  const timeline: Array<string> = [];
  while (Date.now() - started < 6 * 60_000) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    worktreePath ??= projection?.thread?.worktreePath ?? projection?.worktreePath ?? null;
    const run = runsOf(projection).at(-1) as any;
    const line = `${run?.status ?? "-"} ${worktreePath ?? "-"}`;
    if (timeline.at(-1)?.slice(timeline.at(-1)!.indexOf(" ") + 1) !== line) timeline.push(`${Math.round((Date.now() - started) / 1000)}s ${line}`);
    if (run !== undefined && ["completed", "failed", "interrupted", "cancelled"].includes(run.status)) break;
    await sleep(2000);
  }
  report.timeline = timeline;
  const run = runsOf(projection).at(-1) as any;
  report.run = { status: run?.status, failure: run?.failure ?? run?.error ?? null };
  report.worktreePath = worktreePath;
  // The setup terminal's scrollback, as the client's terminal drawer shows it.
  const terminal = await attachTerminal(cookie, { threadId, terminalId: "setup-setup", resume: true }).catch(() => undefined);
  await sleep(3000);
  report.setupTerminal = terminal === undefined ? null : stripAnsi(terminal.output()).split("\n").filter((line) => line.trim() !== "").slice(0, 30);
  report.setupTerminalEvents = terminal?.events.map((e) => e.event.type).slice(0, 10) ?? null;
  await terminal?.detach();
  if (worktreePath !== null) {
    const id = worktreePath.replace(/^\/w\//, "");
    report.envInWorktree = await readDoText(id, "/workspace/repo/.env");
    report.viewInWorktree = await readDoText(id, "/workspace/.t3flare/project-root/.env");
  }
  // What t3 recorded about the setup stage (the thread's activities / turn items mentioning setup).
  report.setupItems = JSON.stringify(projection ?? {})
    .match(/"[^"]*[Ss]etup[^"]*"/g)
    ?.filter((text) => /exit|fail|script|setup-script|Setup script/.test(text))
    .slice(0, 12) ?? [];
  report.workspace = workspace;
}

report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
const out = arg("out");
if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
console.log(text);
process.exit(0);
