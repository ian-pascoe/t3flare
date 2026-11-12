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

/** A Workspace with the fixture cloned through t3's own clone, and its project. */
const ensureProject = async (cookie: string, id: string): Promise<{ projectId: string; root: string }> => {
  const root = `/w/${id}`;
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: root }).catch((error: unknown) => ({
    error: String(error).slice(0, 300),
  }))) as { cwd?: string; error?: string };
  if (cloned.cwd !== root && !String(cloned.error).includes("exist")) throw new Error(`clone of ${id} failed: ${cloned.error}`);
  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: root, createWorkspaceRootIfMissing: false }).catch(() => undefined);
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
  const runsBefore = runsOf(projectionOf(await threadWindow(cookie, threadId))).length;
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
    requests: (projection?.runtimeRequests ?? []).map((r: any) => ({ kind: r.kind, requestKind: r.requestKind ?? null, status: r.status, decision: r.decision ?? null, options: (r.options ?? []).map((o: any) => o.decision) })),
    providerThreads: (projection?.providerThreads ?? []).map((thread: any) => ({ id: thread.id, nativeThreadRef: thread.nativeThreadRef ?? null, providerInstanceId: thread.providerInstanceId ?? null })),
    ms: Date.now() - started,
  };
};

const workspaceArg = (fallback: string) => arg("workspace") ?? fallback;
const EDIT_AND_TEST = "In src/greeting.txt add a new last line `Hello from the CLI.` (edit the file), then run `bash test.sh` and tell me in one sentence whether it passed.";

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
    const workspace = workspaceArg(`modes-${cli}`);
    const rows: Array<Record<string, unknown>> = [];
    for (const [mode, plan] of [
      ["approval-required", false],
      ["auto-accept-edits", false],
      ["full-access", false],
      ["full-access", true],
    ] as const) {
      await ensureProject(cookie, workspace);
      await reset(workspace);
      const result = await cliTurn(cookie, { cli, workspace, ...(arg("model") === undefined ? {} : { model: arg("model")! }), mode, plan, prompt: plan ? `Plan this change, do not make it: ${EDIT_AND_TEST}` : EDIT_AND_TEST });
      const diff = await changed(workspace);
      const kinds = result.requests.map((r: any) => r.requestKind ?? r.kind);
      rows.push({ mode, plan, status: result.runs.at(-1)?.status, asked: kinds, diff, proposedPlan: result.proposedPlan, text: result.text, threadId: result.threadId });
      if (plan) {
        check(`${mode} plan: edits nothing`, !diff.includes("greeting"), diff);
        if (cli === "claude") check(`${mode} plan: a proposed plan`, result.proposedPlan.length > 0, result.items);
      } else {
        check(`${mode}: the edit happened`, diff.includes("greeting"), { diff, runs: result.runs });
        if (mode === "approval-required") check(`${mode}: the edit and the command asked`, kinds.some((k: string) => /file|edit/i.test(k)) && kinds.some((k: string) => /command|exec/i.test(k)), kinds);
        if (mode === "auto-accept-edits") check(`${mode}: the command asked, the edit did not`, kinds.some((k: string) => /command|exec/i.test(k)) && !kinds.some((k: string) => /file|edit/i.test(k)), kinds);
        if (mode === "full-access") check(`${mode}: nothing asked`, kinds.length === 0, kinds);
      }
    }
    await reset(workspace);
    finish(arg("out") ?? `m${cli === "claude" ? 2 : 3}-modes.json`, { cli, workspace, rows });
    break;
  }
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
