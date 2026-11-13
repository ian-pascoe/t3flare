// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalRandom:off
// The pi-harness ports' stage harness (SPI-1054 web, SPI-1055 todo, SPI-1056 context; docs/steps/pi-ports-1.md): a
// Durable thread uses each ported tool in real turns, and t3's own projection is read back for the items it shows.
// Evidence goes to docs/steps/pi-ports-1/<file>.json, tokens and cookies redacted.
//
//   node scripts/stage.ts run ports ports settings   the harness panel's API: web search on, and the registry's entries
//   node scripts/stage.ts run ports ports turns      web, todo, notes across turns, a rollover and a turn after it
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

const SLUG = process.env.T3FLARE_PORTS_MODEL ?? "anthropic/claude-sonnet-5-5";
const MODEL = { instanceId: "piDurable", model: SLUG, options: /claude/.test(SLUG) ? [{ id: "thinking", value: "low" }] : [] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/pi-ports-1");
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
  console.log(`wrote docs/steps/pi-ports-1/${name}`);
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

const settings = async () => {
  const before = await harness("GET", "/_t3flare/harness/api/settings");
  const on = await harness("POST", "/_t3flare/harness/api/extensions", { extension: "web", settings: { search: true } });
  const after = await harness("GET", "/_t3flare/harness/api/settings");
  const pick = (json: any) => {
    const extensions = json?.resolved?.extensions ?? json?.extensions ?? {};
    return Object.fromEntries(["web", "todo", "context"].map((id) => [id, extensions[id] ?? null]));
  };
  writeEvidence("settings.json", { before: pick(before.json), changed: on.status, after: pick(after.json), ok: on.status < 300 });
};

let cookie = "";

/** One turn on `threadId`: the prompt sent, runs watched to the end, every card accepted. */
const turn = async (threadId: string, prompt: string, timeoutMs = 8 * 60_000) => {
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
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
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
    resets: entries.filter((entry) => entry.kind === "pi.reset").map((entry) => JSON.stringify(entry.content ?? []).slice(0, 600)),
  };
};

const turns = async () => {
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  const { projectId } = await ensureProject(cookie, `ports-${Date.now().toString(36)}`);
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: "pi ports", modelSelection: MODEL, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  const codeword = `ostrich-${Math.floor(Math.random() * 9000 + 1000)}`;
  const results: Record<string, unknown> = {};
  const step = async (name: string, prompt: string, check: (run: Awaited<ReturnType<typeof turn>>) => boolean) => {
    const run = await turn(threadId, prompt);
    const ok = run.status === "completed" && check(run);
    results[name] = { ok, prompt, ...run };
    console.log(`${name}: ${ok ? "ok" : "FAIL"} (${run.status}, ${Math.round(run.ms / 1000)} s)`);
    return run;
  };
  await step(
    "web",
    "Use the web_search tool once to find the Cloudflare Durable Objects documentation, then use web_fetch on https://developers.cloudflare.com/durable-objects/ and reply with the page's title in one line.",
    (run) => run.items.some((item: any) => item.type === "web_search" && item.title === null) && run.items.some((item: any) => item.type === "web_search" && item.title === "Fetched a page"),
  );
  await step(
    "todo",
    "Use the todo tool to plan three tasks: 'Inspect', 'Change', 'Verify' (one add call with all three). Then call todo to mark 'Inspect' active, then call todo again to mark it completed and 'Change' active, then once more to mark every task completed. Reply 'done'.",
    (run) => run.items.filter((item: any) => item.type === "todo_list").length >= 3 && run.items.some((item: any) => item.type === "todo_list" && item.steps.every((s: any) => s.status === "completed")),
  );
  await step(
    "note-save",
    `Save a Note with context_notes: action write, name "codeword", content "The codeword is ${codeword}". Do not repeat the codeword in your reply; reply 'saved'.`,
    (run) => run.items.some((item: any) => item.type === "dynamic_tool" && item.title === 'Notes: write "codeword"'),
  );
  await step(
    "note-read",
    "Read your Note named codeword with context_notes (action read) and reply with the codeword only.",
    (run) => run.reply.includes(codeword) && run.items.some((item: any) => item.type === "dynamic_tool" && String(item.title).startsWith("Notes: read")),
  );
  await step(
    "rollover",
    "Call context_rollover now, as the only tool call of its round, with a Handoff that says: 'Objective: answer the owner. The codeword is in Note codeword.' After the rollover, read the Note with context_notes and reply with the codeword only.",
    (run) => run.reply.includes(codeword) && run.items.some((item: any) => item.type === "dynamic_tool" && String(item.title).startsWith("Context rollover")),
  );
  await step(
    "after-rollover",
    "Use context_history (action search, query \"Cloudflare Durable Objects\") to check what you searched earlier in this thread, then reply 'history ok' and the number of matches.",
    (run) => run.reply.toLowerCase().includes("history ok") && run.items.some((item: any) => item.type === "dynamic_tool" && item.title === "History: search"),
  );
  const session = await sessionOf(threadId);
  const ok = Object.values(results).every((result: any) => result.ok) && session.resets.length >= 1;
  writeEvidence("turns.json", { threadId, ok, steps: results, session });
};

const command = process.argv[2];
if (command === "settings") await settings();
else if (command === "turns") {
  cookie = await pair();
  await turns();
} else {
  console.error("usage: ports settings|turns");
  process.exit(2);
}
