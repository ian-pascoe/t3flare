// @effect-diagnostics globalDate:off globalDateInEffect:off
// The pushes arrive as plain Promise RPC from the DO host, so their timing uses the platform clock.
// The Durable agent provider's ProviderAdapterV2 (step 2a plan, sections 2–3). A provider session is t3's handle on one
// thread's Session DO (agents Worker): commands go to the Session over DO RPC; its pushes come back through the session
// sink and the differ turns them into t3's events. The Session is the durable party: a provider session holds nothing
// a restart would lose but its cursor, and re-reads the Session's state (`snapshot`) whenever it opens or sees a gap.
import {
  type ModelSelection,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  interactionModeOf,
  type LinkedWork,
  type ModelRef,
  runtimeModeOf,
  type SessionPush,
  type SessionPushAnswer,
  type SessionState,
  SILENT_TURN_MS,
  type T3McpCredential,
  sessionNameOf,
  type ThinkingLevel,
} from "@t3flare/session-protocol";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { toWorkspace } from "@t3flare/workspace-client";

import { environmentServices } from "../agents/bindings.ts";
import { byName, type SessionRpc } from "../agents/rpc.ts";
import { registerSession } from "../agents/sessionSink.ts";
import { PI_DURABLE_DRIVER, PiDurableCapabilities } from "./capabilities.ts";
import { approvalIdOf, diff, makeDifferState, type DifferState, type TurnContext } from "./differ.ts";

const driver = PI_DURABLE_DRIVER;
const derive = IdAllocator.derive;

const ref = (nativeId: string, strength: "strong" | "weak" = "strong"): OrchestrationV2ProviderRef => ({
  driver,
  nativeId,
  strength,
});

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** pi-ai's model and thinking level for a t3 model selection (`anthropic/claude-…` slugs, ADR-0012). */
export const modelOf = (selection: ModelSelection): { readonly model: ModelRef; readonly thinking: ThinkingLevel | null } => {
  const slug = selection.model === "default" ? "anthropic/claude-sonnet-5-5" : selection.model;
  const slash = slug.indexOf("/");
  const model = slash < 0 ? { provider: "anthropic", modelId: slug } : { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
  const thinking = getModelSelectionStringOptionValue(selection, "thinking");
  return { model, thinking: thinking !== undefined && THINKING.has(thinking) ? (thinking as ThinkingLevel) : null };
};

/** The Workspace id of a cwd under `/w/<id>` (ADR-0008), or null. */
export const workspaceOfCwd = (cwd: string | null | undefined): string | null => (cwd ? (toWorkspace(cwd)?.id ?? null) : null);

const protocolError = (detail: string, cause?: unknown) =>
  new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail, ...(cause === undefined ? {} : { cause }) });

/**
 * The thread's link origin (t3's `linkOrigin`, step 3), read from t3's projection: null for the owner's own work. The
 * Session asks a fresh approval for every push such a thread makes (owner decision D1).
 */
export const linkedWorkOf = (threadId: string): LinkedWork | null => {
  const row = environmentServices()
    .sql.exec<{ origin: string | null }>(
      "SELECT json_extract(payload_json, '$.linkOrigin') AS origin FROM orchestration_v2_projection_threads WHERE thread_id = ?",
      threadId,
    )
    .toArray()[0];
  if (row?.origin == null) return null;
  try {
    const origin = JSON.parse(row.origin) as { label?: unknown; access?: unknown };
    return { label: typeof origin.label === "string" ? origin.label : "a linked environment", access: typeof origin.access === "string" ? origin.access : null };
  } catch {
    return { label: "a linked environment", access: null };
  }
};

const call = <A>(what: string, thunk: () => Promise<A>) =>
  Effect.tryPromise({ try: thunk, catch: (cause) => protocolError(`The agent's session did not answer ${what}`, cause) });

export const makePiDurableAdapter = (instanceId: ProviderInstanceId, mcpSessions: McpProviderSessions.McpProviderSessions["Service"]) =>
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: Effect.fn("PiDurableAdapter.getCapabilities")(function () {
      return Effect.succeed(PiDurableCapabilities);
    }),
    planSelectionTransition: Effect.fn("PiDurableAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("PiDurableAdapter.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const sessionName = sessionNameOf(input.threadId);
      const client = (): SessionRpc => byName(environmentServices().agents.SESSIONS, sessionName, "SESSIONS");
      /** t3's MCP credential for this thread now (step 3): t3 issues it before the session opens and on attach. */
      const t3Mcp = Effect.map(mcpSessions.read(input.threadId), (config): T3McpCredential | undefined =>
        config === undefined
          ? undefined
          : { authorization: config.authorizationHeader, providerSessionId: config.providerSessionId, instructions: T3_CODE_ORCHESTRATION_INSTRUCTIONS },
      );
      const workspaceId = workspaceOfCwd(input.runtimePolicy.cwd);
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? "/w",
        model: input.modelSelection.model,
        capabilities: PiDurableCapabilities,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, ProviderAdapter.ProviderAdapterV2Error | Cause.Done>();
      const offer = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offerUnsafe(events, event);
      const differ: DifferState = makeDifferState(sessionName);
      let thread: OrchestrationV2ProviderThread | null = null;
      /** The cursor (step 2a plan, section 2): in memory; any doubt pulls a snapshot. */
      let cursor: { epoch: string; seq: number } | null = null;
      const lastPushAt = new Map<string, number>();
      let closed = false;
      // Pushes and snapshots are applied one at a time, in order.
      const applying = yield* Semaphore.make(1);
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

      const emitThread = (patch: Partial<OrchestrationV2ProviderThread>, at: DateTime.Utc) => {
        if (thread === null) return;
        thread = { ...thread, ...patch, updatedAt: at };
        offer({ type: "provider_thread.updated", driver, providerThread: thread });
      };
      const emitSession = (status: OrchestrationV2ProviderSession["status"], at: DateTime.Utc, model?: string) => {
        session = { ...session, status, ...(model === undefined ? {} : { model }), updatedAt: at };
        offer({ type: "provider_session.updated", driver, providerSession: session });
      };

      /** Applies the Session's state: the differ's events, then the bookkeeping of turns that settled. */
      const apply = Effect.fn("PiDurableAdapter.apply")(function* (state: SessionState) {
          const at = yield* DateTime.now;
          const before = new Set(differ.terminated);
          for (const event of diff(differ, state, at, pathOut, textOut)) offer(event);
          let settled = false;
          for (const id of differ.terminated) {
            if (before.has(id)) continue;
            differ.turns.delete(id);
            lastPushAt.delete(id);
            settled = true;
          }
          if (settled && differ.turns.size === 0) {
            emitThread({ status: "idle" }, at);
            emitSession("ready", at);
          }
      });

      const pathOut = (path: string) =>
        workspaceId === null ? path : path.replace(/^\/workspace\/repo(?=\/|$)/, `/w/${workspaceId}`);
      /** Every `/workspace/repo` in a text shown to the owner (an approval's command) as t3's `/w/<id>`. */
      const textOut = (text: string) =>
        workspaceId === null ? text : text.replace(/\/workspace\/repo(?=\/|\b|$)/g, `/w/${workspaceId}`);

      const pullSnapshot = (why: string) =>
        call("a snapshot", () => client().snapshot({})).pipe(
          Effect.tap((state) => Effect.logDebug("pi-durable snapshot", { why, entries: state.entries.length })),
          Effect.tap((state) =>
            Effect.sync(() => {
              cursor = { epoch: state.epoch, seq: (state as Partial<SessionPush>).seq ?? cursor?.seq ?? 0 };
            }),
          ),
          Effect.flatMap(apply),
        );

      const onPush = (push: SessionPush): Promise<SessionPushAnswer> =>
        runPromise(
          applying.withPermits(1)(
            Effect.gen(function* () {
              if (closed) return { ok: true } as SessionPushAnswer;
              const nowMs = Date.now();
              // Only a push that still names a turn counts as a sign of it (the inverse guard).
              for (const id of differ.turns.keys()) if (push.turns[id] !== undefined) lastPushAt.set(id, nowMs);
              // Live turns of the Session that this provider session did not start: orphans (step 2a plan, section 2).
              const orphans = Object.entries(push.turns)
                .filter(([id, turn]) => (turn.status === "queued" || turn.status === "running") && !differ.turns.has(id))
                .map(([id]) => id);
              const gap = cursor === null || cursor.epoch !== push.epoch || push.prevSeq !== cursor.seq || push.more;
              if (gap) {
                cursor = { epoch: push.epoch, seq: push.seq };
                yield* pullSnapshot(cursor === null ? "first push" : "gap").pipe(Effect.catch(() => apply(push)));
              } else {
                cursor = { epoch: push.epoch, seq: push.seq };
                yield* apply(push);
              }
              return { ok: true, ...(orphans.length === 0 ? {} : { orphans }) } satisfies SessionPushAnswer;
            }),
          ),
        );
      const unregister = registerSession(sessionName, onPush);

      // The inverse guard: an open turn with no push for SILENT_TURN_MS pulls a snapshot; a turn the Session no longer
      // has is ended as lost, so a lost Session cannot keep a t3 run (and the Environment) open forever.
      yield* Effect.gen(function* () {
        const nowMs = Date.now();
        const silent = [...differ.turns.keys()].filter((id) => nowMs - (lastPushAt.get(id) ?? nowMs) >= SILENT_TURN_MS);
        if (silent.length === 0) return;
        yield* applying.withPermits(1)(
          call("a snapshot", () => client().snapshot({})).pipe(
            Effect.flatMap((state) => {
              const turns = { ...state.turns };
              for (const id of silent) {
                if (turns[id] === undefined) {
                  const context = differ.turns.get(id);
                  turns[id] = {
                    submissionId: "",
                    runId: context?.runId ?? "",
                    attemptId: "",
                    status: "failed",
                    reason: "lost",
                    startedAt: 0,
                  };
                }
                lastPushAt.set(id, Date.now());
              }
              return apply({ ...state, turns });
            }),
            Effect.catch((error) => Effect.logWarning("The agent's session did not answer the silent-turn check", error)),
          ),
        );
      }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkIn(scope));

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          unregister();
        }).pipe(Effect.andThen(Queue.end(events)), Effect.ignore),
      );

      const register = Effect.fn("PiDurableAdapter.register")(function* (registerInput: {
        readonly threadId: NonNullable<OrchestrationV2ProviderThread["appThreadId"]>;
        readonly existing?: OrchestrationV2ProviderThread | undefined;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: string;
        readonly interactionMode: string;
        readonly resume: boolean;
      }) {
        const at = yield* DateTime.now;
        const { model, thinking } = modelOf(registerInput.modelSelection);
        const credential = yield* t3Mcp;
        const linked = linkedWorkOf(registerInput.threadId);
        const opened = yield* call("open", () =>
          client().open({
            threadId: registerInput.threadId,
            workspaceId,
            runtimeMode: runtimeModeOf(registerInput.runtimeMode),
            interactionMode: interactionModeOf(registerInput.interactionMode),
            model,
            thinking,
            ...(credential === undefined ? {} : { t3Mcp: credential }),
            linked,
          }),
        );
        // ADR-0004: an Environment restart ends running turns. A Session still busy when a provider session reopens it
        // has a turn t3 already ended; abort it so both sides agree (the push's orphans usually did it already).
        if (opened.busy && differ.turns.size === 0) {
          yield* call("abort", () => client().abort({ all: true, reason: "environment-restart" }));
        }
        thread =
          registerInput.existing !== undefined
            ? { ...registerInput.existing, providerSessionId: session.id, nativeThreadRef: ref(sessionName), status: "idle", updatedAt: at }
            : {
                id: derive.providerThread({ driver, nativeThreadId: sessionName }),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: session.id,
                appThreadId: registerInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: ref(sessionName),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt: at,
                updatedAt: at,
              };
        cursor = null;
        offer({ type: "provider_thread.updated", driver, providerThread: thread });
        return thread;
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return session;
        },
        canResumeAfterRestart: true,
        events: Stream.fromQueue(events),
        getModelContextWindow: (selection) =>
          selection.instanceId !== instanceId ? undefined : environmentServices().catalog.find(modelOf(selection).model.provider + "/" + modelOf(selection).model.modelId)?.contextWindow,
        ensureThread: (threadInput) =>
          register({
            threadId: threadInput.threadId,
            existing: threadInput.existingProviderThread,
            modelSelection: threadInput.modelSelection,
            runtimeMode: threadInput.runtimePolicy.runtimeMode,
            interactionMode: threadInput.runtimePolicy.interactionMode,
            resume: false,
          }).pipe(
            Effect.mapError((cause) => new ProviderAdapter.ProviderAdapterEnsureThreadError({ driver, threadId: threadInput.threadId, cause })),
          ),
        resumeThread: (threadInput) =>
          register({
            threadId: threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            existing: threadInput.providerThread,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimeMode: (threadInput.runtimePolicy ?? input.runtimePolicy).runtimeMode,
            interactionMode: (threadInput.runtimePolicy ?? input.runtimePolicy).interactionMode,
            resume: true,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: Effect.fn("PiDurableAdapter.startTurn")(
          function* (turnInput) {
            const startedAt = yield* DateTime.now;
            const nativeTurnId = `${turnInput.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: derive.providerTurn({ driver, nativeTurnId }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: ref(nativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const { model, thinking } = modelOf(turnInput.modelSelection);
            const context: TurnContext = {
              providerTurnId: providerTurn.id,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              rootNodeId: turnInput.rootNodeId,
              providerThreadId: turnInput.providerThread.id,
              runOrdinal: turnInput.runOrdinal,
              providerTurnOrdinal: turnInput.providerTurnOrdinal,
              startedAt,
              providerTurn,
              contextWindow: environmentServices().catalog.find(`${model.provider}/${model.modelId}`)?.contextWindow ?? null,
              providerSessionId: input.providerSessionId,
            };
            // Registered before the submit, so a push that arrives first is not taken for an orphan (plan revision 3).
            differ.turns.set(providerTurn.id, context);
            lastPushAt.set(providerTurn.id, Date.now());
            if (thread === null || thread.id !== turnInput.providerThread.id) thread = turnInput.providerThread;
            offer({ type: "provider_turn.updated", driver, threadId: turnInput.threadId, providerTurn });
            emitThread(
              { status: "active", firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal, lastRunOrdinal: turnInput.runOrdinal },
              startedAt,
            );
            emitSession("running", startedAt, turnInput.modelSelection.model);
            const credential = yield* t3Mcp;
            const linked = linkedWorkOf(turnInput.threadId);
            yield* call("submitTurn", () =>
              client().submitTurn({
                providerTurnId: providerTurn.id,
                runId: turnInput.runId,
                attemptId: turnInput.attemptId,
                text: turnInput.message.text,
                images: [],
                model,
                thinking,
                runtimeMode: runtimeModeOf(turnInput.runtimePolicy.runtimeMode),
                interactionMode: interactionModeOf(turnInput.runtimePolicy.interactionMode),
                ...(credential === undefined ? {} : { t3Mcp: credential }),
                linked,
              }),
            ).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  differ.turns.delete(providerTurn.id);
                  lastPushAt.delete(providerTurn.id);
                }),
              ),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: Effect.fn("PiDurableAdapter.steerTurn")(function* (steerInput) {
          yield* call("steer", () =>
            client().steer({
              providerTurnId: steerInput.providerTurnId,
              key: `${steerInput.providerTurnId}:${steerInput.message.messageId}`,
              text: steerInput.message.text,
              images: [],
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId: steerInput.providerThread.id,
                  providerTurnId: steerInput.providerTurnId,
                  cause,
                }),
            ),
          );
        }),
        interruptTurn: Effect.fn("PiDurableAdapter.interruptTurn")(function* (interruptInput) {
          const context = differ.turns.get(interruptInput.providerTurnId);
          if (context !== undefined) context.interruptRequested = true;
          yield* call("abort", () => client().abort({ providerTurnId: interruptInput.providerTurnId, reason: "interrupt" })).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          );
        }),
        respondToRuntimeRequest: Effect.fn("PiDurableAdapter.respondToRuntimeRequest")(function* (requestInput) {
          const decision = requestInput.decision ?? "cancel";
          const approvalId = approvalIdOf(sessionName, requestInput.requestId);
          if (approvalId === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver, requestId: requestInput.requestId });
          }
          const answerDecision = decision === "accept" || decision === "acceptForSession" || decision === "decline" ? decision : "cancel";
          // Kept before the call, so the push that drops the request closes it as resolved, not cancelled.
          // A question's answer (step 3, `ask_user`) comes as `answers` by question id, which is the Session's request id.
          const answers = requestInput.answers;
          differ.decisions.set(requestInput.requestId, {
            decision: answerDecision,
            ...(requestInput.feedback === undefined ? {} : { feedback: requestInput.feedback }),
            ...(answers === undefined ? {} : { answers }),
          });
          const answered = yield* call("answer", () =>
            client().answer({
              requestId: approvalId,
              decision: answerDecision,
              ...(requestInput.feedback === undefined ? {} : { feedback: requestInput.feedback }),
              ...(answers === undefined ? {} : { answers }),
            }),
          ).pipe(
            Effect.mapError(
              (cause) => new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver, requestId: requestInput.requestId, cause }),
            ),
          );
          if (!answered.applied) {
            differ.decisions.delete(requestInput.requestId);
            return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver, requestId: requestInput.requestId });
          }
        }),
        readThreadSnapshot: Effect.fn("PiDurableAdapter.readThreadSnapshot")(function (snapshotInput) {
          return Effect.succeed({ providerThread: snapshotInput.providerThread, providerTurns: [], messages: [], runtimeRequests: [] });
        }),
        rollbackThread: () => Effect.fail(protocolError("rollback is not supported")),
        forkThread: () => Effect.fail(protocolError("fork is not supported")),
      };
      return runtime;
    }),
  });
