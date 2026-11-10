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
import { defineExtension, type Extension, type ToolExecutionApi, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import type { ApprovalDecision, PendingApproval, RuntimeMode } from "@t3flare/session-protocol";

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

/** The Session's approval requests, over its storage. `changed` runs whenever the pending requests change. */
export class ApprovalStore {
  readonly #storage: ApprovalStorage;
  readonly #changed: () => void;
  /** Calls waiting for an answer in this instance, by request. */
  readonly #waiters = new Map<string, () => void>();

  constructor(storage: ApprovalStorage, changed: () => void) {
    this.#storage = storage;
    this.#changed = changed;
  }

  pending(): ReadonlyArray<PendingApproval> {
    return this.#storage.get<PendingApproval[]>(REQUESTS_KEY) ?? [];
  }

  #answers(): Readonly<Record<string, StoredAnswer>> {
    return this.#storage.get<Record<string, StoredAnswer>>(ANSWERS_KEY) ?? {};
  }

  #putRequests(next: ReadonlyArray<PendingApproval>): void {
    this.#storage.put(REQUESTS_KEY, next);
    this.#changed();
  }

  /** Kinds the owner accepted for the rest of the Session (`acceptForSession`). */
  acceptedKinds(): ReadonlySet<ApprovalKind> {
    return new Set(this.#storage.get<ApprovalKind[]>(ACCEPTED_KEY) ?? []);
  }

  /**
   * Ask for `request`, and wait for the answer. A rerun with the same id waits for the request already made, or takes
   * the answer given while no call waited. `waiting` runs once the request is stored, just before the wait.
   */
  async ask(request: PendingApproval, waiting: () => Promise<void>, context: Context): Promise<StoredAnswer> {
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
    if (answer === undefined) throw new Error(`Approval request ${request.requestId} was lost`);
    return answer;
  }

  /** The call that asked `requestId` is done: withdraw its request if it still waits, and forget its answer. */
  settle(requestId: string): void {
    this.#waiters.delete(requestId);
    const answers = this.#answers();
    if (answers[requestId] !== undefined) {
      this.#storage.put(ANSWERS_KEY, Object.fromEntries(Object.entries(answers).filter(([key]) => key !== requestId)));
    }
    const remaining = this.pending().filter((pending) => pending.requestId !== requestId);
    if (remaining.length !== this.pending().length) this.#putRequests(remaining);
  }

  /** The owner's answer to `requestId`; false when no such request waits (answered already, or its call ended). */
  answer(requestId: string, decision: ApprovalDecision, feedback?: string): boolean {
    const request = this.pending().find((pending) => pending.requestId === requestId);
    if (request === undefined) return false;
    const trimmed = feedback?.trim();
    this.#storage.put(ANSWERS_KEY, {
      ...this.#answers(),
      [requestId]: { decision, ...(trimmed === undefined || trimmed === "" ? {} : { feedback: trimmed }) },
    });
    if (decision === "acceptForSession") this.#storage.put(ACCEPTED_KEY, [...new Set([...this.acceptedKinds(), request.kind])]);
    this.#putRequests(this.pending().filter((pending) => pending.requestId !== requestId));
    this.#waiters.get(requestId)?.();
    return true;
  }

  /** Withdraws the requests of turns that are no longer live, and the answers no call took (only while idle). */
  dropAbandoned(liveTurns: ReadonlySet<string>): void {
    const kept = this.pending().filter((pending) => pending.turn !== null && liveTurns.has(pending.turn));
    if (kept.length !== this.pending().length) this.#putRequests(kept);
    if (liveTurns.size === 0 && Object.keys(this.#answers()).length > 0) this.#storage.put(ANSWERS_KEY, {});
  }
}

/** What the permissions read of the Session at each call. */
export interface PermissionsHost {
  readonly store: ApprovalStore;
  /** The Session's runtime mode now (each turn's `submitTurn` sets it). */
  readonly mode: () => RuntimeMode;
  /** The turn the Session runs now. */
  readonly turn: () => string | null;
  /** The Session's Workspace id, for path translation; null without one. */
  readonly workspaceId: () => string | null;
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

const STARTED_MEMO = "t3flare.started";

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

/** `tool`, asking before it runs when the mode says so. */
const guarded = <T extends ToolRegistration>(host: PermissionsHost, tool: T): T => {
  const unsafe = tool.replay !== "safe";
  return {
    ...tool,
    replay: "safe",
    async execute(args: Record<string, unknown>, api: ToolExecutionApi, context: Context) {
      if (unsafe && (await api.memo<boolean>(STARTED_MEMO, context)) === true) {
        return {
          output: [
            {
              type: "text" as const,
              text: "This call was cut off by a restart after it started, so it may have partly run. Check the state before running it again.",
            },
          ],
          isError: true,
        };
      }
      const kind = kindOf(tool.name);
      const requestId = String(api.taskId);
      if (asks(host.mode(), kind) && !host.store.acceptedKinds().has(kind)) {
        try {
          const answer = await host.store.ask(
            { requestId, turn: host.turn(), callId: api.callId, tool: tool.name, kind, ...summaryOf(tool.name, args), createdAt: Date.now() },
            () => api.progressed(context).catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "progressed-failed", error: String(error) }))),
            context,
          );
          if (answer.decision === "decline" || answer.decision === "cancel") return declinedResult(answer);
        } finally {
          host.store.settle(requestId);
        }
      }
      if (unsafe) await api.memo(STARTED_MEMO, true, context);
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
