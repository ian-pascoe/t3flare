// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off globalConsole:off
// The Workspace DO's CLI processes (step 4a, the process channel): `codex app-server` and `pi --mode rpc` under the
// platform's non-PTY exec in the Workspace's Container, their stdout and stderr kept as bytes until the Environment's
// spawner reads them (`read`, a long poll that is also the heartbeat), their stdin, signals and turns from the
// spawner. A sibling of `TerminalHost`, but pulled rather than pushed (see `read`).
//
// - Input is ordered by `seq`, one write at a time: a duplicate (a retried RPC) is acknowledged, a gap or a failed write
//   kills the process; nothing is ever skipped (review F6).
// - Output is never dropped: a batch stays until the next read acknowledges it; reading pauses while 1 MiB waits.
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
  ProcessReadAnswer,
  ProcessReadInput,
  ProcessStartAnswer,
  ProcessStartInput,
} from "@t3flare/workspace-client";

/** A process not heartbeaten for this long is killed (the spawner beats every 30 s). */
export const HEARTBEAT_LAPSE_MS = 90_000;
export const BATCH_MS = 16;
export const BATCH_BYTES = 64 * 1024;
/** A read answers at most about this many bytes (one frame more when a frame is bigger). */
export const READ_BYTES = 1024 * 1024;
/** Output with input in the last second is answered sooner (a request's answer). */
export const ECHO_WINDOW_MS = 1_000;
/** Reading pauses while this much waits to be read. */
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
  readonly beforeStart?: (input: ProcessStartInput) => Promise<{ readonly env?: Readonly<Record<string, string>>; readonly sandbox?: boolean } | void>;
}

/**
 * Step 4b: what a CLI process counts against the Workspace's cap, in Codex processes. Claude Code (its Node adapter and
 * `claude`) peaked at 344 MiB and OpenCode (`opencode acp` and its `serve` child) at 439 MiB in a turn running
 * `npm ci && npm test` (docs/steps/step-4b/m0-local.json P7), about twice an idle Codex app-server.
 */
export const CLI_WEIGHT: Readonly<Record<string, number>> = { claude: 2, opencode: 2 };
const weightOf = (cli: string) => CLI_WEIGHT[cli] ?? 1;

interface Proc {
  readonly key: string;
  readonly cli: string;
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
  /** The process's tool handle (ADR-0028), in memory only: gone with the process or this object. */
  readonly toolHandle: string | undefined;
}

/** Who a tool handle speaks for: a live CLI process of this Workspace. */
export interface ToolCaller {
  readonly key: string;
  readonly cli: string;
  readonly thread: string | null;
}

const encoder = new TextEncoder();

export class ProcessHost {
  readonly #deps: ProcessHostDeps;
  readonly #procs = new Map<string, Proc>();
  #pending: Array<ProcessFrame> = [];
  #pendingBytes = 0;
  /** The last batch read, until the next read acknowledges it. */
  #sent: { readonly batch: number; readonly frames: ReadonlyArray<ProcessFrame> } | undefined;
  #batch = 0;
  #readers: Array<() => void> = [];
  #drained: Array<() => void> = [];
  #reads = 0;
  #lastInput = 0;

  constructor(deps: ProcessHostDeps) {
    this.#deps = deps;
  }

  /** The live processes' weight against the cap (`CLI_WEIGHT`). */
  get weight(): number {
    return [...this.#procs.values()].filter((proc) => !proc.exited).reduce((sum, proc) => sum + weightOf(proc.cli), 0);
  }

  /** Live processes (not exited). */
  get size(): number {
    return [...this.#procs.values()].filter((proc) => !proc.exited).length;
  }

  /** Batches the Environment read (its pull). */
  get pushes(): number {
    return this.#reads;
  }

  keys(): ReadonlyArray<string> {
    return [...this.#procs.keys()];
  }

  /** The live process `handle` was issued to, or null (unknown, or its process exited: revoked with it). */
  toolCaller(handle: string | null): ToolCaller | null {
    if (handle === null || handle.length < 32) return null;
    for (const proc of this.#procs.values()) {
      if (proc.exited || proc.toolHandle === undefined || proc.toolHandle !== handle) continue;
      return { key: proc.key, cli: proc.cli, thread: proc.marker.thread ?? null };
    }
    return null;
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

  async start(input: ProcessStartInput & { readonly files?: ReadonlyArray<ProcessFile> }): Promise<ProcessStartAnswer> {
    const refuse = (reason: string): ProcessStartAnswer => ({ ok: false, epoch: this.#deps.epoch, reason });
    if (this.#procs.has(input.key)) return { ok: true, epoch: this.#deps.epoch };
    if (input.cli === "probe" && !this.#deps.allowProbe) return refuse("the probe program runs on test stages only");
    if (this.weight + weightOf(input.cli) > this.#deps.maxProcesses) return refuse(`this Workspace already runs ${this.size} CLI agent processes (Claude Code and OpenCode count twice); let one finish first`);
    if (!this.#deps.running()) {
      try {
        await this.#deps.startContainer();
      } catch (error) {
        return refuse(String(error instanceof Error ? error.message : error));
      }
    }
    await this.#killOthers(input.environmentEpoch);
    let extraEnv: Readonly<Record<string, string>> = {};
    let sandbox: boolean | undefined;
    try {
      const prepared = await this.#deps.beforeStart?.(input);
      extraEnv = prepared?.env ?? {};
      sandbox = prepared?.sandbox;
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
        ...(input.prune === undefined ? {} : { prune: input.prune }),
      });
    } catch (error) {
      return refuse(String(error instanceof Error ? error.message : error));
    }
    const now = this.#deps.now();
    const proc: Proc = {
      key: input.key,
      cli: input.cli,
      marker: {
        key: input.key,
        environmentEpoch: input.environmentEpoch,
        ...(input.thread === undefined ? {} : { thread: input.thread }),
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
      toolHandle: input.toolHandle !== undefined && /^[0-9a-f]{64}$/.test(input.toolHandle) ? input.toolHandle : undefined,
    };
    this.#procs.set(input.key, proc);
    this.#save();
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
      return refuse(`the process did not start: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`);
    }
    if (proc.killing) await this.#deps.kill([proc.key]);
    console.log(JSON.stringify({ t3flare: "process-started", key: input.key, cli: input.cli, thread: input.thread ?? null, environmentEpoch: input.environmentEpoch, sandbox: sandbox ?? null }));
    return { ok: true, epoch: this.#deps.epoch, ...(sandbox === undefined ? {} : { sandbox }) };
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
    if (frame.stream !== "exit") this.#deps.filesMayHaveChanged("output");
    for (const wake of this.#readers.splice(0)) wake();
  }

  /**
   * The Environment's read (pull, not push): frames since the last read it acknowledged, waiting up to `waitMs` for
   * some. The read is also the heartbeat of `keys`. The Workspace never calls the Environment for output: on step4a a
   * push answered inside the Environment's own input call nested each round trip one level deeper, until the
   * platform's subrequest depth limit ("Subrequest depth limit exceeded" at the eighth round trip, M1). A batch is kept
   * until the next read acknowledges it (`ack`), and sent again otherwise: never dropped.
   */
  async read(input: ProcessReadInput): Promise<ProcessReadAnswer> {
    const answer = this.heartbeat(input.keys);
    if (this.#sent !== undefined && input.ack !== this.#sent.batch) return { ...answer, batch: this.#sent.batch, frames: this.#sent.frames };
    this.#sent = undefined;
    if (this.#pending.length === 0 && input.waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, input.waitMs);
        this.#readers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      // A request's answer comes in pieces: gather them for a moment (sooner while input is recent).
      if (this.#pending.length > 0 && this.#pendingBytes < BATCH_BYTES) {
        await new Promise((resolve) => setTimeout(resolve, this.#deps.now() - this.#lastInput < ECHO_WINDOW_MS ? BATCH_MS : BATCH_MS * 2));
      }
    }
    const frames: Array<ProcessFrame> = [];
    let bytes = 0;
    while (this.#pending.length > 0 && (frames.length === 0 || bytes < READ_BYTES)) {
      const frame = this.#pending.shift()!;
      frames.push(frame);
      bytes += frame.data?.byteLength ?? 16;
    }
    this.#pendingBytes -= bytes;
    for (const resolve of this.#drained.splice(0)) resolve();
    if (frames.length === 0) return { ...answer, batch: 0, frames };
    this.#reads++;
    this.#sent = { batch: ++this.#batch, frames };
    return { ...answer, batch: this.#batch, frames };
  }

  /** Frames waiting for the Environment's next read (tests, and the stop's last look). */
  pendingFrames(): ReadonlyArray<ProcessFrame> {
    return [...(this.#sent?.frames ?? []), ...this.#pending];
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
    if (proc.inTurn && !active) {
      proc.turnEndedAt = this.#deps.now();
      // A turn ended: its session file and edits come into the DO now, not at the next quiet pull (a deploy or a
      // crash can take the Container before that).
      this.#deps.filesMayHaveChanged("exit");
    }
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

  /**
   * Ends every process before the Container stops (TERM, then KILL from 2 s, by marker) and waits for their exits, so
   * a CLI flushes its session file and the stop's pull takes it (M5 on step4a: a Codex rollout not yet written when
   * the Container went could not be resumed).
   */
  async stopAll(timeoutMs = 8000): Promise<number> {
    const keys = [...this.#procs.values()].filter((proc) => !proc.exited).map((proc) => proc.key);
    if (keys.length === 0) return 0;
    await Promise.all(keys.map((key) => this.signal(key).catch(() => undefined)));
    const deadline = this.#deps.now() + timeoutMs;
    while (this.size > 0 && this.#deps.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    return keys.length;
  }

  heartbeat(keys: ReadonlyArray<string>): ProcessAnswer {
    const now = this.#deps.now();
    for (const key of keys) {
      const proc = this.#procs.get(key);
      if (proc !== undefined) proc.lastHeartbeat = now;
    }
    // A key the Environment holds but this instance does not: an earlier instance's process, still running.
    if (keys.some((key) => !this.#procs.has(key))) void this.killOrphans().catch(() => undefined);
    return this.#answer(keys);
  }

  /** Kills processes an earlier instance of this object started (their handles went with it); by stored markers. */
  async killOrphans(): Promise<number> {
    if (!this.#deps.running()) return 0;
    const orphans = this.#deps.remembered().filter((marker) => !this.#procs.has(marker.key));
    if (orphans.length === 0) return 0;
    console.log(JSON.stringify({ t3flare: "process-orphans-killed", count: orphans.length }));
    await this.#deps.kill(orphans.map((marker) => marker.key));
    this.#save();
    return orphans.length;
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
