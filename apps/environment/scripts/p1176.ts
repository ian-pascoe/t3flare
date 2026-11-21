// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// SPI-1176's evidence on its stage: the hard cut. t3flare knows no Model proxy: a fresh Environment needs setup until the
// owner adds a Model endpoint, then every agent kind runs a turn, and a selection from before the cut falls back.
//
//   node scripts/stage.ts deploy p1176
//   node scripts/stage.ts run p1176 p1176 [--out ../../.evidence/spi-1176/p1176.json]
//
// 1. The setup state: every endpoint is removed (the deploy sets one up when dev.env has T3FLARE_MODEL_ENDPOINT). Every
//    agent's provider (Pi Durable, Codex, Claude Code, OpenCode, pi) is `warning` with no model, its message pointing
//    to the Settings page; a Pi Durable turn fails saying to set an endpoint up; each CLI's spawn is refused, saying
//    which endpoint it needs.
// 2. The owner's setup step, through the panel's API as the owner's form saves it: two API-key endpoints at the owner's
//    Commissary, an ordinary endpoint now (`comm`, Anthropic Messages; `resp`, OpenAI Responses at its `/v1`). Every
//    provider is then ready, and text generation's setting names their small model.
// 3. A turn with tools (approval-required, every request accepted: an edit and a test run) per agent kind: Pi Durable
//    (the acceptance test's real turn, with t3's commit action) and pi, Claude Code and OpenCode on `comm`, Codex on
//    `resp`.
// 4. Old selections fall back to the default model: Pi Durable's real turn on `anthropic/claude-haiku-5-5`, and a turn
//    on each CLI's proxy-era model (Codex's bare `gpt-6-luna`, pi's `anthropic/claude-haiku-5-5`, Claude Code's and
//    OpenCode's `anthropic/claude-sonnet-5-5`).
// 5. The leak scan in each CLI's Container, its processes alive; both Workers' logs hold no key and no handle.
//
// The endpoints' key is the owner's Commissary key, read from the shell or ~/.config/t3flare/dev.env under its names
// from before the cut (MODEL_PROXY_URL, MODEL_PROXY_API_KEY: this script's input only, bound to no Worker). It goes into
// the save requests and nowhere else; every answer kept is scanned for it first.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { cliTurn as acpTurn, EDIT_AND_TEST, enable as enableAcp } from "./lib/acpTurn.ts";
import { admin, createProjectAndThread, enablePiDurable, itemsOf, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, textGenerationSetting, threadWindow, wsCall } from "./lib/client.ts";
import { cliTurn, enable } from "./lib/cliTurn.ts";
import { realTurn } from "./lib/realTurn.ts";
import { leakCheck as leak, linesOf, panelApi as api, relayEvidence, workerLogs, workspaceExec as exec } from "./lib/relayEvidence.ts";
import { tailing } from "./lib/tail.ts";

/** The owner's Commissary URL and key: the shell's, else dev.env's (read here, never printed). */
const commissary = (): { readonly url: string; readonly key: string } => {
  const names = ["MODEL_PROXY_URL", "MODEL_PROXY_API_KEY"];
  const fromEnv = Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
  const file = path.join(process.env.HOME ?? "", ".config/t3flare/dev.env");
  let fromFile: Record<string, string> = {};
  if (names.some((name) => fromEnv[name] === undefined) && fs.existsSync(file)) {
    const script = `set -a; . "$1"; set +a; node -e 'process.stdout.write(JSON.stringify(Object.fromEntries(process.argv.slice(1).map((n) => [n, process.env[n] ?? ""]))))' ${names.join(" ")}`;
    const read = spawnSync("bash", ["-c", script, "-", file], { encoding: "utf8" });
    if (read.status === 0) fromFile = JSON.parse(read.stdout) as Record<string, string>;
  }
  const all = { ...fromFile, ...fromEnv };
  return { url: (all.MODEL_PROXY_URL ?? "").replace(/\/+$/, ""), key: all.MODEL_PROXY_API_KEY ?? "" };
};

const { url: COMMISSARY_URL, key: KEY } = commissary();
const { stage, report, handles, clean, check, leaks, fail, finish } = relayEvidence([KEY]);
if (COMMISSARY_URL === "" || KEY === "") {
  fail("the run needs the owner's Commissary URL and key (MODEL_PROXY_URL and MODEL_PROXY_API_KEY in the shell or dev.env)");
  finish();
}

const MODEL = "claude-haiku-5-5";
const DRIVERS = ["piDurable", "codex", "claudeAgent", "opencode", "pi"] as const;
/** What each provider's snapshot says: its status, its message, how many models. */
const providers = async (cookie: string) => {
  const config = (await wsCall(cookie, "server.getConfig", {})) as { providers?: Array<{ driver: string; status: string; message?: string; models?: Array<{ slug: string }> }> };
  return Object.fromEntries(
    DRIVERS.map((driver) => {
      const provider = (config.providers ?? []).find((entry) => entry.driver === driver);
      return [driver, provider === undefined ? null : { status: provider.status, message: provider.message ?? null, models: (provider.models ?? []).map((model) => model.slug) }];
    }),
  ) as Record<(typeof DRIVERS)[number], { status: string; message: string | null; models: Array<string> } | null>;
};
/** Waits (bounded) until every provider's snapshot has caught up with an endpoint change. */
const settledProviders = async (cookie: string, ready: boolean) => {
  let seen = await providers(cookie);
  for (let i = 0; i < 20 && !Object.values(seen).every((entry) => entry !== null && (entry.status === "ready") === ready); i++) {
    await sleep(1500);
    seen = await providers(cookie);
  }
  return seen;
};

const runId = Date.now().toString(36);
const all = await tailing([`t3flare-agents-${stage}`, `t3flare-environment-${stage}`], async () => {
  const cookie = await pair();
  await admin("POST", "/_t3flare/disarm-bootstrap");
  await enablePiDurable(cookie);
  await enable(cookie, "codex", "codex");
  await enable(cookie, "pi", "pi");
  await enableAcp(cookie, "claude");
  await enableAcp(cookie, "opencode");

  // 1. The setup state.
  const before = ((await api("GET", "endpoints")).json?.endpoints ?? []) as Array<{ id: string }>;
  for (const { id } of before) await api("POST", "endpoints", { op: "remove", id });
  report.removedEndpoints = before.map((endpoint) => endpoint.id);
  const setup = await settledProviders(cookie, false);
  report.setupState = setup;
  for (const driver of DRIVERS) {
    const entry = setup[driver];
    check(`${driver} needs setup with no endpoint: warning, no model, pointing to the Settings page`, entry?.status === "warning" && entry.models.length === 0 && /Settings page \(\/_t3flare\/settings\), under Model endpoints/.test(entry.message ?? ""), entry);
  }
  // A Pi Durable turn with no endpoint.
  const durable = await createProjectAndThread(cookie, { title: "setup state", workspaceRoot: `/w/p1176-setup-durable-${runId}` });
  await sendMessage(cookie, durable.threadId, "Reply with the word ok.");
  let durableProjection: any;
  for (let i = 0; i < 60; i++) {
    durableProjection = projectionOf(await threadWindow(cookie, durable.threadId));
    if (runsOf(durableProjection).length > 0 && runsOf(durableProjection).every((run) => SETTLED.has(run.status))) break;
    await sleep(1500);
  }
  const durableFailures = itemsOf(durableProjection).filter((item: any) => item.type === "error").map((item: any) => ({ code: item.failure?.code ?? null, message: String(item.failure?.message ?? "") }));
  report.setupDurableTurn = clean({ runs: runsOf(durableProjection).map((run) => run.status), failures: durableFailures });
  check("a Pi Durable turn with no endpoint fails, saying to set one up on the Settings page", runsOf(durableProjection).at(-1)?.status === "failed" && durableFailures.some((entry) => /No Model endpoint is set up: add one on the Settings page/.test(entry.message)), report.setupDurableTurn);
  // Each CLI's spawn, refused with what it needs.
  const setupWorkspace = `p1176-setup-${runId}`;
  const refusals: Record<string, unknown> = {};
  const NEEDS: Record<string, RegExp> = {
    codex: /Codex has no Model endpoint to run on: it needs one that speaks OpenAI Responses/,
    pi: /Pi has no Model endpoint to run on: it needs one that lists a model/,
    claude: /Claude Code has no Model endpoint to run on: it needs one that speaks Anthropic Messages/,
    opencode: /OpenCode has no Model endpoint to run on/,
  };
  for (const cli of ["codex", "pi", "claude", "opencode"] as const) {
    // One Workspace per CLI: the two turn helpers keep their own project lists, so they never share a Workspace.
    const turn = cli === "codex" || cli === "pi" ? await cliTurn(cookie, { cli, workspace: `${setupWorkspace}-${cli}`, mode: "approval-required", plan: false, prompt: "Reply with the word ok." }) : await acpTurn(cookie, { cli, workspace: `${setupWorkspace}-${cli}`, mode: "approval-required", plan: false, prompt: "Reply with the word ok." });
    // The error items' failure text as t3 keeps it (the helpers' item summaries cut it short).
    const errors = itemsOf(projectionOf(await threadWindow(cookie, turn.threadId))).filter((item: any) => item.type === "error").map((item: any) => ({ title: item.title ?? null, message: String(item.failure?.message ?? "") }));
    const text = JSON.stringify({ runs: turn.runs, errors });
    refusals[cli] = clean({ runs: turn.runs.map((run) => run.status), said: NEEDS[cli]!.exec(text)?.[0] ?? null, errors });
    check(`a ${cli} spawn with no endpoint for its API is refused, saying which it needs`, turn.runs.at(-1)?.status === "failed" && NEEDS[cli]!.test(text), refusals[cli]);
  }
  report.setupSpawns = refusals;

  // 2. The owner's setup step.
  const saves = {
    comm: (await api("POST", "endpoints", { op: "save", endpoint: { id: "comm", label: "Commissary", api: "anthropic-messages", baseUrl: COMMISSARY_URL, auth: "api-key", headers: {}, models: [MODEL] }, apiKey: KEY })).status,
    resp: (await api("POST", "endpoints", { op: "save", endpoint: { id: "resp", label: "Commissary (Responses)", api: "openai-responses", baseUrl: `${COMMISSARY_URL}/v1`, auth: "api-key", headers: {}, models: [MODEL] }, apiKey: KEY })).status,
  };
  report.saves = saves;
  check("two API-key endpoints saved through the panel's API", saves.comm === 200 && saves.resp === 200, saves);
  const ready = await settledProviders(cookie, true);
  report.afterSetup = ready;
  for (const driver of DRIVERS) check(`${driver} is ready once an endpoint for it is set up`, ready[driver]?.status === "ready" && (ready[driver]?.models.length ?? 0) > 0, ready[driver]);
  check("Codex lists only the Responses endpoint's model, the others the Anthropic one's", ready.codex?.models.join() === `resp/${MODEL}` && ready.claudeAgent?.models.join() === `comm/${MODEL}`, ready);
  await sleep(2000);
  report.textGeneration = await textGenerationSetting(cookie);
  check("text generation's setting names the endpoints' small model", (report.textGeneration as { model?: string } | null)?.model === `comm/${MODEL}`, report.textGeneration);

  // 3. A turn with tools per agent kind.
  const durableTurn = await realTurn(cookie, { push: false, model: `comm/${MODEL}` });
  report.durableTurn = clean(durableTurn);
  check("a Pi Durable turn with tools on the endpoint: the edit and the test run approved, the checkpoint and t3's commit", durableTurn.ok, durableTurn.failures);
  const turns: Record<string, unknown> = {};
  const workspaces: Record<string, string> = {};
  const toolTurn = (turn: { runs: Array<any>; items: Array<any> }) => turn.runs.at(-1)?.status === "completed" && turn.items.some((item: any) => item.type === "file_change") && turn.items.some((item: any) => item.type === "command_execution");
  const turnOf = (cli: string, options: { workspace: string; model?: string; prompt: string }) =>
    cli === "codex" || cli === "pi" ? cliTurn(cookie, { cli, mode: "approval-required", plan: false, ...options }) : acpTurn(cookie, { cli, mode: "approval-required", plan: false, ...options });
  for (const { cli, model } of [
    { cli: "codex", model: `resp/${MODEL}` },
    { cli: "claude", model: `comm/${MODEL}` },
    { cli: "opencode", model: `comm/${MODEL}` },
    { cli: "pi", model: `comm/${MODEL}` },
  ]) {
    const workspace = `p1176-${cli}-${runId}`;
    workspaces[cli] = workspace;
    // Codex has no edit tool of its own name (it patches): SPI-1167's wording for it.
    const line = cli === "codex" ? "Hello through the relay." : "Hello from the CLI.";
    const prompt = cli === "codex" ? `In src/greeting.txt add a new last line \`${line}\` (edit the file), then run \`bash test.sh\` and tell me in one sentence whether it passed.` : EDIT_AND_TEST;
    const turn = await turnOf(cli, { workspace, model, prompt });
    const repo = linesOf((await exec(workspace, `echo "edited=$(grep -cF '${line}' /workspace/repo/src/greeting.txt 2>/dev/null || echo 0)"`)).stdout);
    turns[cli] = clean({ model, runs: turn.runs.slice(-1), items: turn.items, text: turn.text, requests: turn.requests, edited: repo.edited ?? null });
    check(
      `a ${cli} turn with tools on ${model} through the relay: the file edited, the test run`,
      toolTurn(turn) || (turn.runs.at(-1)?.status === "completed" && repo.edited === "1" && turn.requests.length > 0 && /pass/i.test(turn.text)),
      turns[cli],
    );
  }
  report.turns = turns;

  // 4. Old selections.
  const oldDurable = await realTurn(cookie, { push: false });
  report.oldDurable = clean({ model: oldDurable.model, ok: oldDurable.ok, failures: oldDurable.failures, turn: oldDurable.turn ?? null });
  check("a Pi Durable turn on anthropic/claude-haiku-5-5 (a proxy-era selection) runs on the default model", oldDurable.ok, report.oldDurable);
  const old: Record<string, unknown> = {};
  const scanned: Record<string, any> = {};
  for (const cli of ["codex", "pi", "claude", "opencode"]) {
    // Each CLI's proxy-era model, named explicitly (the helpers name an endpoint model when given none).
    const proxyEra: Record<string, string> = { codex: "gpt-6-luna", pi: "anthropic/claude-haiku-5-5", claude: "anthropic/claude-sonnet-5-5", opencode: "anthropic/claude-sonnet-5-5" };
    const turn = await turnOf(cli, { workspace: workspaces[cli]!, model: proxyEra[cli]!, prompt: "Run `cat src/greeting.txt` with your shell tool, then reply with the single word done." });
    old[cli] = clean({ model: turn.model, runs: turn.runs.slice(-1), items: turn.items, text: turn.text });
    check(`a ${cli} thread on its proxy-era model (${turn.model}) runs on the default model`, turn.runs.at(-1)?.status === "completed" && /done/i.test(turn.text), old[cli]);
    // 5. The leak scan, right after the CLI's last turn, its processes alive (a Container idle for minutes may sleep:
    // its scan then answers no Container; once more).
    let scan = await leak(workspaces[cli]!);
    if (scan?.container == null) scan = await leak(workspaces[cli]!);
    scanned[cli] = scan;
  }
  report.oldSelections = old;

  const scans: Record<string, unknown> = {};
  for (const [cli, scan] of Object.entries(scanned)) {
    scans[cli] = clean({ do: scan?.do ?? null, hits: scan?.container?.hits ?? null, files: scan?.container?.files ?? null, notScanned: scan?.notScanned ?? null, lookedFor: scan?.lookedFor ?? null });
    check(`the leak scan in ${cli}'s Container finds no key and scanned every one`, (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0 && (scan?.container?.files ?? 0) > 0 && Array.isArray(scan?.notScanned) && scan.notScanned.length === 0 && (scan?.lookedFor ?? []).includes("endpoint:comm"), scan);
  }
  report.leak = scans;
  // No Container holds the retired key route or a nonce: the route is gone, and no process has a nonce.
  const pi = linesOf((await exec(workspaces.pi!, "echo route=$(curl -s -o /dev/null -w '%{http_code}' http://computer.internal/t3flare/model-key?cli=pi); echo nonces=$(grep -lz '^T3FLARE_MODEL_KEY_NONCE=' /proc/[0-9]*/environ 2>/dev/null | wc -l)")).stdout);
  report.retired = pi;
  check("the retired key route gives nothing, and no process holds a nonce", pi.route !== "200" && pi.nonces === "0", pi);
});

// The logs.
const relayLogs = workerLogs(all.text, "model-relay");
report.relayLog = {
  entries: relayLogs.length,
  byCli: Object.fromEntries(["codex", "claude", "opencode", "pi"].map((cli) => [cli, [...new Set(relayLogs.filter((entry) => entry.cli === cli).map((entry) => `${entry.endpoint} ${entry.status}`))].sort((a, b) => a.localeCompare(b))])),
};
check("no key and no handle in either Worker's log", !leaks(all.text), { bytes: all.workers });
check("no log names a Model proxy key route grant", !all.text.includes('"t3flare":"model-key"'));
void handles;
finish();
