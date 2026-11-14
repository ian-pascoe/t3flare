// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-1150's stage evidence (stage `pmise`): the Global mise config through the panel's API, laid down in the Containers
// that start with it, and what every command path's environment carries. Run through the stage's `run`, which sets the
// stage's service token and admin token (never printed):
//
//   node scripts/stage.ts run pmise pmise variables   the guard variables from every command path (variables.json; first)
//   … install | override | git-gh | hold | restart | invalid | size | cost | empty | late | passive-first   (<case>.json)
//
// Evidence goes to docs/steps/global-mise/, each file naming the deployed commit.
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, DEFAULT_MODEL, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, SETTLED, sleep, threadWindow, uuid, wsCall, wsFirst, wsStream } from "./lib/client.ts";
import { tailing } from "./lib/tail.ts";
import { attachTerminal, stripAnsi } from "./lib/terminal.ts";

const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const T3 = process.env.T3_URL ?? "";
const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/global-mise");
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const scriptHeaders = { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` };
const WORKSPACE = "pmise";
const SONNET = process.env.T3FLARE_PMISE_MODEL ?? "anthropic/claude-sonnet-5-5";

/** The CLI agents, as t3 lists them (pcli.ts). */
const CLIS = {
  codex: { instanceId: "codex", driver: "codex", model: process.env.T3FLARE_PMISE_CODEX_MODEL ?? "gpt-6-luna" },
  claude: { instanceId: "claudeAgent", driver: "claudeAgent", model: SONNET },
  opencode: { instanceId: "opencode", driver: "opencode", model: SONNET },
  pi: { instanceId: "pi", driver: "pi", model: SONNET },
} as const;
type Cli = keyof typeof CLIS;

/** The deployed build's commit (the Worker's `/_t3flare/health`), so each evidence file names the code it ran against. */
const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;

const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify({ at: new Date().toISOString(), host: new URL(T3).host, commit: await deployedCommit(), ...value }, null, 1)}\n`);
  console.log(`wrote docs/steps/global-mise/${name} (ok: ${String(value.ok)})`);
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
    json = text.slice(0, 600);
  }
  return { status: response.status, json };
};

const setEnvironment = async (settings: Record<string, unknown>) => {
  const answer = await harness("POST", "/_t3flare/harness/api/environment", { settings });
  if (answer.status !== 200) throw new Error(`environment change refused: ${answer.status} ${JSON.stringify(answer.json)}`);
  return answer.json as { revision: number; resolved: Record<string, unknown> };
};

/** One Workspace call, its whole answer kept. */
const callOn = async (id: string, body: unknown) => {
  const response = await fetch(new URL(`/_t3flare/agents/workspace-call?id=${id}`, T3), { method: "POST", redirect: "manual", headers: { ...scriptHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return { status: response.status, ...JSON.parse(text) } as { status: number; result: any; container: any; text?: string };
  } catch {
    return { status: response.status, result: undefined, container: undefined, text } as { status: number; result: any; container: any; text?: string };
  }
};
const execOn = async (id: string, script: string, timeoutMs = 120_000) => {
  const answer = await callOn(id, { exec: { script, timeoutMs } });
  return { exitCode: answer.result?.exitCode as number | undefined, stdout: String(answer.result?.stdout ?? ""), stderr: String(answer.result?.stderr ?? answer.text ?? "").slice(0, 600) };
};
const stopOn = (id: string) => admin("POST", `/_t3flare/agents/workspace-stop?id=${id}`);
const stateOf = async (id: string) => ((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces as Array<any> | undefined)?.find((row) => row.id === id)?.container;

let cookie = "";

interface Case {
  readonly name?: string;
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

/** One turn on a new thread of `instance`, every request accepted; its runs, answer and tool items. */
const turn = async (projectId: string, model: { instanceId: string; model: string; options: [] }, prompt: string, timeoutMs = 8 * 60_000) => {
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: `pmise ${model.instanceId}`, modelSelection: model, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  await sendMessage(cookie, threadId, prompt, model);
  const started = Date.now();
  const answered = new Set<string>();
  let view: any;
  while (Date.now() - started < timeoutMs) {
    view = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (view?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      answered.add(request.id);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
    }
    const runs = runsOf(view);
    if (runs.length > 0 && runs.every((run) => SETTLED.has(run.status))) break;
    await sleep(2_000);
  }
  const items = itemsOf(view);
  return {
    threadId,
    runs: runsOf(view).map((run: any) => ({ status: run.status, failure: run.failure ?? null })),
    answer: String(items.filter((item: any) => item.type === "assistant_message").at(-1)?.text ?? "").slice(-400),
    tools: items.filter((item: any) => item.type === "command_execution").map((item: any) => String(item.input ?? "").slice(0, 200)),
    // A command's output as t3's client expands it (the thread window omits it): what the agent's tool returned.
    outputs: await Promise.all(
      items
        .filter((item: any) => item.type === "command_execution")
        .map(async (item: any) => JSON.stringify(await wsFirst(cookie, "orchestration.subscribeCommandOutput", { threadId, itemId: item.id }).catch((error: unknown) => ({ error: String(error).slice(0, 200) }))).slice(0, 800)),
    ),
    errors: items.filter((item: any) => item.type === "error").map((item: any) => String(item.detail ?? item.message ?? item.text ?? JSON.stringify(item)).slice(-1200)),
    ms: Date.now() - started,
  };
};

const durableModel = DEFAULT_MODEL as { instanceId: string; model: string; options: [] };
const cliModel = (cli: Cli) => ({ instanceId: CLIS[cli].instanceId, model: CLIS[cli].model, options: [] as [] });
const enableAll = async () => {
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  for (const cli of Object.values(CLIS)) await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: cli.instanceId, instance: { driver: cli.driver, enabled: true } } });
  // Each instance's provider list fresh, as the client asks for it before a thread (OpenCode's session opens after it).
  for (const cli of Object.values(CLIS)) await wsCall(cookie, "server.refreshProviders", { instanceId: cli.instanceId, fresh: true }).catch(() => undefined);
};

// ── variables.json ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The names COMMAND_ENV sets for mise: each one's value, or `unset`, as a command's own environment has it. */
const NAMES = ["MISE_SYSTEM_CONFIG_FILE", "MISE_GLOBAL_CONFIG_FILE", "MISE_GITHUB_GH_CLI_TOKENS", "MISE_GITHUB_USE_GIT_CREDENTIALS", "MISE_GITHUB_CREDENTIAL_COMMAND", "MISE_DISABLE_TOOLS", "MISE_DISABLE_BACKENDS"];
const SETTINGS = ["github.gh_cli_tokens", "github.use_git_credentials", "github.credential_command", "disable_tools", "disable_backends"];
const VARS_DIR = "/workspace/.pmise";

/**
 * The check each path runs (`bash /workspace/.pmise/vars.sh <who>`): a gh `hosts.yml` in the command's own home (a CLI's
 * home is its own), then each variable as the command has it, mise's resolved settings, and the token mise would send.
 */
const VARS_SCRIPT = `who=$1
mkdir -p "$HOME/.config/gh"
printf 'github.com:\\n    oauth_token: ghp_pmisehostsyml0000000000000000000000000\\n    user: pmise\\n    git_protocol: https\\n' > "$HOME/.config/gh/hosts.yml"
{
echo "home=$HOME"
for n in ${NAMES.join(" ")}; do if [ -n "\${!n+x}" ]; then echo "env $n=[\${!n}]"; else echo "env $n unset"; fi; done
for s in ${SETTINGS.join(" ")}; do echo "setting $s=[$(mise settings get $s 2>&1 | tr '\\n' ' ' | sed 's/ $//')]"; done
mise doctor 2>/dev/null | sed -n '/^dirs:/,/^$/p' | sed -n -E 's/^  ([a-z_]+): (.*)$/dir \\1=[\\2]/p'
for n in XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_CONFIG_HOME; do echo "xdg $n=[\${!n:-}]"; done
echo "pinned-node [$(MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_NOT_FOUND_AUTO_INSTALL=false node --version 2>&1 | head -1)]"
echo "where-node [$(MISE_AUTO_INSTALL=false mise where node 2>&1 | head -1)]"
echo "other-data [$(ls -d "\${XDG_DATA_HOME:-/nonexistent}/mise/installs" 2>/dev/null || echo none)]"
echo "token [$(mise token github 2>&1 | tr '\\n' ' ' | sed -E 's/(gh[a-z]_[A-Za-z0-9]{4})[A-Za-z0-9]+/\\1…/g; s/ $//')]"
} > ${VARS_DIR}/vars-$who.txt 2>&1
echo pmise-vars-done-$who
`;

const parseVars = (text: string) => {
  const env: Record<string, string | null> = {};
  const settings: Record<string, string> = {};
  let token: string | null = null;
  let home: string | null = null;
  const dirs: Record<string, string> = {};
  const xdg: Record<string, string> = {};
  const probe: Record<string, string> = {};
  for (const line of text.split("\n")) {
    let match = /^env (\w+)=\[(.*)\]$/.exec(line);
    if (match !== null) env[match[1]!] = match[2]!;
    match = /^env (\w+) unset$/.exec(line);
    if (match !== null) env[match[1]!] = null;
    match = /^setting ([\w.]+)=\[(.*)\]$/.exec(line);
    if (match !== null) settings[match[1]!] = match[2]!;
    match = /^token \[(.*)\]$/.exec(line);
    if (match !== null) token = match[1]!;
    match = /^dir (\w+)=\[(.*)\]$/.exec(line);
    if (match !== null) dirs[match[1]!] = match[2]!;
    match = /^xdg (\w+)=\[(.*)\]$/.exec(line);
    if (match !== null) xdg[match[1]!] = match[2]!;
    match = /^(pinned-node|where-node|other-data) \[(.*)\]$/.exec(line);
    if (match !== null) probe[match[1]!] = match[2]!;
    match = /^home=(.*)$/.exec(line);
    if (match !== null) home = match[1]!;
  }
  return { home, env, settings, token, miseDirs: dirs, xdg, pinned: probe };
};

/** What the guards must look like from a command, by name: the two `false` ones (the ticket's) and the empty three. */
const EXPECTED_ENV: Record<string, string> = {
  MISE_GITHUB_GH_CLI_TOKENS: "false",
  MISE_GITHUB_USE_GIT_CREDENTIALS: "false",
  MISE_GITHUB_CREDENTIAL_COMMAND: "",
  MISE_DISABLE_TOOLS: "",
  MISE_DISABLE_BACKENDS: "",
};

const variables = async () => {
  cookie ||= await pair();
  const { projectId, root } = await ensureProject(cookie, WORKSPACE);
  await enableAll();
  // A pin the image lacks: each path must see the lay-down's install with mise's auto-install off.
  await setEnvironment({ globalMiseConfig: NODE_PIN });
  // A running Container keeps what it started with: every path starts a new one.
  await stopAll();
  const written = await execOn(WORKSPACE, `mkdir -p ${VARS_DIR} && cat > ${VARS_DIR}/vars.sh <<'PMISE_EOF'\n${VARS_SCRIPT}PMISE_EOF\necho ok`);
  if (!written.stdout.includes("ok")) throw new Error(`could not write the check: ${JSON.stringify(written)}`);
  const paths: Array<{ who: string; how: string; detail: unknown }> = [];
  const run = `bash ${VARS_DIR}/vars.sh`;
  // `variables <who> …` runs only those paths, merged into the file's earlier results.
  const only = process.argv.slice(3);
  const wanted = (who: string) => only.length === 0 || only.includes(who);

  // The Workspace DO's own command (computerd's env, WorkspaceDO.exec).
  if (wanted("workspace-exec")) paths.push({ who: "workspace-exec", how: "the Workspace DO's exec (t3's git and the admin route take this path)", detail: await execOn(WORKSPACE, `${run} workspace-exec`) });

  // A Durable agent's bash (computer's stub from the Session, computerd's env).
  if (wanted("durable")) paths.push({
    who: "durable",
    how: "a Durable agent's bash on the Container",
    detail: await turn(projectId, durableModel, `Call the bash tool once with command \`${run} durable\` and backend \`container\`. Then reply with the single word done.`),
  });

  // A t3 Terminal (the platform's exec, terminalEnv).
  if (wanted("terminal")) {
  const terminal = await attachTerminal(cookie, { threadId: `pmise-${uuid()}`, terminalId: "default", cwd: root });
  await terminal.until(/[$#] $/, 180_000);
  const typed = await terminal.run(`${run} terminal`, 120_000).catch((error: unknown) => ({ ms: -1, text: String(error).slice(0, 400) }));
  await terminal.close(true).catch(() => undefined);
  await terminal.detach().catch(() => undefined);
  paths.push({ who: "terminal", how: "a t3 Terminal", detail: { ms: typed.ms, tail: stripAnsi(typed.text).slice(-300) } });
  }

  // A command each CLI agent runs (the platform's exec, then each CLI's own handling of its children's environment).
  for (const cli of (Object.keys(CLIS) as Array<Cli>).filter(wanted)) {
    // A Workspace runs at most 4 CLI process weights (Claude Code and OpenCode count twice): each CLI on a fresh
    // Container, so the earlier ones' processes never refuse the next.
    await stopOn(WORKSPACE);
    paths.push({
      who: cli,
      how: `a shell command ${cli} runs`,
      detail: await turn(projectId, cliModel(cli), `Run this exact shell command once with your shell tool, from any directory: \`${run} ${cli}\` . Do not change it. Then reply with the single word done.`).catch((error: unknown) => ({
        error: String(error).slice(0, 400),
      })),
    });
  }

  const read = await execOn(WORKSPACE, `for f in ${VARS_DIR}/vars-*.txt; do echo "== $f"; cat "$f"; done`);
  const files = Object.fromEntries(
    read.stdout
      .split(/^== /m)
      .filter((chunk) => chunk.trim() !== "")
      .map((chunk) => {
        const [first, ...rest] = chunk.split("\n");
        return [/vars-(.+)\.txt$/.exec(first ?? "")?.[1] ?? first, rest.join("\n")];
      }),
  );
  const results = paths.map((entry) => {
    const text = files[entry.who];
    if (text === undefined) return { ...entry, ranAt: new Date().toISOString(), ran: false, ok: false };
    const parsed = parseVars(text);
    const arrived = Object.fromEntries(Object.entries(EXPECTED_ENV).map(([name, value]) => [name, parsed.env[name] === value]));
    const falseGuards = arrived.MISE_GITHUB_GH_CLI_TOKENS === true && arrived.MISE_GITHUB_USE_GIT_CREDENTIALS === true;
    const emptyGuards = arrived.MISE_GITHUB_CREDENTIAL_COMMAND === true && arrived.MISE_DISABLE_TOOLS === true && arrived.MISE_DISABLE_BACKENDS === true;
    return { ...entry, ranAt: new Date().toISOString(), ran: true, ...parsed, arrived, falseGuards, emptyGuards, noToken: parsed.token !== null && parsed.token.includes("(none)"), sharesInstall: parsed.pinned["pinned-node"] === "v24.11.1" && parsed.miseDirs.data === "~/.local/share/mise" && parsed.pinned["other-data"] === "none", ok: falseGuards && emptyGuards && parsed.token?.includes("(none)") === true && parsed.pinned["pinned-node"] === "v24.11.1" && parsed.miseDirs.data === "~/.local/share/mise" && parsed.pinned["other-data"] === "none" };
  });
  const earlier: Array<any> = only.length === 0 || !fs.existsSync(path.join(OUT, "variables.json")) ? [] : JSON.parse(fs.readFileSync(path.join(OUT, "variables.json"), "utf8")).results ?? [];
  const merged = [...earlier.filter((entry) => !only.includes(entry.who)), ...results];
  await writeEvidence("variables.json", {
    note: "Each path ran `vars.sh` with a gh hosts.yml in its own home and the Global mise config `node = \"24.11.1\"` (the image has 26.13.0): the variables as its command has them (null: unset), mise's resolved settings and effective directories (`mise doctor`; ~ is /root), its XDG_* values, the pinned node with mise's auto-install off, any install under its own XDG_DATA_HOME, and the token mise would send.",
    results: merged,
    ok: merged.every((entry) => entry.ok),
  });
};

/** One OpenCode turn under `wrangler tail`: the log lines about its session's open, redacted (a diagnosis aid). */
const opencodeDebug = async () => {
  cookie ||= await pair();
  const { projectId } = await ensureProject(cookie, WORKSPACE);
  await enableAll();
  const { result, text } = await tailing([new URL(T3).hostname.split(".")[0]!, `t3flare-agents-pmise`], () => turn(projectId, cliModel("opencode"), "Reply with the single word done."));
  const lines = text.split("\n").filter((line) => /opencode|acp|process-start|refus|error/i.test(line));
  console.log(JSON.stringify(result.runs));
  for (const line of lines.slice(0, 60)) console.log(line.replace(/(bearer|token|key|secret)([^,}]{0,10})["':= ]+[^"',} ]+/gi, "$1$2=<redacted>").slice(0, 600));
};


// ── The Global mise config's cases ───────────────────────────────────────────────────────────────────────────────

const GLOBAL_FILE = "/var/lib/t3flare/mise/config.toml";
/** A node the image lacks (it has 26.13.0). */
const NODE_PIN = '[tools]\nnode = "24.11.1"\n';
const OUT_DIR = "/workspace/.pmise";

const setMise = (text: string) => setEnvironment({ globalMiseConfig: text });
const status = async () => (await harness("GET", "/_t3flare/harness/api/status")).json?.["last Global mise lay-down"] ?? null;
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Stops every pmise Workspace's Container and waits until each is stopped. */
const stopAll = async (ids: ReadonlyArray<string> = [WORKSPACE]) => {
  for (const id of ids) {
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      await stopOn(id);
      if ((await stateOf(id))?.running !== true) break;
      await sleep(3_000);
    }
  }
};

/** A Durable agent's bash on the Container: one command, its tool output as t3's client expands it. */
const durableBash = async (projectId: string, command: string, extra = "") =>
  turn(projectId, durableModel, `Call the bash tool once with command \`${command}\` and backend \`container\`${extra}. Do not retry or run anything else. Then reply with the tool's output or error text, quoted exactly.`);

/** A file the paths write their answers to, read through the Workspace DO (null when absent). */
const readOut = async (name: string) => {
  const read = await execOn(WORKSPACE, `cat ${OUT_DIR}/${name} 2>/dev/null || echo PMISE-ABSENT`);
  return read.stdout.includes("PMISE-ABSENT") ? null : read.stdout.trim();
};

const install = async () => {
  cookie ||= await pair();
  const { projectId, root } = await ensureProject(cookie, WORKSPACE);
  await enableAll();
  await setEnvironment({ containerIdleMinutes: 2, containerBudget: 3 });
  await setMise(NODE_PIN);
  await execOn(WORKSPACE, `mkdir -p ${OUT_DIR} && rm -f ${OUT_DIR}/node-*.txt`);
  const results: Array<Case> = [];
  const check = async (who: string, run: () => Promise<unknown>) => {
    await stopAll();
    const detail = await run();
    const text = await readOut(`node-${who}.txt`);
    const state = await stateOf(WORKSPACE);
    results.push({ name: who, node: text, globalMise: state?.globalMise ?? null, launch: state?.launch?.globalMise ?? null, detail, ok: text === "v24.11.1" && state?.globalMise?.outcome === "laid" });
  };
  await check("durable", () => durableBash(projectId, `node --version > ${OUT_DIR}/node-durable.txt 2>&1`));
  await check("pi", () => turn(projectId, cliModel("pi"), `Run this exact shell command once with your shell tool: \`node --version > ${OUT_DIR}/node-pi.txt 2>&1\` . Then reply with the single word done.`));
  await check("terminal", async () => {
    const terminal = await attachTerminal(cookie, { threadId: `pmise-${uuid()}`, terminalId: "default", cwd: root });
    await terminal.until(/[$#] $/, 600_000);
    const typed = await terminal.run(`node --version > ${OUT_DIR}/node-terminal.txt 2>&1`, 120_000).catch((error: unknown) => ({ ms: -1, text: String(error).slice(0, 300) }));
    await terminal.close(true).catch(() => undefined);
    await terminal.detach().catch(() => undefined);
    return { ms: typed.ms };
  });
  await writeEvidence("install.json", { pin: NODE_PIN, imageNode: "26.13.0", status: await status(), results, ok: results.every((entry) => entry.ok) });
};

const override = async () => {
  cookie ||= await pair();
  await ensureProject(cookie, WORKSPACE);
  const global = `${NODE_PIN}"github:junegunn/fzf" = "0.56.3"\n`;
  await setMise(global);
  await stopAll();
  const repo = '[tools]\nnode = "22.12.0"\n';
  const run = await execOn(
    WORKSPACE,
    `cd /workspace/repo && printf '${repo.replaceAll("\n", "\\n")}' > mise.toml && echo "node $(node --version)" && echo "fzf $(fzf --version)" && echo "outside $(cd / && node --version)" && mise ls --current 2>/dev/null | awk '{print $1, $2, $3}'; rm -f mise.toml mise.lock`,
    600_000,
  );
  const line = (name: string) => new RegExp(`^${name} (.*)$`, "m").exec(run.stdout)?.[1] ?? null;
  await writeEvidence("override.json", {
    global,
    repo,
    node: line("node"),
    fzf: line("fzf"),
    outsideRepo: line("outside"),
    miseLs: run.stdout.split("\n").filter((entry) => /^(node|github:|gh|conda:git) /.test(entry)),
    stderr: run.stderr,
    ok: line("node") === "v22.12.0" && line("fzf")?.startsWith("0.56.3") === true && line("outside") === "v24.11.1",
  });
};

/** t3's commit action (the git panel's Commit) of one new file, and the commit it made; the repo reset after. */
const t3Commit = async (root: string, label: string) => {
  await execOn(WORKSPACE, `cd /workspace/repo && git reset -q --hard origin/main && git clean -fdq && echo "${label} $(date +%s)" > pmise-commit.txt`);
  const events = (await wsStream(cookie, "git.runStackedAction", { actionId: uuid(), cwd: root, action: "commit", commitMessage: `pmise: ${label}`, filePaths: ["pmise-commit.txt"] }).catch((error: unknown) => [{ error: String(error).slice(0, 400) }])) as Array<any>;
  const head = await execOn(WORKSPACE, "cd /workspace/repo && git log -1 --format=%s && git reset -q --hard origin/main && git clean -fdq");
  const failed = events.find((event) => event?.kind === "action_failed" || event?.error !== undefined);
  return { events: events.map((event) => event?.kind ?? null), failure: failed === undefined ? null : String(failed.error ?? JSON.stringify(failed)).slice(0, 400), head: head.stdout.trim().split("\n")[0] ?? "" };
};

const gitGh = async () => {
  cookie ||= await pair();
  const { root } = await ensureProject(cookie, WORKSPACE);
  const cases: Array<Case> = [];
  // With no Global mise config: t3's commit action as main's code gives it (the control).
  await setMise("");
  await stopAll();
  const control = await t3Commit(root, "control without a Global mise config");
  // Under the node pin: t3's own status and commit action, a commit through the Workspace's git, and gh.
  await setMise(NODE_PIN);
  await stopAll();
  const gh = await execOn(WORKSPACE, "gh --version | head -1; git --version; node --version");
  const statusAnswer = await wsCall(cookie, "vcs.refreshStatus", { cwd: root }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }));
  const underPin = await t3Commit(root, "under the node pin");
  await execOn(WORKSPACE, `cd /workspace/repo && echo "pmise $(date +%s)" > pmise-commit.txt`);
  const add = await callOn(WORKSPACE, { git: { argv: ["add", "pmise-commit.txt"], cwd: "/workspace/repo", startContainer: true } });
  const commit = await callOn(WORKSPACE, { git: { argv: ["-c", "user.name=pmise", "-c", "user.email=pmise@example.invalid", "commit", "-q", "-m", "pmise: the Workspace's git under the node pin"], cwd: "/workspace/repo", startContainer: true } });
  const head = await execOn(WORKSPACE, "cd /workspace/repo && git log -1 --format=%s && git reset -q --hard origin/main && git clean -fdq");
  cases.push({
    name: "t3's git status, a commit, and gh, under a node pin",
    gh: gh.stdout.trim().split("\n"),
    status: JSON.stringify(statusAnswer).slice(0, 300),
    t3CommitAction: { control, underPin, note: "t3's commit action fails the same way with no Global mise config: t3's temporary object directory is on its own side (not this change)" },
    workspaceGit: { add: add.result?.exitCode ?? null, commit: commit.result?.exitCode ?? null, head: head.stdout.trim().split("\n")[0] ?? "" },
    ok:
      gh.stdout.startsWith("gh version") &&
      gh.stdout.includes("v24.11.1") &&
      !JSON.stringify(statusAnswer).includes('"error"') &&
      head.stdout.startsWith("pmise: the Workspace's git under the node pin") &&
      (underPin.failure === null ? underPin.head === "pmise: under the node pin" : underPin.failure === control.failure),
  });
  // An owner-pinned conda:git: the lay-down gives it the image's system gitconfig (the credential helper).
  const pinned = '[tools]\n"conda:git" = "2.49.0"\n';
  await setMise(pinned);
  await stopAll();
  const fetched = await execOn(
    WORKSPACE,
    `cd /workspace/repo && git --version && echo "helper $(git config --system --get credential.helper | grep -c t3flare/git-credential)" && echo "password $(printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | grep -c '^password=')" && GIT_TERMINAL_PROMPT=0 git fetch -q origin && echo fetched`,
    600_000,
  );
  cases.push({
    name: "an owner-pinned conda:git has the credential helper, and a credentialed fetch works",
    pin: pinned,
    stdout: fetched.stdout.trim().split("\n"),
    stderr: fetched.stderr,
    globalMise: (await stateOf(WORKSPACE))?.globalMise ?? null,
    ok: fetched.stdout.includes("git version 2.49.0") && fetched.stdout.includes("helper 1") && fetched.stdout.includes("password 1") && fetched.stdout.includes("fetched"),
  });
  await writeEvidence("git-gh.json", { cases, ok: cases.every((entry) => entry.ok) });
};

/** A pin whose install takes more than a minute on a cpu-1 Container (one job at a time; measured in the file). */
const LONG_PIN = '[settings]\njobs = 1\n\n[tools]\nnode = "24.11.1"\nrust = "1.91.1"\ngo = "1.25.4"\npython = "3.12.8"\njava = "temurin-21.0.5+11.0.LTS"\ndeno = "2.1.4"\nzig = "0.13.0"\nterraform = "1.10.3"\ndotnet = "9.0.101"\nkotlin = "2.1.0"\ngradle = "8.12"\n';

const hold = async () => {
  cookie ||= await pair();
  const { projectId } = await ensureProject(cookie, WORKSPACE);
  const other = "pmise-b";
  await ensureProject(cookie, other);
  await enableAll();
  await stopAll([WORKSPACE, other]);
  await setEnvironment({ containerIdleMinutes: 1, containerBudget: 1 });
  await setMise(LONG_PIN);
  const started = Date.now();
  // From a Durable agent's bash: computer's path, where the Workspace DO's exec does not hold the Container itself.
  const agent = durableBash(projectId, `node --version > ${OUT_DIR}/node-hold.txt 2>&1`);
  const samples: Array<{ readonly s: number; readonly running: boolean | null; readonly globalMise: string | null }> = [];
  let refused: unknown = null;
  let reason: unknown = null;
  while (Date.now() - started < 12 * 60_000) {
    const state = await stateOf(WORKSPACE);
    samples.push({ s: Math.round((Date.now() - started) / 1000), running: state?.running ?? null, globalMise: state?.globalMise?.outcome ?? null });
    if (reason === null && state?.running === true && Date.now() - started > 35_000) {
      reason = (await callOn(WORKSPACE, { reclaimReason: true })).result;
      // A second Workspace's start at a budget of 1: refused, and the reclaim leaves this one alone.
      const answer = await callOn(other, { exec: { script: "true", timeoutMs: 120_000 } });
      refused = { status: answer.status, answer: JSON.stringify(answer).slice(0, 600) };
    }
    if (state?.globalMise?.outcome !== undefined && state.globalMise.at > started) break;
    await sleep(5_000);
  }
  const turned = await agent;
  const state = await stateOf(WORKSPACE);
  const node = await readOut("node-hold.txt");
  await setEnvironment({ containerIdleMinutes: 2, containerBudget: 3 });
  await writeEvidence("hold.json", {
    pin: LONG_PIN,
    idleMinutes: 1,
    budget: 1,
    installMs: state?.globalMise?.answer?.ms ?? null,
    reclaimReasonDuringInstall: reason,
    otherWorkspaceStart: refused,
    samples,
    agent: turned,
    node,
    globalMise: state?.globalMise ?? null,
    ok: (state?.globalMise?.answer?.ms ?? 0) > 60_000 && reason === "in use" && samples.every((sample) => sample.running !== false || sample.s < 10) && state?.globalMise?.outcome === "laid" && node === "v24.11.1",
  });
};

const restart = async () => {
  cookie ||= await pair();
  await ensureProject(cookie, WORKSPACE);
  const first = NODE_PIN;
  const second = '[tools]\nnode = "22.12.0"\n';
  await setMise(first);
  await stopAll();
  const a = await execOn(WORKSPACE, `cat ${GLOBAL_FILE}; node --version`, 600_000);
  await setMise(second);
  const b = await execOn(WORKSPACE, `cat ${GLOBAL_FILE}; node --version; echo '# an agent edit' >> ${GLOBAL_FILE}; tail -1 ${GLOBAL_FILE}`, 600_000);
  const running = await stateOf(WORKSPACE);
  await stopAll();
  const c = await execOn(WORKSPACE, `cat ${GLOBAL_FILE}; node --version`, 600_000);
  const next = await stateOf(WORKSPACE);
  await writeEvidence("restart.json", {
    first: { text: first, file: a.stdout },
    changedWhileRunning: { text: second, file: b.stdout, launchSha256: running?.launch?.globalMise?.sha256 ?? null, firstSha256: await sha256(first) },
    nextStart: { file: c.stdout, launchSha256: next?.launch?.globalMise?.sha256 ?? null, secondSha256: await sha256(second) },
    ok:
      a.stdout.includes("v24.11.1") &&
      b.stdout.startsWith(first) &&
      b.stdout.includes("v24.11.1") &&
      running?.launch?.globalMise?.sha256 === (await sha256(first)) &&
      c.stdout.startsWith(second) &&
      !c.stdout.includes("an agent edit") &&
      c.stdout.includes("v22.12.0"),
  });
};

const invalid = async () => {
  cookie ||= await pair();
  await ensureProject(cookie, WORKSPACE);
  const text = "this is = = not toml\n";
  await setMise(text);
  await stopAll();
  const run = await execOn(WORKSPACE, `git --version; gh --version | head -1; test -f ${GLOBAL_FILE} && echo laid || echo not-laid`);
  const state = await stateOf(WORKSPACE);
  const shown = await status();
  await writeEvidence("invalid.json", { text, stdout: run.stdout.trim().split("\n"), globalMise: state?.globalMise ?? null, status: shown, ok: run.stdout.includes("git version") && run.stdout.includes("gh version") && run.stdout.includes("not-laid") && state?.globalMise?.outcome === "not-laid" && String(shown).includes("not laid down") });
};

const size = async () => {
  cookie ||= await pair();
  await ensureProject(cookie, WORKSPACE);
  const head = NODE_PIN;
  const filler = "# filler to reach 16 KiB of UTF-8, €\n";
  let text = head;
  while (new TextEncoder().encode(text + filler).length <= 16 * 1024) text += filler;
  text += "#".repeat(16 * 1024 - new TextEncoder().encode(text).length - 1) + "\n";
  const bytes = new TextEncoder().encode(text).length;
  const saved = await setMise(text);
  const over = await harness("POST", "/_t3flare/harness/api/environment", { settings: { globalMiseConfig: `${text}#` } });
  await stopAll();
  const run = await execOn(WORKSPACE, `wc -c < ${GLOBAL_FILE}; sha256sum ${GLOBAL_FILE} | cut -c1-64; node --version`, 600_000);
  const [readBytes, readSha, node] = run.stdout.trim().split("\n");
  await writeEvidence("size.json", { bytes, revision: saved.revision, oneByteMore: { status: over.status, answer: over.json }, read: { bytes: Number(readBytes), sha256: readSha, node }, expectedSha256: await sha256(text), ok: bytes === 16 * 1024 && over.status === 400 && Number(readBytes) === bytes && readSha === (await sha256(text)) && node === "v24.11.1" });
};

/** Seconds from a stopped Container to its first command's answer, through the Workspace DO's exec. */
const startToFirst = async () => {
  await stopAll();
  const started = Date.now();
  const run = await execOn(WORKSPACE, "true", 900_000);
  return { seconds: (Date.now() - started) / 1000, exitCode: run.exitCode, globalMise: (await stateOf(WORKSPACE))?.globalMise ?? null };
};

const cost = async () => {
  cookie ||= await pair();
  await ensureProject(cookie, WORKSPACE);
  await setMise("");
  const without = [await startToFirst(), await startToFirst()];
  await setMise(NODE_PIN);
  const withPin = [await startToFirst(), await startToFirst()];
  await writeEvidence("cost.json", { note: "No install cache: every start installs the owner's tools again.", pin: NODE_PIN, without, withPin, ok: withPin.every((entry) => entry.exitCode === 0 && entry.globalMise?.outcome === "laid") && without.every((entry) => entry.exitCode === 0) });
};

const empty = async () => {
  cookie ||= await pair();
  await ensureProject(cookie, WORKSPACE);
  await setMise("");
  const starts = [await startToFirst(), await startToFirst()];
  const run = await execOn(WORKSPACE, `test -e ${GLOBAL_FILE} && echo present || echo absent; ls /var/lib/t3flare/mise 2>/dev/null | wc -l; node --version; git --version`);
  // A cleared config reports too: Status no longer shows an older start's file.
  const shown = await status();
  await writeEvidence("empty.json", {
    note: "With no Global mise config the lay-down runs nothing (no exec): its outcome is recorded without an answer, and mise resolves from the image's base file alone.",
    starts,
    status: shown,
    after: run.stdout.trim().split("\n"),
    ok: starts.every((entry) => entry.exitCode === 0 && entry.globalMise?.outcome === "none" && entry.globalMise?.answer === undefined) && String(shown).includes("no Global mise config") && run.stdout.startsWith("absent\n0\nv26.13.0"),
  });
};

/** A Durable agent's command cut off while the Container installs never runs afterwards. */
const late = async () => {
  cookie ||= await pair();
  const { projectId } = await ensureProject(cookie, WORKSPACE);
  await enableAll();
  await setMise(LONG_PIN);
  await execOn(WORKSPACE, `mkdir -p ${OUT_DIR} && rm -f ${OUT_DIR}/late-ran`);
  await stopAll();
  const turned = await durableBash(projectId, `touch ${OUT_DIR}/late-ran`, " and timeout 10 (seconds)");
  // The lay-down ends, then computer would have dispatched the command: wait past it.
  const started = Date.now();
  while (Date.now() - started < 12 * 60_000) {
    const state = await stateOf(WORKSPACE);
    if (state?.globalMise?.answer !== undefined && state.globalMise.at > started - 15 * 60_000) break;
    await sleep(5_000);
  }
  await sleep(20_000);
  const ran = await readOut("late-ran");
  await writeEvidence("late.json", {
    pin: LONG_PIN,
    agent: turned,
    ranAfterwards: ran !== null,
    globalMise: (await stateOf(WORKSPACE))?.globalMise ?? null,
    ok: ran === null && turned.outputs.some((output) => output.includes("the Container was installing the Global mise config")),
  });
};

/**
 * A passive read starts the Container (no lay-down for it) and holds it, and a Durable agent's `bash` arrives meanwhile
 * through computer: the agent's command waits for the lay-down and sees the pin; the read never ran it.
 */
const passiveFirst = async () => {
  cookie ||= await pair();
  const { projectId } = await ensureProject(cookie, WORKSPACE);
  await enableAll();
  await setMise(NODE_PIN);
  await execOn(WORKSPACE, `mkdir -p ${OUT_DIR} && rm -f ${OUT_DIR}/node-passive-first.txt`);
  await stopAll();
  const started = Date.now();
  // The admin route's exec with \`passive\`: what t3's first status read does when it starts a stopped Container.
  const read = callOn(WORKSPACE, { exec: { script: `test -f ${GLOBAL_FILE} && echo global-present || echo global-absent; sleep 25; echo read-done`, passive: true, timeoutMs: 180_000 } });
  // Until the Container runs under the passive read, then the agent's command.
  while (Date.now() - started < 120_000 && (await stateOf(WORKSPACE))?.running !== true) await sleep(1_000);
  const agent = await durableBash(projectId, `node --version > ${OUT_DIR}/node-passive-first.txt 2>&1`);
  const readAnswer = await read;
  const node = await readOut("node-passive-first.txt");
  const state = await stateOf(WORKSPACE);
  await writeEvidence("passive-first.json", {
    pin: NODE_PIN,
    passiveRead: { stdout: String(readAnswer.result?.stdout ?? "").trim().split("\n"), exitCode: readAnswer.result?.exitCode ?? null },
    agent,
    node,
    globalMise: state?.globalMise ?? null,
    ok: String(readAnswer.result?.stdout ?? "").includes("global-absent") && node === "v24.11.1" && state?.globalMise?.outcome === "laid",
  });
};

const commands: Record<string, () => Promise<void>> = { variables, install, override, "git-gh": gitGh, hold, restart, invalid, size, cost, empty, late, "passive-first": passiveFirst, "opencode-debug": opencodeDebug };
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: pmise.ts ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
await command();
