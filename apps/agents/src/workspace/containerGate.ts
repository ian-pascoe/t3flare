// Whether a Workspace's Container may start, and the starts under way (the nightly's step 2b `leased: true`).
//
// A removed worktree with uncommitted work is a tombstone: its files are kept, its Container and budget lease are not.
// Stopping the Container is not enough on its own: a start already under way (its lease taken, the Container still
// coming up, so not yet `running`) outlives the stop and holds a lease again, and a caller still holding the
// Workspace's stub (the thread's first turn, its terminal) starts it again after. A closed gate refuses every start,
// and closing waits out the ones under way, so the stop that follows is the last word. Provisioning or a restore opens
// it again.

/** The closed mark, kept in the Workspace DO's storage so a restarted object still refuses. */
export interface GateStore {
  readonly closed: () => boolean;
  readonly setClosed: (closed: boolean) => void;
}

/** What a start on a closed gate throws; computer's start wraps it as it wraps a budget refusal. */
export const CLOSED_MESSAGE = "t3flare: this Workspace was removed: its Container does not start";

export class ContainerGate {
  readonly #store: GateStore;
  readonly #starts = new Set<Promise<unknown>>();

  constructor(store: GateStore) {
    this.#store = store;
  }

  closed(): boolean {
    return this.#store.closed();
  }

  /** Starts under way: `close` waits for them. */
  get starting(): number {
    return this.#starts.size;
  }

  /**
   * Runs a start (its lease, then the platform's start) unless the gate is closed. The check and the tracking happen
   * before the first await, so a start either sees the gate closed or is one that `close` waits for.
   */
  start<A>(run: () => Promise<A>): Promise<A> {
    if (this.#store.closed()) return Promise.reject(new Error(CLOSED_MESSAGE));
    const started = run();
    // Settles once the start has ended either way and left the set, so `close` never waits on a finished start.
    const tracked: Promise<void> = started.then(
      () => void this.#starts.delete(tracked),
      () => void this.#starts.delete(tracked),
    );
    this.#starts.add(tracked);
    return started;
  }

  /** Closes the gate and waits until no start is under way (each ends, started or refused). Stops nothing itself. */
  async close(): Promise<void> {
    this.#store.setClosed(true);
    while (this.#starts.size > 0) await Promise.all(this.#starts);
  }

  reopen(): void {
    this.#store.setClosed(false);
  }
}
