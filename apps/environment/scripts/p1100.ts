// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
// SPI-1100's stage harness (docs/steps/spi-1100.md): a turn's checkpoint holds what the agent wrote in it, for the CLI
// agents (which write in the Workspace's Container) and the Durable agent (which writes through the Workspace DO).
// For each agent, through t3's own commands as the web client sends them, on a worktree thread:
// - turn 1 writes notes.txt as `one`, turn 2 as `two`;
// - t3's turn diffs (`orchestration.getTurnDiff`) 0→1 and 1→2 name notes.txt, with the line each turn wrote;
// - a rollback to turn 1's checkpoint with files restored (`checkpoint.rollback`, "Revert to this message") puts
//   notes.txt back to `one`, and the agent no longer recalls turn 2's code word (skipped with --no-rollback).
// The checkpoint operations the Workspace DOs answered, and by which side, are in each agent's evidence.
// Evidence goes to docs/steps/spi-1100/<out>.json, tokens and cookies redacted.
//
//   node scripts/stage.ts run p1100 p1100 [codex,pi,claude,opencode,durable] [--out <name>] [--no-rollback]
import * as fs from "node:fs";
import * as path from "node:path";

import { enable as enableAcp, INSTANCE } from "./lib/acpTurn.ts";
import { enable as enableCli, ensureProject, modelOf } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, pair, projectionOf, runsOf, sendMessage, sleep, threadWindow, uuid, wsCall, wsFirst } from "./lib/client.ts";

const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/spi-1100");
const SETTLED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const DURABLE_SLUG = process.env.T3FLARE_P1100_MODEL ?? "anthropic/claude-haiku-5-5";

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
  console.log(`wrote docs/steps/spi-1100/${name}`);
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const agents = (args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "codex,pi,claude,opencode,durable").split(",");

let cookie = "";

const projection = async (threadId: string): Promise<any> => projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));

/** Waits until the thread has a run of ordinal `ordinal` or later and all its runs have settled; every card accepted. */
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
    await sleep(1000);
  }
  throw new Error(`timed out: runs ${JSON.stringify(runsOf(current).map((run) => run.status))}`);
};

const readNotes = async (cwd: string): Promise<string | null> => {
  const read = (await wsCall(cookie, "projects.readFile", { cwd, relativePath: "notes.txt", allowMissing: true }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
  return read?.exists === false ? null : typeof read?.contents === "string" ? read.contents.trim() : `error: ${read?.error}`;
};

const turnDiff = async (threadId: string, from: number, to: number): Promise<string> => {
  const answer = (await wsCall(cookie, "orchestration.getTurnDiff", { threadId, fromTurnCount: from, toTurnCount: to }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }))) as any;
  return typeof answer?.diff === "string" ? answer.diff : `error: ${answer?.error}`;
};

/** A diff that adds `line` to notes.txt (as its only line, a new file or an overwrite). */
const diffWrites = (diff: string, line: string) => diff.includes("b/notes.txt") && diff.split("\n").some((row) => row === `+${line}`);

const modelFor = (agent: string) =>
  agent === "durable"
    ? { instanceId: "piDurable", model: DURABLE_SLUG, options: [] }
    : agent === "claude" || agent === "opencode"
      ? { instanceId: INSTANCE[agent]!.instanceId, model: INSTANCE[agent]!.model, options: [] }
      : modelOf(agent, undefined);

const enableAgent = async (agent: string) => {
  if (agent === "durable") {
    await wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } } });
  } else if (agent === "claude" || agent === "opencode") {
    await enableAcp(cookie, agent);
  } else {
    await enableCli(cookie, agent, agent);
  }
};

/** The checkpoint operations the Workspace DOs answered since the last clear (the Environment's in-memory trace). */
const trace = async (clear: boolean) => ((await admin("GET", `/_t3flare/agents/checkpoint-trace${clear ? "?clear=1" : ""}`)).json as any)?.entries ?? null;

const LINES = ["one", "two"];
const WORDS = ["FIG-3", "PLUM-9"];
const prompt = (index: number) =>
  `Write the file notes.txt in the current directory (the repository root) so its only line is \`${LINES[index]}\` (overwrite it if it exists). Use your file editing tool. Code word ${index + 1} is ${WORDS[index]}; remember it. Then reply only OK.`;
const ASK = "Without reading any file or running any command: list every code word I have given you in this conversation, comma-separated, or reply NONE.";

const run = async (projectId: string, agent: string) => {
  const started = Date.now();
  await enableAgent(agent);
  const model = modelFor(agent);
  await trace(true).catch(() => undefined);
  const threadId = uuid();
  // What the client's composer sends for a new thread in "New worktree" mode: file restore needs an isolated worktree.
  await wsCall(cookie, "orchestration.launchThread", {
    commandId: uuid(),
    creationSource: "web",
    threadId,
    projectId,
    title: `spi-1100: ${agent}`,
    generateTitle: false,
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "worktree", baseRef: "main" },
    initialMessage: { messageId: uuid(), text: prompt(0), attachments: [] },
  });
  await settle(threadId, 1, 10 * 60_000);
  const worktreePath: string | null = (await projection(threadId))?.thread?.worktreePath ?? ((await wsFirst(cookie, "subscribeWorktreeSetup", { threadId }).catch(() => undefined)) as any)?.worktreePath ?? null;
  if (worktreePath === null) throw new Error("the thread has no worktree");
  const notes: Array<string | null> = [await readNotes(worktreePath)];
  const diffs: Array<string> = [await turnDiff(threadId, 0, 1)];
  await sendMessage(cookie, threadId, prompt(1), model);
  await settle(threadId, 2);
  notes.push(await readNotes(worktreePath));
  diffs.push(await turnDiff(threadId, 1, 2));
  const diffsOk = LINES.every((line, index) => diffWrites(diffs[index]!, line));
  const before = await projection(threadId);
  const runs = runsOf(before).map((r: any) => ({ ordinal: r.ordinal, status: r.status }));
  const checkpoints = (before?.checkpoints ?? []).map((checkpoint: any) => ({ id: checkpoint.id, scopeId: checkpoint.scopeId, appRunOrdinal: checkpoint.appRunOrdinal ?? null, status: checkpoint.status }));
  const capturesTrace = await trace(false).catch((error: unknown) => String(error).slice(0, 200));
  let rollback: any = { skipped: true };
  if (!flag("no-rollback")) {
    const target = (before?.checkpoints ?? []).findLast((checkpoint: any) => checkpoint.appRunOrdinal === 1);
    if (target === undefined) {
      rollback = { ok: false, error: "no checkpoint of the first turn" };
    } else {
      // The web client's "Revert to this message", files restored (client-runtime `revertThreadCheckpoint`).
      const rolled = await dispatch(cookie, { type: "checkpoint.rollback", restoreFiles: true, commandId: uuid(), threadId, scopeId: target.scopeId, checkpointId: target.id }).then(
        (value: unknown) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error: String(error).slice(0, 600) }),
      );
      const waitStarted = Date.now();
      let after: any;
      const live = (view: any) => runsOf(view).filter((r: any) => r.status !== "rolled_back").map((r: any) => r.ordinal);
      while (rolled.ok && Date.now() - waitStarted < 120_000) {
        after = await projection(threadId);
        if (!live(after).includes(2)) break;
        await sleep(1000);
      }
      // t3 restores the files after the thread's runs are marked; give the restore a moment.
      let restored = await readNotes(worktreePath);
      for (let tries = 0; rolled.ok && restored !== "one" && tries < 20; tries++) {
        await sleep(1000);
        restored = await readNotes(worktreePath);
      }
      const rolledBack = rolled.ok && !live(after).includes(2);
      // The conversation: the rolled-back turn's code word is gone (a fresh ACP session may also have lost turn 1's).
      let answer = "";
      if (rolled.ok) {
        await sendMessage(cookie, threadId, ASK, model);
        answer = String(itemsOf(await settle(threadId, 2)).filter((item: any) => item.type === "assistant_message").at(-1)?.text ?? "");
      }
      const forgot = !answer.includes(WORDS[1]!);
      rollback = { ok: rolled.ok && rolledBack && restored === "one" && forgot, dispatch: rolled, rolledBack, restored, answer: answer.slice(0, 300), forgot, target: { id: target.id, appRunOrdinal: target.appRunOrdinal } };
    }
  }
  const ok = notes.join(",") === "one,two" && diffsOk && (rollback.skipped === true || rollback.ok === true);
  console.log(`${agent}: ${ok ? "ok" : "FAIL"} (notes ${notes.join(",")}; diffs ${diffs.map((diff, index) => diffWrites(diff, LINES[index]!)).join(",")}; rollback ${rollback.skipped ? "skipped" : `${rollback.ok} -> ${rollback.restored ?? rollback.error}, answered ${JSON.stringify(rollback.answer ?? "")}`})`);
  return {
    ok,
    agent,
    model: model.model,
    threadId,
    worktreePath,
    notes,
    diffs: diffs.map((diff) => diff.slice(0, 1500)),
    diffsOk,
    runs,
    answers: itemsOf(before).filter((item: any) => item.type === "assistant_message").map((item: any) => String(item.text ?? "").slice(0, 200)),
    checkpoints,
    checkpointTrace: capturesTrace,
    rollback,
    ms: Date.now() - started,
  };
};

cookie = await pair();
const { projectId } = await ensureProject(cookie, `p1100-${Date.now().toString(36)}`);
const results: Record<string, any> = {};
for (const agent of agents) {
  try {
    results[agent] = await run(projectId, agent);
  } catch (error) {
    results[agent] = { ok: false, agent, error: String(error).slice(0, 600) };
    console.log(`${agent}: FAIL (${String(error).slice(0, 300)})`);
  }
}
const ok = Object.values(results).every((result) => result.ok);
writeEvidence(`${option("out") ?? agents.join("-")}.json`, { ok, results });
if (!ok) process.exitCode = 1;
