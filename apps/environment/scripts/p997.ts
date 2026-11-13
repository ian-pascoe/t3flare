// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-997 and SPI-987's stage harness (parity gap G6; docs/steps/spi-997.md), on Durable threads, through t3's own
// commands as the web client sends them:
// - fork: a thread is given three code words, one a turn; a fork from the second turn (`thread.fork`, source point
//   `run`) answers with the first two and not the third, natively (the fork's provider thread is `forkedFrom` the
//   source's, and no context handoff was made).
// - rollback: a worktree thread writes notes.txt in each of three turns, with a code word each; a rollback to the first
//   turn's checkpoint (`checkpoint.rollback`, files restored) marks the later runs rolled back, puts notes.txt back as
//   the first turn left it, and the agent no longer has the later code words.
// Evidence goes to docs/steps/spi-997/<file>.json, tokens and cookies redacted.
//
// - rollback-claude: the same rollback on a Claude thread (ACP; files restored, a fresh agent session).
//
//   node scripts/stage.ts run p997 p997 [fork|rollback|rollback-claude]
import * as fs from "node:fs";
import * as path from "node:path";

import { enable, INSTANCE } from "./lib/acpTurn.ts";
import { ensureProject } from "./lib/cliTurn.ts";
import { dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall, wsFirst } from "./lib/client.ts";

const SLUG = process.env.T3FLARE_P997_MODEL ?? "anthropic/claude-haiku-5-5";
const DURABLE = { instanceId: "piDurable", model: SLUG, options: [] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/spi-997");
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const WORDS = ["FIG-3", "PLUM-9", "KIWI-7"];

const SECRET_KEYS = /token|authorization|cookie|secret|handle|bearer|credential|csrf/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  }
  return value;
};

const writeEvidence = (name: string, value: unknown) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(redact({ at: new Date().toISOString(), model: SLUG, ...(value as object) }), null, 1)}\n`);
  console.log(`wrote docs/steps/spi-997/${name}`);
};

let cookie = "";

const projection = async (threadId: string): Promise<any> => projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));

/** Waits until the thread has a run of ordinal `ordinal` or later and all its runs have settled; every card accepted. */
const settle = async (threadId: string, ordinal: number, timeoutMs = 6 * 60_000): Promise<any> => {
  const started = Date.now();
  let current: any;
  const answered = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    current = await projection(threadId);
    for (const request of (current?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      answered.add(request.id);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
    }
    const runs = runsOf(current);
    if (runs.some((run: any) => run.ordinal >= ordinal) && runs.every((run) => SETTLED.has(run.status))) return current;
    await sleep(1000);
  }
  throw new Error(`timed out: runs ${JSON.stringify(runsOf(current).map((run) => run.status))}`);
};

/** The newest assistant text of the run with ordinal `ordinal` (or the newest run). */
const answerOf = (view: any, runId?: string): string => {
  const items = itemsOf(view).filter((item: any) => item.type === "assistant_message" && (runId === undefined || item.runId === runId));
  return String(items.at(-1)?.text ?? "");
};

const wordsIn = (text: string) => WORDS.filter((word) => text.includes(word));

const runView = (view: any) =>
  runsOf(view).map((run: any) => ({ id: run.id, ordinal: run.ordinal, status: run.status, answer: answerOf(view, run.id).slice(0, 300) }));

const ASK = "Without reading any file or running any command: list every code word I have given you in this conversation, comma-separated, or reply NONE.";

const fork = async (projectId: string) => {
  const sourceId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId: sourceId, projectId, title: "spi-997: fork source", modelSelection: DURABLE, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  for (const [index, word] of WORDS.entries()) {
    await sendMessage(cookie, sourceId, `Code word ${index + 1} is ${word}. Remember it. Reply only OK.`, DURABLE);
    await settle(sourceId, index + 1);
  }
  const source = await projection(sourceId);
  const second = runsOf(source).find((run: any) => run.ordinal === 2);
  // The web client's "Fork from here" on the second turn (client-runtime `forkThreadFromRun`).
  const targetId = uuid();
  await dispatch(cookie, {
    type: "thread.fork",
    commandId: uuid(),
    createdBy: "user",
    creationSource: "web",
    sourceThreadId: sourceId,
    targetThreadId: targetId,
    sourcePoint: { type: "run", runId: second?.id },
    title: "spi-997: fork",
  });
  await sleep(2000);
  await sendMessage(cookie, targetId, ASK, DURABLE);
  const target = await settle(targetId, 1);
  const answer = answerOf(target);
  const providerThreads = (target?.providerThreads ?? []).map((thread: any) => ({ id: thread.id, nativeThreadRef: thread.nativeThreadRef, forkedFrom: thread.forkedFrom ?? null }));
  const handoffs = (target?.contextHandoffs ?? target?.handoffs ?? []).map((handoff: any) => ({ id: handoff.id, strategy: handoff.strategy ?? null }));
  const transfers = (target?.contextTransfers ?? []).map((transfer: any) => ({ id: transfer.id, status: transfer.status ?? null, resolution: transfer.resolution ?? null }));
  const native = providerThreads.some((thread: any) => thread.forkedFrom !== null) && handoffs.length === 0;
  const ok = runsOf(target).at(-1)?.status === "completed" && wordsIn(answer).join(",") === "FIG-3,PLUM-9" && native;
  // The source goes on with all three.
  await sendMessage(cookie, sourceId, ASK, DURABLE);
  const sourceAfter = await settle(sourceId, 4);
  const sourceOk = wordsIn(answerOf(sourceAfter)).length === 3;
  console.log(`fork: ${ok && sourceOk ? "ok" : "FAIL"} (fork answered ${JSON.stringify(answer.slice(0, 120))}; native ${native}; source ${sourceOk})`);
  return {
    ok: ok && sourceOk,
    sourceThreadId: sourceId,
    targetThreadId: targetId,
    native,
    fork: { answer, words: wordsIn(answer), runs: runView(target), providerThreads, handoffs, transfers, threadKeys: Object.keys(target ?? {}) },
    source: { runs: runView(sourceAfter), wordsAfter: wordsIn(answerOf(sourceAfter)) },
  };
};

const readNotes = async (cwd: string): Promise<string | null> => {
  const read = (await wsCall(cookie, "projects.readFile", { cwd, relativePath: "notes.txt", allowMissing: true }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
  return read?.exists === false ? null : typeof read?.contents === "string" ? read.contents.trim() : `error: ${read?.error}`;
};

/** `agent`: the Durable agent, or Claude over ACP (stock t3's ACP rollback: t3's checkpoint and a fresh agent session). */
const rollback = async (projectId: string, agent: "durable" | "claude") => {
  const model = agent === "durable" ? DURABLE : { instanceId: INSTANCE.claude!.instanceId, model: INSTANCE.claude!.model, options: [] };
  if (agent === "claude") await enable(cookie, "claude");
  // What the client's composer sends for a new thread in "New worktree" mode: file restore needs an isolated worktree.
  const threadId = uuid();
  const prompt = (index: number) =>
    `Write the file notes.txt in the current directory (the repository root) so its only line is \`${["one", "two", "three"][index]}\` (overwrite it). Code word ${index + 1} is ${WORDS[index]}; remember it. Then reply only OK.`;
  await wsCall(cookie, "orchestration.launchThread", {
    commandId: uuid(),
    creationSource: "web",
    threadId,
    projectId,
    title: `spi-997: rollback (${agent})`,
    generateTitle: false,
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "worktree", baseRef: "main" },
    initialMessage: { messageId: uuid(), text: prompt(0), attachments: [] },
  });
  await settle(threadId, 1, 8 * 60_000);
  const worktreePath: string | null = (await projection(threadId))?.thread?.worktreePath ?? (await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch(() => undefined) as any)?.worktreePath ?? null;
  if (worktreePath === null) throw new Error("the rollback thread has no worktree");
  const notes: Array<string | null> = [await readNotes(worktreePath)];
  for (const index of [1, 2]) {
    await sendMessage(cookie, threadId, prompt(index), model);
    await settle(threadId, index + 1);
    notes.push(await readNotes(worktreePath));
  }
  const before = await projection(threadId);
  const checkpoints = (before?.checkpoints ?? []).map((checkpoint: any) => ({ id: checkpoint.id, scopeId: checkpoint.scopeId, appRunOrdinal: checkpoint.appRunOrdinal ?? null, status: checkpoint.status }));
  const target = (before?.checkpoints ?? []).findLast((checkpoint: any) => checkpoint.appRunOrdinal === 1);
  if (target === undefined) throw new Error(`no checkpoint of the first turn: ${JSON.stringify(checkpoints)}`);
  // The web client's "Revert to this message", files restored (client-runtime `revertThreadCheckpoint`).
  const rolled = await dispatch(cookie, { type: "checkpoint.rollback", restoreFiles: true, commandId: uuid(), threadId, scopeId: target.scopeId, checkpointId: target.id }).then(
    (value: unknown) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: String(error).slice(0, 600) }),
  );
  // The thread's window leaves rolled-back runs out (t3's visible history); either way runs 2 and 3 are gone from it.
  let afterRollback: any;
  const waitStarted = Date.now();
  const live = (view: any) => runsOf(view).filter((run: any) => run.status !== "rolled_back").map((run: any) => run.ordinal);
  while (Date.now() - waitStarted < 120_000) {
    afterRollback = await projection(threadId);
    if (!live(afterRollback).includes(2) && !live(afterRollback).includes(3)) break;
    await sleep(1000);
  }
  const restored = await readNotes(worktreePath);
  const rolledBack = [2, 3].filter((ordinal) => !live(afterRollback).includes(ordinal));
  const visibleRuns = runsOf(afterRollback).map((run: any) => ({ ordinal: run.ordinal, status: run.status }));
  await sendMessage(cookie, threadId, ASK, model);
  const after = await settle(threadId, 2);
  const answer = answerOf(after);
  // The Durable agent keeps the first turn; a fresh ACP session keeps whatever t3 hands it, never the later turns.
  const remembered = agent === "durable" ? wordsIn(answer).join(",") === "FIG-3" : !wordsIn(answer).some((word) => word !== "FIG-3");
  const ok = rolled.ok && notes.join(",") === "one,two,three" && restored === "one" && rolledBack.join(",") === "2,3" && remembered && runsOf(after).at(-1)?.status === "completed";
  console.log(`rollback ${agent}: ${ok ? "ok" : "FAIL"} (notes ${notes.join(",")} -> ${restored}; rolled back ${rolledBack.join(",")}; answered ${JSON.stringify(answer.slice(0, 120))})`);
  return { ok, agent, threadId, worktreePath, notes, checkpoints, target: { id: target.id, appRunOrdinal: target.appRunOrdinal }, dispatch: rolled, restored, rolledBack, visibleRuns, answer, words: wordsIn(answer), runs: runView(after) };
};

const command = process.argv[2];
cookie = await pair();
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
const { projectId } = await ensureProject(cookie, `p997-${Date.now().toString(36)}`);
const results: Record<string, any> = {};
if (command === undefined || command === "fork") results.fork = await fork(projectId);
if (command === undefined || command === "rollback") results.rollback = await rollback(projectId, "durable");
if (command === "rollback-claude") results.rollbackClaude = await rollback(projectId, "claude");
const ok = Object.values(results).every((result) => result.ok);
writeEvidence(command === undefined ? "turns.json" : `${command}.json`, { ok, ...results });
if (!ok) process.exitCode = 1;
