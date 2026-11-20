// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1168's evidence on its stage: Claude Code through the model relay.
//
//   node scripts/stage.ts deploy p1168
//   node scripts/stage.ts run p1168 p1168 [--out ../../docs/steps/spi-1168/p1168.json]
//
// 1. Two Anthropic Messages Model endpoints saved through the Settings page's API, both Commissary's Anthropic API with
//    the proxy key (SPI-1162's approach): `comm` and `comm2`, each with its own model.
// 2. Claude Code lists the endpoints' models by slug (and none of the proxy's); its managed settings point at the
//    relay's model-routed URL with the handle helper, and its background model is the text-generation model.
// 3. A Claude Code turn with tools on `comm/<model>` (approval-required, every request accepted): an edit and a test run.
// 4. A model switch in the same thread to `comm2/<model>`, and back: each turn completes in the same native Claude
//    session (one process, one base URL), knows the code word, and the relay's log names each turn's endpoint.
// 5. Where the handle is: only in the claude-agent-acp process's start environment (not claude's, not a shell's, not in
//    any file); a full-access turn's `env` holds no handle. The handle reaches the relay (200); a forged handle and none
//    get 401; an endpoint saved after the process started, named in the body, gets 403.
// 6. The leak scan finds no endpoint key and names none it could not scan; a planted canary key is found.
// 7. The agents Worker's log (wrangler tail): Claude's relayed requests, routed, with their endpoints, and the names of
//    the headers Claude sends that the allowlist drops; no handle or key.
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
const logFile = path.join(os.tmpdir(), `t3flare-p1168-tail-${Date.now()}.ndjson`);
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

const api = (method: string, pathname: string, body?: unknown) => admin(method, `/_t3flare/settings/api/${pathname}`, body);
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

// 1. The endpoints: Commissary's Anthropic API twice, each with a model of its own (the list read with the key).
const ANTHROPIC = { api: "anthropic-messages", baseUrl: proxyUrl, auth: "api-key", headers: {} };
const discovered = ((await api("POST", "endpoints/discover", { endpoint: { id: "comm", label: "Commissary", ...ANTHROPIC }, apiKey: proxyKey })).json ?? {}) as { ok?: boolean; models?: Array<{ id: string }> };
const offered = new Set((discovered.models ?? []).map((model) => model.id));
const FIRST = "claude-haiku-5-5";
const SECOND = ["claude-sonnet-5-5", "claude-sonnet-4-6", "claude-sonnet-4-5"].find((id) => offered.has(id)) ?? FIRST;
report.models = { discovered: discovered.ok === true, first: `comm/${FIRST}`, second: `comm2/${SECOND}` };
check("Commissary's Anthropic API lists the first model", offered.has(FIRST), [...offered].slice(0, 30));
const saved = {
  comm: (await api("POST", "endpoints", { op: "save", endpoint: { id: "comm", label: "Commissary", ...ANTHROPIC, models: [FIRST] }, apiKey: proxyKey })).status,
  comm2: (await api("POST", "endpoints", { op: "save", endpoint: { id: "comm2", label: "Commissary (second)", ...ANTHROPIC, models: [SECOND] }, apiKey: proxyKey })).status,
};
report.endpoints = { saved, baseUrl: "<MODEL_PROXY_URL>" };
check("both endpoints saved", saved.comm === 200 && saved.comm2 === 200, saved);

// 2. Claude Code's model list.
await enable(cookie, "claude");
await sleep(2000);
const config = (await wsCall(cookie, "server.getConfig", {})) as any;
const claudeModels = (((config?.providers ?? []) as Array<any>).find((provider) => provider.driver === "claudeAgent")?.models ?? []).map((model: any) => ({ slug: model.slug, group: model.subProvider }));
report.claudeModels = { first: claudeModels.slice(0, 3), total: claudeModels.length, proxyRetained: claudeModels.filter((row: any) => String(row.slug).startsWith("anthropic/")).length };
check(
  "Claude Code lists the Anthropic Messages endpoints' models by slug, first (t3's registry keeps the proxy's it listed before, after them)",
  claudeModels[0]?.slug === `comm/${FIRST}` && claudeModels[1]?.slug === `comm2/${SECOND}`,
  claudeModels.slice(0, 4),
);
// The owner's text-generation model: the second endpoint's, so Claude Code's background model is seen to follow it.
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
await updateSettings(cookie, { textGenerationModelSelection: { instanceId: "piDurable", model: `comm2/${SECOND}` } });
let textModel = null as { instanceId: string; model: string } | null;
for (let i = 0; i < 15 && textModel?.model !== `comm2/${SECOND}`; i++) {
  await sleep(1000);
  textModel = (((await wsCall(cookie, "server.getConfig", {})) as any)?.settings?.textGenerationModelSelection ?? null) as typeof textModel;
}
report.textGenerationModel = textModel;

// 3. A turn with tools on comm's model.
const run = Date.now().toString(36);
const A = `relay-claude-${run}`;
const first = await cliTurn(cookie, {
  cli: "claude",
  workspace: A,
  model: `comm/${FIRST}`,
  mode: "approval-required",
  plan: false,
  prompt: `Remember the code word OSPREY-41 for later. ${EDIT_AND_TEST}`,
});
report.turn = clean(first);
check(
  "a Claude Code turn with tools ran on comm's model through the relay",
  first.runs.at(-1)?.status === "completed" && first.items.some((item: any) => item.type === "file_change") && first.items.some((item: any) => item.type === "command_execution" && String(item.input ?? item.title ?? "").includes("test.sh")),
  first.items,
);
check("its tool requests were asked and accepted", first.requests.length > 0 && first.requests.every((request: any) => request.decision === "accept"), first.requests);

// The managed settings Claude Code runs with (the Container's): the relay, the handle helper, the background model.
const managed = await exec(A, "cat /etc/claude-code/managed-settings.json");
const settings = JSON.parse(String(managed.stdout ?? "{}")) as any;
report.managedSettings = clean({
  apiKeyHelper: settings.apiKeyHelper,
  availableModels: settings.availableModels,
  baseUrl: settings.env?.ANTHROPIC_BASE_URL,
  backgroundModel: settings.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  sonnetModel: settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
  opusModel: settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL,
});
check(
  "Claude Code's sonnet and opus aliases are slugs (sonnet: the endpoints' sonnet; opus: none, so the first model)",
  settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL === `comm2/${SECOND}` && settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL === `comm/${FIRST}`,
  report.managedSettings,
);
check(
  "the managed settings: the model-routed relay URL, the handle helper, the endpoints' slugs",
  settings.apiKeyHelper === "/opt/t3flare/bin/t3flare-claude-handle" && settings.env?.ANTHROPIC_BASE_URL === "http://computer.internal/t3flare/model/_" && JSON.stringify(settings.availableModels) === JSON.stringify([`comm/${FIRST}`, `comm2/${SECOND}`]),
  report.managedSettings,
);
check("the background model is the text-generation model (an Anthropic Messages endpoint's)", textModel?.model === `comm2/${SECOND}` && settings.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL === textModel.model, { textModel, managed: report.managedSettings });

// 4. A model switch between the endpoints in the same thread, and back.
const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
const switched = await cliTurn(cookie, { cli: "claude", workspace: A, model: `comm2/${SECOND}`, mode: "approval-required", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
const back = await cliTurn(cookie, { cli: "claude", workspace: A, model: `comm/${FIRST}`, mode: "approval-required", plan: false, prompt: "And once more: the code word only.", threadId: first.threadId });
report.switch = clean({ toComm2: { runs: switched.runs.slice(-1), text: switched.text, native: native(switched) }, back: { runs: back.runs.slice(-1), text: back.text, native: native(back) }, first: native(first) });
check(
  "a model switch to the other endpoint's model and back: each turn completes and knows the code word",
  switched.runs.at(-1)?.status === "completed" && switched.text.includes("OSPREY-41") && back.runs.at(-1)?.status === "completed" && back.text.includes("OSPREY-41"),
  report.switch,
);
check("the same native Claude session throughout (no handoff)", native(first).length === 1 && JSON.stringify(native(first)) === JSON.stringify(native(switched)) && JSON.stringify(native(first)) === JSON.stringify(native(back)), report.switch);

// 5. Where the handle is, with the thread's process alive. Only counts and names leave the Container.
const CANARY = { id: "canary", label: "Canary", ...ANTHROPIC, models: [FIRST] };
check("the canary endpoint saved (after the process started)", (await api("POST", "endpoints", { op: "save", endpoint: CANARY, apiKey: canaryKey })).status === 200);
const ROUTED = "http://computer.internal/t3flare/model/_/v1/messages";
const post = (handleExpr: string, model: string) =>
  `curl -s -o /dev/null -w '%{http_code}' -X POST ${handleExpr === "" ? "" : `-H "x-api-key: ${handleExpr}" `}-H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' --data '{"model":"${model}","max_tokens":5,"messages":[{"role":"user","content":"Reply with ok."}]}' ${ROUTED}`;
const where = await exec(
  A,
  [
    // Every process whose environment holds a handle, by its command.
    `holders=""; for f in /proc/[0-9]*/environ; do if tr '\\0' '\\n' < "$f" 2>/dev/null | grep -q '^T3FLARE_MODEL_HANDLE='; then p=\${f#/proc/}; p=\${p%/environ}; holders="$holders $(tr '\\0' ' ' < /proc/$p/cmdline | head -c 240 | sed 's/[^A-Za-z0-9 ./_@-]//g')|"; fi; done`,
    `H=$(grep -ahz '^T3FLARE_MODEL_HANDLE=' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | head -1 | cut -d= -f2)`,
    `echo "handle=$H"`,
    `echo "holders=$holders"`,
    // The claude binary's own environment, and the files: none holds it.
    `claude=0; for p in $(pgrep -f 'claude-agent-sdk-linux-x64/claude'); do tr '\\0' '\\n' < /proc/$p/environ | grep -q '^T3FLARE_MODEL_HANDLE=' && claude=$((claude+1)); done; echo "claudeProcesses=$(pgrep -fc 'claude-agent-sdk-linux-x64/claude')"; echo "claudeWithHandle=$claude"`,
    `echo "files=$( [ -n "$H" ] && grep -rlsF "$H" /var/lib/t3flare /etc/claude-code /root /tmp /workspace 2>/dev/null | wc -l)"`,
    `n=0; for d in /var/lib/t3flare/cli/*/; do k=$(basename "$d"); [ -f "$d/acp.pid" ] && [ "$(T3FLARE_EXEC=$k /opt/t3flare/bin/t3flare-claude-handle 2>/dev/null)" = "$H" ] && n=$((n+1)); done; echo "helper=$n"`,
    `F=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')`,
    `echo "valid=$(${post("$H", `comm/${FIRST}`)})"`,
    `echo "validOther=$(${post("$H", `comm2/${SECOND}`)})"`,
    `echo "forged=$(${post("$F", `comm/${FIRST}`)})"`,
    `echo "none=$(${post("", `comm/${FIRST}`)})"`,
    `echo "unconfigured=$(${post("$H", `canary/${FIRST}`)})"`,
    `echo "noSlug=$(${post("$H", FIRST)})"`,
  ].join("\n"),
  120_000,
);
const lines = linesOf(where.stdout);
const handle = /^[0-9a-f]{64}$/.test(lines.handle ?? "") ? lines.handle! : undefined;
if (handle !== undefined) handles.push(handle);
delete lines.handle;
report.handle = clean({ found: handle !== undefined, ...lines, stderr: String(where.stderr ?? "").slice(0, 300) });
const holders = String(lines.holders ?? "").split("|").map((entry) => entry.trim()).filter((entry) => entry !== "");
check("only the launch chain's start environments hold the handle (setsid and claude-agent-acp; not claude's, not a shell's)", handle !== undefined && holders.length >= 1 && holders.every((entry) => entry === "setsid --wait /opt/t3flare/bin/claude-agent-acp" || entry.includes("claude-handle-unset.cjs")) && lines.claudeWithHandle === "0" && Number(lines.claudeProcesses) >= 1, report.handle);
check("no file holds the handle", lines.files === "0", report.handle);
check("the handle helper prints the handle", Number(lines.helper) >= 1, report.handle);
check("the handle reaches both endpoints through the model-routed URL (200)", lines.valid === "200" && lines.validOther === "200", report.handle);
check("a forged handle and no handle are refused (401)", lines.forged === "401" && lines.none === "401", report.handle);
check("an endpoint saved after the process started, named in the body, is refused (403)", lines.unconfigured === "403", report.handle);
check("a model without an endpoint is refused (400)", lines.noSlug === "400", report.handle);

// A Claude shell has no handle.
const shell = await cliTurn(cookie, { cli: "claude", workspace: A, model: `comm/${FIRST}`, mode: "full-access", plan: false, prompt: "Run exactly this shell command: `env > /tmp/p1168-shell-env.txt` and then reply with the single word done.", threadId: first.threadId });
const shellEnv = await exec(A, "echo handle=$(grep -c '^T3FLARE_MODEL_HANDLE=' /tmp/p1168-shell-env.txt); echo exec=$(grep -c '^T3FLARE_EXEC=' /tmp/p1168-shell-env.txt); rm -f /tmp/p1168-shell-env.txt");
report.shellEnv = { runs: shell.runs.slice(-1), counts: String(shellEnv.stdout ?? "").trim() };
check("a Claude shell's environment has no model handle (its marker shows it was the process's)", String(shellEnv.stdout ?? "").includes("handle=0") && String(shellEnv.stdout ?? "").includes("exec=1"), report.shellEnv);

// 6. The leak scan, with the thread's process alive; then the positive control.
const scan = await leak(A);
report.leak = clean(scan);
check("the leak scan finds no endpoint key and scanned every key (DO files, Container files, process environments and command lines)", (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0 && (scan?.container?.files ?? 0) > 0 && Array.isArray(scan?.notScanned) && scan.notScanned.length === 0, scan);
await exec(A, `printf %s '${canaryKey}' > /tmp/p1168-canary.txt`);
const planted = await leak(A);
await exec(A, "rm -f /tmp/p1168-canary.txt");
const plantedHits = (planted?.container?.hits ?? []) as Array<{ name: string; path: string }>;
report.leakControl = clean({ hits: plantedHits });
check("the leak scan finds an endpoint key planted in the Container", plantedHits.some((hit) => hit.name === "endpoint:canary" && hit.path === "/tmp/p1168-canary.txt"), report.leakControl);
check("the canary endpoint removed", (await api("POST", "endpoints", { op: "remove", id: "canary" })).status === 200);

// 7. The agents Worker's log.
await sleep(10_000);
tail.kill("SIGINT");
await sleep(1500);
fs.closeSync(logFd);
const raw = fs.readFileSync(logFile, "utf8");
const relayLogs: Array<any> = [];
for (const chunk of raw.split(/\n(?=\{\n)/).filter((part) => part.trim().startsWith("{"))) {
  try {
    const event = JSON.parse(chunk) as { logs?: Array<{ message: Array<unknown> }> };
    for (const log of event.logs ?? []) {
      for (const message of log.message) {
        if (typeof message !== "string" || !message.startsWith('{"t3flare":"model-relay"')) continue;
        relayLogs.push(JSON.parse(message));
      }
    }
  } catch {
    // An event cut off when the tail stopped.
  }
}
const claudeLogs = relayLogs.filter((entry) => entry.cli === "claude");
const byStatus: Record<string, number> = {};
for (const entry of relayLogs) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
report.relayLog = {
  entries: relayLogs.length,
  byStatus,
  claude: { entries: claudeLogs.length, endpoints: [...new Set(claudeLogs.map((entry) => entry.endpoint))], routed: claudeLogs.every((entry) => entry.routed === true), statuses: [...new Set(claudeLogs.map((entry) => entry.status))] },
  // What Claude Code sends that the allowlist keeps back (names only).
  claudeDropped: [...new Set(claudeLogs.flatMap((entry) => entry.dropped ?? []))].sort((a, b) => String(a).localeCompare(String(b))),
  // Requests the routed URL refused before an endpoint (a request with no model slug in its body).
  routedRefusals: relayLogs.filter((entry) => entry.routed === true && entry.endpoint === null).map((entry) => ({ status: entry.status, method: entry.method, why: entry.why })),
  sample: claudeLogs.slice(0, 3),
};
check("the routed URL refused none of Claude's requests (every model it sent was a slug)", (report.relayLog as any).routedRefusals.length === 0 && claudeLogs.every((entry) => entry.status === 200), report.relayLog);
check("Claude's requests went through the model-routed URL to both endpoints", claudeLogs.length >= 3 && claudeLogs.every((entry) => entry.routed === true) && claudeLogs.some((entry) => entry.endpoint === "comm") && claudeLogs.some((entry) => entry.endpoint === "comm2"), report.relayLog);
check("no handle or key in the agents Worker's log", [...secrets, ...handles].every((value) => !raw.includes(value)));
finish();
