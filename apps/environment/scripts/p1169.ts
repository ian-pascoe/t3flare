// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1169's evidence on its stage: OpenCode through the model relay.
//
//   node scripts/stage.ts deploy p1169
//   node scripts/stage.ts run p1169 p1169 [--out ../../docs/steps/spi-1169/p1169.json]
//
// 1. Three Model endpoints saved through the Harness panel's API, all Commissary's with the proxy key (SPI-1162's
//    approach), one per API OpenCode speaks: `comm` (Anthropic Messages at <MODEL_PROXY_URL>), `oai` (OpenAI-compatible
//    Chat Completions at <MODEL_PROXY_URL>/v1) and `resp` (OpenAI Responses at <MODEL_PROXY_URL>/v1).
// 2. OpenCode lists the endpoints' models by slug, first; its system configuration has one provider per endpoint at the
//    relay's per-endpoint URL, and no key.
// 3. An OpenCode turn with tools on `comm/<model>` (approval-required, every request accepted): an edit and a test run.
// 4. In the same thread, a turn with tools on `oai/<model>` (an OpenAI endpoint), then one on `resp/<model>`: each
//    completes in the same native OpenCode session, the last knows the code word, and the relay's log names each
//    turn's endpoint.
// 5. Where the handle is: only in OpenCode's start environments (setsid, `opencode acp` and the server it starts; not
//    the launcher's loops, not a shell's, not in any file); a full-access turn's `env` holds no handle. The handle
//    reaches the relay for each endpoint in its API's key header (200); a forged handle and none get 401; an endpoint
//    saved after the process started gets 403. The key helper was never asked (SPI-1045).
// 6. The leak scan finds no endpoint key and names none it could not scan; a planted canary key is found.
// 7. The agents Worker's log (wrangler tail): OpenCode's relayed requests with their endpoints, and the names of the
//    headers OpenCode sends that the allowlist drops; no handle or key.
//
// No key or handle is printed or kept: every answer kept is scanned for them first.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { admin, pair, sleep, updateSettings, wsCall } from "./lib/client.ts";
import { cliTurn, EDIT_AND_TEST, enable } from "./lib/acpTurn.ts";

const here = path.resolve(import.meta.dirname, "..");
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = option("out");
const stage = new URL(process.env.T3_URL ?? "http://localhost").hostname.split(".")[0]!.replace(/^t3flare-environment-/, "");
const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";

/** The positive control's key: a test endpoint's, planted in the Container for the leak scan to find. */
const canaryKey = `sk-canary-${randomBytes(24).toString("hex")}`;
const secrets = [proxyKey, canaryKey].filter((value) => value.length >= 8);
const handles: Array<string> = [];
const failures: Array<string> = [];
// The code the evidence covers: the commit deployed (the working tree must be clean for it to be that commit).
const git = (...args: Array<string>) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const report: Record<string, unknown> = { at: new Date().toISOString(), stage, head: git("rev-parse", "HEAD"), clean: git("status", "--porcelain") === "" };
/** Throws if a key or a handle is in `value`; a value kept as evidence goes through here. */
function clean<T>(value: T): T {
  const text = JSON.stringify(value) ?? "";
  for (const secret of [...secrets, ...handles]) if (text.includes(secret)) throw new Error("a key or a handle reached an answer kept as evidence");
  return value;
}
const check = (name: string, ok: boolean, detail?: unknown) => {
  report.checks = [...((report.checks as Array<unknown>) ?? []), { name, ok }];
  if (!ok) failures.push(`${name}: ${JSON.stringify(clean(detail ?? null)).slice(0, 600)}`);
  return ok;
};

// The agents Worker's log, for the whole run (wrangler with the alchemy profile's token, never printed).
const profile = process.env.ALCHEMY_PROFILE ?? "default";
const cf = (() => {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values;
  return { token: stored.access as string, accountId: stored.accountId as string };
})();
const logFile = path.join(os.tmpdir(), `t3flare-p1169-tail-${Date.now()}.ndjson`);
const logFd = fs.openSync(logFile, "w", 0o600);
const tail = spawn(path.join(here, "node_modules/.bin/wrangler"), ["tail", `t3flare-agents-${stage}`, "--format", "json"], {
  cwd: here,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: cf.token, CLOUDFLARE_ACCOUNT_ID: cf.accountId ?? "" },
  stdio: ["ignore", logFd, "ignore"],
});
await sleep(8000);

const finish = (): never => {
  tail.kill("SIGINT");
  report.failures = failures;
  report.ok = failures.length === 0;
  const text = JSON.stringify(clean(report), null, 2);
  console.log(text.slice(0, 20_000));
  if (out !== undefined) fs.writeFileSync(out, `${text}\n`);
  fs.rmSync(logFile, { force: true });
  process.exit(report.ok ? 0 : 1);
};

const api = (method: string, pathname: string, body?: unknown) => admin(method, `/_t3flare/harness/api/${pathname}`, body);
const exec = async (workspace: string, script: string, timeoutMs = 60_000) =>
  ((await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script, timeoutMs } })).json as any)?.result ?? {};
const leak = async (workspace: string) => (await admin("POST", `/_t3flare/check/leak?id=${encodeURIComponent(workspace)}`)).json;
const linesOf = (stdout: string | undefined) => Object.fromEntries((stdout ?? "").trim().split("\n").map((line: string) => line.split("=", 2) as [string, string]));

if (proxyUrl === "" || proxyKey === "") {
  failures.push("the stage needs MODEL_PROXY_URL and MODEL_PROXY_API_KEY (dev.env)");
  finish();
}

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");

// 1. The endpoints: Commissary's three APIs OpenCode speaks, each with the same model (the list read with the key).
const ANTHROPIC = { api: "anthropic-messages", baseUrl: proxyUrl, auth: "api-key", headers: {} };
const COMPLETIONS = { api: "openai-completions", baseUrl: `${proxyUrl}/v1`, auth: "api-key", headers: {} };
const RESPONSES = { api: "openai-responses", baseUrl: `${proxyUrl}/v1`, auth: "api-key", headers: {} };
const MODEL = "claude-haiku-5-5";
const discover = async (id: string, spec: Record<string, unknown>) =>
  new Set((((await api("POST", "endpoints/discover", { endpoint: { id, label: id, ...spec }, apiKey: proxyKey })).json ?? {}) as { models?: Array<{ id: string }> }).models?.map((model) => model.id) ?? []);
const offered = { comm: await discover("comm", ANTHROPIC), oai: await discover("oai", COMPLETIONS) };
report.models = { model: MODEL, anthropicLists: offered.comm.has(MODEL), openaiLists: offered.oai.has(MODEL) };
check("Commissary's Anthropic API lists the model", offered.comm.has(MODEL), [...offered.comm].slice(0, 30));
const saved = {
  comm: (await api("POST", "endpoints", { op: "save", endpoint: { id: "comm", label: "Commissary (Anthropic)", ...ANTHROPIC, models: [MODEL] }, apiKey: proxyKey })).status,
  oai: (await api("POST", "endpoints", { op: "save", endpoint: { id: "oai", label: "Commissary (Chat Completions)", ...COMPLETIONS, models: [MODEL] }, apiKey: proxyKey })).status,
  resp: (await api("POST", "endpoints", { op: "save", endpoint: { id: "resp", label: "Commissary (Responses)", ...RESPONSES, models: [MODEL] }, apiKey: proxyKey })).status,
};
report.endpoints = { saved, baseUrls: { comm: "<MODEL_PROXY_URL>", oai: "<MODEL_PROXY_URL>/v1", resp: "<MODEL_PROXY_URL>/v1" } };
check("the three endpoints saved", saved.comm === 200 && saved.oai === 200 && saved.resp === 200, saved);
const SLUGS = { comm: `comm/${MODEL}`, oai: `oai/${MODEL}`, resp: `resp/${MODEL}` };

// 2. OpenCode's model list.
await enable(cookie, "opencode");
await sleep(2000);
const config = (await wsCall(cookie, "server.getConfig", {})) as any;
const opencodeModels = (((config?.providers ?? []) as Array<any>).find((provider) => provider.driver === "opencode")?.models ?? []).map((model: any) => ({ slug: model.slug, group: model.subProvider, isDefault: model.isDefault === true }));
report.opencodeModels = { first: opencodeModels.slice(0, 4), total: opencodeModels.length, proxyRetained: opencodeModels.filter((row: any) => String(row.slug).startsWith("anthropic/")).length };
check(
  "OpenCode lists the endpoints' models by slug, first, the first the default (t3's registry keeps the proxy's it listed before, after them)",
  JSON.stringify(opencodeModels.slice(0, 3).map((row: any) => row.slug)) === JSON.stringify([SLUGS.comm, SLUGS.oai, SLUGS.resp]) && opencodeModels[0]?.isDefault === true,
  opencodeModels.slice(0, 5),
);
// The owner's text-generation model: the Responses endpoint's, so OpenCode's small model is seen to follow it.
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
await updateSettings(cookie, { textGenerationModelSelection: { instanceId: "piDurable", model: SLUGS.resp } });
let textModel = null as { instanceId: string; model: string } | null;
for (let i = 0; i < 15 && textModel?.model !== SLUGS.resp; i++) {
  await sleep(1000);
  textModel = (((await wsCall(cookie, "server.getConfig", {})) as any)?.settings?.textGenerationModelSelection ?? null) as typeof textModel;
}
report.textGenerationModel = textModel;

// 3. A turn with tools on comm's model (Anthropic Messages).
const run = Date.now().toString(36);
const A = `relay-opencode-${run}`;
const first = await cliTurn(cookie, { cli: "opencode", workspace: A, model: SLUGS.comm, mode: "approval-required", plan: false, prompt: `Remember the code word HERON-58 for later. ${EDIT_AND_TEST}` });
report.turn = clean(first);
const toolTurn = (turn: typeof first) => turn.runs.at(-1)?.status === "completed" && turn.items.some((item: any) => item.type === "file_change") && turn.items.some((item: any) => item.type === "command_execution");
check("an OpenCode turn with tools ran on the Anthropic Messages endpoint's model through the relay", toolTurn(first), first.items);
check("its tool requests were asked and accepted", first.requests.length > 0 && first.requests.every((request: any) => request.decision === "accept"), first.requests);

// OpenCode's system configuration in the Container: one provider per endpoint at the relay, no key.
const installed = await exec(A, "cat /etc/opencode/opencode.json");
const system = JSON.parse(String(installed.stdout ?? "{}")) as any;
const providers = Object.fromEntries(Object.entries(system.providers ?? {}).map(([id, provider]: [string, any]) => [id, { package: provider.package, baseURL: provider.settings?.baseURL, models: Object.keys(provider.models ?? {}) }]));
report.systemConfiguration = clean({ providers, model: system.model, small_model: system.small_model, plugins: system.plugins, providerPolicies: (system.policies ?? []).filter((entry: any) => entry.action === "provider.use") });
check(
  "OpenCode's providers: one per endpoint at the relay's per-endpoint URL, its package by API",
  JSON.stringify(providers) ===
    JSON.stringify({
      "t3flare-endpoint-comm": { package: "@opencode/ai/providers/anthropic-compatible", baseURL: "http://computer.internal/t3flare/model/comm/v1", models: [MODEL] },
      "t3flare-endpoint-oai": { package: "@opencode/ai/providers/openai-compatible", baseURL: "http://computer.internal/t3flare/model/oai", models: [MODEL] },
      "t3flare-endpoint-resp": { package: "@opencode/ai/providers/openai-compatible-responses", baseURL: "http://computer.internal/t3flare/model/resp", models: [MODEL] },
    }),
  report.systemConfiguration,
);
check("no key in OpenCode's system configuration", !/apiKey|x-api-key|authorization/i.test(String(installed.stdout ?? "")), report.systemConfiguration);
check("OpenCode's small model is the text-generation model", textModel?.model === SLUGS.resp && system.small_model === `t3flare-endpoint-resp/${MODEL}`, { textModel, small: system.small_model });

// 4. The same thread on the OpenAI endpoints: a tool turn on Chat Completions, then Responses.
const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
const openai = await cliTurn(cookie, { cli: "opencode", workspace: A, model: SLUGS.oai, mode: "approval-required", plan: false, prompt: "In src/greeting.txt add another last line `Hello again.` with your file edit tool (not the shell), then run `bash test.sh` and tell me in one sentence whether it passed.", threadId: first.threadId });
report.openaiTurn = clean(openai);
check("an OpenCode turn with tools ran on the OpenAI (Chat Completions) endpoint's model, in the same thread", toolTurn(openai), openai.items);
const responses = await cliTurn(cookie, { cli: "opencode", workspace: A, model: SLUGS.resp, mode: "approval-required", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
report.switch = clean({ toResponses: { runs: responses.runs.slice(-1), text: responses.text, native: native(responses) }, openai: native(openai), first: native(first) });
check("a model switch to the Responses endpoint's model: the turn completes and knows the code word", responses.runs.at(-1)?.status === "completed" && responses.text.includes("HERON-58"), report.switch);
check("the same native OpenCode session throughout (no handoff)", native(first).length === 1 && JSON.stringify(native(first)) === JSON.stringify(native(openai)) && JSON.stringify(native(first)) === JSON.stringify(native(responses)), report.switch);

// 5. Where the handle is, with the thread's process alive. Only counts and names leave the Container.
const CANARY = { id: "canary", label: "Canary", ...ANTHROPIC, models: [MODEL] };
check("the canary endpoint saved (after the process started)", (await api("POST", "endpoints", { op: "save", endpoint: CANARY, apiKey: canaryKey })).status === 200);
const RELAY = "http://computer.internal/t3flare/model";
const body = `{"model":"${MODEL}","max_tokens":5,"messages":[{"role":"user","content":"Reply with ok."}]}`;
const anthropicPost = (endpoint: string, handleExpr: string) =>
  `curl -s -o /dev/null -w '%{http_code}' -X POST ${handleExpr === "" ? "" : `-H "x-api-key: ${handleExpr}" `}-H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' --data '${body}' ${RELAY}/${endpoint}/v1/messages`;
const openaiPost = (endpoint: string, handleExpr: string) =>
  `curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer ${handleExpr}" -H 'content-type: application/json' --data '${body}' ${RELAY}/${endpoint}/chat/completions`;
const where = await exec(
  A,
  [
    // Every process whose environment holds a handle, by its command.
    `holders=""; for f in /proc/[0-9]*/environ; do if tr '\\0' '\\n' < "$f" 2>/dev/null | grep -q '^T3FLARE_MODEL_HANDLE='; then p=\${f#/proc/}; p=\${p%/environ}; holders="$holders $(tr '\\0' ' ' < /proc/$p/cmdline | head -c 240 | sed 's/[^A-Za-z0-9 ./_@-]//g')|"; fi; done`,
    `H=$(grep -ahz '^T3FLARE_MODEL_HANDLE=' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | head -1 | cut -d= -f2)`,
    `echo "handle=$H"`,
    `echo "holders=$holders"`,
    // The launcher's loops run without it.
    `loops=0; for p in $(pgrep -f 'bin/opencode --t3flare-'); do tr '\\0' '\\n' < /proc/$p/environ | grep -q '^T3FLARE_MODEL_HANDLE=' && loops=$((loops+1)); done; echo "loopProcesses=$(pgrep -fc 'bin/opencode --t3flare-')"; echo "loopsWithHandle=$loops"`,
    `echo "files=$( [ -n "$H" ] && grep -rlsF "$H" /var/lib/t3flare /etc/opencode /root /tmp /workspace 2>/dev/null | wc -l)"`,
    `F=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')`,
    `echo "anthropic=$(${anthropicPost("comm", "$H")})"`,
    `echo "openai=$(${openaiPost("oai", "$H")})"`,
    `echo "forged=$(${anthropicPost("comm", "$F")})"`,
    `echo "none=$(${anthropicPost("comm", "")})"`,
    `echo "unconfigured=$(${anthropicPost("canary", "$H")})"`,
  ].join("\n"),
  120_000,
);
const lines = linesOf(where.stdout);
const handle = /^[0-9a-f]{64}$/.test(lines.handle ?? "") ? lines.handle! : undefined;
if (handle !== undefined) handles.push(handle);
delete lines.handle;
report.handle = clean({ found: handle !== undefined, ...lines, stderr: String(where.stderr ?? "").slice(0, 300) });
const holders = String(lines.holders ?? "").split("|").map((entry) => entry.trim()).filter((entry) => entry !== "");
const CHAIN = new Set(["setsid --wait /opt/t3flare/bin/opencode acp", "/opt/t3flare/opencode/opencode acp", "/opt/t3flare/opencode/opencode serve --stdio --port 0"]);
check(
  "only OpenCode's start environments hold the handle (setsid, `opencode acp` and its server; not the launcher's loops, not a shell's)",
  handle !== undefined && holders.length >= 2 && holders.every((entry) => CHAIN.has(entry)) && lines.loopsWithHandle === "0" && Number(lines.loopProcesses) >= 2,
  report.handle,
);
check("no file holds the handle", lines.files === "0", report.handle);
check("the handle reaches the Anthropic endpoint in x-api-key and the OpenAI endpoint as a Bearer (200)", lines.anthropic === "200" && lines.openai === "200", report.handle);
check("a forged handle and no handle are refused (401)", lines.forged === "401" && lines.none === "401", report.handle);
check("an endpoint saved after the process started is refused (403)", lines.unconfigured === "403", report.handle);

// An OpenCode shell has no handle.
const shell = await cliTurn(cookie, { cli: "opencode", workspace: A, model: SLUGS.comm, mode: "full-access", plan: false, prompt: "Run exactly this shell command: `env > /tmp/p1169-shell-env.txt` and then reply with the single word done.", threadId: first.threadId });
const shellEnv = await exec(A, "echo handle=$(grep -c '^T3FLARE_MODEL_HANDLE=' /tmp/p1169-shell-env.txt); echo nonce=$(grep -c '^T3FLARE_MODEL_KEY_NONCE=' /tmp/p1169-shell-env.txt); echo exec=$(grep -c '^T3FLARE_EXEC=' /tmp/p1169-shell-env.txt); rm -f /tmp/p1169-shell-env.txt");
report.shellEnv = { runs: shell.runs.slice(-1), counts: String(shellEnv.stdout ?? "").trim() };
check("an OpenCode shell's environment has no model handle and no nonce (its marker shows it was the process's)", String(shellEnv.stdout ?? "").includes("handle=0") && String(shellEnv.stdout ?? "").includes("nonce=0") && String(shellEnv.stdout ?? "").includes("exec=1"), report.shellEnv);

// 6. The leak scan, with the thread's process alive; then the positive control.
const scan = await leak(A);
report.leak = clean(scan);
check("the leak scan finds no endpoint key and scanned every key (DO files, Container files, process environments and command lines)", (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0 && (scan?.container?.files ?? 0) > 0 && Array.isArray(scan?.notScanned) && scan.notScanned.length === 0, scan);
await exec(A, `printf %s '${canaryKey}' > /tmp/p1169-canary.txt`);
const planted = await leak(A);
await exec(A, "rm -f /tmp/p1169-canary.txt");
const plantedHits = (planted?.container?.hits ?? []) as Array<{ name: string; path: string }>;
report.leakControl = clean({ hits: plantedHits });
check("the leak scan finds an endpoint key planted in the Container", plantedHits.some((hit) => hit.name === "endpoint:canary" && hit.path === "/tmp/p1169-canary.txt"), report.leakControl);
check("the canary endpoint removed", (await api("POST", "endpoints", { op: "remove", id: "canary" })).status === 200);

// 7. The agents Worker's log.
await sleep(10_000);
tail.kill("SIGINT");
await sleep(1500);
fs.closeSync(logFd);
const raw = fs.readFileSync(logFile, "utf8");
const relayLogs: Array<any> = [];
const keyLogs: Array<any> = [];
for (const chunk of raw.split(/\n(?=\{\n)/).filter((part) => part.trim().startsWith("{"))) {
  try {
    const event = JSON.parse(chunk) as { logs?: Array<{ message: Array<unknown> }> };
    for (const log of event.logs ?? []) {
      for (const message of log.message) {
        if (typeof message !== "string") continue;
        if (message.startsWith('{"t3flare":"model-relay"')) relayLogs.push(JSON.parse(message));
        else if (message.startsWith('{"t3flare":"model-key')) keyLogs.push(JSON.parse(message));
      }
    }
  } catch {
    // An event cut off when the tail stopped.
  }
}
const opencodeLogs = relayLogs.filter((entry) => entry.cli === "opencode");
const byStatus: Record<string, number> = {};
for (const entry of relayLogs) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
const byEndpoint: Record<string, number> = {};
for (const entry of opencodeLogs) byEndpoint[entry.endpoint] = (byEndpoint[entry.endpoint] ?? 0) + 1;
report.relayLog = {
  entries: relayLogs.length,
  byStatus,
  opencode: { entries: opencodeLogs.length, byEndpoint, routed: opencodeLogs.some((entry) => entry.routed === true), statuses: [...new Set(opencodeLogs.map((entry) => entry.status))] },
  // What OpenCode sends that the allowlist keeps back (names only).
  opencodeDropped: [...new Set(opencodeLogs.flatMap((entry) => entry.dropped ?? []))].sort((a, b) => String(a).localeCompare(String(b))),
  sample: opencodeLogs.slice(0, 3),
};
// SPI-1045: the key helper's route is the Model proxy's; an OpenCode process on the relay never asks it.
report.keyHelper = { entries: keyLogs.length, opencode: keyLogs.filter((entry) => JSON.stringify(entry).includes("opencode")).length };
check("OpenCode's requests went to each endpoint's own path (comm, oai, resp), none model-routed, every one 200", ["comm", "oai", "resp"].every((id) => (byEndpoint[id] ?? 0) > 0) && opencodeLogs.every((entry) => entry.status === 200 && entry.routed !== true), report.relayLog);
check("OpenCode on the relay never asked the key helper", (report.keyHelper as any).opencode === 0, report.keyHelper);
check("no handle or key in the agents Worker's log", [...secrets, ...handles].every((value) => !raw.includes(value)));
finish();
