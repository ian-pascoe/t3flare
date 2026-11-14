// @effect-diagnostics globalTimers:off globalDate:off
// The Global mise config's lay-down, once per Container (SPI-1150, ADR-0032 §8): the Workspace DO runs the script
// (`@t3flare/sandbox-image/globalMise`) on each new Container before its first command, holding the Container while it
// runs, and reports how it ended.
//
// - Keyed by the Container's runtime id (computer's connect answers it): a Container that replaced one that died on its
//   own has a new one, so it gets its own run. The outcome is kept in storage, so a new instance of the Workspace DO (a
//   deploy) does not run a finished lay-down again. Without a runtime id the script runs anyway: it is idempotent on a
//   Container's disk (it answers again for the same revision and text).
// - Held: the run counts as a command, so neither the idle stop nor another Workspace's reclaim stops the Container
//   under an install, and the idle time counts from its end.
// - Bounded: the script bounds its lock, install and checks; the Workspace DO waits for their sum and a margin
//   (`GLOBAL_MISE_DEADLINE_MS`), then kills the exec and treats it as not laid, final for that Container.
// - Retried: an exec that failed (refused, broken, no answer, the lock held) is tried again at once, then by the next
//   caller or the alarm, at most `MAX_ATTEMPTS` times per Container. Every run is reported (`report`).
import type { GlobalMiseOutcome, GlobalMiseReport } from "@t3flare/harness-registry";
import { type GlobalMiseAnswer, globalMiseArgv, parseGlobalMiseAnswer } from "@t3flare/sandbox-image/globalMise";

/** What a Container start lays down: the text of its launch, with its digest. */
export interface GlobalMiseLaunch {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly revision: number;
  readonly source: "environment" | "kept" | "default";
}

/** A running exec on the Container (the platform's): its output when it ends, and a kill. */
export interface GlobalMiseExec {
  readonly output: Promise<{ readonly stdout: string; readonly exitCode: number | null }>;
  kill(): void;
}

export interface GlobalMiseDeps {
  /** Starts the script on the running Container, `stdin` on its stdin; throws when the exec cannot start. */
  readonly exec: (argv: ReadonlyArray<string>, stdin: string) => Promise<GlobalMiseExec>;
  /** The launch of the Container now running, read after its connect; undefined before any (a launch from before SPI-1150 has no text). */
  readonly launch: () => GlobalMiseLaunch | undefined;
  /** Holds the Container as a command does; the answer releases it. */
  readonly hold: () => () => void;
  /** The run has ended: a use of the Container (the idle time counts from now). */
  readonly used: () => Promise<void>;
  readonly report: (report: GlobalMiseReport) => void;
  readonly storage: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
  readonly workspace: () => string | null;
  readonly now: () => number;
  readonly deadlineMs: number;
  readonly log?: (event: Record<string, unknown>) => void;
}

/** At most this many runs per Container: one, one at once after an exec failure, one more from a later caller. */
export const MAX_ATTEMPTS = 3;

/** The kept outcome of the current Container's lay-down. */
export const GLOBAL_MISE_KEY = "t3flare:global-mise";

export interface GlobalMiseState {
  readonly runtime: string;
  readonly outcome: GlobalMiseOutcome;
  readonly attempts: number;
  readonly answer?: GlobalMiseAnswer;
  readonly at: number;
}

const FINAL: ReadonlyArray<GlobalMiseOutcome> = ["laid", "not-laid", "deadline"];

/** The launch with no text: what a Container gets when nothing is laid down. */
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export class GlobalMise {
  readonly #deps: GlobalMiseDeps;
  readonly #running = new Map<string, Promise<GlobalMiseState>>();

  constructor(deps: GlobalMiseDeps) {
    this.#deps = deps;
  }

  /** Whether a lay-down runs now (a command waiting in connect waits for it). */
  inFlight(): boolean {
    return this.#running.size > 0;
  }

  /** The current Container's outcome, as kept. */
  state(): GlobalMiseState | undefined {
    return this.#deps.storage.get<GlobalMiseState>(GLOBAL_MISE_KEY);
  }

  /**
   * The lay-down of the Container `runtime` (computer's runtime id), run or joined; resolves when it has ended. A final
   * outcome is not run again; an exec failure is retried once at once and then by a later call, `MAX_ATTEMPTS` in all.
   */
  ensure(runtime: string | undefined, options: { readonly retry?: boolean } = {}): Promise<GlobalMiseState> {
    const key = runtime ?? "";
    const running = this.#running.get(key);
    if (running !== undefined) return running;
    const kept = this.state();
    // `retry: false` (a passive read's connect): a Container that had a run keeps its outcome, failed or not.
    if (runtime !== undefined && kept?.runtime === runtime && (FINAL.includes(kept.outcome) || kept.attempts >= MAX_ATTEMPTS || options.retry === false)) return Promise.resolve(kept);
    const before = runtime !== undefined && kept?.runtime === runtime ? kept.attempts : 0;
    const promise = (async () => {
      let state = await this.#run(key, before);
      // The first exec failed: once more at once (a transient refusal); later ones wait for a later caller or the alarm.
      if (state.outcome === "exec-failed" && before === 0) state = await this.#run(key, state.attempts);
      return state;
    })().finally(() => this.#running.delete(key));
    this.#running.set(key, promise);
    return promise;
  }

  /** The alarm's retry: a Container whose lay-down's exec failed, with attempts left, is tried again (not awaited). */
  retryFailed(runtime: string | undefined): boolean {
    const kept = this.state();
    if (runtime === undefined || kept?.runtime !== runtime || kept.outcome !== "exec-failed" || kept.attempts >= MAX_ATTEMPTS || this.#running.has(runtime)) return false;
    void this.ensure(runtime).catch(() => undefined);
    return true;
  }

  async #run(runtime: string, attemptsBefore: number): Promise<GlobalMiseState> {
    const deps = this.#deps;
    const known = deps.launch();
    // A launch from before SPI-1150 (no Global mise config recorded) runs the script with no text: it lays nothing down.
    const launch = known ?? { text: "", bytes: 0, sha256: EMPTY_SHA, revision: 0, source: "default" as const };
    const started = deps.now();
    // No text in a known launch on a known Container: nothing to lay down, nothing run (its disk has no global file).
    if (known !== undefined && known.text === "" && runtime !== "") {
      const state: GlobalMiseState = { runtime, outcome: "not-laid", attempts: attemptsBefore + 1, at: started };
      deps.storage.put(GLOBAL_MISE_KEY, state);
      return state;
    }
    const release = deps.hold();
    let outcome: GlobalMiseOutcome = "exec-failed";
    let answer: GlobalMiseAnswer | undefined;
    let error: string | undefined;
    try {
      const exec = await deps.exec(globalMiseArgv(launch.revision, launch.sha256, launch.source), launch.text);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        exec.output,
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), deps.deadlineMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result === "deadline") {
        exec.kill();
        outcome = "deadline";
      } else {
        answer = parseGlobalMiseAnswer(result.stdout);
        outcome = answer === undefined || answer.locked === true ? "exec-failed" : answer.laid ? "laid" : "not-laid";
        if (answer === undefined) error = `no answer (exit ${String(result.exitCode)})`;
      }
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause).slice(0, 300);
    } finally {
      release();
    }
    await deps.used().catch(() => undefined);
    const at = deps.now();
    const state: GlobalMiseState = { runtime, outcome, attempts: attemptsBefore + 1, ...(answer === undefined ? {} : { answer }), at };
    // Kept only for a known Container: without a runtime id each call runs the (idempotent) script again.
    if (runtime !== "") deps.storage.put(GLOBAL_MISE_KEY, state);
    const report: GlobalMiseReport = {
      workspace: deps.workspace(),
      runtime: runtime === "" ? "unknown" : runtime,
      revision: launch.revision,
      sha256: launch.sha256,
      bytes: launch.bytes,
      source: launch.source,
      outcome,
      install: answer?.install ?? null,
      timedOut: answer?.timedOut ?? outcome === "deadline",
      ms: Math.max(0, at - started),
      at,
    };
    deps.log?.({ t3flare: "global-mise", ...report, attempt: state.attempts, ...(error === undefined ? {} : { error }) });
    deps.report(report);
    return state;
  }
}
