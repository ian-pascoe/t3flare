// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off extendsNativeError:off
// The host is plain DO code around t3's Effect runtime, so it uses the platform's timers and errors.
// The Environment DO (ADR-0002): the host around t3's runtime. It boots t3 lazily (the 1 s startup
// limit), counts boots and falls back to safe mode (bootState.ts), seeds t3's bootstrap grant only while
// pairing is armed (ADR-0010), resets itself when idle and wakes on one alarm (ADR-0003), and answers the
// admin routes the Worker has already verified (admin.ts).
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";

import { modelCatalog } from "@t3flare/models/catalog";
import type { SessionPush, SessionPushAnswer } from "@t3flare/session-protocol";
import type { TerminalPush, TerminalPushAnswer } from "@t3flare/workspace-client";

import { bindEnvironmentServices } from "./agents/bindings.ts";
import { GitHubTokens } from "./agents/github.ts";
import { deliverPush } from "./agents/sessionSink.ts";
import { GRACE_MS } from "./agents/deletionConstants.ts";
import { workspaceRegistry } from "./agents/workspaces.ts";
import type { AgentsBindings } from "./agents/rpc.ts";
import * as BootState from "./host/bootState.ts";
import * as Idle from "./host/idle.ts";
import * as ModuleState from "./host/moduleState.ts";
import * as Pairing from "./host/pairing.ts";
import { bindStateStorage } from "./platform/stateStore.ts";
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

/** The proxy's model list, as the last read of it left it (ADR-0012). */
const CATALOG_KEY = "t3flare:model-catalog";

export class EnvironmentDO extends DurableObject<EnvironmentEnv> {
  #runtime: Promise<Runtime> | undefined;
  #host: string | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastBoot: BootReport | undefined;
  #constructedAt = Date.now();
  #github: GitHubTokens | undefined;

  constructor(ctx: DurableObjectState, env: EnvironmentEnv) {
    super(ctx, env);
    isolate.constructions++;
    if (isolate.startedAt === 0) isolate.startedAt = Date.now();
    // Sockets and requests of a reset object are gone even if the isolate is not.
    Idle.activity.sockets = 0;
    Idle.activity.inFlight = 0;
    Idle.activity.idleSince = Date.now();
    resetTerminals();
    // Before any t3 code runs: the `node:fs` shim and FileSystem Layer read this.
    bindStateStorage({ sql: ctx.storage.sql, transactionSync: (closure) => ctx.storage.transactionSync(closure) });
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
   * RPC from a Workspace DO: its repo's Container token, for the git credential helper in its Container (ADR-0013;
   * the agent's own `git push`/`fetch`). One repo; `workflows` only when the Workspace is opted in. Null for a
   * Workspace the registry does not list or without a GitHub remote. Counted as a request for the idle check.
   */
  async workspaceToken(id: string): Promise<{ readonly token: string | null }> {
    Idle.requestStarted();
    try {
      const { containerToken } = await import("./agents/processRouter.ts");
      return { token: await containerToken(id) };
    } finally {
      Idle.requestEnded();
    }
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

  /** Resets the object, as an eviction or deploy does: memory and sockets go, storage stays. */
  abort(reason: string): void {
    this.ctx.abort(reason);
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
    const verdict = Idle.idleVerdict(this.ctx.storage.sql, now, options.force ? 0 : this.#idleAfterMs());
    if (!verdict.reset) return verdict;
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
      const due = Idle.nextDue(this.ctx.storage.sql).at;
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
    Idle.requestStarted();
    try {
      if (Pairing.BOOTSTRAP_EXCHANGE_PATHS.has(url.pathname) && request.method === "POST") {
        const refused = await this.#refuseDisarmedBootstrap(request);
        if (refused !== undefined) return refused;
      }
      const runtime = await this.boot("request", request);
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
