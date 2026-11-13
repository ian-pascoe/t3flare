// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// SPI-1079's stage harness: MCP servers' questions reach the owner as t3 cards, on a Durable thread and on a Codex
// thread, and an Executor-style pause is resumed only after the owner's card. The stage's fixture MCP Worker
// (`scripts/tools/fixtureMcp.ts`) is added twice as a direct server: `fixture` (its questions) and `exefix` (Executor's
// model mode in miniature). Evidence goes to docs/steps/spi-1079/<file>.json, tokens and cookies redacted.
//
//   node scripts/stage.ts run spi1079 spi1079 setup      add the two servers through the panel's API and list them
//   node scripts/stage.ts run spi1079 spi1079 durable    the Durable cases (durable.json)
//   node scripts/stage.ts run spi1079 spi1079 codex      the Codex cases through the relay (codex.json)
//   node scripts/stage.ts run spi1079 spi1079 log        the fixture's log
import * as fs from "node:fs";
import * as path from "node:path";

import { enable as enableCli, ensureProject, modelOf } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

const STAGE = process.env.T3FLARE_STAGE ?? "spi1079";
const FIXTURE_URL = process.env.T3FLARE_FIXTURE_URL ?? `https://t3flare-mcpfixture-${STAGE}.ian-g-pascoe.workers.dev`;
const SLUG = process.env.T3FLARE_TOOLS_MODEL ?? "anthropic/claude-sonnet-5-5";
const MODEL = { instanceId: "piDurable", model: SLUG, options: /claude/.test(SLUG) ? [{ id: "thinking", value: "low" }] : [] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1079");
const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const MARKER = "t3flare-elicit";

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
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(redact({ at: new Date().toISOString(), ...(value as object) }), null, 1)}\n`);
  console.log(`wrote docs/steps/spi-1079/${name}`);
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

const fixtureLog = async (): Promise<Array<string>> =>
  ((await (await fetch(`${FIXTURE_URL}/log`, { headers: { authorization: `Bearer ${process.env.T3FLARE_FIXTURE_BEARER ?? ""}` } })).json()) as { lines?: Array<string> }).lines ?? [];

interface Case {
  readonly name: string;
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------------------
// Setup: the two direct servers

const setup = async () => {
  const servers = [
    { server: "fixture", url: `${FIXTURE_URL}/mcp` },
    { server: "exefix", url: `${FIXTURE_URL}/executor-mcp` },
  ];
  const results = [];
  for (const { server, url } of servers) {
    const existing = ((await harness("GET", "/_t3flare/harness/api/mcp")).json?.servers ?? []).some((row: any) => row.name === server);
    if (existing) await harness("POST", "/_t3flare/harness/api/mcp", { op: "remove", server });
    const added = await harness("POST", "/_t3flare/harness/api/mcp/servers", { server, url, auth: { kind: "header", header: "Authorization" }, value: `Bearer ${process.env.T3FLARE_FIXTURE_BEARER ?? ""}` });
    const tested = await harness("POST", "/_t3flare/harness/api/mcp/test", { server });
    results.push({ server, added: added.status, tested: tested.json });
  }
  const listed = ((await harness("GET", "/_t3flare/harness/api/mcp")).json?.servers ?? []).map((row: any) => ({ name: row.name, tools: (row.tools ?? []).map((tool: any) => `${tool.upstream}:${tool.class}`) }));
  writeEvidence("setup.json", { fixture: FIXTURE_URL, results, listed, ok: results.every((row) => row.added < 300) });
};

// ---------------------------------------------------------------------------------------------------------------------
// The owner, as the harness plays him: each new card answered by `answer` (unanswered when it returns undefined)

type Answer = { readonly decision: "accept" | "decline" | "cancel" } | { readonly answers: Record<string, unknown> } | undefined;
type Answerer = (request: any, item: any) => Answer;

let cookie = "";

const watch = async (threadId: string, answer: Answerer, options: { readonly timeoutMs?: number; readonly runsBefore: number; readonly during?: (projection: any) => Promise<void> }) => {
  const started = Date.now();
  const answered = new Set<string>();
  const cards: Array<any> = [];
  let projection: any;
  while (Date.now() - started < (options.timeoutMs ?? 8 * 60_000)) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      const item = itemsOf(projection).find((candidate: any) => candidate.requestId === request.id);
      const given = answer(request, item);
      if (given === undefined) continue;
      answered.add(request.id);
      const refused = await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, ...given }).then(
        () => undefined,
        (error: unknown) => String((error as { detail?: unknown })?.detail ?? error).slice(0, 200),
      );
      cards.push({
        id: request.id,
        marked: String(request.id).includes(MARKER),
        kind: request.kind,
        type: item?.type ?? null,
        requestKind: item?.requestKind ?? null,
        title: item?.title ?? null,
        prompt: typeof item?.prompt === "string" ? item.prompt.slice(0, 2000) : undefined,
        questions: Array.isArray(item?.questions) ? item.questions.map((q: any) => ({ id: q.id, header: q.header, question: String(q.question).slice(0, 600), options: (q.options ?? []).map((o: any) => o.value ?? o.label) })) : undefined,
        options: Array.isArray(item?.options) ? item.options.map((o: any) => `${o.decision}:${o.label}`) : undefined,
        given: "answers" in given ? { answers: given.answers } : given,
        ...(refused === undefined ? {} : { refused }),
      });
    }
    await options.during?.(projection);
    const runs = runsOf(projection);
    if (runs.length > options.runsBefore && runs.slice(options.runsBefore).every((run) => SETTLED.has(run.status))) break;
    await sleep(1500);
  }
  return { projection, cards, ms: Date.now() - started, status: runsOf(projection).at(-1)?.status ?? null };
};

const replyOf = (projection: any) =>
  itemsOf(projection)
    .filter((item: any) => item.type === "assistant_message")
    .map((item: any) => String(item.text ?? ""))
    .join("")
    .slice(-600);

/** Cards of MCP questions (the host's `t3flare-elicit` ids), apart from the tool cards a write tool raises. */
const isQuestion = (request: any) => String(request.id).includes(MARKER);

const FORM_YES = { colour: "blue", note: "from the owner", urgent: "true", t3flare_send: "send" };
const FORM_NO = { colour: "red", t3flare_send: "decline" };
/** The owner: a form gets `form`, a question card gets `decision`, a tool card (a write) is accepted. */
const owner = (decision: "accept" | "decline", form: Record<string, unknown> = FORM_YES): Answerer => (request) =>
  !isQuestion(request) ? { decision: "accept" } : request.kind === "user_input" ? { answers: form } : { decision };

// ---------------------------------------------------------------------------------------------------------------------
// Durable thread

const verbatim = (code: string) =>
  `Call the codemode tool exactly once, with exactly this code (verbatim, change nothing), then reply with the script's output and nothing else:\n\n\`\`\`js\n${code}\n\`\`\``;

const scriptOutput = async (threadId: string): Promise<string> => {
  const state = (await admin("GET", `/_t3flare/agents/session?thread=${encodeURIComponent(threadId)}`)).json;
  return ((state?.entries ?? []) as Array<any>)
    .filter((entry) => entry.role === "toolResult" && entry.toolName === "codemode")
    .map((entry) => (entry.content ?? []).map((block: any) => block.text ?? "").join(""))
    .at(-1) ?? "";
};

const durableThread = async (projectId: string, title: string, mode: string) => {
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title, modelSelection: MODEL, runtimeMode: mode, interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  return threadId;
};

const durableTurn = async (projectId: string, label: string, code: string, answer: Answerer, options: { readonly mode?: string; readonly during?: (projection: any) => Promise<void>; readonly threadId?: string } = {}) => {
  const threadId = options.threadId ?? (await durableThread(projectId, `spi1079-${label}`, options.mode ?? "full-access"));
  const before = (await fixtureLog()).length;
  const runsBefore = runsOf(projectionOf(await threadWindow(cookie, threadId))).length;
  await sendMessage(cookie, threadId, verbatim(code), MODEL);
  const turn = await watch(threadId, answer, { runsBefore, ...(options.during === undefined ? {} : { during: options.during }) });
  return { threadId, status: turn.status, cards: turn.cards, output: (await scriptOutput(threadId)).slice(0, 1500), logAdded: (await fixtureLog()).slice(before), ms: turn.ms };
};

const durable = async () => {
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  const workspace = `spi1079-durable-${Date.now().toString(36)}`;
  const { projectId } = await ensureProject(cookie, workspace);
  const cases: Array<Case> = [];
  const call = (tool: string, text: string) => `text(await tools.mcp__fixture__${tool}({ text: ${JSON.stringify(text)} }).catch((e) => "threw: " + e.message));`;
  {
    const run = await durableTurn(projectId, "form-yes", call("fixture_ask", "durable approve"), owner("accept"));
    const form = run.cards.find((card) => card.marked);
    cases.push({
      name: "form: a user_input card with one question per field and Send; the owner's answers reach the server (full access: the question still asks)",
      ...run,
      ok: form?.kind === "user_input" && JSON.stringify(form.questions?.map((q: any) => q.id)) === JSON.stringify(["colour", "note", "urgent", "t3flare_send"]) && run.logAdded.includes('fixture_ask:accept:{"colour":"blue","note":"from the owner","urgent":true}'),
    });
  }
  {
    const run = await durableTurn(projectId, "form-no", call("fixture_ask", "durable decline"), owner("accept", FORM_NO));
    cases.push({ name: "form: the owner picks Decline; the server is told decline and gets no values", ...run, ok: run.cards.some((card) => card.marked) && run.logAdded.includes("fixture_ask:decline") });
  }
  {
    const run = await durableTurn(projectId, "confirm-yes", call("fixture_confirm", "durable approve"), owner("accept"));
    const card = run.cards.find((c) => c.marked);
    cases.push({ name: "confirmation: t3's mcp-elicitation approval card; approved", ...run, ok: card?.kind === "mcp-elicitation" && card.requestKind === "mcp-elicitation" && run.logAdded.includes("fixture_confirm:accept") });
  }
  {
    const run = await durableTurn(projectId, "confirm-no", call("fixture_confirm", "durable decline"), owner("decline"));
    cases.push({ name: "confirmation: declined", ...run, ok: run.cards.some((c) => c.marked) && run.logAdded.includes("fixture_confirm:decline") });
  }
  {
    const run = await durableTurn(projectId, "page", call("fixture_page", "durable page"), owner("accept"));
    const card = run.cards.find((c) => c.marked);
    cases.push({ name: "page (URL mode): the card shows the link; Opened it", ...run, ok: card?.kind === "mcp-elicitation" && String(card.prompt).includes("https://example.com/t3flare-fixture-page") && run.logAdded.includes("fixture_page:accept") });
  }
  {
    const run = await durableTurn(projectId, "password", call("fixture_password", "durable password"), owner("accept"));
    cases.push({ name: "a form asking for a password is declined unseen: no card, the server told decline", ...run, ok: !run.cards.some((c) => c.marked) && run.logAdded.includes("fixture_password:decline") });
  }
  {
    // Owner-only: while thread A's form card waits, thread B (full access) calls t3_pending_request on it; the Environment
    // refuses it before t3 sees it, and the card is still pending until the owner answers.
    const a = await durableThread(projectId, "spi1079-fence-a", "full-access");
    const b = await durableThread(projectId, "spi1079-fence-b", "full-access");
    let attempt: any = null;
    const run = await durableTurn(projectId, "fence", call("fixture_ask", "fence"), (request) => (attempt === null && isQuestion(request) ? undefined : owner("accept", FORM_NO)(request, undefined)), {
      threadId: a,
      during: async (projection) => {
        if (attempt !== null) return;
        const card = (projection?.runtimeRequests ?? []).find((r: any) => r.status === "pending" && isQuestion(r));
        if (card === undefined) return;
        const code = `const read = await tools.mcp__t3_code__t3_pending_request({ action: "read", threadId: ${JSON.stringify(a)}, requestId: ${JSON.stringify(card.id)} }).catch((e) => "read threw: " + e.message);
const responded = await tools.mcp__t3_code__t3_pending_request({ action: "respond", threadId: ${JSON.stringify(a)}, requestId: ${JSON.stringify(card.id)}, answers: { colour: "green", t3flare_send: "send" } }).catch((e) => "respond threw: " + e.message);
text("READ " + String(read).slice(0, 400) + "\\nRESPOND " + String(responded).slice(0, 400));`;
        const turnB = await durableTurn(projectId, "fence-b", code, () => ({ decision: "accept" }), { threadId: b });
        const after = projectionOf(await threadWindow(cookie, a));
        attempt = { cardId: card.id, bStatus: turnB.status, output: turnB.output, stillPending: (after?.runtimeRequests ?? []).some((r: any) => r.id === card.id && r.status === "pending") };
      },
    });
    cases.push({
      name: "owner only: another agent's t3_pending_request read and respond on the form card are refused; the card stays pending; no green",
      attempt,
      ...run,
      ok: attempt !== null && attempt.stillPending === true && /RESPOND[\s\S]*only the owner answers/.test(attempt.output) && /READ[\s\S]*only the owner answers/.test(attempt.output) && !run.logAdded.some((line) => line.includes("green")),
    });
  }
  // Executor-style ("Through your agent"): the pause raises the card with Executor's text and the agent's call; resume
  // happens only after the owner's answer, and an agent has no resume.
  const exec = (line: string) => `text(JSON.stringify(await tools.mcp__exefix__call({ calls: { path: "tools.fixture-notes.note", input: { line: ${JSON.stringify(line)} } } }).catch((e) => "threw: " + e.message)));`;
  {
    const marker = `exec-${Date.now().toString(36)}`;
    const run = await durableTurn(projectId, "exec-yes", `${exec(`${marker}-yes`)}\ntry { tools.mcp__exefix__resume; text(" RESUME:present"); } catch (e) { text(" RESUME:absent"); }`, owner("accept"));
    const card = run.cards.find((c) => c.marked);
    cases.push({
      name: "Executor-style approval: t3flare's card shows Executor's text (app, tool, arguments) and the agent's call; approved: resume ran once with accept",
      ...run,
      ok:
        card?.kind === "mcp-elicitation" &&
        String(card.prompt).includes(`Approve fixture-notes.note with line "${marker}-yes"?`) &&
        String(card.prompt).includes('"app": "fixture-notes"') &&
        String(card.prompt).includes("The agent's call: exefix: call") &&
        JSON.stringify(run.logAdded) === JSON.stringify(["resume:accept", `exec:${marker}-yes`]) &&
        run.output.includes("ran fixture-notes.note") &&
        !run.output.includes("apr_") &&
        run.output.includes("RESUME:absent"),
    });
  }
  {
    const marker = `exec-${Date.now().toString(36)}`;
    const run = await durableTurn(projectId, "exec-no", exec(`${marker}-no`), owner("decline"));
    cases.push({ name: "Executor-style approval declined: Executor is sent its decline; nothing ran", ...run, ok: run.cards.some((c) => c.marked) && JSON.stringify(run.logAdded) === JSON.stringify(["resume:decline"]) && !run.output.includes("apr_") });
  }
  writeEvidence("durable.json", { model: SLUG, workspace, cases, ok: cases.every((c) => c.ok) });
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${workspace}`);
};

// ---------------------------------------------------------------------------------------------------------------------
// Codex thread, through the relay

const codexTurn = async (workspace: string, label: string, prompt: string, answer: Answerer) => {
  const { projectId } = await ensureProject(cookie, workspace);
  const model = modelOf("codex", process.env.T3FLARE_CODEX_MODEL);
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: `spi1079 codex ${label}`, modelSelection: model, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  const before = (await fixtureLog()).length;
  await sendMessage(cookie, threadId, prompt, model);
  const turn = await watch(threadId, answer, { runsBefore: 0, timeoutMs: 10 * 60_000 });
  // Each case on a fresh process: a Workspace holds at most 4 CLI processes.
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  return { threadId, status: turn.status, cards: turn.cards, reply: replyOf(turn.projection), logAdded: (await fixtureLog()).slice(before), ms: turn.ms };
};

const codex = async () => {
  await enableCli(cookie, "codex", "codex");
  const workspace = `spi1079-codex-${Date.now().toString(36)}`;
  const only = "Do not run any shell command; use only that MCP tool, once.";
  const cases: Array<Case> = [];
  {
    const run = await codexTurn(workspace, "form-yes", `Call the MCP tool fixture_ask of the "fixture" MCP server with text "codex approve" and reply with exactly what it returned. ${only}`, owner("accept"));
    const form = run.cards.find((c) => c.marked);
    cases.push({ name: "Codex: a form's user_input card on the CLI thread; the owner's answers reach the server", ...run, ok: form?.kind === "user_input" && run.logAdded.includes('fixture_ask:accept:{"colour":"blue","note":"from the owner","urgent":true}') });
  }
  {
    const run = await codexTurn(workspace, "form-no", `Call the MCP tool fixture_ask of the "fixture" MCP server with text "codex decline" and reply with exactly what it returned. ${only}`, owner("accept", FORM_NO));
    cases.push({ name: "Codex: the owner declines the form", ...run, ok: run.cards.some((c) => c.marked) && run.logAdded.includes("fixture_ask:decline") });
  }
  {
    const run = await codexTurn(workspace, "confirm-no", `Call the MCP tool fixture_confirm of the "fixture" MCP server with text "codex decline" and reply with exactly what it returned. ${only}`, owner("decline"));
    const card = run.cards.find((c) => c.marked);
    cases.push({ name: "Codex: a confirmation's mcp-elicitation card, declined", ...run, ok: card?.kind === "mcp-elicitation" && run.logAdded.includes("fixture_confirm:decline") });
  }
  {
    const marker = `cexec-${Date.now().toString(36)}`;
    const run = await codexTurn(workspace, "exec-yes", `Call the MCP tool "call" of the "exefix" MCP server with arguments {"calls": {"path": "tools.fixture-notes.note", "input": {"line": "${marker}"}}} and reply with exactly what it returned. ${only}`, owner("accept"));
    const card = run.cards.find((c) => c.marked);
    cases.push({
      name: "Codex: an Executor-style pause raises t3flare's card on the CLI thread; approved, resume ran once; the reply has no requestId",
      ...run,
      ok: card?.kind === "mcp-elicitation" && String(card.prompt).includes(`Approve fixture-notes.note with line "${marker}"?`) && JSON.stringify(run.logAdded) === JSON.stringify(["resume:accept", `exec:${marker}`]) && !run.reply.includes("apr_"),
    });
  }
  writeEvidence("codex.json", { workspace, cases, ok: cases.every((c) => c.ok) });
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${workspace}`);
};

// ---------------------------------------------------------------------------------------------------------------------

const command = process.argv[2];
if (command === "log") {
  console.log(JSON.stringify(await fixtureLog(), null, 1));
} else {
  cookie = await pair();
  if (command === "setup") await setup();
  else if (command === "durable") await durable();
  else if (command === "codex") await codex();
  else {
    console.error("usage: spi1079 setup|durable|codex|log");
    process.exit(2);
  }
}
