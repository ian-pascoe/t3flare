// The Session ↔ Environment contract (ADR-0005; step 2a plan, section 2). Plain types and constants only: both Workers
// import them, and neither imports the other's code. The Session DO (agents Worker) pushes its committed state to the
// Environment DO; the Environment DO's provider adapter calls the Session's commands and diffs what it pushes into t3's
// provider events. Structural copies of the pi-durable shapes the adapter reads, so the environment Worker needs no
// pi-durable.

/** The Session DO's name for t3 thread `threadId`: one Session per thread. Also the provider thread's native id. */
export const sessionNameOf = (threadId: string): string => `thread:${threadId}`;

/** The Environment DO's name (ADR-0002: one per deploy). */
export const ENVIRONMENT_NAME = "environment";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The t3 runtime modes the Session enforces (step 2a plan, section 3). */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

/**
 * The mode the Session enforces for t3's runtime mode. It fails closed: an unknown or missing mode asks for approval.
 * t3's `auto` runs as approval-required, as t3's own Pi provider runs it
 * (t3code/packages/provider-pi/src/server/mcpInjection.ts); we have no automatic reviewer to approve for the owner.
 */
export const runtimeModeOf = (mode: string | null | undefined): RuntimeMode =>
  mode === "auto-accept-edits" || mode === "full-access" ? mode : "approval-required";

/** t3's interaction mode as the Session enforces it (step 3, F-plan): `plan` is read-only work. */
export type InteractionMode = "default" | "plan";

/**
 * The interaction mode the Session enforces. It fails closed: any mode t3 sends other than `default` (`plan`, or one
 * added later) runs as plan. A missing one (a Session stored before step 3) is the default.
 */
export const interactionModeOf = (mode: string | null | undefined): InteractionMode =>
  mode === undefined || mode === null || mode === "default" ? "default" : "plan";

/**
 * t3's MCP credential for the thread's provider session (step 3, plan section 4.1; ADR-0022): issued by t3, read by the
 * adapter, and kept by the Session in its DO storage only. Never in a Container, a push, a snapshot or a log.
 */
export interface T3McpCredential {
  /** `Bearer <token>`, as t3 issues it (`McpProviderSessionConfig.authorizationHeader`). */
  readonly authorization: string;
  /** t3's provider-session id the credential is scoped to; t3 namespaces `clientRequestId` by it. */
  readonly providerSessionId: string;
  /** t3's orchestration instructions (`T3_CODE_ORCHESTRATION_INSTRUCTIONS`), shown while the tools are installed. */
  readonly instructions: string;
}

/**
 * The link a thread's work came from (t3's `linkOrigin`), when it came over a Peer link (step 3). The Session asks
 * a fresh approval for every `git push` such a thread makes (owner decision D1, option 2).
 */
export interface LinkedWork {
  readonly label: string;
  readonly access: string | null;
}

/** One `/mcp` request from a Session to the Environment DO (`EnvironmentDO.mcp`, plan section 4.2). */
export interface McpRpcRequest {
  readonly authorization: string;
  readonly body: string;
  readonly sessionId?: string;
  readonly protocolVersion?: string;
}

export interface McpRpcAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly sessionId?: string;
  readonly body: string;
}

/** A model as the Session runs it: pi-ai's provider and model id. */
export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface ImageInput {
  readonly data: string;
  readonly mimeType: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands: Environment → Session (RPC methods on SessionDO)

export interface OpenInput {
  readonly threadId: string;
  readonly workspaceId: string | null;
  readonly runtimeMode: RuntimeMode;
  /** Step 3: absent from an adapter before it (the default). */
  readonly interactionMode?: InteractionMode;
  readonly model: ModelRef;
  readonly thinking: ThinkingLevel | null;
  /** Step 3: t3's MCP credential for this provider session; absent when t3 issued none. */
  readonly t3Mcp?: T3McpCredential;
  /** Step 3: the thread's link origin, null for the owner's own work. */
  readonly linked?: LinkedWork | null;
}

export interface OpenAnswer {
  readonly epoch: string;
  readonly busy: boolean;
  readonly turns: Readonly<Record<string, TurnState>>;
}

export interface SubmitTurnInput {
  /** The key: a repeated call with the same providerTurnId submits nothing new. */
  readonly providerTurnId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly text: string;
  readonly images: ReadonlyArray<ImageInput>;
  readonly model: ModelRef;
  readonly thinking: ThinkingLevel | null;
  readonly runtimeMode: RuntimeMode;
  /** Step 3: absent from an adapter before it (the default). */
  readonly interactionMode?: InteractionMode;
  /** Step 3: as `OpenInput.t3Mcp`, read again at every turn. */
  readonly t3Mcp?: T3McpCredential;
  readonly linked?: LinkedWork | null;
}

export interface SteerInput {
  readonly providerTurnId: string;
  readonly key: string;
  readonly text: string;
  readonly images: ReadonlyArray<ImageInput>;
}

export interface AbortInput {
  readonly providerTurnId?: string;
  readonly all?: boolean;
  readonly reason: string;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface AnswerInput {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly feedback?: string;
  /** Step 3: a question's answer (`ask_user`), as t3 hands it to a provider: by question id. */
  readonly answers?: Readonly<Record<string, unknown>>;
}

export interface SnapshotInput {
  /** Entries after this one; all of the root conversation's when absent. */
  readonly fromEntry?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// State: Session → Environment (`sessionPush`) and the snapshot's answer

/** pi-ai's content blocks as committed entries and the live partial carry them (only what the differ reads). */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string; readonly redacted?: boolean }
  | { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly type: "image"; readonly mimeType?: string }
  | { readonly type: string; readonly [key: string]: unknown };

export interface UsageSlim {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
}

/** One committed transcript entry, slimmed: its messages' content bounded, tool results cut to TOOL_OUTPUT_BYTES. */
export interface PushedEntry {
  readonly id: string;
  readonly kind: string;
  readonly byTaskId: string | null;
  /** The turn (providerTurnId) the Session was running when the entry was committed; null outside a turn. */
  readonly turn: string | null;
  readonly role: "user" | "assistant" | "toolResult" | "system" | "other";
  readonly content: ReadonlyArray<ContentBlock>;
  /** Assistant entries: why the response ended, and its error message (never shown raw). */
  readonly stopReason?: string;
  readonly errorMessage?: string;
  /** Tool results: the call they answer. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly details?: unknown;
  readonly usage?: UsageSlim;
  readonly timestamp?: number;
}

export interface ToolSlotSlim {
  readonly callId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "done";
}

export interface LiveSlim {
  /** The run in progress, if any: its generation task, and the turn it serves. */
  readonly run: { readonly taskId: string; readonly turn: string | null } | null;
  /** The in-flight response's committed partial: its generation task and its blocks. */
  readonly generation: { readonly taskId: string; readonly attempt: number; readonly content: ReadonlyArray<ContentBlock> } | null;
  readonly tools: ReadonlyArray<ToolSlotSlim>;
  readonly runFailure: { readonly reason: string; readonly detail?: string; readonly taskId: string } | null;
}

export type TurnStatus = "queued" | "running" | "answered" | "failed" | "aborted";

export interface TurnState {
  readonly submissionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly status: TurnStatus;
  /** When the turn settled without an answer: pi-durable's reason (RunFailureReason, or ours: `turn_deadline`). */
  readonly reason?: string;
  /** Bounded detail for `failed` (a model error's text is classified, never shown raw). */
  readonly detail?: string;
  /** The entry the turn's input was placed as. */
  readonly inputEntry?: string;
  readonly startedAt: number;
  readonly settledAt?: number;
  /**
   * Steers sent into the turn (their submissions). A steer that reaches the run as it gives its final answer starts the
   * next pi-durable run; it is still this turn's work, so the turn settles only when they have.
   */
  readonly steers?: ReadonlyArray<string>;
  /** What the model proxy answered this turn (step 2a part 2); absent in pushes from before it. */
  readonly proxy?: ProxyRecord;
}

/** A turn's model proxy requests, and its last failure as the Session classified it when the answer came. */
export interface ProxyRecord {
  /** The Session's requests to the proxy while this turn ran (the fault route's answers included). */
  readonly requests: number;
  readonly failure?: ProxyFailureRecord;
}

/** `@t3flare/models/proxyFailure`'s `ProxyFailure`, with the time of the answer (epoch ms). */
export interface ProxyFailureRecord {
  readonly class: "usage_limit" | "permission_error" | "provider_error";
  readonly code: string;
  readonly row: number;
  readonly resetAt?: number;
  readonly stop: boolean;
  readonly at: number;
}

export interface PendingApproval {
  readonly requestId: string;
  readonly turn: string | null;
  readonly callId: string;
  readonly tool: string;
  /**
   * `mcp-tool` (step 3, review C4): a t3 MCP tool, accepted for the session per tool name. `git-push` (step 3, D1): a
   * push from linked work, never accepted for the session.
   */
  readonly kind: "command" | "file-change" | "mcp-tool" | "git-push";
  readonly summary: string;
  readonly detail?: string;
  /** The card's own buttons (t3's `ProviderApprovalOption`s), instead of t3's defaults (SPI-992's push card). */
  readonly options?: ReadonlyArray<{ readonly decision: "accept" | "acceptForSession" | "decline" | "cancel"; readonly label: string; readonly warning?: string }>;
  /** A call a code mode script made (tools step, ADR-0027): the script's call and the start of its code. */
  readonly via?: { readonly parentCallId: string; readonly script: string };
  readonly createdAt: number;
}

/**
 * A question the agent asked the owner (`ask_user`, step 3): one question, optional choices, a free answer unless only
 * the choices are allowed. It waits durably as an approval does.
 */
export interface PendingQuestion {
  readonly requestId: string;
  readonly turn: string | null;
  readonly callId: string;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly allowFreeText: boolean;
  readonly createdAt: number;
}

export interface SessionState {
  readonly sessionId: string;
  readonly epoch: string;
  readonly entries: ReadonlyArray<PushedEntry>;
  /** Entries were cut at the bound: pull a snapshot from the last one pushed. */
  readonly more: boolean;
  readonly live: LiveSlim;
  readonly agent: { readonly model: ModelRef | null; readonly thinking: string | null };
  readonly usage: UsageSlim | null;
  readonly inbox: { readonly pending: number };
  readonly approvals: ReadonlyArray<PendingApproval>;
  /** Step 3: absent in a push from a Session before it. */
  readonly questions?: ReadonlyArray<PendingQuestion>;
  readonly turns: Readonly<Record<string, TurnState>>;
}

export interface SessionPush extends SessionState {
  readonly seq: number;
  readonly prevSeq: number;
  /** A push with nothing new, sent every LIVENESS_PUSH_MS while a turn is live. */
  readonly liveness: boolean;
}

export interface SessionPushAnswer {
  readonly ok: true;
  readonly wantSnapshot?: true;
  /** Live turns t3 does not have open: the Session aborts them and withdraws their approvals. */
  readonly orphans?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bounds and timings

/** How long the Session coalesces commits before a push while streaming. */
export const PUSH_COALESCE_MS = 300;
/** The most a push's entries may hold (JSON); past it, `more` and the adapter pulls a snapshot. */
export const PUSH_ENTRIES_BYTES = 256 * 1024;
/** A tool result's text, as pushed. */
export const TOOL_OUTPUT_BYTES = 16 * 1024;
/** While a turn is live the Session pushes at least this often. */
export const LIVENESS_PUSH_MS = 60_000;
/** An open turn with no push for this long makes the adapter pull a snapshot (the inverse guard). */
export const SILENT_TURN_MS = 2 * 60_000;
/** A turn may run at most this long (step 2a cost guardrails). */
export const TURN_DEADLINE_MS = 2 * 60 * 60_000;
