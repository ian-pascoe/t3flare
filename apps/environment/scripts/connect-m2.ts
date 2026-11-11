// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
// Step 3+ M2 on a linked stage: each way a Durable agent run goes, and what t3 published to T3 Connect for it, read
// from the publish recorder (the relay's own answers). No phone needed; a phone signed in to the account buzzes.
//
//   a complete   a turn that completes, no client socket open
//   b approval   an approval-required bash, answered after 30 s
//   c question   an ask_user question, answered after 30 s
//   d limit      a proxy-fault usage limit
//   e stop       Stop mid-turn
//   f restart    an Environment restart (abort) mid-turn, then completion
//   g off        publishing off, one turn, publishing on again
//   h restart-approval  a restart while an approval waits (review finding 4)
//   i restart-question  a restart while an ask_user question waits (review finding 4)
//   j rejected   the relay's link removed (as the T3 apps' removal), then a turn: the relay refuses (review finding 8);
//                relinked afterwards
//
//   bun scripts/stage.ts run step3plus connect-m2 [--only a,b,…] [--out m2-publishes.json]
import * as path from "node:path";

import { admin, dispatch, mutateProject, pair, runsOf, sleep, updateSettings, uuid } from "./lib/client.ts";
import { createThread, pendingOf, projection, replyOf, say, settled, until } from "./lib/cloudThread.ts";
import { writeEvidence } from "./lib/evidence.ts";

const at = process.argv.indexOf("--only");
const only = at < 0 ? undefined : new Set(process.argv[at + 1]!.split(","));
const wants = (row: string) => only === undefined || only.has(row);
const outAt = process.argv.indexOf("--out");
const outName = outAt < 0 ? "m2-publishes.json" : process.argv[outAt + 1]!;
const stamp = Date.now().toString(36);
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
  return ok;
};

const cookie = await pair();
// A fresh stage has no `piDurable` instance configured, and t3 enables only codex and claudeAgent unconfigured.
await updateSettings(cookie, { providerInstances: { piDurable: { driver: "piDurable", enabled: true } } });
const projectId = uuid();
await mutateProject(cookie, {
  type: "project.create",
  commandId: uuid(),
  projectId,
  title: `connect m2 ${stamp}`,
  workspaceRoot: `/w/connect-m2-${stamp}`,
  createWorkspaceRootIfMissing: true,
});
await admin("POST", "/_t3flare/disarm-bootstrap");

/** The recorder's entries for a thread, once its publishes have landed (t3 holds a completion 5 s). */
const publishes = async (threadId: string, settleMs = 12_000) => {
  await sleep(settleMs);
  const status = (await admin("GET", "/_t3flare/connect/status")).json;
  return ((status?.publishes?.recent ?? []) as Array<any>).filter((entry) => entry.threadId === threadId);
};
const phasesOf = (entries: Array<any>) => entries.filter((e) => e.event === "publishing").map((e) => e.phase);
const accepted = (entries: Array<any>, phase: string) => entries.some((e) => e.event === "completed" && e.phase === phase && e.ok === true);
const out: Record<string, unknown> = {};

const thread = async (title: string, runtimeMode = "full-access") => createThread(cookie, projectId, { title: `${title} ${stamp}`, runtimeMode });
const ASK = (nonce: string) => `Use the ask_user tool to ask me exactly this question: "Which color for ${nonce}?" with options ["red", "blue"]. Then reply with only the color I chose.`;
const questionOf = (p: any) => pendingOf(p).find((request: any) => request.kind === "user_input");
const questionId = (p: any, request: any) => (p?.turnItems ?? []).find((item: any) => item.type === "user_input_request" && item.requestId === request.id)?.questions?.[0]?.id ?? "";
const answer = (threadId: string, request: any, extra: Record<string, unknown>) =>
  dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, ...extra });
const running = (p: any) => runsOf(p).some((run) => run.status === "running");
const restart = async () => {
  await admin("POST", "/_t3flare/restart?mode=abort");
  await sleep(5000);
};

if (wants("a")) {
  const threadId = await thread("m2 a complete");
  await say(cookie, threadId, "Reply with the single word: pong");
  const done = await until(cookie, threadId, settled);
  const entries = await publishes(threadId);
  out.a = { threadId, run: runsOf(done).at(-1)?.status, phases: phasesOf(entries), entries };
  check("a: running then completed published, the relay answering ok", phasesOf(entries).includes("running") && accepted(entries, "completed"), out.a);
}

if (wants("b")) {
  const threadId = await thread("m2 b approval", "approval-required");
  await say(cookie, threadId, "Run the shell command `echo connect-m2` with your bash tool, then reply with its output.");
  const waiting = await until(cookie, threadId, (p) => pendingOf(p).length > 0 || settled(p));
  const request = pendingOf(waiting)[0];
  const before = await publishes(threadId, 3000);
  await sleep(27_000);
  if (request !== undefined) await answer(threadId, request, { decision: "accept" });
  const done = await until(cookie, threadId, settled);
  const entries = await publishes(threadId);
  out.b = { threadId, request: request?.kind ?? null, run: runsOf(done).at(-1)?.status, phases: phasesOf(entries), waitingPublishedBeforeAnswer: phasesOf(before), entries };
  check("b: Approval needed published while it waited", accepted(before, "waiting_for_approval"), out.b);
}

if (wants("c")) {
  const threadId = await thread("m2 c question");
  await say(cookie, threadId, ASK(`c-${stamp}`));
  const waiting = await until(cookie, threadId, (p) => questionOf(p) !== undefined || settled(p));
  const request = questionOf(waiting);
  const before = await publishes(threadId, 3000);
  await sleep(27_000);
  if (request !== undefined) await answer(threadId, request, { answers: { [questionId(waiting, request)]: "blue" } });
  const done = await until(cookie, threadId, settled);
  const entries = await publishes(threadId);
  out.c = { threadId, asked: request !== undefined, reply: replyOf(done).slice(-100), phases: phasesOf(entries), waitingPublishedBeforeAnswer: phasesOf(before), entries };
  check("c: Waiting for input published while it waited", accepted(before, "waiting_for_input"), out.c);
}

if (wants("d")) {
  const threadId = await thread("m2 d limit");
  const fault = (await admin("POST", `/_t3flare/agents/proxy-fault?thread=${threadId}`, { fixture: "cooldown", resetAt: Date.now() + 120_000 })).json;
  await say(cookie, threadId, "Reply with the single word: pong");
  const done = await until(cookie, threadId, settled);
  const entries = await publishes(threadId);
  out.d = { threadId, fault, run: runsOf(done).at(-1)?.status, phases: phasesOf(entries), entries };
  check("d: a usage limit is published as failed (D3)", accepted(entries, "failed"), out.d);
}

if (wants("e")) {
  const threadId = await thread("m2 e stop");
  await say(cookie, threadId, "Run the shell command `sleep 60` with your bash tool, then reply with the word done.");
  // Stop once the bash call is under way, so the run is surely still going.
  const live = await until(cookie, threadId, (p) => (running(p) && (p?.turnItems ?? []).some((item: any) => item.type === "command_execution")) || settled(p));
  const run = runsOf(live).find((r) => r.status === "running");
  const interrupted =
    run === undefined
      ? "not running"
      : await dispatch(cookie, { type: "run.interrupt", commandId: uuid(), threadId, runId: run.id }).then(
          () => "sent",
          (error: unknown) => String(error).slice(0, 200),
        );
  const done = await until(cookie, threadId, settled);
  const entries = await publishes(threadId);
  const alertable = phasesOf(entries).filter((phase) => ["completed", "failed", "waiting_for_approval", "waiting_for_input"].includes(phase));
  out.e = { threadId, interrupted, run: runsOf(done).at(-1)?.status, phases: phasesOf(entries), entries };
  check("e: Stop publishes no alertable phase (running was published)", run !== undefined && phasesOf(entries).includes("running") && alertable.length === 0, out.e);
}

if (wants("f")) {
  const threadId = await thread("m2 f restart");
  await say(cookie, threadId, "Write a 250-word story about a lighthouse keeper, then end with the word done.");
  await until(cookie, threadId, (p) => running(p) || settled(p));
  await sleep(3000);
  const restartedAt = new Date().toISOString();
  await restart();
  const done = await until(cookie, threadId, settled, 300_000);
  const entries = await publishes(threadId);
  out.f = { threadId, restartedAt, runs: runsOf(done).map((r) => r.status), phases: phasesOf(entries), entries };
  check("f: a completed publish after the restart", entries.some((e) => e.event === "completed" && e.phase === "completed" && e.ok === true && e.at > restartedAt), out.f);
}

if (wants("g")) {
  await admin("POST", "/_t3flare/connect/publish?on=0");
  const threadId = await thread("m2 g off");
  await say(cookie, threadId, "Reply with the single word: pong");
  await until(cookie, threadId, settled);
  const entries = await publishes(threadId);
  await admin("POST", "/_t3flare/connect/publish?on=1");
  out.g = { threadId, entries };
  check("g: publishing off sends nothing", entries.filter((e) => e.event === "publishing").length === 0, out.g);
}

for (const [row, kind] of [["h", "approval"], ["i", "question"]] as const) {
  if (!wants(row)) continue;
  const threadId = await thread(`m2 ${row} restart-${kind}`, kind === "approval" ? "approval-required" : "full-access");
  await say(cookie, threadId, kind === "approval" ? "Run the shell command `echo connect-m2` with your bash tool, then reply with its output." : ASK(`${row}-${stamp}`));
  const waiting = await until(cookie, threadId, (p) => pendingOf(p).length > 0 || settled(p));
  await sleep(8000);
  const restartedAt = new Date().toISOString();
  await restart();
  // What t3 and the publisher do on their own after the boot, before anyone answers.
  await sleep(20_000);
  const after = await projection(cookie, threadId).catch(() => undefined);
  const request = pendingOf(after)[0];
  if (request !== undefined) {
    await answer(threadId, request, kind === "approval" ? { decision: "accept" } : { answers: { [questionId(after, request)]: "red" } });
  }
  const done = await until(cookie, threadId, settled, 240_000);
  const entries = await publishes(threadId);
  out[row] = {
    threadId,
    pendingBefore: pendingOf(waiting).map((r: any) => r.kind),
    restartedAt,
    pendingAfterBoot: pendingOf(after).map((r: any) => r.kind),
    runsAfterBoot: runsOf(after).map((r) => r.status),
    answeredAfterBoot: request !== undefined,
    runs: runsOf(done).map((r) => r.status),
    phases: phasesOf(entries),
    publishedAfterBoot: entries.filter((e) => e.at > restartedAt).map((e) => `${e.event}:${e.phase ?? ""}`),
    entries,
  };
  console.log(`${row}: ${JSON.stringify({ ...(out[row] as object), entries: undefined })}`);
}

if (wants("j")) {
  const removed = (await admin("POST", "/_t3flare/connect/fault/relay-unlink")).json;
  const threadId = await thread("m2 j rejected");
  await say(cookie, threadId, "Reply with the single word: pong");
  await until(cookie, threadId, settled);
  const entries = await publishes(threadId, 45_000);
  const status = (await admin("GET", "/_t3flare/connect/status")).json;
  const relinked = (await admin("POST", "/_t3flare/connect/relink")).json;
  out.j = { removed, threadId, entries, summary: { rejected: status?.publishes?.rejected, lastFailure: status?.publishes?.lastFailure }, relinked };
  check("j: the relay's refusal is recorded as rejected, by status", status?.publishes?.rejected === true && [401, 403].includes(status?.publishes?.lastFailure?.status), out.j);
}

writeEvidence(path.resolve(import.meta.dirname, "../../../docs/steps/step-3plus", outName), { stamp, projectId, failures, ...out });
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
