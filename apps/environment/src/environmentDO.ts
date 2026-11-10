// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off extendsNativeError:off
// The host is plain DO code around t3's Effect runtime, so it uses the platform's timers and errors.
// The Environment DO (ADR-0002): the host around t3's runtime. It boots t3 lazily (the 1 s startup
// limit), counts boots and falls back to safe mode (bootState.ts), seeds t3's bootstrap grant only while
// pairing is armed (ADR-0010), resets itself when idle and wakes on one alarm (ADR-0003), and answers the
// admin routes the Worker has already verified (admin.ts).
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";

import * as BootState from "./host/bootState.ts";
import * as Idle from "./host/idle.ts";
import * as ModuleState from "./host/moduleState.ts";
import { bindStateStorage } from "./platform/stateStore.ts";
import type { Runtime } from "./runtime.ts";

export interface EnvironmentEnv {
  readonly T3_BOOTSTRAP_TOKEN?: string;
  /** Overrides IDLE_AFTER_MS (tests and the acceptance stage). */
  readonly T3FLARE_IDLE_AFTER_MS?: string;
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

const ARMED_UNTIL_KEY = "t3flare/bootstrap/armed-until";
const HOST_KEY = "t3flare/host";
/** The longest an admin may arm pairing for. */
export const MAX_ARM_MINUTES = 60;
export const DEFAULT_ARM_MINUTES = 15;

/** The routes that exchange a bootstrap credential for a session. */
const BOOTSTRAP_EXCHANGE_PATHS = new Set(["/api/auth/browser-session", "/oauth/token"]);

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

export class EnvironmentDO extends DurableObject<EnvironmentEnv> {
  #runtime: Promise<Runtime> | undefined;
  #host: string | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastBoot: BootReport | undefined;
  #constructedAt = Date.now();

  constructor(ctx: DurableObjectState, env: EnvironmentEnv) {
    super(ctx, env);
    isolate.constructions++;
    if (isolate.startedAt === 0) isolate.startedAt = Date.now();
    // Sockets and requests of a reset object are gone even if the isolate is not.
    Idle.activity.sockets = 0;
    Idle.activity.inFlight = 0;
    Idle.activity.idleSince = Date.now();
    // Before any t3 code runs: the `node:fs` shim and FileSystem Layer read this.
    bindStateStorage({ sql: ctx.storage.sql, transactionSync: (closure) => ctx.storage.transactionSync(closure) });
  }

  get ctxStorage(): DurableObjectState["storage"] {
    return this.ctx.storage;
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

  async armedUntil(): Promise<Date | null> {
    const value = await this.ctx.storage.get<string>(ARMED_UNTIL_KEY);
    return value === undefined ? null : new Date(value);
  }

  async isArmed(now = new Date()): Promise<boolean> {
    const until = await this.armedUntil();
    return until !== null && until.getTime() > now.getTime();
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
      if (runtime.bootstrapSeeded) await this.#scheduleArmExpiry();
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
    const until = new Date(Date.now() + Math.min(Math.max(minutes, 1), MAX_ARM_MINUTES) * 60_000);
    await this.ctx.storage.put(ARMED_UNTIL_KEY, until.toISOString());
    const runtime = this.#runtime === undefined ? undefined : await this.#runtime.catch(() => undefined);
    if (runtime !== undefined && !runtime.bootstrapSeeded) await this.restartRuntime("arm-bootstrap");
    else if (runtime !== undefined) await this.#scheduleArmExpiry();
    return until;
  }

  async disarm(): Promise<void> {
    await this.ctx.storage.delete(ARMED_UNTIL_KEY);
    const runtime = this.#runtime === undefined ? undefined : await this.#runtime.catch(() => undefined);
    if (runtime?.bootstrapSeeded) await this.restartRuntime("disarm-bootstrap");
  }

  /** While t3 holds a seeded grant, the alarm fires when pairing disarms, so t3 restarts without it. */
  async #scheduleArmExpiry() {
    const until = await this.armedUntil();
    if (until === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > until.getTime()) await this.ctx.storage.setAlarm(until.getTime());
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

  /**
   * ADR-0003: when idle, set one alarm for t3's next due work and reset the object. Returns what it found
   * (for the admin route) and resets only when `reset` is true.
   */
  async checkIdle(options: { readonly force?: boolean } = {}): Promise<Idle.IdleVerdict & { alarm?: string | null }> {
    if (this.#runtime === undefined) return { reset: false, why: "t3 is not running" };
    const now = new Date();
    const verdict = Idle.idleVerdict(this.ctx.storage.sql, now, options.force ? 0 : this.#idleAfterMs());
    if (!verdict.reset) return verdict;
    // A pending arm window needs no alarm: the next boot reads it, and seeds the grant only if still armed.
    const due = verdict.due.at;
    if (due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(due.getTime(), now.getTime() + 1000));
    const alarm = due === null ? null : new Date(Math.max(due.getTime(), now.getTime() + 1000)).toISOString();
    console.log(JSON.stringify({ t3flare: "idle-reset", alarm, work: verdict.work, sources: verdict.due.sources }));
    this.#stopIdleChecks();
    // Reset outside this call, so the caller's I/O completes first.
    setTimeout(() => this.ctx.abort("t3flare: idle reset"), 0);
    return { ...verdict, alarm };
  }

  override async alarm(): Promise<void> {
    const runtime = this.#runtime === undefined ? undefined : await this.#runtime.catch(() => undefined);
    if (runtime?.bootstrapSeeded && !(await this.isArmed())) {
      console.log(JSON.stringify({ t3flare: "bootstrap-disarmed", action: "restart-in-place" }));
      await this.restartRuntime("bootstrap-window-closed");
      return;
    }
    if (runtime === undefined) {
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
      if (BOOTSTRAP_EXCHANGE_PATHS.has(url.pathname) && request.method === "POST") {
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
    const body = await request.clone().text();
    if (!body.includes(token) && !body.includes(encodeURIComponent(token))) return undefined;
    console.log(JSON.stringify({ t3flare: "bootstrap-refused", reason: "pairing is not armed" }));
    return Response.json({ error: "pairing is not armed" }, { status: 401 });
  }
}
