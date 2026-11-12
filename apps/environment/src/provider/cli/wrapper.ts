// @effect-diagnostics globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off globalDate:off globalDateInEffect:off effectFnOpportunity:off cryptoRandomUUID:off
// The CLI adapters' wrapper (step 4a, plan §3 with review F1, F7, F10): t3's own Codex and Pi adapters, with what the
// Cloud Environment changes around them.
//
// - One process per provider session, so one Workspace per session (review F1): t3 reuses a live session for a second
//   thread when the adapter says `supportsMultipleProviderThreadsPerSession` (Orchestrator.ts `providerSessionIdFor`,
//   ProviderSessionManager `open`), which would run another project's thread in this Workspace's Container. The flag is
//   false both in `getCapabilities()` and on the session entity t3 keeps.
// - A fork into another Workspace is refused: the fork runs in the source's process, so in the source's Container.
// - t3's tools through the MCP relay (SPI-1039, `relayedMcp.ts`; OD-3 lifted); MCP apps and feedback uploads (to the
//   vendor) are gone.
// - The turn's state reaches the Workspace (`processTurn`): the Container's hold (review F7).
// - The 2 h turn cap (ADR-0015): a turn still running then ends its process, and with it the session.
// - Events can be filtered (pi's "t3-code MCP unavailable" notice, review F10).
// - A tool call the MCP relay asks about (ADR-0028) is raised as t3's approval card on the thread's live turn: the
//   wrapper injects the request's events and answers it itself (`respondToRuntimeRequest`), never the CLI.
import { toWorkspace } from "@t3flare/workspace-client";
import {
  type NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunId,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ChannelProcess } from "../../agents/processChannel.ts";
import { type CliAnswer, type CliAsk, registerCliAsker } from "./cliAsk.ts";

/** ADR-0015: a CLI turn longer than this ends its process. */
export const TURN_CAP_MS = 2 * 60 * 60_000;

/** What t3flare knows of one CLI provider session: its process (the client factory's) and the thread's policy. */
export interface CliSession {
  /** t3's thread that opened the session. */
  readonly thread: string;
  process: ChannelProcess | undefined;
  runtimeMode: string | undefined;
  interactionMode: string | undefined;
  /** The Workspace the session's process runs in. */
  readonly workspace: string | null;
  turnActive: boolean;
  capFiber: Fiber.Fiber<void> | undefined;
  /** The session's process's tool handle for the MCP relay (ADR-0028): 256 random bits, never logged. */
  readonly toolHandle: string;
}

/** A new tool handle (ADR-0028): 32 random bytes, hex. */
export const newToolHandle = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Sessions of one driver instance, by provider session id: shared by its client factory and its wrapper. */
export type CliSessions = Map<string, CliSession>;

/**
 * The session whose adapter is opening now, for the spawner (`agents/cliProcess.ts`): t3's adapters spawn inside
 * `openSession`, so the spawn learns its thread and records its process on the session.
 */
export const CliSpawn = Context.Reference<CliSession | undefined>("t3flare/CliSpawn", { defaultValue: () => undefined });

export const sessionFor = (sessions: CliSessions, providerSessionId: string, cwd: string | null, thread: string): CliSession => {
  let session = sessions.get(providerSessionId);
  if (session === undefined) {
    session = { thread, process: undefined, runtimeMode: undefined, interactionMode: undefined, workspace: cwd === null ? null : (toWorkspace(cwd)?.id ?? null), turnActive: false, capFiber: undefined, toolHandle: newToolHandle() };
    sessions.set(providerSessionId, session);
  }
  return session;
};

/** The capabilities t3 sees for a CLI agent here. */
export const cliCapabilities = (capabilities: OrchestrationV2ProviderCapabilities): OrchestrationV2ProviderCapabilities => ({
  ...capabilities,
  sessions: { ...capabilities.sessions, supportsMultipleProviderThreadsPerSession: false },
  // SPI-1039: t3's tools reach CLI agents through the relay (relayedMcp.ts), never with t3's bearer.
  tools: { ...capabilities.tools, supportsMcpTools: true },
});

const workspaceOf = (cwd: string | null | undefined): string | null => (cwd === null || cwd === undefined ? null : (toWorkspace(cwd)?.id ?? null));

export interface WrapOptions {
  readonly sessions: CliSessions;
  /** Drops an event before t3 sees it. */
  readonly dropEvent?: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean;
}

/** The live turn a card is raised on: what `startTurn` said, and the provider turn id its events gave. */
interface LiveTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  providerTurnId: ProviderTurnId | undefined;
  /** The highest turn item ordinal seen on the turn; a card takes the next. */
  ordinal: number;
}

/** A card waiting on the owner. */
interface OpenCard {
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  readonly answer: (answer: CliAnswer) => void;
}

/** t3's runtime request id of a card: never one of the CLI's own (its adapter answers those). */
const cardRequestPrefix = (driver: string) => `runtime-request:${driver}:t3flare-ask:`;

const answerOf = (decision: ProviderApprovalDecision): CliAnswer =>
  decision === "acceptForSession" ? { approved: true, forSession: true } : decision === "accept" || decision === "acceptAlways" ? { approved: true } : { approved: false, reason: decision };

/** t3's adapter, as the Cloud Environment runs it. */
export const wrapCliAdapter = (adapter: ProviderAdapter.ProviderAdapterV2["Service"], options: WrapOptions): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const { sessions } = options;
  const turnEnded = (session: CliSession) =>
    Effect.gen(function* () {
      if (!session.turnActive) return;
      session.turnActive = false;
      session.process?.turn(false);
      if (session.capFiber !== undefined) yield* Fiber.interrupt(session.capFiber);
      session.capFiber = undefined;
    });
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapter.instanceId,
    driver: adapter.driver,
    getCapabilities: () => adapter.getCapabilities().pipe(Effect.map(cliCapabilities)),
    planSelectionTransition: (input) => adapter.planSelectionTransition(input),
    openSession: (input) =>
      Effect.gen(function* () {
        const session = sessionFor(sessions, input.providerSessionId, input.runtimePolicy.cwd, input.threadId);
        session.runtimeMode = input.runtimePolicy.runtimeMode;
        session.interactionMode = input.runtimePolicy.interactionMode;
        const runtime = yield* adapter.openSession(input).pipe(Effect.provideService(CliSpawn, session));
        yield* Effect.addFinalizer(() => Effect.sync(() => sessions.delete(input.providerSessionId)));
        const { uploadFeedback: _feedback, mcpApps: _apps, ...rest } = runtime;
        // ADR-0028: the relay's cards, raised on the live turn and closed by the owner's answer, the ask's withdrawal or the turn's end.
        const injected = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const cards = new Map<string, OpenCard>();
        let live: LiveTurn | undefined;
        const closeCard = (id: string, decision: ProviderApprovalDecision | null, answer: CliAnswer): Array<ProviderAdapter.ProviderAdapterV2Event> => {
          const card = cards.get(id);
          if (card === undefined) return [];
          cards.delete(id);
          card.answer(answer);
          const now = DateTime.nowUnsafe();
          const resolved = decision !== null;
          return [
            { type: "runtime_request.updated", driver: adapter.driver, threadId: card.node.threadId, runtimeRequest: { ...card.runtimeRequest, status: resolved ? "resolved" : "cancelled", resolvedAt: now, ...(decision === null ? {} : { decision }) } },
            { type: "node.updated", driver: adapter.driver, node: { ...card.node, status: resolved ? "completed" : "cancelled", completedAt: now } },
            { type: "turn_item.updated", driver: adapter.driver, turnItem: { ...card.turnItem, status: resolved ? "completed" : "cancelled", completedAt: now, updatedAt: now } as OrchestrationV2TurnItem },
          ];
        };
        const offer = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
          for (const event of events) Queue.offerUnsafe(injected, event);
        };
        const ask = (card: CliAsk, signal: AbortSignal): Promise<CliAnswer> =>
          new Promise((resolve) => {
            const turn = live;
            if (turn === undefined || turn.providerTurnId === undefined || !session.turnActive) return resolve({ approved: false, reason: "no live turn to ask on" });
            if (signal.aborted) return resolve({ approved: false, reason: "withdrawn" });
            const id = RuntimeRequestId.make(`${cardRequestPrefix(adapter.driver)}${crypto.randomUUID()}`);
            const nodeId = IdAllocator.derive.approvalNode({ requestId: id });
            const nativeItemRef = { driver: adapter.driver, nativeId: id, strength: "weak" as const };
            const now = DateTime.nowUnsafe();
            turn.ordinal += 1;
            const runtimeRequest: OrchestrationV2RuntimeRequest = {
              id,
              nodeId,
              providerTurnId: turn.providerTurnId,
              nativeRequestRef: nativeItemRef,
              kind: card.requestKind,
              status: "pending",
              responseCapability: { type: "live", providerSessionId: input.providerSessionId, supportsFeedback: false },
              createdAt: now,
              resolvedAt: null,
            };
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: turn.threadId,
              runId: turn.runId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              runtimeRequestId: id,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: IdAllocator.derive.approvalTurnItem({ requestId: id }),
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: turn.ordinal,
              status: "waiting",
              title: card.title,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "approval_request",
              requestId: id,
              requestKind: card.requestKind,
              prompt: `${card.summary}\n\n${card.detail}`,
              ...(card.options.length === 0 ? {} : { options: card.options }),
            };
            const onAbort = () => offer(closeCard(id, null, { approved: false, reason: "withdrawn" }));
            const answer = (value: CliAnswer) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            };
            cards.set(id, { runtimeRequest, node, turnItem, answer });
            signal.addEventListener("abort", onAbort, { once: true });
            offer([
              { type: "runtime_request.updated", driver: adapter.driver, threadId: turn.threadId, runtimeRequest },
              { type: "node.updated", driver: adapter.driver, node },
              { type: "turn_item.updated", driver: adapter.driver, turnItem },
            ]);
          });
        const unregister = registerCliAsker(session.thread, {
          ask,
          state: () => ({ runtimeMode: session.runtimeMode, interactionMode: session.interactionMode, workspace: session.workspace }),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unregister();
            for (const id of cards.keys()) closeCard(id, null, { approved: false, reason: "the session ended" });
          }),
        );
        /** Follows the live turn's ids; at its end, its open cards close (before t3 sees the terminal). */
        const track = (event: ProviderAdapter.ProviderAdapterV2Event): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> => {
          const turn = live;
          if (turn === undefined) return [event];
          if (event.type === "provider_turn.updated" && event.providerTurn.nodeId === turn.rootNodeId) turn.providerTurnId = event.providerTurn.id;
          if (event.type === "turn_item.updated" && event.turnItem.runId === turn.runId) turn.ordinal = Math.max(turn.ordinal, event.turnItem.ordinal);
          if (event.type !== "turn.terminal" || (turn.providerTurnId !== undefined && event.providerTurnId !== turn.providerTurnId)) return [event];
          live = undefined;
          return [...[...cards.keys()].flatMap((id) => closeCard(id, null, { approved: false, reason: "the turn ended" })), event];
        };
        const events = runtime.events.pipe(
          Stream.flatMap((event) => Stream.fromIterable(track(event))),
          Stream.tap((event) => (event.type === "turn.terminal" ? turnEnded(session) : Effect.void)),
          Stream.filter((event) => options.dropEvent?.(event) !== true),
          Stream.merge(Stream.fromQueue(injected), { haltStrategy: "left" }),
        );
        return {
          ...rest,
          providerSession: { ...runtime.providerSession, capabilities: cliCapabilities(runtime.providerSession.capabilities) },
          events,
          startTurn: (turn) =>
            Effect.gen(function* () {
              session.runtimeMode = turn.runtimePolicy.runtimeMode;
              session.interactionMode = turn.runtimePolicy.interactionMode;
              session.turnActive = true;
              live = { threadId: turn.threadId, runId: turn.runId, rootNodeId: turn.rootNodeId, providerThreadId: turn.providerThread.id, providerTurnId: undefined, ordinal: turn.providerTurnOrdinal * 100 };
              session.process?.turn(true);
              if (session.capFiber !== undefined) yield* Fiber.interrupt(session.capFiber);
              session.capFiber = yield* Effect.sleep(TURN_CAP_MS).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    console.warn(JSON.stringify({ t3flare: "cli-turn-cap", providerSessionId: input.providerSessionId, key: session.process?.key ?? null }));
                    session.process?.kill();
                  }),
                ),
                Effect.forkDetach,
              );
              // A turn that never started ends here: no `turn.terminal` follows, and the hold and the cap would stay.
              yield* runtime.startTurn(turn).pipe(Effect.onError(() => turnEnded(session)));
            }),
          respondToRuntimeRequest: (response) => {
            if (!response.requestId.startsWith(cardRequestPrefix(adapter.driver))) return runtime.respondToRuntimeRequest(response);
            if (!cards.has(response.requestId)) return Effect.fail(new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver: adapter.driver, requestId: response.requestId }));
            const decision = response.decision ?? "cancel";
            return Effect.sync(() => offer(closeCard(response.requestId, decision, answerOf(decision))));
          },
          forkThread: (fork) => {
            const target = workspaceOf(fork.runtimePolicy?.cwd);
            if (target !== null && session.workspace !== null && target !== session.workspace) {
              return Effect.fail(
                new ProviderAdapter.ProviderAdapterForkThreadError({
                  driver: adapter.driver,
                  providerThreadId: fork.sourceProviderThread.id,
                  cause: `t3flare: a ${adapter.driver} thread forks only within its own Workspace (${session.workspace}), not into ${target}: each Workspace's CLI runs in its own Container`,
                }),
              );
            }
            return runtime.forkThread(fork);
          },
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
};
