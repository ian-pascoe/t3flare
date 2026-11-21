// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-1162's evidence on its stage: Model endpoints through the Settings page's API (the stage's service token, as a
// script), a Durable turn with tools on each, the picker grouped by endpoint, a changed model list reaching the picker
// and a running thread, and a removed endpoint's model failing the turn with a clear message.
//
//   node scripts/stage.ts run p1162 p1162 [--out ../../.evidence/spi-1162/p1162.json]
//
// The Anthropic Messages endpoint is the stage's Model proxy (Commissary) at MODEL_PROXY_URL with its key; the OpenAI
// one is Commissary's OpenAI Responses API at `<MODEL_PROXY_URL>/v1` with the same key, unless OPENAI_API_KEY is set (then
// OpenAI's own API with gpt-5-mini). Commissary has no GPT model this key may use, so through it the Responses endpoint
// runs gemini-3-flash (Commissary translates). No key is printed: every answer kept is scanned for them first.
import * as fs from "node:fs";

import { admin, createProjectAndThread, pair, projectionOf, runsOf, sendMessage, SETTLED, sleep, threadWindow, wsCall } from "./lib/client.ts";
import { realTurn } from "./lib/realTurn.ts";

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = option("out");
const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";
const openaiKey = process.env.OPENAI_API_KEY;
const secrets = [proxyKey, openaiKey].filter((value): value is string => value !== undefined && value.length >= 8);
const failures: Array<string> = [];
const report: Record<string, unknown> = { at: new Date().toISOString(), openai: openaiKey === undefined ? "Commissary's OpenAI Responses API" : "OpenAI's API" };
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 600)}`);
  return ok;
};
const clean = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of secrets) if (text.includes(secret)) throw new Error("a key reached an answer kept as evidence");
  return value;
};
const finish = () => {
  report.failures = failures;
  report.ok = failures.length === 0;
  const text = JSON.stringify(clean(report), null, 2);
  console.log(text);
  if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
  process.exit(report.ok ? 0 : 1);
};

const api = (method: string, path: string, body?: unknown) => admin(method, `/_t3flare/settings/api/${path}`, body);

const ANTHROPIC = { id: "commissary", label: "Commissary", api: "anthropic-messages", baseUrl: proxyUrl, auth: "api-key", headers: {} };
const OPENAI =
  openaiKey === undefined
    ? { id: "openai", label: "OpenAI (Responses)", api: "openai-responses", baseUrl: `${proxyUrl}/v1`, auth: "api-key", headers: { "X-T3flare-Evidence": "p1162" } }
    : { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {} };
const OPENAI_KEY = openaiKey ?? proxyKey;

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");

// 1. The model lists, read from each endpoint with the key typed (the form's Read model list).
const discovered = async (endpoint: unknown, apiKey: string) => {
  const answer = await api("POST", "endpoints/discover", { endpoint, apiKey });
  clean(answer);
  return answer.json as { ok: boolean; models?: Array<{ id: string; name: string; known: boolean; reasoning: boolean }>; error?: string };
};
const anthropicList = await discovered(ANTHROPIC, proxyKey);
const openaiList = await discovered(OPENAI, OPENAI_KEY);
report.discovered = {
  commissary: { ok: anthropicList.ok, count: anthropicList.models?.length ?? 0, error: anthropicList.error ?? null, sample: anthropicList.models?.slice(0, 5) },
  openai: { ok: openaiList.ok, count: openaiList.models?.length ?? 0, error: openaiList.error ?? null, sample: openaiList.models?.filter((model) => model.id.startsWith("gpt")).slice(0, 5) },
};
check("Commissary's model list was read", anthropicList.ok && (anthropicList.models?.length ?? 0) > 0, report.discovered);
const claude = "claude-haiku-5-5";
const ids = new Set((openaiList.models ?? []).map((model) => model.id));
const gpt = openaiKey === undefined ? "gemini-3-flash" : "gpt-5-mini";
check("the Responses endpoint lists the model used", ids.has(gpt), [...ids].slice(0, 20));
report.models = { anthropic: `commissary/${claude}`, openai: `openai/${gpt}` };

// 2. Both endpoints saved, keys sealed; the entity listed without them.
const saveAnthropic = await api("POST", "endpoints", { op: "save", endpoint: { ...ANTHROPIC, models: [claude] }, apiKey: proxyKey });
const saveOpenai = await api("POST", "endpoints", { op: "save", endpoint: { ...OPENAI, models: [gpt] }, apiKey: OPENAI_KEY });
report.saved = clean({ commissary: saveAnthropic, openai: saveOpenai });
check("both endpoints saved", saveAnthropic.status === 200 && saveOpenai.status === 200, report.saved);
const listed = await api("GET", "endpoints");
report.listed = clean(listed.json);
check("the list shows both keys as set", listed.json?.credentialsKey === true && listed.json?.endpoints?.every((endpoint: any) => endpoint.key?.set === true), listed.json);

// 3. The picker: every endpoint's models by slug, grouped by endpoint.
const piDurable = async () => {
  const reply = (await wsCall(cookie, "server.refreshProviders", { instanceId: "piDurable" }).catch(() => undefined)) as any;
  const config = (reply?.providers === undefined ? await wsCall(cookie, "server.getConfig", {}) : reply) as any;
  return (config.providers as Array<any>).find((provider) => provider.driver === "piDurable");
};
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
const picker = (await piDurable())?.models ?? [];
const endpointRows = picker.filter((model: any) => !String(model.slug).startsWith("anthropic/")).map((model: any) => ({ slug: model.slug, group: model.subProvider, thinking: (model.capabilities?.optionDescriptors ?? []).some((option: any) => option.id === "thinking") }));
report.picker = { endpointModels: endpointRows, proxyModels: picker.length - endpointRows.length };
check("the picker shows both endpoints' models, grouped", endpointRows.some((row: any) => row.slug === `commissary/${claude}` && row.group === "Commissary") && endpointRows.some((row: any) => row.slug === `openai/${gpt}` && row.group === OPENAI.label), report.picker);

// 4. A Durable turn with tools on each (edit a file, run `bash test.sh`, approvals accepted).
const anthropicTurn = await realTurn(cookie, { push: false, model: `commissary/${claude}` });
report.anthropicTurn = clean(anthropicTurn);
check("the Anthropic Messages endpoint ran a turn with tools", anthropicTurn.ok, anthropicTurn.failures);
const openaiTurn = await realTurn(cookie, { push: false, model: `openai/${gpt}` });
report.openaiTurn = clean(openaiTurn);
check("the OpenAI Responses endpoint ran a turn with tools", openaiTurn.ok, openaiTurn.failures);

// 5. A changed model list reaches the picker and a running thread at its next turn (a thread of its own, in a fresh
// folder: realTurn's Workspace is left as it was).
const second = openaiKey === undefined ? "claude-haiku-5-5" : "gpt-5-nano";
const awaitRuns = async (threadId: string, count: number) => {
  const started = Date.now();
  let projection: any;
  while (Date.now() - started < 5 * 60_000) {
    projection = projectionOf(await threadWindow(cookie, threadId));
    const runs = runsOf(projection);
    if (runs.length >= count && runs.every((run) => SETTLED.has(run.status))) return projection;
    await sleep(1500);
  }
  return projection;
};
const failureText = (projection: any) => [...JSON.stringify(projection).matchAll(/"(?:message|detail|summary)":"([^"]{0,300})"/g)].map((match) => match[1]).filter((text) => /not available|endpoint|HTTP/.test(text ?? ""));
const { threadId } = await createProjectAndThread(cookie, { title: `p1162-${Date.now().toString(36)}`, workspaceRoot: `/w/p1162-${Date.now().toString(36)}` });
const on = (slug: string) => ({ instanceId: "piDurable", model: slug, options: [] });
await sendMessage(cookie, threadId, "Reply with the single word: ready.", on(`openai/${gpt}`));
const first = runsOf(await awaitRuns(threadId, 1)).map((run) => run.status);
const edited = await api("POST", "endpoints", { op: "save", endpoint: { ...OPENAI, models: [gpt, second] } });
await sleep(1500);
const after = ((await piDurable())?.models ?? []).map((model: any) => model.slug);
await sendMessage(cookie, threadId, "Reply with the single word: ready.", on(`openai/${second}`));
const nextProjection = await awaitRuns(threadId, 2);
const next = runsOf(nextProjection).map((run) => run.status);
report.changedList = { threadId, firstTurn: first, saved: clean(edited.status), added: `openai/${second}`, inPicker: after.includes(`openai/${second}`), nextTurn: next, errors: failureText(nextProjection) };
check("an added model reaches the picker at once", edited.status === 200 && after.includes(`openai/${second}`), report.changedList);
check("the running thread's next turn uses the added model", first[0] === "completed" && next[1] === "completed", report.changedList);

// 6. A removed endpoint's model fails the thread's next turn with a clear message, and leaves the picker.
const removed = await api("POST", "endpoints", { op: "remove", id: "openai" });
await sleep(1500);
const pickerAfter = ((await piDurable())?.models ?? []).filter((model: any) => String(model.slug).startsWith("openai/")).map((model: any) => model.slug);
await sendMessage(cookie, threadId, "Reply with the single word: ready.", on(`openai/${second}`));
const removedProjection = await awaitRuns(threadId, 3);
const lastRun = runsOf(removedProjection).at(-1);
report.removed = clean({ status: removed.status, run: lastRun?.status ?? null, errors: failureText(removedProjection), pickerAfter });
check("the removed endpoint's models leave the picker", pickerAfter.length === 0, pickerAfter);
check("the removed endpoint's model failed the turn, saying why", lastRun?.status === "failed" && /is not available: its Model endpoint was removed/.test(JSON.stringify(removedProjection)), report.removed);

// 7. The audit log: every change, never a key.
const audit = (await api("GET", "audit")).json?.entries?.filter((entry: any) => entry.entity === "endpoints") ?? [];
report.audit = clean(audit);
check("each change is audited under the entity endpoints", audit.length >= 3, audit.length);
finish();
