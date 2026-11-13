// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// SPI-1152's stage evidence (stage `pvars`): the Variables in the Environment settings, through the panel's API, and the
// commands that start with them, read where each command path shows its output. Run through the stage's `run`, which
// sets the stage's service token and admin token (never printed):
//
//   node scripts/stage.ts run pvars pvars apply        a Variable in a Durable agent's command on the Container and on the
//                                                        Worker Shell, in a Codex command, and in a Terminal (apply.json)
//   node scripts/stage.ts run pvars pvars refusals     each refused-name class and a credential-looking value (refusals.json)
//   node scripts/stage.ts run pvars pvars precedence   a Variable shadowed by mise's [env] and by a command's export (precedence.json)
//   node scripts/stage.ts run pvars pvars pins         with Variables set, each CLI's endpoint and key helper as before (pins.json)
//   node scripts/stage.ts run pvars pvars running      a running Container untouched; the next start has the change (running.json)
//   node scripts/stage.ts run pvars pvars audit        the audit log's names and values (audit.json)
//   node scripts/stage.ts run pvars pvars panel        the section's list on the stage's page: shots, and a Variable added and saved (panel.json)
//
// Evidence goes to docs/steps/spi-1152/, each file naming the deployed build's commit.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject, enable } from "./lib/cliTurn.ts";
import { admin, DEFAULT_MODEL, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, SETTLED, sleep, threadWindow, uuid, wsFirst } from "./lib/client.ts";
import { attachTerminal } from "./lib/terminal.ts";

const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const T3 = process.env.T3_URL ?? "";
const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1152");
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const scriptHeaders = { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` };
const WORKSPACE = "pvars";
const NAME = "PVARS_PROBE";
const ECHO = `echo ${NAME}=$${NAME}`;
/** The echo, and where it ran: only the Container has the image's CLI binaries. */
const ECHO_WHERE = `${ECHO}; test -e /opt/t3flare/bin && echo ON=container || echo ON=worker`;
const SONNET = "anthropic/claude-sonnet-5-5";

interface Case {
  readonly name: string;
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

/** The deployed build's commit (the Worker's `/_t3flare/health`), so each evidence file names the code it ran against. */
const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;

const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify({ at: new Date().toISOString(), host: new URL(T3).host, commit: await deployedCommit(), ...value }, null, 1)}\n`);
  console.log(`wrote docs/steps/spi-1152/${name} (ok: ${String(value.ok)})`);
};

/** The panel's JSON API as a script calls it: the service token and the admin token. */
const harness = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(new URL(pathname, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...scriptHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
};

const setVariables = async (variables: Record<string, string>) => {
  const answer = await harness("POST", "/_t3flare/harness/api/environment", { settings: { variables } });
  if (answer.status !== 200) throw new Error(`Variables ${JSON.stringify(variables)} refused: ${answer.status} ${JSON.stringify(answer.json)}`);
  return answer.json as { revision: number; resolved: Record<string, unknown> };
};

// ── The Workspace, its Container and its commands ───────────────────────────────────────────────────────────────

let cookie = "";
let projectId = "";
const ready = async () => {
  cookie ||= await pair();
  projectId = (await ensureProject(cookie, WORKSPACE)).projectId;
};

/** One Workspace DO command (`exec`, the path its own commands take), its whole answer kept. */
const call = async (body: unknown) => {
  const response = await fetch(new URL(`/_t3flare/agents/workspace-call?id=${WORKSPACE}`, T3), { method: "POST", redirect: "manual", headers: { ...scriptHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return { status: response.status, ...JSON.parse(text) } as { status: number; result: any; container: any };
  } catch {
    return { status: response.status, result: { stderr: text }, container: undefined } as { status: number; result: any; container: any };
  }
};
const exec = async (script: string) => {
  const answer = await call({ exec: { script, cwd: "/workspace/repo", timeoutMs: 180_000 } });
  return { exitCode: answer.result?.exitCode ?? null, stdout: String(answer.result?.stdout ?? ""), stderr: String(answer.result?.stderr ?? "").slice(0, 400), startedAt: answer.container?.startedAt ?? null, launch: answer.container?.launch ?? null };
};
const containerOf = async () => ((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces as Array<any> | undefined)?.find((row) => row.id === WORKSPACE)?.container;
const stop = async () => {
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
    if ((await containerOf())?.running === false) return;
    await sleep(3_000);
  }
  throw new Error("the Container did not stop");
};

/** The value `NAME` had in `text` (`NAME=value` on a line of its own, as `ECHO` prints it); null when absent. */
const probed = (text: string, name = NAME): string | null => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;

/** A thread's settled projection after one message. */
const turn = async (threadId: string, text: string, model: unknown, limitMs = 6 * 60_000) => {
  const before = runsOf(projectionOf(await threadWindow(cookie, threadId))).length;
  await sendMessage(cookie, threadId, text, model as never);
  const started = Date.now();
  let projection: any;
  while (Date.now() - started < limitMs) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending")) {
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" });
    }
    const runs = runsOf(projection);
    if (runs.length > before && runs.every((run) => SETTLED.has(run.status))) break;
    await sleep(2_000);
  }
  return projection;
};

/**
 * The commands of a thread's projection with their output as t3's client expands a row (`subscribeCommandOutput`), the
 * text the owner sees and the tool result the agent got.
 */
const commandsOf = (threadId: string, projection: any) =>
  Promise.all(
    itemsOf(projection)
      .filter((item: any) => item.type === "command_execution" && (item.runId === undefined || item.runId === runsOf(projection).at(-1)?.id))
      .map(async (item: any) => {
        const output = await wsFirst(cookie, "orchestration.subscribeCommandOutput", { threadId, itemId: item.id }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }));
        const text = typeof (output as { text?: unknown }).text === "string" ? (output as { text: string }).text : "";
        return { input: item.input, status: item.status, output, text };
      }),
  );

const newThread = async (title: string, model: unknown) => {
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title,
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
};

/** A Durable agent's `bash` on one backend: the command, its output as t3 shows it, and the value it printed. */
const durableCommand = async (threadId: string, backend: "container" | "worker") => {
  const projection = await turn(threadId, `Call the bash tool exactly once, with command \`${ECHO_WHERE}\` and backend \`${backend}\`. Do not run anything else. Then reply with the tool's output, quoted exactly.`, DEFAULT_MODEL);
  const commands = await commandsOf(threadId, projection);
  const text = commands.at(-1)?.text ?? "";
  return { backend, runs: runsOf(projection).map((run) => run.status), commands, value: probed(text), ranOn: probed(text, "ON") };
};

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────────────────────

const apply = async () => {
  await ready();
  const value = `applied-${uuid().slice(0, 8)}`;
  const set = await setVariables({ [NAME]: value });
  await stop();
  const cases: Array<Case> = [];

  await enable(cookie, "piDurable", "piDurable");
  const durable = await newThread("pvars durable", DEFAULT_MODEL);
  const onContainer = await durableCommand(durable, "container");
  cases.push({ name: "a Durable agent's command on the Container", ...onContainer, ok: onContainer.value === value && onContainer.ranOn === "container" });
  const onWorker = await durableCommand(durable, "worker");
  cases.push({ name: "a Durable agent's command on the Worker Shell", ...onWorker, ok: onWorker.value === value && onWorker.ranOn === "worker" });

  await enable(cookie, "codex", "codex");
  const codexModel = { instanceId: "codex", model: process.env.T3FLARE_PVARS_CODEX_MODEL ?? "gpt-6-luna", options: [] };
  const codex = await newThread("pvars codex", codexModel);
  const codexProjection = await turn(codex, `Run exactly this shell command and nothing else: \`${ECHO}\`. Then reply with its output, quoted exactly.`, codexModel);
  const codexCommands = await commandsOf(codex, codexProjection);
  const codexValue = probed(codexCommands.map((entry) => entry.text).join("\n"));
  cases.push({ name: "a Codex command", runs: runsOf(codexProjection).map((run) => run.status), commands: codexCommands, value: codexValue, ok: codexValue === value });

  const terminal = await attachTerminal(cookie, { threadId: durable, terminalId: `pvars-${uuid().slice(0, 6)}`, cwd: `/w/${WORKSPACE}`, cols: 100, rows: 30 });
  await terminal.until(/[$#] $/, 120_000);
  const echoed = await terminal.run(ECHO);
  await terminal.close(true).catch(() => undefined);
  await terminal.detach();
  const terminalValue = probed(echoed.text);
  cases.push({ name: "a Terminal", output: echoed.text.slice(-300), value: terminalValue, ok: terminalValue === value });

  const launch = (await containerOf())?.launch ?? null;
  cases.push({ name: "the Container's launch took the Variables", launch, ok: launch?.variables?.[NAME] === value && launch?.revision === set.revision });
  await stop();
  await writeEvidence("apply.json", { workspace: WORKSPACE, variable: NAME, value, revision: set.revision, cases, ok: cases.every((entry) => entry.ok) });
};

/** One sample per refused-name class, and a credential-looking value; each must be refused with its reason. */
const REFUSALS: ReadonlyArray<{ readonly class: string; readonly variables: Record<string, string>; readonly says: RegExp }> = [
  { class: "set by t3flare (a CLI profile)", variables: { ANTHROPIC_BASE_URL: "https://elsewhere.example" }, says: /t3flare sets it itself/ },
  { class: "set by t3flare (the managed settings)", variables: { HTTPS_PROXY: "http://proxy.example:8080" }, says: /t3flare sets it itself/ },
  { class: "exact name", variables: { PATH: "/tmp" }, says: /the shell or the Container sets it/ },
  { class: "prefix T3", variables: { T3CODE_THREAD_ID: "x" }, says: /names starting T3 / },
  { class: "prefix MISE_", variables: { MISE_ENV: "x" }, says: /names starting MISE_ / },
  { class: "prefix GIT_", variables: { GIT_DIR: "x" }, says: /names starting GIT_ / },
  { class: "prefix GH_", variables: { GH_HOST: "x" }, says: /names starting GH_ / },
  { class: "prefix GITHUB_", variables: { GITHUB_REPOSITORY: "x" }, says: /names starting GITHUB_ / },
  { class: "prefix SSH_", variables: { SSH_AUTH_SOCK: "x" }, says: /names starting SSH_ / },
  { class: "prefix LD_", variables: { LD_PRELOAD: "x" }, says: /names starting LD_ / },
  { class: "loader hook", variables: { NODE_OPTIONS: "--require /tmp/x.js" }, says: /load code before a command runs/ },
  { class: "credential-like name", variables: { STRIPE_API_KEY: "x" }, says: /names a credential/ },
  { class: "credential-looking value", variables: { OPENAI: `sk-${"a".repeat(32)}` }, says: /value looks like an API key/ },
  { class: "more than 50", variables: Object.fromEntries(Array.from({ length: 51 }, (_, at) => [`V${at}`, "x"])), says: /at most 50 Variables/ },
];

const refusals = async () => {
  const before = (await harness("GET", "/_t3flare/harness/api/environment")).json;
  const cases: Array<Case> = [];
  for (const sample of REFUSALS) {
    const answer = await harness("POST", "/_t3flare/harness/api/environment", { settings: { variables: sample.variables } });
    const text = String(answer.json).trim();
    cases.push({ name: sample.class, tried: Object.keys(sample.variables).length > 3 ? `${Object.keys(sample.variables).length} Variables` : sample.variables, status: answer.status, answer: text, ok: answer.status === 400 && sample.says.test(text) });
  }
  const after = (await harness("GET", "/_t3flare/harness/api/environment")).json;
  cases.push({ name: "nothing refused was stored", before: { revision: before?.revision, variables: before?.resolved?.variables }, after: { revision: after?.revision, variables: after?.resolved?.variables }, ok: before?.revision === after?.revision });
  await writeEvidence("refusals.json", { cases, ok: cases.every((entry) => entry.ok) });
};

const precedence = async () => {
  await ready();
  await setVariables({ [NAME]: "from-variable" });
  await stop();
  // A repo mise.toml with [env] (the Workspace's files are trusted: MISE_TRUSTED_CONFIG_PATHS), removed afterwards.
  const script = [
    `printf '[env]\\n${NAME} = "from-mise"\\n' > mise.toml`,
    ECHO.replace(`${NAME}=`, "plain="),
    `mise exec -- bash -c 'echo mise=$${NAME}'`,
    `export ${NAME}=exported`,
    ECHO.replace(`${NAME}=`, "exported="),
    "rm -f mise.toml",
  ].join("\n");
  const run = await exec(script);
  const cases: Array<Case> = [
    { name: "a plain command sees the Variable", value: probed(run.stdout, "plain"), ok: probed(run.stdout, "plain") === "from-variable" },
    { name: "mise's [env] wins over it", value: probed(run.stdout, "mise"), ok: probed(run.stdout, "mise") === "from-mise" },
    { name: "a command's own export wins over it", value: probed(run.stdout, "exported"), ok: probed(run.stdout, "exported") === "exported" },
  ];
  const clean = await exec("git status --short");
  cases.push({ name: "the repo's mise.toml is gone again", status: clean.stdout, ok: !clean.stdout.includes("mise.toml") });
  await stop();
  await writeEvidence("precedence.json", { workspace: WORKSPACE, script, run, cases, ok: cases.every((entry) => entry.ok) });
};

/**
 * The live processes in the Container with t3flare's exec marker (CLI processes and what they run): executable, argv,
 * the environment names, and the values of the names below only (a process's nonce and tool handle are never read out).
 */
const SHOWN = [NAME, "NODE_ENV", "ANTHROPIC_BASE_URL", "HTTPS_PROXY", "HTTP_PROXY", "NODE_OPTIONS", "CODEX_HOME", "PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "LANG", "HOME"];
const PROCESSES = `for d in /proc/[0-9]*; do
  grep -qz '^T3FLARE_EXEC=' "$d/environ" 2>/dev/null || continue
  echo "PID \${d#/proc/}"
  echo "EXE $(readlink "$d/exe")"
  echo "ARGV $(base64 -w0 < "$d/cmdline")"
  echo "NAMES $(tr '\\0' '\\n' < "$d/environ" | cut -d= -f1 | sort | tr '\\n' ' ')"
  for name in ${SHOWN.join(" ")}; do line=$(tr '\\0' '\\n' < "$d/environ" | grep -m1 "^$name=") && echo "ENV $line"; done
done
echo "CLAUDE $(cat /etc/claude-code/managed-settings.json 2>/dev/null | base64 -w0)"
echo "OPENCODE $(cat /etc/opencode/opencode.json 2>/dev/null | base64 -w0)"
for f in /var/lib/t3flare/cli/*/agent/models.json; do [ -f "$f" ] && echo "PIMODELS $(base64 -w0 < "$f")"; done`;

const processes = async () => {
  const run = await exec(PROCESSES);
  const rows: Array<{ pid: string; exe: string; argv: Array<string>; names: Array<string>; env: Record<string, string> }> = [];
  const files: { claude: Array<any>; opencode: Array<any>; pi: Array<any> } = { claude: [], opencode: [], pi: [] };
  const decode = (text: string) => Buffer.from(text, "base64").toString("utf8");
  for (const line of run.stdout.split("\n")) {
    const [tag, ...rest] = line.split(" ");
    const body = rest.join(" ");
    if (tag === "PID") rows.push({ pid: body, exe: "", argv: [], names: [], env: {} });
    else if (tag === "EXE") rows.at(-1)!.exe = body;
    else if (tag === "ARGV") rows.at(-1)!.argv = decode(body).split("\0").filter((arg) => arg !== "");
    else if (tag === "NAMES") rows.at(-1)!.names = body.trim().split(" ");
    else if (tag === "ENV") {
      const at = body.indexOf("=");
      rows.at(-1)!.env[body.slice(0, at)] = body.slice(at + 1);
    } else if ((tag === "CLAUDE" || tag === "OPENCODE" || tag === "PIMODELS") && body.trim() !== "") {
      const parsed = JSON.parse(decode(body));
      files[tag === "CLAUDE" ? "claude" : tag === "OPENCODE" ? "opencode" : "pi"].push(parsed);
    }
  }
  return { rows, files, exitCode: run.exitCode };
};

type Row = Awaited<ReturnType<typeof processes>>["rows"][number];

const CLIS = {
  codex: { instanceId: "codex", driver: "codex", model: process.env.T3FLARE_PVARS_CODEX_MODEL ?? "gpt-6-luna", is: (row: Row) => row.exe === "/opt/t3flare/bin/codex" },
  // pi names its process `pi` (its argv is rewritten); its executable is the image's Node.
  pi: { instanceId: "pi", driver: "pi", model: SONNET, is: (row: Row) => row.exe.endsWith("/bin/node") && (row.argv[0] === "pi" || row.argv.some((arg) => arg.startsWith("/opt/t3flare/pi/"))) },
  claude: { instanceId: "claudeAgent", driver: "claudeAgent", model: SONNET, is: (row: Row) => row.argv.some((arg) => arg.includes("claude-agent-acp")) },
  opencode: { instanceId: "opencode", driver: "opencode", model: SONNET, is: (row: Row) => row.exe.startsWith("/opt/t3flare/opencode/") },
} as const;

const pins = async () => {
  await ready();
  const value = `pinned-${uuid().slice(0, 8)}`;
  await setVariables({ [NAME]: value, NODE_ENV: "pvars" });
  await stop();
  const cases: Array<Case> = [];
  const only = process.argv.slice(3);
  for (const [cli, spec] of Object.entries(CLIS).filter(([name]) => only.length === 0 || only.includes(name))) {
    await enable(cookie, spec.instanceId, spec.driver);
    const model = { instanceId: spec.instanceId, model: spec.model, options: [] };
    const threadId = await newThread(`pvars ${cli}`, model);
    const projection = await turn(threadId, "Reply with the single word ready, and nothing else. Do not run any tool.", model);
    const reply = itemsOf(projection)
      .filter((item: any) => item.type === "assistant_message")
      .map((item: any) => String(item.text ?? ""))
      .join("");
    const seen = await processes();
    const mine = seen.rows.filter(spec.is);
    const argv = mine.flatMap((row) => row.argv).join(" ");
    let endpoint: unknown = null;
    let keyHelper: unknown = null;
    if (cli === "codex") {
      endpoint = /base_url="([^"]+)"/.exec(argv)?.[1] ?? null;
      keyHelper = /auth=\{command="([^"]+)",args=\["codex"\]/.exec(argv)?.[1] ?? null;
    } else if (cli === "pi") {
      const models = seen.files.pi.at(-1)?.providers?.anthropic;
      endpoint = models?.baseUrl ?? null;
      keyHelper = models?.apiKey ?? null;
    } else if (cli === "claude") {
      const managed = seen.files.claude.at(-1);
      endpoint = { managed: managed?.env?.ANTHROPIC_BASE_URL ?? null, process: mine.find((row) => row.env.ANTHROPIC_BASE_URL !== undefined)?.env.ANTHROPIC_BASE_URL ?? null, httpsProxyPinned: managed?.env?.HTTPS_PROXY ?? null };
      keyHelper = managed?.apiKeyHelper ?? null;
    } else {
      const config = seen.files.opencode.at(-1);
      endpoint = config?.providers?.t3flare?.settings?.baseURL ?? null;
      keyHelper = config?.plugins ?? null;
    }
    const variableSeen = mine.map((row) => row.env[NAME] ?? null);
    const expected = {
      codex: { endpoint: (e: any) => typeof e === "string" && e.endsWith("/v1"), keyHelper: (k: any) => k === "/opt/t3flare/bin/t3flare-model-key" },
      pi: { endpoint: (e: any) => typeof e === "string" && e.startsWith("https://"), keyHelper: (k: any) => k === "!/opt/t3flare/bin/t3flare-model-key pi" },
      claude: { endpoint: (e: any) => typeof e?.managed === "string" && e.managed === e.process && e.httpsProxyPinned === "", keyHelper: (k: any) => k === "/opt/t3flare/bin/t3flare-claude-key" },
      opencode: { endpoint: (e: any) => typeof e === "string" && e.endsWith("/v1"), keyHelper: (k: any) => Array.isArray(k) && k.length === 1 && k[0] === "/opt/t3flare/share/opencode-key-plugin" },
    }[cli as keyof typeof CLIS];
    cases.push({
      name: `${cli}: a turn through the proxy, its endpoint and key helper t3flare's, the Variables in its environment`,
      runs: runsOf(projection).map((run: any) => ({ status: run.status, failure: run.failure ?? null })),
      reply: reply.slice(-200),
      processes: mine.map((row) => ({ pid: row.pid, argv0: row.argv[0], env: row.env, names: row.names })),
      allProcesses: seen.rows.map((row) => `${row.exe}: ${row.argv.slice(0, 3).join(" ")}`),
      endpoint,
      keyHelper,
      variableSeen,
      ok: /ready/i.test(reply) && runsOf(projection).at(-1)?.status === "completed" && mine.length > 0 && expected.endpoint(endpoint) && expected.keyHelper(keyHelper) && variableSeen.every((seenValue) => seenValue === value),
    });
    console.log(`${cli}: ${cases.at(-1)!.ok}`);
    // Each CLI alone in its Container: a Workspace runs at most 4 CLI process weights (Claude Code and OpenCode count twice).
    await stop();
  }
  const endpoints = cases.map((entry) => entry.endpoint).map((e: any) => (typeof e === "string" ? e.replace(/\/v1$/, "") : (e?.managed ?? null)));
  cases.push({ name: "every CLI reaches the same model proxy", endpoints, ok: endpoints.every((e) => e !== null && e === endpoints[0]) });
  await stop();
  await setVariables({});
  await writeEvidence("pins.json", { workspace: WORKSPACE, variables: { [NAME]: value, NODE_ENV: "pvars" }, cases, ok: cases.every((entry) => entry.ok) });
};

const running = async () => {
  await ready();
  const cases: Array<Case> = [];
  await setVariables({ [NAME]: "first" });
  await stop();
  const first = await exec(ECHO);
  cases.push({ name: "started with the Variable at first", value: probed(first.stdout), startedAt: first.startedAt, launch: first.launch, ok: probed(first.stdout) === "first" && first.launch?.variables?.[NAME] === "first" });
  const changed = await setVariables({ [NAME]: "second" });
  const during = await exec(ECHO);
  cases.push({
    name: "changed to second while it runs: the running Container's commands still get first, its start unchanged",
    revision: changed.revision,
    value: probed(during.stdout),
    startedAt: during.startedAt,
    launch: during.launch,
    ok: probed(during.stdout) === "first" && during.startedAt === first.startedAt && during.launch?.variables?.[NAME] === "first",
  });
  await stop();
  const next = await exec(ECHO);
  cases.push({ name: "the next start has second", value: probed(next.stdout), startedAt: next.startedAt, launch: next.launch, ok: probed(next.stdout) === "second" && next.startedAt !== first.startedAt && next.launch?.revision === changed.revision });
  await stop();
  await writeEvidence("running.json", { workspace: WORKSPACE, cases, ok: cases.every((entry) => entry.ok) });
};

const audit = async () => {
  const before = (await harness("GET", "/_t3flare/harness/api/environment")).json?.resolved?.variables ?? {};
  await setVariables({ ...before, PVARS_AUDIT: "one" });
  await setVariables({ ...before, PVARS_AUDIT: "two", PVARS_REGION: "eu" });
  await harness("POST", "/_t3flare/harness/api/environment", { settings: { variables: { GH_TOKEN: "x" } } });
  await setVariables(before);
  const entries = ((await harness("GET", "/_t3flare/harness/api/audit")).json?.entries ?? []) as Array<any>;
  const variables = entries.filter((entry) => entry.entity === "environment" && entry.target === "variables");
  const latest = variables.slice(0, 3);
  const cases: Array<Case> = [
    {
      name: "each Variables change is logged with the names and values before and after",
      entries: latest,
      ok:
        latest.length === 3 &&
        latest[2]?.after?.variables?.PVARS_AUDIT === "one" &&
        latest[1]?.before?.variables?.PVARS_AUDIT === "one" &&
        latest[1]?.after?.variables?.PVARS_AUDIT === "two" &&
        latest[1]?.after?.variables?.PVARS_REGION === "eu" &&
        latest[0]?.before?.variables?.PVARS_REGION === "eu" &&
        latest[0]?.after?.variables?.PVARS_AUDIT === undefined,
    },
    { name: "the refused change is not logged", ok: !JSON.stringify(entries).includes("GH_TOKEN") },
  ];
  await writeEvidence("audit.json", { note: "The Workers Logs line of each change (store.ts) carries no value; unit-tested in apps/environment/test/environmentSettings.test.ts.", cases, ok: cases.every((entry) => entry.ok) });
};

const browser = (...args: Array<string>) => {
  const result = spawnSync("agent-browser", ["--session", "pvars", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`agent-browser ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  return result.stdout;
};

/** Adds a row with the page's own Add button, types a Variable as a person would, and saves with the form's Save. */
const ADD_AND_SAVE = `(() => {
  const list = document.querySelector('[data-kind="variables"]');
  list.querySelector('[data-variable-add]').click();
  const rows = list.querySelectorAll('[data-variable]');
  const row = rows[rows.length - 1];
  const name = row.querySelector('[data-variable-name]');
  name.value = 'PVARS_PANEL';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  const value = row.querySelector('[data-variable-value]');
  value.value = 'from the page';
  value.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('form[data-environment] [data-save]').click();
})()`;

const panel = async () => {
  await setVariables({ NODE_ENV: "development", LOG_LEVEL: "debug", DATABASE_URL: "postgres://localhost:5432/dev" });
  fs.mkdirSync(OUT, { recursive: true });
  const page = new URL("/_t3flare/harness", HARNESS).toString();
  const save = (name: string) => {
    const file = path.join(OUT, name);
    browser("screenshot", file);
    const widthOf = () => Number(/pixelWidth: (\d+)/.exec(spawnSync("sips", ["-g", "pixelWidth", file], { encoding: "utf8" }).stdout)?.[1]);
    if (widthOf() > 1400) spawnSync("sips", ["--resampleWidth", "1400", file], { stdio: "ignore" });
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  };
  for (const scheme of ["light", "dark"]) {
    for (const [name, width, height, scale] of [["desktop", 1280, 1100, 1], ["phone", 390, 844, 2]] as const) {
      browser("--headers", JSON.stringify(scriptHeaders), "--color-scheme", scheme, "open", page);
      browser("set", "viewport", String(width), String(height), String(scale));
      browser("set", "media", scheme);
      browser("open", page);
      browser("wait", "--load", "networkidle");
      browser("eval", `document.querySelector('[data-kind="variables"]').scrollIntoView({ block: 'center' })`);
      spawnSync("sleep", ["0.5"]);
      save(`variables-${name}-${scheme}.png`);
      browser("close");
    }
  }
  // The page's own script under its CSP: a row added and saved; the API then holds it beside the others.
  browser("--headers", JSON.stringify(scriptHeaders), "open", page);
  browser("wait", "--load", "networkidle");
  browser("eval", ADD_AND_SAVE);
  await sleep(4_000);
  const stored = (await harness("GET", "/_t3flare/harness/api/environment")).json?.resolved?.variables;
  browser("close");
  const cases: Array<Case> = [
    { name: "a Variable added with the list's Add button and saved with Save is stored beside the others", stored, ok: stored?.PVARS_PANEL === "from the page" && stored?.NODE_ENV === "development" && Object.keys(stored ?? {}).length === 4 },
  ];
  await setVariables({});
  await writeEvidence("panel.json", { note: "The Environment section on the stage's page, its script under the page's CSP; screenshots variables-<desktop|phone>-<light|dark>.png.", cases, ok: cases.every((entry) => entry.ok) });
};

const commands: Record<string, () => Promise<void>> = { apply, refusals, precedence, pins, running, audit, panel };
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: pvars.ts ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
await command();
