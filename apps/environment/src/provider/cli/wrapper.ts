// @effect-diagnostics globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off globalDate:off globalDateInEffect:off effectFnOpportunity:off
// The CLI adapters' wrapper (step 4a, plan §3 with review F1, F7, F10): t3's own Codex and Pi adapters, with what the
// Cloud Environment changes around them.
//
// - One process per provider session, so one Workspace per session (review F1): t3 reuses a live session for a second
//   thread when the adapter says `supportsMultipleProviderThreadsPerSession` (Orchestrator.ts `providerSessionIdFor`,
//   ProviderSessionManager `open`), which would run another project's thread in this Workspace's Container. The flag is
//   false both in `getCapabilities()` and on the session entity t3 keeps.
// - A fork into another Workspace is refused: the fork runs in the source's process, so in the source's Container.
// - No t3 tools (OD-3): `supportsMcpTools` is false, MCP apps are gone, feedback uploads (to the vendor) are gone.
// - The turn's state reaches the Workspace (`processTurn`): the Container's hold (review F7).
// - The 2 h turn cap (ADR-0015): a turn still running then ends its process, and with it the session.
// - Events can be filtered (pi's "t3-code MCP unavailable" notice, review F10).
import { toWorkspace } from "@t3flare/workspace-client";
import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { ChannelProcess } from "../../agents/processChannel.ts";
import { linkedWorkOf } from "../adapter.ts";

/** ADR-0015: a CLI turn longer than this ends its process. */
export const TURN_CAP_MS = 2 * 60 * 60_000;

/** What t3flare knows of one CLI provider session: its process (the client factory's) and the thread's policy. */
export interface CliSession {
  /** t3's thread that opened the session. */
  readonly thread: string;
  /** The thread came through a peer link (step 3's `linkOrigin`): its pushes ask while the process lives (F8). */
  readonly linked: boolean;
  process: ChannelProcess | undefined;
  runtimeMode: string | undefined;
  interactionMode: string | undefined;
  /** The Workspace the session's process runs in. */
  readonly workspace: string | null;
  turnActive: boolean;
  capFiber: Fiber.Fiber<void> | undefined;
}

/** Sessions of one driver instance, by provider session id: shared by its client factory and its wrapper. */
export type CliSessions = Map<string, CliSession>;

/**
 * The session whose adapter is opening now, for the spawner (`agents/cliProcess.ts`): t3's adapters spawn inside
 * `openSession`, so the spawn learns its thread, whether it is linked, and records its process on the session.
 */
export const CliSpawn = Context.Reference<CliSession | undefined>("t3flare/CliSpawn", { defaultValue: () => undefined });

export const sessionFor = (sessions: CliSessions, providerSessionId: string, cwd: string | null, thread: string): CliSession => {
  let session = sessions.get(providerSessionId);
  if (session === undefined) {
    session = { thread, linked: linkedWorkOf(thread) !== null, process: undefined, runtimeMode: undefined, interactionMode: undefined, workspace: cwd === null ? null : (toWorkspace(cwd)?.id ?? null), turnActive: false, capFiber: undefined };
    sessions.set(providerSessionId, session);
  }
  return session;
};

/** The capabilities t3 sees for a CLI agent here. */
export const cliCapabilities = (capabilities: OrchestrationV2ProviderCapabilities): OrchestrationV2ProviderCapabilities => ({
  ...capabilities,
  sessions: { ...capabilities.sessions, supportsMultipleProviderThreadsPerSession: false },
  tools: { ...capabilities.tools, supportsMcpTools: false },
});

const workspaceOf = (cwd: string | null | undefined): string | null => (cwd === null || cwd === undefined ? null : (toWorkspace(cwd)?.id ?? null));

export interface WrapOptions {
  readonly sessions: CliSessions;
  /** Drops an event before t3 sees it. */
  readonly dropEvent?: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean;
  /** The CLI has no plan mode (pi): a plan turn (handed down by a link, F6) is refused rather than run unguarded. */
  readonly refusePlan?: string;
}

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
        const events = runtime.events.pipe(
          Stream.tap((event) => (event.type === "turn.terminal" ? turnEnded(session) : Effect.void)),
          Stream.filter((event) => options.dropEvent?.(event) !== true),
        );
        return {
          ...rest,
          providerSession: { ...runtime.providerSession, capabilities: cliCapabilities(runtime.providerSession.capabilities) },
          events,
          startTurn: (turn) =>
            Effect.gen(function* () {
              if (options.refusePlan !== undefined && turn.runtimePolicy.interactionMode !== "default") {
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: adapter.driver,
                  threadId: turn.threadId,
                  providerThreadId: turn.providerThread.id,
                  runId: turn.runId,
                  cause: options.refusePlan,
                });
              }
              session.runtimeMode = turn.runtimePolicy.runtimeMode;
              session.interactionMode = turn.runtimePolicy.interactionMode;
              session.turnActive = true;
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
