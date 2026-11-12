// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
// Step 3+ M3 (the exit criterion, with the owner's phone): two runs with no client attached, one that completes and one
// that asks (`ask_user`), and the relay's delivery counts for each publish, from the recorder. The question waits for
// the owner's answer (from the phone, if paired to this stage) for up to --wait-s seconds, then this script answers it.
//
//   bun scripts/stage.ts run step3plus connect-m3 [--wait-s 600]
import * as path from "node:path";

import { admin, dispatch, mutateProject, pair, runsOf, sleep, updateSettings, uuid } from "./lib/client.ts";
import { createThread, pendingOf, replyOf, say, settled, until } from "./lib/cloudThread.ts";
import { writeEvidence } from "./lib/evidence.ts";

const waitAt = process.argv.indexOf("--wait-s");
const waitS = waitAt < 0 ? 600 : Number(process.argv[waitAt + 1]);
const stamp = Date.now().toString(36);
const cookie = await pair();
await updateSettings(cookie, { providerInstances: { piDurable: { driver: "piDurable", enabled: true } } });
const projectId = uuid();
await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: "t3flare phone check", workspaceRoot: `/w/connect-m3-${stamp}`, createWorkspaceRootIfMissing: true });
await admin("POST", "/_t3flare/disarm-bootstrap");

const recent = async (threadId: string) => ((((await admin("GET", "/_t3flare/connect/status")).json?.publishes?.recent ?? []) as Array<any>).filter((e) => e.threadId === threadId));
const delivered = (entries: Array<any>, phase: string) => entries.filter((e) => e.event === "completed" && e.phase === phase).map((e) => ({ at: e.at, ok: e.ok, deliveries: e.deliveries }));
const now = () => new Date().toISOString();

const completeId = await createThread(cookie, projectId, { title: "Phone check: finishes" });
await say(cookie, completeId, "Reply with the single word: pong");
await until(cookie, completeId, settled);
await sleep(12_000);
const completeEntries = await recent(completeId);
console.log(`${now()} completes: ${JSON.stringify(delivered(completeEntries, "completed"))}`);

const askId = await createThread(cookie, projectId, { title: "Phone check: asks you" });
await say(cookie, askId, 'Use the ask_user tool to ask me exactly this question: "Red or blue?" with options ["red", "blue"]. Then reply with only the color I chose.');
const waiting = await until(cookie, askId, (p) => pendingOf(p).some((r: any) => r.kind === "user_input") || settled(p));
await sleep(5000);
console.log(`${now()} asks: ${JSON.stringify(delivered(await recent(askId), "waiting_for_input"))}`);
const answeredBy = await until(cookie, askId, (p) => pendingOf(p).length === 0 || settled(p), waitS * 1000).then(async (p) => {
  const request = pendingOf(p).find((r: any) => r.kind === "user_input");
  if (request === undefined) return "owner";
  const questionId = (p?.turnItems ?? []).find((i: any) => i.type === "user_input_request" && i.requestId === request.id)?.questions?.[0]?.id ?? "";
  await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId: askId, requestId: request.id, answers: { [questionId]: "blue" } });
  return "script";
});
const done = await until(cookie, askId, settled);
await sleep(12_000);
const askEntries = await recent(askId);
writeEvidence(path.resolve(import.meta.dirname, "../../../docs/steps/step-3plus/m3-deliveries.json"), {
  complete: { threadId: completeId, published: delivered(completeEntries, "completed"), entries: completeEntries },
  ask: {
    threadId: askId,
    asked: pendingOf(waiting).length > 0,
    answeredBy,
    reply: replyOf(done).slice(-80),
    runs: runsOf(done).map((r) => r.status),
    published: delivered(askEntries, "waiting_for_input"),
    entries: askEntries,
  },
});
