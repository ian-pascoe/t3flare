// @effect-diagnostics globalConsole:off globalDate:off
// Step 3: an owner's thread on the stage's fixture project with the Durable agent, driven as the stock client drives it,
// and its projection read until a condition holds (the M2–M4 scripts).
import { dispatch, projectionOf, runsOf, SETTLED, sendMessage, sleep, threadWindow, uuid } from "./client.ts";

export const MODEL = { instanceId: "piDurable", model: "anthropic/claude-haiku-5-5" };

export const createThread = async (
  cookie: string,
  projectId: string,
  options: { readonly title: string; readonly runtimeMode?: string; readonly interactionMode?: string },
): Promise<string> => {
  const threadId = uuid();
  await dispatch(cookie, {
    type: "thread.create",
    commandId: uuid(),
    threadId,
    projectId,
    title: options.title,
    modelSelection: MODEL,
    runtimeMode: options.runtimeMode ?? "full-access",
    interactionMode: options.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
};

export const say = (cookie: string, threadId: string, text: string) => sendMessage(cookie, threadId, text, MODEL as never);

export const projection = async (cookie: string, threadId: string): Promise<any> => projectionOf(await threadWindow(cookie, threadId));

export const pendingOf = (p: any): Array<any> => (p?.runtimeRequests ?? []).filter((request: any) => request.status === "pending");

/** Reads the thread until `done` holds or `timeoutMs` passes; the last projection either way. */
export const until = async (cookie: string, threadId: string, done: (p: any) => boolean, timeoutMs = 240_000): Promise<any> => {
  const started = Date.now();
  let last: any;
  while (Date.now() - started < timeoutMs) {
    last = await projection(cookie, threadId).catch(() => last);
    if (last !== undefined && done(last)) return last;
    await sleep(1500);
  }
  return last;
};

export const settled = (p: any) => runsOf(p).length > 0 && runsOf(p).every((run) => SETTLED.has(run.status));

/** The thread's T3 tool calls (`mcp__t3-code__…` items): name, status and a bounded output. */
export const t3Calls = (p: any) =>
  (p?.turnItems ?? [])
    .filter((item: any) => item.type === "dynamic_tool" && String(item.toolName).startsWith("mcp__t3-code__"))
    .map((item: any) => ({ tool: String(item.toolName).replace("mcp__t3-code__", ""), status: item.status, output: JSON.stringify(item.output ?? null).slice(0, 300) }));

export const replyOf = (p: any): string =>
  (p?.turnItems ?? []).filter((item: any) => item.type === "assistant_message").map((item: any) => String(item.text ?? "")).join("\n");

/** Accepts every pending approval as the owner, until the runs settle; the requests it answered. */
export const approveAll = async (cookie: string, threadId: string, timeoutMs = 300_000, decision = "accept"): Promise<{ readonly projection: any; readonly answered: Array<any> }> => {
  const answered: Array<any> = [];
  const started = Date.now();
  let p: any;
  while (Date.now() - started < timeoutMs) {
    p = await projection(cookie, threadId).catch(() => p);
    for (const request of pendingOf(p).filter((r: any) => !answered.some((a) => a.id === r.id))) {
      answered.push(request);
      await dispatch(cookie, { type: "runtime-request.respond", commandId: uuid(), threadId, requestId: request.id, decision });
    }
    if (p !== undefined && settled(p) && pendingOf(p).length === 0) break;
    await sleep(1500);
  }
  return { projection: p, answered };
};
