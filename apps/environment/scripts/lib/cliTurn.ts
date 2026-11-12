// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off
// Step 4a: one CLI agent turn from t3's own client protocol (a Codex or Pi thread in a Workspace of the fixture), every
// request answered, and the projection's evidence. Used by `scripts/cli4a.ts` and `acceptance.ts --codex/--pi`.
import { dispatch, itemsOf, mutateProject, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./client.ts";
import { cloudProjects } from "./fixtureProject.ts";

const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";

/** A Workspace with the fixture cloned through t3's own clone, and its project (made once per id). */
export const ensureProject = async (cookie: string, id: string): Promise<{ projectId: string; root: string }> => {
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

export const enable = async (cookie: string, instanceId: string, driver: string) =>
  wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId, instance: { driver, enabled: true } } });

export const modelOf = (cli: string, slug: string | undefined) =>
  cli === "codex" ? { instanceId: "codex", model: slug ?? "gpt-6-luna", options: [] } : { instanceId: "pi", model: slug ?? "anthropic/claude-haiku-5-5", options: [] };

export interface TurnOptions {
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
export const cliTurn = async (cookie: string, options: TurnOptions) => {
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
    requests: (projection?.runtimeRequests ?? []).map((r: any) => ({ id: r.id, kind: r.kind, requestKind: r.requestKind ?? null, status: r.status, decision: r.decision ?? null })),
    providerThreads: (projection?.providerThreads ?? []).map((thread: any) => ({ id: thread.id, nativeThreadRef: thread.nativeThreadRef ?? null, providerSessionId: thread.providerSessionId ?? null, providerInstanceId: thread.providerInstanceId ?? null })),
    providerSessions: (projection?.providerSessions ?? []).map((session: any) => ({ id: session.id, status: session.status, cwd: session.cwd ?? null })),
    ms: Date.now() - started,
  };
};

