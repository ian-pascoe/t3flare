// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-1150's stage evidence (stage `pmise`): the Global mise config through the panel's API, laid down in the Containers
// that start with it, and what every command path's environment carries. Run through the stage's `run`, which sets the
// stage's service token and admin token (never printed):
//
//   node scripts/stage.ts run pmise pmise variables   the guard variables from every command path (variables.json; first)
//
// Evidence goes to docs/steps/global-mise/, each file naming the deployed commit.
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, DEFAULT_MODEL, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, SETTLED, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";
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
    ms: Date.now() - started,
  };
};

const durableModel = DEFAULT_MODEL as { instanceId: string; model: string; options: [] };
const cliModel = (cli: Cli) => ({ instanceId: CLIS[cli].instanceId, model: CLIS[cli].model, options: [] as [] });
const enableAll = async () => {
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  for (const cli of Object.values(CLIS)) await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: cli.instanceId, instance: { driver: cli.driver, enabled: true } } });
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
echo "token [$(mise token github 2>&1 | tr '\\n' ' ' | sed -E 's/(gh[a-z]_[A-Za-z0-9]{4})[A-Za-z0-9]+/\\1…/g; s/ $//')]"
} > ${VARS_DIR}/vars-$who.txt 2>&1
echo pmise-vars-done-$who
`;

const parseVars = (text: string) => {
  const env: Record<string, string | null> = {};
  const settings: Record<string, string> = {};
  let token: string | null = null;
  let home: string | null = null;
  for (const line of text.split("\n")) {
    let match = /^env (\w+)=\[(.*)\]$/.exec(line);
    if (match !== null) env[match[1]!] = match[2]!;
    match = /^env (\w+) unset$/.exec(line);
    if (match !== null) env[match[1]!] = null;
    match = /^setting ([\w.]+)=\[(.*)\]$/.exec(line);
    if (match !== null) settings[match[1]!] = match[2]!;
    match = /^token \[(.*)\]$/.exec(line);
    if (match !== null) token = match[1]!;
    match = /^home=(.*)$/.exec(line);
    if (match !== null) home = match[1]!;
  }
  return { home, env, settings, token };
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
  const written = await execOn(WORKSPACE, `mkdir -p ${VARS_DIR} && rm -f ${VARS_DIR}/vars-*.txt && cat > ${VARS_DIR}/vars.sh <<'PMISE_EOF'\n${VARS_SCRIPT}PMISE_EOF\necho ok`);
  if (!written.stdout.includes("ok")) throw new Error(`could not write the check: ${JSON.stringify(written)}`);
  const paths: Array<{ who: string; how: string; detail: unknown }> = [];
  const run = `bash ${VARS_DIR}/vars.sh`;

  // The Workspace DO's own command (computerd's env, WorkspaceDO.exec).
  paths.push({ who: "workspace-exec", how: "the Workspace DO's exec (t3's git and the admin route take this path)", detail: await execOn(WORKSPACE, `${run} workspace-exec`) });

  // A Durable agent's bash (computer's stub from the Session, computerd's env).
  paths.push({
    who: "durable",
    how: "a Durable agent's bash on the Container",
    detail: await turn(projectId, durableModel, `Call the bash tool once with command \`${run} durable\` and backend \`container\`. Then reply with the single word done.`),
  });

  // A t3 Terminal (the platform's exec, terminalEnv).
  const terminal = await attachTerminal(cookie, { threadId: `pmise-${uuid()}`, terminalId: "default", cwd: root });
  await terminal.until(/[$#] $/, 180_000);
  const typed = await terminal.run(`${run} terminal`, 120_000).catch((error: unknown) => ({ ms: -1, text: String(error).slice(0, 400) }));
  await terminal.close(true).catch(() => undefined);
  await terminal.detach().catch(() => undefined);
  paths.push({ who: "terminal", how: "a t3 Terminal", detail: { ms: typed.ms, tail: stripAnsi(typed.text).slice(-300) } });

  // A command each CLI agent runs (the platform's exec, then each CLI's own handling of its children's environment).
  for (const cli of Object.keys(CLIS) as Array<Cli>) {
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
    if (text === undefined) return { ...entry, ran: false, ok: false };
    const parsed = parseVars(text);
    const arrived = Object.fromEntries(Object.entries(EXPECTED_ENV).map(([name, value]) => [name, parsed.env[name] === value]));
    const falseGuards = arrived.MISE_GITHUB_GH_CLI_TOKENS === true && arrived.MISE_GITHUB_USE_GIT_CREDENTIALS === true;
    const emptyGuards = arrived.MISE_GITHUB_CREDENTIAL_COMMAND === true && arrived.MISE_DISABLE_TOOLS === true && arrived.MISE_DISABLE_BACKENDS === true;
    return { ...entry, ran: true, ...parsed, arrived, falseGuards, emptyGuards, noToken: parsed.token !== null && parsed.token.includes("(none)"), ok: falseGuards && emptyGuards && parsed.token?.includes("(none)") === true };
  });
  await writeEvidence("variables.json", {
    note: "Each path ran `vars.sh` with a gh hosts.yml in its own home: the variables as its command has them (null: unset), mise's resolved settings, and the token mise would send.",
    results,
    ok: results.every((entry) => entry.ok),
  });
};

const commands: Record<string, () => Promise<void>> = { variables };
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: pmise.ts ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
await command();
// Unused until later cases; kept for them.
void stopOn;
void stateOf;
void setEnvironment;
