// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// A large repo with a submodule as a project and a worktree thread (the prod bug of 2026-11-11: t3flare itself, whose
// `t3code` submodule has 31,946 files), through t3's own RPCs:
//
//   node scripts/stage.ts run <stage> bigrepo [--repo ian-pascoe/t3flare] [--out <file>]
//
// Clones the repo as a project; launches a worktree thread whose turn checks the submodule out, commits an edit and
// answers; reads status and the diff in the worktree, then the same reads with its Container stopped; removes the
// worktree and checks it was purged; then reads the project's two status shapes (the local poll's, and
// statusDetails') with its Container stopped.
import * as fs from "node:fs";

import { admin, DEFAULT_MODEL, mutateProject, pair, runsOf, SETTLED, sleep, updateSettings, uuid, waitFor, wsCall, wsFirst } from "./lib/client.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const repo = arg("repo") ?? "ian-pascoe/t3flare";
const report: Record<string, unknown> = { repo, at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
};
const cookie = await pair();
// A fresh stage has no configured provider instances, and t3 refuses to launch on an unconfigured non-default one.
await updateSettings(cookie, { providerInstances: { piDurable: { driver: "piDurable", enabled: true } } }).catch((error: unknown) => {
  report.settings = String(error).slice(0, 300);
});
const id = `big-${Date.now().toString(36)}`;
const workspaceCall = async (ws: string, body: unknown) => {
  const started = Date.now();
  // A Workspace DO that cannot answer (reset, or stuck syncing) is a finding, not the end of the run.
  const answer = await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(ws)}`, body).catch((error: unknown) => ({ status: 0, json: { result: { ran: false, detail: String(error).slice(0, 300) } } }));
  return { ms: Date.now() - started, status: answer.status, result: answer.json?.result, container: answer.json?.container };
};
const gitIn = (ws: string, argv: Array<string>, startContainer: boolean) => workspaceCall(ws, { git: { argv, cwd: "/workspace/repo", startContainer } });
const registry = async (ws: string) =>
  (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).find((row) => row.id === ws);
const stop = (ws: string) => admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(ws)}`);
const summary = (answer: Awaited<ReturnType<typeof gitIn>>) => ({
  ms: answer.ms,
  http: answer.status,
  ran: answer.result?.ran,
  exitCode: answer.result?.exitCode,
  stale: answer.result?.stale ?? null,
  reason: answer.result?.reason ?? answer.result?.detail ?? null,
  stdout: typeof answer.result?.stdout === "string" ? answer.result.stdout.replaceAll("\0", "\\0").slice(0, 400) : null,
  running: answer.container?.running,
});
const STATUS = ["status", "--porcelain=2", "--branch", "-z"];
const STATUS_NAB = [...STATUS, "--no-ahead-behind"];
const REVIEW = ["-c", "diff.suppressBlankEmpty=false", "diff", "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", "--minimal", "--numstat", "-z", "HEAD", "--"];

// 1. The project.
let started = Date.now();
const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${repo}.git`, destinationPath: `/w/${id}` }).catch(
  (error: unknown) => ({ error: String(error).slice(0, 500) }),
)) as { cwd?: string; error?: string };
report.clone = { ms: Date.now() - started, ...cloned };
if (!check("clone", cloned.cwd === `/w/${id}`, cloned)) {
  console.log(JSON.stringify({ ok: false, failures, ...report }, null, 2));
  process.exit(1);
}
const projectId = uuid();
await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: `/w/${id}`, createWorkspaceRootIfMissing: false });
report.projectInfo = (await registry(id))?.info;

await gitIn(id, STATUS_NAB, false);

// 2. A worktree thread whose turn checks the submodule out and commits an edit.
const threadId = uuid();
const marker = `bigrepo-${Date.now()}`;
started = Date.now();
await wsCall(cookie, "orchestration.launchThread", {
  commandId: uuid(),
  creationSource: "web",
  threadId,
  projectId,
  title: id,
  generateTitle: false,
  modelSelection: DEFAULT_MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "worktree", baseRef: "main" },
  initialMessage: {
    messageId: uuid(),
    text: [
      "Run exactly these shell commands in one bash call, then reply with the single word done:",
      "git submodule update --init --depth 1 t3code && ls t3code | head -3 &&",
      `echo ${marker} >> README.md && git add README.md && git commit -qm "${marker}" && git status --short | head -5`,
    ].join("\n"),
    attachments: [],
  },
});
let setup: any;
const stageTimes: Record<string, number> = {};
while (Date.now() - started < 10 * 60_000) {
  setup = await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch(() => undefined);
  for (const stage of setup?.stages ?? []) if (["done", "failed", "skipped"].includes(stage.status) && stageTimes[stage.id] === undefined) stageTimes[stage.id] = Date.now() - started;
  if ((setup?.stages ?? []).some((s: any) => s.id === "agent" && s.status !== "pending")) break;
  if (setup?.phase === "failed") break;
  await sleep(1500);
}
const worktreePath: string | null = setup?.worktreePath ?? null;
report.worktreeSetup = { ms: Date.now() - started, path: worktreePath, stages: (setup?.stages ?? []).map((s: any) => `${s.id}:${s.status}`), stageTimes, error: setup?.error ?? null };
const settled = await waitFor(cookie, threadId, (projection) => runsOf(projection).some((run) => SETTLED.has(run.status)), 15 * 60_000).catch((error: unknown) => ({ error: String(error) }));
const runs = "projection" in settled ? runsOf(settled.projection).map((run) => run.status) : settled;
const runTimes = await admin("POST", "/_t3flare/sql", {
  sql: "SELECT json_extract(payload_json, '$.requestedAt') AS requested, json_extract(payload_json, '$.startedAt') AS started, json_extract(payload_json, '$.completedAt') AS completed FROM orchestration_v2_projection_runs WHERE thread_id = ?",
  params: [threadId],
}).catch(() => undefined);
const [requested, runStarted, completed] = (runTimes?.json?.rows?.[0] ?? []) as Array<string | null>;
const msBetween = (from: string | null | undefined, to: string | null | undefined) => (from && to ? Date.parse(to) - Date.parse(from) : null);
report.turn = { msFromLaunch: Date.now() - started, runs, requestToAgentStartMs: msBetween(requested, runStarted), agentRunMs: msBetween(runStarted, completed) };
check("the turn completed", Array.isArray(runs) && runs.includes("completed"), runs);
if (worktreePath === null) {
  check("worktree path", false, setup);
} else {
  const wt = worktreePath.replace(/^\/w\//, "");
  report.worktreeInfo = (await registry(wt))?.info;
  // 3. Status and the diff in the worktree, Container running (real git), then stopped (the stale answers).
  const log = await gitIn(wt, ["log", "--format=%s", "-1"], true);
  check("the turn's commit is in the worktree", String(log.result?.stdout ?? "").includes(marker), summary(log));
  report.running = { status: summary(await gitIn(wt, STATUS_NAB, false)), statusAb: summary(await gitIn(wt, STATUS, false)), review: summary(await gitIn(wt, REVIEW, false)) };
  report.submodule = summary(await gitIn(wt, ["submodule", "status"], true));
  await stop(wt);
  report.stopped = { status: summary(await gitIn(wt, STATUS_NAB, false)), statusAb: summary(await gitIn(wt, STATUS, false)), review: summary(await gitIn(wt, REVIEW, false)) };
  for (const [name, answer] of Object.entries(report.stopped as Record<string, any>)) check(`worktree ${name} answered while stopped`, answer.exitCode === 0 && answer.running === false, answer);
  // 4. The removal: clean (the edit is committed), so its branch is carried home and the Workspace purged.
  started = Date.now();
  const removed = await wsCall(cookie, "vcs.removeWorktree", { cwd: `/w/${id}`, path: worktreePath, force: false }).then(
    () => "removed",
    (error: unknown) => String(error).slice(0, 500),
  );
  const row = await registry(wt);
  report.removal = { ms: Date.now() - started, removed, row: row === undefined ? null : { state: row.state, lastError: row.lastError } };
  check("the worktree was removed and purged", removed === "removed" && row === undefined, report.removal);
  const home = await gitIn(id, ["log", "--format=%s", "-1", "--all", `--grep=${marker}`], true);
  check("the turn's commit was carried home", String(home.result?.stdout ?? "").includes(marker), summary(home));
}
// 5. The project's status while its Container is stopped: both shapes t3 sends (the local poll, and statusDetails').
await stop(id);
report.projectStatusStopped = { noAheadBehind: summary(await gitIn(id, STATUS_NAB, false)), aheadBehind: summary(await gitIn(id, STATUS, false)) };
check("project status (no-ahead-behind) answered while stopped", (report.projectStatusStopped as any).noAheadBehind.exitCode === 0, report.projectStatusStopped);
check("project status (ahead-behind) answered while stopped", (report.projectStatusStopped as any).aheadBehind.exitCode === 0, report.projectStatusStopped);
check("the project's Container stayed stopped", (report.projectStatusStopped as any).aheadBehind.running === false, report.projectStatusStopped);

report.trace = (((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<any>)
  .filter((entry) => entry.ms > 5000 || (entry.exitCode !== 0 && /status|diff/.test(entry.argv.join(" "))))
  .map((entry) => ({ argv: entry.argv.join(" ").slice(0, 120), cwd: entry.cwd, route: entry.route, exitCode: entry.exitCode, ms: entry.ms, detail: String(entry.detail ?? "").slice(0, 300) }));
await mutateProject(cookie, { type: "project.delete", commandId: uuid(), projectId, force: true }).catch(() => undefined);
await admin("POST", `/_t3flare/agents/workspace-remove?id=${id}`);
const out = { ok: failures.length === 0, failures, ...report };
console.log(JSON.stringify(out, null, 2));
const file = arg("out");
if (file !== undefined) fs.writeFileSync(file, JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
