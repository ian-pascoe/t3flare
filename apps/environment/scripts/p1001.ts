// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-1147's stage harness (Repo skills and Prompt templates for Pi Durable; docs/steps/spi-1001.md), through t3's own
// calls as the web client makes them. The fixture's files (apps/environment/test/fixtures/skills/) are written,
// uncommitted, into a clone of the fixture project with t3's file write; they are never committed to the fixture repo,
// whose other acceptances would get them in their system prompts.
//
// - snapshot: the composer's snapshot of the project lists fruit-code (the .agents one, not .claude's), owner-only
//   (user-invocation only) and /echo, with the Container stopped before and after (M0: the Workspace DO lists .agents
//   without starting it); the cwd t3 passes the hook for the project, a worktree and the scratch folder.
// - turns: "what is the fruit code?" reads the SKILL.md and answers KIWI-7; `$fruit-code` answers it, t3's message
//   kept as typed; `/echo a` answers `ECHO a none`; `$nope` is left untouched; a skill written mid-thread expands by
//   mention on the next message.
// - switch: with the Harness `skills` extension off, the snapshot is empty, and there is no listing and no expansion.
// Evidence goes to docs/steps/spi-1001/<file>.json, tokens and cookies redacted.
//
//   node scripts/stage.ts run p1001 p1001 [snapshot|turns|switch]
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall, wsFirst } from "./lib/client.ts";

const SLUG = process.env.T3FLARE_P1001_MODEL ?? "anthropic/claude-sonnet-5-5";
const DURABLE = { instanceId: "piDurable", model: SLUG, options: [] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1001");
const FIXTURE = path.resolve(import.meta.dirname, "../test/fixtures/skills");
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled"]);
const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const accessHeaders = { "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "" };

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
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(redact({ at: new Date().toISOString(), model: SLUG, ...(value as object) }), null, 1)}\n`);
  console.log(`wrote docs/steps/spi-1001/${name}`);
};

const harness = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(new URL(pathname, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) as any };
  } catch {
    return { status: response.status, json: text.slice(0, 300) as any };
  }
};

let cookie = "";

const findIn = (value: unknown, pred: (record: any) => boolean): any => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findIn(item, pred);
      if (found !== undefined) return found;
    }
  } else if (value !== null && typeof value === "object") {
    if (pred(value)) return value;
    for (const inner of Object.values(value)) {
      const found = findIn(inner, pred);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** The fixture's files, by path relative to its root. */
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
  const written: Array<string> = [];
  for (const file of fixtureFiles()) {
    await wsCall(cookie, "projects.writeFile", { cwd, ...file });
    written.push(file.relativePath);
  }
  return written;
};

const workspaceRow = async (id: string) =>
  (((await admin("GET", "/_t3flare/agents/workspaces")).json?.workspaces ?? []) as Array<any>).find((row) => row.id === id);
const containerOf = async (id: string) => {
  const row = await workspaceRow(id);
  return { running: row?.container?.running ?? null, leased: row?.container?.leased ?? null };
};
const stopContainer = async (id: string) => {
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(id)}`);
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if ((await containerOf(id)).running === false) return;
    await sleep(2000);
  }
  throw new Error(`the Container of ${id} did not stop`);
};

/** The composer's snapshot of `cwd` for Pi Durable, fresh (past t3's TTL), as the client asks for it. */
const composerSnapshot = async (cwd: string) => {
  const reply = (await wsCall(cookie, "server.refreshProviders", { instanceId: "piDurable", cwd, fresh: true }).catch((error: unknown) => ({ error: String(error).slice(0, 400) }))) as any;
  const provider = (reply?.providers ?? []).find((candidate: any) => candidate.instanceId === "piDurable");
  const scoped = (provider?.workspaceSnapshots ?? []).find((snapshot: any) => snapshot.cwd === cwd) ?? provider?.workspaceSnapshots?.[0];
  return {
    error: reply?.error ?? null,
    snapshotCwd: scoped?.cwd ?? null,
    skills: scoped?.skills ?? null,
    slashCommands: scoped?.slashCommands ?? null,
    slashCommandsPending: scoped?.slashCommandsPending ?? null,
  };
};

const projection = async (threadId: string): Promise<any> => projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));

const settle = async (threadId: string, ordinal: number, timeoutMs = 6 * 60_000): Promise<any> => {
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
    await sleep(1000);
  }
  throw new Error(`timed out: runs ${JSON.stringify(runsOf(current).map((run) => run.status))}`);
};

const newThread = async (projectId: string, title: string) => {
  const threadId = uuid();
  await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title, modelSelection: DURABLE, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
  return threadId;
};

/** One turn: what t3 kept as the owner's message, the agent's answer, and the files its tools touched. */
const turn = async (threadId: string, ordinal: number, text: string) => {
  await sendMessage(cookie, threadId, text, DURABLE);
  const view = await settle(threadId, ordinal);
  const run = runsOf(view).find((candidate: any) => candidate.ordinal === ordinal) as any;
  const items = itemsOf(view).filter((item: any) => item.runId === run?.id);
  const typed = items.find((item: any) => item.type === "user_message")?.text ?? null;
  const answer = String(items.filter((item: any) => item.type === "assistant_message").at(-1)?.text ?? "");
  // Each tool item without its ids, as text: what it ran and on which path.
  const IDS = new Set(["id", "threadId", "runId", "nodeId", "providerThreadId", "providerTurnId", "createdAt", "updatedAt", "startedAt", "completedAt"]);
  const tools = items
    .filter((item: any) => !["user_message", "assistant_message", "reasoning", "checkpoint"].includes(item.type))
    .map((item: any) => JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => !IDS.has(key)))).slice(0, 800));
  return { sent: text, status: run?.status ?? null, typed, answer: answer.slice(0, 600), tools };
};

const readsFile = (step: { tools: Array<string> }, name: string) => step.tools.some((tool) => tool.includes(name));

const snapshot = async (projectId: string, root: string, id: string) => {
  const written = await writeFixture(root);
  await stopContainer(id);
  const before = await containerOf(id);
  const project = await composerSnapshot(root);
  const after = await containerOf(id);
  // M0: the directory t3 passes the hook for a worktree and for the scratch folder.
  const worktree = (await wsCall(cookie, "vcs.createWorktree", { cwd: root, refName: "main", newRefName: `p1001-${Date.now().toString(36)}`, path: null }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
  const worktreePath: string | null = worktree?.worktree?.path ?? null;
  const worktreeSnapshot = worktreePath === null ? { error: worktree?.error ?? "no worktree" } : await composerSnapshot(worktreePath);
  const scratch = (await wsCall(cookie, "projects.ensureScratch", {}).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
  const shell = (await wsFirst(cookie, "orchestration.subscribeShell", {}).catch(() => undefined)) as any;
  const scratchRoot: string | null = findIn(shell, (record) => record.id === scratch?.projectId && typeof record.workspaceRoot === "string")?.workspaceRoot ?? null;
  const scratchSnapshot = scratchRoot === null ? { error: "no scratch root" } : await composerSnapshot(scratchRoot);
  const names = (project.skills ?? []).map((skill: any) => skill.name);
  const fruit = (project.skills ?? []).find((skill: any) => skill.name === "fruit-code");
  const owner = (project.skills ?? []).find((skill: any) => skill.name === "owner-only");
  const ok =
    names.length === 2 &&
    fruit?.path === `${root}/.agents/skills/fruit-code/SKILL.md` &&
    fruit?.scope === "project" &&
    fruit?.userInvocationOnly === false &&
    owner?.userInvocationOnly === true &&
    (project.slashCommands ?? []).some((command: any) => command.name === "echo") &&
    before.running === false &&
    after.running === false;
  console.log(`snapshot: ${ok ? "ok" : "FAIL"} (${JSON.stringify(names)}; container ${before.running} -> ${after.running})`);
  return { ok, projectId, root, written, container: { before, after }, project, m0: { project: project.snapshotCwd, worktree: { path: worktreePath, ...worktreeSnapshot }, scratch: { root: scratchRoot, ...scratchSnapshot } } };
};

const turns = async (projectId: string, root: string) => {
  const threadId = await newThread(projectId, "spi-1147: skills");
  const steps: Record<string, any> = {};
  steps.listed = await turn(threadId, 1, "What is the fruit code? Reply with the code alone.");
  steps.mention = await turn(threadId, 2, "$fruit-code");
  steps.template = await turn(threadId, 3, "/echo a");
  steps.unknown = await turn(threadId, 4, "Reply with exactly the text after the colon, unchanged: $nope");
  // A name new to this run: the skill exists only from here on.
  const late = `late-${Date.now().toString(36)}`;
  const before = await composerSnapshot(root);
  await wsCall(cookie, "projects.writeFile", { cwd: root, relativePath: `.agents/skills/${late}/SKILL.md`, contents: `---\nname: ${late}\ndescription: A skill written mid-thread.\n---\n\nReply with exactly: LATE-5\n` });
  steps.late = { ...(await turn(threadId, 5, `$${late}`)), listedBefore: (before.skills ?? []).some((skill: any) => skill.name === late) };
  const checks = {
    listedReadsSkill: readsFile(steps.listed, "fruit-code/SKILL.md") && steps.listed.answer.includes("KIWI-7") && !steps.listed.answer.includes("FAKE-0"),
    mentionAnswers: steps.mention.answer.includes("KIWI-7") && steps.mention.typed === "$fruit-code",
    templateAnswers: steps.template.answer.trim() === "ECHO a none" && steps.template.typed === "/echo a",
    unknownUntouched: steps.unknown.answer.includes("$nope"),
    lateExpands: steps.late.answer.includes("LATE-5") && steps.late.listedBefore === false,
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(`turns: ${ok ? "ok" : "FAIL"} ${JSON.stringify(checks)}`);
  return { ok, threadId, checks, steps };
};

const switchOff = async (projectId: string, root: string) => {
  const off = await harness("POST", "/_t3flare/harness/api/extensions", { extension: "skills", enabled: false });
  try {
    const snapshotOff = await composerSnapshot(root);
    const threadId = await newThread(projectId, "spi-1147: skills off");
    const listing = await turn(threadId, 1, "Without reading any file or running any command: does your system prompt hold an <available_skills> list? Reply YES or NO, then the skill names if YES.");
    const mention = await turn(threadId, 2, "Without reading any file or running any command, reply with exactly the text after the colon, unchanged: $fruit-code");
    const template = await turn(threadId, 3, "/echo a");
    const checks = {
      snapshotEmpty: (snapshotOff.skills ?? []).length === 0 && (snapshotOff.slashCommands ?? []).length === 0,
      noListing: /^\W*NO\b/i.test(listing.answer) && !listing.answer.includes("fruit-code"),
      noExpansion: mention.answer.includes("$fruit-code") && !mention.answer.includes("KIWI-7"),
      noTemplate: !template.answer.includes("ECHO a none"),
    };
    const ok = off.status === 200 && Object.values(checks).every(Boolean);
    console.log(`switch: ${ok ? "ok" : "FAIL"} ${JSON.stringify(checks)}`);
    return { ok, off: { status: off.status }, checks, snapshotOff, threadId, steps: { listing, mention, template } };
  } finally {
    const on = await harness("POST", "/_t3flare/harness/api/extensions", { extension: "skills", enabled: true });
    console.log(`switch back on: ${on.status}`);
  }
};

const command = process.argv[2];
cookie = await pair();
await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
const id = process.env.T3FLARE_P1001_PROJECT ?? `p1001-${Date.now().toString(36)}`;
const { projectId, root } = await ensureProject(cookie, id);
const results: Record<string, any> = {};
if (command === undefined || command === "snapshot") {
  results.snapshot = await snapshot(projectId, root, id);
  writeEvidence("snapshot.json", results.snapshot);
} else {
  await writeFixture(root);
}
if (command === undefined || command === "turns") {
  results.turns = await turns(projectId, root);
  writeEvidence("turns.json", results.turns);
}
if (command === undefined || command === "switch") {
  results.switch = await switchOff(projectId, root);
  writeEvidence("switch.json", results.switch);
}
if (!Object.values(results).every((result) => result.ok)) process.exitCode = 1;
