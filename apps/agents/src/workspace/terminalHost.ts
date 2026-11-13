// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off globalConsole:off
// The Workspace DO's terminals (step 2b, ADR-0021): shells under the platform's PTY exec in the Workspace's Container,
// their output pushed to the Environment DO in batches, their input, size and close from the Environment's PTY adapter.
//
// - Signals never use `ExecProcess.kill()` (review F2: it raises after the process exited): a close runs part 2's kill
//   script on the terminal's marker, which also takes what the shell left in its session.
// - The rc file's markers (sandbox-image `terminal.ts`) are stripped here: they say whether a command runs in the
//   foreground (t3's subprocess inspector, review F1), release the input typed before the first prompt, and trigger a
//   pull of the Container's files when a prompt returns.
// - A terminal the Environment stops heartbeating for `HEARTBEAT_LAPSE_MS`, or names unknown in a push's answer, is
//   killed: its Environment restarted or is gone (D1: terminals end with their Environment).
// - Only input is use (review F10): the Container's terminal hold is measured from the last input. Opening is not input
//   (cost audit F1): t3 re-attaches every open panel after an Environment restart, so an open must not hold the
//   Container. A shell at its prompt holds it for less than one running a foreground command.
import { scanMarkers, terminalCommand } from "@t3flare/sandbox-image/terminal";
import type { TerminalAnswer, TerminalFrame, TerminalOpenInput, TerminalPush, TerminalPushAnswer } from "@t3flare/workspace-client";

/** A terminal not heartbeaten for this long is killed (the adapter beats every 30 s). */
export const HEARTBEAT_LAPSE_MS = 90_000;
/** A batch closes after this long or this many bytes. */
export const BATCH_MS = 16;
export const BATCH_BYTES = 32 * 1024;
/** Output with no input in the last `ECHO_WINDOW_MS` waits longer for its batch: fewer pushes (cost audit F4). */
export const BULK_BATCH_MS = 100;
export const ECHO_WINDOW_MS = 1_000;
/** Reading a shell's output pauses while this much waits to be pushed. */
export const BACKPRESSURE_BYTES = 1024 * 1024;
/** Input typed before the first prompt is held at most this long. */
export const FIRST_PROMPT_WAIT_MS = 20_000;
/** At most this many terminals per Workspace (the DO's in-memory handles). */
export const MAX_TERMINALS = 8;

/** The part of the platform's `ExecProcess` used here. */
export interface ShellProcess {
  readonly stdin: WritableStream | null;
  readonly stdout: ReadableStream | null;
  readonly exitCode: Promise<number>;
  resize(cols: number, rows: number): void;
}

export interface TerminalHostDeps {
  readonly now: () => number;
  /** Whether the Container runs (`ctx.container.running`). */
  readonly running: () => boolean;
  /** Starts the Container through computer (the budget's lease); throws with the reason when refused. */
  readonly startContainer: () => Promise<void>;
  /** `ctx.container.exec` with a PTY. */
  readonly spawn: (argv: ReadonlyArray<string>, options: { readonly cols: number; readonly rows: number; readonly env: Record<string, string> }) => Promise<ShellProcess>;
  /** Part 2's kill script on markers, in the Container; nothing when it is not running. */
  readonly kill: (markers: ReadonlyArray<string>) => Promise<void>;
  /** Pushes a batch to the Environment DO. */
  readonly push: (push: Omit<TerminalPush, "workspace">) => Promise<TerminalPushAnswer>;
  /** The base env of a shell: the image's command env without `BASH_ENV`. */
  readonly baseEnv: Readonly<Record<string, string>>;
  /** A prompt returned, or a shell exited: the files may have changed. */
  readonly filesMayHaveChanged: (why: "prompt" | "exit" | "output") => void;
  /** Markers of shells this object started, kept in storage to find orphans after a restart. */
  readonly remember: (markers: ReadonlyArray<string>) => void;
  readonly remembered: () => ReadonlyArray<string>;
  readonly epoch: string;
  /** Brings the DO's pending writes into a running Container before a shell starts (a worktree's project-root view). */
  readonly beforeSpawn: () => Promise<void>;
  /** Where a worktree's project-root view is, in the Workspace. */
  readonly projectRootView: string;
  /**
   * Whether input typed before the shell's first prompt waits for it (t3's shells). An agent's Terminal runs a command,
   * not the rc file's prompt, so its input goes at once (SPI-1057).
   */
  readonly holdFirstInput?: boolean;
}

interface Terminal {
  readonly key: string;
  process: ShellProcess | undefined;
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  seq: number;
  busy: boolean;
  prompted: boolean;
  held: Array<string>;
  heldSince: number;
  carry: string;
  lastHeartbeat: number;
  exited: boolean;
  /** The adapter closed it: no exit frame needed beyond the one the exit sends. */
  closing: boolean;
}

const encoder = new TextEncoder();

export class TerminalHost {
  readonly #deps: TerminalHostDeps;
  readonly #terminals = new Map<string, Terminal>();
  #pending: Array<TerminalFrame> = [];
  #pendingBytes = 0;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #flushDue = 0;
  #inFlight: Promise<void> | undefined;
  #drained: Array<() => void> = [];
  #lastInput = 0;
  #pushFailures = 0;
  #pushes = 0;
  #orphansChecked = false;

  constructor(deps: TerminalHostDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#terminals.size;
  }

  /** When input was last typed into any terminal; 0 when never. */
  get lastInput(): number {
    return this.#lastInput;
  }

  /** Whether open terminals hold the Container now: `busyMs` from the last input while a command runs, else `promptMs`. */
  holdsContainer(hold: { readonly promptMs: number; readonly busyMs: number }): boolean {
    const open = [...this.#terminals.values()].filter((terminal) => !terminal.exited);
    if (open.length === 0) return false;
    const ms = open.some((terminal) => terminal.busy) ? hold.busyMs : hold.promptMs;
    return this.#deps.now() - this.#lastInput < ms;
  }

  /** Batches pushed to the Environment since this object started (cost audit F4's check). */
  get pushes(): number {
    return this.#pushes;
  }

  keys(): ReadonlyArray<string> {
    return [...this.#terminals.keys()];
  }

  #answer(keys: ReadonlyArray<string>): TerminalAnswer {
    return { epoch: this.#deps.epoch, unknown: keys.filter((key) => !this.#terminals.has(key)) };
  }

  /** Kills shells an earlier instance of this object started and lost (its handles went with it). */
  async #killOrphans(): Promise<void> {
    if (this.#orphansChecked || !this.#deps.running()) return;
    this.#orphansChecked = true;
    const orphans = this.#deps.remembered().filter((marker) => !this.#terminals.has(marker));
    if (orphans.length > 0) {
      console.log(JSON.stringify({ t3flare: "terminal-orphans", count: orphans.length }));
      await this.#deps.kill(orphans);
    }
    this.#deps.remember(this.keys());
  }

  async open(input: TerminalOpenInput): Promise<TerminalAnswer> {
    const now = this.#deps.now();
    if (this.#terminals.has(input.key)) return this.#answer([]);
    const terminal: Terminal = {
      key: input.key,
      process: undefined,
      writer: undefined,
      seq: 0,
      busy: false,
      prompted: false,
      held: [],
      heldSince: now,
      carry: "",
      lastHeartbeat: now,
      exited: false,
      closing: false,
    };
    if (this.#terminals.size >= MAX_TERMINALS) {
      this.#terminals.set(input.key, terminal);
      this.#refuse(terminal, `this Workspace already has ${MAX_TERMINALS} open terminals; close one first`);
      return this.#answer([]);
    }
    this.#terminals.set(input.key, terminal);
    if (!this.#deps.running()) {
      this.#frame(terminal, { data: "\x1b[2mStarting the Workspace's Container…\x1b[0m\r\n" });
      try {
        await this.#deps.startContainer();
      } catch (error) {
        this.#refuse(terminal, String(error instanceof Error ? error.message : error));
        return this.#answer([]);
      }
    }
    if (terminal.exited) return this.#answer([]);
    await this.#killOrphans().catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "terminal-orphans-failed", error: String(error) })));
    await this.#deps.beforeSpawn().catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "terminal-push-before-spawn-failed", error: String(error).slice(0, 300) })));
    try {
      const command = terminalCommand({
        marker: input.key,
        t3Path: input.t3Path,
        cwd: input.cwd,
        ...(input.projectRoot === undefined ? {} : { projectRoot: { t3Path: input.projectRoot, view: this.#deps.projectRootView } }),
        ...(input.command === undefined ? {} : { command: input.command }),
      });
      const process = await this.#deps.spawn(["bash", "-c", command], {
        cols: input.cols,
        rows: input.rows,
        env: { ...this.#deps.baseEnv, ...input.env, T3FLARE_EXEC: input.key },
      });
      terminal.process = process;
      terminal.writer = process.stdin?.getWriter() as WritableStreamDefaultWriter<Uint8Array> | undefined;
      terminal.heldSince = this.#deps.now();
      this.#deps.remember(this.keys());
      void this.#read(terminal);
      void process.exitCode.then(
        (code) => this.#exited(terminal, code),
        () => this.#exited(terminal, 129),
      );
      if (terminal.closing) await this.#deps.kill([terminal.key]);
    } catch (error) {
      this.#refuse(terminal, `the shell did not start: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`);
    }
    return this.#answer([]);
  }

  #refuse(terminal: Terminal, reason: string): void {
    this.#frame(terminal, { data: `\x1b[31mt3flare: ${reason}\x1b[0m\r\n` });
    this.#exited(terminal, 1);
  }

  async #read(terminal: Terminal): Promise<void> {
    const reader = terminal.process?.stdout?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        while (this.#pendingBytes >= BACKPRESSURE_BYTES) await new Promise<void>((resolve) => this.#drained.push(resolve));
        const { done, value } = await reader.read();
        if (done) break;
        this.#output(terminal, decoder.decode(value as Uint8Array, { stream: true }));
      }
      const rest = decoder.decode();
      if (rest !== "" || terminal.carry !== "") this.#output(terminal, rest, true);
    } catch {
      // The stream ends with the process (or the Container).
    }
  }

  #output(terminal: Terminal, chunk: string, final = false): void {
    const scanned = scanMarkers(terminal.carry, chunk);
    terminal.carry = final ? "" : scanned.carry;
    const text = final ? scanned.text + scanned.carry : scanned.text;
    if (scanned.busy !== undefined) terminal.busy = scanned.busy;
    if (text !== "" || scanned.busy !== undefined) {
      this.#frame(terminal, { ...(text === "" ? {} : { data: text }), ...(scanned.busy === undefined ? {} : { busy: scanned.busy }) });
    }
    if (scanned.prompts > 0) {
      if (!terminal.prompted) {
        terminal.prompted = true;
        this.#release(terminal);
      }
      this.#deps.filesMayHaveChanged("prompt");
    } else if (text !== "") this.#deps.filesMayHaveChanged("output");
  }

  #frame(terminal: Terminal, frame: Omit<TerminalFrame, "key" | "seq">): void {
    const full: TerminalFrame = { key: terminal.key, seq: terminal.seq++, ...frame };
    this.#pending.push(full);
    this.#pendingBytes += frame.data?.length ?? 16;
    this.#flushSoon(this.#pendingBytes >= BATCH_BYTES ? 0 : this.#typing() ? BATCH_MS : BULK_BATCH_MS);
  }

  /** Input within the echo window: output is pushed promptly, so the echo of a keystroke shows at once. */
  #typing(): boolean {
    return this.#deps.now() - this.#lastInput < ECHO_WINDOW_MS;
  }

  #flushSoon(ms: number): void {
    if (this.#inFlight !== undefined) return; // the push in flight flushes again when it ends
    const due = Date.now() + ms;
    if (this.#flushTimer !== undefined) {
      if (due >= this.#flushDue) return; // an earlier flush is already armed
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
      let answer: TerminalPushAnswer;
      try {
        answer = await this.#deps.push({ epoch: this.#deps.epoch, frames });
        this.#pushFailures = 0;
        this.#pushes++;
      } catch (error) {
        // Never dropped: a lost frame could be a setup script's sentinel. The batch goes back in front and is tried
        // again, backing off to 5 s; a terminal whose Environment is gone ends by the heartbeat's lapse.
        this.#pushFailures++;
        console.warn(JSON.stringify({ t3flare: "terminal-push-failed", attempt: this.#pushFailures, frames: frames.length, error: String(error).slice(0, 300) }));
        this.#pending = [...frames, ...this.#pending];
        this.#pendingBytes += frames.reduce((sum, frame) => sum + (frame.data?.length ?? 16), 0);
        await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 100 * 2 ** Math.min(this.#pushFailures, 6))));
        return;
      }
      // An Environment that does not know a terminal restarted or closed it: nobody reads the shell any more.
      for (const key of answer.unknown) {
        const terminal = this.#terminals.get(key);
        if (terminal !== undefined && !terminal.exited) {
          console.log(JSON.stringify({ t3flare: "terminal-unknown-to-environment", key }));
          void this.close(key);
        }
      }
    })();
    try {
      await this.#inFlight;
    } finally {
      this.#inFlight = undefined;
      for (const resolve of this.#drained.splice(0)) resolve();
      // What came in meanwhile goes at once while typing or past a batch's bytes, else in the next 100 ms batch.
      if (this.#pending.length > 0) this.#flushSoon(this.#pendingBytes >= BATCH_BYTES || this.#typing() ? 0 : BULK_BATCH_MS);
    }
  }

  /** Waits until every frame so far was pushed (tests, and before an idle stop). */
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

  #release(terminal: Terminal): void {
    const held = terminal.held.splice(0);
    for (const data of held) void this.#write(terminal, data);
  }

  async #write(terminal: Terminal, data: string): Promise<void> {
    try {
      await terminal.writer?.write(encoder.encode(data));
    } catch {
      // The shell is gone; its exit is on its way.
    }
  }

  async input(key: string, data: string): Promise<TerminalAnswer> {
    const terminal = this.#terminals.get(key);
    if (terminal === undefined || terminal.exited) return this.#answer([key]);
    this.#lastInput = this.#deps.now();
    if (this.#deps.holdFirstInput !== false && !terminal.prompted && this.#deps.now() - terminal.heldSince < FIRST_PROMPT_WAIT_MS) {
      terminal.held.push(data);
      return this.#answer([]);
    }
    if (terminal.held.length > 0) this.#release(terminal);
    await this.#write(terminal, data);
    return this.#answer([]);
  }

  resize(key: string, cols: number, rows: number): TerminalAnswer {
    const terminal = this.#terminals.get(key);
    if (terminal === undefined || terminal.exited) return this.#answer([key]);
    try {
      terminal.process?.resize(cols, rows);
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "terminal-resize-failed", error: String(error).slice(0, 200) }));
    }
    return this.#answer([]);
  }

  /** Kills the shell and what it started (part 2's kill script on its marker); its exit frame follows. */
  async close(key: string): Promise<TerminalAnswer> {
    const terminal = this.#terminals.get(key);
    if (terminal === undefined || terminal.exited) return this.#answer([key]);
    terminal.closing = true;
    if (terminal.process === undefined) return this.#answer([]); // still opening: killed once it starts
    if (!this.#deps.running()) {
      this.#exited(terminal, 129);
      return this.#answer([]);
    }
    await this.#deps.kill([key]);
    return this.#answer([]);
  }

  /** The adapter's liveness for `keys`; answers the keys this object does not hold. */
  heartbeat(keys: ReadonlyArray<string>): TerminalAnswer {
    const now = this.#deps.now();
    for (const key of keys) {
      const terminal = this.#terminals.get(key);
      if (terminal !== undefined) terminal.lastHeartbeat = now;
    }
    return this.#answer(keys);
  }

  /** Kills terminals whose Environment stopped heartbeating; run on a timer and from the alarm. */
  async expire(): Promise<number> {
    const now = this.#deps.now();
    const lapsed = [...this.#terminals.values()].filter((terminal) => !terminal.exited && now - terminal.lastHeartbeat >= HEARTBEAT_LAPSE_MS);
    for (const terminal of lapsed) {
      console.log(JSON.stringify({ t3flare: "terminal-heartbeat-lapsed", key: terminal.key }));
      await this.close(terminal.key);
    }
    return lapsed.length;
  }

  /** The Container stops (idle stop, destroy): every shell ends with it. */
  containerStopped(): void {
    for (const terminal of this.#terminals.values()) {
      if (!terminal.exited) {
        this.#frame(terminal, { data: "\r\n\x1b[2mThe Workspace's Container stopped.\x1b[0m\r\n" });
        this.#exited(terminal, 129);
      }
    }
  }

  #exited(terminal: Terminal, code: number): void {
    if (terminal.exited) return;
    terminal.exited = true;
    if (terminal.carry !== "") this.#frame(terminal, { data: terminal.carry });
    terminal.carry = "";
    this.#frame(terminal, { busy: false, exit: { code } });
    this.#terminals.delete(terminal.key);
    this.#deps.remember(this.keys());
    this.#deps.filesMayHaveChanged("exit");
    // What the shell left in its session (a `sleep 600 &`): part 2's kill script, never `ExecProcess.kill()`.
    if (terminal.process !== undefined && this.#deps.running()) {
      void this.#deps.kill([terminal.key]).catch(() => undefined);
    }
  }
}
