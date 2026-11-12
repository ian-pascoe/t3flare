// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off nodeBuiltinImport:off globalTimers:off
// Step 4b: Claude Code and OpenCode turns from t3's own client protocol, shared by `scripts/cli4b.ts` (the milestones'
// evidence) and `scripts/acceptance.ts --claude --opencode`.
import { admin, dispatch, itemsOf, mutateProject, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid, wsCall } from "./client.ts";

const FIXTURE = process.env.T3FLARE_FIXTURE_REPO ?? "ian-pascoe/t3flare-fixture";

export const INSTANCE: Readonly<Record<string, { readonly instanceId: string; readonly driver: string; readonly model: string }>> = {
  claude: { instanceId: "claudeAgent", driver: "claudeAgent", model: "anthropic/claude-sonnet-5-5" },
  opencode: { instanceId: "opencode", driver: "opencode", model: "anthropic/claude-sonnet-5-5" },
};

/** A Workspace with the fixture cloned through t3's own clone, and its project (made once per id in this run). */
const projects = new Map<string, { projectId: string; root: string }>();
export const ensureProject = async (cookie: string, id: string): Promise<{ projectId: string; root: string }> => {
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

export const enable = async (cookie: string, cli: string) =>
  wsCall(cookie, "server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: INSTANCE[cli]!.instanceId, instance: { driver: INSTANCE[cli]!.driver, enabled: true } } });

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

export const EDIT_AND_TEST = "In src/greeting.txt add a new last line `Hello from the CLI.` with your file edit tool (not the shell), then run `bash test.sh` and tell me in one sentence whether it passed.";

/** The files of a Workspace's repo that differ from HEAD (git status), through the admin route. */
export const changed = async (workspace: string): Promise<string> => {
  const answer = (await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script: "cd /workspace/repo && git status --porcelain && git diff --stat", timeoutMs: 30_000 } })).json as any;
  return String(answer?.result?.stdout ?? answer?.result?.error ?? "").trim();
};
export const reset = async (workspace: string) =>
  admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(workspace)}`, { exec: { script: "cd /workspace/repo && git checkout -- . && git clean -fdq -e .t3flare", timeoutMs: 30_000 } });

