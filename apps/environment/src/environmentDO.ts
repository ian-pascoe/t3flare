// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off extendsNativeError:off cryptoRandomUUID:off
// The host is plain DO code around t3's Effect runtime, so it uses the platform's timers and errors.
// The Environment DO (ADR-0002): the host around t3's runtime. It boots t3 lazily (the 1 s startup
// limit), counts boots and falls back to safe mode (bootState.ts), seeds t3's bootstrap grant only while
// pairing is armed (ADR-0010), resets itself when idle and wakes on one alarm (ADR-0003), and answers the
// admin routes the Worker has already verified (admin.ts).
import type { CliPushAsk } from "./provider/cli/linkedPushAsk.ts";
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";

import { modelCatalog } from "@t3flare/models/catalog";
import type { McpRpcAnswer, McpRpcRequest, SessionPush, SessionPushAnswer } from "@t3flare/session-protocol";
import type { TerminalPush, TerminalPushAnswer } from "@t3flare/workspace-client";
import { type McpRelayAnswer, type McpRelayInput, resolveHarness, T3_RELAY_SERVER, type ResolvedHarness } from "@t3flare/harness-registry";

import { bindEnvironmentServices } from "./agents/bindings.ts";
import { GitHubTokens } from "./agents/github.ts";
import { deliverPush } from "./agents/sessionSink.ts";
import { GRACE_MS } from "./agents/deletionConstants.ts";
import { ProcessChannel } from "./agents/processChannel.ts";
import { locate, workspaceRpc } from "./agents/workspaceClient.ts";
import { workspaceRegistry } from "./agents/workspaces.ts";
import type { AgentsBindings } from "./agents/rpc.ts";
import * as BootState from "./host/bootState.ts";
import * as Idle from "./host/idle.ts";
import * as ModuleState from "./host/moduleState.ts";
import * as Pairing from "./host/pairing.ts";
import { isRefusedRelayRoute } from "./host/relayRoutes.ts";
import { bindStateStorage } from "./platform/stateStore.ts";
import type { HarnessCaller } from "./harness/panel.ts";
import { harnessSecrets } from "./harness/secrets.ts";
import { harnessStore } from "./harness/store.ts";
import { HarnessOAuth, type McpOAuthBinding, OAUTH_CALLBACK_PATH, OAUTH_CLIENT_PATH } from "./harness/oauth.ts";
import { type McpCallAnswer, McpHost, type McpEngineBinding, type McpView } from "./mcp/host.ts";
import { currentTerminals, resetTerminals } from "./terminal/current.ts";
import type { Runtime } from "./runtime.ts";

export interface EnvironmentEnv extends AgentsBindings {
  readonly T3_BOOTSTRAP_TOKEN?: string;
  /** The GitHub App (ADR-0013): only this Worker holds its key; the Environment DO mints every token. */
  readonly T3FLARE_GITHUB_APP_ID?: string;
  readonly T3FLARE_GITHUB_APP_PRIVATE_KEY?: string;
  /** The model proxy (ADR-0012), for text generation. */
  readonly MODEL_PROXY_URL?: string;
  readonly MODEL_PROXY_API_KEY?: string;
  /** Overrides IDLE_AFTER_MS (tests and the acceptance stage). */
  readonly T3FLARE_IDLE_AFTER_MS?: string;
  /** Step 2b: the sweep purges only when this is "1" (stages); prod's sweep reports what it would do (review F3). */
  readonly T3FLARE_SWEEP_PURGE?: string;
  /** Overrides the sweep's 7-day grace (stages). */
  readonly T3FLARE_SWEEP_GRACE_MS?: string;
  /**
   * Step 3+ (ADR-0025): "1" keeps the T3 Connect account token after the link (stages). Unset, as on prod, it is
   * discarded (owner decision D2).
   */
  readonly T3FLARE_CONNECT_KEEP_ACCOUNT_TOKEN?: string;
  /**
   * Step 3+ (review finding 6): "1" lets the stage's Access service token run the Connect mutations (stages). Unset,
   * as on prod, only the owner's own Access identity may.
   */
  readonly T3FLARE_CONNECT_SERVICE_TOKEN?: string;
  /** Test stages: the stage-only probes and faults answer (step 4a's process probe). */
  readonly T3FLARE_FAULTS?: string;
  /** The harness panel's admin host (ADR-0026): what a change's `Origin` must name. */
  readonly T3FLARE_HARNESS_HOST?: string;
  /** The MCP Worker's engine (ADR-0028): every MCP list and call goes through it. */
  readonly MCP_ENGINE?: McpEngineBinding;
  /** The MCP Worker's OAuth entrypoint (review M4, M5): every sign-in and refresh request is made there. */
  readonly MCP_OAUTH?: McpOAuthBinding;
  /** Commissary's MCP endpoint; default `${MODEL_PROXY_URL}/mcp`. */
  readonly COMMISSARY_TOOLS_URL?: string;
  /** `?toolkits=` narrowing of Commissary's tools. */
  readonly COMMISSARY_TOOLKITS?: string;
}

/** Module state that outlives `ctx.abort()` in a warm isolate (ADR-0003); reported by the health route. */
export const isolate = {
  /** When the first object was constructed here (workerd's clock reads 0 at global scope). */
  startedAt: 0,
  /** DO instances constructed in this isolate: more than one means resets reused a warm isolate. */
  constructions: 0,
  /** t3 boots in this isolate. */
  boots: 0,
};

// Before t3's modules evaluate (they load on the first request): the build's module-state registrations
// call this.
ModuleState.install();

const HOST_KEY = "t3flare/host";
export const DEFAULT_ARM_MINUTES = 15;

/**
 * The Commissary tools key (decision 1 of the tools step): the Workers' own proxy key for now, never the Containers'
 * (`COMMISSARY_CONTAINER_API_KEY`). One place, so a dedicated key can replace it.
 */
export const toolsKeyOf = (env: { readonly MODEL_PROXY_API_KEY?: string }): string | undefined => env.MODEL_PROXY_API_KEY;

export class SafeModeError extends Error {
  readonly safeMode: BootState.SafeMode;
  constructor(safeMode: BootState.SafeMode) {
    super(`t3flare: safe mode (${safeMode.reason ?? "unknown"})`);
    this.safeMode = safeMode;
  }
}

export interface BootReport {
  readonly at: string;
  readonly trigger: string;
  readonly wallMs: number;
  readonly bootstrapSeeded: boolean;
  readonly isolateBoot: number;
}

/** When the Workspace sweep is next due, and its last report (step 2b, plan section 5.5). */
const NEXT_SWEEP_KEY = "t3flare:next-sweep";
const LAST_SWEEP_KEY = "t3flare:last-sweep";
/** The deleted threads whose Sessions the sweep destroyed. */
const SWEPT_SESSIONS_KEY = "t3flare:swept-sessions";

/** Step 4a (review F6): this object's boot counter, the process channel's Environment epoch. */
const BOOT_COUNT_KEY = "t3flare:boot-count";

/** The proxy's model list, as the last read of it left it (ADR-0012). */
const CATALOG_KEY = "t3flare:model-catalog";

export class EnvironmentDO extends DurableObject<EnvironmentEnv> {
  #runtime: Promise<Runtime> | undefined;
  #host: string | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastBoot: BootReport | undefined;
  #constructedAt = Date.now();
  #github: GitHubTokens | undefined;
  /**
   * Step 3 (review C2): delegated tasks' questions a restart cut, raised again once t3 takes commands after this boot.
   * `/mcp` waits for it, so a linked environment following such a task never reads the cut run as its end.
   */
  #reraised: Promise<unknown> = Promise.resolve();
  /** Step 4a: this instance's CLI processes in the Workspaces' Containers. */
  readonly #processes: ProcessChannel;

  constructor(ctx: DurableObjectState, env: EnvironmentEnv) {
    super(ctx, env);
    isolate.constructions++;
    if (isolate.startedAt === 0) isolate.startedAt = Date.now();
    // Sockets and requests of a reset object are gone even if the isolate is not.
    Idle.activity.sockets = 0;
    Idle.activity.inFlight = 0;
    Idle.activity.idleSince = Date.now();
    Idle.activity.unreadableUntil = 0;
    // The sign-in's poll and the publishes the holds stood for went with the reset (step 3+).
    Idle.holds.clear();
    resetTerminals();
    // Before any t3 code runs: the `node:fs` shim and FileSystem Layer read this.
    bindStateStorage({ sql: ctx.storage.sql, transactionSync: (closure) => ctx.storage.transactionSync(closure) });
    const boot = (ctx.storage.kv.get<number>(BOOT_COUNT_KEY) ?? 0) + 1;
    ctx.storage.kv.put(BOOT_COUNT_KEY, boot);
    this.#processes = new ProcessChannel({
      environmentEpoch: boot,
      place: (cwd) => {
        const at = locate(cwd);
        if (at === undefined || at.record.state !== "ready") return undefined;
        // A fresh stub for every call: a stub to a Workspace DO that reset stays broken (its heartbeats would fail forever).
        const rpc = () => workspaceRpc(at.id);
        return {
          workspace: at.id,
          t3Path: `/w/${at.id}`,
          remote: {
            processStart: (input) => rpc().processStart(input),
            processInput: (key, seq, data) => rpc().processInput(key, seq, data),
            processTurn: (key, active) => rpc().processTurn(key, active),
            processSignal: (key) => rpc().processSignal(key),
            processHeartbeat: (keys) => rpc().processHeartbeat(keys),
            processRead: (input) => rpc().processRead(input),
          },
        };
      },
      newKey: () => `proc-${crypto.randomUUID()}`,
    });
    const modelProxy =
      env.MODEL_PROXY_URL && env.MODEL_PROXY_API_KEY ? { url: env.MODEL_PROXY_URL, apiKey: env.MODEL_PROXY_API_KEY } : undefined;
    bindEnvironmentServices({
      agents: env,
      modelProxy,
      catalog: modelCatalog({
        proxy: modelProxy,
        store: { read: () => ctx.storage.kv.get(CATALOG_KEY), write: (catalog) => ctx.storage.kv.put(CATALOG_KEY, catalog) },
      }),
      github: () => this.github,
      workspaces: workspaceRegistry(ctx.storage.sql),
      sql: ctx.storage.sql,
      sweep: {
        purge: env.T3FLARE_SWEEP_PURGE === "1",
        graceMs: Number(env.T3FLARE_SWEEP_GRACE_MS) > 0 ? Number(env.T3FLARE_SWEEP_GRACE_MS) : GRACE_MS,
      },
      marks: { has: (key) => ctx.storage.kv.get(key) !== undefined, set: (key) => ctx.storage.kv.put(key, Date.now()) },
      processes: this.#processes,
      faults: env.T3FLARE_FAULTS === "1",
      relayServers: (linked) =>
        Object.entries(this.mcpHost.servers())
          .filter(([, server]) => server.enabled && (!linked || server.linkedOffered))
          .map(([name]) => name)
          .sort(),
    });
  }

  get ctxStorage(): DurableObjectState["storage"] {
    return this.ctx.storage;
  }

  /** The agents Worker's Durable Objects (ADR-0014). */
  get agents(): AgentsBindings {
    return this.env;
  }

  /** The GitHub App's minter (ADR-0013, ADR-0018). */
  get github(): GitHubTokens {
    this.#github ??= new GitHubTokens({
      appId: this.env.T3FLARE_GITHUB_APP_ID,
      privateKey: this.env.T3FLARE_GITHUB_APP_PRIVATE_KEY,
    });
    return this.#github;
  }

  /**
   * A Session's committed state (ADR-0005), RPC from the agents Worker: boots t3 if it is not running (the Session is
   * the durable party, so its push wakes the Environment), waits until t3's startup recovery has run, then hands the
   * push to the adapter's open provider session for that thread (`sessionSink.ts`). Counted as a request for the idle
   * check (step 2a plan, section 3).
   */
  async sessionPush(push: SessionPush): Promise<SessionPushAnswer> {
    Idle.requestStarted();
    try {
      const runtime = await this.boot("session-push");
      await runtime.commandReady();
      return await deliverPush(push.sessionId, push);
    } finally {
      Idle.requestEnded();
    }
  }

  /**
   * A Session's call of t3's `/mcp` (step 3, plan section 4.2; ADR-0022), RPC from the agents Worker: t3's own HTTP app
   * answers it as it answers the public route, so t3's auth and tool access run unchanged, but nothing crosses the public
   * host. Boots t3 as a push does (review C7: the host is the one stored, never a made-up request's), waits for its
   * startup recovery, and counts as a request for the idle check while it is held (a long `t3_thread_wait`).
   */
  async mcp(input: McpRpcRequest): Promise<McpRpcAnswer> {
    Idle.requestStarted();
    try {
      const runtime = await this.boot("mcp");
      await runtime.commandReady();
      const host = await this.#publicHost();
      const response = await runtime.fetch(
        new Request(`https://${host}/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: input.authorization,
            ...(input.sessionId === undefined ? {} : { "mcp-session-id": input.sessionId }),
            ...(input.protocolVersion === undefined ? {} : { "mcp-protocol-version": input.protocolVersion }),
          },
          body: input.body,
        }),
      );
      const sessionId = response.headers.get("mcp-session-id") ?? undefined;
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        ...(sessionId === undefined ? {} : { sessionId }),
        body: await response.text(),
      };
    } finally {
      Idle.requestEnded();
    }
  }

  /**
   * RPC from the agents Worker, M0's check of the binding back. Counted as a request for the idle check, as every call
   * from the agents Worker is (step 2a plan, section 3).
   */
  async agentsPing(message: string): Promise<{ readonly environment: string; readonly message: string }> {
    Idle.requestStarted();
    try {
      return { environment: this.ctx.id.toString(), message };
    } finally {
      Idle.requestEnded();
    }
  }

  /**
   * RPC from a Workspace DO: a token for its one repo (ADR-0013; SPI-992), with the repo and its expiry. `read`: the
   * Container token, for the git credential helper there (code read-only). `push`: the push gateway's (`contents:
   * write`; `workflows` only when the Workspace is opted in), which never reaches a Container. Null for a Workspace the
   * registry does not list or without a GitHub remote. Counted as a request for the idle check.
   */
  async workspaceToken(id: string, options: { readonly purpose: "read" | "push" }): Promise<{ readonly token: string | null; readonly expiresAt?: number; readonly repo?: { readonly owner: string; readonly name: string } }> {
    Idle.requestStarted();
    try {
      const { workspaceGitHubToken } = await import("./agents/processRouter.ts");
      const minted = await workspaceGitHubToken(id, options.purpose === "push" ? "push" : "read");
      return minted === null ? { token: null } : minted;
    } finally {
      Idle.requestEnded();
    }
  }

  /**
   * RPC from a Workspace DO (the push gateway's policy): asks the owner about a push on a CLI thread's live turn
   * (SPI-1040). Counted as open work for the idle check while it waits (review M7).
   */
  async approvePush(input: { readonly thread: string; readonly workspace: string; readonly linked: boolean; readonly askId: string; readonly summary: string; readonly detail: string; readonly options?: CliPushAsk["options"] }): Promise<{ readonly approved: boolean; readonly trust?: boolean; readonly reason?: string }> {
    Idle.requestStarted();
    try {
      const { approveCliPush } = await import("./provider/cli/linkedPushAsk.ts");
      return await approveCliPush({ ...input, options: input.options ?? [] });
    } finally {
      Idle.requestEnded();
    }
  }

  /** RPC from a Workspace DO: the push's git went away (review M7); the card `approvePush` raised is withdrawn. */
  async cancelPush(input: { readonly askId: string }): Promise<void> {
    const { cancelCliPush } = await import("./provider/cli/linkedPushAsk.ts");
    cancelCliPush(input.askId);
  }

  /**
   * A Workspace DO's terminal output (step 2b, ADR-0021), RPC from the agents Worker. Never boots t3 and is not counted
   * as activity (ADR-0003's refinement): a chatty shell with no client cannot keep the Environment awake. Answers the
   * terminals this instance does not know (t3 not running, restarted, or the terminal closed): the Workspace DO kills
   * them.
   */
  async terminalOutput(push: TerminalPush): Promise<TerminalPushAnswer> {
    const terminals = currentTerminals();
    if (terminals === undefined) return { unknown: [...new Set(push.frames.filter((frame) => frame.exit === undefined).map((frame) => frame.key))] };
    return terminals.deliver(push);
  }

  /**
   * The harness panel (ADR-0026), RPC from the Worker's `HarnessAdmin` entrypoint only, after it verified Access on the
   * admin host. Never boots t3. Not reachable through `fetch` (the t3 host never serves the panel).
   */
  async harness(request: Request, caller: HarnessCaller): Promise<Response> {
    const { handleHarness } = await import("./harness/panel.ts");
    return handleHarness(request, { caller, host: this.env.T3FLARE_HARNESS_HOST ?? "", store: harnessStore(this.ctx.storage.kv), mcp: this.mcpHost, secrets: harnessSecrets(this.ctx.storage.kv), oauth: this.harnessOAuth });
  }

  /**
   * The admin host's public paths (review M4: the OAuth callback and the client metadata document, under an Access
   * Bypass application), RPC from `HarnessAdmin` only. Nothing else is answered here.
   */
  async harnessPublic(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method not allowed\n", { status: 405 });
    if (url.pathname === OAUTH_CLIENT_PATH) return this.harnessOAuth.clientDocument();
    if (url.pathname === OAUTH_CALLBACK_PATH) return this.harnessOAuth.callback(url);
    return new Response("Not found\n", { status: 404 });
  }

  #harnessOAuth: HarnessOAuth | undefined;
  get harnessOAuth(): HarnessOAuth {
    const store = harnessStore(this.ctx.storage.kv);
    this.#harnessOAuth ??= new HarnessOAuth({
      kv: this.ctx.storage.kv,
      secrets: harnessSecrets(this.ctx.storage.kv),
      engine: this.env.MCP_OAUTH,
      host: this.env.T3FLARE_HARNESS_HOST ?? "",
      audit: (entry) => store.audit({ at: Date.now(), caller: "oauth", ...entry }),
    });
    return this.#harnessOAuth;
  }

  /** The MCP host (ADR-0028), over this object's storage and the MCP Worker's engine. */
  #mcpHost: McpHost | undefined;
  get mcpHost(): McpHost {
    this.#mcpHost ??= new McpHost({
      kv: this.ctx.storage.kv,
      engine: this.env.MCP_ENGINE,
      commissary: {
        url: this.env.COMMISSARY_TOOLS_URL ?? (this.env.MODEL_PROXY_URL === undefined ? undefined : `${this.env.MODEL_PROXY_URL.replace(/\/+$/, "")}/mcp`),
        key: toolsKeyOf(this.env),
        ...(this.env.COMMISSARY_TOOLKITS === undefined ? {} : { toolkits: this.env.COMMISSARY_TOOLKITS }),
      },
      settings: () => harnessStore(this.ctx.storage.kv).load(),
      secret: async (server, field) => harnessSecrets(this.ctx.storage.kv).read(server, field),
      oauthToken: (server, stale) => this.harnessOAuth.accessToken(server, stale),
      background: (work) => this.ctx.waitUntil(work),
    });
    return this.#mcpHost;
  }

  /**
   * The MCP servers' secrets, for the leak checks only (`/_t3flare/check/peer-leak`, which answers names, never values):
   * each direct server's header value, OAuth access and refresh tokens and registered client secret.
   */
  mcpLeakSecrets(): Array<{ readonly name: string; readonly value: string }> {
    const secrets = harnessSecrets(this.ctx.storage.kv);
    const found: Array<{ name: string; value: string }> = [];
    const parsed = (text: string | undefined): Record<string, unknown> => {
      try {
        return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        return {};
      }
    };
    for (const server of Object.keys(this.mcpHost.servers())) {
      const header = secrets.read(server, "header");
      if (header !== undefined) found.push({ name: `mcp-header:${server}`, value: header });
      const tokens = parsed(secrets.read(server, "oauth-tokens"));
      for (const field of ["access", "refresh"]) if (typeof tokens[field] === "string") found.push({ name: `mcp-oauth-${field}:${server}`, value: tokens[field] });
      const client = parsed(secrets.read(server, "oauth-client"));
      if (typeof client.client_secret === "string") found.push({ name: `mcp-oauth-client-secret:${server}`, value: client.client_secret });
    }
    return found;
  }

  /** The MCP tools a Session may install (ADR-0028), from kept inventories. Never boots t3. */
  async mcpView(input: { readonly linked: boolean }): Promise<McpView> {
    return this.mcpHost.view(input);
  }

  /** A Session's MCP call, already judged by `decideCall` in its tool. Open work while it runs (the idle reset waits). */
  async mcpCall(input: {
    readonly server: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly linked: boolean;
    readonly judged?: "read" | "write";
  }): Promise<McpCallAnswer> {
    Idle.requestStarted();
    try {
      return await this.mcpHost.call(input);
    } finally {
      Idle.requestEnded();
    }
  }

  /** The CLI relay's "accept for the session" answers, by thread (memory: a restart asks again). */
  readonly #relayAccepted = new Map<string, Set<string>>();
  /** The relay's MCP sessions with t3's `/mcp`, by t3's credential (memory). */
  readonly #t3RelaySessions = new Map<string, { sessionId?: string; tools?: ReadonlyArray<{ readonly name: string }>; listedAt?: number; nextId?: number }>();

  /**
   * RPC from a Workspace DO: one MCP message of a CLI process through the relay (ADR-0028), its caller resolved from
   * the process's tool handle. Open work while it runs (a held call keeps the idle reset away, review M9).
   */
  async mcpRelay(input: McpRelayInput): Promise<McpRelayAnswer> {
    Idle.requestStarted();
    try {
      const [{ relayMessage }, { relayT3Message }, { approveCliTool, cliThreadStates }, { t3CredentialOf }] = await Promise.all([
        import("./mcp/relay.ts"),
        import("./mcp/t3Relay.ts"),
        import("./provider/cli/linkedPushAsk.ts"),
        import("./provider/cli/relayedMcp.ts"),
      ]);
      const accepted = this.#relayAccepted;
      const shared = {
        states: cliThreadStates,
        ask: approveCliTool,
        accepted: {
          has: (thread: string, key: string) => accepted.get(thread)?.has(key) === true,
          add: (thread: string, key: string) => {
            const set = accepted.get(thread) ?? new Set<string>();
            set.add(key);
            accepted.set(thread, set);
          },
        },
        log: (event: Record<string, unknown>) => console.log(JSON.stringify(event)),
      };
      if (input.server === T3_RELAY_SERVER) {
        return await relayT3Message(input, { ...shared, post: (request) => this.mcp(request), credential: t3CredentialOf, cache: this.#t3RelaySessions, now: () => Date.now() });
      }
      return await relayMessage(input, { ...shared, view: (view) => this.mcpHost.view(view), call: (call) => this.mcpHost.call(call) });
    } finally {
      Idle.requestEnded();
    }
  }

  /** The harness settings for a Session's turn (ADR-0026), resolved and secret-free. Never boots t3. */
  async harnessSettings(input: { readonly projectId?: string }): Promise<ResolvedHarness> {
    const store = harnessStore(this.ctx.storage.kv);
    const stored = store.load();
    store.noteRead(stored.revision, Date.now());
    return resolveHarness(stored, input);
  }

  /** Diagnosis and the reboot check: this instance's channel. */
  get processChannel(): ProcessChannel {
    return this.#processes;
  }

  /** Resets the object, as an eviction or deploy does: memory and sockets go, storage stays. */
  abort(reason: string): void {
    this.ctx.abort(reason);
  }

  /** Step 3+ (review finding 6): whether the stage's service token may run the Connect mutations (never on prod). */
  get connectServiceTokenAllowed(): boolean {
    return this.env.T3FLARE_CONNECT_SERVICE_TOKEN === "1";
  }

  get runtimeIfBooted(): Promise<Runtime> | undefined {
    return this.#runtime;
  }

  get lastBoot(): BootReport | undefined {
    return this.#lastBoot;
  }

  get constructedAt(): number {
    return this.#constructedAt;
  }

  armedUntil(): Promise<Date | null> {
    return Pairing.armedUntil(this.ctx.storage);
  }

  isArmed(now = new Date()): Promise<boolean> {
    return Pairing.isArmed(this.ctx.storage, now);
  }

  async #publicHost(request?: Request): Promise<string> {
    if (request !== undefined) {
      const host = new URL(request.url).host;
      if (host !== this.#host) {
        this.#host = host;
        await this.ctx.storage.put(HOST_KEY, host);
      }
    }
    this.#host ??= (await this.ctx.storage.get<string>(HOST_KEY)) ?? "t3flare.invalid";
    return this.#host;
  }

  /** Boots t3 if it is not running. Throws SafeModeError in safe mode. */
  boot(trigger: string, request?: Request): Promise<Runtime> {
    this.#runtime ??= this.#startRuntime(trigger, request).catch((error) => {
      this.#runtime = undefined;
      throw error;
    });
    return this.#runtime;
  }

  async #startRuntime(trigger: string, request?: Request): Promise<Runtime> {
    const kv = this.ctx.storage;
    const decision = await BootState.beginBoot(kv, new Date());
    if (!decision.start) {
      console.log(JSON.stringify({ t3flare: "safe-mode", ...decision.safeMode }));
      throw new SafeModeError(decision.safeMode);
    }
    const started = Date.now();
    try {
      if (await BootState.takeInjectedFailure(kv)) throw new Error("t3flare: injected boot failure (admin fault route)");
      const host = await this.#publicHost(request);
      const armed = await this.isArmed();
      const { boot } = await import("./runtime.ts");
      const runtime = await boot({
        storage: this.ctx.storage,
        bootstrapToken: armed ? this.env.T3_BOOTSTRAP_TOKEN : undefined,
        host,
        connect: { keepAccountToken: this.env.T3FLARE_CONNECT_KEEP_ACCOUNT_TOKEN === "1" },
      });
      await BootState.bootSucceeded(kv, new Date());
      isolate.boots++;
      Idle.activity.idleSince = Date.now();
      this.#lastBoot = {
        at: new Date(started).toISOString(),
        trigger,
        wallMs: Date.now() - started,
        bootstrapSeeded: runtime.bootstrapSeeded,
        isolateBoot: isolate.boots,
      };
      console.log(JSON.stringify({ t3flare: "booted", ...this.#lastBoot, constructions: isolate.constructions }));
      this.#startIdleChecks();
      this.#reraised = runtime
        .commandReady()
        .then(async () => {
          const { reraiseQuestionsAfterRestart } = await import("./agents/questionRestart.ts");
          const raised = await runtime.run(reraiseQuestionsAfterRestart);
          if (raised > 0) console.log(JSON.stringify({ t3flare: "questions-raised-again", count: raised }));
        })
        .catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "questions-reraise-failed", error: String(error).slice(0, 300) })));
      // Step 3+ (review finding 4): once the questions are raised again, what the phone last heard of each live thread
      // is published again as it is now (a tombstone for a run the restart cancelled).
      void this.#reraised
        .then(async () => {
          const [{ Connect }, Effect] = await Promise.all([import("./connect/service.ts"), import("effect/Effect")]);
          const republished = await runtime.run(Effect.flatMap(Connect, (connect) => connect.republishLastLive));
          if (republished.length > 0) console.log(JSON.stringify({ t3flare: "connect-republished", count: republished.length }));
        })
        .catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "connect-republish-failed", error: String(error).slice(0, 300) })));
      if (runtime.bootstrapSeeded) await Pairing.keepWindowClosing(this.ctx.storage);
      return runtime;
    } catch (error) {
      await BootState.bootFailed(kv, error);
      console.error(JSON.stringify({ t3flare: "boot-failed", trigger, error: String(error).slice(0, 2000) }));
      throw error;
    }
  }

  /** Disposes t3's runtime in place: same object, same isolate. The next request or `boot` starts it again. */
  async stopRuntime(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#stopIdleChecks();
    if (runtime === undefined) return;
    try {
      await (await runtime).dispose();
    } catch {
      // A runtime that failed to boot has nothing to dispose.
    }
  }

  /** Restarts t3 in place, so a change to what boot seeds (arming pairing) takes effect. */
  async restartRuntime(trigger: string): Promise<Runtime> {
    await this.stopRuntime();
    return this.boot(trigger);
  }

  async arm(minutes: number): Promise<Date> {
    // Arming restarts t3 in place, which would end a T3 Connect sign-in's poll (step 3+, review finding 4).
    if (Idle.activeHolds(Date.now()).includes(Idle.CONNECT_SIGN_IN_HOLD)) throw new Error("t3flare: a T3 Connect sign-in is pending; arm after it ends");
    const until = await Pairing.arm(this.ctx.storage, minutes, new Date());
    const runtime = this.#runtime === undefined ? undefined : await this.#runtime.catch(() => undefined);
    if (runtime !== undefined && !runtime.bootstrapSeeded) await this.restartRuntime("arm-bootstrap");
    else if (runtime !== undefined) await Pairing.keepWindowClosing(this.ctx.storage);
    return until;
  }

  async disarm(): Promise<void> {
    await Pairing.disarm(this.ctx.storage);
    const runtime = this.#runtime === undefined ? undefined : await this.#runtime.catch(() => undefined);
    if (runtime?.bootstrapSeeded) await this.restartRuntime("disarm-bootstrap");
  }

  #idleAfterMs(): number {
    const value = Number(this.env.T3FLARE_IDLE_AFTER_MS);
    return Number.isFinite(value) && value > 0 ? value : Idle.IDLE_AFTER_MS;
  }

  #startIdleChecks() {
    if (this.#idleTimer !== undefined) return;
    const every = Math.min(Idle.IDLE_CHECK_EVERY_MS, Math.max(1000, Math.floor(this.#idleAfterMs() / 4)));
    this.#idleTimer = setInterval(() => {
      void this.checkIdle().catch((error) => console.error(JSON.stringify({ t3flare: "idle-check-failed", error: String(error) })));
    }, every);
  }

  #stopIdleChecks() {
    if (this.#idleTimer !== undefined) clearInterval(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #sweeping: Promise<unknown> | undefined;

  /** When the sweep is next due (the first is an hour after the first look). */
  #nextSweep(now = Date.now()): number {
    const stored = this.ctx.storage.kv.get<number>(NEXT_SWEEP_KEY);
    if (stored !== undefined) return stored;
    this.ctx.storage.kv.put(NEXT_SWEEP_KEY, now + 60 * 60_000);
    return now + 60 * 60_000;
  }

  /** Runs the Workspace sweep (step 2b); `dry` only reports. Never boots t3: it reads t3's tables directly. */
  async runSweep(options: { readonly dry: boolean }): Promise<unknown> {
    const { sweep } = await import("./agents/deletion.ts");
    const { environmentServices } = await import("./agents/bindings.ts");
    const swept = new Set(this.ctx.storage.kv.get<ReadonlyArray<string>>(SWEPT_SESSIONS_KEY) ?? []);
    const report = await sweep(this.ctx.storage.sql, { ...environmentServices().sweep, dry: options.dry }, Date.now(), {
      has: (threadId) => swept.has(threadId),
      add: (threadId) => void swept.add(threadId),
    });
    if (!options.dry) this.ctx.storage.kv.put(SWEPT_SESSIONS_KEY, [...swept].slice(-5000));
    if (!options.dry) {
      this.ctx.storage.kv.put(LAST_SWEEP_KEY, report);
      this.ctx.storage.kv.put(NEXT_SWEEP_KEY, Date.parse(report.nextDue));
      await this.#armSweep();
    }
    return report;
  }

  get lastSweep(): unknown {
    return this.ctx.storage.kv.get(LAST_SWEEP_KEY) ?? null;
  }

  async #sweepIfDue(now = Date.now()): Promise<void> {
    if (now < this.#nextSweep(now) || this.#sweeping !== undefined) return;
    this.#sweeping = this.runSweep({ dry: false })
      .catch((error: unknown) => console.error(JSON.stringify({ t3flare: "sweep-failed", error: String(error).slice(0, 500) })))
      .finally(() => (this.#sweeping = undefined));
    await this.#sweeping;
  }

  /** The one alarm also wakes the sweep (ADR-0003's refinement). */
  async #armSweep(): Promise<void> {
    const at = this.#nextSweep();
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
  }

  /**
   * ADR-0003: when idle, set one alarm for t3's next due work and reset the object. Returns what it found
   * (for the admin route) and resets only when `reset` is true.
   */
  async checkIdle(options: { readonly force?: boolean } = {}): Promise<Idle.IdleVerdict & { alarm?: string | null }> {
    if (this.#runtime === undefined) return { reset: false, why: "t3 is not running" };
    void this.#sweepIfDue().catch(() => undefined);
    const now = new Date();
    // A forced check (the admin route) reads t3's tables again even while backing off.
    if (options.force) Idle.activity.unreadableUntil = 0;
    const verdict = Idle.idleVerdict(this.ctx.storage.sql, now, options.force ? 0 : this.#idleAfterMs());
    if (!verdict.reset) {
      // Fail safe (fragility U2): the Environment stays up. Logged once per back-off, as an error.
      if (verdict.unreadable !== undefined) {
        console.error(
          JSON.stringify({ t3flare: "idle-check-unreadable", error: verdict.unreadable, retryAfter: new Date(Idle.activity.unreadableUntil).toISOString() }),
        );
      }
      return verdict;
    }
    // A pending arm window needs no alarm: the next boot reads it, and seeds the grant only if still armed.
    // The sweep's due time joins t3's (step 2b).
    const due = Math.min(verdict.due.at?.getTime() ?? Number.POSITIVE_INFINITY, this.#nextSweep(now.getTime()));
    await this.ctx.storage.setAlarm(Math.max(due, now.getTime() + 1000));
    // `ctx.abort()` discards writes not yet durable: on production the alarm was lost without this.
    await this.ctx.storage.sync();
    const stored = await this.ctx.storage.getAlarm();
    const alarm = stored === null ? null : new Date(stored).toISOString();
    console.log(JSON.stringify({ t3flare: "idle-reset", alarm, work: verdict.work, sources: verdict.due.sources }));
    this.#stopIdleChecks();
    // Reset outside this call, so the caller's I/O completes first.
    setTimeout(() => this.ctx.abort("t3flare: idle reset"), 0);
    return { ...verdict, alarm };
  }

  override async alarm(): Promise<void> {
    const runtime = this.#runtime === undefined ? undefined : await this.#runtime.catch(() => undefined);
    // An earlier alarm may have displaced the window's close: onAlarm sets it again while the window is open.
    if ((await Pairing.onAlarm(this.ctx.storage, { seeded: runtime?.bootstrapSeeded ?? false }, new Date())) === "close-window") {
      console.log(JSON.stringify({ t3flare: "bootstrap-disarmed", action: "restart-in-place" }));
      await this.restartRuntime("bootstrap-window-closed");
      return;
    }
    await this.#sweepIfDue().catch(() => undefined);
    if (runtime === undefined) {
      // A wake for the sweep alone does not boot t3: it is armed again for t3's own due work, if any.
      // If t3's tables cannot be read, the due work is unknown: boot t3 rather than miss a wake (fragility U2).
      let due: Date | null;
      try {
        due = Idle.nextDue(this.ctx.storage.sql).at;
      } catch (error) {
        if (!(error instanceof Idle.UnreadableTables)) throw error;
        console.error(JSON.stringify({ t3flare: "alarm-due-unreadable", error: error.message }));
        due = new Date(0);
      }
      if (due === null || due.getTime() > Date.now() + 1000) {
        const at = Math.min(due?.getTime() ?? Number.POSITIVE_INFINITY, this.#nextSweep());
        await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
        return;
      }
      console.log(JSON.stringify({ t3flare: "alarm-wake" }));
      try {
        await this.boot("alarm");
      } catch (error) {
        // Safe mode or a failed boot: the alarm is not retried; the owner sees it in the health route.
        console.error(JSON.stringify({ t3flare: "alarm-wake-failed", error: String(error) }));
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_t3flare/")) {
      // The Worker verified the caller (access.ts) before forwarding.
      const { handleAdmin } = await import("./host/admin.ts");
      return handleAdmin(request, this);
    }
    // Step 3+ (plan section 5, review finding 1): T3 Connect's relay-initiated routes are not served, for any method,
    // before t3 boots. t3's own app refuses them too (connect/service.ts).
    if (isRefusedRelayRoute(url.pathname)) return new Response("Not found\n", { status: 404 });
    Idle.requestStarted();
    try {
      if (Pairing.BOOTSTRAP_EXCHANGE_PATHS.has(url.pathname) && request.method === "POST") {
        const refused = await this.#refuseDisarmedBootstrap(request);
        if (refused !== undefined) return refused;
      }
      const runtime = await this.boot("request", request);
      if (url.pathname === "/mcp") await this.#reraised;
      return await runtime.fetch(request);
    } catch (error) {
      if (error instanceof SafeModeError) {
        return Response.json({ t3flare: "safe-mode", ...error.safeMode }, { status: 503, headers: { "retry-after": "60" } });
      }
      console.error(JSON.stringify({ t3flare: "request-failed", path: url.pathname, error: String(error).slice(0, 2000) }));
      return new Response("t3flare: the Environment failed to start; see the admin health route.\n", { status: 500 });
    } finally {
      Idle.requestEnded();
    }
  }

  /**
   * Belt and braces for ADR-0010: outside the armed window, an exchange that presents the bootstrap token is
   * refused here, even if a grant seeded during the window is still in t3's memory.
   */
  async #refuseDisarmedBootstrap(request: Request): Promise<Response | undefined> {
    const token = this.env.T3_BOOTSTRAP_TOKEN;
    if (!token || (await this.isArmed())) return undefined;
    if (!Pairing.presentsBootstrapToken(await request.clone().text(), token)) return undefined;
    console.log(JSON.stringify({ t3flare: "bootstrap-refused", reason: "pairing is not armed" }));
    return Response.json({ error: "pairing is not armed" }, { status: 401 });
  }
}
