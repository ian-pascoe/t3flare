// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-996's stage harness (parity G5; docs/steps/spi-996.md): on a Durable thread, a plan-mode turn ends with t3's
// proposed plan and Implement starts a default-mode turn from it; a long command's output streams to t3's command item
// while it runs (t3's own command-output subscription, as an expanded row reads it); with t3's labs flag on, a completed
// turn gets a prompt suggestion. Evidence goes to docs/steps/spi-996/<file>.json, tokens and cookies redacted.
//
//   node scripts/stage.ts run p996 p996 turns [presentation|plan|streaming|streaming-worker|suggestion]
import * as fs from "node:fs";
import * as path from "node:path";

import { ORCHESTRATION_V2_WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";

import { ensureProject } from "./lib/cliTurn.ts";
import { dispatch, itemsOf, pair, projectionOf, protocol, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

const SLUG = process.env.T3FLARE_P996_MODEL ?? "anthropic/claude-sonnet-5-5";
const MODEL = { instanceId: "piDurable", model: SLUG, options: /claude/.test(SLUG) ? [{ id: "thinking", value: "low" }] : [] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/spi-996");
/** The web client's Implement prefix (t3code `apps/web/src/proposedPlan.ts`, `PLAN_IMPLEMENTATION_PROMPT_PREFIX`). */
const IMPLEMENT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

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
  console.log(`wrote docs/steps/spi-996/${name}`);
};

let cookie = "";

/** Every event of a WS subscription with its arrival time, until it ends or `ms` pass. */
const subscribe = (method: string, payload: unknown, ms: number): Promise<Array<{ readonly atMs: number; readonly value: unknown }>> => {
  const started = Date.now();
  const seen: Array<{ atMs: number; value: unknown }> = [];
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<string, (input: unknown) => Stream.Stream<unknown, unknown>>;
      yield* client[method]!(payload).pipe(
        Stream.runForEach((value) => Effect.sync(() => seen.push({ atMs: Date.now() - started, value }))),
        Effect.timeout(`${ms} millis`),
        Effect.ignore,
      );
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  ).then(() => seen);
};

const shownItem = (item: any) => ({
  id: item.id,
  type: item.type,
  status: item.status,
  title: item.title ?? null,
  ...(item.type === "proposed_plan" ? { planId: item.planId, markdown: String(item.markdown ?? "").slice(0, 1500), streaming: item.streaming } : {}),
  ...(item.type === "dynamic_tool" ? { toolName: item.toolName } : {}),
  ...(item.type === "assistant_message" ? { text: String(item.text ?? "").slice(0, 600) } : {}),
  ...(item.type === "file_change" ? { fileName: item.fileName } : {}),
  ...(item.type === "command_execution" ? { input: String(item.input ?? "").slice(0, 300), output: String(item.output ?? "").slice(0, 600), exitCode: item.exitCode ?? null } : {}),
  ...(item.type === "error" ? { failure: item.failure } : {}),
});

/** One turn: `send` starts it; runs are watched to the end, every card accepted; `onItem` sees each new item as it appears. */
const turn = async (threadId: string, send: () => Promise<unknown>, onItem?: (item: any) => void, timeoutMs = 8 * 60_000) => {
  const before = projectionOf(await threadWindow(cookie, threadId));
  const runsBefore = runsOf(before).length;
  const itemsBefore = new Set(itemsOf(before).map((item: any) => item.id));
  const noticed = new Set<string>();
  await send();
  const started = Date.now();
  let projection: any;
  const answered = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const item of itemsOf(projection)) {
      if (itemsBefore.has(item.id) || noticed.has(item.id)) continue;
      noticed.add(item.id);
      onItem?.(item);
    }
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      answered.add(request.id);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
    }
    const runs = runsOf(projection);
    if (runs.length > runsBefore && runs.slice(runsBefore).every((run) => SETTLED.has(run.status))) break;
    await sleep(500);
  }
  const runs = runsOf(projection).slice(runsBefore);
  return {
    status: runs.at(-1)?.status ?? null,
    runs: runs.map((run: any) => ({ id: run.id, status: run.status, sourcePlanRef: run.sourcePlanRef ?? null, interactionMode: run.runtimePolicy?.interactionMode ?? run.interactionMode ?? null })),
    ms: Date.now() - started,
    items: itemsOf(projection).filter((item: any) => !itemsBefore.has(item.id)).map(shownItem),
    plans: (projection?.plans ?? []).filter((plan: any) => plan.kind === "proposed_plan").map((plan: any) => ({ id: plan.id, status: plan.status, markdown: String(plan.markdown ?? "").slice(0, 200) })),
    thread: { interactionMode: projection?.thread?.interactionMode ?? null },
  };
};

const createThread = async (projectId: string, title: string, interactionMode: "default" | "plan") => {
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title, modelSelection: MODEL, runtimeMode: "full-access", interactionMode, branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  return threadId;
};

const plan = async (projectId: string) => {
  const threadId = await createThread(projectId, "spi-996: plan", "plan");
  const proposed = await turn(threadId, () =>
    sendMessage(
      cookie,
      threadId,
      "Plan adding a file notes/plan-check.txt whose only line is `planned and built`. Look at the repository's top level first. Keep the plan to three steps.",
      MODEL,
    ),
  );
  const planItem = proposed.items.find((item: any) => item.type === "proposed_plan") as any;
  const active = proposed.plans.find((candidate: any) => candidate.id === planItem?.planId);
  const proposedOk =
    proposed.status === "completed" &&
    planItem !== undefined &&
    active?.status === "active" &&
    !proposed.items.some((item: any) => item.type === "file_change" || (item.type === "command_execution" && /notes\/plan-check/.test(item.input)));
  console.log(`plan: ${proposedOk ? "ok" : "FAIL"} (${proposed.status}, ${Math.round(proposed.ms / 1000)} s)`);
  // Implement, as the web client does it: the thread back to default mode, then the plan as the message, citing it.
  await dispatch(cookie, { type: "thread.interaction-mode.set", commandId: uuid(), threadId, interactionMode: "default" });
  const implemented = await turn(threadId, () =>
    sendMessage(cookie, threadId, `${IMPLEMENT_PREFIX}${planItem?.markdown ?? ""}`, MODEL, planItem === undefined ? {} : { sourcePlanRef: { threadId, planId: planItem.planId } }),
  );
  const after = implemented.plans.find((candidate: any) => candidate.id === planItem?.planId);
  const wrote = implemented.items.some((item: any) => (item.type === "file_change" && /plan-check/.test(item.fileName)) || (item.type === "command_execution" && /plan-check/.test(item.input)));
  const implementOk =
    implemented.status === "completed" && implemented.runs.at(-1)?.sourcePlanRef?.planId === planItem?.planId && after?.status === "completed" && wrote && implemented.thread.interactionMode === "default";
  console.log(`implement: ${implementOk ? "ok" : "FAIL"} (${implemented.status}, ${Math.round(implemented.ms / 1000)} s)`);
  return { threadId, ok: proposedOk && implementOk, proposed: { ok: proposedOk, ...proposed }, implemented: { ok: implementOk, ...implemented } };
};

/**
 * `container`: the command runs on the Container, whose output streams. `worker`: bash chooses its backend; a sleep loop
 * goes to the Worker Shell, whose output arrives once at exit (computer's RPC), so nothing streams there (recorded, not
 * failed: the gap is SPI-996's follow-up).
 */
const streaming = async (projectId: string, backend: "container" | "worker") => {
  const threadId = await createThread(projectId, `spi-996: live output (${backend})`, "default");
  let frames: Promise<Array<{ atMs: number; value: unknown }>> | undefined;
  let itemSeenAtMs = 0;
  const started = Date.now();
  const run = await turn(
    threadId,
    () =>
      sendMessage(
        cookie,
        threadId,
        `Run exactly this with bash${backend === "container" ? ', with backend "container"' : " (leave its backend parameter out)"}: \`for i in 1 2 3 4 5; do echo tick $i; sleep 1; done\`. Then reply with the last line it printed.`,
        MODEL,
      ),
    (item) => {
      if (frames !== undefined || item.type !== "command_execution" || !/tick/.test(String(item.input))) return;
      itemSeenAtMs = Date.now() - started;
      frames = subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput, { threadId, itemId: item.id }, 60_000);
    },
  );
  const seen = (await frames) ?? [];
  const shown = seen.map(({ atMs, value }) => ({ atMs: atMs + itemSeenAtMs, ...(value as object) }));
  const runningFrames = shown.filter((frame: any) => frame.running === true && String(frame.text).includes("tick"));
  const runningText = runningFrames.map((frame: any) => String(frame.text)).join("");
  const ticksWhileRunning = [1, 2, 3, 4, 5].filter((index) => runningText.includes(`tick ${index}`));
  // Streamed: output arrived in more than one running frame, spread over the command's seconds, before it ended.
  const spreadMs = runningFrames.length < 2 ? 0 : (runningFrames.at(-1) as any).atMs - (runningFrames[0] as any).atMs;
  const streamed = runningFrames.length >= 2 && spreadMs >= 1_500 && ticksWhileRunning.length >= 3;
  const ok = run.status === "completed" && (backend === "worker" || streamed);
  console.log(`streaming ${backend}: ${ok ? "ok" : "FAIL"} (${runningFrames.length} running frames over ${spreadMs} ms; ticks ${ticksWhileRunning.join(",")})`);
  return { threadId, ok, streamed, frames: shown, ticksWhileRunning, spreadMs, ...run };
};

const suggestion = async (projectId: string) => {
  await wsCall(cookie, "server.updateSettings", { patch: { promptSuggestionsEnabled: true } });
  const threadId = await createThread(projectId, "spi-996: suggestion", "default");
  const watching = subscribe(ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion, { threadId }, 240_000);
  const run = await turn(threadId, () => sendMessage(cookie, threadId, "Read README.md and tell me in one sentence what this repository is for.", MODEL), undefined, 150_000);
  // The suggestion follows the turn's end: the subscription runs on for the rest of its window.
  const events = await watching;
  await wsCall(cookie, "server.updateSettings", { patch: { promptSuggestionsEnabled: false } });
  const texts = events.flatMap(({ atMs, value }) => (value !== null && typeof value === "object" ? [{ atMs, ...(value as object) }] : []));
  const ok = run.status === "completed" && texts.some((event: any) => typeof event.text === "string" && event.text.length > 0 && event.runId === run.runs.at(-1)?.id);
  console.log(`suggestion: ${ok ? "ok" : "FAIL"} (${texts.length} suggestion(s))`);
  return { threadId, ok, suggestions: texts, status: run.status, runs: run.runs };
};

/** What t3 tells clients about the provider: the plan-mode toggle and the capabilities that turn on the rest. */
const presentation = async () => {
  const config = (await wsCall(cookie, "server.getConfig", {})) as { providers: Array<any> };
  const provider = config.providers.find((candidate) => candidate.driver === "piDurable");
  const shown = {
    showInteractionModeToggle: provider?.showInteractionModeToggle ?? provider?.presentation?.showInteractionModeToggle ?? null,
    displayName: provider?.displayName ?? null,
  };
  const ok = shown.showInteractionModeToggle === true;
  console.log(`presentation: ${ok ? "ok" : "FAIL"}`);
  return { ok, ...shown };
};

const turns = async () => {
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  const { projectId } = await ensureProject(cookie, `p996-${Date.now().toString(36)}`);
  const only = process.argv[3];
  const results: Record<string, any> = {};
  if (only === undefined || only === "presentation") results.presentation = await presentation();
  if (only === undefined || only === "plan") results.plan = await plan(projectId);
  if (only === undefined || only === "streaming") results.streaming = await streaming(projectId, "container");
  if (only === undefined || only === "streaming-worker") results.streamingWorker = await streaming(projectId, "worker");
  if (only === undefined || only === "suggestion") results.suggestion = await suggestion(projectId);
  const ok = Object.values(results).every((result) => result.ok);
  writeEvidence(only === undefined ? "turns.json" : `${only}.json`, { ok, ...results });
  if (!ok) process.exitCode = 1;
};

const command = process.argv[2];
if (command === "turns") {
  cookie = await pair();
  await turns();
} else {
  console.error("usage: p996 turns [presentation|plan|streaming|streaming-worker|suggestion]");
  process.exit(2);
}
