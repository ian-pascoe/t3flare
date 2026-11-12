// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 4b's stage evidence (plan §8 M1–M5), through the admin routes and t3's own client protocol.
//
//   bun scripts/stage.ts run step4b cli4b acp --cli claude|opencode [--model <id>] [--workspace <id>]
//        M1: the CLI through t3's spawner and the channel, over ACP, without t3's drivers
//   bun scripts/stage.ts run step4b cli4b turn --cli claude|opencode [--model <slug>] [--mode <runtime mode>] [--plan]
//        [--workspace <id>] [--prompt <text>] [--thread <id>] [--approve accept|decline] [--out <file>]
//        M2/M3: one turn from t3's client protocol, every request answered
//   bun scripts/stage.ts run step4b cli4b modes --cli claude|opencode [--model <slug>] [--out <file>]
//        M2/M3: approval-required, auto-accept-edits, full-access and plan, each on a fresh thread
import * as path from "node:path";

import { admin, dispatch, itemsOf, mutateProject, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";
import { writeEvidence as writeAt } from "./lib/evidence.ts";

const [scenario = "acp", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const flag = (name: string) => args.includes(`--${name}`);
const evidence = (name: string, value: unknown) => writeAt(path.resolve(import.meta.dirname, "../../../docs/steps/step-4b", name), value);
const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
};
const finish = (name: string | undefined, report: Record<string, unknown>) => {
  const full = { scenario, ok: failures.length === 0, failures, ...report };
  if (name !== undefined) evidence(name, full);
  console.log(JSON.stringify(full, null, 1).slice(0, 8000));
  process.exit(failures.length === 0 ? 0 : 1);
};

const INSTANCE: Readonly<Record<string, { readonly instanceId: string; readonly driver: string; readonly model: string }>> = {
  claude: { instanceId: "claudeAgent", driver: "claudeAgent", model: "anthropic/claude-sonnet-5-5" },
  opencode: { instanceId: "opencode", driver: "opencode", model: "anthropic/claude-sonnet-5-5" },
};

/** A Workspace with the fixture cloned through t3's own clone, and its project (made once per id in this run). */
const projects = new Map<string, { projectId: string; root: string }>();
const ensureProject = async (cookie: string, id: string): Promise<{ projectId: string; root: string }> => {
  const known = projects.get(id);
  if (known !== undefined) return known;
  const root = `/w/${id}`;
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: root }).catch((error: unknown) => ({
    error: String(error).slice(0, 300),
  }))) as { cwd?: string; error?: string };
  if (cloned.cwd !== root && !String(cloned.error).includes("exist")) throw new Error(`clone of ${id} failed: ${cloned.error}`);
  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: root, createWorkspaceRootIfMissing: false }).catch(() => undefined);
  projects.set(id, { projectId, root });
  return { projectId, root };
};

const enable = async (cookie: string, cli: string) =>
  wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: INSTANCE[cli]!.instanceId, instance: { driver: INSTANCE[cli]!.driver, enabled: true } } });

interface TurnOptions {
  readonly cli: string;
  readonly workspace: string;
  readonly model?: string;
  readonly mode: string;
  readonly plan: boolean;
  readonly prompt: string;
  readonly threadId?: string;
  readonly approve?: "accept" | "decline";
}

/** One turn on a CLI thread (a new one, or `threadId`), every request answered; the projection's evidence. */
const cliTurn = async (cookie: string, options: TurnOptions) => {
  const started = Date.now();
  const { projectId, root } = await ensureProject(cookie, options.workspace);
  const model = { instanceId: INSTANCE[options.cli]!.instanceId, model: options.model ?? INSTANCE[options.cli]!.model, options: [] };
  let threadId = options.threadId;
  if (threadId === undefined) {
    threadId = uuid();
    await dispatch(cookie, {
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectId,
      title: `${options.cli} ${options.mode}${options.plan ? " plan" : ""}`,
      modelSelection: model,
      runtimeMode: options.mode,
      interactionMode: options.plan ? "plan" : "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  }
  const before = projectionOf(await threadWindow(cookie, threadId));
  const runsBefore = runsOf(before).length;
  const requestsBefore = new Set<string>((before?.runtimeRequests ?? []).map((r: any) => r.id));
  await sendMessage(cookie, threadId, options.prompt, model, options.plan ? { interactionMode: "plan" } : {});
  const answered: Array<{ id: string; at: number }> = [];
  let projection: any;
  while (Date.now() - started < 10 * 60_000) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.some((a) => a.id === r.id))) {
      answered.push({ id: request.id, at: Date.now() });
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision: options.approve ?? "accept" });
    }
    const runs = runsOf(projection);
    if (runs.length > runsBefore && runs.every((run) => SETTLED.has(run.status))) break;
    await sleep(1500);
  }
  const items = itemsOf(projection);
  const runs = runsOf(projection);
  const last = runs.at(-1) as any;
  const turnItems = items.filter((item: any) => last === undefined || item.runId === undefined || item.runId === last.id);
  return {
    threadId,
    root,
    model: model.model,
    runs: runs.map((run: any) => ({ id: run.id, status: run.status, failure: run.failure ?? null })),
    items: turnItems.map((item: any) => ({ type: item.type, status: item.status ?? null, title: item.title ?? item.toolName ?? null, fileName: item.fileName ?? null, input: typeof item.input === "string" ? item.input.slice(0, 120) : null })),
    proposedPlan: turnItems.filter((item: any) => item.type === "proposed_plan").map((item: any) => String(item.planMarkdown ?? item.markdown ?? item.text ?? "").slice(0, 300)),
    text: turnItems
      .filter((item: any) => item.type === "assistant_message")
      .map((item: any) => String(item.text ?? ""))
      .join("")
      .slice(-400),
    // This turn's requests only (the projection keeps the thread's).
    requests: (projection?.runtimeRequests ?? []).filter((r: any) => !requestsBefore.has(r.id)).map((r: any) => ({ kind: r.kind, requestKind: r.requestKind ?? null, status: r.status, decision: r.decision ?? null, options: (r.options ?? []).map((o: any) => o.decision) })),
    providerThreads: (projection?.providerThreads ?? []).map((thread: any) => ({ id: thread.id, nativeThreadRef: thread.nativeThreadRef ?? null, providerInstanceId: thread.providerInstanceId ?? null })),
    ms: Date.now() - started,
  };
};

const workspaceArg = (fallback: string) => arg("workspace") ?? fallback;
const EDIT_AND_TEST = "In src/greeting.txt add a new last line `Hello from the CLI.` with your file edit tool (not the shell), then run `bash test.sh` and tell me in one sentence whether it passed.";

/** The files of a Workspace's repo that differ from HEAD (git status), through the admin route. */
const changed = async (workspace: string): Promise<string> => {
  const answer = (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script: "cd /workspace/repo && git status --porcelain && git diff --stat", timeoutMs: 30_000 } })).json as any;
  return String(answer?.result?.stdout ?? answer?.result?.error ?? "").trim();
};
const reset = async (workspace: string) =>
  admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script: "cd /workspace/repo && git checkout -- . && git clean -fdq -e .t3flare", timeoutMs: 30_000 } });

switch (scenario) {
  case "acp": {
    const cli = arg("cli") ?? "claude";
    const workspace = workspaceArg(`acp-${cli}`);
    const cookie = await pair();
    await ensureProject(cookie, workspace);
    const report = (await admin("POST", "/_t3flare/agents/acp-check", { cli, workspace, ...(arg("model") === undefined ? {} : { model: arg("model") }) })).json as any;
    check("initialize answered, no login offered", report?.initialize?.error === undefined && (cli === "claude" ? report?.initialize?.authMethods?.length === 0 : true), report?.initialize);
    check("the prompt ended", report?.prompt?.stopReason === "end_turn", report?.prompt);
    if (cli === "claude") check("modes: default, no auto or bypass", report?.session?.modes?.current === "default" && !report?.session?.modes?.available?.some((m: string) => m === "auto" || m === "bypassPermissions"), report?.session?.modes);
    check("the process tree went with the kill", report?.markerProcessesAfterKill === 0, report?.markerProcessesAfterKill);
    finish(arg("out") ?? `m1-acp-${cli}.json`, { cli, workspace, report });
    break;
  }
  case "turn": {
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`cli-${cli}`);
    const result = await cliTurn(cookie, {
      cli,
      workspace,
      ...(arg("model") === undefined ? {} : { model: arg("model")! }),
      mode: arg("mode") ?? "approval-required",
      plan: flag("plan"),
      prompt: arg("prompt") ?? EDIT_AND_TEST,
      ...(arg("thread") === undefined ? {} : { threadId: arg("thread")! }),
      ...(arg("approve") === undefined ? {} : { approve: arg("approve") as "accept" | "decline" }),
    });
    check("the turn completed", result.runs.at(-1)?.status === "completed", result.runs);
    finish(arg("out"), { cli, result, changed: await changed(workspace) });
    break;
  }
  case "modes": {
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`modes-${cli}-${Date.now().toString(36)}`);
    const rows: Array<Record<string, unknown>> = [];
    // One thread, its mode changed between turns as the client does (t3 restarts the agent on a runtime-mode change).
    let threadId: string | undefined;
    for (const [mode, plan] of [
      ["approval-required", false],
      ["auto-accept-edits", false],
      ["full-access", false],
      ["full-access", true],
    ] as const) {
      await ensureProject(cookie, workspace);
      await reset(workspace);
      if (threadId !== undefined) {
        await dispatch(cookie, { type: "thread.runtime-mode.set", commandId: uuid(), threadId, runtimeMode: mode });
        await dispatch(cookie, { type: "thread.interaction-mode.set", commandId: uuid(), threadId, interactionMode: plan ? "plan" : "default" });
      }
      const result = await cliTurn(cookie, {
        cli,
        workspace,
        ...(arg("model") === undefined ? {} : { model: arg("model")! }),
        mode,
        plan,
        prompt: plan ? `Plan this change, do not make it: ${EDIT_AND_TEST}` : EDIT_AND_TEST,
        ...(threadId === undefined ? {} : { threadId }),
      });
      threadId = result.threadId;
      const diff = await changed(workspace);
      const kinds = result.requests.map((r: any) => r.requestKind ?? r.kind);
      rows.push({ mode, plan, status: result.runs.at(-1)?.status, failure: result.runs.at(-1)?.failure ?? null, asked: kinds, items: result.items.map((item: any) => `${item.type}:${item.title ?? ""}`), diff, proposedPlan: result.proposedPlan, text: result.text, threadId: result.threadId });
      if (plan) {
        check(`${mode} plan: edits nothing`, !diff.includes("greeting"), diff);
        if (cli === "claude") check(`${mode} plan: a proposed plan`, result.proposedPlan.length > 0, result.items);
      } else {
        check(`${mode}: the edit happened`, diff.includes("greeting"), { diff, runs: result.runs });
        // The edit asks as a file change, or as the command that made it (a model may append with the shell).
        if (mode === "approval-required") check(`${mode}: the edit and the command asked`, kinds.some((k: string) => /file/i.test(k)) && kinds.some((k: string) => /command/i.test(k)), kinds);
        if (mode === "auto-accept-edits") check(`${mode}: the command asked, the edit inside the project did not`, kinds.some((k: string) => /command/i.test(k)) && !kinds.some((k: string) => /file/i.test(k)), kinds);
        if (mode === "full-access") check(`${mode}: nothing asked`, kinds.length === 0, kinds);
      }
    }
    await reset(workspace);
    finish(arg("out") ?? `m${cli === "claude" ? 2 : 3}-modes.json`, { cli, workspace, rows });
    break;
  }
  case "resume": {
    // M4: a turn sets a code word, the Workspace's Container stops, the next turn on the same thread resumes the
    // agent's own session from the synced state (Claude's projects/, OpenCode's snapshot). Review F8: the proof is the
    // `acp-request` log line of a session/load or session/resume that succeeded, read from the Worker's logs after.
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`resume-${cli}-${Date.now().toString(36)}`);
    const word = `${cli === "claude" ? "PERSIMMON" : "QUINCE"}-${Math.floor(Math.random() * 90 + 10)}`;
    const first = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: false, prompt: `Remember the code word ${word}. Reply with the single word ok.` });
    // OpenCode's snapshot is taken within 15 s of a change.
    await sleep(20_000);
    const stoppedAt = Date.now();
    await admin("POST", `/_t3flare/agents/workspace-stop?id=${encodeURIComponent(workspace)}`);
    await sleep(20_000);
    const second = await cliTurn(cookie, { cli, workspace, mode: "approval-required", plan: false, threadId: first.threadId, prompt: "What was the code word? Reply with it only." });
    const native = (result: typeof first) => result.providerThreads.map((thread) => thread.nativeThreadRef?.nativeId ?? null);
    check("turn 1 completed", first.runs.at(-1)?.status === "completed", first.runs);
    check("turn 2 completed", second.runs.at(-1)?.status === "completed", second.runs);
    check("turn 2 recalls the code word", second.text.includes(word), second.text);
    check("the same native session", JSON.stringify(native(first)) === JSON.stringify(native(second)) && native(second).length === 1, { first: native(first), second: native(second) });
    check("no handoff", !second.items.some((item: any) => /handoff|context_transfer/i.test(String(item.type))), second.items);
    finish(arg("out") ?? `m4-resume-${cli}.json`, { cli, workspace, word, stoppedAt, first: { threadId: first.threadId, runs: first.runs, native: native(first) }, second: { runs: second.runs, native: native(second), text: second.text, items: second.items } });
    break;
  }
  case "two": {
    // M4: a Claude turn in one project and an OpenCode turn in another, at once (two Containers).
    const cookie = await pair();
    await enable(cookie, "claude");
    await enable(cookie, "opencode");
    const stamp = Date.now().toString(36);
    const [claude, opencode] = await Promise.all([
      cliTurn(cookie, { cli: "claude", workspace: `two-claude-${stamp}`, mode: "full-access", plan: false, prompt: EDIT_AND_TEST }),
      cliTurn(cookie, { cli: "opencode", workspace: `two-opencode-${stamp}`, mode: "full-access", plan: false, prompt: EDIT_AND_TEST }),
    ]);
    check("Claude completed", claude.runs.at(-1)?.status === "completed", claude.runs);
    check("OpenCode completed", opencode.runs.at(-1)?.status === "completed", opencode.runs);
    finish(arg("out") ?? "m4-two-at-once.json", { claude: { runs: claude.runs, ms: claude.ms, text: claude.text }, opencode: { runs: opencode.runs, ms: opencode.ms, text: opencode.text } });
    break;
  }
  case "restart": {
    // M4: the Environment restarts mid-turn; the old epoch's processes (Claude's child included) are gone before the
    // new spawn, and t3's continuation finishes the turn.
    const cookie = await pair();
    const cli = arg("cli") ?? "claude";
    await enable(cookie, cli);
    const workspace = workspaceArg(`restart-${cli}-${Date.now().toString(36)}`);
    const { projectId } = await ensureProject(cookie, workspace);
    const threadId = uuid();
    const model = { instanceId: INSTANCE[cli]!.instanceId, model: INSTANCE[cli]!.model, options: [] };
    await dispatch(cookie, { type: "thread.create", commandId: uuid(), threadId, projectId, title: `${cli} restart`, modelSelection: model, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" });
    await sendMessage(cookie, threadId, "Run the shell command `sleep 25 && echo slept`, then reply with the single word done.", model);
    await sleep(12_000);
    const before = (await admin("GET", `/_t3flare/agents/process-state?id=${encodeURIComponent(workspace)}`)).json;
    await admin("POST", "/_t3flare/restart");
    const restartedAt = Date.now();
    let projection: any;
    while (Date.now() - restartedAt < 6 * 60_000) {
      await sleep(5000);
      projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
      const runs = runsOf(projection);
      if (runs.length > 0 && runs.every((run) => SETTLED.has(run.status))) break;
    }
    const after = (await admin("GET", `/_t3flare/agents/process-state?id=${encodeURIComponent(workspace)}`)).json;
    const runs = runsOf(projection).map((run: any) => ({ status: run.status, failure: run.failure ?? null }));
    check("the turn settled", runs.length > 0, runs);
    finish(arg("out") ?? `m4-restart-${cli}.json`, { cli, workspace, runs, items: itemsOf(projection).map((item: any) => item.type), processesBefore: before, processesAfter: after });
    break;
  }
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
