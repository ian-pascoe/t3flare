// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalTimers:off
// Turn liveness and recovery on a deployed stage (step 2a plan, section 3):
//
//   bun scripts/stage.ts run step2a turns liveness   a clientless turn keeps the Environment up; it resets after
//   bun scripts/stage.ts run step2a turns restart [--no-continue]
//                                                    an Environment restart mid-turn continues (or, with continuation
//                                                    off, the Session's turn is aborted as an orphan)
//   bun scripts/stage.ts run step2a turns restart --tools [--approval]
//                                                    (M5) the same with a turn that runs tools in the fixture Workspace
//                                                    (restart while its `bash` runs); with --approval, while an approval
//                                                    waits: no continuation, the turn aborted, the request withdrawn
//   bun scripts/stage.ts run step2a turns deadline   (M5, stage deployed with T3FLARE_TURN_DEADLINE_MS) the turn cap
//   bun scripts/stage.ts run step2a turns lost       a Session that loses its turn: the inverse guard ends it
//   … [--model anthropic/claude-haiku-5-5] [--out file.json]
import * as fs from "node:fs";

import {
  admin,
  createProjectAndThread,
  dispatch,
  uuid,
  DEFAULT_MODEL,
  itemsOf,
  pair,
  runsOf,
  sendMessage,
  SETTLED,
  sleep,
  updateSettings,
  waitFor,
} from "./lib/client.ts";

const [scenario = "liveness"] = process.argv.slice(2);
const flag = (name: string) => process.argv.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1]!;
};
const out = flag("out") ? option("out", "") : undefined;
const model = { ...DEFAULT_MODEL, model: option("model", "anthropic/claude-haiku-5-5") };
const report: Record<string, unknown> = { scenario, at: new Date().toISOString(), model: model.model };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 600)}`);
};
const finish = () => {
  report.failures = failures;
  report.ok = failures.length === 0;
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (out) fs.writeFileSync(out, `${text}\n`);
  process.exit(report.ok ? 0 : 1);
};

const LONG = `Count from 1 to ${option("count", "4000")}, one number per line, nothing else.`;
const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");
const stamp = Date.now().toString(36);

const health = async () => (await admin("GET", "/_t3flare/health")).json;

if (scenario === "liveness") {
  const { threadId } = await createProjectAndThread(cookie, { title: `liveness ${stamp}`, workspaceRoot: `/t3/home/liveness-${stamp}` });
  const constructedAt = (await health()).object?.constructedAt;
  // The socket closed after the send: no client is attached for the rest of the turn.
  await sendMessage(cookie, threadId, LONG, model, { titleSeed: "Counting" });
  const verdicts: Array<{ at: number; why: string; reset: boolean; constructedAt: string | null; runtime: string }> = [];
  const started = Date.now();
  let settledAt: number | null = null;
  let resetAt: number | null = null;
  while (Date.now() - started < 8 * 60_000) {
    const projection = settledAt === null ? await waitFor(cookie, threadId, () => true, 5000).then((r) => r.projection) : undefined;
    const run = projection === undefined ? undefined : runsOf(projection)[0];
    if (settledAt === null && run !== undefined && SETTLED.has(run.status)) settledAt = Date.now();
    const h = await health();
    // While the turn runs, the check ignores the idle delay (`force`), so the verdict is what open work says alone; the
    // Session's pushes also count as requests, which keep the delay from running out. After the turn, the plain check.
    const verdict = await admin("POST", settledAt === null ? "/_t3flare/idle-check?force=1" : "/_t3flare/idle-check");
    verdicts.push({
      at: Math.round((Date.now() - started) / 1000),
      why: verdict.json?.why ?? JSON.stringify(verdict.json).slice(0, 120),
      reset: verdict.json?.reset === true,
      constructedAt: h.object?.constructedAt ?? null,
      runtime: h.runtime,
    });
    if (settledAt !== null && (h.object?.constructedAt !== constructedAt || h.runtime === "stopped")) {
      resetAt = Date.now();
      break;
    }
    await sleep(10_000);
  }
  // Reading the thread to check it pairs a client again: only after the reset.
  const after = await waitFor(cookie, threadId, () => true);
  report.liveness = {
    turnSeconds: settledAt === null ? null : Math.round((settledAt - started) / 1000),
    resetSecondsAfterTurn: settledAt === null || resetAt === null ? null : Math.round((resetAt - settledAt) / 1000),
    run: runsOf(after.projection).map((r) => r.status),
    title: after.projection?.thread?.title,
    verdicts,
  };
  check("the turn completed with no client", runsOf(after.projection)[0]?.status === "completed", report.liveness);
  check("open work for the whole turn", verdicts.filter((v) => settledAt === null || v.at * 1000 < settledAt - started).every((v) => !v.reset && /open work/.test(v.why)), verdicts);
  check("the Environment reset after the turn, not at once", resetAt !== null && settledAt !== null && resetAt - settledAt >= 30_000, report.liveness);
  check("a title was generated", typeof after.projection?.thread?.title === "string" && after.projection.thread.title !== "Counting", after.projection?.thread?.title);
  finish();
}

/** A thread in the fixture Workspace's project (step 2a M3–M5). */
const fixtureThread = async (title: string, runtimeMode: string) => {
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId: process.env.T3FLARE_FIXTURE_PROJECT ?? "945fed9f-4b65-4c0d-89a1-cae2ef93839f",
    title,
    modelSelection: model,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
};

const TOOLS_TURN =
  "Use the bash tool to run `sleep 25 && echo slept`, then read src/add.sh with the read tool, then run `bash test.sh`, and finally tell me in one sentence what add.sh does.";

if (scenario === "restart") {
  const noContinue = flag("no-continue");
  const tools = flag("tools");
  const approval = flag("approval");
  if (noContinue) {
    await updateSettings(cookie, { continueThreadsAfterServerUpdate: false });
  }
  const threadId = tools
    ? await fixtureThread(`restart tools ${stamp}`, approval ? "approval-required" : "full-access")
    : (await createProjectAndThread(cookie, { title: `restart ${stamp}`, workspaceRoot: `/t3/home/restart-${stamp}` })).threadId;
  await sendMessage(cookie, threadId, tools ? TOOLS_TURN : LONG, model);
  // Text turns: restart while the answer streams. Tool turns: while `bash` runs, or while its approval waits.
  const running = await waitFor(
    cookie,
    threadId,
    (p) =>
      runsOf(p).some((r) => r.status === "running") &&
      (!tools ||
        (approval
          ? (p?.runtimeRequests ?? []).some((r: any) => r.status === "pending")
          : itemsOf(p).some((i: any) => i.type === "command_execution" && i.status === "running"))),
    180_000,
  );
  const firstRun = runsOf(running.projection).find((r) => r.status === "running")!.id;
  const pendingRequest = (running.projection?.runtimeRequests ?? []).find((r: any) => r.status === "pending")?.id ?? null;
  await sleep(tools ? 2000 : 3000);
  const before = (await health()).object?.constructedAt;
  await admin("POST", "/_t3flare/restart");
  const restartedAt = Date.now();
  // Recovery: the first run ends; with continuation on, a continuation run follows and completes.
  const recovered = await waitFor(
    cookie,
    threadId,
    (p) => {
      const runs = runsOf(p);
      const first = runs.find((r) => r.id === firstRun);
      if (first === undefined || !SETTLED.has(first.status)) return false;
      if (noContinue || approval) return true;
      const continuation = runs.find((r: any) => r.restartContinuationOfRunId === firstRun);
      return continuation !== undefined && SETTLED.has(continuation.status);
    },
    300_000,
  );
  const runs = runsOf(recovered.projection) as Array<any>;
  const continuation = runs.find((r) => r.restartContinuationOfRunId === firstRun);
  // The Session learns the turn is gone from the answer to its next push (the orphans): at once while it streams, at
  // its next liveness push (60 s) while it waits on a tool or an approval.
  let session: any;
  const sessionWaitStarted = Date.now();
  do {
    await sleep(5000);
    session = (await admin("GET", `/_t3flare/agents/session?thread=${threadId}`)).json;
  } while (
    Object.values(session?.turns ?? {}).some((t: any) => t.status === "running" || t.status === "queued") &&
    Date.now() - sessionWaitStarted < 150_000
  );
  const sessionSettledSeconds = Math.round((Date.now() - restartedAt) / 1000);
  const sessionTurns = Object.values(session?.turns ?? {}) as Array<any>;
  const requestAfter = pendingRequest === null ? null : (recovered.projection?.runtimeRequests ?? []).find((r: any) => r.id === pendingRequest);
  report.restart = {
    noContinue,
    tools,
    approval,
    threadId,
    pendingRequest: pendingRequest === null ? null : { id: pendingRequest.slice(-24), after: requestAfter?.status ?? null, responseCapability: requestAfter?.responseCapability?.type ?? null },
    sessionApprovals: (session?.approvals ?? []).length,
    sessionSettledSeconds,
    toolItems: itemsOf(recovered.projection)
      .filter((i: any) => i.type === "command_execution" || i.type === "dynamic_tool" || i.type === "approval_request")
      .map((i: any) => ({ type: i.type, status: i.status, run: String(i.runId).slice(-12), input: String(i.input ?? i.toolName ?? i.prompt ?? "").slice(0, 60) })),
    objectReset: (await health()).object?.constructedAt !== before,
    secondsToRecover: Math.round((Date.now() - restartedAt) / 1000),
    runs: runs.map((r) => ({ id: r.id.slice(-12), status: r.status, continuationOf: r.restartContinuationOfRunId?.slice(-12) ?? null })),
    sessionTurns: sessionTurns.map((t) => ({ status: t.status, reason: t.reason ?? null })),
    continuationAnswer: itemsOf(recovered.projection)
      .filter((i: any) => i.type === "assistant_message" && i.runId === continuation?.id)
      .map((i: any) => String(i.text).slice(-80)),
    liveSessionTurns: sessionTurns.filter((t) => t.status === "running" || t.status === "queued").length,
  };
  check("the first run ended", SETTLED.has(runs.find((r) => r.id === firstRun)?.status ?? ""), report.restart);
  if (noContinue || approval) check("no continuation", continuation === undefined, report.restart);
  else check("a continuation run completed", continuation?.status === "completed", report.restart);
  if (approval) {
    check("the approval is no longer pending in t3", requestAfter !== undefined && requestAfter.status !== "pending", report.restart);
    check("the Session withdrew the approval", (session?.approvals ?? []).length === 0, report.restart);
  }
  check("the Session's first turn was aborted (no turn left live)", (report.restart as any).liveSessionTurns === 0, report.restart);
  check("the Session's first turn ended aborted", sessionTurns.some((t) => t.status === "aborted"), report.restart);
  if (noContinue) {
    await updateSettings(cookie, { continueThreadsAfterServerUpdate: true });
  }
  finish();
}

if (scenario === "deadline") {
  // Deploy the stage with T3FLARE_TURN_DEADLINE_MS=120000 first (the 2 h cap, shortened).
  const threadId = await fixtureThread(`deadline ${stamp}`, "full-access");
  await sendMessage(cookie, threadId, "Run `sleep 900 && echo done` with the bash tool and tell me when it finishes.", model);
  const running = await waitFor(cookie, threadId, (p) => runsOf(p).some((r) => r.status === "running"), 120_000);
  const runId = runsOf(running.projection).find((r) => r.status === "running")!.id;
  const startedAt = Date.now();
  const ended = await waitFor(cookie, threadId, (p) => SETTLED.has(runsOf(p).find((r) => r.id === runId)?.status ?? ""), 8 * 60_000);
  const run = runsOf(ended.projection).find((r) => r.id === runId);
  const error = itemsOf(ended.projection).find((i: any) => i.type === "error" && i.runId === runId);
  const session = (await admin("GET", `/_t3flare/agents/session?thread=${threadId}`)).json;
  report.deadline = {
    threadId,
    secondsFromRunning: Math.round((Date.now() - startedAt) / 1000),
    status: run?.status,
    error: error?.failure ?? null,
    sessionTurns: Object.values(session?.turns ?? {}).map((t: any) => ({ status: t.status, reason: t.reason ?? null })),
    bash: itemsOf(ended.projection).filter((i: any) => i.type === "command_execution").map((i: any) => ({ status: i.status, input: i.input })),
  };
  check("the run failed at the deadline", run?.status === "failed" && (error?.failure?.code === "turn_deadline"), report.deadline);
  check("the Session's turn was aborted for the deadline", (report.deadline as any).sessionTurns.some((t: any) => t.reason === "turn_deadline"), report.deadline);
  finish();
}

if (scenario === "lost") {
  const { threadId } = await createProjectAndThread(cookie, { title: `lost ${stamp}`, workspaceRoot: `/t3/home/lost-${stamp}` });
  await sendMessage(cookie, threadId, LONG, model);
  const running = await waitFor(cookie, threadId, (p) => runsOf(p).some((r) => r.status === "running"), 60_000);
  const runId = runsOf(running.projection).find((r) => r.status === "running")!.id;
  const dropped = await admin("POST", `/_t3flare/agents/drop-turns?thread=${threadId}`);
  const droppedAt = Date.now();
  const ended = await waitFor(cookie, threadId, (p) => SETTLED.has(runsOf(p).find((r) => r.id === runId)?.status ?? ""), 6 * 60_000);
  const run = runsOf(ended.projection).find((r) => r.id === runId);
  const error = itemsOf(ended.projection).find((i: any) => i.type === "error" && i.runId === runId);
  report.lost = {
    dropped: dropped.json,
    secondsToEnd: Math.round((Date.now() - droppedAt) / 1000),
    status: run?.status,
    error: error?.failure?.message ?? null,
  };
  check("the run ended within 3.5 minutes", Date.now() - droppedAt < 210_000 && SETTLED.has(run?.status ?? ""), report.lost);
  finish();
}

console.error(`unknown scenario ${scenario}`);
process.exit(2);
