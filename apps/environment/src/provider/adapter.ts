// @effect-diagnostics globalDate:off
// A push arrives as plain Promise RPC from the DO host, outside Effect, so its arrival time reads the platform clock.
// The Durable agent provider's ProviderAdapterV2 (step 2a plan, sections 2–3). A provider session is t3's handle on one
// thread's Session DO (agents Worker): commands go to the Session over DO RPC; its pushes come back through the session
// sink and the differ turns them into t3's events. The Session is the durable party: a provider session holds nothing
// a restart would lose but its cursor, and re-reads the Session's state (`snapshot`) whenever it opens or sees a gap.
import {
  isDelegatedAppThread,
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
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { defaultModelSlug, EMPTY_ENDPOINTS, endpointSlug, findEndpointModel, type ModelEndpoints, parseEndpointSlug, selectionSlug } from "@t3flare/models/endpoints";
import { toWorkspace } from "@t3flare/workspace-client";

import { environmentServices } from "../agents/bindings.ts";
import { byName, type SessionRpc } from "../agents/rpc.ts";
import { registerSession } from "../agents/sessionSink.ts";
import { durableModeRecord } from "./threadCaller.ts";
import { PI_DURABLE_DRIVER, PiDurableCapabilities } from "./capabilities.ts";
import { type AttachmentReader, turnPrompt } from "./attachments.ts";
import { messageSkillsFor, type SkillsAccess } from "./skills.ts";
import { approvalIdOf, diff, forgetProposedPlan, makeDifferState, type DifferState, type TurnContext } from "./differ.ts";

const driver = PI_DURABLE_DRIVER;
const derive = IdAllocator.derive;

const ref = (nativeId: string, strength: "strong" | "weak" = "strong"): OrchestrationV2ProviderRef => ({
  driver,
  nativeId,
  strength,
});

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * pi-ai's model and thinking level for a t3 model selection: a Model endpoint's slug, `<endpointId>/<modelId>`, as
 * `{ provider: <endpointId>, modelId }` (ADR-0034 §2). An old selection (`isRetiredSlug`: t3's `default`, a
 * bare id, `anthropic/<id>`) runs on the default model (`selectionSlug`, `defaultModelSlug`). With
 * no endpoint to fall back to it is passed on as it is, and the Session refuses it as a model it does not have. A slug of
 * an endpoint that is gone is passed on too: the turn fails saying so (SPI-1162).
 */
export const modelOf = (selection: ModelSelection, endpoints: ModelEndpoints): { readonly model: ModelRef; readonly thinking: ThinkingLevel | null } => {
  const slug = selectionSlug(selection.model, defaultModelSlug(endpoints));
  const parsed = parseEndpointSlug(slug);
  const model = parsed === undefined ? { provider: "", modelId: slug } : { provider: parsed.endpointId, modelId: parsed.modelId };
  const thinking = getModelSelectionStringOptionValue(selection, "thinking");
  return { model, thinking: thinking !== undefined && THINKING.has(thinking) ? (thinking as ThinkingLevel) : null };
};

/** The Model endpoints as stored now (none before the Environment binds them). */
const endpointsNow = (): ModelEndpoints => environmentServices().modelEndpoints?.() ?? EMPTY_ENDPOINTS;

/** A selection's endpoint model (its limits and inputs), after the fallback; undefined for one no endpoint lists. */
const endpointModelOf = (selection: ModelSelection) => {
  const endpoints = endpointsNow();
  const { model } = modelOf(selection, endpoints);
  return findEndpointModel(endpoints, endpointSlug(model.provider, model.modelId))?.model;
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

export const makePiDurableAdapter = (
  instanceId: ProviderInstanceId,
  mcpSessions: McpProviderSessions.McpProviderSessions["Service"],
  attachments: AttachmentReader,
  skills: SkillsAccess,
) =>
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
      const workspaceInnerCwd = input.runtimePolicy.cwd ? (toWorkspace(input.runtimePolicy.cwd)?.inner ?? null) : null;
      // SPI-1147: the thread's Repo skills and Prompt templates, which a message's `$name` or leading `/` expands with.
      const threadSkills = messageSkillsFor(input.runtimePolicy.cwd, skills);
      /** The Environment skill set's hash now, or undefined when the store cannot be read (never fails the turn). */
      const environmentSkillsInput = (): { readonly environmentSkillsHash?: string } => {
        try {
          const hash = skills.environment?.hash();
          return hash === undefined ? {} : { environmentSkillsHash: hash };
        } catch {
          return {};
        }
      };
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
          const events = diff(differ, state, at, pathOut, textOut);
          for (const event of events) offer(event);
          let settled = false;
          for (const event of events) {
            if (event.type !== "turn.terminal" || event.status !== "completed") continue;
            const context = differ.turns.get(event.providerTurnId);
            if (context?.suggests === true) yield* suggest(context);
          }
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

      const promptSuggestions = input.promptSuggestions ?? Effect.succeed(false);
      /**
       * SPI-996: t3's prompt suggestion after a completed turn, while the owner has the labs flag on, as t3's Codex adapter
       * samples one: best effort, and dropped when another turn started meanwhile.
       */
      const suggest = Effect.fn("PiDurableAdapter.suggest")(
        function* (context: TurnContext) {
          if (!(yield* promptSuggestions)) return;
          const { text } = yield* call("suggestPrompt", () => client().suggestPrompt({ providerTurnId: context.providerTurnId }));
          if (text === "" || closed || differ.turns.size > 0) return;
          offer({ type: "prompt_suggestion.updated", driver, threadId: context.threadId, runId: context.runId, text });
        },
        Effect.catchCause((cause) => Effect.logDebug("pi-durable prompt suggestion failed", cause)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

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
              const nowMs = yield* Clock.currentTimeMillis;
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
      // The Settings server's record of this session's threads' modes (plan D3), cleared when it unregisters.
      const modes = durableModeRecord();
      const noteModes = (threadId: string, runtimeMode: string, interactionMode: string) =>
        modes.note(threadId, { runtimeMode: runtimeModeOf(runtimeMode), interactionMode: interactionModeOf(interactionMode) });

      // The inverse guard: an open turn with no push for SILENT_TURN_MS pulls a snapshot; a turn the Session no longer
      // has is ended as lost, so a lost Session cannot keep a t3 run (and the Environment) open forever.
      yield* Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
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
          modes.forgetAll();
        }).pipe(Effect.andThen(Queue.end(events)), Effect.ignore),
      );

      const register = Effect.fn("PiDurableAdapter.register")(function* (registerInput: {
        readonly threadId: NonNullable<OrchestrationV2ProviderThread["appThreadId"]>;
        readonly existing?: OrchestrationV2ProviderThread | undefined;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: string;
        readonly interactionMode: string;
        readonly resume: boolean;
        /** G6: a new provider thread forked from another (t3's `forkedFrom`) and owned by `ownerNodeId`. */
        readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
        readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
      }) {
        const at = yield* DateTime.now;
        const { model, thinking } = modelOf(registerInput.modelSelection, endpointsNow());
        const credential = yield* t3Mcp;
        const linked = linkedWorkOf(registerInput.threadId);
        const opened = yield* call("open", () =>
          client().open({
            threadId: registerInput.threadId,
            workspaceId,
            // A scratch thread's own folder in the No project Workspace (parity G4); the repo's root otherwise.
            ...(workspaceInnerCwd === null ? {} : { cwd: workspaceInnerCwd }),
            runtimeMode: runtimeModeOf(registerInput.runtimeMode),
            interactionMode: interactionModeOf(registerInput.interactionMode),
            model,
            thinking,
            ...(credential === undefined ? {} : { t3Mcp: credential }),
            linked,
          }),
        );
        noteModes(registerInput.threadId, registerInput.runtimeMode, registerInput.interactionMode);
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
                ownerNodeId: registerInput.ownerNodeId ?? null,
                nativeThreadRef: ref(sessionName),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: registerInput.forkedFrom ?? null,
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
          selection.instanceId !== instanceId ? undefined : endpointModelOf(selection)?.contextWindow,
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
            const { model, thinking } = modelOf(turnInput.modelSelection, endpointsNow());
            const catalogModel = endpointModelOf(turnInput.modelSelection);
            // A model no endpoint lists gets the images (its turn fails anyway): pi-durable shows a text-only model a placeholder.
            const acceptsImages = catalogModel === undefined || catalogModel.input.includes("image");
            const prompt = yield* turnPrompt(turnInput.message, { acceptsImages, reader: attachments, skills: threadSkills });
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
              contextWindow: catalogModel?.contextWindow ?? null,
              acceptsImages,
              providerSessionId: input.providerSessionId,
              suggests: !isDelegatedAppThread(turnInput.appThread),
            };
            // SPI-996: a default-mode turn (Implement, or the owner moving on) leaves the last proposed plan to t3.
            if (interactionModeOf(turnInput.runtimePolicy.interactionMode) === "default") forgetProposedPlan(differ);
            // Registered before the submit, so a push that arrives first is not taken for an orphan (plan revision 3).
            differ.turns.set(providerTurn.id, context);
            lastPushAt.set(providerTurn.id, yield* Clock.currentTimeMillis);
            if (thread === null || thread.id !== turnInput.providerThread.id) thread = turnInput.providerThread;
            offer({ type: "provider_turn.updated", driver, threadId: turnInput.threadId, providerTurn });
            emitThread(
              { status: "active", firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal, lastRunOrdinal: turnInput.runOrdinal },
              startedAt,
            );
            emitSession("running", startedAt, turnInput.modelSelection.model);
            const credential = yield* t3Mcp;
            const linked = linkedWorkOf(turnInput.threadId);
            noteModes(turnInput.threadId, turnInput.runtimePolicy.runtimeMode, turnInput.runtimePolicy.interactionMode);
            yield* call("submitTurn", () =>
              client().submitTurn({
                providerTurnId: providerTurn.id,
                runId: turnInput.runId,
                attemptId: turnInput.attemptId,
                text: prompt.text,
                images: prompt.images,
                model,
                thinking,
                runtimeMode: runtimeModeOf(turnInput.runtimePolicy.runtimeMode),
                interactionMode: interactionModeOf(turnInput.runtimePolicy.interactionMode),
                ...(credential === undefined ? {} : { t3Mcp: credential }),
                linked,
                // SPI-1148: the Environment skill set's hash; the Session has its Workspace take a new one (plan §4.2).
                ...environmentSkillsInput(),
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
          const acceptsImages = differ.turns.get(steerInput.providerTurnId)?.acceptsImages ?? true;
          const prompt = yield* turnPrompt(steerInput.message, { acceptsImages, reader: attachments, skills: threadSkills });
          yield* call("steer", () =>
            client().steer({
              providerTurnId: steerInput.providerTurnId,
              key: `${steerInput.providerTurnId}:${steerInput.message.messageId}`,
              text: prompt.text,
              images: prompt.images,
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
        /**
         * G6 (SPI-987): the conversation goes back to the checkpoint's turn (the Session forks its pi-durable conversation
         * before the first turn after it); t3 restores the files. As t3's Pi adapter, the snapshot is the provider thread
         * alone: t3 keeps its own transcript and marks the later runs rolled back.
         */
        rollbackThread: Effect.fn("PiDurableAdapter.rollbackThread")(
          function* (rollbackInput) {
            if (differ.turns.size > 0) return yield* protocolError("Cannot roll back while a turn is running");
            if (rollbackInput.providerThread.nativeThreadRef?.nativeId !== sessionName) {
              return yield* protocolError("Rollback requested for a thread this session does not host");
            }
            const ordinal = rollbackInput.target.type === "thread_start" ? 0 : rollbackInput.target.providerTurn.ordinal;
            const dropTurns = rollbackInput.providerThreadTurns.filter((turn) => turn.ordinal > ordinal).map((turn) => turn.id);
            const answer = yield* call("rollback", () => client().rollback({ dropTurns }));
            yield* Effect.logInfo("pi-durable rollback", { sessionName, ordinal, ...answer });
            const at = yield* DateTime.now;
            const providerThread = { ...rollbackInput.providerThread, status: "idle" as const, updatedAt: at };
            if (thread?.id === providerThread.id) thread = providerThread;
            return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
          },
          (effect, rollbackInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
              ),
            ),
        ),
        /**
         * G6 (SPI-997): t3's native fork. The target thread's Session (this session's) is seeded with the source Session's
         * model context through the end of `providerTurnId`, and runs on its own from there. On failure t3 falls back to
         * its portable context handoff (ProviderTurnStartService).
         */
        forkThread: Effect.fn("PiDurableAdapter.forkThread")(
          function* (forkInput) {
            if (forkInput.targetThreadId !== input.threadId) return yield* protocolError("A fork opens in the target thread's own session");
            if (differ.turns.size > 0) return yield* protocolError("Cannot fork while a turn is running");
            const source = forkInput.sourceProviderThread.nativeThreadRef;
            if (source?.driver !== driver || source.nativeId === null || !source.nativeId.startsWith("thread:") || source.nativeId === sessionName) {
              return yield* protocolError("The fork's source is not another Durable agent session");
            }
            const policy = forkInput.runtimePolicy ?? input.runtimePolicy;
            const forked = yield* register({
              threadId: forkInput.targetThreadId,
              modelSelection: forkInput.modelSelection ?? input.modelSelection,
              runtimeMode: policy.runtimeMode,
              interactionMode: policy.interactionMode,
              resume: false,
              forkedFrom: {
                providerThreadId: forkInput.sourceProviderThread.id,
                ...(forkInput.providerTurnId === undefined ? {} : { providerTurnId: forkInput.providerTurnId }),
              },
              ownerNodeId: forkInput.ownerNodeId ?? null,
            });
            const answer = yield* call("fork", () =>
              client().fork({ source: source.nativeId!, ...(forkInput.providerTurnId === undefined ? {} : { providerTurnId: forkInput.providerTurnId }) }),
            );
            yield* Effect.logInfo("pi-durable fork", { sessionName, source: source.nativeId, ...answer });
            return forked;
          },
          (effect, forkInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) => new ProviderAdapter.ProviderAdapterForkThreadError({ driver, providerThreadId: forkInput.sourceProviderThread.id, cause }),
              ),
            ),
        ),
      };
      return runtime;
    }),
  });
