// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off globalTimers:off cryptoRandomUUID:off globalFetch:off
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
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  type AbortInput,
  type AnswerInput,
  type ImageInput,
  type InteractionMode,
  interactionModeOf,
  type LinkedWork,
  type T3McpCredential,
  LIVENESS_PUSH_MS,
  type ModelRef,
  type OpenAnswer,
  type OpenInput,
  PUSH_COALESCE_MS,
  PUSH_ENTRIES_BYTES,
  type PushedEntry,
  type RuntimeMode,
  runtimeModeOf,
  type SessionPush,
  type SessionPushAnswer,
  type SessionState,
  type SnapshotInput,
  type SteerInput,
  type SubmitTurnInput,
  sessionNameOf,
  type ThinkingLevel,
  TURN_DEADLINE_MS,
  type ProxyRecord,
  type TurnState,
} from "@t3flare/session-protocol";
import { ComputerExecutionEnv, ComputerFiles, type ComputerWorkspaceStub } from "@t3flare/computer-env";
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { REPO_ROOT } from "@t3flare/workspace-client";
import { DurableObject } from "cloudflare:workers";

import { EMPTY_HARNESS, extensionOf, resolveHarness, type ResolvedHarness } from "@t3flare/harness-registry";

import { environmentStub } from "../environment.ts";
import { type CodemodeSandboxNamespace, codemodeExtension, remoteSandbox, toolSearchExtension } from "../extensions/codemode.ts";
import { mcpExtension, mcpNamespaces, type McpView } from "../extensions/mcp.ts";
import { codingTools } from "../extensions/coding-tools.ts";
import { fileTools } from "../extensions/files.ts";
import { answerText, askUser, QuestionStore } from "../extensions/ask-user.ts";
import { McpQuestions } from "../extensions/mcpQuestions.ts";
import { ApprovalStore, interactionModeSection, permissions } from "../extensions/permissions.ts";
import { projectContext } from "../extensions/project-context.ts";
import { WEB_EXTENSION, WEB_NAMESPACE, webExtension } from "../extensions/web.ts";
import { catalogOf, type T3Catalog, t3McpExtension } from "../extensions/t3-mcp.ts";
import { T3McpClient } from "./t3McpClient.ts";
import { modelCatalog, type ModelCatalog } from "@t3flare/models/catalog";
import { proxyModels } from "./models.ts";
import { compactionLimits, FAULT_FIXTURES, type Fault, type ProxyLimitsOptions, proxyLimits, recordingFetch } from "./proxyLimits.ts";
import { KILL_RETRY_MS, RunningExecs } from "./runningExecs.ts";
import { liveOf, pushedEntry, turnOfEntry, usageOf } from "./state.ts";

export interface SessionEnv {
  readonly ENVIRONMENT: DurableObjectNamespace;
  /** The Workspace DOs (this Worker's own): the agent's tools work on the thread's Workspace. */
  readonly WORKSPACES: DurableObjectNamespace;
  readonly MODEL_PROXY_URL: string;
  readonly MODEL_PROXY_API_KEY: string;
  /** "1" on a test stage (never prod): the model proxy fault route is accepted. */
  readonly T3FLARE_FAULTS?: string;
  /** Overrides TURN_DEADLINE_MS (tests and the stage's deadline check). */
  readonly T3FLARE_TURN_DEADLINE_MS?: string;
  /** Code mode's sandbox objects (ADR-0027), from the codemode Worker; absent in a deploy's bootstrap pass. */
  readonly CODEMODE_SANDBOX?: CodemodeSandboxNamespace;
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
const CATALOG_KEY = "t3flare:model-catalog";
/** Each turn's model proxy record (requests, last failure), apart from the turns so no turn write can lose one. */
const PROXY_KEY = "t3flare:proxy";
/**
 * t3's MCP credential for this thread's provider session (step 3, ADR-0022): this object's storage only, never a push,
 * a snapshot, a Workspace or a Container (review C8).
 */
const T3_MCP_KEY = "t3flare:t3-mcp";
/** The catalog the `t3-mcp` extension was built from (installed again at each start, before work resumes). */
const T3_CATALOG_KEY = "t3flare:t3-mcp-catalog";
/** The harness settings the Session last took (ADR-0026), so a restart installs the same extensions before resuming. */
const HARNESS_KEY = "t3flare:harness";
/** The MCP tools the Session last installed (ADR-0028), in chunks (review M12): a restart installs the same first. */
const MCP_BUILD_KEY = "t3flare:mcp-build";
const MCP_CHUNK_CHARS = 100_000;
/** How long a turn's start waits for the Environment's harness settings before it keeps the ones it has. */
const HARNESS_READ_MS = 5_000;
/** A test's model proxy fault (stages only). */
const FAULT_KEY = "t3flare:proxy-fault";
/** The most a Stop (or the object's start) waits for an aborted command's processes to be killed. */
const KILL_BOUND_MS = 3_000;

interface Meta {
  readonly threadId: string;
  readonly workspaceId: string | null;
  readonly runtimeMode: RuntimeMode;
  /** Step 3 (F-plan); absent in a Session stored before it. */
  readonly interactionMode?: InteractionMode;
  /** Step 3: the thread's link origin (t3's `linkOrigin`), null or absent for the owner's own work. */
  readonly linked?: LinkedWork | null;
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
  /** The agent's questions to the owner (`ask_user`, step 3). */
  readonly #questions: QuestionStore;
  /** MCP servers' questions during the Session's calls (SPI-1079): in memory, never stored. */
  readonly #mcpQuestions: McpQuestions;
  /** The proxy's model list (ADR-0012), kept in this object's storage and read again when it is old. */
  readonly #catalog: ModelCatalog;
  /** Every model request's fetch: the proxy's answers recorded, a test fault answered (`proxyLimits.ts`). */
  readonly #proxyFetch: typeof fetch;
  /** How a failed model answer is classified and recorded: by generation's hook and by compaction's models. */
  readonly #limits: ProxyLimitsOptions;
  /** The Container commands running, kept so an aborted one's processes are killed, even after a restart. */
  readonly #execs: RunningExecs;
  /** t3's `/mcp`, through the Environment DO (step 3). */
  readonly #t3: T3McpClient;
  readonly #registryWriter: ReturnType<typeof createRegistry>;

  constructor(ctx: DurableObjectState, env: SessionEnv) {
    super(ctx, env);
    this.#catalog = modelCatalog({
      proxy: { url: env.MODEL_PROXY_URL, apiKey: env.MODEL_PROXY_API_KEY },
      store: { read: () => ctx.storage.kv.get(CATALOG_KEY), write: (catalog) => ctx.storage.kv.put(CATALOG_KEY, catalog) },
    });
    this.#approvals = new ApprovalStore(ctx.storage.kv, () => this.#schedulePush(0));
    this.#questions = new QuestionStore(ctx.storage.kv, () => this.#schedulePush(0));
    this.#mcpQuestions = new McpQuestions(() => this.#schedulePush(0));
    const recorder = recordingFetch({
      fetch: (input, init) => fetch(input, init),
      fault: () => ctx.storage.kv.get<Fault>(FAULT_KEY),
      clearFault: () => void ctx.storage.kv.delete(FAULT_KEY),
      now: () => Date.now(),
      onRequest: () => this.#noteProxy((record) => ({ ...record, requests: record.requests + 1 })),
    });
    this.#proxyFetch = recorder.fetch;
    this.#execs = new RunningExecs(ctx.storage.kv, (ids) => this.#killExecs(ids));
    const registry = createRegistry();
    this.#limits = { last: recorder.last, record: (failure) => this.#noteProxy((record) => ({ ...record, failure })) };
    registry.install(proxyLimits(this.#limits));
    registry.install(codingTools());
    registry.install(fileTools(() => this.#files()));
    registry.install(projectContext(REPO_ROOT));
    registry.install(
      permissions({
        store: this.#approvals,
        mode: () => runtimeModeOf(this.#meta()?.runtimeMode),
        interaction: () => interactionModeOf(this.#meta()?.interactionMode),
        turn: () => this.#liveTurn(),
        workspaceId: () => this.#meta()?.workspaceId ?? null,
      }),
    );
    registry.install(interactionModeSection(() => interactionModeOf(this.#meta()?.interactionMode)));
    registry.install(askUser({ store: this.#questions, turn: () => this.#liveTurn() }));
    this.#t3 = new T3McpClient(
      (request) => environmentStub(env.ENVIRONMENT).mcp(request),
      () => ctx.storage.kv.get<T3McpCredential>(T3_MCP_KEY),
    );
    this.#registryWriter = registry;
    // The tools the last turn had, before work that may call them resumes.
    const catalog = ctx.storage.kv.get<T3Catalog>(T3_CATALOG_KEY);
    if (catalog !== undefined) registry.install(this.#t3Extension(catalog));
    // The MCP tools the last turn had, then code mode and tool search as the settings last taken say (defaults before the
    // first), after every tool they reach.
    const mcp = this.#mcpBuild();
    if (mcp !== undefined) registry.install(this.#mcpExtension(mcp));
    this.#installHarness(ctx.storage.kv.get<ResolvedHarness>(HARNESS_KEY) ?? resolveHarness(EMPTY_HARNESS));
    this.#registry = registry;
    this.#opening = new Promise((resolve, reject) => {
      void ctx.blockConcurrencyWhile(async () => {
        try {
          // A fallback before anything can throw: an object whose open or recovery fails is started again.
          const fallback = Date.now() + HEARTBEAT_MS;
          const current = await ctx.storage.getAlarm();
          if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
          // The proxy's list before the Harness opens, so a model it added is there for a resumed turn; bounded, never throws.
          await this.#catalog.refresh();
          const storage = await openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" });
          const harness = await Harness.open(
            storage,
            {
              models: compactionLimits(
                proxyModels({ url: env.MODEL_PROXY_URL, apiKey: env.MODEL_PROXY_API_KEY }, () => this.#catalog.current(), this.#proxyFetch),
                this.#limits,
              ),
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
          // The commands that were running when this object last died: their calls are cut off (pi-durable reruns or ends
          // them), so their processes are killed. Read before the Harness resumes, so a command it starts is not.
          const orphans = this.#execs.ids();
          await this.#arm();
          this.#noteDiagnostic("constructed");
          harness.resume();
          // Bounded, and never fails the open.
          if (orphans.length > 0) {
            console.warn(JSON.stringify({ t3flare: "kill-orphaned-execs", count: orphans.length }));
            await this.#execs.killAll(KILL_BOUND_MS, orphans).catch(() => undefined);
            await this.#arm();
          }
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
  // t3's MCP tools (step 3)

  #t3Extension(catalog: T3Catalog) {
    return t3McpExtension(catalog, {
      store: this.#approvals,
      mode: () => runtimeModeOf(this.#meta()?.runtimeMode),
      interaction: () => interactionModeOf(this.#meta()?.interactionMode),
      turn: () => this.#liveTurn(),
      credential: () => this.ctx.storage.kv.get<T3McpCredential>(T3_MCP_KEY)?.providerSessionId,
      instructions: () => this.ctx.storage.kv.get<T3McpCredential>(T3_MCP_KEY)?.instructions,
      call: (tool, args) => this.#t3.callTool(tool, args),
    });
  }

  /**
   * Keeps the credential t3 issued for this provider session (none: the tools are unavailable), and when it changed
   * lists t3's tools with it and installs the extension again if the catalog changed. Never fails the command.
   */
  async #takeT3Mcp(credential: T3McpCredential | undefined): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (credential === undefined) {
      kv.delete(T3_MCP_KEY);
      return;
    }
    const before = kv.get<T3McpCredential>(T3_MCP_KEY);
    kv.put(T3_MCP_KEY, credential);
    if (before?.authorization === credential.authorization && kv.get(T3_CATALOG_KEY) !== undefined) return;
    try {
      const listed = await this.#t3.listTools();
      if (listed === undefined) return;
      const catalog = catalogOf(listed);
      if (kv.get<T3Catalog>(T3_CATALOG_KEY)?.hash === catalog.hash) return;
      kv.put(T3_CATALOG_KEY, catalog);
      this.#registryWriter.install(this.#t3Extension(catalog));
      // tool_search's deferral wraps name every other tool: t3's changed.
      this.#installHarness(kv.get<ResolvedHarness>(HARNESS_KEY) ?? resolveHarness(EMPTY_HARNESS));
      console.log(JSON.stringify({ t3flare: "t3-mcp-catalog", tools: catalog.tools.length, left: catalog.left.length, hash: catalog.hash }));
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "t3-mcp-catalog-failed", error: String(error).slice(0, 300) }));
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Harness settings (ADR-0026): code mode, tool search and the offered tools, taken at a turn's start

  /**
   * Installs (or removes) the switchable extensions (web, SPI-1054), then code mode and tool search, as `harness` says:
   * code mode's namespaces and tool search's deferral cover the tools installed before them. pi-durable applies it from
   * the next phase.
   */
  #installHarness(harness: ResolvedHarness): void {
    const registry = this.#registryWriter;
    const namespaces: Array<CodemodeNamespace> = [];
    const web = extensionOf(harness, WEB_EXTENSION);
    if (web.enabled) {
      const searchModel = String(web.settings.searchModel);
      registry.install(
        webExtension(
          web.settings.search === true ? { search: { url: this.env.MODEL_PROXY_URL, apiKey: this.env.MODEL_PROXY_API_KEY, model: () => searchModel } } : {},
        ),
      );
      namespaces.push(WEB_NAMESPACE);
    } else {
      registry.uninstall({ name: WEB_EXTENSION });
    }
    const sandbox = this.env.CODEMODE_SANDBOX;
    const sessionName = this.ctx.id.name ?? this.ctx.id.toString();
    if (harness.codemode.enabled && sandbox !== undefined) {
      const view = this.#mcpBuild();
      registry.install(
        codemodeExtension(remoteSandbox(sandbox, sessionName), {
          inlineBudget: harness.codemode.inlineBudget,
          namespaces: [...namespaces, ...(view === undefined ? [] : mcpNamespaces(view))],
        }),
      );
    } else {
      registry.uninstall({ name: "codemode" });
    }
    if (harness.toolSearch.enabled) {
      const names = registry
        .snapshot()
        .tools()
        .flatMap(({ extension, tool }) => (extension.name === "tool-search" ? [] : [tool.name]));
      registry.install(toolSearchExtension(names, harness.offered));
    } else {
      registry.uninstall({ name: "tool-search" });
    }
  }

  // MCP tools (ADR-0028)

  #mcpExtension(view: McpView) {
    return mcpExtension(view, {
      store: this.#approvals,
      mode: () => runtimeModeOf(this.#meta()?.runtimeMode),
      interaction: () => interactionModeOf(this.#meta()?.interactionMode),
      turn: () => this.#liveTurn(),
      call: (input) => environmentStub(this.env.ENVIRONMENT).mcpCall(input),
      asker: (callId, signal) => this.#mcpQuestions.asker(this.#liveTurn(), callId, signal),
    });
  }

  /** The MCP view the Session last installed, from its chunks. */
  #mcpBuild(): McpView | undefined {
    const kv = this.ctx.storage.kv;
    const meta = kv.get<{ readonly version: string; readonly chunks: number }>(MCP_BUILD_KEY);
    if (meta === undefined) return undefined;
    let text = "";
    for (let index = 0; index < meta.chunks; index++) text += kv.get<string>(`${MCP_BUILD_KEY}:${index}`) ?? "";
    try {
      return JSON.parse(text) as McpView;
    } catch {
      return undefined;
    }
  }

  /**
   * The Environment's MCP view at a turn's start: a new version is kept and installed (with code mode's namespaces and
   * tool search's deferral, once: a positional tools entry), never mid-turn. Bounded; never fails the turn.
   */
  async #takeMcp(): Promise<void> {
    try {
      const view = await Promise.race([
        environmentStub(this.env.ENVIRONMENT).mcpView(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HARNESS_READ_MS)),
      ]);
      if (view === undefined) return console.warn(JSON.stringify({ t3flare: "mcp-view-timeout" }));
      const kv = this.ctx.storage.kv;
      if (kv.get<{ version: string }>(MCP_BUILD_KEY)?.version === view.version) return;
      const text = JSON.stringify(view);
      const chunks = Math.max(1, Math.ceil(text.length / MCP_CHUNK_CHARS));
      for (let index = 0; index < chunks; index++) kv.put(`${MCP_BUILD_KEY}:${index}`, text.slice(index * MCP_CHUNK_CHARS, (index + 1) * MCP_CHUNK_CHARS));
      kv.put(MCP_BUILD_KEY, { version: view.version, chunks });
      this.#registryWriter.install(this.#mcpExtension(view));
      this.#installHarness(kv.get<ResolvedHarness>(HARNESS_KEY) ?? resolveHarness(EMPTY_HARNESS));
      console.log(JSON.stringify({ t3flare: "mcp-view", version: view.version, servers: view.servers.map((server) => [server.name, server.tools.length, server.state]) }));
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "mcp-view-failed", error: String(error).slice(0, 300) }));
    }
  }

  /**
   * The Environment's harness settings at a turn's start: a new revision is kept and installed (applies to this turn's
   * next phase, never one under way). Bounded; on failure the Session keeps what it has. Never fails the turn.
   */
  async #takeHarness(): Promise<void> {
    try {
      const resolved = await Promise.race([
        environmentStub(this.env.ENVIRONMENT).harnessSettings({}),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HARNESS_READ_MS)),
      ]);
      if (resolved === undefined) return console.warn(JSON.stringify({ t3flare: "harness-settings-timeout" }));
      if (this.ctx.storage.kv.get<ResolvedHarness>(HARNESS_KEY)?.revision === resolved.revision) return;
      this.ctx.storage.kv.put(HARNESS_KEY, resolved);
      this.#installHarness(resolved);
      console.log(JSON.stringify({ t3flare: "harness-settings", revision: resolved.revision }));
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "harness-settings-failed", error: String(error).slice(0, 300) }));
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Storage helpers

  #meta(): Meta | undefined {
    return this.ctx.storage.kv.get<Meta>(META_KEY);
  }

  /** The turn the Session runs now (the asking turn of an approval or a question), or null. */
  #liveTurn(): string | null {
    return Object.entries(this.#turns()).find(([, turn]) => isLive(turn))?.[0] ?? null;
  }

  #turns(): Turns {
    return this.ctx.storage.kv.get<Turns>(TURNS_KEY) ?? {};
  }

  #saveTurns(turns: Turns) {
    this.ctx.storage.kv.put(TURNS_KEY, turns);
  }

  /** The turns with their model proxy records. */
  #turnsWithProxy(): Turns {
    const turns = this.#turns();
    const proxy = this.ctx.storage.kv.get<Record<string, ProxyRecord>>(PROXY_KEY) ?? {};
    return Object.fromEntries(Object.entries(turns).map(([id, turn]) => [id, proxy[id] === undefined ? turn : { ...turn, proxy: proxy[id] }]));
  }

  /** Updates the model proxy record of the turn running now: the live turn started first (a follow-up waits for it). */
  #noteProxy(update: (record: ProxyRecord) => ProxyRecord): void {
    const running = Object.entries(this.#turns())
      .filter(([, turn]) => isLive(turn))
      .sort(([, a], [, b]) => a.startedAt - b.startedAt)[0]?.[0];
    if (running === undefined) return;
    const proxy = this.ctx.storage.kv.get<Record<string, ProxyRecord>>(PROXY_KEY) ?? {};
    proxy[running] = update(proxy[running] ?? { requests: 0 });
    this.ctx.storage.kv.put(PROXY_KEY, proxy);
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
    return new ComputerExecutionEnv({
      workspace,
      id: `computer:${id}`,
      cwd: cwd ?? REPO_ROOT,
      reachContainer: true,
      containerEnv: COMMAND_ENV,
      ledger: {
        started: (execId) => this.#execs.started(execId),
        ended: (execId) => this.#execs.ended(execId),
        stopped: (execId) => {
          // Not awaited by the command's caller; a kill that does not finish is tried again from the alarm.
          void this.#execs
            .stopped(execId, KILL_BOUND_MS)
            .then(() => this.#arm())
            .catch(() => undefined);
        },
      },
    });
  }

  /** Kills the processes of `execIds` in the thread's Workspace Container (`WorkspaceDO.killExecs`). */
  async #killExecs(execIds: ReadonlyArray<string>): Promise<{ readonly survivors: number }> {
    const id = this.#meta()?.workspaceId;
    if (id === undefined || id === null) return { survivors: 0 };
    // SAFETY: the Workspace DO answers `killExecs` (WorkspaceDO.ts); a stub's RPC types only rewrite its declared type.
    const workspace = this.env.WORKSPACES.get(this.env.WORKSPACES.idFromName(id)) as unknown as {
      killExecs(ids: ReadonlyArray<string>): Promise<{ readonly running: boolean; readonly signalled: number; readonly survivors: number }>;
    };
    const answer = await workspace.killExecs(execIds);
    console.log(JSON.stringify({ t3flare: "kill-execs", count: execIds.length, ...answer }));
    return answer;
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
    if (this.#execs.retryDue()) candidates.push(now + KILL_RETRY_MS);
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
    if (this.#execs.retryDue()) await this.#execs.retry(KILL_BOUND_MS);
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
      interactionMode: interactionModeOf(input.interactionMode),
      linked: input.linked ?? null,
      epoch,
    } satisfies Meta);
    await this.#takeT3Mcp(input.t3Mcp);
    const root = await this.#root(input.model, input.thinking);
    // The agent works in its Workspace's repo (t3's `/w/<id>`), or nowhere without one.
    if (input.workspaceId !== null) await root.configure({ cwd: REPO_ROOT }, context);
    const turns = this.#turnsWithProxy();
    return { epoch, busy: Object.values(turns).some(isLive), turns };
  }

  async submitTurn(input: SubmitTurnInput): Promise<{ readonly submissionId: string }> {
    const existing = this.#turns()[input.providerTurnId];
    if (existing !== undefined) return { submissionId: existing.submissionId };
    const meta = this.#meta();
    if (meta !== undefined) {
      this.ctx.storage.kv.put(META_KEY, {
        ...meta,
        runtimeMode: input.runtimeMode,
        interactionMode: interactionModeOf(input.interactionMode),
        linked: input.linked ?? meta.linked ?? null,
      } satisfies Meta);
    }
    await this.#takeT3Mcp(input.t3Mcp);
    await this.#takeHarness();
    await this.#takeMcp();
    // A model the kept list lacks may be one the proxy has added since: read its list again (once a minute at most).
    if (this.#catalog.find(`${input.model.provider}/${input.model.modelId}`) === undefined) await this.#catalog.refresh({ force: true });
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
    else if (status === "placed") {
      await (await this.#root()).abort(context);
      // The run's calls are aborted: their commands' processes are killed before the Stop returns (bounded).
      await this.#execs.killAll(KILL_BOUND_MS);
      await this.#arm();
    }
    const turns = this.#turns();
    if (turns[providerTurnId] !== undefined && isLive(turns[providerTurnId]!)) {
      turns[providerTurnId] = { ...turns[providerTurnId]!, status: "aborted", reason, settledAt: Date.now() };
      this.#saveTurns(turns);
    }
    this.#dropAbandonedApprovals();
  }

  /** Answers a pending approval (the waiting call runs or returns the decline) or question (step 3: its answer is the result). */
  answer(input: AnswerInput): Promise<{ readonly applied: boolean }> {
    if (this.#mcpQuestions.has(input.requestId)) {
      const applied = this.#mcpQuestions.answer(input);
      // The decision only: an MCP form's answers are never logged or kept (SPI-1079).
      console.log(JSON.stringify({ t3flare: "mcp-question-answer", requestId: input.requestId, decision: input.decision, answered: input.answers !== undefined, applied }));
      return Promise.resolve({ applied });
    }
    if (this.#questions.pending().some((question) => question.requestId === input.requestId)) {
      const given = Object.values(input.answers ?? {}).map(answerText).find((text) => text !== undefined && text.trim() !== "");
      const text = given ?? (input.decision === "decline" || input.decision === "cancel" ? "(no answer: the owner dismissed the question)" : "(no answer)");
      const applied = this.#questions.answer(input.requestId, text);
      console.log(JSON.stringify({ t3flare: "question-answer", requestId: input.requestId, applied }));
      return Promise.resolve({ applied });
    }
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
    this.ctx.storage.kv.delete(PROXY_KEY);
    await (await this.#root()).abort(context);
    await this.#arm();
    return { dropped };
  }

  /** Counts of this object's starts and alarms (the approval-survives-restarts check, step 2a M3). */
  #noteDiagnostic(what: "constructed" | "alarms"): void {
    const diag = this.ctx.storage.kv.get<Record<string, number>>(DIAG_KEY) ?? {};
    this.ctx.storage.kv.put(DIAG_KEY, { ...diag, [what]: (diag[what] ?? 0) + 1, [`${what}At`]: Date.now() });
  }

  /** Step 3: the T3 tools offered and those left out (names only, never the credential). */
  t3Tools(): Promise<{ readonly tools: ReadonlyArray<string>; readonly left: ReadonlyArray<string>; readonly hash: string | null; readonly credential: boolean }> {
    const catalog = this.ctx.storage.kv.get<T3Catalog>(T3_CATALOG_KEY);
    return Promise.resolve({
      tools: (catalog?.tools ?? []).map((tool) => tool.name),
      left: catalog?.left ?? [],
      hash: catalog?.hash ?? null,
      credential: this.ctx.storage.kv.get(T3_MCP_KEY) !== undefined,
    });
  }

  diagnostics(): Promise<Readonly<Record<string, number>>> {
    return Promise.resolve(this.ctx.storage.kv.get<Record<string, number>>(DIAG_KEY) ?? {});
  }

  /**
   * A test's fault, on a stage only (`T3FLARE_FAULTS`): every model request is answered with `fixture` until `resetAt`,
   * in the proxy's place (`proxyLimits.ts`). Refused on prod.
   */
  proxyFault(input: { readonly fixture: string; readonly resetAt: number }): Promise<{ readonly armed: Fault }> {
    if (this.env.T3FLARE_FAULTS !== "1") return Promise.reject(new Error("t3flare: faults are off in this deployment"));
    const fixture = FAULT_FIXTURES.find((name) => name === input.fixture);
    if (fixture === undefined || !Number.isFinite(input.resetAt)) return Promise.reject(new Error(`t3flare: no fixture ${input.fixture}`));
    const armed: Fault = { fixture, resetAt: input.resetAt };
    this.ctx.storage.kv.put(FAULT_KEY, armed);
    return Promise.resolve({ armed });
  }

  /**
   * Step 2b (review F4): the Session of a deleted thread goes with its Workspace's purge: its live turns are aborted
   * (their commands' processes killed, bounded), then its alarm and storage, and the object restarts empty.
   */
  async destroy(): Promise<{ readonly destroyed: true }> {
    try {
      await this.abort({ all: true, reason: "workspace_deleted" } as AbortInput);
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "session-destroy-abort-failed", error: String(error).slice(0, 300) }));
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    setTimeout(() => this.ctx.abort("t3flare: session destroyed"), 0);
    return { destroyed: true };
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
    this.#questions.dropAbandoned(live);
    this.#mcpQuestions.dropAbandoned(live);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // State and pushes

  async #state(fromEntry: number | undefined, bound: number): Promise<SessionState & { readonly lastEntry: number | undefined }> {
    const root = await this.#root();
    const turns = this.#turnsWithProxy();
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
      approvals: [...this.#approvals.pending(), ...this.#mcpQuestions.approvals()],
      questions: [...this.#questions.pending(), ...this.#mcpQuestions.questions()],
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
