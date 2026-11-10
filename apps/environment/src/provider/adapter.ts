// The Durable agent provider's ProviderAdapterV2 (step 2a plan, sections 2–3). M0 step 0: a stub whose turns answer a
// fixed text, to check how the stock client treats the `piDurable` driver kind (risk R1). The Session-backed adapter
// replaces the turn engine in M1; the event shapes follow t3's Pi adapter.
import type {
  ModelSelection,
  OrchestrationV2ProviderRef,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Cause from "effect/Cause";
import type { ProviderInstanceId } from "@t3tools/contracts";

import { PI_DURABLE_DRIVER, PiDurableCapabilities } from "./capabilities.ts";

const driver = PI_DURABLE_DRIVER;
const derive = IdAllocator.derive;

const ref = (nativeId: string, strength: "strong" | "weak" = "strong"): OrchestrationV2ProviderRef => ({
  driver,
  nativeId,
  strength,
});

/** The Session a t3 thread's Durable agent lives in (ADR-0005): one per thread. */
export const sessionNameOf = (threadId: string) => `thread:${threadId}`;

export const makePiDurableAdapter = (instanceId: ProviderInstanceId) =>
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
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(events, event).pipe(Effect.asVoid);
      let thread: OrchestrationV2ProviderThread | null = null;

      const register = Effect.fn("PiDurableAdapter.register")(function* (input: {
        readonly threadId: NonNullable<OrchestrationV2ProviderThread["appThreadId"]>;
        readonly existing?: OrchestrationV2ProviderThread | undefined;
      }) {
        const at = yield* DateTime.now;
        const nativeId = sessionNameOf(input.threadId);
        thread =
          input.existing !== undefined
            ? { ...input.existing, providerSessionId: session.id, nativeThreadRef: ref(nativeId), status: "idle", updatedAt: at }
            : {
                id: derive.providerThread({ driver, nativeThreadId: nativeId }),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: session.id,
                appThreadId: input.threadId,
                ownerNodeId: null,
                nativeThreadRef: ref(nativeId),
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
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
        return thread;
      });

      const updateThread = Effect.fnUntraced(function* (patch: Partial<OrchestrationV2ProviderThread>) {
        if (thread === null) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
      });

      const updateSession = Effect.fnUntraced(function* (status: OrchestrationV2ProviderSession["status"], model?: ModelSelection) {
        session = { ...session, status, ...(model ? { model: model.model } : {}), updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver, providerSession: session });
      });

      const unsupported = (detail: string) => new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return session;
        },
        canResumeAfterRestart: true,
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          register({ threadId: threadInput.threadId, existing: threadInput.existingProviderThread }).pipe(
            Effect.mapError((cause) => new ProviderAdapter.ProviderAdapterEnsureThreadError({ driver, threadId: threadInput.threadId, cause })),
          ),
        resumeThread: (threadInput) =>
          register({ threadId: threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId, existing: threadInput.providerThread }),
        startTurn: Effect.fn("PiDurableAdapter.startTurn")(function* (turnInput) {
          const startedAt = yield* DateTime.now;
          const nativeTurnId = `${turnInput.providerThread.id}:attempt:${turnInput.attemptId}`;
          let providerTurn: OrchestrationV2ProviderTurn = {
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
          yield* emit({ type: "provider_turn.updated", driver, threadId: turnInput.threadId, providerTurn });
          yield* updateThread({
            status: "active",
            firstRunOrdinal: thread?.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* updateSession("running", turnInput.modelSelection);
          const nativeItemId = `${providerTurn.id}:stub`;
          const text = `t3flare stub provider: received ${turnInput.message.text.length} characters.`;
          const at = yield* DateTime.now;
          const messageId = derive.messageFromProviderItem({ driver, nativeItemId });
          const nodeId = derive.nodeFromProviderItem({ driver, nativeItemId });
          yield* emit({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              parentNodeId: turnInput.rootNodeId,
              rootNodeId: turnInput.rootNodeId,
              kind: "assistant_message",
              status: "completed",
              countsForRun: false,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId: providerTurn.id,
              nativeItemRef: ref(nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: at,
              completedAt: at,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: derive.turnItemFromProviderItem({ driver, nativeItemId }),
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId: providerTurn.id,
              nativeItemRef: ref(nativeItemId),
              parentItemId: null,
              ordinal: turnInput.providerTurnOrdinal * 100 + 1,
              startedAt: at,
              updatedAt: at,
              status: "completed",
              title: null,
              completedAt: at,
              type: "assistant_message",
              messageId,
              text,
              streaming: false,
            },
          });
          yield* emit({
            type: "message.updated",
            driver,
            message: {
              id: messageId,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId,
              role: "assistant",
              text,
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: at,
              updatedAt: at,
            },
          });
          const completedAt = yield* DateTime.now;
          providerTurn = { ...providerTurn, status: "completed", completedAt };
          yield* emit({ type: "provider_turn.updated", driver, threadId: turnInput.threadId, providerTurn });
          yield* updateThread({ status: "idle" });
          yield* updateSession("ready");
          yield* emit({
            type: "turn.terminal",
            driver,
            providerThreadId: turnInput.providerThread.id,
            providerTurnId: providerTurn.id,
            runOrdinal: turnInput.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }),
        steerTurn: (steerInput) =>
          Effect.fail(new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({ driver, providerThreadId: steerInput.providerThread.id })),
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: (requestInput) =>
          Effect.fail(new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver, requestId: requestInput.requestId })),
        readThreadSnapshot: (snapshotInput) =>
          Effect.succeed({ providerThread: snapshotInput.providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
        rollbackThread: () => Effect.fail(unsupported("rollback is not supported")),
        forkThread: () => Effect.fail(unsupported("fork is not supported")),
      };
      yield* Effect.addFinalizer(() => Queue.end(events).pipe(Effect.ignore));
      return runtime;
    }),
  });
