// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// Step 2a M3's deployed checks (tools, approvals, diffs) on the fixture Workspace, through t3's own commands, as the
// web client sends them:
//
//   bun scripts/stage.ts run step2a m3 approve      edit + `bash test.sh` in approval-required, every call approved
//   bun scripts/stage.ts run step2a m3 decline      a `bash` call declined with feedback: the tool returns the decline
//   bun scripts/stage.ts run step2a m3 question     a question-only turn with the Container stopped: it stays stopped
//   bun scripts/stage.ts run step2a m3 edit-only    an edit-only turn (full-access), then status reads: Container stays stopped
//   bun scripts/stage.ts run step2a m3 wait [--minutes 7]  an approval waits through a Session restart and >5 heartbeats
//
// Each prints a JSON report (also written to /tmp/m3-<check>.json).
import * as fs from "node:fs";

import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid } from "./lib/client.ts";

const FIXTURE_PROJECT = process.env.T3FLARE_FIXTURE_PROJECT ?? "945fed9f-4b65-4c0d-89a1-cae2ef93839f";
const WORKSPACE = "t3flare-fixture";
const MODEL = { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5", options: [{ id: "thinking", value: "low" }] };

const [check = "approve", ...flags] = process.argv.slice(2);
const minutes = Number(flags[flags.indexOf("--minutes") + 1] ?? 7);

const cookie = await pair();

const newThread = async (title: string, runtimeMode: string) => {
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId: FIXTURE_PROJECT,
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

const container = async () => {
  const { json } = await admin("GET", "/_t3flare/agents/workspaces");
  return json.workspaces.find((ws: any) => ws.id === WORKSPACE)?.container;
};

const projection = async (threadId: string) => projectionOf(await threadWindow(cookie, threadId));
const pending = (p: any) => (p?.runtimeRequests ?? []).filter((request: any) => request.status === "pending");
const settled = (p: any) => {
  const runs = runsOf(p);
  return runs.length > 0 && runs.every((run) => SETTLED.has(run.status));
};

/** Runs a turn, answering each approval with `answer(request)` (undefined: leave it waiting), until it settles. */
const runTurn = async (
  threadId: string,
  text: string | null,
  answer: (request: any, item: any) => { decision: string; feedback?: string } | undefined,
  timeoutMs = 300_000,
) => {
  if (text !== null) await sendMessage(cookie, threadId, text, MODEL);
  const started = Date.now();
  const answered = new Map<string, { decision: string; at: number; prompt: string | null }>();
  let last: any;
  while (Date.now() - started < timeoutMs) {
    last = await projection(threadId);
    for (const request of pending(last)) {
      if (answered.has(request.id)) continue;
      const item = itemsOf(last).find((candidate: any) => candidate.type === "approval_request" && candidate.requestId === request.id);
      const response = answer(request, item);
      if (response === undefined) continue;
      answered.set(request.id, { decision: response.decision, at: Date.now() - started, prompt: item?.prompt ?? null });
      await dispatch(cookie, {
        type: "runtime-request.respond",
        commandId: uuid(),
        threadId,
        requestId: request.id,
        decision: response.decision,
        ...(response.feedback === undefined ? {} : { feedback: response.feedback }),
      });
    }
    if (settled(last) && pending(last).length === 0 && runsOf(last).length > 0) break;
    await sleep(1500);
  }
  return { projection: last, answered: Object.fromEntries(answered), ms: Date.now() - started };
};

const toolItems = (p: any) =>
  itemsOf(p)
    .filter((item: any) => ["command_execution", "file_change", "dynamic_tool", "approval_request"].includes(item.type))
    .map((item: any) => ({
      type: item.type,
      status: item.status,
      title: item.title,
      ...(item.type === "command_execution" ? { input: item.input, exitCode: item.exitCode, output: String(item.output ?? "").slice(0, 600) } : {}),
      ...(item.type === "file_change" ? { fileName: item.fileName, diffStr: String(item.diffStr ?? "").slice(0, 800) } : {}),
      ...(item.type === "dynamic_tool" ? { toolName: item.toolName, input: item.input } : {}),
      ...(item.type === "approval_request" ? { requestKind: item.requestKind, prompt: item.prompt } : {}),
    }));

const assistantText = (p: any) =>
  itemsOf(p)
    .filter((item: any) => item.type === "assistant_message")
    .map((item: any) => item.text)
    .join("\n")
    .slice(0, 2000);

const report = async (name: string, body: Record<string, unknown>) => {
  const out = { check: name, at: new Date().toISOString(), ...body };
  fs.writeFileSync(`/tmp/m3-${name}.json`, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
};

const checkpoints = async () => (await admin("GET", "/_t3flare/agents/checkpoint-trace?clear=1")).json.entries;
const routerTrace = async () => (await admin("GET", "/_t3flare/agents/router-trace?clear=1")).json.entries;

switch (check) {
  case "approve": {
    await checkpoints();
    const threadId = await newThread("m3 approve", "approval-required");
    const turn = await runTurn(
      threadId,
      "In src/greeting.txt, add a new last line saying exactly `Hello from M3.` using the edit tool. Then run `bash test.sh` and tell me in one sentence whether it passed.",
      () => ({ decision: "accept" }),
    );
    await report("approve", {
      threadId,
      runs: runsOf(turn.projection).map((run) => ({ id: run.id, status: run.status })),
      answered: turn.answered,
      runtimeRequests: (turn.projection?.runtimeRequests ?? []).map((request: any) => ({ id: request.id, kind: request.kind, status: request.status, decision: request.decision })),
      tools: toolItems(turn.projection),
      answer: assistantText(turn.projection),
      checkpoints: await checkpoints(),
      container: await container(),
      ms: turn.ms,
    });
    break;
  }
  case "decline": {
    const threadId = await newThread("m3 decline", "approval-required");
    const turn = await runTurn(
      threadId,
      "Run `echo m3-decline-check` with the bash tool, then tell me what happened in one sentence.",
      () => ({ decision: "decline", feedback: "Not now, M3 decline check." }),
    );
    await report("decline", {
      threadId,
      runs: runsOf(turn.projection).map((run) => ({ id: run.id, status: run.status })),
      answered: turn.answered,
      runtimeRequests: (turn.projection?.runtimeRequests ?? []).map((request: any) => ({ id: request.id, kind: request.kind, status: request.status, decision: request.decision, feedback: request.feedback })),
      tools: toolItems(turn.projection),
      answer: assistantText(turn.projection),
      ms: turn.ms,
    });
    break;
  }
  case "question":
  case "edit-only": {
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
    const before = await container();
    await checkpoints();
    await routerTrace();
    const threadId = await newThread(`m3 ${check}`, "full-access");
    const text =
      check === "question"
        ? "What does src/add.sh do? Read it and answer in one sentence. Do not run any commands."
        : "Using the edit tool only (no bash), append a new last line `Edited by the M3 edit-only check.` to README.md. Do not run any commands.";
    const turn = await runTurn(threadId, text, () => ({ decision: "accept" }));
    // A client watching status: the passive reads t3 makes for the thread's project, through the router.
    const statusReads = [];
    for (let poll = 0; poll < 3; poll++) {
      await threadWindow(cookie, threadId);
      await sleep(5000);
      statusReads.push(await container());
    }
    const trace = await routerTrace();
    await report(check, {
      threadId,
      runs: runsOf(turn.projection).map((run) => ({ id: run.id, status: run.status })),
      tools: toolItems(turn.projection),
      answer: assistantText(turn.projection),
      containerBefore: before,
      containerAfter: await container(),
      statusReads,
      checkpoints: await checkpoints(),
      router: trace.map((entry: any) => ({ argv: entry.argv?.join(" ").slice(0, 160), route: entry.route, detail: entry.detail })),
      ms: turn.ms,
    });
    break;
  }
  case "wait": {
    const threadId = await newThread("m3 wait", "approval-required");
    await sendMessage(cookie, threadId, "Run `echo m3-wait-check` with the bash tool and tell me its output.", MODEL);
    const started = Date.now();
    let request: any;
    while (request === undefined && Date.now() - started < 180_000) {
      request = pending(await projection(threadId))[0];
      if (request === undefined) await sleep(1500);
    }
    if (request === undefined) throw new Error("no approval request appeared");
    const diagBefore = (await admin("GET", `/_t3flare/agents/session-diagnostics?thread=${threadId}`)).json;
    await admin("POST", `/_t3flare/agents/session-restart?thread=${threadId}`);
    const samples = [];
    while (Date.now() - started < minutes * 60_000) {
      await sleep(30_000);
      const p = await projection(threadId);
      // `--quiet`: the Session is left alone (no snapshot calls wake it), so only its own alarm (the heartbeat) does.
      const session = flags.includes("--quiet") ? {} : (await admin("GET", `/_t3flare/agents/session?thread=${threadId}`)).json;
      samples.push({
        t: Math.round((Date.now() - started) / 1000),
        pending: pending(p).map((r: any) => r.id),
        sessionApprovals: (session.approvals ?? []).map((a: any) => a.requestId),
        runs: runsOf(p).map((run) => run.status),
      });
    }
    const diagAfter = (await admin("GET", `/_t3flare/agents/session-diagnostics?thread=${threadId}`)).json;
    const stillPending = pending(await projection(threadId)).find((r: any) => r.id === request.id) !== undefined;
    const turn = await runTurn(threadId, null, () => ({ decision: "accept" }));
    const final = turn.projection;
    await report("wait", {
      threadId,
      requestId: request.id,
      waitedSeconds: Math.round((Date.now() - started) / 1000),
      stillPendingBeforeAnswer: stillPending,
      diagnostics: { before: diagBefore, after: diagAfter },
      samples,
      answered: turn.answered,
      runs: runsOf(final).map((run) => ({ id: run.id, status: run.status })),
      tools: toolItems(final),
      answer: assistantText(final),
    });
    break;
  }
  default:
    console.error(`unknown check ${check}`);
    process.exit(2);
}
