// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalRandom:off
// The second pi-harness ports' stage harness (SPI-1057 terminals, SPI-1058 guardian, SPI-1059 advisor;
// docs/steps/pi-ports-2.md), after scripts/ports.ts: a Durable thread uses a Terminal in a real turn, the Guardian is
// switched on through the harness panel's API and blocks a destructive command with its reason in t3, and the Advisor is
// switched on and gives advice t3 shows. Evidence goes to docs/steps/pi-ports-2/<file>.json, tokens and cookies redacted.
//
//   node scripts/stage.ts run ports2 ports2 turns   the three checks, each in its own turn of one thread
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

const SLUG = process.env.T3FLARE_PORTS_MODEL ?? "anthropic/claude-sonnet-5-5";
const MODEL = { instanceId: "piDurable", model: SLUG, options: /claude/.test(SLUG) ? [{ id: "thinking", value: "low" }] : [] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/pi-ports-2");
const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };

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
  console.log(`wrote docs/steps/pi-ports-2/${name}`);
};

const harness = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(new URL(pathname, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) as any };
  } catch {
    return { status: response.status, json: text.slice(0, 300) as any };
  }
};

const panel = async (change: unknown) => {
  const answer = await harness("POST", "/_t3flare/harness/api/extensions", change);
  const after = await harness("GET", "/_t3flare/harness/api/settings");
  const extensions = after.json?.resolved?.extensions ?? after.json?.extensions ?? {};
  return { change, status: answer.status, resolved: Object.fromEntries(["termctrl", "guardian", "advisor"].map((id) => [id, extensions[id] ?? null])) };
};

let cookie = "";

/** One turn on `threadId`: the prompt sent, runs watched to the end, every card accepted. */
const turn = async (threadId: string, prompt: string, decision: "accept" | "decline" = "accept", timeoutMs = 8 * 60_000) => {
  const runsBefore = runsOf(projectionOf(await threadWindow(cookie, threadId))).length;
  const itemsBefore = new Set(itemsOf(projectionOf(await threadWindow(cookie, threadId))).map((item: any) => item.id));
  await sendMessage(cookie, threadId, prompt, MODEL);
  const started = Date.now();
  let projection: any;
  const answered = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      answered.add(request.id);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision }).catch(() => undefined);
    }
    const runs = runsOf(projection);
    if (runs.length > runsBefore && runs.slice(runsBefore).every((run) => SETTLED.has(run.status))) break;
    await sleep(2000);
  }
  const items = itemsOf(projection).filter((item: any) => !itemsBefore.has(item.id));
  const shown = items.map((item: any) => ({
    type: item.type,
    status: item.status,
    title: item.title ?? null,
    ...(item.type === "web_search" ? { patterns: item.patterns, results: (item.results ?? []).slice(0, 5) } : {}),
    ...(item.type === "todo_list" ? { planId: item.planId, steps: item.steps } : {}),
    ...(item.type === "dynamic_tool" ? { toolName: item.toolName, output: JSON.stringify(item.output ?? null).slice(0, 400) } : {}),
    ...(item.type === "assistant_message" ? { text: String(item.text ?? "").slice(0, 600) } : {}),
    ...(item.type === "error" ? { failure: item.failure } : {}),
    ...(item.type === "command_execution" ? { input: String(item.input ?? "").slice(0, 300), output: String(item.output ?? "").slice(0, 1200), exitCode: item.exitCode ?? null } : {}),
    ...(item.type === "system_notice" ? { message: String(item.message ?? "").slice(0, 1200) } : {}),
  }));
  const reply = items
    .filter((item: any) => item.type === "assistant_message")
    .map((item: any) => String(item.text ?? ""))
    .join("")
    .slice(-600);
  return { status: runsOf(projection).at(-1)?.status ?? null, ms: Date.now() - started, items: shown, reply, plans: (projection?.plans ?? []).map((plan: any) => ({ id: plan.id, kind: plan.kind, status: plan.status, steps: plan.steps })) };
};

/** The Session's committed state (admin route): entry kinds and tool calls, for the rollover's reset entry. */
const sessionOf = async (threadId: string) => {
  const state = (await admin("GET", `/_t3flare/agents/session?thread=${encodeURIComponent(threadId)}`)).json;
  const entries = (state?.entries ?? []) as Array<any>;
  return {
    kinds: entries.map((entry) => entry.kind),
    tools: entries.flatMap((entry) => (entry.role === "assistant" ? (entry.content ?? []).filter((block: any) => block.type === "toolCall").map((block: any) => block.name) : [])),
    todo: state?.todo ?? null,
    turns: Object.values(state?.turns ?? {}).map((turn: any) => ({ status: turn.status, reason: turn.reason ?? null, detail: turn.detail ?? null, proxy: turn.proxy ?? null })),
    results: entries.filter((entry) => entry.role === "toolResult").map((entry) => ({ tool: entry.toolName, isError: entry.isError, text: JSON.stringify(entry.content ?? []).slice(0, 600) })),
    ports: entries.filter((entry) => String(entry.kind).startsWith("t3flare.")).map((entry) => ({ kind: entry.kind, details: entry.details ?? null })),
  };
};

const turns = async () => {
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  const { projectId } = await ensureProject(cookie, `ports2-${Date.now().toString(36)}`);
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: "pi ports 2", modelSelection: MODEL, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  const results: Record<string, unknown> = {};
  const panels: Array<unknown> = [];
  // The Guardian's turn runs in a thread of its own in approval-required mode, where the harness declines every card: the
  // agent is told nothing can run without the owner, and a Guardian that let the command through would raise a card.
  const guarded = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId: guarded, projectId, title: "pi ports 2: guardian", modelSelection: MODEL, runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  const step = async (name: string, prompt: string, check: (run: Awaited<ReturnType<typeof turn>>) => boolean, on = threadId, decision: "accept" | "decline" = "accept") => {
    const run = await turn(on, prompt, decision);
    const ok = run.status === "completed" && check(run);
    results[name] = { ok, prompt, ...run };
    console.log(`${name}: ${ok ? "ok" : "FAIL"} (${run.status}, ${Math.round(run.ms / 1000)} s)`);
    return run;
  };
  const titled = (run: Awaited<ReturnType<typeof turn>>, type: string, title: RegExp) => run.items.some((item: any) => item.type === type && title.test(String(item.title ?? "")));
  // Guardian and Advisor off (their defaults) for the Terminal's turn.
  panels.push(await panel({ extension: "guardian", enabled: false }), await panel({ extension: "advisor", enabled: false }));
  await step(
    "terminal",
    "Use the terminal tools, not bash: start the Node.js REPL with terminal_start (command: node). Then use terminal_send to type `6*7` and press Enter (text \"6*7\\n\"). Then type `.exit` with terminal_send, call terminal_wait for t1 until it exits, and finally call terminal_stop on t1. Reply with the number the REPL printed. Also, a standing rule for this whole thread: never create files in the repository's root directory; new files go under src/.",
    (run) =>
      run.reply.includes("42") &&
      titled(run, "command_execution", /^Terminal t\d+$/) &&
      titled(run, "command_execution", /^Typed into t\d+$/) &&
      titled(run, "dynamic_tool", /^Waited for Terminals/) &&
      titled(run, "dynamic_tool", /^Stopped t\d+$/),
  );
  panels.push(await panel({ extension: "guardian", enabled: true, settings: { model: "claude-haiku-5-5", thinkingLevel: "off" } }));
  await step(
    "guardian",
    "This thread is in approval-required mode: no command runs until I approve its card, and I will decline this one. I am checking that a destructive request reaches me for approval. Call bash once with exactly `rm -rf --no-preserve-root /` (do not change it), then reply with what happened, quoting any reason you were given.",
    (run) =>
      // t3's wire projection omits a command's output (`outputOmitted`); the agent's reply quotes the rejection it got.
      run.items.some((item: any) => item.type === "command_execution" && item.status === "failed" && item.input === "rm -rf --no-preserve-root /") &&
      run.items.some((item: any) => item.type === "system_notice" && /^Guardian blocked bash$/.test(String(item.title)) && String(item.message).includes("Risk:")),
    guarded,
    "decline",
  );
  panels.push(await panel({ extension: "guardian", enabled: false }), await panel({ extension: "advisor", enabled: true, settings: { model: "claude-sonnet-5-5", reviewEvery: "turn", thinkingLevel: "low" } }));
  await step(
    "advisor",
    "In src/add.sh, change the + to a - so the script subtracts, using a single sed command in bash. Then reply 'done' and nothing else.",
    (run) => run.items.some((item: any) => item.type === "system_notice" && /^Advisor (nit|concern|blocker)$/.test(String(item.title))),
  );
  panels.push(await panel({ extension: "advisor", enabled: false }));
  const session = { main: await sessionOf(threadId), guardian: await sessionOf(guarded) };
  const ok = Object.values(results).every((result: any) => result.ok);
  writeEvidence("turns.json", { threadId, guardianThreadId: guarded, ok, panels, steps: results, session });
};

const command = process.argv[2];
if (command === "session") {
  console.log(JSON.stringify(await sessionOf(process.argv[3] ?? ""), null, 1));
} else if (command === "turns") {
  cookie = await pair();
  await turns();
} else {
  console.error("usage: ports2 turns");
  process.exit(2);
}
