// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalFetch:off globalTimers:off
// SPI-1166's evidence on its stage: the Harness panel's "Sign in with GitHub Copilot" (a Copilot plan, GitHub's device
// flow) through the panel's own routes, as a script with the stage's service token, a Durable turn with tools on the
// Copilot endpoint, and a sign-out.
//
//   node scripts/stage.ts run p1166 p1166 page          the panel shows the device sign-in and its note, no paste field
//   node scripts/stage.ts run p1166 p1166 start         starts a sign-in; prints GitHub's device page and the code to
//                                                       relay to the owner (the device code never leaves the stage)
//   node scripts/stage.ts run p1166 p1166 pending       while the attempt waits: one ask (still waiting), and the page,
//                                                       status and audit hold no token form
//   node scripts/stage.ts run p1166 p1166 complete [s]  asks at GitHub's interval until approved, refused, lapsed or s
//                                                       seconds (default 60) pass
//   node scripts/stage.ts run p1166 p1166 status        the sign-in's status and the Copilot endpoint, as the panel lists them
//   node scripts/stage.ts run p1166 p1166 models <id>…  sets the Copilot endpoint's models ("Edit models")
//   node scripts/stage.ts run p1166 p1166 turn          a Durable turn with tools on the Copilot endpoint's small model
//   node scripts/stage.ts run p1166 p1166 sign-out      signs the Copilot endpoint out
//   node scripts/stage.ts run p1166 p1166 scan          the page, status and audit hold no GitHub or Copilot token's form
//
// Each writes `--out <file>` when given. No token is ever in an answer the panel gives; the user code is recorded only by
// its shape.
import * as fs from "node:fs";

import { defaultTextModel, type ModelEndpoints } from "@t3flare/models/endpoints";

import { admin, pair } from "./lib/client.ts";
import { realTurn } from "./lib/realTurn.ts";

const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const [step, ...args] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--out");
const ID = "copilot";
const api = (method: string, path: string, body?: unknown) => admin(method, `/_t3flare/harness/api/${path}`, body);
/** GitHub's token forms (`gho_`, `ghu_`, …), a Copilot token (`tid=…;exp=…`), and a bearer header. */
const TOKEN_FORMS = /gh[opusr]_[A-Za-z0-9]{8}|tid=[^;\s"]+;|Bearer /;

const write = (report: Record<string, unknown>) => {
  const text = JSON.stringify({ at: new Date().toISOString(), step, ...report }, null, 2);
  console.log(text);
  if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
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

/** A user code by its shape only (`XXXX-XXXX` as `4-4`). */
const shapeOf = (code: string) => code.split("-").map((part) => part.length).join("-");

if (step === "page") {
  const { status, html } = await page();
  const form = /<form class="group add" id="sign-in-copilot-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
  write({
    status,
    signInForm: html.includes('data-sign-in-kind="copilot"'),
    device: form.includes("data-sign-in-device") && form.includes("data-sign-in-code"),
    pasteField: form.includes('name="pasted"'),
    note: /GitHub(&#39;|')s terms may not allow/.test(form) && /Copilot plan/.test(form) && /github\.com, under Settings, Applications/.test(form),
    excerpt: (form === "" ? html.slice(0, 500) : form).replace(/\s+/g, " ").slice(0, 3000),
  });
} else if (step === "start") {
  const answer = await api("POST", "endpoints/sign-in", { op: "start", id: ID, signIn: "copilot", label: "GitHub Copilot" });
  const device = answer.json?.device as { userCode: string; expiresAt: number; intervalSeconds: number } | undefined;
  write({
    status: answer.status,
    ok: answer.json?.ok === true,
    authorizeUrl: answer.json?.authorizeUrl ?? answer.json,
    device: device === undefined ? null : { userCode: `<${shapeOf(device.userCode)}>`, expiresAt: new Date(device.expiresAt).toISOString(), intervalSeconds: device.intervalSeconds },
  });
  // For the owner (relayed): GitHub's device page and the code to enter there; neither is a secret.
  if (device !== undefined) console.error(`\nOPEN ${answer.json.authorizeUrl}\nCODE ${device.userCode}\n`);
} else if (step === "pending") {
  const asked = await api("POST", "endpoints/sign-in", { op: "complete", id: ID, label: "GitHub Copilot" });
  const texts = await panelTexts();
  const listed = (await api("GET", "endpoints")).json as { signIns?: Record<string, { pendingSince: number | null }> };
  const found = Object.entries({ ...texts, asked: asked.json }).filter(([, value]) => TOKEN_FORMS.test(JSON.stringify(value)));
  write({ asked: asked.json, waiting: listed.signIns?.[ID]?.pendingSince != null, pattern: String(TOKEN_FORMS), found: found.map(([name]) => name) });
} else if (step === "complete") {
  const until = Date.now() + Number(args[0] ?? 60) * 1000;
  const started = Date.now();
  let answer = await api("POST", "endpoints/sign-in", { op: "complete", id: ID, label: "GitHub Copilot" });
  let asks = 1;
  while (answer.json?.waiting === true && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    answer = await api("POST", "endpoints/sign-in", { op: "complete", id: ID, label: "GitHub Copilot" });
    asks += 1;
  }
  if (TOKEN_FORMS.test(JSON.stringify(answer.json))) throw new Error("a token's form reached the panel's answer");
  write({ status: answer.status, ms: Date.now() - started, asks, answer: answer.json });
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
  if (endpoint === undefined) throw new Error("no Copilot endpoint yet: sign in first");
  const answer = await api("POST", "endpoints", { op: "save", endpoint: { id: ID, label: endpoint.label, api: endpoint.api, baseUrl: endpoint.baseUrl, auth: endpoint.auth, headers: {}, models: args } });
  write({ status: answer.status, models: answer.json?.endpoint?.models?.map((model: { id: string }) => model.id) ?? answer.json });
} else if (step === "turn") {
  const listed = await api("GET", "endpoints");
  const endpoints = (listed.json?.endpoints ?? []) as ModelEndpoints["endpoints"];
  // The Copilot endpoint's small model, by text generation's rule.
  const model = defaultTextModel({ revision: 0, endpoints: endpoints.filter((endpoint) => endpoint.id === ID) });
  if (model === undefined) throw new Error("the Copilot endpoint has no small model");
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
  console.error("usage: p1166 page|start|pending|complete [seconds]|status|models <id>…|turn|sign-out|scan [--out file]");
  process.exit(2);
}
