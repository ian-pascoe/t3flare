// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off globalConsole:off
// The Workspace DO's CLI processes (step 4a, the process channel): `codex app-server` and `pi --mode rpc` under the
// platform's non-PTY exec in the Workspace's Container, their stdout and stderr pushed to the Environment DO as bytes
// in batches, their stdin, signals, turns and heartbeats from the Environment's spawner. A sibling of `TerminalHost`.
//
// - Input is ordered by `seq`, one write at a time: a duplicate (a retried RPC) is acknowledged, a gap or a failed write
//   kills the process; nothing is ever skipped (review F6).
// - Output is never dropped: a failed push goes back in front and is retried; reading pauses while 1 MiB waits.
// - Every process carries the Environment's epoch (its durable boot counter). A start from another epoch first kills
//   every process of this Workspace started under a different one, so two copies of one native thread never write the
//   same session file (plan §2.6). Markers are kept in storage, so orphans of an earlier instance are killed too.
// - Signals never use `ExecProcess.kill()` (step 2b's review F2): part 2's kill script on the marker.
// - The hold (review F7): a process holds the Container while its thread is in a turn, and for `idleHoldMs` after the
//   last turn ended (or the last input). Past that it no longer holds it, and t3's own idle release (Patch 0003, at the
//   same 10 minutes) ends the session.
import { processCommand, type ProcessFile } from "@t3flare/sandbox-image/process";
import type {
  ProcessAnswer,
  ProcessFrame,
  ProcessInputAnswer,
  ProcessPush,
  ProcessPushAnswer,
  ProcessStartAnswer,
  ProcessStartInput,
} from "@t3flare/workspace-client";

/** A process not heartbeaten for this long is killed (the spawner beats every 30 s). */
export const HEARTBEAT_LAPSE_MS = 90_000;
export const BATCH_MS = 16;
export const BULK_BATCH_MS = 100;
export const BATCH_BYTES = 64 * 1024;
/** Output with input in the last second is pushed sooner (a request's answer). */
export const ECHO_WINDOW_MS = 1_000;
/** Reading pauses while this much waits to be pushed. */
export const BACKPRESSURE_BYTES = 1024 * 1024;
/** How long after its last turn a CLI process holds the Container (review F7; t3 releases the session at 10 minutes). */
export const CLI_IDLE_HOLD_MS = 11 * 60_000;
/** A process with neither input nor output for this long is killed (past the 2 h turn cap). */
export const BACKSTOP_MS = 130 * 60_000;
/** A process out of a turn for this long may be ended to free the Container for another Workspace (review F7). */
export const RECLAIMABLE_AFTER_MS = 30_000;

/** The part of the platform's `ExecProcess` used here (no PTY). */
export interface CliProcess {
  readonly stdin: WritableStream | null;
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
  readonly exitCode: Promise<number>;
}

/** A live process's marker as kept in storage. */
export interface ProcessMarker {
  readonly key: string;
  readonly environmentEpoch: number;
  readonly thread?: string;
  readonly linked?: boolean;
}

export interface ProcessHostDeps {
  readonly now: () => number;
  /** This Workspace DO's boot counter. */
  readonly epoch: number;
  readonly running: () => boolean;
  /** Starts the Container through computer (the budget's lease); throws with the reason when refused. */
  readonly startContainer: () => Promise<void>;
  /** `ctx.container.exec` without a PTY, stdin piped, stdout and stderr apart. */
  readonly spawn: (argv: ReadonlyArray<string>, env: Record<string, string>) => Promise<CliProcess>;
  /** Part 2's kill script on markers, in the Container; nothing when it is not running. */
  readonly kill: (markers: ReadonlyArray<string>) => Promise<void>;
  readonly push: (push: Omit<ProcessPush, "workspace">) => Promise<ProcessPushAnswer>;
  /** The image's command env without `BASH_ENV`. */
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly remember: (markers: ReadonlyArray<ProcessMarker>) => void;
  readonly remembered: () => ReadonlyArray<ProcessMarker>;
  /** Output went quiet, or a process exited: the Container's files may have changed. */
  readonly filesMayHaveChanged: (why: "output" | "exit") => void;
  /** At most this many live processes (derived from the memory probe, P9). */
  readonly maxProcesses: number;
  /** Whether `cli: "probe"` may start (test stages). */
  readonly allowProbe: boolean;
  /** Before a start: the profile's checks that need the Container (the sandbox probe, the key's nonce). */
  readonly beforeStart?: (input: ProcessStartInput) => Promise<{ readonly env?: Readonly<Record<string, string>> } | void>;
  /** A process of a linked thread lives, or no longer does (D1, review F8). */
  readonly linkedWork?: (thread: string, alive: boolean) => void;
}

interface Proc {
  readonly key: string;
  readonly marker: ProcessMarker;
  process: CliProcess | undefined;
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  outSeq: number;
  nextInSeq: number;
  lastHeartbeat: number;
  lastIo: number;
  lastInput: number;
  inTurn: boolean;
  turnEndedAt: number;
  exited: boolean;
  killing: boolean;
}

const encoder = new TextEncoder();

export class ProcessHost {
  readonly #deps: ProcessHostDeps;
  readonly #procs = new Map<string, Proc>();
  #pending: Array<ProcessFrame> = [];
  #pendingBytes = 0;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #flushDue = 0;
  #inFlight: Promise<void> | undefined;
  #drained: Array<() => void> = [];
  #pushFailures = 0;
  #pushes = 0;
  #lastInput = 0;

  constructor(deps: ProcessHostDeps) {
    this.#deps = deps;
  }

  /** Live processes (not exited). */
  get size(): number {
    return [...this.#procs.values()].filter((proc) => !proc.exited).length;
  }

  get pushes(): number {
    return this.#pushes;
  }

  keys(): ReadonlyArray<string> {
    return [...this.#procs.keys()];
  }

  /** Diagnosis: each live process, its turn state and how long it has been quiet. */
  state(): ReadonlyArray<{ readonly key: string; readonly thread: string | null; readonly environmentEpoch: number; readonly inTurn: boolean; readonly idleMs: number }> {
    const now = this.#deps.now();
    return [...this.#procs.values()].map((proc) => ({
      key: proc.key,
      thread: proc.marker.thread ?? null,
      environmentEpoch: proc.marker.environmentEpoch,
      inTurn: proc.inTurn,
      idleMs: now - Math.max(proc.turnEndedAt, proc.lastInput),
    }));
  }

  #answer(keys: ReadonlyArray<string>): ProcessAnswer {
    return { epoch: this.#deps.epoch, unknown: keys.filter((key) => !this.#procs.has(key)) };
  }

  #save(): void {
    this.#deps.remember([...this.#procs.values()].filter((proc) => !proc.exited).map((proc) => proc.marker));
  }

  /** Whether CLI processes hold the Container: one is in a turn, or its last turn (or input) is recent. */
  holdsContainer(idleHoldMs = CLI_IDLE_HOLD_MS): boolean {
    const now = this.#deps.now();
    return [...this.#procs.values()].some((proc) => !proc.exited && (proc.inTurn || now - Math.max(proc.turnEndedAt, proc.lastInput) < idleHoldMs));
  }

  /** Processes no turn has used for `RECLAIMABLE_AFTER_MS`: the budget may end them for another Workspace. */
  reclaimable(): ReadonlyArray<string> {
    const now = this.#deps.now();
    return [...this.#procs.values()]
      .filter((proc) => !proc.exited && !proc.inTurn && now - Math.max(proc.turnEndedAt, proc.lastInput) >= RECLAIMABLE_AFTER_MS)
      .map((proc) => proc.key);
  }

  async start(input: ProcessStartInput & { readonly files?: ReadonlyArray<ProcessFile>; readonly links?: ReadonlyArray<{ readonly path: string; readonly target: string }> }): Promise<ProcessStartAnswer> {
    const refuse = (reason: string): ProcessStartAnswer => ({ ok: false, epoch: this.#deps.epoch, reason });
    if (this.#procs.has(input.key)) return { ok: true, epoch: this.#deps.epoch };
    if (input.cli === "probe" && !this.#deps.allowProbe) return refuse("the probe program runs on test stages only");
    if (this.size >= this.#deps.maxProcesses) return refuse(`this Workspace already runs ${this.#deps.maxProcesses} CLI agent processes; let one finish first`);
    if (!this.#deps.running()) {
      try {
        await this.#deps.startContainer();
      } catch (error) {
        return refuse(String(error instanceof Error ? error.message : error));
      }
    }
    await this.#killOthers(input.environmentEpoch);
    let extraEnv: Readonly<Record<string, string>> = {};
    try {
      extraEnv = (await this.#deps.beforeStart?.(input))?.env ?? {};
    } catch (error) {
      return refuse(String(error instanceof Error ? error.message : error).slice(0, 500));
    }
    let command: string;
    try {
      command = processCommand({
        marker: input.key,
        t3Path: input.t3Path,
        cwd: input.cwd,
        argv: input.argv,
        ...(input.files === undefined ? {} : { files: input.files }),
        ...(input.links === undefined ? {} : { links: input.links }),
      });
    } catch (error) {
      return refuse(String(error instanceof Error ? error.message : error));
    }
    const now = this.#deps.now();
    const proc: Proc = {
      key: input.key,
      marker: {
        key: input.key,
        environmentEpoch: input.environmentEpoch,
        ...(input.thread === undefined ? {} : { thread: input.thread }),
        ...(input.linked === true ? { linked: true } : {}),
      },
      process: undefined,
      writer: undefined,
      outSeq: 0,
      nextInSeq: 0,
      lastHeartbeat: now,
      lastIo: now,
      lastInput: now,
      inTurn: false,
      turnEndedAt: now,
      exited: false,
      killing: false,
    };
    this.#procs.set(input.key, proc);
    this.#save();
    if (proc.marker.linked === true && proc.marker.thread !== undefined) this.#deps.linkedWork?.(proc.marker.thread, true);
    try {
      const process = await this.#deps.spawn(["bash", "-c", command], { ...this.#deps.baseEnv, ...input.env, ...extraEnv, T3FLARE_EXEC: input.key });
      proc.process = process;
      proc.writer = process.stdin?.getWriter() as WritableStreamDefaultWriter<Uint8Array> | undefined;
      const reads = Promise.all([this.#read(proc, process.stdout, "stdout"), this.#read(proc, process.stderr, "stderr")]);
      void process.exitCode
        .then(
          (code) => code,
          () => 129,
        )
        .then(async (code) => {
          // Every byte first, then the exit (a stream broken by the Container's end does not wait forever).
          await Promise.race([reads, new Promise((resolve) => setTimeout(resolve, 5000))]);
          this.#exited(proc, code);
        });
    } catch (error) {
      this.#procs.delete(input.key);
      this.#save();
      if (proc.marker.linked === true && proc.marker.thread !== undefined) this.#deps.linkedWork?.(proc.marker.thread, false);
      return refuse(`the process did not start: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`);
    }
    if (proc.killing) await this.#deps.kill([proc.key]);
    console.log(JSON.stringify({ t3flare: "process-started", key: input.key, cli: input.cli, thread: input.thread ?? null, environmentEpoch: input.environmentEpoch }));
    return { ok: true, epoch: this.#deps.epoch };
  }

  /** Kills every process of this Workspace started under another Environment epoch, or by an earlier instance of this object. */
  async #killOthers(environmentEpoch: number): Promise<void> {
    const stale = this.#deps.remembered().filter((marker) => marker.environmentEpoch !== environmentEpoch || !this.#procs.has(marker.key));
    if (stale.length === 0) return;
    console.log(JSON.stringify({ t3flare: "process-stale-killed", count: stale.length, environmentEpoch }));
    await this.#deps.kill(stale.map((marker) => marker.key));
    for (const marker of stale) {
      const proc = this.#procs.get(marker.key);
      if (proc !== undefined) this.#exited(proc, 129);
      else if (marker.linked === true && marker.thread !== undefined) this.#deps.linkedWork?.(marker.thread, false);
    }
    this.#save();
  }

  async #read(proc: Proc, stream: ReadableStream | null, name: "stdout" | "stderr"): Promise<void> {
    if (stream === null) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        while (this.#pendingBytes >= BACKPRESSURE_BYTES) await new Promise<void>((resolve) => this.#drained.push(resolve));
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value as Uint8Array;
        if (bytes.byteLength === 0) continue;
        proc.lastIo = this.#deps.now();
        this.#frame(proc, { stream: name, data: bytes });
      }
    } catch {
      // The stream ends with the process (or the Container).
    }
  }

  #frame(proc: Proc, frame: Omit<ProcessFrame, "key" | "seq">): void {
    this.#pending.push({ key: proc.key, seq: proc.outSeq++, ...frame });
    this.#pendingBytes += frame.data?.byteLength ?? 16;
    this.#flushSoon(this.#pendingBytes >= BATCH_BYTES ? 0 : this.#deps.now() - this.#lastInput < ECHO_WINDOW_MS ? BATCH_MS : BULK_BATCH_MS);
    if (frame.stream !== "exit") this.#deps.filesMayHaveChanged("output");
  }

  #flushSoon(ms: number): void {
    if (this.#inFlight !== undefined) return;
    const due = Date.now() + ms;
    if (this.#flushTimer !== undefined) {
      if (due >= this.#flushDue) return;
      clearTimeout(this.#flushTimer);
    }
    this.#flushDue = due;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flush();
    }, ms);
  }

  async #flush(): Promise<void> {
    if (this.#inFlight !== undefined || this.#pending.length === 0) return;
    const frames = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#inFlight = (async () => {
      let answer: ProcessPushAnswer;
      try {
        answer = await this.#deps.push({ epoch: this.#deps.epoch, frames });
        this.#pushFailures = 0;
        this.#pushes++;
      } catch (error) {
        // Never dropped: the batch goes back in front, retried with backoff to 5 s; a process whose Environment is gone
        // ends by the heartbeat's lapse.
        this.#pushFailures++;
        console.warn(JSON.stringify({ t3flare: "process-push-failed", attempt: this.#pushFailures, frames: frames.length, error: String(error).slice(0, 300) }));
        this.#pending = [...frames, ...this.#pending];
        this.#pendingBytes += frames.reduce((sum, frame) => sum + (frame.data?.byteLength ?? 16), 0);
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 100 * 2 ** Math.min(this.#pushFailures, 6))));
        return;
      }
      for (const key of answer.unknown) {
        const proc = this.#procs.get(key);
        if (proc !== undefined && !proc.exited) {
          console.log(JSON.stringify({ t3flare: "process-unknown-to-environment", key }));
          void this.signal(key);
        }
      }
    })();
    try {
      await this.#inFlight;
    } finally {
      this.#inFlight = undefined;
      for (const resolve of this.#drained.splice(0)) resolve();
      if (this.#pending.length > 0) this.#flushSoon(this.#pendingBytes >= BATCH_BYTES ? 0 : BATCH_MS);
    }
  }

  /** Waits until every frame so far was pushed (tests, and before a stop). */
  async settled(): Promise<void> {
    for (let i = 0; i < 50 && (this.#pending.length > 0 || this.#inFlight !== undefined || this.#flushTimer !== undefined); i++) {
      if (this.#flushTimer !== undefined) {
        clearTimeout(this.#flushTimer);
        this.#flushTimer = undefined;
      }
      if (this.#inFlight !== undefined) await this.#inFlight.catch(() => undefined);
      await this.#flush();
    }
  }

  /** stdin bytes number `seq` (0, 1, …); null closes stdin. */
  async input(key: string, seq: number, data: Uint8Array | null): Promise<ProcessInputAnswer> {
    const proc = this.#procs.get(key);
    if (proc === undefined || proc.exited) return { ...this.#answer([key]), accepted: "unknown" };
    if (seq < proc.nextInSeq) return { ...this.#answer([]), accepted: "duplicate" };
    if (seq > proc.nextInSeq) {
      console.warn(JSON.stringify({ t3flare: "process-input-gap", key, expected: proc.nextInSeq, got: seq }));
      await this.signal(key);
      return { ...this.#answer([]), accepted: "gap" };
    }
    proc.nextInSeq++;
    const now = this.#deps.now();
    proc.lastInput = now;
    proc.lastIo = now;
    this.#lastInput = now;
    try {
      if (data === null) await proc.writer?.close();
      else await proc.writer?.write(data);
      return { ...this.#answer([]), accepted: "written" };
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "process-input-failed", key, error: String(error).slice(0, 200) }));
      await this.signal(key);
      return { ...this.#answer([]), accepted: "failed" };
    }
  }

  /** Whether the process's thread is in a turn (the adapter's wrapper says): the hold's clock. */
  turn(key: string, active: boolean): ProcessAnswer {
    const proc = this.#procs.get(key);
    if (proc === undefined || proc.exited) return this.#answer([key]);
    if (proc.inTurn && !active) proc.turnEndedAt = this.#deps.now();
    proc.inTurn = active;
    return this.#answer([]);
  }

  /** TERM, then KILL from 2 s (part 2's kill script on the marker); the exit frame follows. */
  async signal(key: string): Promise<ProcessAnswer> {
    const proc = this.#procs.get(key);
    if (proc === undefined || proc.exited) return this.#answer([key]);
    proc.killing = true;
    if (proc.process === undefined) return this.#answer([]); // still starting: killed once it runs
    if (!this.#deps.running()) {
      this.#exited(proc, 129);
      return this.#answer([]);
    }
    await this.#deps.kill([key]);
    return this.#answer([]);
  }

  heartbeat(keys: ReadonlyArray<string>): ProcessAnswer {
    const now = this.#deps.now();
    for (const key of keys) {
      const proc = this.#procs.get(key);
      if (proc !== undefined) proc.lastHeartbeat = now;
    }
    return this.#answer(keys);
  }

  /** Kills processes whose Environment stopped heartbeating, and those silent past the backstop. */
  async expire(): Promise<number> {
    const now = this.#deps.now();
    const lapsed = [...this.#procs.values()].filter(
      (proc) => !proc.exited && (now - proc.lastHeartbeat >= HEARTBEAT_LAPSE_MS || (!proc.inTurn && now - proc.lastIo >= BACKSTOP_MS)),
    );
    for (const proc of lapsed) {
      console.log(JSON.stringify({ t3flare: "process-expired", key: proc.key, heartbeatAgoMs: now - proc.lastHeartbeat, ioAgoMs: now - proc.lastIo }));
      await this.signal(proc.key);
    }
    return lapsed.length;
  }

  /** The Container stops (idle stop, destroy): every process ends with it. */
  containerStopped(): void {
    for (const proc of this.#procs.values()) if (!proc.exited) this.#exited(proc, 129);
  }

  #exited(proc: Proc, code: number): void {
    if (proc.exited) return;
    proc.exited = true;
    this.#frame(proc, { stream: "exit", code });
    this.#procs.delete(proc.key);
    this.#save();
    if (proc.marker.linked === true && proc.marker.thread !== undefined) this.#deps.linkedWork?.(proc.marker.thread, false);
    this.#deps.filesMayHaveChanged("exit");
    console.log(JSON.stringify({ t3flare: "process-exited", key: proc.key, code }));
    // What the CLI left in its session (a background server): part 2's kill script, never `ExecProcess.kill()`.
    if (proc.process !== undefined && this.#deps.running()) void this.#deps.kill([proc.key]).catch(() => undefined);
  }
}

/** For tests: text of a process's frames of one stream. */
export const textOf = (frames: ReadonlyArray<ProcessFrame>, key: string, stream: "stdout" | "stderr"): string => {
  const decoder = new TextDecoder();
  return frames
    .filter((frame) => frame.key === key && frame.stream === stream && frame.data !== undefined)
    .map((frame) => decoder.decode(frame.data, { stream: true }))
    .join("");
};

export const bytes = (text: string): Uint8Array => encoder.encode(text);
