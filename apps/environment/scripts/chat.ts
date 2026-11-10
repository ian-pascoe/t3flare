// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalTimers:off
// M1's chat check (step 2a): a Durable agent answers in a thread, a steer joins its run, Stop interrupts a long one, and
// the thread gets a generated title. Run against a stage:
//
//   bun scripts/stage.ts run step2a chat [--out file.json]
import * as fs from "node:fs";

import { createProjectAndThread, dispatch, itemsOf, pair, runsOf, sendMessage, SETTLED, sleep, uuid, waitFor } from "./lib/client.ts";

const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const report: Record<string, unknown> = { at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 400)}`);
};

const cookie = await pair();
const stamp = Date.now().toString(36);
const { threadId } = await createProjectAndThread(cookie, { title: `chat ${stamp}`, workspaceRoot: `/t3/home/chat-${stamp}` });

// 1. An answer, with reasoning, and a title.
const seed = "Why is the sky blue?";
await sendMessage(cookie, threadId, "Think briefly, then answer in one sentence: why is the sky blue?", undefined, { titleSeed: seed });
const first = await waitFor(cookie, threadId, (p) => runsOf(p).some((r) => SETTLED.has(r.status)));
const items = itemsOf(first.projection);
report.answer = {
  ms: first.ms,
  run: runsOf(first.projection).map((r) => r.status),
  itemTypes: items.map((i: any) => `${i.type}:${i.status}`),
  answer: items.find((i: any) => i.type === "assistant_message")?.text?.slice(0, 200),
  reasoningItems: items.filter((i: any) => i.type === "reasoning").length,
};
check("the run completed", runsOf(first.projection)[0]?.status === "completed", report.answer);
check("an assistant message", items.some((i: any) => i.type === "assistant_message" && i.status === "completed"), report.answer);
const titled = await waitFor(cookie, threadId, (p) => typeof p?.thread?.title === "string" && p.thread.title !== seed && !p.thread.title.startsWith("chat "), 60_000).catch(
  (error: unknown) => ({ projection: undefined, ms: -1, error: String(error) }),
);
report.title = { title: (titled as any).projection?.thread?.title ?? null, ms: titled.ms };
check("a generated title", titled.ms >= 0, report.title);

// 2. Stop interrupts a long answer.
await sendMessage(cookie, threadId, "Count from 1 to 3000, one number per line, nothing else.");
const running = await waitFor(cookie, threadId, (p) => runsOf(p).filter((r) => r.status === "running").length > 0, 60_000);
const runId = runsOf(running.projection).find((r) => r.status === "running")!.id;
await sleep(1500);
await dispatch(cookie, { type: "run.interrupt", commandId: uuid(), threadId, runId });
const stopped = await waitFor(cookie, threadId, (p) => SETTLED.has(runsOf(p).find((r) => r.id === runId)?.status ?? ""), 60_000);
report.stop = { status: runsOf(stopped.projection).find((r) => r.id === runId)?.status, ms: stopped.ms };
check("Stop interrupts the run", (report.stop as any).status === "interrupted", report.stop);

// 3. A steer joins the running run.
await sendMessage(cookie, threadId, "Write a 600-word story about a lighthouse keeper. Plain prose, no title.");
const steering = await waitFor(cookie, threadId, (p) => runsOf(p).some((r) => r.status === "running"), 60_000);
const steerRun = runsOf(steering.projection).find((r) => r.status === "running")!.id;
await dispatch(cookie, {
  type: "message.dispatch",
  commandId: uuid(),
  threadId,
  messageId: uuid(),
  text: "Also: end your answer with the word STEERED.",
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  deliveryIntent: "steer",
  createdBy: "user",
  creationSource: "web",
});
const steered = await waitFor(cookie, threadId, (p) => SETTLED.has(runsOf(p).find((r) => r.id === steerRun)?.status ?? ""), 120_000);
const steeredItems = itemsOf(steered.projection).filter((i: any) => i.type === "assistant_message" && i.runId === steerRun);
const steeredText = steeredItems.map((i: any) => i.text).join("\n");
report.steer = {
  status: runsOf(steered.projection).find((r) => r.id === steerRun)?.status,
  endsSteered: /STEERED\W*$/.test(steeredText.trim()),
  assistantMessagesInRun: steeredItems.length,
  runs: runsOf(steered.projection).length,
  reasoningItemsInThread: itemsOf(steered.projection).filter((i: any) => i.type === "reasoning").length,
};
check("a steer joins the run", (report.steer as any).endsSteered === true, report.steer);
check("reasoning shows as reasoning items", (report.steer as any).reasoningItemsInThread > 0, report.steer);

report.threadId = threadId;
report.failures = failures;
report.ok = failures.length === 0;
const text = JSON.stringify(report, null, 2);
console.log(text);
if (out) fs.writeFileSync(out, `${text}\n`);
process.exit(report.ok ? 0 : 1);
