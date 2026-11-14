// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-1153's stage harness (Environment skills for the CLI agents; docs/steps/env-skills-cli.md), through t3's own
// calls as the web client makes them, and the Harness panel's API as a script calls it. The Repo fixture
// (apps/environment/test/fixtures/cli-skills/: fruit-code says KIWI-7 at each CLI's root) is written, uncommitted, into
// a clone of the fixture project; the Environment skills come from the fixture repo's branch `spi1153-env`, pushed by
// `fixture`: env-code (its code, MANGO-5, in a reference file), fruit-code (PLUM-9, the same-named pair) and, apart,
// late-code (LATE-8), installed and removed while a CLI's process runs.
//
// Per CLI (codex, pi, claude, opencode), into docs/steps/env-skills-cli/<cli>.json:
// - composer: the snapshot lists env-code with scope `user` at the mount, and the same-named fruit-code as the CLI
//   keeps it (CLI_ROOTS' environmentPrecedence), with the Container stopped before and after;
// - described: on a fresh thread, "what is the environment code?" reads env-code and answers MANGO-5;
// - mention: on a fresh thread, `$env-code` answers MANGO-5, t3 keeping what was typed;
// - pair: `$fruit-code` on that thread: the CLI's winner (PLUM-9 the Environment's, KIWI-7 the Repo's);
// - write: a write through the CLI's linked root (pi: its flag's directory) refused, from the Container's shell and from
//   the agent's own tool, nothing planted;
// - catch-up: late-code installed while the process runs, then a mention and a described turn on that process, then a
//   mention on a new process (the Container stopped); late-code removed, then a mention on the running process.
//
//   node scripts/stage.ts run pclienv pclienv fixture
//   node scripts/stage.ts run pclienv pclienv [codex|pi|claude|opencode …]
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

type Cli = "codex" | "pi" | "claude" | "opencode";
const SONNET = process.env.T3FLARE_PCLIENV_MODEL ?? "anthropic/claude-sonnet-5-5";
const MOUNT = "/workspace/.agents/skills";
/** Each CLI: its instance, model, the Repo root of fruit-code, where its process reads the set, and its winner of the pair. */
const CLIS: Readonly<Record<Cli, { readonly instanceId: string; readonly driver: string; readonly model: string; readonly repoRoot: string; readonly linked: string; readonly winner: "environment" | "repo" | "both" }>> = {
  codex: { instanceId: "codex", driver: "codex", model: process.env.T3FLARE_PCLIENV_CODEX_MODEL ?? "gpt-6-luna", repoRoot: ".agents/skills", linked: "codex/skills/t3flare-environment", winner: "both" },
  pi: { instanceId: "pi", driver: "pi", model: SONNET, repoRoot: ".agents/skills", linked: "", winner: "environment" },
  claude: { instanceId: "claudeAgent", driver: "claudeAgent", model: SONNET, repoRoot: ".claude/skills", linked: "claude/skills", winner: "environment" },
  opencode: { instanceId: "opencode", driver: "opencode", model: SONNET, repoRoot: ".agents/skills", linked: "config/opencode/skills", winner: "repo" },
};
const T3 = process.env.T3_URL ?? "";
const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/env-skills-cli");
const REPO_FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/cli-skills");
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled"]);
const FIXTURE_REPO = "ian-pascoe/t3flare-fixture";
const BRANCH = "spi1153-env";
const PROJECT = process.env.T3FLARE_PCLIENV_PROJECT ?? "pclienv-proj";
const root = `/w/${PROJECT}`;
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };
const scriptHeaders = { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` };

const SECRET_KEYS = /token|authorization|cookie|secret|handle|bearer|credential|csrf/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  }
  return value;
};
const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;
const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(redact({ at: new Date().toISOString(), host: new URL(T3).host, commit: await deployedCommit(), ...value }), null, 1)}\n`);
  console.log(`wrote docs/steps/env-skills-cli/${name} (ok: ${String(value.ok)})`);
};

// ── The fixture repo's branch ────────────────────────────────────────────────────────────────────────────────────────

const git = (cwd: string, ...args: Array<string>) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(0, 300)}`);
  return result.stdout.trim();
};
const SKILL_MD = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const ENV_FILES: Record<string, string> = {
  "skills/env-code/SKILL.md": SKILL_MD("env-code", "How to find the environment code, the code the Cloud Environment keeps. Use whenever anyone asks for the environment code.", "The environment code is written in reference/code.md, next to this file. Read that file and answer with the code alone."),
  "skills/env-code/reference/code.md": "The environment code is MANGO-5.\n",
  "skills/fruit-code/SKILL.md": SKILL_MD("fruit-code", "The fruit code, as the Environment keeps it. Use whenever anyone asks for the fruit code.", "The fruit code is PLUM-9. Answer with the code alone."),
  "late/late-code/SKILL.md": SKILL_MD("late-code", "How to find the late code. Use whenever anyone asks for the late code.", "The late code is LATE-8. Answer with the code alone."),
  "README.md": "SPI-1153's Environment skills fixture branch; moved by apps/environment/scripts/pclienv.ts.\n",
};
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pclienv-"));
  const clone = spawnSync("gh", ["repo", "clone", FIXTURE_REPO, dir, "--", "--depth", "1", "--quiet"], { encoding: "utf8" });
  if (clone.status !== 0) throw new Error(`gh repo clone failed: ${clone.stderr.slice(0, 300)}`);
  git(dir, "checkout", "--orphan", BRANCH);
  git(dir, "rm", "-rf", "--quiet", ".");
  for (const [file, content] of Object.entries(ENV_FILES)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t3flare stage", "-c", "user.email=stage@t3flare.invalid", "commit", "--quiet", "-m", `pclienv: ${BRANCH}`);
  git(dir, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${BRANCH}`);
  console.log(`pushed ${BRANCH} at ${git(dir, "rev-parse", "HEAD").slice(0, 7)}`);
  fs.rmSync(dir, { recursive: true, force: true });
};

// ── The panel's API, the Workspace, the client ───────────────────────────────────────────────────────────────────────

const harness = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(new URL(`/_t3flare/harness/api/${pathname}`, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...scriptHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) as any };
  } catch {
    return { status: response.status, json: text.trim() as any };
  }
};
const installed = async () => ((await harness("GET", "skills")).json.skills as Array<any>).map((skill) => skill.name as string);
const install = async (folder: "skills" | "late") => {
  const source = `https://github.com/${FIXTURE_REPO}/tree/${BRANCH}/${folder}`;
  const preview = await harness("POST", "skills/preview", { source });
  if (preview.status !== 200) throw new Error(`preview of ${source}: ${JSON.stringify(preview.json).slice(0, 300)}`);
  const folders = (preview.json.skills as Array<any>).filter((skill) => skill.problems.length === 0 && skill.unchanged !== true).map((skill) => skill.path);
  if (folders.length === 0) return { status: 200, skipped: "unchanged" };
  const answer = await harness("POST", "skills/install", { source, commit: preview.json.commit, folders });
  return { status: answer.status, commit: preview.json.commit, folders };
};
const remove = async (name: string) => (await harness("POST", "skills/remove", { name })).status;

const call = async (body: unknown) => {
  const response = await fetch(new URL(`/_t3flare/agents/workspace-call?id=${PROJECT}`, T3), { method: "POST", redirect: "manual", headers: { ...scriptHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return JSON.parse(text) as { result: any; container: any };
  } catch {
    return { result: text.slice(0, 500), container: undefined };
  }
};
const sh = async (script: string) => {
  const answer = await call({ exec: { script, timeoutMs: 120_000 } });
  return { exitCode: answer.result?.exitCode ?? null, stdout: String(answer.result?.stdout ?? "").slice(0, 3000), stderr: String(answer.result?.stderr ?? "").slice(0, 1000) };
};
const containerOf = async () => {
  const row = (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).find((candidate) => candidate.id === PROJECT);
  return { running: row?.container?.running ?? null };
};
const stopContainer = async () => {
  const started = Date.now();
  while (Date.now() - started < 240_000) {
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${PROJECT}`);
    if ((await containerOf()).running === false) return;
    await sleep(4000);
  }
  throw new Error("the Container did not stop");
};

let cookie = "";
let projectId = "";

const composerSnapshot = async (instanceId: string) => {
  const reply = (await wsCall(cookie, "server.refreshProviders", { instanceId, cwd: root, fresh: true }).catch((error: unknown) => ({ error: String(error).slice(0, 400) }))) as any;
  const provider = (reply?.providers ?? []).find((candidate: any) => candidate.instanceId === instanceId);
  const scoped = (provider?.workspaceSnapshots ?? []).find((snapshot: any) => snapshot.cwd === root) ?? provider?.workspaceSnapshots?.[0];
  return { error: reply?.error ?? null, skills: ((scoped?.skills ?? []) as Array<any>).filter((skill) => ["env-code", "fruit-code", "late-code"].includes(skill.name)) };
};

const settle = async (threadId: string, ordinal: number, timeoutMs = 8 * 60_000): Promise<any> => {
  const started = Date.now();
  let current: any;
  const answered = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    current = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (current?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      answered.add(request.id);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: "accept" }).catch(() => undefined);
    }
    const runs = runsOf(current);
    if (runs.some((run: any) => run.ordinal >= ordinal) && runs.every((run) => SETTLED.has(run.status))) return current;
    await sleep(1500);
  }
  throw new Error(`timed out: runs ${JSON.stringify(runsOf(current).map((run) => run.status))}`);
};

interface Thread {
  readonly cli: Cli;
  readonly threadId: string;
  ordinal: number;
}
const newThread = async (cli: Cli, title: string): Promise<Thread> => {
  const threadId = uuid();
  const model = { instanceId: CLIS[cli].instanceId, model: CLIS[cli].model, options: [] };
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title, modelSelection: model, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  return { cli, threadId, ordinal: 0 };
};
const IDS = new Set(["id", "threadId", "runId", "nodeId", "providerThreadId", "providerTurnId", "createdAt", "updatedAt", "startedAt", "completedAt", "nativeItemRef", "parentItemId"]);
const turn = async (thread: Thread, text: string) => {
  thread.ordinal += 1;
  const model = { instanceId: CLIS[thread.cli].instanceId, model: CLIS[thread.cli].model, options: [] };
  await sendMessage(cookie, thread.threadId, text, model);
  const view = await settle(thread.threadId, thread.ordinal);
  const run = runsOf(view).find((candidate: any) => candidate.ordinal === thread.ordinal) as any;
  const items = itemsOf(view).filter((item: any) => item.runId === run?.id);
  return {
    sent: text,
    status: run?.status ?? null,
    failure: run?.failure ?? run?.error ?? null,
    typed: items.find((item: any) => item.type === "user_message")?.text ?? null,
    answer: String(items.filter((item: any) => item.type === "assistant_message").at(-1)?.text ?? "").slice(0, 600),
    tools: items
      .filter((item: any) => !["user_message", "assistant_message", "reasoning", "checkpoint"].includes(item.type))
      .map((item: any) => JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => !IDS.has(key)))).slice(0, 900)),
  };
};
const touches = (step: { tools: ReadonlyArray<string> }, name: string) => step.tools.some((tool) => tool.includes(name));

/** Where the CLI's live process reads the set: its linked root in its home (pi: the mount its flag names), and the link's target. */
const linkedRoot = async (cli: Cli) => {
  if (CLIS[cli].linked === "") return { at: MOUNT, target: null, live: null };
  const found = await sh(`for d in /var/lib/t3flare/cli/proc-*/${CLIS[cli].linked}; do [ -L "$d" ] && echo "$d $(readlink "$d")"; done`);
  const line = found.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const [at, target] = line.split(" ");
  return { at: at ?? null, target: target ?? null, live: found };
};

// ── Per CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const probeCli = async (cli: Cli) => {
  const spec = CLIS[cli];
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: spec.instanceId, instance: { driver: spec.driver, enabled: true } } });
  if ((await installed()).includes("late-code")) await remove("late-code");
  const setup = await install("skills");
  const checks: Record<string, boolean> = {};
  const steps: Record<string, any> = { setup };

  // The composer, the Container stopped.
  await stopContainer();
  const before = await containerOf();
  const snapshot = await composerSnapshot(spec.instanceId);
  const after = await containerOf();
  const envCode = snapshot.skills.find((skill: any) => skill.name === "env-code");
  const fruit = snapshot.skills.filter((skill: any) => skill.name === "fruit-code").map((skill: any) => ({ scope: skill.scope, path: skill.path }));
  checks.composerListsEnvironmentSkill = envCode?.scope === "user" && envCode?.path === `${MOUNT}/env-code/SKILL.md`;
  const environmentFruit = { scope: "user", path: `${MOUNT}/fruit-code/SKILL.md` };
  const repoFruit = { scope: "project", path: `${root}/${spec.repoRoot}/fruit-code/SKILL.md` };
  const expectedFruit = spec.winner === "environment" ? [environmentFruit] : spec.winner === "repo" ? [repoFruit] : [repoFruit, environmentFruit];
  checks.composerFollowsCliPrecedence = JSON.stringify(fruit) === JSON.stringify(expectedFruit);
  checks.noContainerForComposer = before.running === false && after.running === false;

  // A description-matched turn on a fresh process.
  const described = await newThread(cli, `spi-1153 ${cli}: described`);
  steps.described = await turn(described, "What is the environment code? Reply with the code alone.");
  checks.describedReadsSkill = steps.described.answer.includes("MANGO-5") && touches(steps.described, "env-code");

  // A mention, on another fresh process (the Container stopped: a Workspace runs few CLI processes at once).
  await stopContainer();
  const mentioned = await newThread(cli, `spi-1153 ${cli}: mention`);
  steps.mention = await turn(mentioned, "$env-code");
  checks.mentionFollows = steps.mention.answer.includes("MANGO-5") && steps.mention.typed === "$env-code";

  // The same-named pair.
  steps.pair = await turn(mentioned, "$fruit-code What is the fruit code? Reply with the code alone.");
  const plum = steps.pair.answer.includes("PLUM-9");
  const kiwi = steps.pair.answer.includes("KIWI-7");
  steps.pairWinner = plum && !kiwi ? "environment" : kiwi && !plum ? "repo" : "unclear";
  // Codex lists both and a bare mention picks neither: the model's pick is recorded, not checked.
  checks.pairWinnerIsCli = spec.winner === "both" ? steps.pairWinner !== "unclear" : steps.pairWinner === spec.winner;

  // A write through the linked root: from the Container's shell, and the agent's own.
  const linked = await linkedRoot(cli);
  steps.linkedRoot = linked;
  checks.linkedToMount = cli === "pi" || linked.target === MOUNT;
  const at = linked.at ?? MOUNT;
  steps.shellWrite = await sh(
    [
      `if touch '${at}/planted' 2>/tmp/w.err; then echo "touch: written"; else echo "touch: refused: $(cat /tmp/w.err)"; fi`,
      `if printf x > '${at}/env-code/SKILL.md' 2>/tmp/w.err; then echo "overwrite: written"; else echo "overwrite: refused: $(cat /tmp/w.err)"; fi`,
      `ls '${at}'`,
    ].join("\n"),
  );
  steps.agentWrite = await turn(mentioned, `Run exactly this shell command and reply with its error output verbatim: touch '${at}/planted-by-agent'`);
  steps.afterWrites = await sh(`ls -la '${MOUNT}' '${MOUNT}/env-code'; head -c 400 '${MOUNT}/env-code/SKILL.md'`);
  checks.writeRefused =
    steps.shellWrite.stdout.includes("touch: refused") &&
    steps.shellWrite.stdout.includes("overwrite: refused") &&
    /read-only/i.test(`${steps.agentWrite.answer} ${steps.agentWrite.tools.join(" ")}`) &&
    !steps.afterWrites.stdout.includes("planted") &&
    steps.afterWrites.stdout.includes("name: env-code");

  // Catch-up: installed while this process runs.
  steps.lateInstall = await install("late");
  steps.lateMention = await turn(mentioned, "$late-code What is the late code? Reply with the code alone.");
  steps.lateDescribed = await turn(mentioned, "What is the late code? Reply with the code alone.");
  // A new process (the Container stopped; the thread resumes).
  await stopContainer();
  steps.lateMentionNewProcess = await turn(mentioned, "$late-code What is the late code? Reply with the code alone.");
  checks.lateSeenByNewProcess = steps.lateMentionNewProcess.answer.includes("LATE-8");
  // Removed while that process runs.
  steps.lateRemove = await remove("late-code");
  steps.lateRemovedMention = await turn(mentioned, "$late-code What is the late code? If you cannot find it, reply NONE.");
  steps.lateRemovedMount = await sh(`ls '${MOUNT}'`);
  checks.lateGoneFromMount = !steps.lateRemovedMount.stdout.includes("late-code");
  steps.catchUp = {
    installRunningMention: steps.lateMention.answer.includes("LATE-8"),
    installRunningDescribed: steps.lateDescribed.answer.includes("LATE-8"),
    installNewProcess: steps.lateMentionNewProcess.answer.includes("LATE-8"),
    removedRunningMention: steps.lateRemovedMention.answer.includes("LATE-8") ? "still answered LATE-8" : "not answered",
  };

  const ok = Object.values(checks).every(Boolean);
  console.log(`${cli}: ${ok ? "ok" : "FAIL"} ${JSON.stringify(checks)} catch-up ${JSON.stringify(steps.catchUp)}`);
  return { ok, cli, model: spec.model, expectedWinner: spec.winner, checks, composer: { container: { before, after }, ...snapshot }, threads: { described: described.threadId, mentioned: mentioned.threadId }, steps };
};

const asked = process.argv.slice(2);
if (asked[0] === "fixture") {
  fixture();
} else {
  cookie = await pair();
  projectId = (await ensureProject(cookie, PROJECT)).projectId;
  for (const file of fs.readdirSync(REPO_FIXTURE, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())) {
    const full = path.join(file.parentPath, file.name);
    await wsCall(cookie, "projects.writeFile", { cwd: root, relativePath: path.relative(REPO_FIXTURE, full), contents: fs.readFileSync(full, "utf8") });
  }
  let failed = false;
  for (const cli of (asked.length === 0 ? Object.keys(CLIS) : asked) as Array<Cli>) {
    try {
      const result = await probeCli(cli);
      await writeEvidence(`${cli}.json`, { project: { id: PROJECT, root }, ...result });
      if (!result.ok) failed = true;
    } catch (error) {
      console.error(`${cli}: ${String(error).slice(0, 600)}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}
