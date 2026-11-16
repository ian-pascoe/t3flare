// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalFetch:off
// SPI-1165's evidence on its stage: the Harness panel's "Sign in with Claude" (a Claude Pro or Max plan, Claude Code's
// OAuth) through the panel's own routes, as a script with the stage's service token, a Durable turn with tools on the
// Claude endpoint, and a sign-out.
//
//   node scripts/stage.ts run p1165 p1165 page          the panel shows the sign-in, its paste field and its note
//   node scripts/stage.ts run p1165 p1165 start <file>  starts a sign-in; prints the authorize URL to relay, and keeps
//                                                       it in <file> (0600) for `pending`'s scan
//   node scripts/stage.ts run p1165 p1165 pending <file>
//                                                       while the attempt waits: the page, status and audit hold none of
//                                                       its state or challenge (from <file>, deleted after)
//   node scripts/stage.ts run p1165 p1165 complete <file>
//                                                       completes it with the code in <file> (0600, deleted after)
//   node scripts/stage.ts run p1165 p1165 status        the sign-in's status and the Claude endpoint, as the panel lists them
//   node scripts/stage.ts run p1165 p1165 models <id>…  sets the Claude endpoint's models ("Edit models")
//   node scripts/stage.ts run p1165 p1165 turn          a Durable turn with tools on the Claude endpoint's small model
//   node scripts/stage.ts run p1165 p1165 sign-out      signs the Claude endpoint out
//   node scripts/stage.ts run p1165 p1165 scan          the page, status and audit hold no Claude token's form
//
// Each writes `--out <file>` when given. No token is ever in an answer the panel gives; the authorize URL's state and
// challenge are recorded only by length.
import * as fs from "node:fs";

import { defaultTextModel, type ModelEndpoints } from "@t3flare/models/endpoints";

import { admin, pair } from "./lib/client.ts";
import { realTurn } from "./lib/realTurn.ts";

const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const [step, ...args] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--out");
const file = args[0];
const ID = "claude";
const api = (method: string, path: string, body?: unknown) => admin(method, `/_t3flare/harness/api/${path}`, body);
/** A Claude subscription's token forms (access `sk-ant-oat…`, refresh `sk-ant-ort…`), and a bearer header. */
const TOKEN_FORMS = /sk-ant-o[ar]t|Bearer /;

const write = (report: Record<string, unknown>) => {
  const text = JSON.stringify({ at: new Date().toISOString(), step, ...report }, null, 2);
  console.log(text);
  if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
};

/** The authorize URL's parameters: fixed ones by value, the attempt's own (state, challenge) by length only. */
const describeAuthorize = (url: string) => {
  const parsed = new URL(url);
  const own = new Set(["state", "code_challenge"]);
  return {
    endpoint: `${parsed.origin}${parsed.pathname}`,
    params: Object.fromEntries([...parsed.searchParams].map(([name, value]) => [name, own.has(name) ? `<${value.length} chars>` : value])),
  };
};

const page = async (): Promise<{ readonly status: number; readonly html: string }> => {
  const full = await fetch(new URL("/_t3flare/harness", process.env.T3_URL), {
    headers: { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID!, "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET!, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN}` },
  });
  return { status: full.status, html: await full.text() };
};

/** Everything the panel shows of the endpoints: the page, the list with each sign-in's status, the audit. */
const panelTexts = async (): Promise<{ readonly page: string; readonly listed: unknown; readonly audit: ReadonlyArray<unknown> }> => {
  const listed = await api("GET", "endpoints");
  const audit = ((await api("GET", "audit")).json?.entries ?? []).filter((entry: { entity: string }) => entry.entity === "endpoints");
  return { page: (await page()).html, listed: listed.json, audit };
};

if (step === "page") {
  const { status, html } = await page();
  write({
    status,
    signInForm: html.includes('data-sign-in-kind="claude"'),
    pasteField: html.includes('id="sign-in-claude-paste"'),
    note: /Anthropic(&#39;|')s terms may not allow/.test(html) && /Pro or Max/.test(html) && /claude\.ai/.test(html),
    excerpt: (/<form class="group add" id="sign-in-claude-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? html.slice(0, 500)).replace(/\s+/g, " ").slice(0, 3000),
  });
} else if (step === "start") {
  if (file === undefined) throw new Error("start <file>: where the authorize URL is kept for `pending`");
  const answer = await api("POST", "endpoints/sign-in", { op: "start", id: ID, signIn: "claude", label: "Claude" });
  const url = typeof answer.json?.authorizeUrl === "string" ? answer.json.authorizeUrl : undefined;
  if (url !== undefined) fs.writeFileSync(file, url, { mode: 0o600 });
  write({ status: answer.status, ok: answer.json?.ok === true, authorize: url === undefined ? answer.json : describeAuthorize(url) });
  // For the owner's browser (relayed): the link holds no secret but this attempt's state and challenge.
  if (url !== undefined) console.error(`\nAUTHORIZE ${url}\n`);
} else if (step === "pending") {
  if (file === undefined) throw new Error("pending <file>: the authorize URL `start` kept");
  const url = new URL(fs.readFileSync(file, "utf8").trim());
  fs.rmSync(file);
  const own = ["state", "code_challenge"].map((name) => url.searchParams.get(name) ?? "").filter((value) => value !== "");
  const texts = JSON.stringify(await panelTexts());
  const listed = (await api("GET", "endpoints")).json as { signIns?: Record<string, { pendingSince: number | null }> };
  write({ waiting: listed.signIns?.[ID]?.pendingSince !== null && listed.signIns?.[ID] !== undefined, checked: own.map((value) => `<${value.length} chars>`), found: own.filter((value) => texts.includes(value)).length });
} else if (step === "complete") {
  if (file === undefined) throw new Error("complete <file>: the file holding the pasted code");
  const pasted = fs.readFileSync(file, "utf8").trim();
  const started = Date.now();
  const answer = await api("POST", "endpoints/sign-in", { op: "complete", id: ID, label: "Claude", pasted });
  fs.rmSync(file);
  const code = pasted.split("#")[0] ?? "";
  if (code !== "" && JSON.stringify(answer.json).includes(code)) throw new Error("the pasted code reached the panel's answer");
  write({ status: answer.status, ms: Date.now() - started, answer: answer.json, pastedShape: { length: pasted.length, parts: pasted.split("#").map((part) => part.length) } });
} else if (step === "status") {
  const listed = await api("GET", "endpoints");
  const endpoints = (listed.json?.endpoints ?? []) as Array<Record<string, unknown>>;
  write({
    endpoints: endpoints.map((endpoint) => ({ id: endpoint.id, auth: endpoint.auth, api: endpoint.api, baseUrl: endpoint.baseUrl, models: (endpoint.models as Array<{ id: string }>).map((model) => model.id), signIn: endpoint.signIn ?? null })),
    signIns: listed.json?.signIns ?? null,
    audit: ((await api("GET", "audit")).json?.entries ?? []).filter((entry: { entity: string }) => entry.entity === "endpoints").slice(0, 10),
  });
} else if (step === "models") {
  const listed = (await api("GET", "endpoints")).json?.endpoints as ModelEndpoints["endpoints"] | undefined;
  const endpoint = listed?.find((entry) => entry.id === ID);
  if (endpoint === undefined) throw new Error("no Claude endpoint yet: sign in first");
  const answer = await api("POST", "endpoints", { op: "save", endpoint: { id: ID, label: endpoint.label, api: endpoint.api, baseUrl: endpoint.baseUrl, auth: endpoint.auth, headers: {}, models: args } });
  write({ status: answer.status, models: answer.json?.endpoint?.models?.map((model: { id: string }) => model.id) ?? answer.json });
} else if (step === "turn") {
  const listed = await api("GET", "endpoints");
  const endpoints = (listed.json?.endpoints ?? []) as ModelEndpoints["endpoints"];
  // The Claude endpoint's small model, by text generation's rule.
  const model = defaultTextModel({ revision: 0, endpoints: endpoints.filter((endpoint) => endpoint.id === ID) });
  if (model === undefined) throw new Error("the Claude endpoint has no small model");
  const cookie = await pair();
  await admin("POST", "/_t3flare/disarm-bootstrap");
  const turn = await realTurn(cookie, { push: false, model });
  write({ model, ...turn });
  process.exit(turn.ok ? 0 : 1);
} else if (step === "sign-out") {
  const answer = await api("POST", "endpoints/sign-in", { op: "sign-out", id: ID });
  write({ status: answer.status, answer: answer.json });
} else if (step === "scan") {
  const texts = await panelTexts();
  const found = Object.entries(texts).filter(([, value]) => TOKEN_FORMS.test(JSON.stringify(value)));
  write({ scanned: Object.keys(texts), pattern: String(TOKEN_FORMS), found: found.map(([name]) => name) });
} else {
  console.error("usage: p1165 page|start <file>|pending <file>|complete <file>|status|models <id>…|turn|sign-out|scan [--out file]");
  process.exit(2);
}
