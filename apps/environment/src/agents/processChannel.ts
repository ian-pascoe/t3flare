// @effect-diagnostics globalTimers:off globalConsole:off globalDate:off extendsNativeError:off
// The Environment's half of the process channel (step 4a, ADR-0015's refinement): a CLI process t3 spawns runs in a
// Workspace's Container (the Workspace DO's `ProcessHost`); here it is a handle t3's code reads and writes.
//
// - One instance per Environment DO instance (review F6): its handles and pids are never module state, which outlives
//   `ctx.abort()` in a warm isolate. It is bound with the Environment's services and reached through them.
// - stdin: one `processInput` in flight per process, numbered without gaps; a lost answer is retried with the same
//   number (the host acknowledges a duplicate); a refused or failed write ends the process, never skips bytes.
// - stdout and stderr: bounded queues of bytes, filled by one read loop per Workspace (a long poll, `processRead`: the
//   Environment pulls, so every call between the two objects starts here). `deliver` awaits room in stdout's queue, so
//   a slow reader delays the next read, and the Workspace pauses its reads of the process (backpressure end to end).
//   stderr is diagnostics: when nobody reads it, its oldest bytes are dropped past its bound, so it never stalls stdout.
// - The Workspace DO's epoch (its boot counter) is the one its start answered; another in any answer, or the key
//   unknown, ends the process with 129: the Workspace restarted and its processes went with it.
// - pids are synthetic and unique per instance (> 1: t3's `signalProcessGroup` refuses `pid <= 1`).
import type {
  ProcessAnswer,
  ProcessCli,
  ProcessFrame,
  ProcessInputAnswer,
  ProcessReadAnswer,
  ProcessReadInput,
  ProcessStartAnswer,
  ProcessStartInput,
} from "@t3flare/workspace-client";

/** A read waits this long for output; it is also the processes' heartbeat (the Workspace kills them after 90 s without). */
export const READ_WAIT_MS = 20_000;
/** Reads that fail in a row before a Workspace's processes end here (the Workspace's lapse kills them there). */
export const READ_FAILURES = 4;
/** stdin is sent in pieces of at most this many bytes (a `data:` image can be several MB). */
export const INPUT_PIECE_BYTES = 1024 * 1024;
/** A queue's bound: stdout waits past it; stderr drops its oldest past it. */
export const QUEUE_BYTES = 4 * 1024 * 1024;
/** A lost `processInput` answer is retried this many times with the same seq before the process is ended. */
const INPUT_RETRIES = 3;

/** The Workspace DO's process RPCs, as much as the channel uses. */
export interface ProcessRemote {
  processStart(input: ProcessStartInput): Promise<ProcessStartAnswer>;
  processInput(key: string, seq: number, data: Uint8Array | null): Promise<ProcessInputAnswer>;
  processTurn(key: string, active: boolean): Promise<ProcessAnswer>;
  processSignal(key: string): Promise<ProcessAnswer>;
  processHeartbeat(keys: ReadonlyArray<string>): Promise<ProcessAnswer>;
  processRead(input: ProcessReadInput): Promise<ProcessReadAnswer>;
}

export interface ProcessPlace {
  readonly workspace: string;
  /** `/w/<id>`. */
  readonly t3Path: string;
  readonly remote: ProcessRemote;
}

export class ProcessRefused extends Error {}

/** A queue of byte chunks, bounded by bytes; `null` from `take` is the end. */
export class ByteQueue {
  readonly #limit: number;
  readonly #mode: "wait" | "drop-oldest";
  #chunks: Array<Uint8Array> = [];
  #bytes = 0;
  #ended = false;
  #takers: Array<(chunk: Uint8Array | null) => void> = [];
  #room: Array<() => void> = [];
  dropped = 0;

  constructor(limit: number, mode: "wait" | "drop-oldest") {
    this.#limit = limit;
    this.#mode = mode;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** Adds a chunk; with "wait", resolves once there is room for it. */
  async offer(chunk: Uint8Array): Promise<void> {
    if (this.#ended) return;
    const taker = this.#takers.shift();
    if (taker !== undefined) {
      taker(chunk);
      return;
    }
    if (this.#mode === "wait") {
      while (this.#bytes > 0 && this.#bytes + chunk.byteLength > this.#limit && !this.#ended) await new Promise<void>((resolve) => this.#room.push(resolve));
      if (this.#ended) return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    if (this.#mode === "drop-oldest") {
      while (this.#bytes > this.#limit && this.#chunks.length > 1) {
        const old = this.#chunks.shift()!;
        this.#bytes -= old.byteLength;
        this.dropped += old.byteLength;
      }
    }
  }

  take(): Promise<Uint8Array | null> {
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) {
      this.#bytes -= chunk.byteLength;
      for (const resolve of this.#room.splice(0)) resolve();
      return Promise.resolve(chunk);
    }
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve) => this.#takers.push(resolve));
  }

  end(): void {
    this.#ended = true;
    for (const taker of this.#takers.splice(0)) taker(null);
    for (const resolve of this.#room.splice(0)) resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = await this.take();
      if (chunk === null) return;
      yield chunk;
    }
  }
}

const encoder = new TextEncoder();

/** One CLI process in a Workspace's Container, as t3's handle sees it. */
export class ChannelProcess {
  readonly key: string;
  readonly pid: number;
  readonly place: ProcessPlace;
  readonly cli: ProcessCli;
  readonly stdout = new ByteQueue(QUEUE_BYTES, "wait");
  readonly stderr = new ByteQueue(QUEUE_BYTES, "drop-oldest");
  readonly exit: Promise<number>;
  readonly #channel: ProcessChannel;
  #resolveExit!: (code: number) => void;
  #epoch: number | undefined;
  #nextFrame = 0;
  #nextInput = 0;
  #writes: Promise<void> = Promise.resolve();
  #killSent = false;
  exitCode: number | undefined;

  constructor(channel: ProcessChannel, pid: number, key: string, place: ProcessPlace, cli: ProcessCli) {
    this.#channel = channel;
    this.pid = pid;
    this.key = key;
    this.place = place;
    this.cli = cli;
    this.exit = new Promise((resolve) => (this.#resolveExit = resolve));
  }

  get epoch(): number | undefined {
    return this.#epoch;
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  /** Whether Codex's sandbox (bubblewrap) works in this process's Container; undefined when not probed. */
  sandbox: boolean | undefined;

  started(epoch: number, sandbox?: boolean): void {
    this.#epoch = epoch;
    this.sandbox = sandbox;
  }

  /** An answer from the Workspace DO: another instance, or this key unknown, ends the process. */
  checkAnswer(answer: ProcessAnswer): void {
    if (this.exitCode !== undefined) return;
    if ((this.#epoch !== undefined && answer.epoch !== this.#epoch) || answer.unknown.includes(this.key)) {
      void this.stderr.offer(encoder.encode("t3flare: the Workspace restarted; this process is gone\n"));
      this.finish(129);
    }
  }

  /** Queues stdin bytes, in pieces, after every earlier write. */
  write(chunk: Uint8Array): Promise<void> {
    const pieces: Array<Uint8Array> = [];
    for (let at = 0; at < chunk.byteLength; at += INPUT_PIECE_BYTES) pieces.push(chunk.subarray(at, Math.min(chunk.byteLength, at + INPUT_PIECE_BYTES)));
    for (const piece of pieces) this.#writes = this.#writes.then(() => this.#send(piece));
    return this.#writes;
  }

  /** Closes stdin after every earlier write. */
  closeStdin(): Promise<void> {
    this.#writes = this.#writes.then(() => this.#send(null));
    return this.#writes;
  }

  async #send(data: Uint8Array | null): Promise<void> {
    if (this.exitCode !== undefined) return;
    const seq = this.#nextInput++;
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await this.place.remote.processInput(this.key, seq, data);
        this.checkAnswer(answer);
        if (answer.accepted === "written" || answer.accepted === "duplicate") return;
        // gap, failed, unknown: the host ended (or never had) the process; its exit frame may never come.
        console.warn(JSON.stringify({ t3flare: "process-input-refused", key: this.key, accepted: answer.accepted }));
        this.finish(129);
        return;
      } catch (error) {
        if (attempt >= INPUT_RETRIES) {
          console.warn(JSON.stringify({ t3flare: "process-input-failed", key: this.key, error: String(error).slice(0, 200) }));
          this.kill();
          this.finish(129);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  }

  /** TERM then KILL by marker in the Container (one RPC); the exit frame follows. */
  kill(): void {
    if (this.exitCode !== undefined || this.#killSent) return;
    this.#killSent = true;
    this.place.remote
      .processSignal(this.key)
      .then((answer) => this.checkAnswer(answer))
      .catch((error: unknown) => {
        console.warn(JSON.stringify({ t3flare: "process-signal-failed", key: this.key, error: String(error).slice(0, 200) }));
        this.finish(129);
      });
  }

  /** The thread's turn started or ended: the Workspace's hold of the Container (review F7). */
  turn(active: boolean): void {
    if (this.exitCode !== undefined) return;
    this.place.remote
      .processTurn(this.key, active)
      .then((answer) => this.checkAnswer(answer))
      .catch(() => undefined);
  }

  /** A frame of this process's, in the Workspace's order; awaits room in stdout's queue. */
  async frame(frame: ProcessFrame): Promise<void> {
    if (this.exitCode !== undefined || frame.seq < this.#nextFrame) return;
    this.#nextFrame = frame.seq + 1;
    if (frame.stream === "stdout" && frame.data !== undefined) await this.stdout.offer(frame.data);
    else if (frame.stream === "stderr" && frame.data !== undefined) await this.stderr.offer(frame.data);
    else if (frame.stream === "exit") this.finish(frame.code ?? 129);
  }

  finish(code: number): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.#channel.forget(this);
    this.#resolveExit(code);
  }
}

export interface ProcessChannelDeps {
  /** The Environment DO's boot counter. */
  readonly environmentEpoch: number;
  /** The Workspace of a t3 path, when listed and ready. */
  readonly place: (cwd: string) => ProcessPlace | undefined;
  readonly newKey: () => string;
}

export interface ChannelStart {
  readonly cli: ProcessCli;
  readonly cwd: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly files?: ProcessStartInput["files"];
  readonly links?: ReadonlyArray<{ readonly path: string; readonly target: string }>;
  readonly prune?: ProcessStartInput["prune"];
  readonly thread?: string;
  readonly linked?: boolean;
  /** Made by the caller when it needs the key before the start (the profile's per-process home). */
  readonly key?: string;
}

/** Every CLI process of this Environment DO instance: the spawner's state, and its Workspaces' readers. */
export class ProcessChannel {
  readonly #deps: ProcessChannelDeps;
  readonly #byKey = new Map<string, ChannelProcess>();
  readonly #byPid = new Map<number, ChannelProcess>();
  #nextPid = 200_000;
  /** Workspaces with a read loop running. */
  readonly #readers = new Set<string>();

  constructor(deps: ProcessChannelDeps) {
    this.#deps = deps;
  }

  get environmentEpoch(): number {
    return this.#deps.environmentEpoch;
  }

  get size(): number {
    return this.#byKey.size;
  }

  newKey(): string {
    return this.#deps.newKey();
  }

  /** Where `cwd` runs, or undefined (no Workspace: the caller refuses). */
  placeOf(cwd: string): ProcessPlace | undefined {
    return this.#deps.place(cwd);
  }

  /** Starts a process; resolves once it runs in the Container, or rejects with the Workspace's reason. */
  async start(input: ChannelStart): Promise<ChannelProcess> {
    const place = this.#deps.place(input.cwd);
    if (place === undefined) throw new ProcessRefused(`${input.cli === "pi" ? "Pi" : "Codex"} runs in a Workspace's Container, and ${input.cwd} is in none; start the thread in a project`);
    const key = input.key ?? this.#deps.newKey();
    const process = new ChannelProcess(this, this.#nextPid++, key, place, input.cli);
    this.#byKey.set(key, process);
    this.#byPid.set(process.pid, process);
    let answer: ProcessStartAnswer;
    try {
      answer = await place.remote.processStart({
        key,
        environmentEpoch: this.#deps.environmentEpoch,
        cli: input.cli,
        t3Path: place.t3Path,
        cwd: input.cwd,
        argv: input.argv,
        env: input.env,
        ...(input.files === undefined ? {} : { files: input.files }),
        ...(input.links === undefined ? {} : { links: input.links }),
        ...(input.prune === undefined ? {} : { prune: input.prune }),
        ...(input.thread === undefined ? {} : { thread: input.thread }),
        ...(input.linked === true ? { linked: true } : {}),
      });
    } catch (error) {
      process.finish(129);
      throw new ProcessRefused(`the Workspace did not start the process: ${String(error).slice(0, 300)}`);
    }
    if (!answer.ok) {
      process.finish(1);
      throw new ProcessRefused(answer.reason);
    }
    process.started(answer.epoch, answer.sandbox);
    this.#ensureReader(place);
    return process;
  }

  /** Frames a read brought: each to its process, in order, awaiting the readers' room (backpressure to the Workspace). */
  async deliver(epoch: number, frames: ReadonlyArray<ProcessFrame>): Promise<void> {
    for (const frame of frames) {
      const process = this.#byKey.get(frame.key);
      if (process === undefined || (process.epoch !== undefined && process.epoch !== epoch)) continue;
      await process.frame(frame);
    }
  }

  byPid(pid: number): ChannelProcess | undefined {
    return this.#byPid.get(pid);
  }

  forget(process: ChannelProcess): void {
    this.#byKey.delete(process.key);
    this.#byPid.delete(process.pid);
  }

  /** Ends every process (the Environment is going away): the Workspaces kill them when their reads (heartbeats) lapse otherwise. */
  killAll(): void {
    for (const process of this.#byKey.values()) process.kill();
  }

  /** The processes of one Workspace here, started or starting. */
  #inWorkspace(workspace: string): ReadonlyArray<ChannelProcess> {
    return [...this.#byKey.values()].filter((process) => process.place.workspace === workspace);
  }

  #ensureReader(place: ProcessPlace): void {
    if (this.#readers.has(place.workspace)) return;
    this.#readers.add(place.workspace);
    void this.#readLoop(place);
  }

  /**
   * One long poll at a time per Workspace while it has processes here (`processRead`, which is also their heartbeat):
   * the Environment pulls, so every call between the two objects starts on this side (see ProcessReadInput).
   */
  async #readLoop(place: ProcessPlace): Promise<void> {
    let ack = 0;
    let failures = 0;
    for (;;) {
      const processes = this.#inWorkspace(place.workspace);
      if (processes.length === 0) {
        this.#readers.delete(place.workspace);
        return;
      }
      const started = processes.filter((process) => process.epoch !== undefined);
      let answer: ProcessReadAnswer;
      try {
        answer = await place.remote.processRead({ keys: started.map((process) => process.key), ack, waitMs: READ_WAIT_MS });
        failures = 0;
      } catch (error) {
        failures++;
        console.warn(JSON.stringify({ t3flare: "process-read-failed", workspace: place.workspace, failures, error: String(error).slice(0, 200) }));
        if (failures >= READ_FAILURES) {
          for (const process of this.#inWorkspace(place.workspace)) process.finish(129);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 250 * 2 ** failures)));
        continue;
      }
      if (answer.batch !== 0) ack = answer.batch;
      for (const process of started) process.checkAnswer(answer);
      await this.deliver(answer.epoch, answer.frames);
    }
  }
}
