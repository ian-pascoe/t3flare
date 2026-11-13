// The differ (ADR-0005; step 2a plan, section 3): the Session's committed state, as it pushes it, turned into t3's
// provider events. Pure: `diff(state, pushed, now)` returns the events for what changed since the last call on `state`.
// Every id is derived from pi-durable's own ids (the generation task for text and reasoning, the tool call's id for a
// tool), so re-applying a range after a gap or a restart emits the same upserts. Shapes follow t3's Pi adapter.
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import {
  RuntimeRequestId,
  type NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRef,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  PlanId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ApprovalDecision, ContentBlock, PendingApproval, PendingQuestion, PushedEntry, SessionState, TurnState } from "@t3flare/session-protocol";
import { classifyProxyFailure, type ProxyFailure, proxyFailureMessage } from "@t3flare/models/proxyFailure";
import * as DateTime from "effect/DateTime";

import { PI_DURABLE_DRIVER } from "./capabilities.ts";

const driver = PI_DURABLE_DRIVER;
const derive = IdAllocator.derive;

/** What the adapter knows of a turn it started (`startTurn`'s input). */
export interface TurnContext {
  readonly providerTurnId: ProviderTurnId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly runOrdinal: number;
  readonly providerTurnOrdinal: number;
  readonly startedAt: DateTime.Utc;
  /** The provider turn as last emitted, to emit its terminal update. */
  readonly providerTurn: Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }>["providerTurn"];
  readonly contextWindow: number | null;
  /** Whether the turn's model takes images (a steer's attachments follow it). Absent: it does. */
  readonly acceptsImages?: boolean;
  /** The provider session the turn runs in (an approval's live response capability). */
  readonly providerSessionId: ProviderSessionId;
  /** Stop asked by t3 (`interruptTurn`): an abort settles as `interrupted`, else as `cancelled`. */
  interruptRequested?: boolean;
}

export interface DifferState {
  /** The Session's native id, the prefix of every native item id. */
  readonly sessionName: string;
  readonly turns: Map<string, TurnContext>;
  /** What was last emitted for each event key, so an unchanged item is not emitted again. */
  readonly emitted: Map<string, string>;
  /** Each item's ordinal within its turn, in first-seen order. */
  readonly ordinals: Map<string, number>;
  readonly nextOrdinal: Map<string, number>;
  /** Turns whose terminal was emitted. */
  readonly terminated: Set<string>;
  /** When each item was first seen. */
  readonly startedAt: Map<string, DateTime.Utc>;
  /** Each item's last emitted shape, to close it when its turn settles. */
  readonly items: Map<
    string,
    {
      readonly turn: string;
      readonly kind: OrchestrationV2ExecutionNode["kind"];
      readonly status: ItemStatus;
      readonly title: string | null;
      readonly body: ItemBody;
      readonly parentKey?: string;
    }
  >;
  /** Code mode's nested calls' arguments as last seen live (the committed list cuts them to 200 characters). */
  readonly nestedArgs: Map<string, Readonly<Record<string, unknown>>>;
  /** Tool calls seen in committed responses of turns still open, and their results once seen (pushes split them). */
  readonly toolCalls: Map<string, { readonly call: ToolCallInfo; readonly turn: string }>;
  readonly toolResults: Map<string, PushedEntry>;
  /** Approvals emitted as pending and not yet closed, by the Session's request id. */
  readonly approvals: Map<string, OpenApproval>;
  /** The owner's answers, by t3's runtime request id (`respondToRuntimeRequest`), to close a request as resolved. */
  readonly decisions: Map<string, { readonly decision: ApprovalDecision; readonly feedback?: string; readonly answers?: Readonly<Record<string, unknown>> }>;
  /** SPI-1055: the Todo List's revision last shown (undefined: none yet). */
  todoRev?: number;
}

interface OpenApproval {
  readonly turn: string;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

export const makeDifferState = (sessionName: string): DifferState => ({
  sessionName,
  turns: new Map(),
  emitted: new Map(),
  ordinals: new Map(),
  nextOrdinal: new Map(),
  terminated: new Set(),
  startedAt: new Map(),
  items: new Map(),
  toolCalls: new Map(),
  toolResults: new Map(),
  approvals: new Map(),
  decisions: new Map(),
  nestedArgs: new Map(),
});

/** t3's runtime request id for the Session's approval request `requestId` (stable across re-diffs and restarts). */
export const runtimeRequestIdOf = (sessionName: string, requestId: string): RuntimeRequestId =>
  RuntimeRequestId.make(`runtime-request:${driver}:${sessionName}:approval:${requestId}`);

/** The Session's approval request id of t3's runtime request id, or undefined when it is not one of ours. */
export const approvalIdOf = (sessionName: string, runtimeRequestId: string): string | undefined => {
  const prefix = `runtime-request:${driver}:${sessionName}:approval:`;
  return runtimeRequestId.startsWith(prefix) ? runtimeRequestId.slice(prefix.length) : undefined;
};

const ref = (nativeId: string): OrchestrationV2ProviderRef => ({ driver, nativeId, strength: "strong" });

const ordinalOf = (state: DifferState, turn: TurnContext, key: string): number => {
  const existing = state.ordinals.get(key);
  if (existing !== undefined) return existing;
  const next = state.nextOrdinal.get(turn.providerTurnId) ?? turn.providerTurnOrdinal * 100 + 1;
  state.ordinals.set(key, next);
  state.nextOrdinal.set(turn.providerTurnId, next + 1);
  return next;
};

const startedAtOf = (state: DifferState, key: string, now: DateTime.Utc): DateTime.Utc => {
  const existing = state.startedAt.get(key);
  if (existing !== undefined) return existing;
  state.startedAt.set(key, now);
  return now;
};

/** Pushes `event` unless an identical one was emitted under `key` (timestamps aside). */
const emitOnce = (state: DifferState, out: Array<ProviderAdapterV2Event>, key: string, event: ProviderAdapterV2Event, identity: unknown) => {
  const fingerprint = JSON.stringify(identity);
  if (state.emitted.get(key) === fingerprint) return;
  state.emitted.set(key, fingerprint);
  out.push(event);
};

type ItemStatus = "running" | "completed" | "failed" | "interrupted";
/** A turn item's type-specific fields (`type` and the rest), checked against t3's schema by its decoder. */
type ItemBody = { readonly type: string; readonly [field: string]: unknown };

const emitItem = (
  state: DifferState,
  out: Array<ProviderAdapterV2Event>,
  turn: TurnContext,
  key: string,
  kind: OrchestrationV2ExecutionNode["kind"],
  status: ItemStatus,
  title: string | null,
  body: ItemBody,
  now: DateTime.Utc,
  /** A child's parent item (code mode's nested calls, as t3's Pi provider nests them). */
  parentKey?: string,
) => {
  const nativeItemId = `${state.sessionName}:${key}`;
  const parentNativeId = parentKey === undefined ? undefined : `${state.sessionName}:${parentKey}`;
  state.items.set(key, { turn: turn.providerTurnId, kind, status, title, body, ...(parentKey === undefined ? {} : { parentKey }) });
  const startedAt = startedAtOf(state, key, now);
  const completedAt = status === "running" ? null : now;
  const nodeId = derive.nodeFromProviderItem({ driver, nativeItemId });
  const ordinal = ordinalOf(state, turn, key);
  emitOnce(
    state,
    out,
    `node:${key}`,
    {
      type: "node.updated",
      driver,
      node: {
        id: nodeId,
        threadId: turn.threadId,
        runId: turn.runId,
        parentNodeId: parentNativeId === undefined ? turn.rootNodeId : derive.nodeFromProviderItem({ driver, nativeItemId: parentNativeId }),
        rootNodeId: turn.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.providerTurnId,
        nativeItemRef: ref(nativeItemId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    },
    [kind, status],
  );
  emitOnce(
    state,
    out,
    `item:${key}`,
    {
      type: "turn_item.updated",
      driver,
      turnItem: {
        id: derive.turnItemFromProviderItem({ driver, nativeItemId }),
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.providerTurnId,
        nativeItemRef: ref(nativeItemId),
        parentItemId: parentNativeId === undefined ? null : derive.turnItemFromProviderItem({ driver, nativeItemId: parentNativeId }),
        ordinal,
        startedAt,
        updatedAt: now,
        status,
        title,
        completedAt,
        ...body,
      } as OrchestrationV2TurnItem,
    },
    [status, title, body],
  );
  if (body.type === "assistant_message") {
    const message = body as unknown as { readonly messageId: never; readonly text: string; readonly streaming: boolean };
    emitOnce(
      state,
      out,
      `message:${key}`,
      {
        type: "message.updated",
        driver,
        message: {
          id: message.messageId,
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId,
          role: "assistant",
          text: message.text,
          attachments: [],
          streaming: message.streaming,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: startedAt,
          updatedAt: now,
        },
      },
      [message.text, message.streaming],
    );
  }
};

const text = (blocks: ReadonlyArray<ContentBlock>): string =>
  blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("");

/** Text and reasoning blocks of one response (committed or live), keyed by its generation task and block index. */
const emitResponse = (
  state: DifferState,
  out: Array<ProviderAdapterV2Event>,
  turn: TurnContext,
  taskId: string,
  blocks: ReadonlyArray<ContentBlock>,
  streaming: boolean,
  now: DateTime.Utc,
) => {
  blocks.forEach((block, index) => {
    const key = `gen:${taskId}:${index}`;
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      const messageId = derive.messageFromProviderItem({ driver, nativeItemId: `${state.sessionName}:${key}` });
      emitItem(state, out, turn, key, "assistant_message", streaming ? "running" : "completed", null, {
        type: "assistant_message",
        messageId,
        text: block.text,
        streaming,
      }, now);
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
      emitItem(state, out, turn, key, "reasoning", streaming ? "running" : "completed", null, {
        type: "reasoning",
        text: block.thinking,
        streaming,
      }, now);
    }
  });
};

interface ToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Translates `/workspace/repo/…` (the Workspace's own view) to t3's `/w/<ws>/…` in a structured path field. */
export type PathOut = (path: string) => string;

const emitTool = (
  state: DifferState,
  out: Array<ProviderAdapterV2Event>,
  turn: TurnContext,
  call: ToolCallInfo,
  status: ItemStatus,
  result: PushedEntry | undefined,
  pathOut: PathOut,
  textOut: (text: string) => string,
  now: DateTime.Utc,
  parentKey?: string,
) => {
  const key = `call:${call.id}`;
  const output = result === undefined ? "" : text(result.content);
  const details = (result?.details ?? {}) as Record<string, unknown>;
  // The Todo List is shown from the Session's document as t3's todo list (`emitTodo`), not as the calls that change it;
  // a failed call stays a tool item, whose output says why.
  if (call.name === "todo" && result?.isError !== true) return;
  if (call.name === "bash") {
    const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
    emitItem(state, out, turn, key, "tool_call", status, "bash", {
      type: "command_execution",
      input: textOut(str(call.arguments.command) ?? ""),
      ...(output.length > 0 ? { output } : {}),
      ...(exitCode === undefined ? {} : { exitCode }),
    }, now, parentKey);
    return;
  }
  if (call.name === "edit" || call.name === "write") {
    const fileName = str(call.arguments.path) ?? str(call.arguments.file_path);
    if (fileName !== undefined) {
      const patch = str(details.patch);
      const diffStr = patch !== undefined ? textOut(patch) : result?.isError === true && output.trim().length > 0 ? output : undefined;
      const newStr = call.name === "write" ? str(call.arguments.content) : undefined;
      emitItem(state, out, turn, key, "tool_call", status, call.name, {
        type: "file_change",
        fileName: pathOut(fileName),
        ...(diffStr === undefined ? {} : { diffStr }),
        ...(newStr === undefined ? {} : { newStr }),
      }, now, parentKey);
      return;
    }
  }
  // The web tools (SPI-1054) as t3's own web search item, as t3's ACP adapter shows a fetch; a failed call stays a tool
  // item, whose output says why.
  if ((call.name === "web_search" || call.name === "web_fetch") && result?.isError !== true) {
    const search = call.name === "web_search";
    const pattern = str(search ? call.arguments.query : call.arguments.url)?.trim();
    const results = webResults(search ? details.results : [details], textOut);
    emitItem(state, out, turn, key, "tool_call", status, search ? null : "Fetched a page", {
      type: "web_search",
      ...(pattern === undefined || pattern === "" ? {} : { patterns: [textOut(pattern)] }),
      ...(results.length === 0 ? {} : { results }),
    }, now, parentKey);
    return;
  }
  const input = Object.fromEntries(
    Object.entries(call.arguments).map(([name, value]) => [name, name === "path" && typeof value === "string" ? pathOut(value) : value]),
  );
  emitItem(state, out, turn, key, "tool_call", status, toolTitle(call), {
    type: "dynamic_tool",
    // t3's own tools (`mcp__t3-code__…`, step 3) show as t3 shows them for its Pi provider.
    ...mcpToolPresentation({ toolName: call.name }),
    toolName: call.name,
    input,
    ...(result === undefined ? {} : { output: { content: result.content.filter((block) => block.type === "text") } }),
  }, now, parentKey);
};

/**
 * The Todo List (SPI-1055) as t3 shows another provider's (OpenCode's `emitTodo`): each change a `todo_list` row where the
 * turn changed it, and the turn's plan artifact (`plan.updated`), which t3's ingestor gives step durations. Steps keep the
 * Task's id, so a Task keeps its timing as its status moves.
 */
const emitTodo = (state: DifferState, out: Array<ProviderAdapterV2Event>, pushed: SessionState, now: DateTime.Utc) => {
  const todo = pushed.todo;
  if (todo === undefined || todo === null || todo.rev === state.todoRev) return;
  const turnId = pushed.live.run?.turn ?? Object.entries(pushed.turns).find(([, turn]) => turn.status === "running")?.[0];
  const turn = turnId === undefined || turnId === null ? undefined : state.turns.get(turnId);
  if (turn === undefined || state.terminated.has(turn.providerTurnId)) return;
  state.todoRev = todo.rev;
  const key = `todo:${turn.providerTurnId}:${todo.rev}`;
  const steps = todo.tasks.flatMap((task) => {
    const text = task.title.trim();
    return text === "" ? [] : [{ id: `todo:${task.id}`, text, status: task.status === "active" ? ("running" as const) : task.status }];
  });
  const planId = PlanId.make(`plan:${driver}:${state.sessionName}:todo:${turn.providerTurnId}`);
  emitItem(state, out, turn, key, "todo_list", "completed", "Todo list", { type: "todo_list", planId, steps }, now);
  out.push({
    type: "plan.updated",
    driver,
    plan: {
      id: planId,
      threadId: turn.threadId,
      runId: turn.runId,
      nodeId: derive.nodeFromProviderItem({ driver, nativeItemId: `${state.sessionName}:${key}` }),
      kind: "todo_list",
      status: steps.length > 0 && steps.every((step) => step.status === "completed") ? "completed" : "active",
      steps,
    },
  });
};

/** A tool item's title: code mode's, and the context tools' by what they did (SPI-1056); else the tool's name. */
const toolTitle = (call: ToolCallInfo): string => {
  const action = str(call.arguments.action);
  const name = str(call.arguments.name);
  switch (call.name) {
    case "codemode":
      return "Code mode";
    case "context_notes":
      return `Notes: ${action ?? "?"}${name === undefined ? "" : ` ${JSON.stringify(name.slice(0, 64))}`}`;
    case "context_history":
      return `History: ${action ?? "?"}`;
    case "context_rollover":
      return "Context rollover: the agent hands off to a fresh context";
    default:
      return call.name;
  }
};

/** A web tool's pages (`details.results` of `web_search`, `details` of `web_fetch`) as t3's web search results. */
const webResults = (raw: unknown, textOut: (text: string) => string): Array<{ readonly url: string; readonly title?: string; readonly snippet?: string }> =>
  (Array.isArray(raw) ? raw : []).slice(0, 20).flatMap((page: unknown) => {
    const fields = (typeof page === "object" && page !== null ? page : {}) as Record<string, unknown>;
    const url = str(fields.url)?.trim();
    if (url === undefined || url === "") return [];
    const title = str(fields.title);
    const snippet = str(fields.snippet);
    return [{ url, ...(title === undefined ? {} : { title }), ...(snippet === undefined ? {} : { snippet: textOut(snippet) }) }];
  });

/** A nested call's status as committed in the code mode result's `details.calls`. */
const nestedStatus = (status: unknown): ItemStatus =>
  status === "ok" ? "completed" : status === "error" ? "failed" : status === "cancelled" ? "interrupted" : "running";

const parseArgs = (text: unknown): Readonly<Record<string, unknown>> => {
  if (typeof text !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { args: text };
  }
};

/**
 * Code mode's nested calls (ADR-0027, plan §2.5) as children of the script's item: live from `nestedTools`, settled from
 * the result's `details.calls` (ids `<call>/c<id>` both ways, so the upserts match), omitted calls as one more child.
 */
const emitNested = (
  state: DifferState,
  out: Array<ProviderAdapterV2Event>,
  turn: TurnContext,
  parent: ToolCallInfo,
  result: PushedEntry | undefined,
  live: ReadonlyArray<NonNullable<SessionState["live"]["nestedTools"]>[number]>,
  pathOut: PathOut,
  textOut: (text: string) => string,
  now: DateTime.Utc,
) => {
  const parentKey = `call:${parent.id}`;
  const details = (result?.details ?? {}) as { calls?: ReadonlyArray<Record<string, unknown>>; omittedCalls?: { count?: unknown; failed?: unknown } };
  if (result === undefined || !Array.isArray(details.calls)) {
    for (const slot of live) {
      if (slot.parentCallId !== parent.id) continue;
      state.nestedArgs.set(slot.callId, slot.args);
      const status: ItemStatus = slot.status === "done" ? (slot.isError === true ? "failed" : "completed") : "running";
      const shown = slot.output === undefined ? undefined : ({ content: [{ type: "text", text: slot.output }] } as unknown as PushedEntry);
      emitTool(state, out, turn, { id: slot.callId, name: slot.name, arguments: slot.args }, status, slot.name === "bash" ? shown : undefined, pathOut, textOut, now, parentKey);
    }
    return;
  }
  for (const nested of details.calls) {
    const id = `${parent.id}/c${String(nested.id)}`;
    const name = typeof nested.name === "string" ? nested.name : "tool";
    const args = state.nestedArgs.get(id) ?? parseArgs(nested.args);
    emitTool(state, out, turn, { id, name, arguments: args }, nestedStatus(nested.status), undefined, pathOut, textOut, now, parentKey);
  }
  const omitted = details.omittedCalls;
  if (typeof omitted?.count === "number" && omitted.count > 0) {
    const failed = typeof omitted.failed === "number" ? omitted.failed : 0;
    emitItem(state, out, turn, `call:${parent.id}/omitted`, "tool_call", failed > 0 ? "failed" : "completed", `${omitted.count} more calls (${failed} failed)`, {
      type: "dynamic_tool",
      ...mcpToolPresentation({ toolName: "codemode" }),
      toolName: "codemode",
      input: {},
    }, now, parentKey);
  }
};

/** t3's request kind for a Session approval: a T3 tool's is a permission (as t3's Pi bridge asks). */
const requestKindOf = (kind: PendingApproval["kind"]): "command" | "file-change" | "permission" | "mcp-elicitation" => (kind === "mcp-tool" ? "permission" : kind);

/** A Session request (an approval, or step 3's question) as t3 shows it: its kinds and its turn item's own fields. */
interface RequestView {
  readonly requestId: string;
  readonly turn: string | null;
  readonly createdAt: number;
  readonly runtimeKind: OrchestrationV2RuntimeRequest["kind"];
  readonly nodeKind: "approval_request" | "user_input_request";
  readonly title: string;
  readonly item: Readonly<Record<string, unknown>>;
}

const approvalView = (approval: PendingApproval, textOut: (text: string) => string): RequestView => ({
  requestId: approval.requestId,
  turn: approval.turn,
  createdAt: approval.createdAt,
  runtimeKind: requestKindOf(approval.kind),
  nodeKind: "approval_request",
  title: approval.title ?? `Allow ${approval.tool}?`,
  item: {
    type: "approval_request",
    requestKind: requestKindOf(approval.kind),
    prompt: textOut(
      [approval.summary, approval.detail, approval.via === undefined ? undefined : `From a code mode script:\n${approval.via.script}`]
        .filter((part) => part !== undefined)
        .join("\n\n"),
    ),
    ...(approval.options === undefined ? {} : { options: approval.options }),
  },
});

/** A question (`ask_user`) as t3's \`user_input\` request, in the shape t3's Pi provider gives one (\`piQuestion\`). */
const questionView = (question: PendingQuestion): RequestView => ({
  requestId: question.requestId,
  turn: question.turn,
  createdAt: question.createdAt,
  runtimeKind: "user_input",
  nodeKind: "user_input_request",
  title: question.questions === undefined ? "Question" : question.question,
  item: {
    type: "user_input_request",
    // An MCP server's form (SPI-1079): one question per field, as the MCP host made them.
    questions: question.questions?.map((asked) => ({ ...asked, options: [...asked.options] })) ?? [
      {
        id: question.requestId,
        header: "Question",
        question: question.question,
        options: question.options.map((option) => ({ label: option, description: option, value: option })),
        allowCustomAnswer: question.allowFreeText || question.options.length === 0,
      },
    ],
  },
});

/** Opens each new pending request of a turn this provider session started, and closes those the Session no longer has. */
const emitRequests = (state: DifferState, out: Array<ProviderAdapterV2Event>, pending: ReadonlyArray<RequestView>, now: DateTime.Utc) => {
  const current = new Set(pending.map((request) => request.requestId));
  for (const view of pending) {
    if (state.approvals.has(view.requestId) || view.turn === null) continue;
    const turn = state.turns.get(view.turn);
    if (turn === undefined || state.terminated.has(turn.providerTurnId)) continue;
    const id = runtimeRequestIdOf(state.sessionName, view.requestId);
    const nativeId = `${state.sessionName}:approval:${view.requestId}`;
    const nodeId = derive.approvalNode({ requestId: id });
    const createdAt = DateTime.makeUnsafe(view.createdAt);
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id,
      nodeId,
      providerTurnId: turn.providerTurnId,
      nativeRequestRef: ref(nativeId),
      kind: view.runtimeKind,
      status: "pending",
      responseCapability: { type: "live", providerSessionId: turn.providerSessionId, supportsFeedback: true },
      createdAt,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: turn.threadId,
      runId: turn.runId,
      parentNodeId: turn.rootNodeId,
      rootNodeId: turn.rootNodeId,
      kind: view.nodeKind,
      status: "waiting",
      countsForRun: false,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.providerTurnId,
      nativeItemRef: ref(nativeId),
      runtimeRequestId: id,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: null,
    };
    const turnItem = {
      id: derive.approvalTurnItem({ requestId: id }),
      threadId: turn.threadId,
      runId: turn.runId,
      nodeId,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.providerTurnId,
      nativeItemRef: ref(nativeId),
      parentItemId: null,
      ordinal: ordinalOf(state, turn, `approval:${view.requestId}`),
      status: "waiting",
      title: view.title,
      startedAt: createdAt,
      completedAt: null,
      updatedAt: createdAt,
      requestId: id,
      ...view.item,
    } as OrchestrationV2TurnItem;
    state.approvals.set(view.requestId, { turn: turn.providerTurnId, runtimeRequest, node, turnItem });
    out.push({ type: "runtime_request.updated", driver, threadId: turn.threadId, runtimeRequest });
    out.push({ type: "node.updated", driver, node });
    out.push({ type: "turn_item.updated", driver, turnItem });
  }
  for (const [requestId, open] of state.approvals) {
    if (current.has(requestId)) continue;
    state.approvals.delete(requestId);
    const answered = state.decisions.get(open.runtimeRequest.id);
    state.decisions.delete(open.runtimeRequest.id);
    const resolved = answered !== undefined;
    out.push({
      type: "runtime_request.updated",
      driver,
      threadId: open.node.threadId,
      runtimeRequest: {
        ...open.runtimeRequest,
        status: resolved ? "resolved" : "cancelled",
        resolvedAt: now,
        ...(answered === undefined ? {} : { decision: answered.decision }),
        ...(answered?.feedback === undefined ? {} : { feedback: answered.feedback }),
        ...(answered?.answers === undefined ? {} : { answers: answered.answers }),
      },
    });
    out.push({ type: "node.updated", driver, node: { ...open.node, status: resolved ? "completed" : "cancelled", completedAt: now } });
    out.push({
      type: "turn_item.updated",
      driver,
      turnItem: { ...open.turnItem, status: resolved ? "completed" : "cancelled", completedAt: now, updatedAt: now } as OrchestrationV2TurnItem,
    });
  }
};

/** The least time after the turn's end a usage limit's reset is held to: t3 arms no resume for one not after it. */
export const MIN_RESET_MS = 30_000;

/** A model proxy failure as t3's: fixed text by its code, the reset held to at least 30 s after `now`. */
const proxyFailureOf = (failure: ProxyFailure, now: DateTime.Utc): OrchestrationV2ProviderFailure => {
  const nowMs = DateTime.toEpochMillis(now);
  const resetAt =
    failure.class === "usage_limit" && failure.resetAt !== undefined
      ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(failure.resetAt, nowMs + MIN_RESET_MS)))
      : null;
  return makeProviderFailure({
    class: failure.class,
    message: proxyFailureMessage(failure),
    code: failure.code,
    retryable: !(failure.class === "permission_error" || failure.code === "proxy_no_account"),
    resetAt,
  });
};

/**
 * A model error, classified (step 2a part 2 plan, section 3): the Session's record of the proxy's answer first, else the
 * error text (a push from before the record, or a failure the Session did not see), counted from the settle time.
 */
export const failureOf = (turn: TurnState, now: DateTime.Utc): OrchestrationV2ProviderFailure => {
  const reason = turn.reason ?? "unknown";
  const detail = turn.detail ?? "";
  if (reason === "model_error") {
    const recorded = turn.proxy?.failure;
    if (recorded !== undefined) return proxyFailureOf(recorded as ProxyFailure, now);
    const classified = classifyProxyFailure({ status: 0, retryAfter: null, text: detail, at: turn.settledAt ?? DateTime.toEpochMillis(now) });
    if (classified !== undefined) return proxyFailureOf(classified, now);
    const status = /\b([45]\d\d)\b/.exec(detail)?.[1];
    return makeProviderFailure({
      class: "provider_error",
      message: status === undefined ? "The model provider reported an error." : `The model provider returned HTTP ${status}.`,
      code: status ?? null,
      retryable: null,
    });
  }
  const messages: Record<string, string> = {
    turn_deadline: "The turn ran longer than 2 hours and was stopped.",
    restart_limit: "The agent's session was cut off too many times in a row.",
    faulted: "The agent's session failed.",
    orphaned: "The agent's session could not run this turn.",
    interrupted: "The model request was interrupted too many times.",
    no_model: "The selected model is not available.",
    turn_limit: "The turn reached its tool-round limit.",
    lost: "The agent's session lost this turn.",
  };
  return makeProviderFailure({ class: "provider_error", message: messages[reason] ?? `The turn ended without an answer (${reason}).`, code: reason });
};

/** The events for `pushed`, relative to what `state` last saw. `pathOut` translates structured path fields. */
export const diff = (
  state: DifferState,
  pushed: SessionState,
  now: DateTime.Utc,
  pathOut: PathOut = (path) => path,
  textOut: (text: string) => string = (text) => text,
): Array<ProviderAdapterV2Event> => {
  const out: Array<ProviderAdapterV2Event> = [];
  const calls = state.toolCalls;
  const results = state.toolResults;
  const slots = new Map(pushed.live.tools.map((slot) => [slot.callId, slot]));

  for (const entry of pushed.entries) {
    const turn = entry.turn === null ? undefined : state.turns.get(entry.turn);
    if (turn === undefined) continue;
    if (entry.role === "assistant") {
      emitResponse(state, out, turn, entry.byTaskId ?? `entry-${entry.id}`, entry.content, false, now);
      for (const block of entry.content) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          calls.set(block.id, { call: block as unknown as ToolCallInfo, turn: turn.providerTurnId });
        }
      }
    } else if (entry.role === "toolResult" && entry.toolCallId !== undefined) {
      results.set(entry.toolCallId, entry);
    }
  }

  // The live partial: the response streaming now, under its generation task.
  const live = pushed.live;
  const liveTurn = live.run?.turn === null || live.run === null ? undefined : state.turns.get(live.run.turn);
  if (liveTurn !== undefined && live.generation !== null && !state.terminated.has(liveTurn.providerTurnId)) {
    emitResponse(state, out, liveTurn, live.generation.taskId, live.generation.content, true, now);
  }

  for (const [id, { call, turn: turnId }] of calls) {
    const turn = state.turns.get(turnId);
    if (turn === undefined || state.terminated.has(turnId)) continue;
    const result = results.get(id);
    const slot = slots.get(id);
    const status: ItemStatus =
      result !== undefined ? (result.isError === true ? "failed" : "completed") : slot?.status === "done" ? "completed" : "running";
    emitTool(state, out, turn, call, status, result, pathOut, textOut, now);
    if (call.name === "codemode") emitNested(state, out, turn, call, result, pushed.live.nestedTools ?? [], pathOut, textOut, now);
  }

  emitTodo(state, out, pushed, now);

  emitRequests(state, out, [...pushed.approvals.map((approval) => approvalView(approval, textOut)), ...(pushed.questions ?? []).map(questionView)], now);

  // Usage of the newest response in each turn, as the provider turn's token usage.
  const usageByTurn = new Map<string, NonNullable<PushedEntry["usage"]>>();
  for (const entry of pushed.entries) {
    if (entry.turn !== null && entry.usage !== undefined) usageByTurn.set(entry.turn, entry.usage);
  }

  for (const [providerTurnId, pushedTurn] of Object.entries(pushed.turns)) {
    // The 2 h cap aborts the run in the Session; t3 shows it as a failed turn, not a Stop (step 2a plan, section 3).
    const turnState: TurnState =
      pushedTurn.status === "aborted" && pushedTurn.reason === "turn_deadline" ? { ...pushedTurn, status: "failed" } : pushedTurn;
    const turn = state.turns.get(providerTurnId);
    if (turn === undefined || state.terminated.has(providerTurnId)) continue;
    const usage = usageByTurn.get(providerTurnId);
    const tokenUsage =
      usage === undefined
        ? undefined
        : {
            usedTokens: Math.max(0, Math.round(usage.input + usage.cacheRead + usage.cacheWrite + usage.output)),
            ...(turn.contextWindow === null ? {} : { maxTokens: turn.contextWindow }),
            inputTokens: Math.round(usage.input + usage.cacheRead + usage.cacheWrite),
            cachedInputTokens: Math.round(usage.cacheRead),
            outputTokens: Math.round(usage.output),
            updatedAt: DateTime.formatIso(now),
          };
    if (turnState.status === "queued" || turnState.status === "running") {
      if (tokenUsage !== undefined) {
        emitOnce(state, out, `turn-usage:${providerTurnId}`, {
          type: "provider_turn.updated",
          driver,
          threadId: turn.threadId,
          providerTurn: { ...turn.providerTurn, tokenUsage },
        }, [tokenUsage.usedTokens, tokenUsage.outputTokens]);
      }
      continue;
    }
    // Settled: close what is still open, then the provider turn and its terminal.
    const settledStatus = turnState.status === "answered" ? "completed" : turnState.status === "aborted" ? "interrupted" : "failed";
    for (const [key, item] of state.items) {
      if (item.turn !== providerTurnId || item.status !== "running") continue;
      const closed: ItemStatus = settledStatus === "completed" ? "completed" : "interrupted";
      const body = "streaming" in item.body ? { ...item.body, streaming: false } : item.body;
      emitItem(state, out, turn, key, item.kind, closed, item.title, body, now, item.parentKey);
    }
    state.terminated.add(providerTurnId);
    for (const [id, { turn: callTurn }] of state.toolCalls) {
      if (callTurn !== providerTurnId) continue;
      state.toolCalls.delete(id);
      state.toolResults.delete(id);
      for (const nested of state.nestedArgs.keys()) if (nested.startsWith(`${id}/`)) state.nestedArgs.delete(nested);
    }
    const failure = turnState.status === "failed" ? failureOf(turnState, now) : null;
    out.push({
      type: "provider_turn.updated",
      driver,
      threadId: turn.threadId,
      providerTurn: {
        ...turn.providerTurn,
        status: settledStatus === "completed" ? "completed" : settledStatus === "interrupted" ? "interrupted" : "failed",
        completedAt: now,
        ...(tokenUsage === undefined ? {} : { tokenUsage }),
      },
    });
    if (failure !== null) {
      const failureKey = `terminal-failure:${providerTurnId}`;
      const ordinal = ordinalOf(state, turn, failureKey);
      out.push({
        type: "turn_item.updated",
        driver,
        turnItem: {
          // The id t3's ingestor gives the error item it makes from the failed `turn.terminal` below
          // (provider-core `makeProviderFailureTurnItem`, as t3's own Pi adapter names it): one item, not two.
          id: derive.turnItemFromProviderItem({ driver, nativeItemId: `terminal-failure:${turn.providerTurnId}` }),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "failed",
          title: failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure,
        },
      });
      out.push({
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.providerTurnId,
        runOrdinal: turn.runOrdinal as never,
        failureItemOrdinal: ordinal as never,
        status: "failed",
        failure,
        threadDisposition: turnState.reason === "faulted" || turnState.reason === "orphaned" ? "broken" : "reusable",
      });
    } else {
      out.push({
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.providerTurnId,
        runOrdinal: turn.runOrdinal as never,
        status: settledStatus === "completed" ? "completed" : turn.interruptRequested === true ? "interrupted" : "cancelled",
        failure: null,
        threadDisposition: "reusable",
      });
    }
  }
  return out;
};
