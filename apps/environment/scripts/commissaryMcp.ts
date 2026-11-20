// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// SPI-1160's stage evidence: Commissary's MCP endpoint added by hand as an ordinary direct server, signed in with an
// `x-api-key` header, through the Settings page's admin API; then a Durable agent and a Codex agent each run a write
// (with its card) and a read through it. Commissary's client API host and an API key with its `sandbox` toolkit come from
// the shell (`T3FLARE_MCP_API_URL`, `T3FLARE_MCP_KEY`, exported inline): the key goes into the add request and nowhere else, and no evidence file is written that holds it.
//
//   node scripts/stage.ts run p1160 commissaryMcp add       add (or re-add) the server, test it   (add.json)
//   node scripts/stage.ts run p1160 commissaryMcp durable   a Durable agent's write and read      (durable.json)
//   node scripts/stage.ts run p1160 commissaryMcp cli       a Codex agent's write and read        (cli-codex.json)
//
// The tools are Commissary's `sandbox` toolkit: sandbox_open and sandbox_write are write tools (no read hint), and
// sandbox_read is a read tool, so the write leaves a file the read shows. Each sandbox is closed at the end.
import * as fs from "node:fs";
import * as path from "node:path";

import { cliTurn, enable as enableCli, ensureProject } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1160");
const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const KEY = process.env.T3FLARE_MCP_KEY ?? "";
const API = (process.env.T3FLARE_MCP_API_URL ?? "").replace(/\/+$/, "");
const URL_ = `${API}/mcp?toolkits=sandbox`;
const SERVER = "commissary";
const MODEL = { instanceId: "piDurable", model: process.env.T3FLARE_TOOLS_MODEL ?? "default", options: [{ id: "thinking", value: "low" }] };
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };

if (KEY === "" || API === "" || HARNESS === "") {
  console.error("commissaryMcp: run through `node scripts/stage.ts run <stage> commissaryMcp …` (T3FLARE_MCP_API_URL and T3FLARE_MCP_KEY exported, the stage's URL)");
  process.exit(2);
}

/** The API host as evidence shows it. */
const scrub = (text: string) => text.replaceAll(new URL(API).host, "<api host>");

const writeEvidence = (name: string, value: unknown) => {
  const text = scrub(`${JSON.stringify({ at: new Date().toISOString(), ...(value as object) }, null, 1)}\n`);
  if (text.includes(KEY)) throw new Error(`commissaryMcp: ${name} would hold the key; not written`);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, name), text);
  console.log(`wrote docs/steps/spi-1160/${name}`);
};

/** The panel's JSON API, as a script calls it: the stage's Access service token and admin token. */
const harness = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(new URL(pathname, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = text.slice(0, 300);
  try {
    json = JSON.parse(text);
  } catch {
    // text
  }
  return { status: response.status, json, text };
};

const rowOf = async () => ((await harness("GET", "/_t3flare/settings/api/mcp")).json?.servers ?? []).find((row: any) => row.name === SERVER);
const sessionOf = (text: string) => text.match(/sbx_[0-9a-f]{8,}/)?.[0];

const add = async () => {
  const answers: Array<string> = [];
  if ((await rowOf()) !== undefined) answers.push((await harness("POST", "/_t3flare/settings/api/mcp", { op: "remove", server: SERVER })).text);
  const added = await harness("POST", "/_t3flare/settings/api/mcp/servers", { server: SERVER, url: URL_, auth: { kind: "header", header: "x-api-key" }, value: KEY });
  const tested = await harness("POST", "/_t3flare/settings/api/mcp/test", { server: SERVER });
  const listed = await harness("GET", "/_t3flare/settings/api/mcp");
  const page = await harness("GET", "/_t3flare/settings");
  const audit = await harness("GET", "/_t3flare/settings/api/audit");
  answers.push(added.text, tested.text, listed.text, page.text, audit.text);
  const row = (listed.json?.servers ?? []).find((server: any) => server.name === SERVER);
  const tools = (row?.tools ?? []).map((tool: any) => `${tool.upstream}:${tool.class}`);
  writeEvidence("add.json", {
    note: "Commissary's MCP endpoint added through the panel's admin API as a direct server, signed in with an x-api-key header (T3FLARE_MCP_KEY, passed in by the script, never printed)",
    added: { status: added.status, answer: added.json },
    tested: { status: tested.status, answer: tested.json },
    row: { name: row?.name, setting: row?.setting, secret: row?.secret === undefined ? null : { set: row.secret.set }, status: row?.status, error: row?.error, tools },
    page: { status: page.status, showsServer: page.text.includes('id="srv-commissary"'), showsHeader: page.text.includes("<code>x-api-key</code>") },
    keyInAnyAnswer: answers.some((text) => text.includes(KEY)),
    ok:
      added.status === 200 &&
      tested.json?.status === "ok" &&
      row?.setting?.kind === "direct" &&
      row?.setting?.auth?.header === "x-api-key" &&
      row?.secret?.set === true &&
      ["sandbox_open:write", "sandbox_write:write", "sandbox_read:read", "sandbox_close:write"].every((tool) => tools.includes(tool)) &&
      answers.every((text) => !text.includes(KEY)),
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// A Durable agent (Pi Durable), in approval-required, through code mode scripts.

let cookie = "";

/** Sends `text`, answers each new card with `decision`, until the run settles; the cards with their prompts. */
const runTurn = async (threadId: string, text: string, decision: "accept" | "decline") => {
  const started = Date.now();
  const before = runsOf(projectionOf(await threadWindow(cookie, threadId))).length;
  await sendMessage(cookie, threadId, text, MODEL);
  const answered = new Set<string>();
  const cards: Array<any> = [];
  let projection: any;
  while (Date.now() - started < 8 * 60_000) {
    projection = projectionOf(await threadWindow(cookie, threadId));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      const item = itemsOf(projection).find((candidate: any) => candidate.requestId === request.id);
      answered.add(request.id);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision });
      cards.push({ kind: request.kind, prompt: String(item?.prompt ?? "").slice(0, 800), decision });
    }
    const runs = runsOf(projection);
    if (runs.length > before && runs.slice(before).every((run) => SETTLED.has(run.status))) break;
    await sleep(1500);
  }
  return { status: runsOf(projection).at(-1)?.status ?? null, cards, ms: Date.now() - started };
};

const verbatim = (code: string) =>
  `Call the codemode tool exactly once, with exactly this code (verbatim, change nothing), then reply with the script's output and nothing else:\n\n\`\`\`js\n${code}\n\`\`\``;

/** The thread's code mode results, newest last, from the Session's committed entries. */
const scriptOutputs = async (threadId: string): Promise<Array<string>> => {
  const state = (await admin("GET", `/_t3flare/agents/session?thread=${encodeURIComponent(threadId)}`)).json;
  return (state?.entries ?? []).filter((entry: any) => entry.role === "toolResult" && entry.toolName === "codemode").map((entry: any) => (entry.content ?? []).map((block: any) => block.text ?? "").join(""));
};

const durable = async () => {
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  const marker = `spi1160-durable-${Date.now().toString(36)}`;
  const workspace = marker;
  const { projectId } = await ensureProject(cookie, workspace);
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: marker, modelSelection: MODEL, runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  const T = `tools.mcp__${SERVER}__`;
  const cases: Array<any> = [];
  const write = await runTurn(
    threadId,
    verbatim(`const opened = String(await ${T}sandbox_open({}));\nconst session = opened.match(/sbx_[0-9a-f]+/)[0];\nconst wrote = await ${T}sandbox_write({ session, path: "note.txt", content: "${marker}" });\ntext(session + "\\n" + wrote);`),
    "accept",
  );
  const writeOut = (await scriptOutputs(threadId)).at(-1) ?? "";
  const session = sessionOf(writeOut);
  cases.push({ name: "a write: sandbox_open and sandbox_write each raise a card in approval-required; accepted, they run", ...write, output: writeOut.slice(0, 600), ok: write.status === "completed" && write.cards.length === 2 && write.cards.every((card: any) => card.kind === "permission" && card.prompt.includes(`${SERVER}: sandbox_`)) && /wrote/i.test(writeOut) });
  const read = await runTurn(threadId, verbatim(`text(await ${T}sandbox_read({ session: "${session}", path: "note.txt" }));`), "decline");
  const readOut = (await scriptOutputs(threadId)).at(-1) ?? "";
  cases.push({ name: "a read: sandbox_read runs without a card and shows what the write wrote", ...read, output: readOut.slice(0, 600), ok: read.status === "completed" && read.cards.length === 0 && readOut.includes(marker) });
  const close = await runTurn(threadId, verbatim(`text(await ${T}sandbox_close({ session: "${session}" }));`), "accept");
  const closeOut = (await scriptOutputs(threadId)).at(-1) ?? "";
  cases.push({ name: "cleanup: sandbox_close (a write, its card accepted)", ...close, output: closeOut.slice(0, 300), ok: close.cards.length === 1 && /closed/i.test(closeOut) });
  writeEvidence("durable.json", { agent: "Pi Durable", model: MODEL.model, threadId, mode: "approval-required", cases, ok: cases.every((c) => c.ok) });
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${workspace}`);
};

// ---------------------------------------------------------------------------------------------------------------------
// A CLI agent (Codex) through the MCP relay, in approval-required: the relay's cards are the wrapper's `t3flare-ask`.

const cli = async () => {
  await enableCli(cookie, "codex", "codex");
  const marker = `spi1160-codex-${Date.now().toString(36)}`;
  const workspace = marker;
  const card = (request: any) => String(request.id ?? "").includes(":t3flare-ask:") && request.kind === "permission";
  const only = "Do not run any shell command; use only the MCP tools named.";
  // The projection's requests are the thread's: each turn counts only those it raised.
  const seen = new Set<string>();
  const turn = async (prompt: string, approve: "accept" | "decline", threadId?: string) => {
    const result: any = await cliTurn(cookie, { cli: "codex", workspace, mode: "approval-required", plan: false, prompt, approve, ...(threadId === undefined ? {} : { threadId }) });
    const requests = result.requests.filter((request: any) => !seen.has(request.id));
    for (const request of requests) seen.add(request.id);
    return { threadId: result.threadId as string, model: result.model, run: result.runs.at(-1) ?? null, cards: requests.filter(card), requests, text: String(result.text), items: result.items.filter((item: any) => /mcp|tool/i.test(item.type)).slice(0, 8) };
  };
  const cases: Array<any> = [];
  const write = await turn(`Call the MCP tool sandbox_open of the "${SERVER}" MCP server with no arguments. Then call its sandbox_write with the session id it gave, path "note.txt" and content "${marker}". Reply with only the session id. ${only}`, "accept");
  const session = sessionOf(write.text);
  cases.push({ name: "a write: sandbox_open and sandbox_write each raise the relay's card in approval-required; accepted, they run", ...write, ok: write.run?.status === "completed" && write.cards.length === 2 && session !== undefined });
  const read = await turn(`Call the MCP tool sandbox_read of the "${SERVER}" MCP server with session "${session}" and path "note.txt", and reply with exactly what it returned. ${only}`, "decline", write.threadId);
  cases.push({ name: "a read: sandbox_read runs without a card and shows what the write wrote", ...read, ok: read.run?.status === "completed" && read.cards.length === 0 && read.text.includes(marker) });
  const close = await turn(`Call the MCP tool sandbox_close of the "${SERVER}" MCP server with session "${session}". Then say done. ${only}`, "accept", write.threadId);
  cases.push({ name: "cleanup: sandbox_close (a write, its card accepted)", ...close, ok: close.cards.length === 1 });
  writeEvidence("cli-codex.json", { agent: "Codex", workspace, mode: "approval-required", cases, ok: cases.every((c) => c.ok) });
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${workspace}`);
};

const phase = process.argv[2];
if (phase === "add") await add();
else {
  cookie = await pair();
  if (phase === "durable") await durable();
  else if (phase === "cli") await cli();
  else {
    console.error("usage: commissaryMcp.ts add|durable|cli");
    process.exit(2);
  }
}
process.exit(0);
