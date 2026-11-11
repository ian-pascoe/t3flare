// @effect-diagnostics asyncFunction:off globalTimers:off globalConsole:off
// The Workspace DO syncs files for its terminals (step 2b, ADR-0021; cloudpid's ADR-0012): computer syncs only around
// its own commands, and a shell's writes would otherwise never reach the DO (t3's status, diffs, checkpoints).
//
// - Pull (Container → DO): soon after a prompt returns or a shell exits; 1 s after output goes quiet, backing off while
//   such pulls find nothing (a chatty process would otherwise pull every 2 s forever, review F9); at most one every 2 s.
// - Push (DO → Container): while terminals are open, every 2 s when the DO's change log moved since the last sync.
// - Never while the Container is stopped: a sync would start it and take a budget lease (review F9).
// - One sync at a time here; computer serialises only block by block (review F9).

export const MIN_PULL_GAP_MS = 2_000;
export const PROMPT_PULL_DELAY_MS = 300;
export const QUIET_PULL_DELAY_MS = 1_000;
export const MAX_QUIET_BACKOFF_MS = 60_000;
export const PUSH_EVERY_MS = 2_000;

export interface TerminalSyncDeps {
  readonly now: () => number;
  readonly running: () => boolean;
  /** Runs a pull to completion; answers the entries applied. */
  readonly pull: () => Promise<number>;
  readonly push: () => Promise<number>;
  /** The DO's change-log revision (moves on every write to the DO's files, a pull's included). */
  readonly revision: () => number;
  /** Whether any terminal is open (pushes run only then). */
  readonly active: () => boolean;
}

export class TerminalSync {
  readonly #deps: TerminalSyncDeps;
  #chain: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = 0;
  #quietPending = false;
  #lastPull = 0;
  #quietDelay = QUIET_PULL_DELAY_MS;
  #syncedRevision = -1;
  #pushTimer: ReturnType<typeof setInterval> | undefined;
  readonly stats = { pulls: 0, pushes: 0, emptyPulls: 0, failures: 0 };

  constructor(deps: TerminalSyncDeps) {
    this.#deps = deps;
  }

  /** A prompt returned, a shell exited, or output arrived. */
  changed(why: "prompt" | "exit" | "output"): void {
    if (why === "output") {
      this.#schedule(this.#quietDelay, true);
      return;
    }
    this.#quietDelay = QUIET_PULL_DELAY_MS;
    this.#schedule(PROMPT_PULL_DELAY_MS, false);
  }

  #schedule(delay: number, quiet: boolean): void {
    const now = this.#deps.now();
    const at = Math.max(now + delay, this.#lastPull + MIN_PULL_GAP_MS);
    if (this.#timer !== undefined) {
      // A pending prompt pull is never pushed back, by output or a later prompt.
      if (!this.#quietPending && (quiet || this.#timerAt <= at)) return;
      // A pending quiet pull: output debounces it, a prompt replaces it.
      clearTimeout(this.#timer);
    }
    this.#quietPending = quiet;
    this.#timerAt = at;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.pullNow(quiet).catch(() => undefined);
    }, at - now);
  }

  /** Pulls now (serialised); a quiet pull that finds nothing doubles the next quiet delay. */
  pullNow(quiet = false): Promise<number> {
    return this.#serial(async () => {
      if (!this.#deps.running()) return 0;
      this.#lastPull = this.#deps.now();
      const entries = await this.#deps.pull();
      this.stats.pulls++;
      if (entries === 0) this.stats.emptyPulls++;
      if (quiet) this.#quietDelay = entries === 0 ? Math.min(this.#quietDelay * 2, MAX_QUIET_BACKOFF_MS) : QUIET_PULL_DELAY_MS;
      // What the pull applied is in the Container already: not a reason to push.
      this.#syncedRevision = this.#deps.revision();
      return entries;
    });
  }

  /** Pushes the DO's writes when the change log moved since the last sync. */
  pushIfChanged(): Promise<number> {
    return this.#serial(async () => {
      if (!this.#deps.running() || !this.#deps.active()) return 0;
      const revision = this.#deps.revision();
      if (revision === this.#syncedRevision) return 0;
      const entries = await this.#deps.push();
      this.stats.pushes++;
      this.#syncedRevision = this.#deps.revision();
      return entries;
    });
  }

  #serial<A>(fn: () => Promise<A>): Promise<A> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch((error: unknown) => {
      this.stats.failures++;
      console.warn(JSON.stringify({ t3flare: "terminal-sync-failed", error: String(error).slice(0, 300) }));
    });
    return run;
  }

  /** Starts the push loop (while terminals are open); stops itself when none is. */
  startPushing(): void {
    if (this.#pushTimer !== undefined) return;
    this.#syncedRevision = this.#deps.revision();
    this.#pushTimer = setInterval(() => {
      if (!this.#deps.active()) {
        this.stop();
        return;
      }
      void this.pushIfChanged().catch(() => undefined);
    }, PUSH_EVERY_MS);
  }

  stop(): void {
    if (this.#pushTimer !== undefined) clearInterval(this.#pushTimer);
    this.#pushTimer = undefined;
  }
}
