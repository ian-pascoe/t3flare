// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-1171's evidence on its stage: the subscription sign-ins (ChatGPT, Claude) through the model relay, for every CLI
// agent whose API they speak.
//
//   node scripts/stage.ts deploy p1171
//   node scripts/stage.ts run p1171 p1171 start <kind> <file>     starts a ChatGPT or Claude sign-in through the panel's
//                                                                 route; prints the authorize URL to relay (stderr), and
//                                                                 records its parameters by length only
//   node scripts/stage.ts run p1171 p1171 complete <kind> <file>  completes it with what the owner pasted, from <file>
//                                                                 (0600, deleted after)
//   node scripts/stage.ts run p1171 p1171 status                  the sign-ins and their endpoints, as the panel lists them
//   node scripts/stage.ts run p1171 p1171 run [--out ../../.evidence/spi-1171/p1171.json]
//
// `run`, with the sign-ins the stage has (one not signed in is recorded as unverified):
// 1. The stage's own API-key endpoint is removed, so every CLI's list is the sign-ins' (and the relay's log names them).
// 2. A turn with tools (approval-required, every request accepted: an edit and a test run) per CLI on each subscription
//    it speaks: Codex on ChatGPT; Claude Code on Claude (model-routed); OpenCode and pi on ChatGPT and Claude.
// 3. Mid-thread refresh: in pi's Claude thread, its process still running, the stage's hook marks the Claude token
//    expired; the thread's next turn completes, the broker renewed once (the Environment's log), and the relay's log has
//    the same process's requests with another token's short id after the renewal than before. No CLI restarted.
// 4. The leak scan in each CLI's Container, with its processes alive: no endpoint key, and none of the sign-ins'
//    access or refresh tokens (looked for by value in the DO's files and by hash in the Container), nothing unscanned;
//    a planted canary key is found (the positive control).
// 5. Usage: the relayed sign-in turns are on t3's Usage page from our own records (SPI-1173).
// 6. Sign-out: the Claude sign-in is signed out through the panel; pi's thread's next turn fails with t3's failure
//    naming the sign-in; so does a request at the relay with that process's handle (the CLI's own answer).
// 7. The logs: both Workers' (wrangler tail) and every answer kept hold no token form (`sk-ant-oat`, `sk-ant-ort`,
//    `Bearer `, a JWT's `eyJ`, `gho_`/`ghu_`, `tid=`), and no handle.
//
// No token is ever in an answer the panel gives; no key or handle is printed or kept: every answer kept is scanned first.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

import { defaultTextModel, type ModelEndpoint } from "@t3flare/models/endpoints";

import { cliTurn as acpTurn, EDIT_AND_TEST, enable as enableAcp } from "./lib/acpTurn.ts";
import { admin, itemsOf, pair, projectionOf, sleep, threadWindow, wsCall } from "./lib/client.ts";
import { cliTurn, enable } from "./lib/cliTurn.ts";
import { leakCheck as leak, linesOf, panelApi as api, relayEvidence, workerLogs, workspaceExec as exec } from "./lib/relayEvidence.ts";
import { tailing } from "./lib/tail.ts";

const [step, ...args] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--out");
/** A subscription's token forms (Claude's access and refresh, a bearer, a JWT, GitHub's and Copilot's tokens). */
const TOKEN_FORMS = /sk-ant-o[ar]t|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10}|gh[ou]_[A-Za-z0-9]{8}|tid=[0-9a-f]/;
const KINDS = ["chatgpt", "claude"] as const;
type Kind = (typeof KINDS)[number];
const kindOf = (value: string | undefined): Kind => {
  if (value !== "chatgpt" && value !== "claude") throw new Error("the kind is chatgpt or claude");
  return value;
};

const print = (report: Record<string, unknown>) => {
  const text = JSON.stringify({ at: new Date().toISOString(), step, ...report }, null, 2);
  if (TOKEN_FORMS.test(text)) throw new Error("a token's form reached an answer kept as evidence");
  console.log(text);
};

/** The authorize URL's parameters: fixed ones by value, the attempt's own (state, nonce, challenge, hints) by length. */
const describeAuthorize = (url: string) => {
  const parsed = new URL(url);
  const own = new Set(["state", "nonce", "code_challenge", "login_hint", "ext_agent_host_id"]);
  return { endpoint: `${parsed.origin}${parsed.pathname}`, params: Object.fromEntries([...parsed.searchParams].map(([name, value]) => [name, own.has(name) ? `<${value.length} chars>` : value])) };
};

const listed = async () => (await api("GET", "endpoints")).json as { endpoints?: Array<ModelEndpoint & { signIn?: Record<string, unknown> }>; signIns?: Record<string, Record<string, unknown>> };

if (step === "start") {
  const [kindText, file] = args;
  const kind = kindOf(kindText);
  if (file === undefined) throw new Error("start <kind> <file>");
  const answer = await api("POST", "endpoints/sign-in", { op: "start", id: kind, signIn: kind, label: kind === "chatgpt" ? "ChatGPT" : "Claude", acknowledgedTerms: true });
  const url = typeof answer.json?.authorizeUrl === "string" ? answer.json.authorizeUrl : undefined;
  if (url !== undefined) fs.writeFileSync(file, url, { mode: 0o600 });
  print({ kind, status: answer.status, ok: answer.json?.ok === true, authorize: url === undefined ? answer.json : describeAuthorize(url) });
  if (url !== undefined) console.error(`\nAUTHORIZE ${url}\n`);
} else if (step === "complete") {
  const [kindText, file] = args;
  const kind = kindOf(kindText);
  if (file === undefined) throw new Error("complete <kind> <file>");
  const pasted = fs.readFileSync(file, "utf8").trim();
  fs.rmSync(file);
  const started = Date.now();
  const answer = await api("POST", "endpoints/sign-in", { op: "complete", id: kind, label: kind === "chatgpt" ? "ChatGPT" : "Claude", pasted });
  // The paste's own parts (a code, a state) must be in no answer.
  for (const part of pasted.split(/[#?&=]/)) if (part.length >= 16 && JSON.stringify(answer.json).includes(part)) throw new Error("the paste reached the panel's answer");
  print({ kind, status: answer.status, ms: Date.now() - started, answer: answer.json, pastedShape: { length: pasted.length } });
} else if (step === "status") {
  const endpoints = await listed();
  print({
    endpoints: (endpoints.endpoints ?? []).map((endpoint) => ({ id: endpoint.id, auth: endpoint.auth, api: endpoint.api, models: endpoint.models.map((model) => model.id), signIn: endpoint.signIn ?? null })),
    signIns: endpoints.signIns ?? null,
  });
} else if (step === "abandon") {
  // Owner decision (2026-11-16): no live sign-in for SPI-1171. A waiting attempt is dropped by a sign-out, never completed.
  for (const kind of KINDS) await api("POST", "endpoints/sign-in", { op: "sign-out", id: kind });
  const after = await listed();
  print({ waiting: Object.fromEntries(KINDS.map((kind) => [kind, after.signIns?.[kind]?.pendingSince ?? null])), endpoints: (after.endpoints ?? []).map((endpoint) => endpoint.id) });
} else if (step === "run") {
  await run();
} else if (step === "control") {
  await control();
} else {
  console.error("usage: p1171 start <kind> <file> | complete <kind> <file> | status | abandon | run [--out file] | control [--out file]");
  process.exit(2);
}

/**
 * `control`: what the stage shows with no subscription signed in (owner decision, 2026-11-16).
 * 1. Every CLI lists exactly the sign-ins the ticket's matrix gives it: two sign-in endpoints saved with no credential
 *    (`sub-chatgpt`, `sub-claude`) beside the stage's API-key endpoints (`commissary`, Anthropic Messages; `resp`, OpenAI
 *    Responses, both Commissary's with the proxy key).
 * 2. A regression control: a turn with tools per CLI through the relay on an API-key endpoint.
 * 3. A sign-in that gives no token: each CLI's turn on its sign-in fails with t3's failure naming the sign-in, and a
 *    request at the relay with the process's handle gets 401 in its API's shape, naming it.
 * 4. The Container leak scan in each CLI's Workspace, its processes alive; a planted canary key is found.
 * 5. Both Workers' logs hold no key, token form or handle.
 */
async function control(): Promise<void> {
  const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
  const proxyKey = process.env.MODEL_PROXY_API_KEY ?? "";
  const canaryKey = `sk-canary-${randomBytes(24).toString("hex")}`;
  const { stage, report, handles, clean, check, leaks, fail, finish } = relayEvidence([proxyKey, canaryKey]);
  if (proxyUrl === "" || proxyKey === "") {
    fail("the stage needs MODEL_PROXY_URL and MODEL_PROXY_API_KEY (dev.env)");
    finish();
  }
  const MODEL = "claude-haiku-5-5";
  const all = await tailing([`t3flare-agents-${stage}`, `t3flare-environment-${stage}`], async () => {
    const cookie = await pair();
    await admin("POST", "/_t3flare/disarm-bootstrap");

    // 1. The endpoints, saved before any CLI process starts (a handle's scope is its process's start).
    const saves = {
      resp: (await api("POST", "endpoints", { op: "save", endpoint: { id: "resp", label: "Commissary (Responses)", api: "openai-responses", baseUrl: `${proxyUrl}/v1`, auth: "api-key", headers: {}, models: [MODEL] }, apiKey: proxyKey })).status,
      "sub-chatgpt": await api("POST", "endpoints", { op: "save", endpoint: { id: "sub-chatgpt", label: "ChatGPT", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "chatgpt", headers: {}, models: ["gpt-6.1-sol"] } }),
      "sub-claude": await api("POST", "endpoints", { op: "save", endpoint: { id: "sub-claude", label: "Claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "claude", headers: {}, models: [MODEL] } }),
    };
    report.saves = clean({ resp: saves.resp, "sub-chatgpt": saves["sub-chatgpt"].status, "sub-claude": saves["sub-claude"].status });
    check("the API-key Responses endpoint and two sign-in endpoints with no credential saved", saves.resp === 200 && saves["sub-chatgpt"].status === 200 && saves["sub-claude"].status === 200, { ...(report.saves as object), errors: [saves["sub-chatgpt"].json, saves["sub-claude"].json] });
    const endpoints = (await listed()).endpoints ?? [];
    report.endpoints = endpoints.map((endpoint) => ({ id: endpoint.id, auth: endpoint.auth, api: endpoint.api, signedIn: endpoint.signIn?.signedIn ?? null }));
    const SIGN_IN_MODEL = { chatgpt: "sub-chatgpt/gpt-6.1-sol", claude: `sub-claude/${MODEL}` } as const;

    // The lists: the ticket's matrix.
    await enable(cookie, "codex", "codex");
    await enable(cookie, "pi", "pi");
    await enableAcp(cookie, "claude");
    await enableAcp(cookie, "opencode");
    await sleep(3000);
    const config = (await wsCall(cookie, "server.getConfig", {})) as any;
    const lists = Object.fromEntries(
      ["codex", "claudeAgent", "opencode", "pi"].map((driver) => [driver, ((config?.providers ?? []) as Array<any>).find((provider) => provider.driver === driver)?.models?.map((model: any) => String(model.slug)) ?? []]),
    ) as Record<string, Array<string>>;
    report.lists = Object.fromEntries(Object.entries(lists).map(([driver, slugs]) => [driver, slugs.filter((slug) => !slug.startsWith("commissary/"))]));
    const has = (driver: string, slug: string) => lists[driver]!.includes(slug);
    check("Codex lists the ChatGPT sign-in, not the Claude one", has("codex", SIGN_IN_MODEL.chatgpt) && !has("codex", SIGN_IN_MODEL.claude), report.lists);
    check("Claude Code lists the Claude sign-in, not the ChatGPT one", has("claudeAgent", SIGN_IN_MODEL.claude) && !has("claudeAgent", SIGN_IN_MODEL.chatgpt), report.lists);
    check("OpenCode lists both sign-ins", has("opencode", SIGN_IN_MODEL.claude) && has("opencode", SIGN_IN_MODEL.chatgpt), report.lists);
    check("pi lists both sign-ins", has("pi", SIGN_IN_MODEL.claude) && has("pi", SIGN_IN_MODEL.chatgpt), report.lists);

    // 2 and 3: per CLI, a tool turn on an API-key endpoint, then a new thread on its sign-in.
    const run = Date.now().toString(36);
    const toolTurn = (turn: { runs: Array<any>; items: Array<any> }) => turn.runs.at(-1)?.status === "completed" && turn.items.some((item: any) => item.type === "file_change") && turn.items.some((item: any) => item.type === "command_execution");
    const CLIS = [
      { cli: "codex", control: `resp/${MODEL}`, signIn: "chatgpt" },
      { cli: "claude", control: `commissary/${MODEL}`, signIn: "claude" },
      { cli: "opencode", control: `commissary/${MODEL}`, signIn: "claude" },
      { cli: "pi", control: `commissary/${MODEL}`, signIn: "claude" },
    ] as const;
    const turns: Record<string, unknown> = {};
    const scans: Record<string, unknown> = {};
    const workspaces: Record<string, string> = {};
    const turnOf = (cli: string, options: { workspace: string; model: string; mode: string; plan: boolean; prompt: string }) => (cli === "codex" || cli === "pi" ? cliTurn(cookie, { cli, ...options }) : acpTurn(cookie, { cli, ...options }));
    for (const { cli, control: model, signIn } of CLIS) {
      const workspace = `ctl-${cli}-${run}`;
      workspaces[cli] = workspace;
      // Codex has no edit tool of its own name (it patches): SPI-1167's wording for it.
      const prompt = cli === "codex" ? "In src/greeting.txt add a new last line `Hello through the relay.` (edit the file), then run `bash test.sh` and tell me in one sentence whether it passed." : EDIT_AND_TEST;
      const turn = await turnOf(cli, { workspace, model, mode: "approval-required", plan: false, prompt });
      // What the turn left in the repo: its edit is there, whatever the projection's items show (t3's Codex items showed no
      // file change or test run on p1171 while the file and the answer had both).
      const line = cli === "codex" ? "Hello through the relay." : "Hello from the CLI.";
      const repo = linesOf((await exec(workspace, `echo "edited=$(grep -cF '${line}' /workspace/repo/src/greeting.txt 2>/dev/null || echo 0)"`)).stdout);
      turns[`${cli} control`] = clean({ model, runs: turn.runs.slice(-1), items: turn.items, text: turn.text, edited: repo.edited ?? null });
      check(
        `a ${cli} turn with tools ran through the relay on an API-key endpoint (${model}): the file edited, the test run`,
        toolTurn(turn) || (turn.runs.at(-1)?.status === "completed" && repo.edited === "1" && turn.requests.length > 0 && /passed/i.test(turn.text)),
        turns[`${cli} control`],
      );
      const title = signIn === "chatgpt" ? "ChatGPT" : "Claude";
      const refused = await turnOf(cli, { workspace, model: SIGN_IN_MODEL[signIn], mode: "approval-required", plan: false, prompt: "Reply with the word ok." });
      // t3's failure as its error item carries it (the turn's own failure item).
      const failures = itemsOf(projectionOf(await threadWindow(cookie, refused.threadId)))
        .filter((item: any) => item.type === "error")
        .map((item: any) => ({ class: item.failure?.class ?? null, code: item.failure?.code ?? null, message: String(item.failure?.message ?? "") }));
      turns[`${cli} ${signIn} sign-in`] = clean({ model: SIGN_IN_MODEL[signIn], runs: refused.runs.slice(-1).map((entry) => ({ status: entry.status })), failures });
      const named = refused.runs.at(-1)?.status === "failed" && failures.some((entry) => entry.code === "sign_in_refused" && entry.message.includes(`not signed in to ${title}`));
      if (cli === "claude") {
        // SPI-1172's E1: Claude Code fails before any turn when its session cannot open, with t3's own failure, which the
        // CLI wrapper has no failed turn to map. Recorded, not checked.
        report.claudeCodeOnSignIn = { failedBeforeTurn: refused.runs.at(-1)?.status === "failed", named };
      } else {
        check(`a ${cli} turn on the ${title} sign-in with no credential fails with t3's failure naming the sign-in`, named, turns[`${cli} ${signIn} sign-in`]);
      }
      // The leak scan in this CLI's Container, its processes alive (the Container sleeps once idle).
      const scan = await leak(workspace);
      scans[workspace] = clean({ do: scan?.do ?? null, hits: scan?.container?.hits ?? null, files: scan?.container?.files ?? null, notScanned: scan?.notScanned ?? null, lookedFor: scan?.lookedFor ?? null });
      check(`the leak scan in ${cli}'s Container finds no key and scanned every one`, (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0 && (scan?.container?.files ?? 0) > 0 && Array.isArray(scan?.notScanned) && scan.notScanned.length === 0 && (scan?.lookedFor ?? []).includes("endpoint:resp"), scan);
    }
    report.turns = turns;

    // A request at the relay with pi's handle, on each sign-in, as a CLI makes it.
    const HANDLE_OF = `grep -ahz '^T3FLARE_MODEL_HANDLE=' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | head -1 | cut -d= -f2`;
    const relay = await exec(
      workspaces.pi!,
      [
        `H=$(${HANDLE_OF})`,
        `echo "handle=$H"`,
        `code=$(curl -s -o /tmp/p1171-a.json -w '%{http_code}' -X POST -H "x-api-key: $H" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' --data '{"model":"${MODEL}","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}' http://computer.internal/t3flare/model/sub-claude/v1/messages); echo "claude=$code"`,
        `echo "claudeType=$(grep -o '"type":"authentication_error"' /tmp/p1171-a.json | head -1)"`,
        `echo "claudeNames=$(grep -c 'not signed in to Claude' /tmp/p1171-a.json)"`,
        `code=$(curl -s -o /tmp/p1171-b.json -w '%{http_code}' -X POST -H "authorization: Bearer $H" -H 'content-type: application/json' --data '{"model":"gpt-6.1-sol","input":"hi"}' http://computer.internal/t3flare/model/sub-chatgpt/responses); echo "chatgpt=$code"`,
        `echo "chatgptNames=$(grep -c 'not signed in to ChatGPT' /tmp/p1171-b.json)"`,
        "rm -f /tmp/p1171-a.json /tmp/p1171-b.json",
      ].join("\n"),
    );
    const lines = linesOf(relay.stdout);
    if (/^[0-9a-f]{64}$/.test(lines.handle ?? "")) handles.push(lines.handle!);
    delete lines.handle;
    report.relayRefusal = clean(lines);
    check("a request at the relay on the Claude sign-in gets 401, Anthropic's authentication_error naming the sign-in", lines.claude === "401" && lines.claudeType !== "" && lines.claudeNames === "1", lines);
    check("a request at the relay on the ChatGPT sign-in gets 401 naming the sign-in", lines.chatgpt === "401" && lines.chatgptNames === "1", lines);

    // 4. The leak scans (above, per CLI), then the positive control.
    report.leak = scans;
    const CANARY = { id: "canary", label: "Canary", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "api-key", headers: {}, models: [MODEL] };
    check("the canary endpoint saved", (await api("POST", "endpoints", { op: "save", endpoint: CANARY, apiKey: canaryKey })).status === 200);
    await exec(workspaces.pi!, `printf %s '${canaryKey}' > /tmp/p1171-canary.txt`);
    const planted = await leak(workspaces.pi!);
    await exec(workspaces.pi!, "rm -f /tmp/p1171-canary.txt");
    const hits = (planted?.container?.hits ?? []) as Array<{ name: string; path: string }>;
    report.leakControl = clean({ hits });
    check("the leak scan finds a key planted in the Container (the positive control)", hits.some((hit) => hit.name === "endpoint:canary" && hit.path === "/tmp/p1171-canary.txt"), report.leakControl);
    for (const id of ["canary", "sub-chatgpt", "sub-claude", "resp"]) await api("POST", "endpoints", { op: "remove", id });
  });

  // 5. The logs.
  const relayLogs = workerLogs(all.text, "model-relay");
  const refusals = relayLogs.filter((entry) => typeof entry.signIn === "string");
  report.relayLog = {
    entries: relayLogs.length,
    byCli: Object.fromEntries(["codex", "claude", "opencode", "pi"].map((cli) => [cli, [...new Set(relayLogs.filter((entry) => entry.cli === cli).map((entry) => `${entry.endpoint} ${entry.status}`))].sort((a, b) => a.localeCompare(b))])),
    signInRefusals: refusals.map((entry) => ({ cli: entry.cli, endpoint: entry.endpoint, status: entry.status, signIn: entry.signIn, failure: entry.failure ?? null })),
  };
  check("the relay logged each sign-in's refusal as sign_in_refused", refusals.length > 0 && refusals.every((entry) => entry.status === 401 && entry.failure?.code === "sign_in_refused"), report.relayLog);
  check("no key, token form or handle in either Worker's log", !TOKEN_FORMS.test(all.text) && !leaks(all.text), { bytes: all.workers });
  finish();
}

async function run(): Promise<void> {
  /** The positive control's key: a test endpoint's, planted in the Container for the leak scan to find. */
  const canaryKey = `sk-canary-${randomBytes(24).toString("hex")}`;
  const { stage, report, clean, check, leaks, finish } = relayEvidence([canaryKey]);
  const found = (text: string) => TOKEN_FORMS.test(text) || leaks(text);
  const runStart = Date.now();

  const all = await tailing([`t3flare-agents-${stage}`, `t3flare-environment-${stage}`], async () => {
    const cookie = await pair();
    await admin("POST", "/_t3flare/disarm-bootstrap");

    // 1. Only the sign-ins: the stage's own endpoint (`stage.ts deploy`'s, SPI-1175) is removed.
    const before = await listed();
    const removed = (before.endpoints ?? []).filter((endpoint) => endpoint.auth === "api-key" || endpoint.auth === "none").map((endpoint) => endpoint.id);
    for (const id of removed) await api("POST", "endpoints", { op: "remove", id });
    report.removedEndpoints = removed;
    const endpoints = (await listed()).endpoints ?? [];
    const signedIn = new Set(KINDS.filter((kind) => endpoints.some((endpoint) => endpoint.id === kind && endpoint.auth === kind && endpoint.signIn?.signedIn === true)));
    report.signIns = Object.fromEntries(KINDS.map((kind) => [kind, signedIn.has(kind) ? "signed in" : "unverified: not signed in on the stage"]));
    // Each sign-in's small model (text generation's rule), else its first.
    const modelOf = (kind: Kind): string | undefined => {
      const own = endpoints.filter((endpoint) => endpoint.id === kind);
      return defaultTextModel({ revision: 0, endpoints: own }) ?? (own[0]?.models[0] === undefined ? undefined : `${kind}/${own[0].models[0].id}`);
    };
    const MODELS = Object.fromEntries(KINDS.map((kind) => [kind, modelOf(kind)])) as Record<Kind, string | undefined>;
    report.models = MODELS;
    check("at least one subscription is signed in on the stage", signedIn.size > 0, report.signIns);

    // 2. The matrix: each CLI, a turn with tools on each subscription it speaks.
    await enable(cookie, "codex", "codex");
    await enable(cookie, "pi", "pi");
    await enableAcp(cookie, "claude");
    await enableAcp(cookie, "opencode");
    await sleep(3000);
    const config = (await wsCall(cookie, "server.getConfig", {})) as any;
    const lists = Object.fromEntries(
      ["codex", "claudeAgent", "opencode", "pi"].map((driver) => [driver, ((config?.providers ?? []) as Array<any>).find((provider) => provider.driver === driver)?.models?.map((model: any) => String(model.slug)) ?? []]),
    ) as Record<string, Array<string>>;
    const offered = (driver: string, kind: Kind) => lists[driver]!.some((slug) => slug.startsWith(`${kind}/`));
    report.lists = Object.fromEntries(Object.entries(lists).map(([driver, slugs]) => [driver, Object.fromEntries(KINDS.map((kind) => [kind, slugs.filter((slug) => slug.startsWith(`${kind}/`)).length]))]));
    // The ticket's matrix: Codex ← ChatGPT; Claude Code ← Claude; OpenCode and pi ← both.
    const MATRIX: ReadonlyArray<{ readonly cli: "codex" | "claude" | "opencode" | "pi"; readonly driver: string; readonly kinds: ReadonlyArray<Kind> }> = [
      { cli: "codex", driver: "codex", kinds: ["chatgpt"] },
      { cli: "claude", driver: "claudeAgent", kinds: ["claude"] },
      { cli: "opencode", driver: "opencode", kinds: ["chatgpt", "claude"] },
      { cli: "pi", driver: "pi", kinds: ["chatgpt", "claude"] },
    ];
    for (const { driver, kinds } of MATRIX) {
      for (const kind of KINDS) {
        if (!signedIn.has(kind)) continue;
        const want = kinds.includes(kind);
        check(`${driver} ${want ? "lists" : "does not list"} the ${kind} sign-in's models`, offered(driver, kind) === want, report.lists);
      }
    }
    const run = Date.now().toString(36);
    const toolTurn = (turn: { runs: Array<any>; items: Array<any> }) => turn.runs.at(-1)?.status === "completed" && turn.items.some((item: any) => item.type === "file_change") && turn.items.some((item: any) => item.type === "command_execution");
    const turns: Record<string, unknown> = {};
    const threads: Record<string, { threadId: string; workspace: string }> = {};
    const workspaces = new Set<string>();
    for (const { cli, kinds } of MATRIX) {
      for (const kind of kinds) {
        const model = MODELS[kind];
        const name = `${cli}/${kind}`;
        if (!signedIn.has(kind) || model === undefined) {
          turns[name] = "unverified: the sign-in is not on the stage";
          continue;
        }
        const workspace = `sub-${cli}-${run}`;
        workspaces.add(workspace);
        const options = { workspace, model, mode: "approval-required", plan: false, prompt: `Remember the code word OSPREY-17 for later. ${EDIT_AND_TEST}` };
        const turn = cli === "codex" || cli === "pi" ? await cliTurn(cookie, { cli, ...options }) : await acpTurn(cookie, { cli, ...options });
        // Leave the repo as it was for the next turn in the same Workspace.
        await exec(workspace, "cd /workspace/repo 2>/dev/null && git checkout -- . && git clean -fdq -e .t3flare || true");
        turns[name] = clean({ model, runs: turn.runs.slice(-1), items: turn.items, text: turn.text });
        threads[name] = { threadId: turn.threadId, workspace };
        check(`a ${cli} turn with tools ran on the ${kind} subscription through the relay`, toolTurn(turn), turns[name]);
      }
    }
    report.turns = turns;

    // 3. Mid-thread refresh, in pi's Claude thread (else OpenCode's, else Claude Code's), its process still running.
    const refreshOn = ["pi/claude", "opencode/claude", "claude/claude", "pi/chatgpt", "opencode/chatgpt", "codex/chatgpt"].find((name) => threads[name] !== undefined);
    if (refreshOn !== undefined) {
      const [cli, kind] = refreshOn.split("/") as ["codex" | "claude" | "opencode" | "pi", Kind];
      const { threadId, workspace } = threads[refreshOn]!;
      const statusBefore = (await listed()).signIns?.[kind] ?? {};
      const expired = (await admin("POST", `/_t3flare/check/sign-in-expire?endpoint=${kind}`)).json;
      const options = { workspace, model: MODELS[kind]!, mode: "approval-required", plan: false, threadId, prompt: "What was the code word? Reply with it only." };
      const next = cli === "codex" || cli === "pi" ? await cliTurn(cookie, { cli, ...options }) : await acpTurn(cookie, { cli, ...options });
      const statusAfter = (await listed()).signIns?.[kind] ?? {};
      report.refresh = clean({ on: refreshOn, expired, before: { refreshedAt: statusBefore.refreshedAt ?? null, expiresAt: statusBefore.expiresAt ?? null }, after: { refreshedAt: statusAfter.refreshedAt ?? null, expiresAt: statusAfter.expiresAt ?? null }, runs: next.runs.slice(-1), text: next.text });
      check("the stage's hook marked the sign-in's token expired", (expired as any)?.expired === true, expired);
      check("the thread's next turn completed after the token was renewed, without a new CLI process, and knew the code word", next.runs.at(-1)?.status === "completed" && next.text.includes("OSPREY-17"), report.refresh);
      check("the broker renewed the sign-in (its status's refresh time moved)", typeof statusAfter.refreshedAt === "number" && statusAfter.refreshedAt !== statusBefore.refreshedAt, report.refresh);
    } else {
      report.refresh = "unverified: no sign-in on the stage";
    }

    // 4. The leak scan in each CLI's Container, its processes alive; then the positive control.
    const scans: Record<string, unknown> = {};
    for (const workspace of workspaces) {
      const scan = await leak(workspace);
      const lookedFor = (scan?.lookedFor ?? []) as Array<string>;
      scans[workspace] = clean({ do: scan?.do ?? null, hits: scan?.container?.hits ?? null, files: scan?.container?.files ?? null, notScanned: scan?.notScanned ?? null, lookedFor });
      check(`the leak scan in ${workspace} finds no key or sign-in token, and scanned every one`, (scan?.do ?? []).length === 0 && (scan?.container?.hits ?? []).length === 0 && (scan?.container?.files ?? 0) > 0 && Array.isArray(scan?.notScanned) && scan.notScanned.length === 0, scan);
      check(`the leak scan in ${workspace} looked for each signed-in subscription's access and refresh tokens`, [...signedIn].every((kind) => lookedFor.includes(`sign-in:${kind}:access`) && lookedFor.includes(`sign-in:${kind}:refresh`)), lookedFor);
    }
    report.leak = scans;
    const first = [...workspaces][0];
    if (first !== undefined) {
      const CANARY = { id: "canary", label: "Canary", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "api-key", headers: {}, models: ["claude-haiku-5-5"] };
      check("the canary endpoint saved", (await api("POST", "endpoints", { op: "save", endpoint: CANARY, apiKey: canaryKey })).status === 200);
      await exec(first, `printf %s '${canaryKey}' > /tmp/p1171-canary.txt`);
      const planted = await leak(first);
      await exec(first, "rm -f /tmp/p1171-canary.txt");
      const hits = (planted?.container?.hits ?? []) as Array<{ name: string; path: string }>;
      report.leakControl = clean({ hits });
      check("the leak scan finds a key planted in the Container (the positive control)", hits.some((hit) => hit.name === "endpoint:canary" && hit.path === "/tmp/p1171-canary.txt"), report.leakControl);
      check("the canary endpoint removed", (await api("POST", "endpoints", { op: "remove", id: "canary" })).status === 200);
    }

    // 5. Usage: our records of the relayed sign-in turns, on t3's Usage page.
    await sleep(5000);
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const summary = (await wsCall(cookie, "server.getUsageSummary", { sinceDay: day(-1), untilDay: day(0), timeZone: "UTC", awaitRefresh: true })) as any;
    const ours = ((summary?.buckets ?? []) as Array<any>).filter((bucket) => String(bucket.sourcePath ?? "").startsWith("t3flare://usage/") && KINDS.some((kind) => String(bucket.model ?? "").startsWith(`${kind}/`)));
    const usage = [...new Set(ours.map((bucket) => `${bucket.sourcePath} ${bucket.model}`))].sort();
    report.usage = clean({ since: new Date(runStart).toISOString(), rows: usage });
    for (const name of Object.keys(threads)) {
      const [cli, kind] = name.split("/") as [string, Kind];
      const source = cli === "claude" ? "claude" : cli;
      check(`our usage record of ${name}'s relayed turn is on the Usage page`, usage.some((row) => row.startsWith(`t3flare://usage/${source} ${kind}/`)), report.usage);
    }

    // 6. Sign-out: the next relayed request fails naming the sign-in.
    const signOutOn = ["pi/claude", "opencode/claude", "claude/claude", "pi/chatgpt", "opencode/chatgpt", "codex/chatgpt"].find((name) => threads[name] !== undefined);
    if (signOutOn !== undefined) {
      const [cli, kind] = signOutOn.split("/") as ["codex" | "claude" | "opencode" | "pi", Kind];
      const { threadId, workspace } = threads[signOutOn]!;
      // The thread's process's handle, read before the sign-out, for a request at the relay as the CLI makes it.
      const HANDLE_OF = `grep -ahz '^T3FLARE_MODEL_HANDLE=' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | head -1 | cut -d= -f2`;
      const signOut = await api("POST", "endpoints/sign-in", { op: "sign-out", id: kind });
      const options = { workspace, model: MODELS[kind]!, mode: "approval-required", plan: false, threadId, prompt: "Reply with the word ok." };
      const failed = cli === "codex" || cli === "pi" ? await cliTurn(cookie, { cli, ...options }) : await acpTurn(cookie, { cli, ...options });
      const title = kind === "chatgpt" ? "ChatGPT" : "Claude";
      const failure = failed.runs.at(-1)?.failure as { message?: string; code?: string; class?: string } | null;
      report.signOut = clean({ on: signOutOn, answer: signOut.json, runs: failed.runs.slice(-1), errors: failed.items.filter((item: any) => item.type === "error") });
      check("signed out through the panel", signOut.status === 200 && (signOut.json as any)?.signedOut === true, report.signOut);
      check(`the thread's next turn failed with t3's failure naming the ${title} sign-in`, failed.runs.at(-1)?.status === "failed" && String(failure?.message ?? "").includes(`not signed in to ${title}`), report.signOut);
      const path = kind === "claude" ? `${kind}/v1/messages` : `${kind}/responses`;
      const header = kind === "claude" ? `-H "x-api-key: $H" -H 'anthropic-version: 2023-06-01'` : `-H "authorization: Bearer $H"`;
      const direct = await exec(workspace, `H=$(${HANDLE_OF}); [ -n "$H" ] || { echo "status=nohandle"; exit 0; }; code=$(curl -s -o /tmp/p1171-answer.json -w '%{http_code}' -X POST ${header} -H 'content-type: application/json' --data '{"model":"x","max_tokens":5,"input":"hi","messages":[{"role":"user","content":"hi"}]}' http://computer.internal/t3flare/model/${path}); echo "status=$code"; echo "names=$(grep -c 'not signed in to ${title}' /tmp/p1171-answer.json)"; rm -f /tmp/p1171-answer.json`);
      report.signOutRelay = clean(linesOf(direct.stdout));
      check(`a request at the relay with the process's handle gets 401 naming the ${title} sign-in`, report.signOutRelay !== undefined && (report.signOutRelay as any).status === "401" && (report.signOutRelay as any).names === "1", report.signOutRelay);
    } else {
      report.signOut = "unverified: no sign-in on the stage";
    }
    // Every other sign-in is signed out too, so the stage holds none when it is destroyed.
    for (const kind of signedIn) if (!signOutOn?.endsWith(`/${kind}`)) await api("POST", "endpoints/sign-in", { op: "sign-out", id: kind });
    const after = await listed();
    report.signedOutAll = Object.fromEntries(KINDS.map((kind) => [kind, after.signIns?.[kind]?.signedIn ?? false]));
    check("no sign-in is left signed in", Object.values(report.signedOutAll as Record<string, boolean>).every((value) => value === false), report.signedOutAll);
  });

  // 7. The logs.
  const relayLogs = workerLogs(all.text, "model-relay");
  const signInLogs = relayLogs.filter((entry) => typeof entry.signIn === "string");
  const brokerLogs = workerLogs(all.text, "sign-in");
  const byCli: Record<string, Record<string, number>> = {};
  for (const entry of signInLogs) {
    byCli[entry.cli ?? "?"] ??= {};
    byCli[entry.cli ?? "?"]![`${entry.endpoint} ${entry.status}`] = (byCli[entry.cli ?? "?"]![`${entry.endpoint} ${entry.status}`] ?? 0) + 1;
  }
  const refreshOn = typeof report.refresh === "object" && report.refresh !== null ? String((report.refresh as any).on) : undefined;
  let credentialIds: Array<string> = [];
  if (refreshOn !== undefined) {
    const [cli, kind] = refreshOn.split("/");
    const ofProcess = signInLogs.filter((entry) => entry.cli === cli && entry.endpoint === kind && entry.status === 200);
    const lastHandle = ofProcess.at(-1)?.handle;
    credentialIds = [...new Set(ofProcess.filter((entry) => entry.handle === lastHandle).map((entry) => String(entry.credential)))];
    report.refreshLog = { handle: lastHandle === undefined ? null : "<the process's key>", credentialIds, renewals: brokerLogs.filter((entry) => entry.event === "refresh" && entry.ok === true && entry.endpoint === kind).length, expiredByHook: brokerLogs.filter((entry) => entry.event === "expired-by-hook").length };
    check("one CLI process's relayed requests went with two tokens, before and after the renewal (no restart)", credentialIds.length >= 2, report.refreshLog);
    check("the broker renewed the token once, at the next use after the hook", (report.refreshLog as any).renewals === 1 && (report.refreshLog as any).expiredByHook === 1, report.refreshLog);
  }
  report.relayLog = {
    entries: relayLogs.length,
    signIn: { entries: signInLogs.length, byCli },
    dropped: Object.fromEntries(["codex", "claude", "opencode", "pi"].map((cli) => [cli, [...new Set(signInLogs.filter((entry) => entry.cli === cli).flatMap((entry) => (entry.dropped ?? []) as Array<string>))].sort((a, b) => a.localeCompare(b))])),
    refusals: signInLogs.filter((entry) => entry.status === 401).map((entry) => ({ cli: entry.cli, endpoint: entry.endpoint, failure: entry.failure ?? null })),
  };
  check("no token form or handle in either Worker's log", !found(all.text), { bytes: all.workers });
  finish();
}
