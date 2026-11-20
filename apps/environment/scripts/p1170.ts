// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1170's evidence on its stage: the pi CLI through the model relay.
//
//   node scripts/stage.ts deploy p1170
//   node scripts/stage.ts run p1170 p1170 [--out ../../docs/steps/spi-1170/p1170.json]
//
// 1. Three Model endpoints saved through the Settings page's API, all Commissary's with the proxy key (SPI-1162's
//    approach): `comm` (Anthropic Messages at <MODEL_PROXY_URL>), `oai` (OpenAI-compatible Chat Completions at
//    <MODEL_PROXY_URL>/v1) and `resp` (OpenAI Responses at <MODEL_PROXY_URL>/v1).
// 2. pi lists exactly the endpoints' models by slug, the first the default (none of the proxy's); its models.json has
//    one provider per endpoint at the relay's per-endpoint URL with the handle command as its key, and no key.
// 3. A pi turn with tools on `comm/<model>` (approval-required, every request accepted): an edit and a test run.
// 4. In the same thread, a turn with tools on `oai/<model>` (an OpenAI endpoint), then one on `resp/<model>`: each
//    completes in the same native pi session, and the last (with tools too) knows the code word.
// 5. Where the handle is: only in the start environment of the launch chain's setsid (not pi's, not a shell's, not in
//    any file); a full-access turn's `env` holds no handle. The handle reaches the relay for each endpoint in its API's
//    key header (200); a forged handle and none get 401; an endpoint saved after the process started gets 403. The
//    handle command run outside a pi process's launch chain prints nothing.
// 6. The leak scan finds no endpoint key and names none it could not scan; a planted canary key is found.
// 7. The Container is stopped; the thread's next turn (on `comm/<model>`) runs in a new pi process with a new handle,
//    resumes the same native pi session (switch_session) and knows the code word; the first handle is refused (401).
// 8. The agents Worker's log (wrangler tail): pi's relayed requests with their endpoints, and the names of the headers
//    pi sends that the allowlist drops; the key helper never asked by pi; no handle or key.
//
// No key or handle is printed or kept: every answer kept is scanned for them first.
import { randomBytes } from "node:crypto";

import { PI_HANDLE_HOLDERS } from "../src/agents/cliProfiles.ts";
import { admin, pair, sleep, wsCall } from "./lib/client.ts";
import { cliTurn, enable } from "./lib/cliTurn.ts";
import { EDIT_AND_TEST } from "./lib/acpTurn.ts";
import { leakCheck as leak, linesOf, panelApi as api, relayEvidence, workerLogs, workspaceExec as exec } from "./lib/relayEvidence.ts";
import { tailing } from "./lib/tail.ts";

const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";
/** The positive control's key: a test endpoint's, planted in the Container for the leak scan to find. */
const canaryKey = `sk-canary-${randomBytes(24).toString("hex")}`;
const { stage, report, handles, clean, check, leaks, finish, fail } = relayEvidence([proxyKey, canaryKey]);

if (proxyUrl === "" || proxyKey === "") {
  fail("the stage needs MODEL_PROXY_URL and MODEL_PROXY_API_KEY (dev.env)");
  finish();
}

/** The script that prints the handle of the process whose start environment holds one (the first found), or nothing. */
const HANDLE_OF = `grep -ahz '^T3FLARE_MODEL_HANDLE=' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | head -1 | cut -d= -f2`;

// The agents Worker's log for the whole run (`tailing`), read once the work is done.
const { text: raw } = await tailing([`t3flare-agents-${stage}`], async () => {
  const cookie = await pair();
  await admin("POST", "/_t3flare/disarm-bootstrap");

  // 1. The endpoints: Commissary's three APIs, each with the same model (the list read with the key). The stage's own
  //    endpoint (`stage.ts deploy`'s, SPI-1175) is removed first, so pi's are exactly these.
  const existing = ((await api("GET", "endpoints")).json ?? {}) as { endpoints?: { endpoints?: Array<{ id: string }> } | Array<{ id: string }> };
  const existingIds = (Array.isArray(existing.endpoints) ? existing.endpoints : (existing.endpoints?.endpoints ?? [])).map((entry) => entry.id);
  for (const id of existingIds) await api("POST", "endpoints", { op: "remove", id });
  report.removedEndpoints = existingIds;
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

  // 2. pi's model list.
  await enable(cookie, "pi", "pi");
  await sleep(2000);
  const config = (await wsCall(cookie, "server.getConfig", {})) as any;
  const piModels = (((config?.providers ?? []) as Array<any>).find((provider) => provider.driver === "pi")?.models ?? []).map((model: any) => ({ slug: model.slug, group: model.subProvider, isDefault: model.isDefault === true }));
  report.piModels = { first: piModels.slice(0, 4), total: piModels.length, proxyRetained: piModels.filter((row: any) => String(row.slug).startsWith("anthropic/")).length };
  check(
    "pi lists exactly the endpoints' models by slug, the first the default (t3's registry keeps none of the proxy's)",
    JSON.stringify(piModels.map((row: any) => row.slug)) === JSON.stringify([SLUGS.comm, SLUGS.oai, SLUGS.resp]) && piModels[0]?.isDefault === true && (report.piModels as any).proxyRetained === 0,
    piModels.slice(0, 5),
  );

  // 3. A turn with tools on comm's model (Anthropic Messages).
  const run = Date.now().toString(36);
  const A = `relay-pi-${run}`;
  const first = await cliTurn(cookie, { cli: "pi", workspace: A, model: SLUGS.comm, mode: "approval-required", plan: false, prompt: `Remember the code word KESTREL-41 for later. ${EDIT_AND_TEST}` });
  report.turn = clean(first);
  const toolTurn = (turn: typeof first) => turn.runs.at(-1)?.status === "completed" && turn.items.some((item: any) => item.type === "file_change") && turn.items.some((item: any) => item.type === "command_execution");
  check("a pi turn with tools ran on the Anthropic Messages endpoint's model through the relay", toolTurn(first), first.items);
  // Each request was answered `accept` by `cliTurn`; t3's projection keeps no decision for pi's, only that it resolved.
  check("its tool requests were asked, and resolved by the accept sent", first.requests.length > 0 && first.requests.every((request: any) => request.status === "resolved"), first.requests);

  // pi's models.json and settings in the Container: one provider per endpoint at the relay, the handle command, no key.
  const files = await exec(A, "for d in /var/lib/t3flare/cli/proc-*; do [ -f $d/agent/models.json ] && { cat $d/agent/models.json; echo; echo '#settings'; cat $d/agent/settings.json; break; }; done");
  const [modelsText, settingsText] = String(files.stdout ?? "").split("#settings");
  const models = JSON.parse(modelsText?.trim() || "{}") as any;
  const providers = Object.fromEntries(Object.entries(models.providers ?? {}).map(([id, provider]: [string, any]) => [id, { api: provider.api, baseUrl: provider.baseUrl, apiKey: provider.apiKey, models: (provider.models ?? []).map((model: any) => `${model.id}@${model.baseUrl}`) }]));
  report.modelsJson = clean({ providers, settings: JSON.parse(settingsText?.trim() || "{}") });
  const relayUrl = (id: string) => `http://computer.internal/t3flare/model/${id}`;
  check(
    "pi's providers: one per endpoint, its API, at the relay's per-endpoint URL, the handle command as its key",
    JSON.stringify(providers) ===
      JSON.stringify({
        "t3flare-endpoint-comm": { api: "anthropic-messages", baseUrl: relayUrl("comm"), apiKey: "!/opt/t3flare/bin/t3flare-pi-handle", models: [`${MODEL}@${relayUrl("comm")}`] },
        "t3flare-endpoint-oai": { api: "openai-completions", baseUrl: relayUrl("oai"), apiKey: "!/opt/t3flare/bin/t3flare-pi-handle", models: [`${MODEL}@${relayUrl("oai")}`] },
        "t3flare-endpoint-resp": { api: "openai-responses", baseUrl: relayUrl("resp"), apiKey: "!/opt/t3flare/bin/t3flare-pi-handle", models: [`${MODEL}@${relayUrl("resp")}`] },
      }),
    report.modelsJson,
  );

  // 4. The same thread on the OpenAI endpoints: a tool turn on Chat Completions, then Responses.
  const native = (turn: typeof first) => turn.providerThreads.map((thread: any) => thread.nativeThreadRef?.nativeId ?? null);
  const openai = await cliTurn(cookie, { cli: "pi", workspace: A, model: SLUGS.oai, mode: "approval-required", plan: false, prompt: "In src/greeting.txt add another last line `Hello again.` with your file edit tool (not the shell), then run `bash test.sh` and tell me in one sentence whether it passed.", threadId: first.threadId });
  report.openaiTurn = clean(openai);
  check("a pi turn with tools ran on the OpenAI (Chat Completions) endpoint's model, in the same thread", toolTurn(openai), openai.items);
  const responses = await cliTurn(cookie, { cli: "pi", workspace: A, model: SLUGS.resp, mode: "approval-required", plan: false, prompt: "In src/greeting.txt add another last line `Hello once more.` with your file edit tool (not the shell), then run `bash test.sh`, and reply with the code word only.", threadId: first.threadId });
  report.switch = clean({ toResponses: { runs: responses.runs.slice(-1), items: responses.items, text: responses.text, native: native(responses) }, openai: native(openai), first: native(first) });
  check("a model switch to the Responses endpoint's model: a turn with tools that knows the code word", toolTurn(responses) && responses.text.includes("KESTREL-41"), report.switch);
  check("the same native pi session throughout (no handoff)", native(first).length === 1 && JSON.stringify(native(first)) === JSON.stringify(native(openai)) && JSON.stringify(native(first)) === JSON.stringify(native(responses)), report.switch);

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
      // Every process whose environment holds a handle, by its command (its first words: pi's argv carries paths).
      `holders=""; for f in /proc/[0-9]*/environ; do if tr '\\0' '\\n' < "$f" 2>/dev/null | grep -q '^T3FLARE_MODEL_HANDLE='; then p=\${f#/proc/}; p=\${p%/environ}; holders="$holders $(tr '\\0' ' ' < /proc/$p/cmdline | cut -d' ' -f1-5)|"; fi; done`,
      `H=$(${HANDLE_OF})`,
      `echo "handle=$H"`,
      `echo "holders=$holders"`,
      // pi's own process, the launch chain's setsid's child (node, which titles itself "pi"), runs without it.
      `pis=0; with=0; for s in $(pgrep -f '^setsid --wait /opt/t3flare/bin/pi '); do for p in $(pgrep -P "$s"); do pis=$((pis+1)); title=$(tr '\\0' ' ' < /proc/$p/cmdline | cut -c1-20); tr '\\0' '\\n' < /proc/$p/environ | grep -q '^T3FLARE_MODEL_HANDLE=' && with=$((with+1)); done; done; echo "piProcesses=$pis"; echo "piTitle=$title"; echo "piWithHandle=$with"`,
      `echo "files=$( [ -n "$H" ] && grep -rlsF "$H" /var/lib/t3flare /root /tmp /workspace 2>/dev/null | wc -l)"`,
      // The handle command outside a pi process's launch chain (here, the admin route's shell) prints nothing.
      `echo "outside=$(T3FLARE_EXEC=$(ls /var/lib/t3flare/cli | head -1) /opt/t3flare/bin/t3flare-pi-handle 2>/dev/null | wc -c)"`,
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
  check(
    "only the launch chain's setsid holds the handle (not pi, not a shell)",
    handle !== undefined && holders.length === 1 && holders[0] === PI_HANDLE_HOLDERS[0] && lines.piWithHandle === "0" && lines.piProcesses === "1",
    report.handle,
  );
  check("no file holds the handle", lines.files === "0", report.handle);
  check("the handle command prints nothing outside a pi process's launch chain", lines.outside === "0", report.handle);
  check("the handle reaches the Anthropic endpoint in x-api-key and the OpenAI endpoint as a Bearer (200)", lines.anthropic === "200" && lines.openai === "200", report.handle);
  check("a forged handle and no handle are refused (401)", lines.forged === "401" && lines.none === "401", report.handle);
  check("an endpoint saved after the process started is refused (403)", lines.unconfigured === "403", report.handle);

  // A pi shell has no handle.
  const shell = await cliTurn(cookie, { cli: "pi", workspace: A, model: SLUGS.comm, mode: "full-access", plan: false, prompt: "Run exactly this shell command with your bash tool: `env > /tmp/p1170-shell-env.txt` and then reply with the single word done.", threadId: first.threadId });
  const shellEnv = await exec(A, "echo handle=$(grep -c '^T3FLARE_MODEL_HANDLE=' /tmp/p1170-shell-env.txt); echo exec=$(grep -c '^T3FLARE_EXEC=' /tmp/p1170-shell-env.txt); rm -f /tmp/p1170-shell-env.txt");
  report.shellEnv = { runs: shell.runs.slice(-1), counts: String(shellEnv.stdout ?? "").trim() };
  check("a pi shell's environment has no model handle (its marker shows it was the process's)", String(shellEnv.stdout ?? "").includes("handle=0") && String(shellEnv.stdout ?? "").includes("exec=1"), report.shellEnv);

  // 6. The leak scan, with the thread's process alive; then the positive control.
  const scan = await leak(A);
  report.leak = clean(scan);
  check("the leak scan finds no endpoint key and scanned every key (DO files, Container files, process environments and command lines)", (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0 && (scan?.container?.files ?? 0) > 0 && Array.isArray(scan?.notScanned) && scan.notScanned.length === 0, scan);
  await exec(A, `printf %s '${canaryKey}' > /tmp/p1170-canary.txt`);
  const planted = await leak(A);
  await exec(A, "rm -f /tmp/p1170-canary.txt");
  const plantedHits = (planted?.container?.hits ?? []) as Array<{ name: string; path: string }>;
  report.leakControl = clean({ hits: plantedHits });
  check("the leak scan finds an endpoint key planted in the Container", plantedHits.some((hit) => hit.name === "endpoint:canary" && hit.path === "/tmp/p1170-canary.txt"), report.leakControl);
  check("the canary endpoint removed", (await api("POST", "endpoints", { op: "remove", id: "canary" })).status === 200);

  // 7. Resume after a Container restart: a new process, a new handle, the same native session.
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${A}`);
  let container: any = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    container = (await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces?.find((ws: any) => ws.id === A)?.container ?? null;
    if (container?.running === false) break;
  }
  check("the Container stopped", container?.running === false, container);
  await admin("GET", "/_t3flare/agents/router-trace?clear=1");
  const resumed = await cliTurn(cookie, { cli: "pi", workspace: A, model: SLUGS.comm, mode: "approval-required", plan: false, prompt: "What was the code word? Reply with it only.", threadId: first.threadId });
  report.resume = clean({ runs: resumed.runs.slice(-1), text: resumed.text, native: native(resumed) });
  check("the next turn completed after the restart and knew the code word", resumed.runs.at(-1)?.status === "completed" && resumed.text.includes("KESTREL-41"), report.resume);
  check("the same native pi session (resumed, not a handoff)", JSON.stringify(native(first)) === JSON.stringify(native(resumed)), { first: native(first), resumed: native(resumed) });
  const trace = ((await admin("GET", "/_t3flare/agents/router-trace")).json?.entries ?? []) as Array<any>;
  report.resumeTrace = trace.filter((entry: any) => entry.route === "protocol").slice(-5);
  check("the protocol log shows pi switched to that session file", trace.some((entry: any) => entry.route === "protocol" && String(entry.detail ?? "").includes(String(native(first)[0]))), report.resumeTrace);
  const code = (handleExpr: string) => anthropicPost("comm", handleExpr);
  const revoked = handle === undefined ? {} : await exec(A, `N=$(${HANDLE_OF}); echo "revoked=$(${code(handle)})"; echo "fresh=$(${code("$N")})"; echo "changed=$([ -n "$N" ] && [ "$N" != "${handle}" ] && echo 1 || echo 0)"`);
  report.revoked = { output: String(revoked.stdout ?? "").trim() };
  check("the new process has a new handle; the first process's is refused (401), the new one passes (200)", String(revoked.stdout ?? "").includes("revoked=401") && String(revoked.stdout ?? "").includes("fresh=200") && String(revoked.stdout ?? "").includes("changed=1"), report.revoked);
});

// 8. The agents Worker's log.
const relayLogs = workerLogs(raw, "model-relay");
const keyLogs = workerLogs(raw, "model-key");
const piLogs = relayLogs.filter((entry) => entry.cli === "pi");
const byStatus: Record<string, number> = {};
for (const entry of relayLogs) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
const byEndpoint: Record<string, number> = {};
for (const entry of piLogs) byEndpoint[entry.endpoint] = (byEndpoint[entry.endpoint] ?? 0) + 1;
report.relayLog = {
  entries: relayLogs.length,
  byStatus,
  pi: { entries: piLogs.length, byEndpoint, routed: piLogs.some((entry) => entry.routed === true), statuses: [...new Set(piLogs.map((entry) => entry.status))] },
  // What pi sends that the allowlist keeps back (names only).
  piDropped: [...new Set(piLogs.flatMap((entry) => entry.dropped ?? []))].sort((a, b) => String(a).localeCompare(String(b))),
  sample: piLogs.slice(0, 3),
};
report.keyHelper = { entries: keyLogs.length, pi: keyLogs.filter((entry) => JSON.stringify(entry).includes('"pi"')).length };
check("pi's requests went to each endpoint's own path (comm, oai, resp), none model-routed, every one 200", ["comm", "oai", "resp"].every((id) => (byEndpoint[id] ?? 0) > 0) && piLogs.every((entry) => entry.status === 200 && entry.routed !== true), report.relayLog);
check("pi on the relay never asked the key helper", (report.keyHelper as any).pi === 0, report.keyHelper);
check("no handle or key in the agents Worker's log", !leaks(raw));
finish();
