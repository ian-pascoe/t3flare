// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1167's evidence on its stage (deployed with T3FLARE_PROBE=1): the model relay with Codex as its first CLI.
//
//   T3FLARE_PROBE=1 node scripts/stage.ts deploy p1167
//   node scripts/stage.ts run p1167 p1167 [--out ../../docs/steps/spi-1167/p1167.json] [--skip-stream]
//
// 1. Two Model endpoints saved through the Harness panel's API: `openai` (OpenAI's API with gpt-5-mini when
//    OPENAI_API_KEY is in dev.env, else Commissary's OpenAI Responses API at `<MODEL_PROXY_URL>/v1` with the proxy key,
//    SPI-1162's approach) and `slow`, the stage's probe Worker's stand-in endpoint, keyed with the probe key.
// 2. Codex lists `openai/<model>`; a Codex thread runs a turn with tools on it, through the relay.
// 3. In the Container: the process's model handle reaches the relay; a forged handle, the tool handle and none are
//    refused (401); the handle is refused in another Workspace's Container (foreign).
// 4. The leak scan (step 4a's: Container files, every process's environment and command line, the DO's files) finds
//    no endpoint key.
// 5. The Container is stopped; the thread's next turn resumes the same native Codex thread (its rollout names the
//    endpoint's provider); the first process's handle is now refused (revoked).
// 5b. The same thread on a model of another provider (the Model proxy's) is refused with a clear reason (a Codex
//    process runs turns only on its own provider), and the thread goes on with the endpoint's model.
// 6. A stream of over 10 minutes with idle gaps (30 to 180 s) through the relay from the Container completes.
// 7. The stand-in endpoint saw its key and never a handle; the agents Worker's log (wrangler tail) has every relayed
//    request with its endpoint, status and handle id, and no handle or key.
//
// No key or handle is printed or kept: every answer kept is scanned for them first. The handle travels from the
// Container to this script only to be used in the other Workspace's Container (the foreign case) and the revoked case.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { admin, base, pair, sleep, wsCall } from "./lib/client.ts";
import { cliTurn, enable, ensureProject } from "./lib/cliTurn.ts";

const here = path.resolve(import.meta.dirname, "..");
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = option("out");
const skipStream = process.argv.includes("--skip-stream");
const stage = base.hostname.split(".")[0]!.replace(/^t3flare-environment-/, "");
const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";
const probeKey = process.env.T3FLARE_PROBE_KEY ?? "";
const PROBE = `https://t3flare-probe-${stage}.ian-g-pascoe.workers.dev`;

/** OPENAI_API_KEY from the environment, else from dev.env (read by bash, never printed). */
const openaiKey = (() => {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const file = path.join(os.homedir(), ".config/t3flare/dev.env");
  if (!fs.existsSync(file)) return undefined;
  const result = spawnSync("bash", ["-c", 'set -a; . "$1"; set +a; printf %s "${OPENAI_API_KEY:-}"', "-", file], { encoding: "utf8" });
  return result.status === 0 && result.stdout !== "" ? result.stdout : undefined;
})();

/** The positive control's key (4b): a test endpoint's, planted in the Container for the leak scan to find. */
const canaryKey = `sk-canary-${randomBytes(24).toString("hex")}`;
const secrets = [proxyKey, probeKey, openaiKey, canaryKey].filter((value): value is string => value !== undefined && value.length >= 8);
const handles: Array<string> = [];
const failures: Array<string> = [];
const report: Record<string, unknown> = { at: new Date().toISOString(), stage, openai: openaiKey === undefined ? "Commissary's OpenAI Responses API (<MODEL_PROXY_URL>/v1)" : "OpenAI's API" };
const check = (name: string, ok: boolean, detail?: unknown) => {
  report.checks = [...((report.checks as Array<unknown>) ?? []), { name, ok }];
  if (!ok) failures.push(`${name}: ${JSON.stringify(clean(detail ?? null)).slice(0, 600)}`);
  return ok;
};
/** Throws if a key or a handle is in `value`; a value kept as evidence goes through here. */
function clean<T>(value: T): T {
  const text = JSON.stringify(value) ?? "";
  for (const secret of [...secrets, ...handles]) if (text.includes(secret)) throw new Error("a key or a handle reached an answer kept as evidence");
  return value;
}

// The agents Worker's log, for the whole run (wrangler with the alchemy profile's token, never printed).
const profile = process.env.ALCHEMY_PROFILE ?? "default";
const cf = (() => {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values;
  return { token: stored.access as string, accountId: stored.accountId as string };
})();
const logFile = path.join(os.tmpdir(), `t3flare-p1167-tail-${Date.now()}.ndjson`);
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
const probeLog = async (): Promise<Array<any>> => (await (await fetch(`${PROBE}/log`, { headers: { authorization: `Bearer ${probeKey}` } })).json()) as Array<any>;
const leak = async (workspace: string) => (await admin("POST", `/_t3flare/check/leak?id=${encodeURIComponent(workspace)}`)).json;

/** The first live process's model handle in a Workspace's Container (read from /proc, as any root process could). */
const HANDLE_OF = (name: string) => `grep -ahz '^${name}=' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | head -1 | cut -d= -f2`;
const code = (handleExpr: string, pathname = "slow/models") =>
  `curl -s -o /dev/null -w '%{http_code}' ${handleExpr === "" ? "" : `-H "authorization: Bearer ${handleExpr}" `}http://computer.internal/t3flare/model/${pathname}`;

if (proxyUrl === "" || probeKey === "") {
  failures.push("the stage needs MODEL_PROXY_URL and the probe key (deploy with T3FLARE_PROBE=1)");
  finish();
}

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");

// 1. The endpoints.
// Through Commissary, a model its Responses API serves this key (gemini-3-flash is deprecated there since SPI-1162).
const MODEL = openaiKey === undefined ? "claude-haiku-5-5" : "gpt-5-mini";
const OPENAI =
  openaiKey === undefined
    ? { id: "openai", label: "OpenAI (Responses)", api: "openai-responses", baseUrl: `${proxyUrl}/v1`, auth: "api-key", headers: {}, models: [MODEL] }
    : { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: [MODEL] };
const SLOW = { id: "slow", label: "Stand-in", api: "openai-responses", baseUrl: `${PROBE}/relay/v1`, auth: "api-key", headers: { "X-T3flare-Evidence": "p1167" }, models: ["drip"] };
const saved = {
  openai: (await api("POST", "endpoints", { op: "save", endpoint: OPENAI, apiKey: openaiKey ?? proxyKey })).status,
  slow: (await api("POST", "endpoints", { op: "save", endpoint: SLOW, apiKey: probeKey })).status,
};
report.endpoints = { saved, openai: { baseUrl: OPENAI.baseUrl, model: MODEL }, slow: { baseUrl: SLOW.baseUrl } };
check("both endpoints saved", saved.openai === 200 && saved.slow === 200, saved);

// 2. Codex's model list, and a turn with tools on the endpoint's model.
await enable(cookie, "codex", "codex");
await sleep(2000);
const codexConfig = (await wsCall(cookie, "server.refreshProviders", { instanceId: "codex" }).catch(() => wsCall(cookie, "server.getConfig", {}))) as any;
const codexModels = ((codexConfig?.providers ?? []) as Array<any>).find((provider) => provider.driver === "codex")?.models ?? [];
const listed = codexModels.filter((model: any) => String(model.slug).includes("/")).map((model: any) => ({ slug: model.slug, group: model.subProvider }));
report.codexModels = { endpointModels: listed, total: codexModels.length };
check("Codex lists the Responses endpoints' models by slug", listed.some((row: any) => row.slug === `openai/${MODEL}`) && listed.some((row: any) => row.slug === "slow/drip"), listed);
// A changed model list reaches Codex's at once, through its endpoints listener (read without asking for a refresh).
const added = (await api("POST", "endpoints", { op: "save", endpoint: { ...SLOW, models: ["drip", "drip-2"] } })).status;
let followed = false;
for (let i = 0; i < 10 && !followed; i++) {
  await sleep(1000);
  const config = (await wsCall(cookie, "server.getConfig", {})) as any;
  followed = (((config?.providers ?? []) as Array<any>).find((provider) => provider.driver === "codex")?.models ?? []).some((model: any) => model.slug === "slow/drip-2");
}
report.codexModelsFollow = { saved: added, listed: followed };
check("an added endpoint model reaches Codex's list at once (no refresh asked)", added === 200 && followed, report.codexModelsFollow);

const run = Date.now().toString(36);
const A = `relay-codex-${run}`;
const B = `relay-other-${run}`;
const first = await cliTurn(cookie, {
  cli: "codex",
  workspace: A,
  model: `openai/${MODEL}`,
  mode: "approval-required",
  plan: false,
  prompt: "Remember the code word HERON-67 for later. In src/greeting.txt add a new last line `Hello through the relay.` (edit the file), then run `bash test.sh` and tell me in one sentence whether it passed.",
});
report.turn = clean(first);
check("a Codex turn with tools ran on the endpoint through the relay", first.runs.at(-1)?.status === "completed" && first.items.some((item: any) => item.type === "file_change" && String(item.fileName).endsWith("src/greeting.txt")) && first.items.some((item: any) => item.type === "command_execution" && String(item.input).includes("test.sh") && item.exitCode === 0), first.items);

// 3. Handles in the Container (the turn's process lives on, holding the Container). The `canary` endpoint is saved after
// the process started: its handle is not for it.
const CANARY = { id: "canary", label: "Canary", api: "openai-responses", baseUrl: `${PROBE}/relay/v1`, auth: "api-key", headers: {}, models: ["drip"] };
check("the canary endpoint saved", (await api("POST", "endpoints", { op: "save", endpoint: CANARY, apiKey: canaryKey })).status === 200);
const handleRun = await exec(
  A,
  [
    `H=$(${HANDLE_OF("T3FLARE_MODEL_HANDLE")}); T=$(${HANDLE_OF("T3FLARE_TOOL_HANDLE")})`,
    `F=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')`,
    `echo "handle=$H"`,
    `echo "valid=$(${code("$H")})"`,
    `echo "forged=$(${code("$F")})"`,
    `echo "tool=$(${code("$T")})"`,
    `echo "none=$(${code("")})"`,
    `echo "gone=$(${code("$H", "no-such-endpoint/models")})"`,
    `echo "unconfigured=$(${code("$H", "canary/models")})"`,
    `echo "encoded=$(${code("$H", "slow/%252e%252e/models")})"`,
    // Headers a header-routed gateway would route by: the relay forwards none of them.
    `echo "routing=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $H" -H 'x-portkey-custom-host: https://evil.example' -H 'x-forwarded-host: evil.example' -H 'x-evidence-dropped: evil.example' http://computer.internal/t3flare/model/slow/models)"`,
  ].join("\n"),
);
const lines = Object.fromEntries(String(handleRun.stdout ?? "").trim().split("\n").map((line: string) => line.split("=", 2) as [string, string]));
const handle = /^[0-9a-f]{64}$/.test(lines.handle ?? "") ? lines.handle! : undefined;
if (handle !== undefined) handles.push(handle);
delete lines.handle;
report.handles = { found: handle !== undefined, statuses: lines };
check("the process's model handle reaches the relay (200)", handle !== undefined && lines.valid === "200", report.handles);
check("a forged handle, the tool handle and no handle are refused (401)", lines.forged === "401" && lines.tool === "401" && lines.none === "401", lines);
// The handle's scope comes first: an endpoint that does not exist is refused as any endpoint the process is not for.
check("an endpoint that does not exist is refused (403, the handle is not for it)", lines.gone === "403", lines);
check("an endpoint the process is not configured for is refused (403)", lines.unconfigured === "403", lines);
check("an encoded dot segment is refused (400)", lines.encoded === "400", lines);
check("a request with routing headers still reaches the endpoint (they are dropped, below)", lines.routing === "200", lines);
await ensureProject(cookie, B);
const foreign = handle === undefined ? {} : await exec(B, `echo "foreign=$(${code(handle)})"`);
report.foreign = { output: String(foreign.stdout ?? "").trim() };
check("another Workspace's handle is refused in this Container (401)", String(foreign.stdout ?? "").includes("foreign=401"), report.foreign);

// 4. The leak scan, with the turn's process alive.
const scan = await leak(A);
report.leak = clean(scan);
check("the leak scan finds no endpoint key (DO files, Container files, process environments and command lines)", (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0 && (scan?.container?.files ?? 0) > 0 && (scan?.notScanned ?? []).length === 0, scan);

// 4b. The positive control: the canary endpoint's key, planted in the Container, is found by the same scan.
await exec(A, `printf %s '${canaryKey}' > /tmp/p1167-canary.txt`);
const planted = await leak(A);
await exec(A, "rm -f /tmp/p1167-canary.txt");
const plantedHits = (planted?.container?.hits ?? []) as Array<{ name: string; path: string }>;
report.leakControl = clean({ hits: plantedHits });
check("the leak scan finds an endpoint key planted in the Container", plantedHits.some((hit) => hit.name === "endpoint:canary" && hit.path === "/tmp/p1167-canary.txt"), report.leakControl);
check("the canary endpoint removed", (await api("POST", "endpoints", { op: "remove", id: "canary" })).status === 200);

// 4c. A Codex shell has no model handle (`shell_environment_policy.exclude`), though the Codex process has one.
const shell = await cliTurn(cookie, { cli: "codex", workspace: A, model: `openai/${MODEL}`, mode: "full-access", plan: false, prompt: "Run exactly this shell command: `env > /tmp/p1167-shell-env.txt` and then reply with the single word done.", threadId: first.threadId });
const shellEnv = await exec(A, "echo handle=$(grep -c '^T3FLARE_MODEL_HANDLE=' /tmp/p1167-shell-env.txt); echo exec=$(grep -c '^T3FLARE_EXEC=' /tmp/p1167-shell-env.txt); rm -f /tmp/p1167-shell-env.txt");
report.shellEnv = { runs: shell.runs.slice(-1), counts: String(shellEnv.stdout ?? "").trim() };
check("a Codex shell's environment has no model handle (its marker shows it was the shell's)", String(shellEnv.stdout ?? "").includes("handle=0") && String(shellEnv.stdout ?? "").includes("exec=1"), report.shellEnv);

// 5. Resume after a Container restart; the old handle is revoked.
await admin("POST", `/_t3flare/agents/workspace-stop?id=${A}`);
let container: any = null;
for (let i = 0; i < 12; i++) {
  await sleep(5000);
  container = (await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces?.find((ws: any) => ws.id === A)?.container ?? null;
  if (container?.running === false) break;
}
check("the Container stopped", container?.running === false, container);
await admin("GET", "/_t3flare/agents/router-trace?clear=1");
const second = await cliTurn(cookie, { cli: "codex", workspace: A, model: `openai/${MODEL}`, mode: "full-access", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
report.resume = clean(second);
const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
check("the next turn completed after the restart", second.runs.at(-1)?.status === "completed", second.runs);
check("it knew the code word", second.text.includes("HERON-67"), second.text);
check("the same native Codex thread (resumed, not a handoff)", native(first).length === 1 && JSON.stringify(native(first)) === JSON.stringify(native(second)), { first: native(first), second: native(second) });
const trace = ((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<any>;
report.resumeTrace = trace.filter((entry: any) => entry.route === "protocol").slice(-5);
check("the protocol log shows Codex resumed that thread", trace.some((entry: any) => entry.route === "protocol" && String(entry.detail ?? "").startsWith("ok") && String(entry.detail).includes(String(native(first)[0]))), report.resumeTrace);
const revoked = handle === undefined ? {} : await exec(A, `echo "revoked=$(${code(handle)})"; echo "fresh=$(${code(`$(${HANDLE_OF("T3FLARE_MODEL_HANDLE")})`)})"`);
report.revoked = { output: String(revoked.stdout ?? "").trim() };
check("the first process's handle is refused after it ended (401), the new process's passes", String(revoked.stdout ?? "").includes("revoked=401") && String(revoked.stdout ?? "").includes("fresh=200"), report.revoked);

// 5b. A model of another provider on the same thread is refused, saying why; the endpoint's model goes on.
const proxyTurn = await cliTurn(cookie, { cli: "codex", workspace: A, model: "claude-haiku-5-5", mode: "full-access", plan: false, prompt: "Reply with the code word again, only.", threadId: first.threadId });
const backTurn = await cliTurn(cookie, { cli: "codex", workspace: A, model: `openai/${MODEL}`, mode: "full-access", plan: false, prompt: "And once more: the code word only.", threadId: first.threadId });
report.switch = clean({ toProxy: { runs: proxyTurn.runs.slice(-1) }, back: { runs: backTurn.runs.slice(-1), text: backTurn.text, native: native(backTurn) } });
check(
  "a turn on a model of another provider is refused, and the thread goes on with its endpoint's model",
  proxyTurn.runs.at(-1)?.status === "failed" && backTurn.runs.at(-1)?.status === "completed" && backTurn.text.includes("HERON-67") && JSON.stringify(native(backTurn)) === JSON.stringify(native(first)),
  report.switch,
);

// 6. A stream of over 10 minutes with idle gaps, from the Container through the relay, while a turn holds it.
const GAPS = [30, 60, 90, 120, 150, 180];
if (!skipStream) {
  const holding = cliTurn(cookie, { cli: "codex", workspace: A, model: `openai/${MODEL}`, mode: "full-access", plan: false, prompt: "Run the shell command `sleep 300 && echo slept` and then reply with the single word done.", threadId: first.threadId });
  await sleep(20_000);
  const started = await exec(
    A,
    `H=$(${HANDLE_OF("T3FLARE_MODEL_HANDLE")}); rm -f /tmp/drip.out; (date +%s > /tmp/drip.start; curl -sN -o /tmp/drip.out -w '%{http_code}' -H "authorization: Bearer $H" 'http://computer.internal/t3flare/model/slow/drip?gaps=${GAPS.join(",")}' > /tmp/drip.code 2>/tmp/drip.err; echo $? > /tmp/drip.exit; date +%s > /tmp/drip.end) > /dev/null 2>&1 &\necho started`,
  );
  check("the stream started", String(started.stdout ?? "").includes("started"), started);
  const timeline: Array<unknown> = [];
  let done = false;
  const began = Date.now();
  while (!done && Date.now() - began < 16 * 60_000) {
    await sleep(30_000);
    const poll = await exec(A, "echo events=$(grep -c '^data:' /tmp/drip.out 2>/dev/null || echo 0); echo exit=$(cat /tmp/drip.exit 2>/dev/null); echo code=$(cat /tmp/drip.code 2>/dev/null); echo seconds=$(( $(cat /tmp/drip.end 2>/dev/null || date +%s) - $(cat /tmp/drip.start) ))");
    const state = Object.fromEntries(String(poll.stdout ?? "").trim().split("\n").map((line: string) => line.split("=", 2) as [string, string]));
    timeline.push({ s: Math.round((Date.now() - began) / 1000), ...state });
    done = state.exit !== undefined && state.exit !== "";
  }
  const last = timeline.at(-1) as Record<string, string> | undefined;
  const tailOut = await exec(A, "tail -c 400 /tmp/drip.out; echo; cat /tmp/drip.err | head -c 300");
  report.longStream = { gapsSeconds: GAPS, timeline, last, end: String(tailOut.stdout ?? "").slice(-500) };
  check(
    "a stream of over 10 minutes with idle gaps up to 3 minutes completed through the relay",
    last?.exit === "0" && last?.code === "200" && Number(last?.seconds) >= 600 && Number(last?.events) === GAPS.length + 2 && String(tailOut.stdout ?? "").includes("[DONE]"),
    report.longStream,
  );
  const held = await holding;
  report.holdingTurn = { runs: held.runs };
  const drip = (await probeLog()).filter((entry) => entry.kind === "relay-drip-done").at(-1);
  check("the stand-in endpoint finished the stream", drip !== undefined && drip.seconds >= 600, drip);
}

// 7. What the stand-in endpoint saw, and the agents Worker's log.
const relayed = (await probeLog()).filter((entry) => entry.kind === "relay");
report.standIn = { requests: relayed.length, sawKey: relayed.every((entry) => entry.sawKey === true), evidenceHeader: relayed.every((entry) => entry.headers?.["x-t3flare-evidence"] === "p1167"), sample: relayed.slice(0, 3).map((entry) => ({ path: entry.path, headers: Object.keys(entry.headers ?? {}) })) };
check("the stand-in got its key and the endpoint's header with every relayed request", relayed.length >= 2 && (report.standIn as any).sawKey && (report.standIn as any).evidenceHeader, report.standIn);
check("no handle ever reached the endpoint", handles.every((value) => !JSON.stringify(relayed).includes(value)));
check("no routing header from the Container reached the endpoint", relayed.length > 0 && !JSON.stringify(relayed).includes("evil.example") && relayed.every((entry) => entry.headers?.["x-portkey-custom-host"] === undefined));
// The final turn's leak scan.
const scanAfter = await leak(A);
report.leakAfter = clean(scanAfter);
check("the leak scan after every turn finds no key", (scanAfter?.do ?? []).length === 0 && (scanAfter?.container?.hits ?? []).length === 0 && (scanAfter?.notScanned ?? []).length === 0, scanAfter);

await sleep(10_000);
tail.kill("SIGINT");
await sleep(1500);
fs.closeSync(logFd);
const raw = fs.readFileSync(logFile, "utf8");
// wrangler prints one pretty-printed JSON object per event, back to back (as logs-check.ts reads it).
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
const byStatus: Record<string, number> = {};
for (const entry of relayLogs) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
report.relayLog = {
  entries: relayLogs.length,
  byStatus,
  endpoints: [...new Set(relayLogs.map((entry) => entry.endpoint))],
  // What Codex sends that the allowlist keeps back (names only), from its turns on the openai endpoint.
  codexDropped: [...new Set(relayLogs.filter((entry) => entry.cli === "codex" && entry.endpoint === "openai").flatMap((entry) => entry.dropped ?? []))].sort((a, b) => String(a).localeCompare(String(b))),
  sample: relayLogs.slice(0, 4),
};
check("the agents Worker logged relayed requests with endpoint, status and handle id", relayLogs.length >= 5 && relayLogs.every((entry) => typeof entry.endpoint === "string" && typeof entry.status === "number" && "handle" in entry) && byStatus["200"] !== undefined && byStatus["401"] !== undefined, report.relayLog);
check("no handle or key in the agents Worker's log", [...secrets, ...handles].every((value) => !raw.includes(value)));
finish();
