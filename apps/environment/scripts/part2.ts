// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalTimers:off
// Step 2a part 2's checks on a deployed stage (docs/steps/step-2a-part2-plan.md):
//
//   bun scripts/stage.ts run step2a2 part2 setup            clone the fixture into a Workspace and open a project on it
//   bun scripts/stage.ts run step2a2 part2 ps               the Container's processes (pid, ppid, pgid, sid, args)
//   bun scripts/stage.ts run step2a2 part2 abort            Stop during `nice bash -c 'sleep 600 & sleep 600'`: its processes go
//   bun scripts/stage.ts run step2a2 part2 restart [--session]
//                                                           an Environment restart (or, with --session, a Session restart)
//                                                           while that command runs: its processes go
//   bun scripts/stage.ts run step2a2 part2 survivor         a background process of a completed call survives a later Stop
//   … [--out file.json]
//
// The fixture project is kept in `.alchemy/stages/<host>.part2.json` (gitignored) between runs.
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, base, dispatch, itemsOf, mutateProject, pair, runsOf, sendMessage, SETTLED, sleep, uuid, waitFor, wsCall } from "./lib/client.ts";

const [scenario = "ps"] = process.argv.slice(2);
const flag = (name: string) => process.argv.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1]!;
};
const out = flag("out") ? option("out", "") : undefined;
const MODEL = { instanceId: "piDurable", model: option("model", "anthropic/claude-haiku-5-5"), options: [{ id: "thinking", value: "low" }] };
const report: Record<string, unknown> = { scenario, at: new Date().toISOString(), model: MODEL.model };
const failures: Array<string> = [];
export const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 800)}`);
  return ok;
};
/** The Session's command trace for `threadId` (starts, kills, ends), with times relative to the first entry. */
const traceOf = async (threadId: string) => {
  const entries = ((await admin("GET", `/_t3flare/agents/exec-trace?thread=${threadId}`)).json ?? []) as Array<{ id: string; at: number; event: string; detail?: unknown }>;
  const first = entries[0]?.at ?? 0;
  return entries.map((e) => ({ id: e.id.slice(0, 8), ms: e.at - first, event: e.event, detail: e.detail }));
};

const finish = (): never => {
  report.failures = failures;
  report.ok = failures.length === 0;
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (out) fs.writeFileSync(out, `${text}\n`);
  process.exit(report.ok ? 0 : 1);
};

const fixtureFile = path.resolve(import.meta.dirname, `../.alchemy/stages/${base.host}.part2.json`);
type Fixture = { readonly projectId: string; readonly workspaceId: string; readonly destination: string };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(fixtureFile, "utf8"));

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");
const stamp = Date.now().toString(36);

/** One process of the Container, from `ps`. */
interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly args: string;
}

const exec = async (workspaceId: string, script: string) => {
  const answer = await admin("POST", `/_t3flare/agents/workspace-call?id=${workspaceId}`, { exec: { script, passive: true } });
  return answer.json?.result as { exitCode: number; stdout: string; stderr: string } | undefined;
};

const ps = async (workspaceId: string): Promise<Array<Proc>> => {
  const result = await exec(workspaceId, "ps -eo pid=,ppid=,pgid=,sid=,args=");
  return (result?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [pid, ppid, pgid, sid, ...args] = line.split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), sid: Number(sid), args: args.join(" ") };
    });
};

const threadOn = async (title: string, runtimeMode = "full-access") => {
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId: fixture().projectId,
    title,
    modelSelection: MODEL,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
};

// `nice` sends the whole command to the Container (`sleep` alone would run in the Worker Shell: bash-routing.ts).
const SLEEPER = "nice bash -c 'sleep 600 & sleep 600'";
const SLEEPER_TURN = `Use the bash tool to run exactly this command, once, with no timeout and nothing else: ${SLEEPER}`;
const sleepers = (procs: ReadonlyArray<Proc>) => procs.filter((p) => /^sleep 600$/.test(p.args));

/** Sends the sleeper turn and waits until its two `sleep 600` run: the run, and the processes of the call. */
const startSleeper = async (threadId: string) => {
  await sendMessage(cookie, threadId, SLEEPER_TURN, MODEL);
  const running = await waitFor(
    cookie,
    threadId,
    (p) => itemsOf(p).some((i: any) => i.type === "command_execution" && i.status === "running" && /sleep 600/.test(String(i.input))),
    180_000,
  );
  const runId = runsOf(running.projection).find((r) => r.status === "running")?.id ?? "";
  let procs: Array<Proc> = [];
  for (let i = 0; i < 20 && sleepers(procs).length < 2; i++) {
    await sleep(1000);
    procs = await ps(fixture().workspaceId);
  }
  const call = sleepers(procs);
  // The call's tree: each sleep, its parents up to computerd's child.
  const tree = new Map<number, Proc>();
  for (const s of call) {
    let at: Proc | undefined = s;
    while (at !== undefined && !tree.has(at.pid) && !/computerd|cloudpid-supervise/.test(at.args) && at.pid !== 1) {
      tree.set(at.pid, at);
      at = procs.find((p) => p.pid === at!.ppid);
    }
  }
  return { runId, call, tree: [...tree.values()], all: procs };
};

/** Polls `ps` until none of `pids` is alive or `ms` passes: the seconds it took, or null. */
const goneWithin = async (pids: ReadonlyArray<number>, ms: number) => {
  const started = Date.now();
  let left: Array<Proc> = [];
  while (Date.now() - started < ms) {
    left = (await ps(fixture().workspaceId)).filter((p) => pids.includes(p.pid));
    if (left.length === 0) return { seconds: Math.round((Date.now() - started) / 100) / 10, left };
    await sleep(500);
  }
  return { seconds: null, left };
};

switch (scenario) {
  case "setup": {
    await wsCall(cookie, "server.updateSettings", {
      patch: {},
      providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
    });
    const id = `part2-${stamp}`;
    const destination = `/w/${id}`;
    const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", {
      remoteUrl: `https://github.com/${process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture"}.git`,
      destinationPath: destination,
    })) as { cwd?: string };
    const projectId = uuid();
    await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: destination, createWorkspaceRootIfMissing: false });
    fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
    fs.writeFileSync(fixtureFile, JSON.stringify({ projectId, workspaceId: id, destination }));
    report.setup = { projectId, workspaceId: id, cloned: cloned.cwd === destination };
    check("cloned", cloned.cwd === destination, cloned);
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "ps": {
    report.ps = await ps(fixture().workspaceId);
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "abort": {
    const threadId = await threadOn(`abort ${stamp}`);
    const started = await startSleeper(threadId);
    report.before = { call: started.call, tree: started.tree };
    check("the call's two sleeps ran", started.call.length === 2, started.all);
    await dispatch(cookie, { type: "run.interrupt", commandId: uuid(), threadId, runId: started.runId });
    const stoppedAt = Date.now();
    const gone = await goneWithin(started.tree.map((p) => p.pid), 20_000);
    const settled = await waitFor(cookie, threadId, (p) => SETTLED.has(runsOf(p).find((r) => r.id === started.runId)?.status ?? ""), 60_000);
    report.after = { secondsToGone: gone.seconds, left: gone.left, run: runsOf(settled.projection).find((r) => r.id === started.runId)?.status, msToSettle: Date.now() - stoppedAt };
    report.threadId = threadId;
    report.execTrace = await traceOf(threadId);
    check("no process of the call within 3 s of Stop", gone.seconds !== null && gone.seconds <= 3, report.after);
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "restart": {
    const session = flag("session");
    const threadId = await threadOn(`restart ${session ? "session" : "environment"} ${stamp}`);
    const started = await startSleeper(threadId);
    report.before = { call: started.call, tree: started.tree };
    check("the call's two sleeps ran", started.call.length === 2, started.all);
    await sleep(2000);
    if (session) await admin("POST", `/_t3flare/agents/session-restart?thread=${threadId}`);
    else await admin("POST", "/_t3flare/restart");
    const restartedAt = Date.now();
    // The first run ends (an Environment restart cancels it; a Session restart reruns the waiting call, so the run goes
    // on); either way the first call's processes must go.
    const gone = await goneWithin(started.tree.map((p) => p.pid), 150_000);
    report.after = { secondsToGone: gone.seconds, left: gone.left };
    if (!session) {
      const recovered = await waitFor(cookie, threadId, (p) => SETTLED.has(runsOf(p).find((r) => r.id === started.runId)?.status ?? ""), 120_000).catch(() => undefined);
      (report.after as any).firstRun = runsOf(recovered?.projection).find((r) => r.id === started.runId)?.status ?? null;
    }
    (report.after as any).secondsSinceRestart = Math.round((Date.now() - restartedAt) / 1000);
    report.threadId = threadId;
    report.execTrace = await traceOf(threadId);
    check("the first call's processes are gone after the restart", gone.seconds !== null, report.after);
    // Stop whatever the thread runs now (a continuation may run the command again).
    const now = await waitFor(cookie, threadId, () => true, 5000);
    for (const run of runsOf(now.projection).filter((r) => !SETTLED.has(r.status))) {
      await dispatch(cookie, { type: "run.interrupt", commandId: uuid(), threadId, runId: run.id });
    }
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "survivor": {
    const threadId = await threadOn(`survivor ${stamp}`);
    await sendMessage(
      cookie,
      threadId,
      "Use the bash tool to run exactly this command, once, and nothing else: nohup sleep 900 > /dev/null 2>&1 & echo started",
      MODEL,
    );
    const done = await waitFor(cookie, threadId, (p) => runsOf(p).length > 0 && runsOf(p).every((r) => SETTLED.has(r.status)), 180_000);
    const background = (await ps(fixture().workspaceId)).filter((p) => p.args === "sleep 900");
    report.background = background;
    check("the background sleep runs after its call completed", background.length >= 1 && runsOf(done.projection)[0]?.status === "completed", { background, runs: runsOf(done.projection) });
    // A later call is stopped: the earlier call's background process stays.
    const started = await startSleeper(threadId);
    await dispatch(cookie, { type: "run.interrupt", commandId: uuid(), threadId, runId: started.runId });
    await goneWithin(started.tree.map((p) => p.pid), 20_000);
    const after = (await ps(fixture().workspaceId)).filter((p) => background.some((b) => b.pid === p.pid));
    report.afterStop = after;
    check("the completed call's background process survived the later Stop", after.length === background.length, after);
    await exec(fixture().workspaceId, `kill ${background.map((b) => b.pid).join(" ")} 2>/dev/null; true`);
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
