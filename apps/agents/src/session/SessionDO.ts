// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off globalTimers:off cryptoRandomUUID:off
// The Session DO (ADR-0005, step 2a plan): one Durable agent's conversation, a pi-durable Harness, per t3 thread. The
// host follows pi-durable's test worker and cloudpid's Session host rules (docs/architecture/overview.md → Session host):
// the Harness opens in the constructor after a fallback alarm is armed, `resume()` runs from the constructor and the
// alarm, the alarm is armed before work is admitted, and a 60 s heartbeat runs while a turn is live.
//
// The Session pushes its committed state to the Environment DO over DO RPC (`sessionPush`), coalesced to about 100 ms
// while streaming and at least every 60 s while a turn is live; the Environment's adapter diffs it into t3's events.
// One alarm, computed in one place (`#arm`): the heartbeat, the turn deadline, the liveness push, a push retry.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Conversation,
  createRegistry,
  Harness,
  type RegistryReader,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  type AbortInput,
  type AnswerInput,
  type ImageInput,
  LIVENESS_PUSH_MS,
  type ModelRef,
  type OpenAnswer,
  type OpenInput,
  PUSH_COALESCE_MS,
  PUSH_ENTRIES_BYTES,
  type PushedEntry,
  type RuntimeMode,
  type SessionPush,
  type SessionPushAnswer,
  type SessionState,
  type SnapshotInput,
  type SteerInput,
  type SubmitTurnInput,
  sessionNameOf,
  type ThinkingLevel,
  TURN_DEADLINE_MS,
  type TurnState,
} from "@t3flare/session-protocol";
import { ComputerExecutionEnv, ComputerFiles, type ComputerWorkspaceStub } from "@t3flare/computer-env";
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { REPO_ROOT } from "@t3flare/workspace-client";
import { DurableObject } from "cloudflare:workers";

import { environmentStub } from "../environment.ts";
import { codingTools } from "../extensions/coding-tools.ts";
import { fileTools } from "../extensions/files.ts";
import { ApprovalStore, permissions } from "../extensions/permissions.ts";
import { projectContext } from "../extensions/project-context.ts";
import { proxyModels } from "./models.ts";
import { liveOf, pushedEntry, turnOfEntry, usageOf } from "./state.ts";

export interface SessionEnv {
  readonly ENVIRONMENT: DurableObjectNamespace;
  /** The Workspace DOs (this Worker's own): the agent's tools work on the thread's Workspace. */
  readonly WORKSPACES: DurableObjectNamespace;
  readonly MODEL_PROXY_URL: string;
  readonly MODEL_PROXY_API_KEY: string;
  /** Overrides TURN_DEADLINE_MS (tests and the stage's deadline check). */
  readonly T3FLARE_TURN_DEADLINE_MS?: string;
}

const context = BACKGROUND_CONTEXT;
const HEARTBEAT_MS = 60_000;
const META_KEY = "t3flare:session";
const TURNS_KEY = "t3flare:turns";
const SEQ_KEY = "t3flare:seq";
const PUSHED_KEY = "t3flare:pushed-entry";
const RETRY_KEY = "t3flare:push-retry";
const LAST_PUSH_KEY = "t3flare:last-push";
const DIAG_KEY = "t3flare:diagnostics";

interface Meta {
  readonly threadId: string;
  readonly workspaceId: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly epoch: string;
}

type Turns = Record<string, TurnState>;
const isLive = (turn: TurnState) => turn.status === "queued" || turn.status === "running";

const userContent = (text: string, images: ReadonlyArray<ImageInput>) =>
  images.length === 0
    ? text
    : [{ type: "text" as const, text }, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];

export class SessionDO extends DurableObject<SessionEnv> {
  #opening: Promise<Harness>;
  #watching: Promise<void> | undefined;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  #pushing: Promise<void> = Promise.resolve();
  #dirty = false;
  /** Registry the tool extensions install into, before the Harness resumes work that needs them. */
  readonly #registry: RegistryReader;
  readonly #approvals: ApprovalStore;

  constructor(ctx: DurableObjectState, env: SessionEnv) {
    super(ctx, env);
    this.#approvals = new ApprovalStore(ctx.storage.kv, () => this.#schedulePush(0));
    const registry = createRegistry();
    registry.install(codingTools());
    registry.install(fileTools(() => this.#files()));
    registry.install(projectContext(REPO_ROOT));
    registry.install(
      permissions({
        store: this.#approvals,
        mode: () => this.#meta()?.runtimeMode ?? "full-access",
        turn: () => Object.entries(this.#turns()).find(([, turn]) => isLive(turn))?.[0] ?? null,
        workspaceId: () => this.#meta()?.workspaceId ?? null,
      }),
    );
    this.#registry = registry;
    this.#opening = new Promise((resolve, reject) => {
      void ctx.blockConcurrencyWhile(async () => {
        try {
          // A fallback before anything can throw: an object whose open or recovery fails is started again.
          const fallback = Date.now() + HEARTBEAT_MS;
          const current = await ctx.storage.getAlarm();
          if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
          const storage = await openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" });
          const harness = await Harness.open(
            storage,
            {
              models: proxyModels({ url: env.MODEL_PROXY_URL, apiKey: env.MODEL_PROXY_API_KEY }),
              registry: this.#registry,
              settings: { retry: { enabled: true, maxRetries: 3 } },
              env: (target) => this.#envAt(target.cwd),
              onReport: (report) => console.warn(JSON.stringify({ t3flare: "pi-durable-report", kind: report.kind })),
            },
            context,
          );
          void harness.closed.then((end) => {
            if (end.kind === "failed") ctx.abort(`Harness failed: ${String(end.error)}`);
          });
          await this.#arm();
          this.#noteDiagnostic("constructed");
          harness.resume();
          if (Object.values(this.#turns()).some(isLive)) void this.#watch();
          resolve(harness);
        } catch (error) {
          reject(error as Error);
          throw error;
        }
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Storage helpers

  #meta(): Meta | undefined {
    return this.ctx.storage.kv.get<Meta>(META_KEY);
  }

  #turns(): Turns {
    return this.ctx.storage.kv.get<Turns>(TURNS_KEY) ?? {};
  }

  #saveTurns(turns: Turns) {
    this.ctx.storage.kv.put(TURNS_KEY, turns);
  }

  #deadlineMs(): number {
    const value = Number(this.env.T3FLARE_TURN_DEADLINE_MS);
    return Number.isFinite(value) && value > 0 ? value : TURN_DEADLINE_MS;
  }

  /** The Workspace DO of the thread's Workspace, as computer's stub; undefined without one. */
  #workspaceStub(): ComputerWorkspaceStub | undefined {
    const id = this.#meta()?.workspaceId;
    if (id === undefined || id === null) return undefined;
    // SAFETY: the Workspace DO answers `fileOperation`, `skills`, `prompts`, `instructions` and `__getWorkspaceStub`.
    return this.env.WORKSPACES.get(this.env.WORKSPACES.idFromName(id)) as unknown as ComputerWorkspaceStub;
  }

  /** The agent's environment: its Workspace's files and commands, in `cwd` (the repo by default). */
  #envAt(cwd: string | undefined): ComputerExecutionEnv | undefined {
    const workspace = this.#workspaceStub();
    const id = this.#meta()?.workspaceId;
    if (workspace === undefined || id === undefined || id === null) return undefined;
    return new ComputerExecutionEnv({ workspace, id: `computer:${id}`, cwd: cwd ?? REPO_ROOT, reachContainer: true, containerEnv: COMMAND_ENV });
  }

  #files(): ComputerFiles | undefined {
    const workspace = this.#workspaceStub();
    return workspace === undefined ? undefined : new ComputerFiles(workspace, { reachContainer: true });
  }

  async #root(model?: ModelRef, thinking?: ThinkingLevel | null): Promise<Conversation> {
    const harness = await this.#opening;
    return harness.root(context, model === undefined ? undefined : { agent: { model, thinkingLevel: thinking ?? null } });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The one alarm

  /** Arms the alarm for the earliest of: heartbeat (a turn live), each live turn's deadline, a push retry. */
  async #arm(): Promise<void> {
    const now = Date.now();
    const turns = Object.values(this.#turns()).filter(isLive);
    const candidates: Array<number> = [];
    if (turns.length > 0) {
      candidates.push(now + Math.min(HEARTBEAT_MS, LIVENESS_PUSH_MS));
      for (const turn of turns) candidates.push(turn.startedAt + this.#deadlineMs());
    }
    const retry = this.ctx.storage.kv.get<number>(RETRY_KEY);
    if (retry !== undefined) candidates.push(retry);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(now + 500, Math.min(...candidates)));
  }

  override async alarm(): Promise<void> {
    const harness = await this.#opening;
    this.#noteDiagnostic("alarms");
    harness.resume();
    const now = Date.now();
    const turns = this.#turns();
    for (const [providerTurnId, turn] of Object.entries(turns)) {
      if (isLive(turn) && now - turn.startedAt >= this.#deadlineMs()) {
        console.warn(JSON.stringify({ t3flare: "turn-deadline", providerTurnId }));
        await this.#abortTurn(providerTurnId, "turn_deadline");
      }
    }
    const live = Object.values(this.#turns()).some(isLive);
    if (live) void this.#watch();
    const lastPush = this.ctx.storage.kv.get<number>(LAST_PUSH_KEY) ?? 0;
    if (this.ctx.storage.kv.get<number>(RETRY_KEY) !== undefined || (live && now - lastPush >= LIVENESS_PUSH_MS - 5_000)) {
      this.#schedulePush(0);
    }
    await this.#arm();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands (RPC from the Environment's adapter)

  async open(input: OpenInput): Promise<OpenAnswer> {
    const meta = this.#meta();
    const epoch = meta?.epoch ?? crypto.randomUUID();
    this.ctx.storage.kv.put(META_KEY, {
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      runtimeMode: input.runtimeMode,
      epoch,
    } satisfies Meta);
    const root = await this.#root(input.model, input.thinking);
    // The agent works in its Workspace's repo (t3's `/w/<id>`), or nowhere without one.
    if (input.workspaceId !== null) await root.configure({ cwd: REPO_ROOT }, context);
    const turns = this.#turns();
    return { epoch, busy: Object.values(turns).some(isLive), turns };
  }

  async submitTurn(input: SubmitTurnInput): Promise<{ readonly submissionId: string }> {
    const existing = this.#turns()[input.providerTurnId];
    if (existing !== undefined) return { submissionId: existing.submissionId };
    const meta = this.#meta();
    if (meta !== undefined) this.ctx.storage.kv.put(META_KEY, { ...meta, runtimeMode: input.runtimeMode } satisfies Meta);
    const root = await this.#root(input.model, input.thinking);
    await root.configure({ model: input.model, thinkingLevel: input.thinking ?? null }, context);
    const startedAt = Date.now();
    // Recorded with a placeholder before the submit, so the alarm armed below covers it if the process dies after it.
    const turns = this.#turns();
    turns[input.providerTurnId] = { submissionId: "", runId: input.runId, attemptId: input.attemptId, status: "queued", startedAt };
    this.#saveTurns(turns);
    await this.#arm();
    const submission = await root.submit(
      { type: "input", content: userContent(input.text, input.images), requestId: input.providerTurnId, whenBusy: "followUp" },
      context,
    );
    const after = this.#turns();
    after[input.providerTurnId] = { ...after[input.providerTurnId]!, submissionId: String(submission.id) };
    this.#saveTurns(after);
    void this.#watch();
    this.#schedulePush(0);
    return { submissionId: String(submission.id) };
  }

  async steer(input: SteerInput): Promise<{ readonly submissionId: string }> {
    const turn = this.#turns()[input.providerTurnId];
    if (turn === undefined || !isLive(turn)) throw new Error(`t3flare: turn ${input.providerTurnId} is not live`);
    const root = await this.#root();
    const submission = await root.submit(
      // Only into a run in progress: a steer that finds the Session idle is refused, never a run t3 did not start.
      { type: "input", content: userContent(input.text, input.images), requestId: input.key, whenBusy: "steer", whenIdle: "reject" },
      context,
    );
    const turns = this.#turns();
    const current = turns[input.providerTurnId];
    if (current !== undefined) {
      turns[input.providerTurnId] = { ...current, steers: [...(current.steers ?? []), String(submission.id)] };
      this.#saveTurns(turns);
    }
    this.#schedulePush(0);
    return { submissionId: String(submission.id) };
  }

  async abort(input: AbortInput): Promise<{ readonly aborted: boolean }> {
    const turns = this.#turns();
    const targets = input.all === true
      ? Object.entries(turns).filter(([, turn]) => isLive(turn)).map(([id]) => id)
      : input.providerTurnId !== undefined && turns[input.providerTurnId] !== undefined && isLive(turns[input.providerTurnId]!)
        ? [input.providerTurnId]
        : [];
    for (const id of targets) await this.#abortTurn(id, input.reason);
    this.#schedulePush(0);
    return { aborted: targets.length > 0 };
  }

  async #abortTurn(providerTurnId: string, reason: string): Promise<void> {
    const harness = await this.#opening;
    const turn = this.#turns()[providerTurnId];
    if (turn === undefined) return;
    const record = turn.submissionId === "" ? undefined : await harness.submission(turn.submissionId as never, context);
    const status = record === undefined ? undefined : (await record.status(context)).status;
    if (record !== undefined && status === "queued") await record.abort(context);
    else if (status === "placed") await (await this.#root()).abort(context);
    const turns = this.#turns();
    if (turns[providerTurnId] !== undefined && isLive(turns[providerTurnId]!)) {
      turns[providerTurnId] = { ...turns[providerTurnId]!, status: "aborted", reason, settledAt: Date.now() };
      this.#saveTurns(turns);
    }
    this.#dropAbandonedApprovals();
  }

  /** Answers a pending approval: the waiting call runs or returns the decline. */
  answer(input: AnswerInput): Promise<{ readonly applied: boolean }> {
    const applied = this.#approvals.answer(input.requestId, input.decision, input.feedback);
    console.log(JSON.stringify({ t3flare: "approval-answer", requestId: input.requestId, decision: input.decision, applied }));
    return Promise.resolve({ applied });
  }

  async snapshot(input: SnapshotInput = {}): Promise<SessionState> {
    await this.#refreshTurns();
    const fromEntry = input.fromEntry === undefined ? undefined : Number(input.fromEntry) + 1;
    return this.#state(fromEntry, Number.POSITIVE_INFINITY);
  }

  /** A test's fault (the inverse guard's check): forgets every turn, as a Session that lost its state would. */
  async dropTurns(): Promise<{ readonly dropped: number }> {
    const dropped = Object.keys(this.#turns()).length;
    this.#saveTurns({});
    await (await this.#root()).abort(context);
    await this.#arm();
    return { dropped };
  }

  /** Counts of this object's starts and alarms (the approval-survives-restarts check, step 2a M3). */
  #noteDiagnostic(what: "constructed" | "alarms"): void {
    const diag = this.ctx.storage.kv.get<Record<string, number>>(DIAG_KEY) ?? {};
    this.ctx.storage.kv.put(DIAG_KEY, { ...diag, [what]: (diag[what] ?? 0) + 1, [`${what}At`]: Date.now() });
  }

  diagnostics(): Promise<Readonly<Record<string, number>>> {
    return Promise.resolve(this.ctx.storage.kv.get<Record<string, number>>(DIAG_KEY) ?? {});
  }

  /** A test's fault: the object restarts (as an eviction does), with whatever work it had in memory cut off. */
  restart(): Promise<{ readonly restarting: true }> {
    setTimeout(() => this.ctx.abort("t3flare: session restart requested"), 0);
    return Promise.resolve({ restarting: true });
  }

  /** M0's check: the Environment calls this, and it calls the Environment back over its own binding. */
  async ping(echo: string): Promise<{ readonly session: string; readonly echo: string; readonly environment: unknown }> {
    return {
      session: this.ctx.id.toString(),
      echo,
      environment: await environmentStub(this.env.ENVIRONMENT).agentsPing(`from session ${echo}`),
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Turn states

  /** Reads each live turn's submissions (its own and its steers') and settles the turns whose submissions settled. */
  async #refreshTurns(): Promise<void> {
    const harness = await this.#opening;
    const turns = this.#turns();
    let changed = false;
    for (const [id, turn] of Object.entries(turns)) {
      if (!isLive(turn) || turn.submissionId === "") continue;
      const submission = await harness.submission(turn.submissionId as never, context);
      if (submission === undefined) continue;
      const status = await submission.status(context);
      // A steer still queued or placed keeps the turn running, whatever its own submission says.
      let steering = false;
      for (const steer of turn.steers ?? []) {
        const record = await harness.submission(steer as never, context);
        const steerStatus = record === undefined ? undefined : (await record.status(context)).status;
        if (steerStatus === "queued" || steerStatus === "placed") steering = true;
      }
      let next: TurnState = turn;
      if (status.status === "placed" || (status.status === "done" && steering)) {
        next = { ...turn, status: "running", inputEntry: String(status.entry) };
      } else if (status.status === "done") {
        next = { ...turn, status: "answered", inputEntry: String(status.entry), settledAt: Date.now() };
      } else if (status.status === "unanswered") {
        const reason = String(status.reason);
        const detail = typeof status.detail === "string" ? status.detail.slice(0, 2048) : undefined;
        next = {
          ...turn,
          status: reason === "aborted" ? "aborted" : "failed",
          reason,
          ...(detail === undefined ? {} : { detail }),
          ...("entry" in status && status.entry !== undefined ? { inputEntry: String(status.entry) } : {}),
          settledAt: Date.now(),
        };
      }
      if (JSON.stringify(next) !== JSON.stringify(turn)) {
        turns[id] = next;
        changed = true;
      }
    }
    if (changed) this.#saveTurns(turns);
    this.#dropAbandonedApprovals();
  }

  /** Requests of turns no longer live are withdrawn (their calls were aborted or ended). */
  #dropAbandonedApprovals(): void {
    const live = new Set(Object.entries(this.#turns()).filter(([, turn]) => isLive(turn)).map(([id]) => id));
    this.#approvals.dropAbandoned(live);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // State and pushes

  async #state(fromEntry: number | undefined, bound: number): Promise<SessionState & { readonly lastEntry: number | undefined }> {
    const root = await this.#root();
    const turns = this.#turns();
    const entries: Array<PushedEntry> = [];
    let bytes = 0;
    let more = false;
    let lastEntry: number | undefined;
    let cursor: unknown;
    do {
      const page = await root.entries(
        { ...(fromEntry === undefined ? {} : { minEntryId: fromEntry as never }), order: "ascending" },
        100,
        cursor as never,
        context,
      );
      for (const entry of page.items) {
        const pushed = pushedEntry(entry as never, turnOfEntry(Number(entry.id), turns));
        const size = JSON.stringify(pushed).length;
        if (bytes + size > bound && entries.length > 0) {
          more = true;
          break;
        }
        bytes += size;
        entries.push(pushed);
        lastEntry = Number(entry.id);
      }
      cursor = more ? undefined : page.next;
    } while (cursor !== undefined);
    const view = await this.#view();
    const liveTurn = Object.entries(turns).find(([, turn]) => turn.status === "running")?.[0] ?? null;
    const meta = this.#meta();
    const agentDoc = (view?.docs["pi.agent"] ?? {}) as { model?: ModelRef; thinkingLevel?: string };
    const inbox = (view?.docs["pi.inbox"] ?? {}) as { items?: ReadonlyArray<unknown> };
    return {
      sessionId: meta === undefined ? this.ctx.id.toString() : sessionNameOf(meta.threadId),
      epoch: meta?.epoch ?? "",
      entries,
      more,
      live: liveOf(view?.docs["pi.live"], () => liveTurn),
      agent: { model: agentDoc.model ?? null, thinking: agentDoc.thinkingLevel ?? null },
      usage: usageOf((view?.docs["pi.usage"] as { total?: unknown } | undefined)?.total ?? view?.docs["pi.usage"]) ?? null,
      inbox: { pending: inbox.items?.length ?? 0 },
      approvals: this.#approvals.pending(),
      turns,
      lastEntry,
    };
  }

  /** The root conversation's current view (documents), read through a one-shot watch. */
  #lastView: { readonly docs: Readonly<Record<string, unknown>> } | undefined;
  async #view(): Promise<{ readonly docs: Readonly<Record<string, unknown>> } | undefined> {
    if (this.#lastView !== undefined && this.#watching !== undefined) return this.#lastView;
    const root = await this.#root();
    const handle = await root.watch(context, { min: 1 });
    const value = handle.value as { docs: Readonly<Record<string, unknown>> };
    await handle.stop();
    return value;
  }

  /** Watches the root conversation while turns are live: each commit makes a push due. */
  #watch(): Promise<void> {
    this.#watching ??= (async () => {
      const root = await this.#root();
      const handle = await root.watch(context, { min: 1 });
      this.#lastView = handle.value as { docs: Readonly<Record<string, unknown>> };
      handle.start(async (call) => {
        if (call.kind !== "value") return;
        this.#lastView = call.value as { docs: Readonly<Record<string, unknown>> };
        this.#schedulePush(PUSH_COALESCE_MS);
      });
      const end = await handle.closed;
      console.log(JSON.stringify({ t3flare: "session-watch-ended", kind: end.kind }));
      this.#watching = undefined;
      this.#lastView = undefined;
    })().catch((error: unknown) => {
      console.error(JSON.stringify({ t3flare: "session-watch-failed", error: String(error) }));
      this.#watching = undefined;
    });
    return this.#watching;
  }

  #schedulePush(delayMs: number): void {
    this.#dirty = true;
    if (this.#pushTimer !== undefined && delayMs > 0) return;
    if (this.#pushTimer !== undefined) clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = undefined;
      this.#pushing = this.#pushing.then(() => this.#push()).catch(() => undefined);
    }, delayMs);
  }

  async #push(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    if (this.#meta() === undefined) return;
    await this.#refreshTurns();
    const pushed = this.ctx.storage.kv.get<number>(PUSHED_KEY);
    const state = await this.#state(pushed === undefined ? undefined : pushed + 1, PUSH_ENTRIES_BYTES);
    const prevSeq = this.ctx.storage.kv.get<number>(SEQ_KEY) ?? 0;
    const { lastEntry, ...rest } = state;
    const push: SessionPush = { ...rest, seq: prevSeq + 1, prevSeq, liveness: state.entries.length === 0 };
    let answer: SessionPushAnswer;
    try {
      answer = (await environmentStub(this.env.ENVIRONMENT).sessionPush(push)) as SessionPushAnswer;
    } catch (error) {
      // The Environment is resetting or unreachable: the push is due again from the alarm (it also wakes the Environment).
      const retries = (this.ctx.storage.kv.get<number>("t3flare:push-retries") ?? 0) + 1;
      this.ctx.storage.kv.put("t3flare:push-retries", retries);
      this.ctx.storage.kv.put(RETRY_KEY, Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(retries, 5)));
      console.warn(JSON.stringify({ t3flare: "session-push-failed", retries, error: String(error).slice(0, 500) }));
      this.#dirty = true;
      await this.#arm();
      return;
    }
    this.ctx.storage.kv.put(SEQ_KEY, push.seq);
    this.ctx.storage.kv.put(LAST_PUSH_KEY, Date.now());
    this.ctx.storage.kv.delete(RETRY_KEY);
    this.ctx.storage.kv.delete("t3flare:push-retries");
    if (lastEntry !== undefined) this.ctx.storage.kv.put(PUSHED_KEY, lastEntry);
    if (state.more) this.#dirty = true;
    for (const orphan of answer.orphans ?? []) {
      console.warn(JSON.stringify({ t3flare: "session-orphan-abort", providerTurnId: orphan }));
      await this.#abortTurn(orphan, "orphaned_by_environment");
      this.#dirty = true;
    }
    if (this.#dirty) this.#schedulePush(PUSH_COALESCE_MS);
    await this.#arm();
  }
}
