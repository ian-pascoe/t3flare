// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalTimers:off
// SPI-1172's evidence on its stage: a Durable turn on the stage's Model endpoint (`commissary`, Anthropic Messages, an API
// key) whose model answers come from the Session's fault route in the vendors' shapes, classified by the endpoint's API
// and auth.
//
//   node scripts/stage.ts run p1172 p1172 setup     turn Pi Durable on, clone the fixture, open a project on it
//   node scripts/stage.ts run p1172 p1172 limit     Anthropic's unified usage limit (reset in 2 min): "Usage limit reached"
//                                                   with that reset after one request, the idle Environment woken at the
//                                                   reset, and the thread resumed by itself on the same endpoint
//   node scripts/stage.ts run p1172 p1172 key [--tail]
//                                                   a refused key whose error names the endpoint, after one request, no
//                                                   pause; the fault's body echoes made-up credentials, and neither the
//                                                   thread, the Session's state nor (with --tail) either Worker's logs
//                                                   hold one
//   node scripts/stage.ts run p1172 p1172 overload  an overload (529) is retried and ends as a provider error, no pause
//   node scripts/stage.ts run p1172 p1172 cli [--cli pi|codex|claude] [--control]
//                                                   a CLI agent through the model relay on an endpoint whose key is
//                                                   refused (Commissary's own 401): t3's failure is the relay's, naming
//                                                   the endpoint, not what the CLI made of it; the key is in no answer.
//                                                   --control: the same turn on a working key completes
//   … [--model <endpointId>/<modelId>] [--out file.json]
//
// The fixture project is kept in `.alchemy/stages/<host>.p1172.json` (gitignored) between runs.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { cliTurn as acpCliTurn, enable as acpEnable } from "./lib/acpTurn.ts";
import { cliTurn as cli4aTurn, enable as cli4aEnable } from "./lib/cliTurn.ts";
import { admin, base, dispatch, itemsOf, mutateProject, pair, runsOf, sendMessage, SETTLED, sleep, updateSettings, uuid, waitFor, wsCall } from "./lib/client.ts";
import { fixtureRepo } from "./lib/scriptSettings.ts";

/** The made-up credentials the `anthropicKeyRefused` fault echoes (apps/agents/src/session/proxyLimits.ts). */
const ECHOED = [
  "sk-ant-api03-t3flareFAULTechoNotARealKey0000000000000000000000000000000000000000-AAAA",
  "eyJhbGciOiJIUzI1NiJ9.eyJ0M2ZsYXJlIjoiZmF1bHQtZWNobyJ9.dDNmbGFyZS1mYXVsdC1zaWduYXR1cmU",
] as const;

const [step = "limit"] = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && !["--out", "--model"].includes(all[index - 1] ?? ""));
const flag = (name: string) => process.argv.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1]!;
};
const out = flag("out") ? option("out", "") : undefined;
const MODEL = { instanceId: "piDurable", model: option("model", "commissary/claude-haiku-5-5"), options: [{ id: "thinking", value: "low" }] };
const ENDPOINT = MODEL.model.split("/")[0]!;
const report: Record<string, unknown> = { step, at: new Date().toISOString(), model: MODEL.model };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 800)}`);
  return ok;
};
const finish = (): never => {
  report.failures = failures;
  report.ok = failures.length === 0;
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (out) fs.writeFileSync(out, `${text}\n`);
  process.exit(report.ok ? 0 : 1);
};

/** The Session's view of the thread (its turns, each with its model record), as it would push it. */
const session = async (threadId: string) => (await admin("GET", `/_t3flare/agents/session?thread=${threadId}`)).json ?? {};

const fixtureFile = path.resolve(import.meta.dirname, `../.alchemy/stages/${base.host}.p1172.json`);
const fixture = (): { readonly projectId: string } => JSON.parse(fs.readFileSync(fixtureFile, "utf8"));

const cookie = await pair();
await admin("POST", "/_t3flare/disarm-bootstrap");
const stamp = Date.now().toString(36);

const threadOn = async (title: string) => {
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId: fixture().projectId,
    title,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
};

/** `wrangler tail` of both Workers into a 0600 temp file, stopped by the returned function, which gives its text. */
const tail = (): (() => Promise<{ readonly text: string; readonly file: string; readonly events: number }>) => {
  const here = path.resolve(import.meta.dirname, "..");
  const stage = base.hostname.split(".")[0]!.replace(/^t3flare-environment-/, "");
  const profile = process.env.ALCHEMY_PROFILE ?? "default";
  const stored = process.env.CLOUDFLARE_API_TOKEN
    ? { access: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
    : (JSON.parse(fs.readFileSync(path.join(os.homedir(), ".alchemy/profiles", profile, "cloudflare.json"), "utf8")).values as { access: string; accountId?: string });
  const file = path.join(os.tmpdir(), `t3flare-p1172-tail-${Date.now()}.ndjson`);
  const fd = fs.openSync(file, "w", 0o600);
  const procs = [`t3flare-environment-${stage}`, `t3flare-agents-${stage}`].map((worker) =>
    spawn(path.join(here, "node_modules/.bin/wrangler"), ["tail", worker, "--format", "json"], {
      cwd: here,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: stored.access, CLOUDFLARE_ACCOUNT_ID: stored.accountId ?? "" },
      stdio: ["ignore", fd, "ignore"],
    }),
  );
  return async () => {
    await sleep(8000);
    for (const proc of procs) proc.kill("SIGINT");
    await sleep(1000);
    fs.closeSync(fd);
    const text = fs.readFileSync(file, "utf8");
    return { text, file, events: text.split(/\n(?=\{\n)/).filter((chunk) => chunk.trim().startsWith("{")).length };
  };
};

/** Arms a fault, sends one message, and waits for its run to settle: the run, the error item, the Session's turn. */
const failedTurn = async (title: string, fixtureName: string, resetS: number) => {
  const threadId = await threadOn(title);
  const resetAt = Date.now() + resetS * 1000;
  report.fault = (await admin("POST", `/_t3flare/agents/proxy-fault?thread=${threadId}`, { fixture: fixtureName, resetAt })).json;
  await sendMessage(cookie, threadId, "Reply with the single word: pong", MODEL);
  const failed = await waitFor(cookie, threadId, (p) => SETTLED.has(runsOf(p)[0]?.status ?? ""), 300_000);
  const run = runsOf(failed.projection)[0]!;
  const errors = itemsOf(failed.projection).filter((item: any) => item.type === "error");
  const turns = Object.values((await session(threadId)).turns ?? {}) as Array<any>;
  report.threadId = threadId;
  report.first = { run: run.status, failure: errors[0]?.failure ?? errors[0] ?? null, model: turns[0]?.proxy ?? null, detail: turns[0]?.detail ?? null, faultResetAt: new Date(resetAt).toISOString() };
  check("the first run failed", run.status === "failed", run);
  check("one error item in the thread", errors.length === 1, errors);
  return { threadId, resetAt, failure: (errors[0]?.failure ?? {}) as Record<string, any>, turn: turns[0] ?? {}, projection: failed.projection };
};

switch (step) {
  case "setup": {
    await wsCall(cookie, "server.updateSettings", {
      patch: {},
      providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
    });
    const id = `p1172-${stamp}`;
    const destination = `/w/${id}`;
    const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", {
      remoteUrl: `https://github.com/${fixtureRepo()}.git`,
      destinationPath: destination,
    })) as { cwd?: string };
    const projectId = uuid();
    await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: destination, createWorkspaceRootIfMissing: false });
    fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
    fs.writeFileSync(fixtureFile, JSON.stringify({ projectId, workspaceId: id, destination }));
    report.setup = { projectId, workspaceId: id, cloned: cloned.cwd === destination };
    check("cloned", cloned.cwd === destination, cloned);
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "limit": {
    await updateSettings(cookie, { autoResumeLimitedThreads: true });
    const { threadId, resetAt, failure, turn } = await failedTurn(`limit ${stamp}`, "anthropicUsageLimit", Number(option("reset-s", "120")));
    check("one model request", turn.proxy?.requests === 1, turn.proxy);
    check("the Session classified it by the endpoint's API: a usage limit", turn.proxy?.endpointFailure?.code === "usage_limit" && turn.proxy?.endpointFailure?.endpointId === ENDPOINT, turn.proxy);
    check("t3's failure: a usage limit naming the endpoint", failure.class === "usage_limit" && failure.code === "usage_limit" && String(failure.message).includes(`"${ENDPOINT}"`), failure);
    // The fault's unified reset is in whole seconds: within 2 s of the armed time.
    check("its reset is the vendor's (within 2 s)", Math.abs(Date.parse(failure.resetAt ?? "") - resetAt) <= 2000, { resetAt: failure.resetAt, expected: new Date(resetAt).toISOString() });
    // The Environment goes idle, and its alarm brings it back at the reset.
    await sleep(5000);
    report.idle = (await admin("POST", "/_t3flare/idle-check?force=1")).json;
    const resumed = await waitFor(cookie, threadId, (p) => runsOf(p).length > 1 && SETTLED.has(runsOf(p).at(-1)?.status ?? ""), resetAt - Date.now() + 300_000);
    const runs = runsOf(resumed.projection);
    const answer = itemsOf(resumed.projection).filter((item: any) => item.type === "assistant_message").at(-1);
    const turns = Object.values((await session(threadId)).turns ?? {}) as Array<any>;
    report.resumed = {
      runs: runs.map((run: any) => ({ id: run.id, status: run.status, startedAt: run.startedAt ?? run.createdAt ?? null })),
      secondRunStartedAfterResetMs: Date.parse(String((runs.at(-1) as any)?.startedAt ?? (runs.at(-1) as any)?.createdAt ?? 0)) - resetAt,
      answer: String(answer?.text ?? "").slice(0, 200),
      // The resumed turn's model record: its requests went to the same endpoint (the slug's), never another.
      turns: turns.map((entry) => ({ status: entry.status, proxy: entry.proxy ?? null })),
      health: (await admin("GET", "/_t3flare/health")).json?.boot ?? null,
    };
    check("the thread resumed by itself and completed", runs.at(-1)?.status === "completed", runs);
    check("the resumed run started after the reset", (report.resumed as any).secondRunStartedAfterResetMs >= 0, report.resumed);
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "key": {
    const stop = flag("tail") ? tail() : undefined;
    if (stop !== undefined) await sleep(8000);
    const { threadId, failure, turn, projection } = await failedTurn(`key ${stamp}`, "anthropicKeyRefused", 120);
    check("one model request", turn.proxy?.requests === 1, turn.proxy);
    check(
      "a refused key whose error names the endpoint",
      failure.class === "permission_error" && failure.code === "key_refused" && failure.message === `The Model endpoint "${ENDPOINT}" refused its API key (HTTP 401): check it in the Harness panel.`,
      failure,
    );
    check("no pause: no reset", (failure.resetAt ?? null) === null, failure);
    // What t3 has (the thread) and what the Session pushes (its state) hold none of the fault's echoed credentials.
    const everything = JSON.stringify([projection, await session(threadId)]);
    report.echoedInThreadOrSession = ECHOED.map((secret) => everything.split(secret).length - 1);
    check("no echoed credential reaches t3 or the push", (report.echoedInThreadOrSession as Array<number>).every((n) => n === 0), report.echoedInThreadOrSession);
    if (stop !== undefined) {
      const logs = await stop();
      const counts = ECHOED.map((secret) => logs.text.split(secret).length - 1);
      report.logs = { tailEvents: logs.events, echoed: counts, redactedMarks: logs.text.split("[redacted]").length - 1 };
      check("the logs were tailed", logs.events > 0, report.logs);
      check("no echoed credential in either Worker's logs", counts.every((n) => n === 0), report.logs);
      // The raw tail holds no secret when the check passes; when it fails it may, so it stays in a 0600 temp file.
      if (counts.every((n) => n === 0)) fs.rmSync(logs.file);
    }
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "overload": {
    const { failure, turn } = await failedTurn(`overload ${stamp}`, "overloaded", 120);
    // pi-durable retries an overload (3 retries): four answers, then a provider error.
    check("four model requests (retried)", turn.proxy?.requests === 4, turn.proxy);
    check("a provider error, not a usage limit", failure.class === "provider_error" && failure.code === "overloaded", failure);
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  case "cli": {
    const proxyUrl = (process.env.MODEL_PROXY_URL ?? "").replace(/\/+$/, "");
    if (!check("the stage's script has MODEL_PROXY_URL (dev.env)", proxyUrl !== "")) finish();
    // A made-up key of no vendor's shape: only the relay's known-value redaction would catch an echo of it.
    const refusedKey = `p1172-refused-${stamp}-not-a-real-key`;
    const api = (method: string, pathname: string, body?: unknown) => admin(method, `/_t3flare/settings/api/${pathname}`, body);
    const cli = option("cli", "pi");
    // Codex speaks OpenAI Responses (Commissary's at `/v1`); pi and Claude Code, Anthropic Messages.
    const responses = cli === "codex";
    const modelId = responses ? "gemini-3-flash" : "claude-haiku-5-5";
    const endpoint = { api: responses ? "openai-responses" : "anthropic-messages", baseUrl: responses ? `${proxyUrl}/v1` : proxyUrl, auth: "api-key", headers: {}, models: [modelId] };
    const control = flag("control");
    const saved = await api("POST", "endpoints", { op: "save", endpoint: { id: "badkey", label: "Refused key", ...endpoint }, apiKey: control ? process.env.MODEL_PROXY_API_KEY : refusedKey });
    check(control ? "the endpoint saved with the stage's working key" : "the endpoint with a refused key saved", saved.status === 200, saved.status);
    if (cli === "claude") await acpEnable(cookie, "claude");
    else await cli4aEnable(cookie, cli, cli);
    await sleep(3000);
    const turnOptions = { cli, workspace: `p1172-cli-${stamp}`, model: `badkey/${modelId}`, mode: "full-access", plan: false, prompt: "Reply with the single word: pong" };
    const turn = cli === "claude" ? await acpCliTurn(cookie, turnOptions) : await cli4aTurn(cookie, turnOptions);
    report.cliAgent = cli;
    if (control) {
      report.control = { runs: turn.runs, text: turn.text };
      check("the control turn completed", turn.runs.at(-1)?.status === "completed", turn.runs);
      finish();
    }
    const projection = await waitFor(cookie, turn.threadId, () => true, 10_000);
    const errors = itemsOf(projection.projection).filter((item: any) => item.type === "error").map((item: any) => item.failure);
    const failure = (turn.runs.at(-1)?.failure ?? errors.at(-1) ?? {}) as Record<string, any>;
    report.cli = { runs: turn.runs.map((run: any) => ({ status: run.status })), failure, errorItems: errors };
    check(`the ${cli} turn failed`, turn.runs.at(-1)?.status === "failed", turn.runs);
    check(
      `t3's failure on ${cli} is the relay's: a refused key naming the endpoint`,
      failure.class === "permission_error" && failure.code === "key_refused" && String(failure.message).startsWith('The Model endpoint "badkey" refused its API key (HTTP 401)'),
      failure,
    );
    check("not the Model proxy key's text", !JSON.stringify(report.cli).includes("COMMISSARY_CONTAINER_API_KEY"), report.cli);
    check("the refused key is in no answer", !JSON.stringify(projection.projection).includes(refusedKey));
    await api("POST", "endpoints", { op: "remove", id: "badkey" });
    finish();
  }
  // eslint-disable-next-line no-fallthrough
  default:
    console.error(`unknown step ${step}`);
    process.exit(2);
}
