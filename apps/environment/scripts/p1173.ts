// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1173's evidence on its stage: t3's Usage page from t3flare's own usage records, beside Commissary's request log.
//
//   T3FLARE_PROBE=1 node scripts/stage.ts deploy p1173
//   node scripts/stage.ts run p1173 p1173 [--out ../../docs/steps/spi-1173/p1173.json]
//
// 1. Four Model endpoints saved through the Harness panel's API: three of Commissary's with the Model proxy's key
//    (SPI-1162's approach; Commissary's log counts their requests, so our records of them are dropped): `comm`
//    (Anthropic Messages), `oai` (Chat Completions), `resp` (OpenAI Responses); and `standin`, the stage's probe Worker's
//    Chat Completions stand-in keyed with the probe key (ours to count), serving `STANDIN_MODEL`, a model pi-ai does not
//    price and LiteLLM does. Text generation is pointed at `standin`.
// 2. A turn on each agent: the Durable agent on `comm`, its thread's title regenerated (text generation on `standin`),
//    the Durable agent on `standin`; Codex on `resp`; Claude Code on `comm` (model-routed); pi on `oai` and on
//    `standin`; OpenCode on `oai`.
// 3. t3's usage summary (`server.getUsageSummary`, what the Usage page reads): our sources (`t3flare://usage/<agent>`)
//    have the `standin` turns, priced by t3's rate table, and nothing of the Commissary endpoints; Commissary's half is
//    on the page too (on a probe stage, the probe's stand-in log). Commissary's own log (dev.env's
//    COMMISSARY_MANAGEMENT_*, read here with the script's own `commissary.ts` client) has this run's requests on the
//    proxy's key: counted once, there. It also holds the owner's other traffic on that key, so only this run's model
//    since the run started is counted.
//
// No key or handle is printed or kept: every answer kept is scanned for the keys first.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import { cliTurn as acpTurn, enable as enableAcp } from "./lib/acpTurn.ts";
import { admin, base, createProjectAndThread, dispatch, pair, projectionOf, runsOf, sendMessage, SETTLED, sleep, threadWindow, updateSettings, uuid, wsCall } from "./lib/client.ts";
import { cliTurn, enable } from "./lib/cliTurn.ts";
import { commissaryManagementOf, readUsageRecords, toUsageRecord } from "../src/usage/commissary.ts";

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = option("out");
const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";
const probeKey = process.env.T3FLARE_PROBE_KEY ?? "";
const stage = base.hostname.split(".")[0]!.replace(/^t3flare-environment-/, "");
const PROBE = `https://t3flare-probe-${stage}.ian-g-pascoe.workers.dev`;
const secrets = [proxyKey, probeKey].filter((value) => value.length >= 8);
const failures: Array<string> = [];
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const report: Record<string, unknown> = { at: new Date().toISOString(), head };
const check = (name: string, ok: boolean, detail?: unknown) => {
  report.checks = [...((report.checks as Array<unknown>) ?? []), { name, ok }];
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 800)}`);
  return ok;
};
const clean = <T>(value: T): T => {
  const text = JSON.stringify(value) ?? "";
  for (const secret of secrets) if (text.includes(secret)) throw new Error("a key reached an answer kept as evidence");
  return value;
};
const finish = (): never => {
  report.failures = failures;
  report.ok = failures.length === 0;
  const text = JSON.stringify(clean(report), null, 2);
  console.log(text.slice(0, 30_000));
  if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
  process.exit(report.ok ? 0 : 1);
};
const api = (method: string, pathname: string, body?: unknown) => admin(method, `/_t3flare/harness/api/${pathname}`, body);

if (proxyUrl === "" || proxyKey === "" || probeKey === "") {
  failures.push("the stage needs MODEL_PROXY_URL and MODEL_PROXY_API_KEY (dev.env), and the probe (deploy with T3FLARE_PROBE=1)");
  finish();
}

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const readSummary = async () => (await wsCall(cookie, "server.getUsageSummary", { sinceDay: yesterday, untilDay: today, timeZone: "UTC", awaitRefresh: true })) as any;
const tokensOf = (bucket: any) => (bucket.totals?.uncachedInputTokens ?? 0) + (bucket.totals?.cachedInputTokens ?? 0) + (bucket.totals?.cacheCreationTokens ?? 0) + (bucket.totals?.outputTokens ?? 0);
const runStart = Date.now();

// 1. The endpoints, and text generation on the stand-in's model.
const MODEL = "claude-haiku-5-5";
/** The stand-in's model: one pi-ai's catalog does not know (so the endpoint has no price for it), and LiteLLM does. */
const STANDIN_MODEL = "claude-fable-5-2";
const COMMISSARY = {
  comm: { label: "Commissary (Anthropic)", api: "anthropic-messages", baseUrl: proxyUrl },
  oai: { label: "Commissary (Chat Completions)", api: "openai-completions", baseUrl: `${proxyUrl}/v1` },
  resp: { label: "Commissary (Responses)", api: "openai-responses", baseUrl: `${proxyUrl}/v1` },
} as const;
const saved: Record<string, number> = {};
for (const [id, spec] of Object.entries(COMMISSARY)) {
  saved[id] = (await api("POST", "endpoints", { op: "save", endpoint: { id, ...spec, auth: "api-key", headers: {}, models: [MODEL] }, apiKey: proxyKey })).status;
}
saved.standin = (await api("POST", "endpoints", { op: "save", endpoint: { id: "standin", label: "Stand-in", api: "openai-completions", baseUrl: `${PROBE}/relay/v1`, auth: "api-key", headers: {}, models: [STANDIN_MODEL] }, apiKey: probeKey })).status;
const listed = ((await api("GET", "endpoints")).json?.endpoints ?? []) as Array<any>;
const standinCost = listed.find((endpoint) => endpoint.id === "standin")?.models?.find((model: any) => model.id === STANDIN_MODEL)?.cost ?? null;
report.endpoints = { saved, model: MODEL, standin: { model: STANDIN_MODEL, endpointCost: standinCost, baseUrl: "<probe>/relay/v1" }, baseUrls: { comm: "<MODEL_PROXY_URL>", oai: "<MODEL_PROXY_URL>/v1", resp: "<MODEL_PROXY_URL>/v1" } };
check("the four endpoints saved", Object.values(saved).every((status) => status === 200), saved);
check("the stand-in's endpoint has no price for its model", standinCost === null || Object.values(standinCost).every((value) => value === 0), standinCost);
const SLUG = { comm: `comm/${MODEL}`, oai: `oai/${MODEL}`, resp: `resp/${MODEL}`, standin: `standin/${STANDIN_MODEL}` };
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
await updateSettings(cookie, { textGenerationModelSelection: { instanceId: "piDurable", model: SLUG.standin } });

// 2. A turn on each agent.
const run = Date.now().toString(36);
const turns: Record<string, unknown> = {};
const settled = (status: string | undefined) => status === "completed";

// The Durable agent: a turn on comm's model, the thread's title regenerated by text generation (the stand-in's), then a
// turn on the stand-in.
{
  const { threadId } = await createProjectAndThread(cookie, { title: "New thread", workspaceRoot: `/w/p1173-durable-${run}` });
  const durableTurn = async (slug: string, count: number) => {
    await sendMessage(cookie, threadId, "In one short sentence, what is a usage record?", { instanceId: "piDurable", model: slug, options: [] });
    const started = Date.now();
    let projection: any;
    while (Date.now() - started < 5 * 60_000) {
      projection = projectionOf(await threadWindow(cookie, threadId));
      const runs = runsOf(projection);
      if (runs.length >= count && runs.every((entry) => SETTLED.has(entry.status))) break;
      await sleep(1500);
    }
    return runsOf(projection).map((entry) => entry.status);
  };
  const first = await durableTurn(SLUG.comm, 1);
  check("a Durable turn on Commissary's Anthropic Messages endpoint", settled(first.at(-1)), first);
  const commandId = uuid();
  await dispatch(cookie, { type: "thread.metadata.update", commandId, threadId, regenerateTitle: true });
  let title: any = null;
  for (let i = 0; i < 60 && title?.requestId !== commandId; i++) {
    await sleep(2000);
    const projection = projectionOf(await threadWindow(cookie, threadId));
    title = projection?.thread?.lastTitleRegeneration ?? null;
  }
  // The stand-in answers "ready", not a title: text generation's request is what is recorded, whatever t3 makes of it.
  check("the thread's title asked of text generation on the stand-in (answered: its usage is recorded below)", title?.requestId === commandId, title);
  const second = await durableTurn(SLUG.standin, 2);
  check("a Durable turn on the stand-in", settled(second.at(-1)), second);
  turns.durable = { threadId, runs: second, title: clean(title) };
}
const ask = "Reply with the single word: ready.";
const cli = async (name: string, turn: () => Promise<{ runs: Array<any>; text: string }>, what: string) => {
  const answer = await turn();
  turns[name] = clean({ runs: answer.runs.slice(-1), text: answer.text });
  check(what, settled(answer.runs.at(-1)?.status), turns[name]);
};
await cli("codex", () => cliTurn(cookie, { cli: "codex", workspace: `usage-cli-${run}`, model: SLUG.resp, mode: "full-access", plan: false, prompt: ask }), "a Codex turn on Commissary's Responses endpoint, through the relay");
await enable(cookie, "pi", "pi");
await sleep(2000);
await cli("pi", () => cliTurn(cookie, { cli: "pi", workspace: `usage-cli-${run}`, model: SLUG.oai, mode: "full-access", plan: false, prompt: ask }), "a pi turn on Commissary's Chat Completions endpoint, through the relay");
await cli("piStandin", () => cliTurn(cookie, { cli: "pi", workspace: `usage-cli-${run}`, model: SLUG.standin, mode: "full-access", plan: false, prompt: ask }), "a pi turn on the stand-in, through the relay");
await enableAcp(cookie, "claude");
await sleep(2000);
await cli("claude", () => acpTurn(cookie, { cli: "claude", workspace: `usage-acp-${run}`, model: SLUG.comm, mode: "full-access", plan: false, prompt: ask }), "a Claude Code turn on Commissary's Anthropic Messages endpoint, model-routed through the relay");
await enableAcp(cookie, "opencode");
await sleep(2000);
await cli("opencode", () => acpTurn(cookie, { cli: "opencode", workspace: `usage-acp-${run}`, model: SLUG.oai, mode: "full-access", plan: false, prompt: ask }), "an OpenCode turn on Commissary's Chat Completions endpoint, through the relay");
report.turns = turns;

// 3. The usage summary the Usage page reads, after the records' sends have landed.
await sleep(5000);
const summary = await readSummary();
const ours = (summary?.buckets ?? []).filter((bucket: any) => String(bucket.sourcePath ?? "").startsWith("t3flare://usage/"));
const rows = new Map<string, { provider: string; source: string; model: string; tokens: number; records: number; costUsd: number; costSource: string; sessions: number }>();
for (const bucket of ours) {
  const key = `${bucket.provider} ${bucket.sourcePath} ${bucket.model}`;
  const row = rows.get(key) ?? { provider: bucket.provider, source: bucket.sourcePath, model: bucket.model, tokens: 0, records: 0, costUsd: 0, costSource: bucket.costSource, sessions: 0 };
  row.tokens += tokensOf(bucket);
  row.records += bucket.records ?? 0;
  row.costUsd += bucket.costUsd ?? 0;
  row.sessions = Math.max(row.sessions, bucket.sessions ?? 0);
  rows.set(key, row);
}
const table = [...rows.values()].sort((a, b) => `${a.provider}${a.source}`.localeCompare(`${b.provider}${b.source}`));
const real = commissaryManagementOf(process.env);
const logged = real === undefined ? undefined : await readUsageRecords((input, init) => fetch(input, init), real, runStart, toUsageRecord).catch((error: unknown) => ({ error: String(error).slice(0, 200) }));
const ofRun = logged === undefined || "error" in logged ? [] : logged.records.filter((record) => record!.model === MODEL);
const commissaryLog = logged === undefined ? { configured: false } : "error" in logged ? logged : { since: new Date(runStart).toISOString(), model: MODEL, requests: ofRun.length, byProvider: Object.fromEntries([...new Set(ofRun.map((record) => record!.provider))].map((provider) => [provider, ofRun.filter((record) => record!.provider === provider).length])) };
report.usage = clean({
  table,
  commissaryLog,
  sources: (summary?.sources ?? []).map((source: any) => ({ provider: source.fingerprint.provider, source: source.fingerprint.resolvedHomePath, status: source.status, scannedFiles: source.scannedFiles, distinctSessions: source.distinctSessions, message: source.message })),
  pricing: summary?.pricing,
});
const has = (provider: string, source: string, model: string) => table.some((row) => row.provider === provider && row.source === `t3flare://usage/${source}` && row.model === model && row.tokens > 0);
check("our records: the Durable agent's turn on the stand-in, under Pi, by its endpoint's model", has("pi", "durable", SLUG.standin), table);
check("our records: text generation's title on the stand-in, under Pi", has("pi", "text-generation", SLUG.standin), table);
check("our records: pi's relayed turn on the stand-in, under Pi (the pi CLI's source)", has("pi", "pi", SLUG.standin), table);
check("the stand-in's model, with no endpoint price, is priced by t3's rate table", table.filter((row) => row.model === SLUG.standin).every((row) => row.costSource === "modelPriced" && row.costUsd > 0), table);
check("no record of ours for an endpoint on the proxy's key (Commissary's log counts those)", !table.some((row) => /^(comm|oai|resp)\//.test(row.model)), table);
check("Commissary's own log has this run's requests on the proxy's key (at least one per turn on its endpoints): counted once, there", ofRun.length >= 5, commissaryLog);
check("both halves are on the page: our sources and Commissary's", (summary?.sources ?? []).some((source: any) => String(source.fingerprint?.resolvedHomePath).startsWith("t3flare://")) && (summary?.sources ?? []).some((source: any) => String(source.fingerprint?.resolvedHomePath).startsWith("commissary://")), report.usage);
finish();
