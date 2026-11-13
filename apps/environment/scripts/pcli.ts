// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-1151's stage harness (the CLI agents' Skills and Slash commands in t3's composer; docs/steps/spi-1151.md),
// through t3's own calls as the web client makes them. The fixture (apps/environment/test/fixtures/cli-skills/) is
// written, uncommitted, into a clone of the fixture project with t3's file write.
//
// Per CLI (codex, pi, claude, opencode), into docs/steps/spi-1151/<cli>.json:
// - snapshot: the composer's snapshot of the project lists fruit-code at that CLI's root and its repo command (`/echo`,
//   but Codex, which has none), after the built-ins, with the Container stopped before and after;
// - described: on a fresh thread, "what is the fruit code?" reads the Skill and answers KIWI-7;
// - mention: on a fresh thread, `$fruit-code` answers KIWI-7, t3 keeping what was typed (Claude Code: R6, whether the
//   native `/fruit-code` expands without the agent reading SKILL.md; and a mention that does not open the message);
// - command: `/echo a` answers from the repo's command;
// - built-ins: `/compact` (and Codex's `/goal`) run.
//
//   node scripts/stage.ts run pcli pcli [codex|pi|claude|opencode …]
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { tailing } from "./lib/tail.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

type Cli = "codex" | "pi" | "claude" | "opencode";
const SONNET = process.env.T3FLARE_PCLI_MODEL ?? "anthropic/claude-sonnet-5-5";
const CLIS: Readonly<Record<Cli, { readonly instanceId: string; readonly driver: string; readonly model: string; readonly root: string; readonly echo: string | null }>> = {
  codex: { instanceId: "codex", driver: "codex", model: process.env.T3FLARE_PCLI_CODEX_MODEL ?? "gpt-6-luna", root: ".agents/skills", echo: null },
  pi: { instanceId: "pi", driver: "pi", model: SONNET, root: ".agents/skills", echo: "ECHO a none" },
  claude: { instanceId: "claudeAgent", driver: "claudeAgent", model: SONNET, root: ".claude/skills", echo: "ECHO a" },
  // OpenCode's `/echo` is run, not listed: over ACP its reply never reaches t3.
  opencode: { instanceId: "opencode", driver: "opencode", model: SONNET, root: ".agents/skills", echo: "ECHO a" },
};
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1151");
const FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/cli-skills");
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled"]);

const SECRET_KEYS = /token|authorization|cookie|secret|handle|bearer|credential|csrf/i;
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner)]));
  }
  return value;
};
const writeEvidence = (name: string, value: unknown) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(redact({ at: new Date().toISOString(), ...(value as object) }), null, 1)}\n`);
  console.log(`wrote docs/steps/spi-1151/${name}`);
};

let cookie = "";

const fixtureFiles = (): Array<{ relativePath: string; contents: string }> => {
  const out: Array<{ relativePath: string; contents: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ relativePath: path.relative(FIXTURE, full), contents: fs.readFileSync(full, "utf8") });
    }
  };
  walk(FIXTURE);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};
const writeFixture = async (cwd: string) => {
  for (const file of fixtureFiles()) await wsCall(cookie, "projects.writeFile", { cwd, ...file });
  return fixtureFiles().map((file) => file.relativePath);
};

const containerOf = async (id: string) => {
  const row = (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).find((candidate) => candidate.id === id);
  return { running: row?.container?.running ?? null, leased: row?.container?.leased ?? null };
};
const stopContainer = async (id: string) => {
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(id)}`);
    if ((await containerOf(id)).running === false) return;
    await sleep(3000);
  }
  throw new Error(`the Container of ${id} did not stop`);
};

/** The composer's snapshot of `cwd` for one provider instance, fresh, as the client asks for it. */
const composerSnapshot = async (instanceId: string, cwd: string) => {
  const reply = (await wsCall(cookie, "server.refreshProviders", { instanceId, cwd, fresh: true }).catch((error: unknown) => ({ error: String(error).slice(0, 400) }))) as any;
  const provider = (reply?.providers ?? []).find((candidate: any) => candidate.instanceId === instanceId);
  const scoped = (provider?.workspaceSnapshots ?? []).find((snapshot: any) => snapshot.cwd === cwd) ?? provider?.workspaceSnapshots?.[0];
  return { error: reply?.error ?? null, snapshotCwd: scoped?.cwd ?? null, skills: scoped?.skills ?? null, slashCommands: scoped?.slashCommands ?? null, slashCommandsPending: scoped?.slashCommandsPending ?? null };
};

const projection = async (threadId: string): Promise<any> => projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
const settle = async (threadId: string, ordinal: number, timeoutMs = 8 * 60_000): Promise<any> => {
  const started = Date.now();
  let current: any;
  const answered = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    current = await projection(threadId);
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

const newThread = async (cli: Cli, projectId: string, title: string) => {
  const threadId = uuid();
  const model = { instanceId: CLIS[cli].instanceId, model: CLIS[cli].model, options: [] };
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title, modelSelection: model, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  return threadId;
};

const IDS = new Set(["id", "threadId", "runId", "nodeId", "providerThreadId", "providerTurnId", "createdAt", "updatedAt", "startedAt", "completedAt", "nativeItemRef", "parentItemId"]);
/** One turn: what t3 kept as the owner's message, the run's status and failure, the answer, and the tools it ran. */
const turn = async (cli: Cli, threadId: string, ordinal: number, text: string) => {
  const model = { instanceId: CLIS[cli].instanceId, model: CLIS[cli].model, options: [] };
  await sendMessage(cookie, threadId, text, model);
  const view = await settle(threadId, ordinal);
  const run = runsOf(view).find((candidate: any) => candidate.ordinal === ordinal) as any;
  const items = itemsOf(view).filter((item: any) => item.runId === run?.id);
  const typed = items.find((item: any) => item.type === "user_message")?.text ?? null;
  const answer = String(items.filter((item: any) => item.type === "assistant_message").at(-1)?.text ?? "");
  const tools = items
    .filter((item: any) => !["user_message", "assistant_message", "reasoning", "checkpoint"].includes(item.type))
    .map((item: any) => JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => !IDS.has(key)))).slice(0, 900));
  const kinds = items.map((item: any) => `${item.type}:${item.status ?? ""}${item.type === "assistant_message" ? `:${String(item.text ?? "").length}` : ""}`);
  return { sent: text, status: run?.status ?? null, failure: run?.failure ?? run?.error ?? null, typed, answer: answer.slice(0, 600), tools, kinds };
};
const readsSkillMd = (step: { tools: ReadonlyArray<string> }) => step.tools.some((tool) => tool.includes("fruit-code/SKILL.md"));
const touchesSkill = (step: { tools: ReadonlyArray<string> }) => step.tools.some((tool) => tool.includes("fruit-code"));

const probeCli = async (cli: Cli, projectId: string, root: string, id: string) => {
  const spec = CLIS[cli];
  await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: spec.instanceId, instance: { driver: spec.driver, enabled: true } } });
  // The snapshot, with the Container stopped (each CLI's turns below start it).
  await stopContainer(id);
  const before = await containerOf(id);
  const snapshot = await composerSnapshot(spec.instanceId, root);
  const after = await containerOf(id);
  const fruit = (snapshot.skills ?? []).find((skill: any) => skill.name === "fruit-code");
  const commands = (snapshot.slashCommands ?? []).map((command: any) => command.name);
  const builtIns = cli === "codex" ? ["compact", "goal"] : cli === "pi" ? ["compact"] : [];
  const checks: Record<string, boolean> = {
    snapshotSkill: fruit?.path === `${root}/${spec.root}/fruit-code/SKILL.md`,
    snapshotCommands: JSON.stringify(commands) === JSON.stringify(spec.echo === null || cli === "opencode" ? builtIns : [...builtIns, "echo"]),
    noContainerForSnapshot: before.running === false && after.running === false,
  };
  const steps: Record<string, any> = {};
  const described = await newThread(cli, projectId, `spi-1151 ${cli}: described`);
  steps.described = await turn(cli, described, 1, "What is the fruit code? Reply with the code alone.");
  checks.describedReadsSkill = steps.described.answer.includes("KIWI-7") && touchesSkill(steps.described);
  const mentioned = await newThread(cli, projectId, `spi-1151 ${cli}: mention`);
  steps.mention = await turn(cli, mentioned, 1, "$fruit-code");
  checks.mentionAnswers = steps.mention.answer.includes("KIWI-7") && steps.mention.typed === "$fruit-code";
  let ordinal = 1;
  if (cli === "claude") {
    // R6: the leading mention became Claude's native `/fruit-code`, its body in the prompt: SKILL.md is not read.
    checks.r6NativeExpansion = checks.mentionAnswers! && !readsSkillMd(steps.mention);
    // A Workspace runs at most two Claude Code processes (MAX_CLI_PROCESSES, Claude counting twice): the two threads'
    // end with the Container; the mention thread resumes for its later turns.
    await stopContainer(id);
    const inline = await newThread(cli, projectId, `spi-1151 ${cli}: inline mention`);
    // A mention t3's grammar matches needs whitespace or the end after its name (no full stop), else nothing rewrites it.
    const inlineText = "Tell me the fruit code, following $fruit-code and replying with the code alone.";
    steps.inlineMention = await turn(cli, inline, 1, inlineText);
    checks.inlineMentionAnswers = steps.inlineMention.answer.includes("KIWI-7") && steps.inlineMention.typed === inlineText;
  }
  if (spec.echo !== null) {
    steps.command = await turn(cli, mentioned, ++ordinal, "/echo a");
    // OpenCode: recorded, not checked (not listed): its command's reply never reaches t3.
    if (cli === "opencode") steps.command.expectedUnseen = true;
    else checks.commandAnswers = steps.command.answer.trim() === spec.echo && steps.command.typed === "/echo a";
    if (cli === "opencode") {
      // OpenCode 2.2.7's ACP ends a command's turn once it is submitted (`acp/turn.ts`): whether its reply shows later.
      await sleep(30_000);
      const late = itemsOf(await projection(mentioned)).filter((item: any) => item.type === "assistant_message" && String(item.text ?? "").includes("ECHO"));
      steps.commandLateReply = late.map((item: any) => ({ runId: item.runId, text: String(item.text).slice(0, 200) }));
    }
  }
  if (cli === "pi") {
    // pi compacts only what lies beyond its 20,000 most recent tokens (`keepRecentTokens`), estimated at four characters
    // a token: a turn of about 160,000 characters.
    const filler = Array.from({ length: 24_000 }, (_, at) => `w${at}`).join(" ");
    steps.filler = await turn(cli, mentioned, ++ordinal, `Reply with the single word OK. The rest is filler: ${filler}`);
    steps.filler.sent = `${steps.filler.sent.slice(0, 80)}… (${steps.filler.sent.length} characters)`;
    steps.filler.typed = `${String(steps.filler.typed ?? "").slice(0, 80)}…`;
  }
  steps.compact = await turn(cli, mentioned, ++ordinal, "/compact");
  // Listed for Codex and pi only, where the compaction itself completes; t3's ACP adapter refuses it for Claude Code
  // and OpenCode (recorded, not listed).
  checks.compactAsListed = builtIns.includes("compact") ? steps.compact.kinds.includes("compaction:completed") : steps.compact.status === "failed";
  if (cli === "codex") {
    steps.goal = await turn(cli, mentioned, ++ordinal, "/goal Reply with the single word DONE.");
    checks.goalRuns = steps.goal.status === "completed";
    steps.goalClear = await turn(cli, mentioned, ++ordinal, "/goal clear");
  }
  const ok = Object.values(checks).every(Boolean);
  console.log(`${cli}: ${ok ? "ok" : "FAIL"} ${JSON.stringify(checks)}`);
  return { ok, cli, model: spec.model, checks, snapshot: { container: { before, after }, ...snapshot }, threads: { described, mentioned }, steps };
};

cookie = await pair();
const id = process.env.T3FLARE_PCLI_PROJECT ?? `pcli-${Date.now().toString(36)}`;
const { projectId, root } = await ensureProject(cookie, id);
const written = await writeFixture(root);
const asked = process.argv.slice(2).filter((arg): arg is Cli => arg in CLIS);
let failed = false;
const work = async () => {
  for (const cli of asked.length === 0 ? (Object.keys(CLIS) as Array<Cli>) : asked) {
    try {
      const result = await probeCli(cli, projectId, root, id);
      writeEvidence(`${cli}.json`, { project: { id, root, written }, ...result });
      if (!result.ok) failed = true;
    } catch (error) {
      console.error(`${cli}: ${String(error).slice(0, 600)}`);
      failed = true;
    }
  }
};
// T3FLARE_PCLI_TAIL=<file>: the Environment Worker's logs while it runs, to that file (never into the evidence).
const tailFile = process.env.T3FLARE_PCLI_TAIL;
if (tailFile === undefined) await work();
else fs.writeFileSync(tailFile, (await tailing([new URL(process.env.T3_URL!).hostname.split(".")[0]!], work)).text);
if (failed) process.exitCode = 1;
