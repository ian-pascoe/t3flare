// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// The tools step's stage harness (docs/steps/tools-plan.md §7): code mode on a Durable thread, its probes, the hostile
// scripts, and the harness panel's API and safety. Each case writes its evidence to docs/steps/tools/<file>.json, with
// tokens, cookies and handles redacted.
//
//   bun scripts/stage.ts run tools tools m1            a script that reads, greps, edits and runs a test (m1-codemode.json)
//   bun scripts/stage.ts run tools tools probes        P3 cost per nested call, P4 tokens per preset, P5 restarts (m0-*.json)
//   bun scripts/stage.ts run tools tools memory        P14: concurrent memory-heavy scripts against the 16 MiB cap
//   bun scripts/stage.ts run tools tools sandbox-loss  P14: a script waiting on approval while the sandbox is replaced
//   bun scripts/stage.ts run tools tools hostile       M2: H1-H3, H6, H7 (m2-hostile-script.json)
//   bun scripts/stage.ts run tools tools panel         the panel's API and safety from outside (m3-panel-safety.json)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { cliTurn as acpTurn, enable as enableAcp } from "./lib/acpTurn.ts";
import { cliTurn, enable as enableCli } from "./lib/cliTurn.ts";
import { admin, dispatch, itemsOf, mutateProject, pair, projectionOf, readDoText, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";

const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
const SLUG = process.env.T3FLARE_TOOLS_MODEL ?? "anthropic/claude-sonnet-5-5";
const MODEL = { instanceId: "piDurable", model: SLUG, options: /claude/.test(SLUG) ? [{ id: "thinking", value: "low" }] : [] };
const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/tools");
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
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(redact({ at: new Date().toISOString(), ...(value as object) }), null, 1)}\n`);
  console.log(`wrote docs/steps/tools/${name}`);
};

/** The panel's JSON API on the admin host, as a script calls it: the stage's service token and the admin token. */
const harness = async (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(new URL(pathname, HARNESS), {
    method,
    redirect: "manual",
    headers: {
      ...accessHeaders,
      authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = text.slice(0, 300);
  try {
    json = JSON.parse(text);
  } catch {
    // text
  }
  return { status: response.status, json, headers: response.headers };
};

const setPreset = async (preset: string) => harness("POST", "/_t3flare/harness/api/extensions", { extension: "offered-tools", settings: { preset } });

let cookie = "";
let providerOn = false;

/** A Workspace cloned from the fixture, a project on it, and a thread in `mode` (and `interaction`). */
const newThread = async (label: string, mode: string, interaction = "default") => {
  if (!providerOn) {
    await wsCall(cookie, "server.updateSettings", {
      patch: {},
      providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
    });
    providerOn = true;
  }
  const id = `tools-${label}-${Date.now().toString(36)}`;
  const destination = `/w/${id}`;
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: destination })) as { cwd?: string };
  if (cloned.cwd !== destination) throw new Error(`clone failed: ${JSON.stringify(cloned).slice(0, 300)}`);
  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: destination, createWorkspaceRootIfMissing: false });
  const threadId = await threadIn(projectId, id, mode, interaction);
  return { id, threadId, destination, projectId };
};

/** Another thread on the same project (and Workspace). */
const threadIn = async (projectId: string, title: string, mode: string, interaction = "default") => {
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title,
    modelSelection: MODEL,
    runtimeMode: mode,
    interactionMode: interaction,
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
};

type Decide = (request: any, projection: any) => "accept" | "acceptForSession" | "decline" | "cancel" | undefined;

/** Sends `text`, answers each new card with `decide` (unanswered when it returns undefined), until the run settles. */
const runTurn = async (threadId: string, text: string, decide: Decide = () => "accept", options: { readonly timeoutMs?: number; readonly during?: (projection: any) => Promise<void> } = {}) => {
  const started = Date.now();
  const before = runsOf(projectionOf(await threadWindow(cookie, threadId))).length;
  await sendMessage(cookie, threadId, text, MODEL);
  const answered = new Set<string>();
  const cards: Array<any> = [];
  let projection: any;
  while (Date.now() - started < (options.timeoutMs ?? 8 * 60_000)) {
    projection = projectionOf(await threadWindow(cookie, threadId));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.has(r.id))) {
      const item = itemsOf(projection).find((candidate: any) => candidate.requestId === request.id);
      const decision = decide(request, projection);
      if (decision === undefined) continue;
      answered.add(request.id);
      cards.push({ kind: request.kind, prompt: String(item?.prompt ?? "").slice(0, 1200), decision });
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision });
    }
    await options.during?.(projection);
    const runs = runsOf(projection);
    if (runs.length > before && runs.slice(before).every((run) => SETTLED.has(run.status))) break;
    await sleep(1500);
  }
  return { projection, cards, ms: Date.now() - started, status: runsOf(projection).at(-1)?.status ?? null };
};

/** The instruction that makes a turn one verbatim code mode call. */
const verbatim = (code: string) =>
  `Call the codemode tool exactly once, with exactly this code (verbatim, change nothing), then reply with the script's output and nothing else:\n\n\`\`\`js\n${code}\n\`\`\``;

const codemodeItems = (projection: any) => {
  const items = itemsOf(projection);
  const parents = items.filter((item: any) => item.type === "dynamic_tool" && item.toolName === "codemode" && item.parentItemId == null);
  return parents.map((parent: any) => ({
    title: parent.title,
    status: parent.status,
    output: JSON.stringify(parent.output ?? null).slice(0, 1500),
    children: items
      .filter((item: any) => item.parentItemId === parent.id)
      .map((child: any) => ({ type: child.type, title: child.title, status: child.status, input: (typeof child.input === "string" ? child.input : JSON.stringify(child.input ?? child.fileName ?? "")).slice(0, 200) })),
  }));
};

/** A file of the Workspace's repo, "" when absent. */
/** The text of the thread's code mode results, newest last, from the Session's committed entries. */
const scriptOutputs = async (threadId: string): Promise<Array<string>> => {
  const state = (await admin("GET", `/_t3flare/agents/session?thread=${encodeURIComponent(threadId)}`)).json;
  return (state?.entries ?? [])
    .filter((entry: any) => entry.role === "toolResult" && entry.toolName === "codemode")
    .map((entry: any) => (entry.content ?? []).map((block: any) => block.text ?? "").join(""));
};

const workspaceFile = (workspace: string, file: string) => readDoText(workspace, `/workspace/repo/${file}`);

const cleanup = async (workspace: string) => {
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
  await admin("POST", `/_t3flare/agents/workspace-remove?id=${workspace}`);
};

interface Case {
  readonly name: string;
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

const M1_SCRIPT = `const text0 = await tools.read({ path: "src/greeting.txt" });
const hits = await tools.grep({ pattern: "Hello", path: "src" });
const first = text0.split("\\n").find((line) => line.trim() !== "");
await tools.edit({ path: "src/greeting.txt", edits: [{ oldText: first, newText: first + "\\nHello from code mode." }] });
const test = await tools.bash({ command: "bash test.sh" });
text(JSON.stringify({ firstLine: first, grepHits: String(hits).split("\\n").length, test: String(test).slice(-200) }));`;

const m1 = async (): Promise<Case> => {
  const thread = await newThread("m1", "approval-required");
  const turn = await runTurn(thread.threadId, verbatim(M1_SCRIPT));
  const scripts = codemodeItems(turn.projection);
  const checkpoint = itemsOf(turn.projection).find((item: any) => item.type === "checkpoint" && Array.isArray(item.files) && item.files.length > 0);
  const children = scripts[0]?.children ?? [];
  const result = {
    name: "m1-codemode",
    status: turn.status,
    scripts,
    cards: turn.cards,
    checkpointFiles: checkpoint?.files ?? null,
    ms: turn.ms,
    checks: {
      completed: turn.status === "completed",
      oneScriptItem: scripts.length === 1 && scripts[0]?.title === "Code mode",
      childrenNested: ["command_execution", "file_change"].every((type) => children.some((child: any) => child.type === type)),
      cardsNameTheScript: turn.cards.length > 0 && turn.cards.every((card) => card.prompt.includes("From a code mode script")),
      checkpointHasTheEdit: JSON.stringify(checkpoint?.files ?? []).includes("src/greeting.txt"),
    },
  };
  await cleanup(thread.id);
  return { ...result, ok: Object.values(result.checks).every(Boolean) };
};

/** The provider turn's input tokens of a one-word turn under `preset`. */
const tokensUnder = async (preset: string) => {
  await setPreset(preset);
  const thread = await newThread(`p4-${preset}`, "full-access");
  const turn = await runTurn(thread.threadId, "Reply with the single word OK. Do not call any tool.");
  const usage = (turn.projection?.providerTurns ?? turn.projection?.turns ?? []).map((t: any) => t.tokenUsage).find((u: any) => u !== undefined && u !== null);
  await cleanup(thread.id);
  return { preset, status: turn.status, inputTokens: usage?.inputTokens ?? null, cachedInputTokens: usage?.cachedInputTokens ?? null };
};

const wallSeconds = (output: string) => Number(/Wall time ([\d.]+) seconds/.exec(output)?.[1] ?? Number.NaN);

const probes = async (only?: string) => {
  // P4: tokens per preset (A, B, C).
  if (only === undefined) {
    const p4 = [];
    for (const preset of ["codemode-only", "core", "everything"]) p4.push(await tokensUnder(preset));
    await setPreset("core");
    writeEvidence("m0-p4-tokens.json", { model: SLUG, presets: p4, ok: p4.every((row) => row.inputTokens !== null) });
  }

  // P3: 100 sequential nested reads, timed by the script's own wall time.
  const thread = await newThread("p3", "full-access");
  const turn = await runTurn(thread.threadId, verbatim(`for (let i = 0; i < 100; i++) await tools.read({ path: "src/greeting.txt" });\ntext("done");`));
  const output = (await scriptOutputs(thread.threadId)).at(-1) ?? "";
  const seconds = wallSeconds(output);
  const p3 = { status: turn.status, nestedCalls: 100, wallSeconds: seconds, msPerNestedCall: Math.round((seconds * 1000) / 100), gate: "> 150 ms p50 per nested call is reported" };
  writeEvidence("m0-p3-cost.json", { ...p3, ok: turn.status === "completed" && Number.isFinite(seconds) });

  // P5 (H7): an approval inside a script across two Session restarts; one card throughout, the command ran once.
  if (only === undefined) writeEvidence("m0-p5-restart.json", await restartCase(thread));
  await cleanup(thread.id);
};

const restartCase = async (thread: { readonly id: string; readonly threadId: string }) => {
  await dispatch(cookie, { type: "thread.runtime-mode.set", commandId: uuid(), threadId: thread.threadId, runtimeMode: "approval-required" }).catch(() => undefined);
  let restarts = 0;
  let cardIds = new Set<string>();
  const marker = `restart-${Date.now().toString(36)}`;
  const turn = await runTurn(
    thread.threadId,
    verbatim(`await tools.bash({ command: "echo ${marker} >> ran.log" });\ntext(await tools.read({ path: "ran.log" }));`),
    () => (restarts >= 2 ? "accept" : undefined),
    {
      during: async (projection) => {
        const pending = (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending");
        for (const request of pending) cardIds.add(request.id);
        if (pending.length > 0 && restarts < 2) {
          await admin("POST", `/_t3flare/agents/session-restart?thread=${thread.threadId}`);
          restarts++;
          await sleep(8_000);
        }
      },
    },
  );
  const log = await workspaceFile(thread.id, "ran.log");
  const runs = log.split(marker).length - 1;
  const result = { name: "H7-restart", status: turn.status, restarts, distinctCards: cardIds.size, cards: turn.cards, commandRuns: runs };
  cardIds = new Set();
  return { ...result, ok: turn.status === "completed" && restarts === 2 && result.distinctCards === 1 && runs === 1 };
};

const memory = async () => {
  const thread = await newThread("p14m", "full-access");
  const code = `const out = [];
try { const big = []; for (let i = 0; i < 64; i++) big.push(new Array(256 * 1024).fill(i)); out.push("allocated " + big.length); }
catch (e) { out.push("refused: " + String(e).slice(0, 120)); }
text(out.join("\\n"));`;
  const turns = await Promise.all([0, 1, 2, 3].map(async (n) => {
    const own = n === 0 ? thread.threadId : await threadIn(thread.projectId, `p14m${n}`, "full-access");
    const turn = await runTurn(own, verbatim(code));
    return { status: turn.status, output: (await scriptOutputs(own)).at(-1) ?? null };
  }));
  // After the pressure, a plain script still runs.
  const after = await runTurn(thread.threadId, verbatim(`text("still here");`));
  await cleanup(thread.id);
  const ok = turns.every((turn) => turn.status === "completed" && String(turn.output).includes("refused")) && String((await scriptOutputs(thread.threadId)).at(-1)).includes("still here");
  writeEvidence("m0-p14-memory.json", { capMiB: 16, concurrent: turns, after: after.status, ok });
};

const sandboxLoss = async () => {
  const thread = await newThread("p14s", "approval-required");
  let redeployed = false;
  let redeployLog = "";
  const turn = await runTurn(
    thread.threadId,
    verbatim(`const done = await tools.read({ path: "src/greeting.txt" });\nawait tools.bash({ command: "echo should-not-run > lost.log" });\ntext("ran");`),
    () => (redeployed ? "accept" : undefined),
    {
      timeoutMs: 15 * 60_000,
      during: async (projection) => {
        if (redeployed || !(projection?.runtimeRequests ?? []).some((r: any) => r.status === "pending")) return;
        redeployed = true;
        // A new version of the sandbox Worker: its objects reset, as a deploy, an OOM or a runtime restart does.
        const deployed = spawnSync("bun", ["scripts/stage.ts", "deploy", "tools"], {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: { ...process.env, T3FLARE_SANDBOX_GEN: String(Date.now()) },
          encoding: "utf8",
        });
        console.log(`redeploy exit ${deployed.status}`);
        // Which resources the deploy changed (root's follow-up: only the sandbox Worker, whose env alone differs).
        redeployLog = `${deployed.stdout ?? ""}\n${deployed.stderr ?? ""}`;
      },
    },
  );
  const scripts = codemodeItems(turn.projection);
  const lost = await workspaceFile(thread.id, "lost.log");
  await cleanup(thread.id);
  writeEvidence("m0-p14-sandbox-loss.json", {
    status: turn.status,
    script: scripts[0] ?? null,
    cards: turn.cards,
    lostLog: lost,
    redeployed: [...new Set(redeployLog.split("\n").filter((line) => /updat|creat|replac|deploy/i.test(line) && !/token|secret/i.test(line)).map((line) => line.trim().slice(0, 160)))].slice(0, 40),
    expectation: "the script fails closed: it ends with an error listing the calls it completed; the card is withdrawn or, if answered, the command does not run twice",
    ok: scripts[0] !== undefined,
  });
};

// ---------------------------------------------------------------------------------------------------------------------
// M2: hostile scripts

const hostile = async () => {
  const cases: Array<Case> = [];

  // H1 plan mode: writes and edits refused, commands ask (declined here), t3 writes refused; no file changed.
  {
    const thread = await newThread("h1", "full-access", "plan");
    const code = `const out = [];
for (const [name, call] of [
  ["write", () => tools.write({ path: "h1.txt", content: "x" })],
  ["edit", () => tools.edit({ path: "src/greeting.txt", edits: [{ oldText: "Hello", newText: "Bye" }] })],
  ["bash", () => tools.bash({ command: "echo x > h1-bash.txt" })],
  ["t3", () => tools.mcp__t3_code__t3_project_create({ title: "h1", workspaceRoot: "/w/none" })],
]) { try { out.push(name + ": " + String(await call()).slice(0, 160)); } catch (e) { out.push(name + " threw: " + String(e.message).slice(0, 160)); } }
text(out.join("\\n"));`;
    const turn = await runTurn(thread.threadId, verbatim(code), () => "decline");
    const output = (await scriptOutputs(thread.threadId)).at(-1) ?? "";
    const files = await Promise.all(["h1.txt", "h1-bash.txt"].map((file) => workspaceFile(thread.id, file)));
    cases.push({
      name: "H1 plan mode",
      output,
      cards: turn.cards,
      files,
      ok:
        /write threw: Refused: this thread is in plan mode/.test(output) &&
        /edit threw: Refused: this thread is in plan mode/.test(output) &&
        /bash threw: Declined by the owner/.test(output) &&
        turn.cards.length >= 1 &&
        files.every((file) => file === ""),
    });
    await cleanup(thread.id);
  }

  // H2 approval-required: Promise.all and serial loops ask per call; the queue holds at most 8; a session acceptance on
  // a script's card covers a later direct command.
  {
    const thread = await newThread("h2", "approval-required");
    let maxPending = 0;
    const turn = await runTurn(
      thread.threadId,
      verbatim(`await Promise.all(Array.from({ length: 12 }, (_, i) => tools.bash({ command: "echo p" + i })));\nfor (let i = 0; i < 3; i++) await tools.bash({ command: "echo s" + i });\ntext("ok");`),
      () => "accept",
      { during: async (projection) => void (maxPending = Math.max(maxPending, (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending").length)) },
    );
    cases.push({ name: "H2 every nested command asks; at most 8 pending", status: turn.status, cards: turn.cards.length, maxPending, ok: turn.status === "completed" && turn.cards.length === 15 && maxPending <= 8 });

    const accept = await runTurn(thread.threadId, verbatim(`text(await tools.bash({ command: "echo first" }));`), () => "acceptForSession");
    const direct = await runTurn(thread.threadId, "Run the shell command `echo direct-after-accept` with the bash tool directly (not code mode), then reply done.", () => "decline");
    cases.push({
      name: "H2 accept for the session on a script's card covers a later direct command",
      cards: [...accept.cards, ...direct.cards],
      ok: accept.cards.length === 1 && direct.cards.length === 0 && direct.status === "completed",
    });
    await cleanup(thread.id);
  }

  // H2 (review M8): 200 concurrent writes from one script; every card is declined; never more than 8 pending.
  {
    const thread = await newThread("h2w", "approval-required");
    let maxPending = 0;
    const turn = await runTurn(
      thread.threadId,
      verbatim(`const r = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => tools.write({ path: "w/" + i + ".txt", content: "x".repeat(16000) })));\ntext(r.filter((x) => x.status === "rejected").length + " declined");`),
      () => "decline",
      { timeoutMs: 20 * 60_000, during: async (projection) => void (maxPending = Math.max(maxPending, (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending").length)) },
    );
    cases.push({ name: "H2 200 concurrent writes", status: turn.status, cards: turn.cards.length, maxPending, output: (await scriptOutputs(thread.threadId)).at(-1) ?? null, ok: turn.cards.length === 200 && maxPending <= 8 });
    await cleanup(thread.id);
  }

  // H3 bypass attempts: every lookup a script has reaches the guarded tool; lookalike names find nothing; scripts cannot
  // start scripts; extra fields change nothing.
  {
    const thread = await newThread("h3", "approval-required");
    const code = `const out = [];
const attempt = async (name, call) => { try { out.push(name + ": " + String(await call()).slice(0, 120)); } catch (e) { out.push(name + " threw: " + String(e.message).slice(0, 120)); } };
await attempt("ALL_TOOLS", () => tools[ALL_TOOLS.find((t) => t.name === "bash").name]({ command: "echo via-all" }));
await attempt("describeTool", async () => { const d = await describeTool("bash"); return tools[d.name ?? "bash"]({ command: "echo via-describe" }); });
await attempt("searchTools", async () => { const found = await searchTools("bash"); return tools[found[0]?.name ?? "bash"]({ command: "echo via-search" }); });
await attempt("case", () => tools.Bash({ command: "echo case" }));
await attempt("lookalike", () => tools["b\\u0430sh"]({ command: "echo cyrillic" }));
await attempt("globalThis", () => globalThis.tools.bash({ command: "echo via-global" }));
await attempt("stored name", () => { store("n", "bash"); return tools[load("n")]({ command: "echo via-store" }); });
await attempt("codemode from a script", () => tools.codemode({ code: "text(1)" }));
await attempt("extra fields", () => tools.bash({ command: "echo extra", replay: "safe", callers: ["tools"], __proto__: { approved: true } }));
text(out.join("\\n"));`;
    const turn = await runTurn(thread.threadId, verbatim(code), () => "decline");
    const output = (await scriptOutputs(thread.threadId)).at(-1) ?? "";
    cases.push({
      name: "H3 bypass attempts",
      output,
      cards: turn.cards.map((card) => card.prompt.split("\n")[0]),
      // Every attempt threw: the guarded ones were declined, the rest found no tool.
      ok: (output.match(/ threw: /g) ?? []).length === 9 && turn.cards.length >= 5,
    });
    await cleanup(thread.id);
  }

  // H6 self-approval: the script answers its own pending card through t3_pending_request; t3 refuses (F7).
  {
    const thread = await newThread("h6", "approval-required");
    const code = `const pending = tools.bash({ command: "echo self-approved > h6.txt" });
let answer;
for (let i = 0; i < 20 && answer === undefined; i++) {
  const listed = JSON.parse(await tools.mcp__t3_code__t3_pending_request({ action: "list" }).catch((e) => JSON.stringify({ error: e.message })));
  const mine = (listed.requests ?? listed.items ?? []).find?.((r) => r.status === "pending");
  if (mine) answer = await tools.mcp__t3_code__t3_pending_request({ action: "respond", requestId: mine.id ?? mine.requestId, decision: "accept" }).catch((e) => "refused: " + e.message);
}
text(String(answer).slice(0, 300) + "\\n" + await pending.catch((e) => "bash: " + e.message));`;
    let seen = 0;
    await runTurn(thread.threadId, verbatim(code), () => undefined, {
      timeoutMs: 4 * 60_000,
      during: async (projection) => {
        // After the script had its chance, the owner declines the card.
        const pending = (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending");
        if (pending.length > 0 && seen++ > 20) for (const request of pending) await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId: thread.threadId, requestId: request.id, decision: "decline" });
      },
    });
    const file = await workspaceFile(thread.id, "h6.txt");
    const output = (await scriptOutputs(thread.threadId)).at(-1) ?? "";
    cases.push({ name: "H6 a script cannot approve its own card", output, file, ok: !file.includes("self-approved") && /Declined|refused|cannot/i.test(output) });
    await cleanup(thread.id);
  }

  // H7 restart: one card across two Session restarts, the command ran once.
  {
    const thread = await newThread("h7", "approval-required");
    cases.push(await restartCase(thread));
    await cleanup(thread.id);
  }

  writeEvidence("m2-hostile-script.json", { model: SLUG, cases, ok: cases.every((c) => c.ok) });
};

// ---------------------------------------------------------------------------------------------------------------------
// The panel from outside

const panel = async () => {
  const results: Array<Case> = [];
  const t3 = process.env.T3_URL ?? "";
  // The script path works: service token + admin token.
  const settings = await harness("GET", "/_t3flare/harness/api/settings");
  results.push({ name: "service token + admin token reads the settings", status: settings.status, ok: settings.status === 200 && typeof settings.json?.revision === "number" });
  const changed = await harness("POST", "/_t3flare/harness/api/extensions", { extension: "codemode", settings: { inlineBudget: 2500 } });
  results.push({ name: "and changes them (revision bumps)", status: changed.status, revision: changed.json?.revision, ok: changed.status === 200 });
  await harness("POST", "/_t3flare/harness/api/extensions", { extension: "codemode", settings: { inlineBudget: 2000 } });
  // A service token without the admin token: refused.
  const noToken = await fetch(new URL("/_t3flare/harness/api/settings", HARNESS), { headers: accessHeaders, redirect: "manual" });
  results.push({ name: "service token without the admin token: refused", status: noToken.status, ok: noToken.status === 404 });
  // No Access at all: Access refuses at the edge (a redirect to the login, or 403).
  const bare = await fetch(new URL("/_t3flare/harness/api/settings", HARNESS), { redirect: "manual" });
  results.push({ name: "no Access credentials: refused at the edge", status: bare.status, ok: [302, 401, 403].includes(bare.status) });
  // A forged assertion header with the service token: refused by the Worker.
  const forged = await harness("GET", "/_t3flare/harness/api/settings", undefined, { "cf-access-jwt-assertion": "e30.e30.e30" });
  results.push({ name: "a forged assertion header changes nothing (Access replaces it; the Worker verifies)", status: forged.status, ok: forged.status === 200 || forged.status === 404 });
  // The t3 host never serves the panel, with any credential.
  for (const pathname of ["/_t3flare/harness", "/_t3flare/harness/api/settings"]) {
    const response = await fetch(new URL(pathname, t3), {
      headers: { ...accessHeaders, authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}` },
      redirect: "manual",
    });
    results.push({ name: `t3 host ${pathname}: 404`, status: response.status, ok: response.status === 404 });
  }
  // With t3's own client session cookie (paired), on either host: refused.
  const viaCookieT3 = await fetch(new URL("/_t3flare/harness/api/settings", t3), { headers: { cookie }, redirect: "manual" });
  const viaCookieAdmin = await fetch(new URL("/_t3flare/harness/api/settings", HARNESS), { headers: { cookie }, redirect: "manual" });
  results.push({ name: "t3's session cookie: refused on both hosts", statuses: [viaCookieT3.status, viaCookieAdmin.status], ok: [302, 401, 403, 404].includes(viaCookieT3.status) && [302, 401, 403].includes(viaCookieAdmin.status) });
  // A cross-origin change and a form post: refused before anything is stored.
  const before = (await harness("GET", "/_t3flare/harness/api/settings")).json?.revision;
  const crossOrigin = await harness("POST", "/_t3flare/harness/api/extensions", { extension: "tool-search", enabled: false }, { origin: "https://evil.example" });
  const form = await harness("POST", "/_t3flare/harness/api/extensions", "extension=tool-search&enabled=false", { "content-type": "application/x-www-form-urlencoded" });
  const after = (await harness("GET", "/_t3flare/harness/api/settings")).json?.revision;
  results.push({ name: "cross-origin and form-encoded changes refused", statuses: [crossOrigin.status, form.status], ok: crossOrigin.status === 403 && form.status === 403 && before === after });
  // The page: hash-only CSP.
  const page = await harness("GET", "/_t3flare/harness");
  const csp = page.headers.get("content-security-policy") ?? "";
  results.push({ name: "the page's CSP allows only its own hashed script and style", csp, ok: page.status === 200 && /script-src 'sha256-/.test(csp) && !csp.includes("'self' 'unsafe") });
  // From a Container: computer.internal does not serve the panel.
  writeEvidence("m3-panel-safety.json", { adminHost: new URL(HARNESS).host, cases: results, ok: results.every((r) => r.ok) });
};

// ---------------------------------------------------------------------------------------------------------------------
// MCP on Durable threads (parts 2 and 4): the fixture server, direct (Route B) or through Commissary (Route A)

const FIXTURE_URL = "https://t3flare-mcpfixture-tools.ian-g-pascoe.workers.dev";
const fixture = async (pathname: string, method = "GET") =>
  (await fetch(`${FIXTURE_URL}${pathname}`, { method, headers: { authorization: `Bearer ${process.env.T3FLARE_FIXTURE_BEARER ?? ""}` } })).json() as Promise<any>;
const notes = async (): Promise<Array<string>> => (await fixture("/log")).lines ?? [];

const mcpChange = (change: unknown) => harness("POST", "/_t3flare/harness/api/mcp", change);

const directSetup = async () => {
  const exists = ((await harness("GET", "/_t3flare/harness/api/mcp")).json?.servers ?? []).some((server: any) => server.name === "fixture");
  if (exists) await mcpChange({ op: "remove", server: "fixture" });
  const added = await harness("POST", "/_t3flare/harness/api/mcp/servers", {
    server: "fixture",
    url: `${FIXTURE_URL}/mcp`,
    auth: { kind: "header", header: "Authorization" },
    value: `Bearer ${process.env.T3FLARE_FIXTURE_BEARER ?? ""}`,
  });
  const tested = await harness("POST", "/_t3flare/harness/api/mcp/test", { server: "fixture" });
  const before = ((await harness("GET", "/_t3flare/harness/api/mcp")).json?.servers ?? []).find((server: any) => server.name === "fixture");
  // A direct server's tools are write until the owner marks them read (review H3): the read fixtures, as the owner would.
  for (const tool of before?.tools ?? []) {
    if (["fixture_echo", "fixture_inject", "fixture_slow"].includes(tool.upstream)) await mcpChange({ op: "class", server: "fixture", tool: tool.upstream, class: "read", hash: tool.hash });
  }
  const listed = await harness("GET", "/_t3flare/harness/api/mcp");
  const row = (listed.json?.servers ?? []).find((server: any) => server.name === "fixture");
  return {
    firstListed: (before?.tools ?? []).map((tool: any) => `${tool.upstream}:${tool.class}`), added: { status: added.status, secret: added.json?.secret ?? null }, tested: tested.json, tools: (row?.tools ?? []).map((tool: any) => `${tool.upstream}:${tool.class}`) };
};

/** One script turn on a fresh thread; the cards answered by `decide`, the fixture's new notes counted. */
const mcpScript = async (label: string, mode: string, code: string, decide: Decide, interaction = "default") => {
  const thread = await newThread(label, mode, interaction);
  const before = (await notes()).length;
  const turn = await runTurn(thread.threadId, verbatim(code), decide);
  const output = (await scriptOutputs(thread.threadId)).at(-1) ?? "";
  const added = (await notes()).slice(before);
  await cleanup(thread.id);
  return { thread, status: turn.status, cards: turn.cards, output: output.slice(0, 800), notesAdded: added };
};

const durableMcp = async (server: string, file: string) => {
  const cases: Array<Case> = [];
  // Commissary names a toolkit's tools `<toolkit>_<tool>`: the fixture toolkit's are `fixture_fixture_*`.
  const T = server === "commissary" ? "tools.mcp__commissary__fixture_" : `tools.mcp__${server}__`;
  const marker = `${server}-${Date.now().toString(36)}`;
  {
    const run = await mcpScript("mcp-read", "approval-required", `text(await ${T}fixture_echo({ text: "hello" }));`, () => "accept");
    cases.push({ name: "a read runs without a card (approval-required)", ...run, ok: run.cards.length === 0 && run.output.includes("hello") });
  }
  {
    const run = await mcpScript("mcp-write", "approval-required", `text(await ${T}fixture_note({ line: "${marker}-approved" }));`, () => "accept");
    cases.push({ name: "a write asks in approval-required; approved, one note", ...run, ok: run.cards.length === 1 && run.notesAdded.length === 1 });
  }
  {
    const run = await mcpScript("mcp-decline", "auto-accept-edits", `text(await ${T}fixture_note({ line: "${marker}-declined" }).catch((e) => e.message));`, () => "decline");
    cases.push({ name: "a write asks in auto-accept-edits; declined, no note", ...run, ok: run.cards.length === 1 && run.notesAdded.length === 0 });
  }
  {
    const run = await mcpScript("mcp-full", "full-access", `text(await ${T}fixture_note({ line: "${marker}-full" }));`, () => "accept");
    cases.push({ name: "a write runs in full access without a card", ...run, ok: run.cards.length === 0 && run.notesAdded.length === 1 });
  }
  {
    const run = await mcpScript("mcp-plan", "full-access", `text(await ${T}fixture_note({ line: "${marker}-plan" }).catch((e) => e.message));`, () => "accept", "plan");
    cases.push({ name: "plan mode refuses a write", ...run, ok: run.cards.length === 0 && run.notesAdded.length === 0 && /plan mode/.test(run.output) });
  }
  {
    const run = await mcpScript("mcp-unknown", "approval-required", `text(await ${T}fixture_unknown({ text: "u" }).catch((e) => e.message));`, () => "decline");
    cases.push({ name: "a tool without annotations is write: it asks", ...run, ok: run.cards.length === 1 });
  }
  {
    const run = await mcpScript("mcp-inject", "approval-required", `const doc = await ${T}fixture_inject({ text: "x" });\ntext(doc);`, () => "decline");
    cases.push({ name: "prompt injection in a read's result writes nothing without a card", ...run, ok: run.notesAdded.length === 0 && run.cards.every((card) => card.decision === "decline") });
  }
  writeEvidence(file, { server, cases, ok: cases.every((c) => c.ok) });
};

/** H3 on the direct server: class override stops a card; a flipped hint stays write until confirmed. */
const classCases = async () => {
  const cases: Array<Case> = [];
  const listed = async () => ((await harness("GET", "/_t3flare/harness/api/mcp")).json?.servers ?? []).find((server: any) => server.name === "fixture")?.tools ?? [];
  const unknown = (await listed()).find((tool: any) => tool.upstream === "fixture_unknown");
  await mcpChange({ op: "class", server: "fixture", tool: "fixture_unknown", class: "read", hash: unknown?.hash });
  {
    const run = await mcpScript("mcp-override", "approval-required", `text(await tools.mcp__fixture__fixture_unknown({ text: "now read" }));`, () => "decline");
    cases.push({ name: "the owner marks fixture_unknown read: no card", ...run, ok: run.cards.length === 0 && run.output.includes("unknown ran") });
  }
  const serverTools = async (name: string) => ((await harness("GET", "/_t3flare/harness/api/mcp")).json?.servers ?? []).find((server: any) => server.name === name)?.tools ?? [];
  const flipOf = async (name: string) => (await serverTools(name)).find((tool: any) => tool.upstream.endsWith("fixture_flip"));
  const before = { direct: await flipOf("fixture"), commissary: await flipOf("commissary") };
  await fixture("/flip", "POST");
  await harness("POST", "/_t3flare/harness/api/mcp/test", { server: "fixture" });
  await harness("POST", "/_t3flare/harness/api/mcp/test", { server: "commissary" });
  const after = { direct: await flipOf("fixture"), commissary: await flipOf("commissary") };
  {
    const run = await mcpScript("mcp-flip", "approval-required", `text(await tools.mcp__fixture__fixture_flip({ text: "f" }).catch((e) => e.message));`, () => "decline");
    cases.push({
      name: "direct: a server that starts claiming read stays write (never marked read by the owner), and asks",
      before: before.direct,
      after: after.direct,
      cards: run.cards,
      ok: after.direct?.class === "write" && after.direct?.suggested === "read" && run.cards.length === 1,
    });
  }
  {
    // Commissary pinned its first-seen hint (write); a changed definition that now claims read stays write, unconfirmed.
    const changed = after.commissary?.hash !== before.commissary?.hash;
    cases.push({
      name: "Commissary: a flipped hint under a changed definition stays write until the owner confirms",
      before: before.commissary,
      after: after.commissary,
      commissarySawTheChange: changed,
      ok: changed ? after.commissary?.class === "write" && after.commissary?.unconfirmed === true : after.commissary?.class === "write",
    });
  }
  await fixture("/flip", "POST");
  await mcpChange({ op: "class", server: "fixture", tool: "fixture_unknown", class: "write", hash: unknown?.hash });
  writeEvidence("m6-direct-classes.json", { cases, ok: cases.every((c) => c.ok) });
};

// ---------------------------------------------------------------------------------------------------------------------
// P3's breakdown (root's follow-up): per nested call, timed inside the script, for calls that stop at different layers:
// a Session-local tool (sandbox RPC + Session dispatch + the step's commit), a read (+ the Workspace DO), a command
// (+ the Container), and a read-only t3 tool (+ the Environment DO and t3).

const p3Breakdown = async () => {
  const thread = await newThread("p3b", "full-access");
  const code = `const N = 20;
const out = [];
const time = async (name, call) => {
  const started = Date.now();
  let failed = "";
  for (let i = 0; i < N; i++) { try { await call(); } catch (e) { failed = e.message; } }
  out.push(name + "=" + Math.round((Date.now() - started) / N) + (failed ? " (threw: " + failed.slice(0, 80) + ")" : ""));
};
await time("tool_search", () => tools.tool_search({ query: "grep" }));
await time("read", () => tools.read({ path: "src/greeting.txt" }));
await time("bash_true", () => tools.bash({ command: "true" }));
await time("t3_environment_read", () => tools.mcp__t3_code__t3_environment_read({}));
text(out.join("\\n"));`;
  const turn = await runTurn(thread.threadId, verbatim(code), () => "accept");
  const output = (await scriptOutputs(thread.threadId)).at(-1) ?? "";
  const ms = Object.fromEntries([...output.matchAll(/^(\w+)=(\d+)/gm)].map((m) => [m[1], Number(m[2])]));
  writeEvidence("m0-p3-breakdown.json", { status: turn.status, perCallMs: ms, output: output.slice(0, 800), ok: turn.status === "completed" && Object.keys(ms).length >= 3 });
  await cleanup(thread.id);
};

// ---------------------------------------------------------------------------------------------------------------------
// H6, the real proof (root's follow-up): a script's nested command waits on its card; t3_pending_request list and respond
// on that card's id (from another thread of the same project, at full access so its own calls run) are refused by t3
// (F7: "cannot approve a permission request"), and the card is still pending afterwards.

const h6Proof = async () => {
  const a = await newThread("h6a", "approval-required");
  const bThread = await threadIn(a.projectId, `${a.id}-b`, "full-access");
  const code = `text(await tools.bash({ command: "echo self-approved > h6.txt" }).catch((e) => "bash: " + e.message));`;
  let attempt: any = null;
  let stillPending: boolean | null = null;
  const turnA = await runTurn(a.threadId, verbatim(code), () => (attempt === null ? undefined : "decline"), {
    timeoutMs: 6 * 60_000,
    during: async (projection) => {
      if (attempt !== null) return;
      const card = (projection?.runtimeRequests ?? []).find((r: any) => r.status === "pending");
      if (card === undefined) return;
      const b = `const listed = await tools.mcp__t3_code__t3_pending_request({ action: "list", threadId: ${JSON.stringify(a.threadId)} }).catch((e) => "list threw: " + e.message);
const responded = await tools.mcp__t3_code__t3_pending_request({ action: "respond", threadId: ${JSON.stringify(a.threadId)}, requestId: ${JSON.stringify(card.id)}, answers: {} }).catch((e) => "respond threw: " + e.message);
text("LIST " + String(listed).slice(0, 400) + "\\nRESPOND " + String(responded).slice(0, 600));`;
      const turnB = await runTurn(bThread, verbatim(b), () => "accept", { timeoutMs: 4 * 60_000 });
      const after = projectionOf(await threadWindow(cookie, a.threadId));
      stillPending = (after?.runtimeRequests ?? []).some((r: any) => r.id === card.id && r.status === "pending");
      attempt = { cardId: card.id, cardKind: card.kind, bStatus: turnB.status, bCards: turnB.cards.length, output: ((await scriptOutputs(bThread)).at(-1) ?? "").slice(0, 1200) };
    },
  });
  const file = await workspaceFile(a.id, "h6.txt");
  const outputA = (await scriptOutputs(a.threadId)).at(-1) ?? "";
  const respondRefused = /RESPOND[\s\S]*(cannot|not a user|permission|refus|threw|error|invalid)/i.test(String(attempt?.output ?? ""));
  const result = {
    name: "H6: t3_pending_request respond on a script's pending nested card is refused; the card stays pending until the owner declines",
    attempt,
    stillPendingAfterRespond: stillPending,
    turnA: { status: turnA.status, cards: turnA.cards },
    outputA: outputA.slice(0, 400),
    file,
    ok: attempt !== null && respondRefused && stillPending === true && !file.includes("self-approved"),
  };
  writeEvidence("m2-h6-proof.json", result);
  await cleanup(a.id);
};

// ---------------------------------------------------------------------------------------------------------------------
// CLI agents through the relay (parts 3/5, M5): the direct fixture server and t3's own tools, per CLI

type RelayCli = "codex" | "pi" | "claude" | "opencode";
const cliMcp = async (cli: RelayCli) => {
  const acp = cli === "claude" || cli === "opencode";
  if (acp) await enableAcp(cookie, cli);
  else await enableCli(cookie, cli, cli);
  const workspace = `tools-cli-${cli}`;
  const marker = `${cli}-${Date.now().toString(36)}`;
  const cases: Array<Case> = [];
  // The relay's cards (their ids keep the push card's prefix, M9); a CLI's own prompts are counted apart.
  const card = (request: any) => String(request.id ?? "").includes(":t3flare-push:") && request.kind === "permission";
  const turn = async (name: string, mode: string, prompt: string, approve: "accept" | "decline", plan = false) => {
    const before = (await notes()).length;
    const result: any = await (acp ? acpTurn : cliTurn)(cookie, { cli, workspace, mode, plan, prompt, approve });
    const added = (await notes()).slice(before);
    // Each case on a fresh process: a Workspace holds at most 4 CLI processes.
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${workspace}`);
    return { name, mode, plan, run: result.runs.at(-1) ?? null, cards: result.requests.filter(card), requests: result.requests, text: result.text, items: result.items.filter((item: any) => /mcp|tool/i.test(item.type)).slice(0, 8), notesAdded: added };
  };
  const only = "Do not run any shell command; use only that MCP tool.";
  // pi has no MCP client of its own in the image: only t3's tools reach it (through t3's pi extension).
  if (cli !== "pi") {
    {
      const r = await turn("a read (fixture_echo) runs without a card", "approval-required", `Call the MCP tool fixture_echo of the "fixture" MCP server with text "hello-${marker}" and reply with exactly what it returned. ${only}`, "accept");
      cases.push({ ...r, ok: r.cards.length === 0 && r.text.includes(`hello-${marker}`) });
    }
    {
      const r = await turn("a write (fixture_note) asks in approval-required; approved: one note", "approval-required", `Call the MCP tool fixture_note of the "fixture" MCP server with line "${marker}-approved". Then say done. ${only}`, "accept");
      cases.push({ ...r, ok: r.cards.length === 1 && r.notesAdded.length === 1 });
    }
    {
      const r = await turn("a write declined: no note", "approval-required", `Call the MCP tool fixture_note of the "fixture" MCP server with line "${marker}-declined". If it is refused, say so and stop. ${only}`, "decline");
      cases.push({ ...r, ok: r.cards.length >= 1 && r.notesAdded.length === 0 });
    }
    {
      const r = await turn("a write runs in full access without a card", "full-access", `Call the MCP tool fixture_note of the "fixture" MCP server with line "${marker}-full". Then say done. ${only}`, "accept");
      cases.push({ ...r, ok: r.cards.length === 0 && r.notesAdded.length === 1 });
    }
    {
      const r = await turn("plan mode refuses a write", "full-access", `Call the MCP tool fixture_note of the "fixture" MCP server with line "${marker}-plan" now, then say what it answered. ${only}`, "accept", true);
      cases.push({ ...r, ok: r.notesAdded.length === 0 });
    }
  }
  {
    const r = await turn("t3's own tools through the relay (SPI-1039): t3_thread_list", "approval-required", `Call the t3-code MCP tool t3_thread_list and tell me how many threads it lists. ${only}`, "accept");
    cases.push({ ...r, ok: r.cards.length === 0 && /\d/.test(r.text) && !/unavailable/i.test(r.text) });
  }
  writeEvidence(`m5-cli-${cli}.json`, { cli, workspace, cases, ok: cases.every((c) => c.ok) });
};

const command = process.argv[2];
cookie = await pair();
switch (command) {
  case "m1": {
    const result = await m1();
    writeEvidence("m1-codemode.json", result);
    break;
  }
  case "probes":
    await probes(process.argv[3]);
    break;
  case "memory":
    await memory();
    break;
  case "sandbox-loss":
    await sandboxLoss();
    break;
  case "hostile":
    await hostile();
    break;
  case "panel":
    await panel();
    break;
  case "direct-setup":
    writeEvidence("m6-direct-setup.json", await directSetup());
    break;
  case "durable-mcp":
    await durableMcp(process.argv[3] ?? "fixture", process.argv[4] ?? "m6-direct-durable.json");
    break;
  case "classes":
    await classCases();
    break;
  case "p3-breakdown":
    await p3Breakdown();
    break;
  case "h6":
    await h6Proof();
    break;
  case "cli-mcp":
    await cliMcp((process.argv[3] ?? "codex") as RelayCli);
    break;
  case "stop-all": {
    // Every Workspace's Container stopped (the stage's budget is 3 at once).
    const listed = (await admin("GET", "/_t3flare/agents/workspaces")).json;
    const rows: Array<any> = Array.isArray(listed) ? listed : (listed?.workspaces ?? []);
    for (const row of rows) await admin("POST", `/_t3flare/agents/workspace-stop?id=${row.id}`);
    console.log(`stopped ${rows.length}`);
    break;
  }
  default:
    console.error("usage: tools.ts m1|probes|memory|sandbox-loss|hostile|panel");
    process.exit(2);
}
process.exit(0);
