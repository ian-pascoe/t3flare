// @effect-diagnostics globalTimers:off
// The wake (ADR-0043 §5): a deletion brings the Workspace Sweep forward. One project deletion emits a
// `thread.deleted` per thread and then a `project.deleted`, so the Sweep runs after WAKE_QUIET_MS without a wake, and a
// wake while a Sweep runs asks for exactly one more after it. The Environment DO owns one, and every non-dry Sweep (the
// alarm's, the idle check's, a wake's, and the Owner's from the Settings page or the admin route) runs through it, one
// at a time. A dry run writes nothing and does not queue.

/** How long a wake waits for the next before the Sweep runs. */
export const WAKE_QUIET_MS = 5_000;

export interface SweepWakeDeps<R> {
  readonly now: () => number;
  /** The stored next-sweep time (the one alarm's input, ADR-0003); it survives a reset, the debounce does not. */
  readonly nextSweep: () => number;
  readonly setNextSweep: (at: number) => void;
  /** Sets the one alarm no later than the stored next-sweep time. */
  readonly arm: () => Promise<void>;
  /** One non-dry Sweep, answering its report. */
  readonly sweep: () => Promise<R>;
  /** A failed Sweep or alarm write; the wake goes on. */
  readonly failed: (what: "sweep" | "arm", error: unknown) => void;
}

/**
 * A change moved the Grace (`sweepPurges` or `graceDays`, ADR-0043 §5): every date moved, so the Sweep is woken. Purging
 * turned off forgets when it was turned on (ADR-0043 §4) at once, not at the next Sweep: turned on again inside the wake's
 * quiet, it starts a new Grace.
 */
export const graceMoved = (deps: { readonly purging: boolean; readonly clearPurgingSince: () => void; readonly wake: () => void }): void => {
  if (!deps.purging) deps.clearPurgingSince();
  deps.wake();
};

/**
 * The Owner's Sweep as the Settings page and the admin route run it: a dry run (the preview) directly, since it writes
 * nothing; a real one through `wake`'s queue, so it never overlaps a scheduled Sweep.
 */
export const ownerSweep =
  <R>(wake: Pick<SweepWake<R>, "runNow">, dryRun: () => Promise<R>) =>
  (dry: boolean): Promise<R> =>
    dry ? dryRun() : wake.runNow();

export class SweepWake<R> {
  readonly #deps: SweepWakeDeps<R>;
  #quiet: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #again = false;

  constructor(deps: SweepWakeDeps<R>) {
    this.#deps = deps;
  }

  /**
   * Asks for a Sweep after WAKE_QUIET_MS of quiet. The stored next-sweep time becomes the quiet's end (an earlier one
   * stands unless an earlier wake set it) and the alarm is written now, so a reset inside the quiet loses nothing.
   */
  wake(): void {
    if (this.#running !== undefined) {
      this.#again = true;
      return;
    }
    const due = this.#deps.now() + WAKE_QUIET_MS;
    if (this.#quiet !== undefined || this.#deps.nextSweep() > due) this.#deps.setNextSweep(due);
    if (this.#quiet !== undefined) clearTimeout(this.#quiet);
    this.#quiet = setTimeout(() => {
      this.#quiet = undefined;
      void this.#run();
    }, WAKE_QUIET_MS);
    this.#deps.arm().catch((error: unknown) => this.#deps.failed("arm", error));
  }

  /** The Sweep, if its stored time has come (the alarm, the idle check); never while a wake waits for quiet. */
  runIfDue(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    if (this.#quiet !== undefined || this.#deps.now() < this.#deps.nextSweep()) return Promise.resolve();
    return this.#run();
  }

  /**
   * The Owner's Sweep (the Settings page's "Run the Sweep", the admin route): after the Sweep running now, if any, never
   * beside it, and in place of a wake still waiting for quiet. Answers its report, or rejects with its failure (which
   * `failed` gets too).
   */
  async runNow(): Promise<R> {
    for (;;) {
      if (this.#quiet !== undefined) {
        clearTimeout(this.#quiet);
        this.#quiet = undefined;
      }
      if (this.#running === undefined) return this.#start();
      await this.#running;
    }
  }

  #run(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    void this.#start();
    return this.#running!;
  }

  /** Starts one Sweep, held in `#running` until it settles; answers the Sweep itself (its failure is handled there). */
  #start(): Promise<R> {
    const sweep = this.#deps.sweep();
    this.#running = sweep
      .then(
        () => undefined,
        (error: unknown) => this.#deps.failed("sweep", error),
      )
      .finally(() => {
        this.#running = undefined;
        if (!this.#again) return;
        this.#again = false;
        this.wake();
      });
    return sweep;
  }
}
