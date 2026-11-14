// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-1153's stage harness (Environment skills for the CLI agents; docs/steps/env-skills-cli.md), through t3's own
// calls as the web client makes them, and the Harness panel's API as a script calls it. The Repo fixture
// (apps/environment/test/fixtures/cli-skills/, and a `pair-<word>` Skill in each CLI Repo root, `PAIRS`) is written,
// uncommitted, into a clone of the fixture project; the Environment skills come from the fixture repo's branch
// `spi1153-env`, pushed by `fixture`: env-code (its code, MANGO-5, in a reference file), a `pair-<word>` of each name
// (the same-named pairs: the Repo's says REPO-<WORD>, the Environment's ENV-<WORD>) and, apart, late-code (LATE-8),
// installed and removed while a CLI's process runs.
//
// Per CLI (codex, pi, claude, opencode), into docs/steps/env-skills-cli/<cli>.json:
// - composer: the snapshot lists env-code with scope `user` at the mount, and each pair in the CLI's Repo roots as the
//   CLI keeps it by that root (`CLI_ROOTS`' `environment`), with the Container stopped before and after;
// - described: on a fresh thread, "what is the environment code?" reads env-code and answers MANGO-5;
// - mention: on a fresh thread, `$env-code` answers MANGO-5, t3 keeping what was typed;
// - pairs, per Repo root, each on a fresh thread: a description-matched turn (the CLI's own choice of the pair) and a
//   mention (the composer's and, for OpenCode, t3flare's embed), both against that root's winner;
// - write: a write through the CLI's linked root (pi: its flag's directory) refused, from the Container's shell and from
//   the agent's own tool, nothing planted;
// - catch-up, each on a thread whose history never held the late code: two processes started, late-code installed,
//   then a mention on one and a described turn on the other; removed while a process that started with it runs, then
//   a mention; installed again, then a mention on a new process (the Container stopped).
//
//   node scripts/stage.ts run pclienv pclienv fixture
//   node scripts/stage.ts run pclienv pclienv [codex|pi|claude|opencode …]
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CLI_ROOTS, type EnvironmentPrecedence } from "@t3flare/skills";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

type Cli = "codex" | "pi" | "claude" | "opencode";
const SONNET = process.env.T3FLARE_PCLIENV_MODEL ?? "anthropic/claude-sonnet-5-5";
const MOUNT = "/workspace/.agents/skills";
/** Each CLI: its instance, model, and where its process reads the set (pi: none, its flag names the mount). */
const CLIS: Readonly<Record<Cli, { readonly instanceId: string; readonly driver: string; readonly model: string; readonly linked: string }>> = {
  codex: { instanceId: "codex", driver: "codex", model: process.env.T3FLARE_PCLIENV_CODEX_MODEL ?? "gpt-6-luna", linked: "codex/skills/t3flare-environment" },
  pi: { instanceId: "pi", driver: "pi", model: SONNET, linked: "" },
  claude: { instanceId: "claudeAgent", driver: "claudeAgent", model: SONNET, linked: "claude/skills" },
  opencode: { instanceId: "opencode", driver: "opencode", model: SONNET, linked: "config/opencode/skills" },
};
/** A same-named pair per CLI Repo root, by a neutral word (so a question does not name the root). */
const PAIRS: Readonly<Record<string, string>> = {
  ".agents/skills": "amber",
  ".codex/skills": "birch",
  ".pi/skills": "cedar",
  ".claude/skills": "dune",
  ".opencode/skills": "ember",
  ".opencode/skill": "fjord",
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
/** A pair's Skill, the same name and description on both sides; only its code says which side it is. */
const pairMd = (word: string, code: string) => SKILL_MD(`pair-${word}`, `How to find the ${word} pair code. Use whenever anyone asks for the ${word} pair code.`, `The ${word} pair code is ${code}. Answer with the code alone.`);
const ENV_FILES: Record<string, string> = {
  "skills/env-code/SKILL.md": SKILL_MD("env-code", "How to find the environment code, the code the Cloud Environment keeps. Use whenever anyone asks for the environment code.", "The environment code is written in reference/code.md, next to this file. Read that file and answer with the code alone."),
  "skills/env-code/reference/code.md": "The environment code is MANGO-5.\n",
  ...Object.fromEntries(Object.values(PAIRS).map((word) => [`skills/pair-${word}/SKILL.md`, pairMd(word, `ENV-${word.toUpperCase()}`)])),
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
  return { error: reply?.error ?? null, skills: ((scoped?.skills ?? []) as Array<any>).filter((skill) => ["env-code", "late-code"].includes(skill.name) || String(skill.name).startsWith("pair-")) };
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

/** Which side a pair's answer came from. */
const sideOf = (answer: string, word: string): "environment" | "repo" | "unclear" => {
  const environment = answer.includes(`ENV-${word.toUpperCase()}`);
  const repo = answer.includes(`REPO-${word.toUpperCase()}`);
  return environment && !repo ? "environment" : repo && !environment ? "repo" : "unclear";
};
/** Whether `side` is what a root whose winner is `expected` gives: Codex's `both` picks neither, so any side. */
const agrees = (side: string, expected: EnvironmentPrecedence) => (expected === "both" ? side !== "unclear" : side === expected);

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
  checks.composerListsEnvironmentSkill = envCode?.scope === "user" && envCode?.path === `${MOUNT}/env-code/SKILL.md`;
  const roots = CLI_ROOTS[cli].skills.map((root) => ({ directory: root.directory, word: PAIRS[root.directory]!, expected: root.environment! }));
  steps.composerPairs = roots.map(({ directory, word, expected }) => {
    const listed = snapshot.skills.filter((skill: any) => skill.name === `pair-${word}`).map((skill: any) => ({ scope: skill.scope, path: skill.path }));
    const environment = { scope: "user", path: `${MOUNT}/pair-${word}/SKILL.md` };
    const repo = { scope: "project", path: `${root}/${directory}/pair-${word}/SKILL.md` };
    const wanted = expected === "environment" ? [environment] : expected === "repo" ? [repo] : [repo, environment];
    return { root: directory, expected, listed, ok: JSON.stringify(listed) === JSON.stringify(wanted) };
  });
  checks.composerFollowsCliPerRoot = steps.composerPairs.every((pair: any) => pair.ok);
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

  // The same-named pairs, one per Repo root, each turn on a fresh thread: the CLI's own choice (described) and the
  // mention (t3's composer, and t3flare's embed for OpenCode), both against the root's winner.
  steps.pairs = [];
  for (const { directory, word, expected } of roots) {
    await stopContainer();
    const own = await newThread(cli, `spi-1153 ${cli}: pair ${word} described`);
    const ownTurn = await turn(own, `What is the ${word} pair code? Reply with the code alone.`);
    const byMention = await newThread(cli, `spi-1153 ${cli}: pair ${word} mention`);
    const mentionTurn = await turn(byMention, `$pair-${word} What is the ${word} pair code? Reply with the code alone.`);
    const cliChose = sideOf(ownTurn.answer, word);
    const mentionGave = sideOf(mentionTurn.answer, word);
    steps.pairs.push({ root: directory, word, expected, cliChose, mentionGave, described: ownTurn, mention: mentionTurn });
  }
  checks.pairsCliChoiceIsRoots = steps.pairs.every((pair: any) => agrees(pair.cliChose, pair.expected));
  checks.pairsMentionIsRoots = steps.pairs.every((pair: any) => agrees(pair.mentionGave, pair.expected));

  // Catch-up, each turn on a thread whose history never held the late code. Two processes started before the install:
  await stopContainer();
  const lateA = await newThread(cli, `spi-1153 ${cli}: catch-up mention`);
  steps.lateStartA = await turn(lateA, "Reply with the single word OK.");
  const lateB = await newThread(cli, `spi-1153 ${cli}: catch-up described`);
  steps.lateStartB = await turn(lateB, "Reply with the single word OK.");
  steps.lateInstall = await install("late");
  steps.lateMention = await turn(lateA, "$late-code What is the late code? If you cannot find it, reply NONE.");
  steps.lateDescribed = await turn(lateB, "What is the late code? If you cannot find it, reply NONE.");
  // A process that started with it, then removed while it runs.
  await stopContainer();
  const late = await newThread(cli, `spi-1153 ${cli}: catch-up removal`);
  steps.lateStart = await turn(late, "Reply with the single word OK.");
  steps.lateRemove = await remove("late-code");
  // The turn has the Workspace take the set first: the mount holds no late-code from then on, whatever the process kept.
  steps.lateRemovedMention = await turn(late, "$late-code What is the late code? If you cannot find it, reply NONE.");
  steps.lateRemovedMount = await sh(`ls '${MOUNT}'`);
  checks.lateGoneFromMount = !steps.lateRemovedMount.stdout.includes("late-code");
  // Installed again, then a new process on another fresh thread.
  steps.lateReinstall = await install("late");
  await stopContainer();
  const fresh = await newThread(cli, `spi-1153 ${cli}: catch-up new process`);
  steps.lateMentionNewProcess = await turn(fresh, "$late-code What is the late code? If you cannot find it, reply NONE.");
  checks.lateSeenByNewProcess = steps.lateMentionNewProcess.answer.includes("LATE-8");
  await remove("late-code");
  steps.catchUp = {
    installRunningMention: steps.lateMention.answer.includes("LATE-8"),
    installRunningDescribed: steps.lateDescribed.answer.includes("LATE-8"),
    removedRunningMention: steps.lateRemovedMention.answer.includes("LATE-8"),
    installNewProcess: steps.lateMentionNewProcess.answer.includes("LATE-8"),
  };

  const ok = Object.values(checks).every(Boolean);
  console.log(`${cli}: ${ok ? "ok" : "FAIL"} ${JSON.stringify(checks)} pairs ${JSON.stringify(steps.pairs.map((pair: any) => [pair.root, pair.expected, pair.cliChose, pair.mentionGave]))} catch-up ${JSON.stringify(steps.catchUp)}`);
  return {
    ok,
    cli,
    model: spec.model,
    checks,
    composer: { container: { before, after }, ...snapshot },
    threads: { described: described.threadId, mentioned: mentioned.threadId, lateA: lateA.threadId, lateB: lateB.threadId, late: late.threadId, fresh: fresh.threadId },
    steps,
  };
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
  for (const [directory, word] of Object.entries(PAIRS)) {
    await wsCall(cookie, "projects.writeFile", { cwd: root, relativePath: `${directory}/pair-${word}/SKILL.md`, contents: pairMd(word, `REPO-${word.toUpperCase()}`) });
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
