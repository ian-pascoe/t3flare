// The `permissions` extension (step 2a plan, section 3 → Runtime modes and approvals): wraps of `bash`, `edit` and
// `write` that check the Session's runtime mode, ask the owner when it needs them to, wait, then run the wrapped tool or
// return the decline. Modelled on cloudpid@b8097ff0:packages/extensions/src/approvals.ts (`withApproval`), without
// Effect:
//
// - A request is stored in the Session DO's storage, keyed by the asking call's task, so a rerun of the call after a
//   restart finds it still waiting (and waits again), or finds the answer given meanwhile.
// - Each attempt that reaches the wait marks it as progress (`api.progressed`, cloudpid's pi-durable patch #647), so the
//   restarts that cut a waiting call off never reach `restartLimit`.
// - The wait has no deadline. Cancelling it (Stop) withdraws the request; a request whose call ended is settled.
// - The wrapped tools are replay-safe for the wait only: a memo is committed before the wrapped tool runs, and a rerun
//   that finds it (the tool started, then the Session restarted) returns an error instead of running an unsafe tool
//   twice, as pi-durable does for a tool that is not replay-safe.
//
// Also here: the path translation of t3's `/w/<id>` (the Workspace as t3 names it) to `/workspace/repo` (as the tools
// see it) in the arguments of the file tools and in `bash`'s command (step 2a plan, R13).
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalConsole:off
import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, section, type ToolExecutionApi, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import type { ApprovalDecision, InteractionMode, PendingApproval, RuntimeMode } from "@t3flare/session-protocol";

/** The Durable Object's synchronous key-value storage. */
export interface ApprovalStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
}

export interface StoredAnswer {
  readonly decision: ApprovalDecision;
  readonly feedback?: string;
}

const REQUESTS_KEY = "t3flare:approval-requests";
const ANSWERS_KEY = "t3flare:approval-answers";
const ACCEPTED_KEY = "t3flare:approval-accepted-kinds";

/** Most characters of a request's summary (the command, or the path and what changes). */
export const MAX_SUMMARY = 2_000;

export type ApprovalKind = PendingApproval["kind"];

/**
 * What "accept for the session" covers (review C4): a kind for the coding tools (every command, every file change), one
 * tool by name for t3's MCP tools (so accepting `delegate_task` never unlocks `bash` or another T3 tool, nor the
 * reverse), and nothing for a linked thread's push (owner decision D1: every push asks).
 */
export const acceptanceKeyOf = (call: { readonly tool: string; readonly kind: ApprovalKind }): string | null =>
  call.kind === "git-push" ? null : call.kind === "mcp-tool" ? `mcp-tool:${call.tool}` : call.kind;

/** A request a tool call waits on: stored by the asking call's task, withdrawn when its turn ends. */
export interface WaitingRequest {
  readonly requestId: string;
  readonly turn: string | null;
}

/**
 * Requests tool calls wait on durably, over the Session's storage (approvals; step 3's questions). A request is stored
 * by the asking call's task, so a rerun of the call after a restart finds it still waiting (and waits again), or finds
 * the answer given meanwhile. `changed` runs whenever the pending requests change.
 */
export class WaitingRequests<Request extends WaitingRequest, Answer> {
  readonly #storage: ApprovalStorage;
  readonly #changed: () => void;
  readonly #keys: { readonly requests: string; readonly answers: string };
  /** Calls waiting for an answer in this instance, by request. */
  readonly #waiters = new Map<string, () => void>();

  constructor(storage: ApprovalStorage, keys: { readonly requests: string; readonly answers: string }, changed: () => void) {
    this.#storage = storage;
    this.#keys = keys;
    this.#changed = changed;
  }

  protected get storage(): ApprovalStorage {
    return this.#storage;
  }

  pending(): ReadonlyArray<Request> {
    return this.#storage.get<Request[]>(this.#keys.requests) ?? [];
  }

  #answers(): Readonly<Record<string, Answer>> {
    return this.#storage.get<Record<string, Answer>>(this.#keys.answers) ?? {};
  }

  #putRequests(next: ReadonlyArray<Request>): void {
    this.#storage.put(this.#keys.requests, next);
    this.#changed();
  }

  /**
   * Ask for `request`, and wait for the answer. A rerun with the same id waits for the request already made, or takes
   * the answer given while no call waited. `waiting` runs once the request is stored, just before the wait.
   */
  async ask(request: Request, waiting: () => Promise<void>, context: Context): Promise<Answer> {
    const ready = this.#answers()[request.requestId];
    if (ready !== undefined) return ready;
    if (!this.pending().some((pending) => pending.requestId === request.requestId)) this.#putRequests([...this.pending(), request]);
    await waiting();
    const signal = context.abortSignal;
    await new Promise<void>((resolve, reject) => {
      if (this.#answers()[request.requestId] !== undefined) return resolve();
      const onAbort = () => {
        this.#waiters.delete(request.requestId);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
      };
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.set(request.requestId, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    const answer = this.#answers()[request.requestId];
    if (answer === undefined) throw new Error(`Request ${request.requestId} was lost`);
    return answer;
  }

  /** The call that asked `requestId` is done: withdraw its request if it still waits, and forget its answer. */
  settle(requestId: string): void {
    this.#waiters.delete(requestId);
    const answers = this.#answers();
    if (answers[requestId] !== undefined) {
      this.#storage.put(this.#keys.answers, Object.fromEntries(Object.entries(answers).filter(([key]) => key !== requestId)));
    }
    const remaining = this.pending().filter((pending) => pending.requestId !== requestId);
    if (remaining.length !== this.pending().length) this.#putRequests(remaining);
  }

  /** Answers `requestId`; the request answered, or undefined when none waits (answered already, or its call ended). */
  protected give(requestId: string, answer: Answer): Request | undefined {
    const request = this.pending().find((pending) => pending.requestId === requestId);
    if (request === undefined) return undefined;
    this.#storage.put(this.#keys.answers, { ...this.#answers(), [requestId]: answer });
    this.#putRequests(this.pending().filter((pending) => pending.requestId !== requestId));
    this.#waiters.get(requestId)?.();
    return request;
  }

  /** Withdraws the requests of turns that are no longer live, and the answers no call took (only while idle). */
  dropAbandoned(liveTurns: ReadonlySet<string>): void {
    const kept = this.pending().filter((pending) => pending.turn !== null && liveTurns.has(pending.turn));
    if (kept.length !== this.pending().length) this.#putRequests(kept);
    if (liveTurns.size === 0 && Object.keys(this.#answers()).length > 0) this.#storage.put(this.#keys.answers, {});
  }
}

/** The Session's approval requests. */
export class ApprovalStore extends WaitingRequests<PendingApproval, StoredAnswer> {
  constructor(storage: ApprovalStorage, changed: () => void) {
    super(storage, { requests: REQUESTS_KEY, answers: ANSWERS_KEY }, changed);
  }

  /** What the owner accepted for the rest of the Session (`acceptForSession`), by `acceptanceKeyOf`. */
  #accepted(): ReadonlySet<string> {
    return new Set(this.storage.get<string[]>(ACCEPTED_KEY) ?? []);
  }

  /** Whether the owner accepted calls like this one for the rest of the Session. */
  acceptedFor(call: { readonly tool: string; readonly kind: ApprovalKind }): boolean {
    const key = acceptanceKeyOf(call);
    return key !== null && this.#accepted().has(key);
  }

  /** The owner's answer to `requestId`; false when no such request waits (answered already, or its call ended). */
  answer(requestId: string, decision: ApprovalDecision, feedback?: string): boolean {
    const trimmed = feedback?.trim();
    const request = this.give(requestId, { decision, ...(trimmed === undefined || trimmed === "" ? {} : { feedback: trimmed }) });
    if (request === undefined) return false;
    const key = acceptanceKeyOf(request);
    if (decision === "acceptForSession" && key !== null) this.storage.put(ACCEPTED_KEY, [...new Set([...this.#accepted(), key])]);
    return true;
  }
}

/** What the permissions read of the Session at each call. */
export interface PermissionsHost {
  readonly store: ApprovalStore;
  /** The Session's runtime mode now (each turn's `submitTurn` sets it). */
  readonly mode: () => RuntimeMode;
  /** The Session's interaction mode now (step 3, F-plan; each turn's `submitTurn` sets it). */
  readonly interaction: () => InteractionMode;
  /** The turn the Session runs now. */
  readonly turn: () => string | null;
  /** The Session's Workspace id, for path translation; null without one. */
  readonly workspaceId: () => string | null;
  /** Runs before each command is started (step 3, D1: a linked Session notes its work in the Workspace). */
  readonly beforeCommand?: () => Promise<void>;
}

const kindOf = (tool: string): ApprovalKind => (tool === "bash" ? "command" : "file-change");

/** Whether `mode` asks before a call of `kind`. */
export const asks = (mode: RuntimeMode, kind: ApprovalKind): boolean =>
  mode === "approval-required" || (mode === "auto-accept-edits" && kind === "command");

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");
const cut = (text: string, max = MAX_SUMMARY) => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** What the owner is shown: the command, or the path and the change's size. */
export const summaryOf = (tool: string, args: Readonly<Record<string, unknown>>): { readonly summary: string; readonly detail?: string } => {
  if (tool === "bash") return { summary: cut(textOf(args.command)) };
  const path = textOf(args.path);
  if (tool === "edit") {
    const edits = Array.isArray(args.edits) ? (args.edits as ReadonlyArray<{ oldText?: unknown; newText?: unknown }>) : [];
    const detail = edits
      .slice(0, 3)
      .map((edit) => `- ${cut(textOf(edit.oldText), 300)}\n+ ${cut(textOf(edit.newText), 300)}`)
      .join("\n");
    return { summary: `Edit ${path} (${edits.length} change${edits.length === 1 ? "" : "s"})`, ...(detail === "" ? {} : { detail }) };
  }
  const content = textOf(args.content);
  return { summary: `Write ${path} (${content.length} characters)`, detail: cut(content, 600) };
};

export const STARTED_MEMO = "t3flare.started";

/** What a tool that changes files answers in plan mode (step 3, F-plan): fixed, and nothing runs. */
export const PLAN_MODE_REFUSAL =
  "Refused: this thread is in plan mode, which is read-only. Investigate with read-only tools and reply with a plan; the owner switches the thread out of plan mode to implement it.";

export const planRefusal = () => ({ output: [{ type: "text" as const, text: PLAN_MODE_REFUSAL }], isError: true, details: { planMode: true } });

/**
 * t3's plan-mode instruction (t3code/packages/provider-core/src/server/orchestrationInstructions.ts,
 * `T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS`, not exported there), present in the prompt only while the thread is in plan mode.
 */
export const PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export const interactionModeSection = (interaction: () => InteractionMode): Extension =>
  defineExtension({
    name: "interaction-mode",
    sections: [section("t3_interaction_mode", () => (interaction() === "plan" ? PLAN_MODE_INSTRUCTIONS : undefined))],
  });

const declinedResult = (answer: StoredAnswer) => ({
  output: [
    {
      type: "text" as const,
      text: `${answer.decision === "cancel" ? "Cancelled" : "Declined"} by the owner: the call did not run.${
        answer.feedback === undefined ? "" : ` Their feedback: ${answer.feedback}`
      } Do not ask again for the same change unless the owner wants it.`,
    },
  ],
  isError: true,
  details: { approval: { approved: false, decision: answer.decision, feedback: answer.feedback ?? null } },
});

/**
 * Asks the owner for `request` and waits durably (a rerun after a restart waits again, or takes the answer given
 * meanwhile), marking each wait as progress; the request is settled when the wait ends. The decline's result when
 * declined or cancelled, else undefined.
 */
export const askOwner = async (
  store: ApprovalStore,
  request: Omit<PendingApproval, "requestId" | "callId" | "createdAt">,
  api: ToolExecutionApi,
  context: Context,
): Promise<ReturnType<typeof declinedResult> | undefined> => {
  const requestId = String(api.taskId);
  try {
    const answer = await store.ask(
      { ...request, requestId, callId: api.callId, createdAt: Date.now() },
      () => api.progressed(context).catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "progressed-failed", error: String(error) }))),
      context,
    );
    return answer.decision === "decline" || answer.decision === "cancel" ? declinedResult(answer) : undefined;
  } finally {
    store.settle(requestId);
  }
};

/** The result of a call cut off by a restart after it started: it is not run again. */
export const cutOffResult = () => ({
  output: [
    {
      type: "text" as const,
      text: "This call was cut off by a restart after it started, so it may have partly run. Check the state before running it again.",
    },
  ],
  isError: true,
});

/** `tool`, asking before it runs when the mode says so. */
const guarded = <T extends ToolRegistration>(host: PermissionsHost, tool: T): T => {
  const unsafe = tool.replay !== "safe";
  return {
    ...tool,
    replay: "safe",
    async execute(args: Record<string, unknown>, api: ToolExecutionApi, context: Context) {
      if (unsafe && (await api.memo<boolean>(STARTED_MEMO, context)) === true) return cutOffResult();
      const kind = kindOf(tool.name);
      const plan = host.interaction() === "plan";
      // Plan mode is read-only: no file change runs, and every command asks (a command cannot be classified as reading).
      if (plan && kind === "file-change") return planRefusal();
      if (plan || (asks(host.mode(), kind) && !host.store.acceptedFor({ tool: tool.name, kind }))) {
        const declined = await askOwner(host.store, { turn: host.turn(), tool: tool.name, kind, ...summaryOf(tool.name, args) }, api, context);
        if (declined !== undefined) return declined;
      }
      if (unsafe) await api.memo(STARTED_MEMO, true, context);
      if (kind === "command") await host.beforeCommand?.();
      return tool.execute(args as never, api as never, context);
    },
  } as T;
};

const PATH_TOOLS = ["read", "write", "edit", "ls", "find", "grep"] as const;

/** `/w/<id>` (t3's name for the Workspace) as `/workspace/repo` in `text`. */
export const toToolPath = (text: string, workspaceId: string | null): string =>
  workspaceId === null ? text : text.replace(new RegExp(`/w/${workspaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$|[\\s'"\`;:)])`, "g"), "/workspace/repo");

const translated = <T extends ToolRegistration>(host: PermissionsHost, tool: T, field: "path" | "command"): T => ({
  ...tool,
  async execute(args: Record<string, unknown>, api: ToolExecutionApi, context: Context) {
    const value = args[field];
    const next = typeof value === "string" ? { ...args, [field]: toToolPath(value, host.workspaceId()) } : args;
    return tool.execute(next as never, api as never, context);
  },
});

const wrap = (name: string, f: (tool: ToolRegistration) => ToolRegistration): Wrap => ({ tool: name, wrap: f });

/** The wraps; install after the tools they wrap. */
export const permissions = (host: PermissionsHost): Extension =>
  defineExtension({
    name: "permissions",
    wraps: [
      ...PATH_TOOLS.map((name) => wrap(name, (tool) => translated(host, tool, "path"))),
      wrap("bash", (tool) => translated(host, tool, "command")),
      ...["bash", "edit", "write"].map((name) => wrap(name, (tool) => guarded(host, tool))),
    ],
  });
