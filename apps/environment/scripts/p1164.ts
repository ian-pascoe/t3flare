// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalFetch:off
// SPI-1164's evidence on its stage: the Harness panel's "Sign in with ChatGPT" (ChatGPT plan usage) through the panel's
// own routes, as a script with the stage's service token, and a Durable turn with tools on the stage's API-key endpoint
// through the same Session code a sign-in's turn uses (the provider, the credential request, the turn).
//
//   node scripts/stage.ts run p1164 p1164 page        the panel shows the sign-in, its link field and the plain note
//   node scripts/stage.ts run p1164 p1164 start       starts a sign-in; prints the authorize URL (no secret) to relay
//   node scripts/stage.ts run p1164 p1164 complete <file>
//                                                     completes it with the address in <file> (0600, deleted after)
//   node scripts/stage.ts run p1164 p1164 status      the sign-in's status and the ChatGPT endpoint, as the panel lists them
//   node scripts/stage.ts run p1164 p1164 sign-out    signs the ChatGPT endpoint out
//   node scripts/stage.ts run p1164 p1164 turn        a Durable turn with tools on the stage's API-key endpoint
//
// Each writes `--out <file>` when given. No token is ever in an answer the panel gives; the authorize URL's state, nonce
// and challenge are recorded only by name.
import * as fs from "node:fs";

import { defaultTextModel, type ModelEndpoints } from "@t3flare/models/endpoints";

import { admin, pair } from "./lib/client.ts";
import { realTurn } from "./lib/realTurn.ts";

const [step, file] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--out");
const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const ID = "chatgpt";
const api = (method: string, path: string, body?: unknown) => admin(method, `/_t3flare/harness/api/${path}`, body);

const write = (report: Record<string, unknown>) => {
  const text = JSON.stringify({ at: new Date().toISOString(), step, ...report }, null, 2);
  console.log(text);
  if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
};

/** The authorize URL's parameters: fixed ones by value, the attempt's own (state, nonce, challenge) by name only. */
const describeAuthorize = (url: string) => {
  const parsed = new URL(url);
  const own = new Set(["state", "nonce", "code_challenge"]);
  return {
    endpoint: `${parsed.origin}${parsed.pathname}`,
    params: Object.fromEntries([...parsed.searchParams].map(([name, value]) => [name, own.has(name) ? `<${value.length} chars>` : value])),
  };
};

if (step === "page") {
  const full = await fetch(new URL("/_t3flare/harness", process.env.T3_URL), {
    headers: { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID!, "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET!, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN}` },
  });
  const page = await full.text();
  write({
    status: full.status,
    signInForm: page.includes("data-sign-in-form"),
    startButton: page.includes("data-sign-in-start"),
    pasteField: page.includes('name="pasted"'),
    unverifiedNote: /ChatGPT plan usage is unverified in t3flare/.test(page) && /Plus or Pro/.test(page),
    excerpt: (/<form class="group add" id="sign-in-form"[\s\S]*?<\/form>/.exec(page)?.[0] ?? page.slice(0, 500)).replace(/\s+/g, " ").slice(0, 3000),
  });
} else if (step === "start") {
  const answer = await api("POST", "endpoints/sign-in", { op: "start", id: ID, signIn: "chatgpt", label: "ChatGPT" });
  const url = typeof answer.json?.authorizeUrl === "string" ? answer.json.authorizeUrl : undefined;
  write({ status: answer.status, ok: answer.json?.ok === true, authorize: url === undefined ? answer.json : describeAuthorize(url) });
  // For the owner's browser (relayed): the link holds no secret, only this attempt's state and challenge.
  if (url !== undefined) console.error(`\nAUTHORIZE ${url}\n`);
} else if (step === "complete") {
  if (file === undefined) throw new Error("complete <file>: the file holding the pasted address");
  const pasted = fs.readFileSync(file, "utf8").trim();
  const started = Date.now();
  const answer = await api("POST", "endpoints/sign-in", { op: "complete", id: ID, label: "ChatGPT", pasted });
  fs.rmSync(file);
  const code = new URL(pasted.startsWith("http") ? pasted : `http://${pasted}`).searchParams.get("code");
  const text = JSON.stringify(answer.json);
  if (code !== null && text.includes(code)) throw new Error("the pasted code reached the panel's answer");
  write({ status: answer.status, ms: Date.now() - started, answer: answer.json, pastedShape: { length: pasted.length, scheme: pasted.split(":")[0], params: [...new URL(pasted.startsWith("http") ? pasted : `http://${pasted}`).searchParams.keys()] } });
} else if (step === "status") {
  const listed = await api("GET", "endpoints");
  const endpoints = (listed.json?.endpoints ?? []) as Array<Record<string, unknown>>;
  write({
    endpoints: endpoints.map((endpoint) => ({ id: endpoint.id, auth: endpoint.auth, api: endpoint.api, baseUrl: endpoint.baseUrl, models: (endpoint.models as Array<{ id: string }>).map((model) => model.id), signIn: endpoint.signIn ?? null })),
    signIns: listed.json?.signIns ?? null,
    audit: ((await api("GET", "audit")).json?.entries ?? []).filter((entry: { entity: string }) => entry.entity === "endpoints").slice(0, 10),
  });
} else if (step === "sign-out") {
  const answer = await api("POST", "endpoints/sign-in", { op: "sign-out", id: ID });
  write({ status: answer.status, answer: answer.json });
} else if (step === "turn") {
  const listed = await api("GET", "endpoints");
  const endpoints = (listed.json?.endpoints ?? []) as ModelEndpoints["endpoints"];
  // The stage's API-key endpoint's small model, by text generation's rule (the cheapest known small model).
  const model = defaultTextModel({ revision: 0, endpoints: endpoints.filter((endpoint) => endpoint.auth === "api-key") });
  if (model === undefined) throw new Error("the stage has no API-key endpoint with a small model");
  const cookie = await pair();
  await admin("POST", "/_t3flare/disarm-bootstrap");
  const turn = await realTurn(cookie, { push: false, model });
  write({ model, ...turn });
  process.exit(turn.ok ? 0 : 1);
} else {
  console.error("usage: p1164 page|start|complete <file>|status|sign-out|turn [--out file]");
  process.exit(2);
}
