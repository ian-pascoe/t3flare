// The Session's running Container commands (step 2a part 2 plan, section 4; ADR-0004's refinement). computer-env's
// `exec` reports each command it starts on the Container, and whether it ended by itself or was stopped (an abort or a
// timeout); the ids are kept in the Session's storage, so a Session that dies mid-call still knows them when it opens.
//
// A stopped command's processes are killed by its exec id (the Workspace's `killExecs`, apps/sandbox-image/src/kill.ts):
// computerd's own kill leaves them running (docs/steps/step-2a-part2.md, M0). An id is forgotten only when its command
// ended by itself or a kill found none of its processes left; otherwise the kill is tried again from the Session's
// alarm, and given up after `MAX_ATTEMPTS`. A background process of a command that completed is left alone.
// @effect-diagnostics globalTimers:off globalConsole:off newPromise:off

const KEY = "t3flare:running-execs";
/** Kills of one id before it is given up (each about 5 s apart, from the alarm). */
const MAX_ATTEMPTS = 12;
/** How long the Session waits after a stopped command before it tries a failed kill again. */
export const KILL_RETRY_MS = 5_000;

export interface RunningExecsStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

/** What a kill found: the processes of the ids still alive after it (0 when the Container is not running). */
export interface KillAnswer {
  readonly survivors: number;
}

interface Entry {
  /** `running` until its command stops by an abort or a timeout, or the Session finds it after a restart. */
  readonly state: "running" | "killing";
  readonly attempts: number;
}

type Entries = Record<string, Entry>;

export class RunningExecs {
  readonly #kv: RunningExecsStorage;
  readonly #kill: (ids: ReadonlyArray<string>) => Promise<KillAnswer>;

  constructor(kv: RunningExecsStorage, kill: (ids: ReadonlyArray<string>) => Promise<KillAnswer>) {
    this.#kv = kv;
    this.#kill = kill;
  }

  #entries(): Entries {
    return this.#kv.get<Entries>(KEY) ?? {};
  }

  #update(change: (entries: Entries) => void): void {
    const entries = this.#entries();
    change(entries);
    this.#kv.put(KEY, entries);
  }

  /** The ids kept now: commands running, or stopped and not yet known dead. */
  ids(): ReadonlyArray<string> {
    return Object.keys(this.#entries());
  }

  started(id: string): void {
    this.#update((entries) => {
      entries[id] = { state: "running", attempts: 0 };
    });
  }

  /** The command ended by itself: its processes are its own business (a background one it started stays). */
  ended(id: string): void {
    this.#update((entries) => {
      if (entries[id]?.state === "running") delete entries[id];
    });
  }

  /** The command was stopped (an abort, a timeout): its processes are killed now, and again later if any survive. */
  async stopped(id: string, boundMs = 3_000): Promise<void> {
    await this.killAll(boundMs, [id]);
  }

  /** Whether a kill is to be tried again (the Session's alarm). */
  retryDue(): boolean {
    return Object.values(this.#entries()).some((entry) => entry.state === "killing");
  }

  /** Tries the kills that have not succeeded yet. */
  async retry(boundMs = 3_000): Promise<void> {
    const due = Object.entries(this.#entries())
      .filter(([, entry]) => entry.state === "killing")
      .map(([id]) => id);
    if (due.length > 0) await this.killAll(boundMs, due);
  }

  /**
   * Kills `ids` (by default every id kept), waiting at most `boundMs`: never throws. Each id is marked as killing first,
   * so a kill cut off by the bound, or by the object's death, is tried again.
   */
  async killAll(boundMs: number, ids: ReadonlyArray<string> = this.ids()): Promise<void> {
    const targets = ids.filter((id) => this.#entries()[id] !== undefined);
    if (targets.length === 0) return;
    this.#update((entries) => {
      for (const id of targets) entries[id] = { state: "killing", attempts: (entries[id]?.attempts ?? 0) + 1 };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      this.#kill(targets).catch((error: unknown) => {
        console.warn(JSON.stringify({ t3flare: "kill-execs-failed", error: String(error).slice(0, 300) }));
        return undefined;
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), boundMs);
      }),
    ]);
    clearTimeout(timer);
    this.#update((entries) => {
      for (const id of targets) {
        const entry = entries[id];
        if (entry === undefined) continue;
        if (answer?.survivors === 0) delete entries[id];
        else if (entry.attempts >= MAX_ATTEMPTS) {
          console.warn(JSON.stringify({ t3flare: "kill-execs-gave-up", id, survivors: answer?.survivors ?? null }));
          delete entries[id];
        }
      }
    });
  }
}
