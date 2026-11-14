// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-1163's evidence on its stage: thread titles and commit messages generated on a Model endpoint's model, on an
// Anthropic Messages endpoint and on an OpenAI Responses endpoint (one pi-ai request on the agents Worker); the
// text-generation setting naming its default model; and a failure naming the endpoint without the vendor's body or a key.
//
//   node scripts/stage.ts run p1163 p1163 [--out ../../docs/steps/spi-1163/p1163.json]
//
// As SPI-1162's evidence: the Anthropic Messages endpoint is the stage's Model proxy (Commissary) at MODEL_PROXY_URL with
// its key; the OpenAI Responses one is Commissary's `<MODEL_PROXY_URL>/v1` with the same key (gemini-3-flash, which
// Commissary translates), unless OPENAI_API_KEY is set (then OpenAI's own API with gpt-5-mini). No key is printed: every
// answer kept is scanned for them first.
import * as fs from "node:fs";

import { admin, createProjectAndThread, dispatch, pair, projectionOf, sendMessage, sleep, threadWindow, updateSettings, uuid, wsCall } from "./lib/client.ts";
import { ensureProject } from "./lib/cliTurn.ts";
import { t3Commit } from "./lib/t3Commit.ts";

const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = option("out");
const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";
const openaiKey = process.env.OPENAI_API_KEY;
const WRONG_KEY = `sk-p1163-wrong-${Date.now().toString(36)}`;
const secrets = [proxyKey, openaiKey, WRONG_KEY].filter((value): value is string => value !== undefined && value.length >= 8);
const failures: Array<string> = [];
const report: Record<string, unknown> = { at: new Date().toISOString(), openai: openaiKey === undefined ? "Commissary's OpenAI Responses API" : "OpenAI's API" };
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 600)}`);
  return ok;
};
const clean = <T>(value: T): T => {
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

const api = (method: string, path: string, body?: unknown) => admin(method, `/_t3flare/harness/api/${path}`, body);

const claude = "claude-haiku-5-5";
const gpt = openaiKey === undefined ? "gemini-3-flash" : "gpt-5-mini";
const ANTHROPIC = { id: "commissary", label: "Commissary", api: "anthropic-messages", baseUrl: proxyUrl, auth: "api-key", headers: {}, models: [claude] };
const OPENAI =
  openaiKey === undefined
    ? { id: "openai", label: "OpenAI (Responses)", api: "openai-responses", baseUrl: `${proxyUrl}/v1`, auth: "api-key", headers: {}, models: [gpt] }
    : { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: [gpt] };
// The same host as Commissary, with a key it refuses: the failure's text must name the endpoint and hold neither.
const WRONG = { ...ANTHROPIC, id: "wrong-key", label: "Wrong key" };

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });

const textSetting = async () => {
  const config = (await wsCall(cookie, "server.getConfig", {})) as any;
  const selection = config?.settings?.textGenerationModelSelection ?? null;
  return selection === null ? null : { instanceId: selection.instanceId, model: selection.model };
};
const waitForSetting = async (model: string) => {
  const started = Date.now();
  let seen = await textSetting();
  while (seen?.model !== model && Date.now() - started < 20_000) {
    await sleep(1000);
    seen = await textSetting();
  }
  return seen;
};

// 1. The setting before any endpoint: the Model proxy's small model (until the hard cut).
report.settingBefore = await textSetting();
check("with no endpoints the setting names the proxy's small model", (report.settingBefore as any)?.model === `anthropic/${claude}`, report.settingBefore);

// 2. Both endpoints saved; the unset setting now names the first endpoint's small model, and says so.
const saved = [await api("POST", "endpoints", { op: "save", endpoint: ANTHROPIC, apiKey: proxyKey }), await api("POST", "endpoints", { op: "save", endpoint: OPENAI, apiKey: openaiKey ?? proxyKey })];
report.saved = clean(saved.map((answer) => answer.status));
check("both endpoints saved", saved.every((answer) => answer.status === 200), report.saved);
report.settingDefault = await waitForSetting(`commissary/${claude}`);
check("the unset setting names the first endpoint's small model", (report.settingDefault as any)?.model === `commissary/${claude}`, report.settingDefault);

// A thread with a first message, whose title is generated again on each model.
const { threadId } = await createProjectAndThread(cookie, { title: "New thread", workspaceRoot: `/w/p1163-${Date.now().toString(36)}` });
await sendMessage(cookie, threadId, "Please fix the failing date parser test in src/dates.ts: it treats 2024-02-29 as invalid.");
const findKey = (value: any, key: string): any => {
  if (value === null || typeof value !== "object") return undefined;
  if (key in value) return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
};
const regenerateTitle = async () => {
  // The title is put back first, so a renamed title is this model's (a model naming it as before would read "unchanged").
  await dispatch(cookie, { type: "thread.metadata.update", commandId: uuid(), threadId, title: "New thread" });
  const commandId = uuid();
  await dispatch(cookie, { type: "thread.metadata.update", commandId, threadId, regenerateTitle: true });
  const started = Date.now();
  while (Date.now() - started < 3 * 60_000) {
    const projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    const last = findKey(projection, "lastTitleRegeneration");
    if (last?.requestId === commandId) return { outcome: last.status as string, message: (last.message ?? null) as string | null, title: findKey(projection, "title") as string };
    await sleep(1500);
  }
  return { outcome: "timeout", message: null, title: null };
};

// 3. Titles and commit text on each endpoint's model, the setting pointing at it.
const { root } = await ensureProject(cookie, "p1163-commit");
const runOn = async (slug: string, file: string) => {
  await updateSettings(cookie, { textGenerationModelSelection: { instanceId: "piDurable", model: slug } });
  const title = await regenerateTitle();
  await wsCall(cookie, "projects.writeFile", { cwd: root, relativePath: file, contents: `export const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;\n// ${slug}\n` });
  const commit = await t3Commit(cookie, { id: "p1163-commit", cwd: root, filePaths: [file] });
  return clean({ slug, title, commit: { failure: commit.failure, status: commit.result.status, subject: commit.result.subject, head: commit.head?.subject ?? null } });
};
const anthropicRun = await runOn(`commissary/${claude}`, "src/leap-anthropic.ts");
const openaiRun = await runOn(`openai/${gpt}`, "src/leap-openai.ts");
report.anthropic = anthropicRun;
report.openaiResponses = openaiRun;
for (const run of [anthropicRun, openaiRun]) {
  check(`${run.slug} generated the thread's title`, run.title.outcome === "renamed" && typeof run.title.title === "string" && run.title.title !== "New thread", run.title);
  check(`${run.slug} generated the commit message`, run.commit.failure === null && run.commit.status === "created" && typeof run.commit.subject === "string" && run.commit.subject.length > 0 && run.commit.head === run.commit.subject, run.commit);
}

// 4. A failure names the endpoint, never the vendor's body or the key.
const wrongSaved = await api("POST", "endpoints", { op: "save", endpoint: WRONG, apiKey: WRONG_KEY });
await updateSettings(cookie, { textGenerationModelSelection: { instanceId: "piDurable", model: `wrong-key/${claude}` } });
const wrongTitle = await regenerateTitle();
report.wrongKey = clean({ saved: wrongSaved.status, title: wrongTitle });
check("a refused key's failure names the endpoint and says what to do", wrongTitle.outcome === "failed" && /Model endpoint "wrong-key" refused its API key \(HTTP 40[13]\)/.test(wrongTitle.message ?? ""), report.wrongKey);
check("the failure holds no vendor body", !/\{|"error"|invalid|unauthori[sz]ed/i.test(wrongTitle.message ?? ""), wrongTitle.message);

// 5. A removed endpoint's model says so.
await api("POST", "endpoints", { op: "remove", id: "wrong-key" });
const goneTitle = await regenerateTitle();
report.removedEndpoint = clean(goneTitle);
check("a removed endpoint's model says it was removed", goneTitle.outcome === "failed" && /Model endpoint "wrong-key" was removed/.test(goneTitle.message ?? ""), goneTitle);

finish();
