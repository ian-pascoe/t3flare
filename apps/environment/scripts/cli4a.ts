// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 4a's stage evidence (plan §8 M1–M5), through the admin routes and t3's own client protocol.
//
//   bun scripts/stage.ts run step4a cli4a channel [--workspace <id>]          M1: the probe through t3's spawner
//   bun scripts/stage.ts run step4a cli4a restart [--workspace <id>]          M1: Environment restart, Workspace DO abort
//   bun scripts/stage.ts run step4a cli4a turn --cli codex|pi [--model <slug>] [--mode approval-required|full-access]
//        [--plan] [--workspace <id>] [--prompt <text>] [--thread <id>] [--out <file>]
//                                                                             M3/M4: a CLI turn from t3's client protocol
//   bun scripts/stage.ts run step4a cli4a two                                  M5: a Codex and a Pi turn at once, two Workspaces
//   bun scripts/stage.ts run step4a cli4a resume --cli codex|pi                M5: a turn, the Container stopped, a turn that resumes
import * as path from "node:path";

import { admin, dispatch, itemsOf, mutateProject, pair, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./lib/client.ts";
import { writeEvidence as writeAt } from "./lib/evidence.ts";
import { cloudProjects } from "./lib/fixtureProject.ts";

const [scenario = "channel", ...args] = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const flag = (name: string) => args.includes(`--${name}`);
const evidence = (name: string, value: unknown) => writeAt(path.resolve(import.meta.dirname, "../../../docs/steps/step-4a", name), value);
const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
};
const finish = (name: string | undefined, report: Record<string, unknown>) => {
  const full = { scenario, ok: failures.length === 0, failures, ...report };
  if (name !== undefined) evidence(name, full);
  console.log(JSON.stringify(full, null, 1).slice(0, 6000));
  process.exit(failures.length === 0 ? 0 : 1);
};
const processCheck = async (body: Record<string, unknown>) => (await admin("POST", "/_t3flare/agents/process-check", body)).json;
const processState = async (workspace: string) => (await admin("GET", `/_t3flare/agents/process-state?id=${encodeURIComponent(workspace)}`)).json;

/** A Workspace with the fixture cloned through t3's own clone, and its project (made once per id). */
const ensureProject = async (cookie: string, id: string): Promise<{ projectId: string; root: string }> => {
  const root = `/w/${id}`;
  const existing = (await cloudProjects(cookie)).find((project) => project.workspaceRoot === root);
  if (existing !== undefined) return { projectId: existing.id, root };
  const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", { remoteUrl: `https://github.com/${FIXTURE}.git`, destinationPath: root }).catch((error: unknown) => ({
    error: String(error).slice(0, 300),
  }))) as { cwd?: string; error?: string };
  if (cloned.cwd !== root && !String(cloned.error).includes("exist")) throw new Error(`clone of ${id} failed: ${cloned.error}`);
  const projectId = uuid();
  await mutateProject(cookie, { type: "project.create", commandId: uuid(), projectId, title: id, workspaceRoot: root, createWorkspaceRootIfMissing: false });
  return { projectId, root };
};

const enable = async (cookie: string, instanceId: string, driver: string) =>
  wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId, instance: { driver, enabled: true } } });

const modelOf = (cli: string, slug: string | undefined) =>
  cli === "codex" ? { instanceId: "codex", model: slug ?? "gpt-6-luna", options: [] } : { instanceId: "pi", model: slug ?? "anthropic/claude-haiku-5-5", options: [] };

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
  const model = modelOf(options.cli, options.model);
  let threadId = options.threadId;
  if (threadId === undefined) {
    threadId = uuid();
    await dispatch(cookie, {
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectId,
      title: `${options.cli} ${options.workspace}`,
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
  const answered: Array<string> = [];
  let projection: any;
  while (Date.now() - started < 10 * 60_000) {
    projection = projectionOf(await threadWindow(cookie, threadId).catch(() => undefined));
    for (const request of (projection?.runtimeRequests ?? []).filter((r: any) => r.status === "pending" && !answered.includes(r.id))) {
      answered.push(request.id);
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
    items: turnItems.map((item: any) => ({ type: item.type, status: item.status ?? null, fileName: item.fileName ?? null, input: typeof item.input === "string" ? item.input.slice(0, 120) : null, exitCode: item.exitCode ?? null, ...(item.type === "error" || item.type === "proposed_plan" ? { detail: JSON.stringify(item).slice(0, 800) } : {}) })),
    text: turnItems
      .filter((item: any) => item.type === "assistant_message")
      .map((item: any) => String(item.text ?? ""))
      .join("")
      .slice(-400),
    requests: (projection?.runtimeRequests ?? []).map((r: any) => ({ kind: r.kind, requestKind: r.requestKind ?? null, status: r.status, decision: r.decision ?? null })),
    providerThreads: (projection?.providerThreads ?? []).map((thread: any) => ({ id: thread.id, nativeThreadRef: thread.nativeThreadRef ?? null, providerSessionId: thread.providerSessionId ?? null, providerInstanceId: thread.providerInstanceId ?? null })),
    providerSessions: (projection?.providerSessions ?? []).map((session: any) => ({ id: session.id, status: session.status, cwd: session.cwd ?? null })),
    ms: Date.now() - started,
  };
};

const workspaceArg = (fallback: string) => arg("workspace") ?? fallback;

switch (scenario) {
  case "channel": {
    const workspace = workspaceArg("step3-fixture");
    const report = await processCheck({ op: "check", workspace, roundTrips: Number(arg("round-trips") ?? 200) });
    check("200 round trips", report?.roundTrips?.n === Number(arg("round-trips") ?? 200), report?.roundTrips);
    check("4 MiB in and out", report?.in4MiB?.ok === true && report?.out4MiB?.ok === true, { in: report?.in4MiB, out: report?.out4MiB });
    check("stderr apart", report?.stderrLines >= 1, report?.stderrLines);
    check("the kill took the TERM-ignoring child", report?.markerProcessesAfterKill === 0, report?.markerProcessesAfterKill);
    finish(arg("out") ?? "m1-channel.json", { workspace, report });
    break;
  }
  case "restart": {
    const workspace = workspaceArg("step3-fixture");
    // 1. The Environment restarts with a process held: the next start in that Workspace kills the old epoch's process.
    const held = await processCheck({ op: "hold", workspace });
    const before = await processCheck({ op: "count", workspace, marker: held.key });
    const stateBefore = await processState(workspace);
    await admin("POST", "/_t3flare/restart");
    await sleep(3000);
    const after = await processCheck({ op: "check", workspace, roundTrips: 5 });
    const oldAfter = await processCheck({ op: "count", workspace, marker: held.key });
    check("the held process ran before the restart", before.count >= 1, before);
    check("the old epoch's process is gone after the next start", oldAfter.count === 0, oldAfter);
    check("the new start works", after?.roundTrips?.n === 5, after?.roundTrips);
    // 2. The Workspace DO aborts with a process held: the handle ends (unknown epoch) and the process goes with the object.
    const held2 = await processCheck({ op: "hold", workspace });
    const stateHeld = await processState(workspace);
    await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { probeProcess: { op: "abort" } });
    const abortedAt = Date.now();
    let channelAfterAbort = await processState(workspace);
    while (channelAfterAbort?.channel?.live !== 0 && Date.now() - abortedAt < 150_000) {
      await sleep(5000);
      channelAfterAbort = await processState(workspace);
    }
    const handleEndedMs = Date.now() - abortedAt;
    const held2After = await processCheck({ op: "count", workspace, marker: held2.key });
    check("the aborted Workspace's process is gone", held2After.count === 0, held2After);
    check("the Environment's handle ended (heartbeat or push answered unknown)", channelAfterAbort?.channel?.live === 0, channelAfterAbort?.channel);
    await processCheck({ op: "release", workspace });
    finish(arg("out") ?? "m1-restart.json", { workspace, environmentRestart: { held, before, stateBefore, after: after?.roundTrips, oldAfter }, workspaceAbort: { held: held2, stateHeld, channelAfterAbort, handleEndedMs, held2After } });
    break;
  }
  case "turn": {
    const cookie = await pair();
    const cli = arg("cli") ?? "codex";
    await enable(cookie, cli, cli);
    const result = await cliTurn(cookie, {
      cli,
      workspace: workspaceArg(`cli-${cli}`),
      ...(arg("model") === undefined ? {} : { model: arg("model")! }),
      mode: arg("mode") ?? "approval-required",
      plan: flag("plan"),
      prompt: arg("prompt") ?? "In src/greeting.txt add a new last line `Hello from the CLI.` (edit the file), then run `bash test.sh` and tell me in one sentence whether it passed.",
      ...(arg("thread") === undefined ? {} : { threadId: arg("thread")! }),
      ...(arg("approve") === undefined ? {} : { approve: arg("approve") as "accept" | "decline" }),
    });
    check("the turn completed", result.runs.at(-1)?.status === "completed", result.runs);
    finish(arg("out"), { cli, result, processes: await processState(workspaceArg(`cli-${cli}`)) });
    break;
  }
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
