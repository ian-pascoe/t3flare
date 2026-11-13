// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off newPromise:off
// The agent's Terminals and Background jobs (SPI-1057), the Workspace DO's half: pi-termctrl's Terminals
// (ian-pascoe/pi-extensions@a5e15d1:packages/pi-termctrl, `termctrl-registry.ts` and the termctrl driver's screen) as
// PTYs in the Workspace's Container. They run under a second `TerminalHost` (ADR-0021's host: the platform's PTY exec,
// markers, the kill script, the Container's hold measured from input), whose output feeds a headless xterm per entry
// here instead of t3's terminal adapter: the Workspace DO renders the screen, as termctrl's driver does, and answers the
// Session's tools with it.
//
// Adapted, not redesigned:
// - termctrl's driver process is the xterm here; its `status`/`screen.capture`/`logs` are `view()`;
// - the settle wait (`terminal-tools.ts` `settleTerminal`) runs here, in slices, so a wait is a few RPCs, not one per poll;
// - entries are kept per owner (the Session that started them); ids `t<n>`/`b<n>` count per owner and are never reused;
// - at most `MAX_LIVE` run at once in a Workspace (ADR-0021's 8, not termctrl's 16); exited ones stay readable until
//   stopped, as in termctrl, up to `MAX_KEPT` per owner;
// - they end when the Container stops, as t3's terminals do, and when this object restarts (a deploy).
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type {
  AgentCursor,
  AgentEntryInfo,
  AgentEntryKind,
  AgentExit,
  AgentSettleReason,
  AgentTerminalAnswers,
  AgentTerminalRequest,
  AgentTerminalResult,
  AgentView,
  TerminalFrame,
} from "@t3flare/workspace-client";

/** Running Terminals and Background jobs in one Workspace, across its Sessions (ADR-0021's terminal cap). */
export const MAX_LIVE = 8;
/** Entries (running or exited) one owner keeps; the oldest exited one is forgotten past it. */
export const MAX_KEPT = 32;
/** termctrl's settle constants (`terminal-tools.ts`). */
export const QUIET_MS = 250;
const POLL_MS = 50;
/** termctrl escalates a stop to SIGKILL after this long (`termctrl-registry.ts` DEFAULT_STOP_GRACE_MS). */
const STOP_GRACE_MS = 3_000;
/** Scrollback a Terminal keeps (termctrl's is several hundred lines). */
const SCROLLBACK = 1_000;
/** A Background job's output as a result shows it: pi-termctrl's `bashTail` (300 lines or 16 KB). */
export const JOB_TAIL = { lines: 300, bytes: 16_384 };
/** Where a Background job's whole output is kept, in the Container. */
export const JOB_LOG_DIR = "/tmp/t3flare-jobs";

/** termctrl's key names, as the bytes a terminal reads. */
const KEYS: Readonly<Record<string, string>> = {
  Enter: "\r",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Tab: "\t",
  "Shift+Tab": "\x1b[Z",
  Backspace: "\x7f",
  Delete: "\x1b[3~",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  ...Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`Control+${String.fromCharCode(65 + index)}`, String.fromCharCode(index + 1)])),
};
export const KEY_NAMES: ReadonlyArray<string> = Object.keys(KEYS);

/** The part of `TerminalHost` this uses. */
export interface AgentTerminalHost {
  open(input: {
    readonly key: string;
    readonly t3Path: string;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly env: Readonly<Record<string, string>>;
    readonly command: string;
  }): Promise<unknown>;
  input(key: string, data: string): Promise<unknown>;
  close(key: string): Promise<unknown>;
}

export interface AgentTerminalsDeps {
  readonly host: AgentTerminalHost;
  readonly now: () => number;
  /** The next id number of `kind` for `owner`, kept in storage so a restart never reuses one. */
  readonly nextId: (owner: string, kind: AgentEntryKind) => number;
  /** The env an entry's command runs with on top of the host's base (mise through `BASH_ENV`). */
  readonly env: Readonly<Record<string, string>>;
  /** The Workspace's repo in the Container. */
  readonly repo: string;
}

interface Entry {
  readonly id: string;
  readonly owner: string;
  readonly marker: string;
  readonly kind: AgentEntryKind;
  readonly command: string;
  readonly cwd: string;
  readonly notify: boolean;
  readonly startedAt: number;
  readonly term: Terminal;
  readonly logPath?: string;
  endedAt: number | null;
  exit: AgentExit | null;
  /** The owner saw the exit in a result, or was told of it. */
  exitSeen: boolean;
  /** Lines dropped from the scrollback so far. */
  trimmed: number;
  lastOutputAt: number;
  /** Writes into the xterm still being parsed. */
  writing: Promise<void>;
  /** The owner's previous view: the absolute index of its screen's top line, its rows and cursor row. */
  seen: { readonly top: number; readonly screen: string; readonly cursorRow: number | null } | null;
  /** Calls to this entry, one at a time in arrival order (termctrl's Call queue). */
  queue: Promise<unknown>;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** FNV-1a, as a short marker part: Session names are longer than a marker may be. */
const shortHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** The xterm's internals this reads: the normal buffer's trims and whether the program hid the cursor. */
interface XtermCore {
  readonly _core?: {
    readonly _bufferService?: { readonly buffers?: { readonly normal?: { readonly lines?: { onTrim?: (listener: (amount: number) => void) => unknown } } } };
    readonly coreService?: { readonly isCursorHidden?: boolean };
  };
}

const lastLines = (text: string, limits: { readonly lines: number; readonly bytes: number }): string => {
  const lines = text.split("\n");
  let kept = lines.slice(-limits.lines);
  while (kept.length > 1 && new TextEncoder().encode(kept.join("\n")).length > limits.bytes) kept = kept.slice(1);
  return kept.join("\n");
};

export class AgentTerminals {
  readonly #deps: AgentTerminalsDeps;
  readonly #entries = new Map<string, Entry>();
  readonly #byMarker = new Map<string, Entry>();

  constructor(deps: AgentTerminalsDeps) {
    this.#deps = deps;
  }

  /** Running entries in this Workspace. */
  get live(): number {
    return [...this.#entries.values()].filter((entry) => entry.exit === null).length;
  }

  /** The host's output: each frame into its entry's screen; an exit frame ends it. Unknown markers are answered. */
  frames(frames: ReadonlyArray<TerminalFrame>): ReadonlyArray<string> {
    const unknown = new Set<string>();
    for (const frame of frames) {
      const entry = this.#byMarker.get(frame.key);
      if (entry === undefined) {
        unknown.add(frame.key);
        continue;
      }
      if (frame.data !== undefined && frame.data !== "") {
        const data = frame.data;
        entry.lastOutputAt = this.#deps.now();
        entry.writing = entry.writing.then(() => new Promise<void>((resolve) => entry.term.write(data, resolve)));
      }
      if (frame.exit !== undefined && entry.exit === null) {
        // 129 is the host's code for a shell the Container took with it (`containerStopped`, a kill before the start).
        entry.exit = frame.exit.code === 129 ? { code: null, signal: "the Workspace's Container stopped" } : { code: frame.exit.code, signal: null };
        entry.endedAt = this.#deps.now();
      }
    }
    return [...unknown];
  }

  async handle<R extends AgentTerminalRequest>(request: R): Promise<AgentTerminalResult<R["op"]>> {
    try {
      const value = await this.#dispatch(request);
      return { ok: true, value } as AgentTerminalResult<R["op"]>;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #dispatch(request: AgentTerminalRequest): Promise<AgentTerminalAnswers[AgentTerminalRequest["op"]]> {
    switch (request.op) {
      case "start":
        return this.#start(request);
      case "settle": {
        const entry = this.#entry(request.owner, request.id);
        return this.#queued(entry, () => this.#settle(entry, request));
      }
      case "stop": {
        const entry = this.#entry(request.owner, request.id);
        return this.#queued(entry, () => this.#stop(entry));
      }
      case "list":
        return { entries: this.#owned(request.owner).map((entry) => this.#info(entry)) };
      case "wait":
        return this.#wait(request);
      case "exits": {
        const exits = this.#owned(request.owner).filter((entry) => entry.exit !== null && !entry.exitSeen && entry.notify);
        for (const entry of exits) entry.exitSeen = true;
        return { exits: await Promise.all(exits.map(async (entry) => ({ ...this.#info(entry), tail: await this.#tail(entry, request.tailLines) }))) };
      }
    }
  }

  #owned(owner: string): Array<Entry> {
    return [...this.#entries.values()].filter((entry) => entry.owner === owner);
  }

  #entry(owner: string, id: string): Entry {
    const entry = this.#entries.get(`${owner}\u0000${id}`);
    if (entry !== undefined) return entry;
    const ids = this.#owned(owner).map((known) => known.id);
    throw new Error(`Unknown terminal or Background job ${id}.${ids.length === 0 ? " There are none." : ` Known: ${ids.join(", ")}.`}`);
  }

  #queued<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(run, run);
    entry.queue = next.catch(() => undefined);
    return next;
  }

  #info(entry: Entry): AgentEntryInfo {
    return {
      id: entry.id,
      kind: entry.kind,
      command: entry.command,
      cwd: entry.cwd,
      state: entry.exit === null ? "running" : "exited",
      exit: entry.exit,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      ...(entry.logPath === undefined ? {} : { logPath: entry.logPath }),
    };
  }

  async #start(request: Extract<AgentTerminalRequest, { op: "start" }>): Promise<AgentTerminalAnswers["start"]> {
    if (this.live >= MAX_LIVE) {
      const mine = this.#owned(request.owner).filter((entry) => entry.exit === null);
      throw new Error(
        `This Workspace already runs ${MAX_LIVE} Terminals and Background jobs; stop one first.${mine.length === 0 ? "" : ` Yours: ${mine.map((entry) => `${entry.id} (${entry.command.slice(0, 60)})`).join(", ")}.`}`,
      );
    }
    const prefix = request.kind === "terminal" ? "t" : "b";
    const id = `${prefix}${this.#deps.nextId(request.owner, request.kind)}`;
    const marker = `term-agent-${shortHash(request.owner)}-${id}`;
    const logPath = request.kind === "background_job" ? `${JOB_LOG_DIR}/${marker}.log` : undefined;
    const term = new Terminal({ cols: request.cols, rows: request.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const now = this.#deps.now();
    const entry: Entry = {
      id,
      owner: request.owner,
      marker,
      kind: request.kind,
      command: request.command,
      cwd: request.cwd,
      notify: request.notify,
      startedAt: now,
      term,
      ...(logPath === undefined ? {} : { logPath }),
      endedAt: null,
      exit: null,
      exitSeen: false,
      trimmed: 0,
      lastOutputAt: now,
      writing: Promise.resolve(),
      seen: null,
      queue: Promise.resolve(),
    };
    (term as unknown as XtermCore)._core?._bufferService?.buffers?.normal?.lines?.onTrim?.((amount) => {
      entry.trimmed += amount;
    });
    this.#forgetOldest(request.owner);
    this.#entries.set(`${request.owner}\u0000${id}`, entry);
    this.#byMarker.set(marker, entry);
    // A Background job's whole output also goes to its log, which the agent can `read` (pi-termctrl's job log).
    const command =
      logPath === undefined
        ? request.command
        : `mkdir -p ${JOB_LOG_DIR} && set -o pipefail && { ${request.command}\n} 2>&1 | tee -a ${quote(logPath)}`;
    await this.#deps.host.open({ key: marker, t3Path: this.#deps.repo, cwd: request.cwd, cols: request.cols, rows: request.rows, env: this.#deps.env, command });
    return { entry: this.#info(entry) };
  }

  /** Past MAX_KEPT, the owner's oldest exited entry is forgotten (never a running one). */
  #forgetOldest(owner: string): void {
    const owned = this.#owned(owner);
    if (owned.length < MAX_KEPT) return;
    const oldest = owned.filter((entry) => entry.exit !== null).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest !== undefined) this.#forget(oldest);
  }

  #forget(entry: Entry): void {
    this.#entries.delete(`${entry.owner}\u0000${entry.id}`);
    this.#byMarker.delete(entry.marker);
    entry.term.dispose();
  }

  async #type(entry: Entry, text: string | undefined, keys: ReadonlyArray<string> | undefined): Promise<void> {
    if ((text === undefined || text === "") && (keys === undefined || keys.length === 0)) return;
    if (entry.exit !== null) {
      throw new Error(`${entry.id} has exited (${describeExit(entry.exit)}); it takes no input. Poll it without text or keys for its final screen.`);
    }
    const unknown = (keys ?? []).filter((key) => !(key in KEYS));
    if (unknown.length > 0) throw new Error(`Unknown key${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. Keys: ${KEY_NAMES.join(", ")}.`);
    const data = (text ?? "") + (keys ?? []).map((key) => KEYS[key]).join("");
    await this.#deps.host.input(entry.marker, data);
  }

  async #settle(entry: Entry, request: Extract<AgentTerminalRequest, { op: "settle" }>): Promise<AgentTerminalAnswers["settle"]> {
    await entry.writing;
    const startScreen = request.since ?? this.#screen(entry).screen;
    // Input goes first, in the slice that starts the wait.
    if (request.since === undefined) await this.#type(entry, request.text, request.keys);
    const typedAt = this.#deps.now();
    const sliceEnd = Math.min(request.deadline, this.#deps.now() + request.chunkMs);
    const matches = request.pattern === undefined ? undefined : patternOf(request.pattern);
    let reason: AgentSettleReason | undefined;
    for (;;) {
      await entry.writing;
      const now = this.#deps.now();
      const screen = this.#screen(entry).screen;
      const changed = screen !== startScreen;
      if (matches !== undefined && changed && matches(screen)) reason = "matched";
      else if (entry.exit !== null) reason = "exited";
      // With a pattern, quiet alone never ends the wait; a poll settles on quiet only after new output.
      else if (matches === undefined && now - entry.lastOutputAt >= QUIET_MS && now - typedAt >= QUIET_MS && (request.mode !== "poll" || entry.lastOutputAt > typedAt || changed)) reason = "quiet";
      else if (now >= request.deadline) reason = "timeout";
      else if (now >= sliceEnd) reason = "chunk";
      if (reason !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return { view: await this.#view(entry, request.view && reason !== "chunk"), reason, startScreen };
  }

  async #stop(entry: Entry): Promise<AgentTerminalAnswers["stop"]> {
    if (entry.exit === null) {
      await this.#deps.host.close(entry.marker);
      const deadline = this.#deps.now() + STOP_GRACE_MS;
      while (entry.exit === null && this.#deps.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (entry.exit === null) {
        entry.exit = { code: null, signal: "SIGKILL" };
        entry.endedAt = this.#deps.now();
      }
    }
    await entry.writing;
    const view = await this.#view(entry, true);
    const stopped = this.#info(entry);
    this.#forget(entry);
    return { stopped, view };
  }

  async #wait(request: Extract<AgentTerminalRequest, { op: "wait" }>): Promise<AgentTerminalAnswers["wait"]> {
    const owned = this.#owned(request.owner);
    if (request.ids !== null) for (const id of request.ids) this.#entry(request.owner, id);
    const targets = request.ids === null ? owned.filter((entry) => entry.exit === null) : owned.filter((entry) => request.ids!.includes(entry.id));
    const sliceEnd = Math.min(request.deadline, this.#deps.now() + request.chunkMs);
    for (;;) {
      const exited = targets.filter((entry) => entry.exit !== null);
      if (exited.length > 0 || targets.length === 0 || this.#deps.now() >= sliceEnd) {
        // Every exit by then, also of entries not waited on (termctrl's `terminal_wait`); they are not notified again.
        const all = owned.filter((entry) => entry.exit !== null && !entry.exitSeen);
        const reported = [...new Set([...exited, ...all])];
        for (const entry of reported) entry.exitSeen = true;
        return {
          exited: reported.map((entry) => this.#info(entry)),
          running: owned.filter((entry) => entry.exit === null).map((entry) => this.#info(entry)),
          timedOut: exited.length === 0 && targets.length > 0 && this.#deps.now() >= request.deadline,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /** The visible rows (trailing blank rows trimmed) and the cursor; null while the program hides it. */
  #screen(entry: Entry): { readonly screen: string; readonly cursor: AgentCursor | null; readonly top: number } {
    const buffer = entry.term.buffer.active;
    const rows: Array<string> = [];
    for (let row = 0; row < entry.term.rows; row++) rows.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    const hidden = (entry.term as unknown as XtermCore)._core?.coreService?.isCursorHidden === true;
    const normal = buffer.type === "normal";
    return { screen: rows.join("\n"), cursor: hidden ? null : { x: buffer.cursorX, y: buffer.cursorY }, top: (normal ? entry.trimmed : 0) + buffer.baseY };
  }

  /** The screen, what scrolled off since the owner's previous view, and that view; `record`: this is the owner's view now. */
  async #view(entry: Entry, record: boolean): Promise<AgentView> {
    await entry.writing;
    const { screen, cursor, top } = this.#screen(entry);
    const buffer = entry.term.buffer.active;
    const scrolledOff: Array<string> = [];
    let outputMissing = false;
    if (buffer.type === "normal") {
      const from = entry.seen?.top ?? entry.trimmed;
      if (from < entry.trimmed) outputMissing = true;
      for (let line = Math.max(from, entry.trimmed); line < top; line++) scrolledOff.push(buffer.getLine(line - entry.trimmed)?.translateToString(true) ?? "");
    }
    const previous = entry.seen === null ? null : { screen: entry.seen.screen, cursorRow: entry.seen.cursorRow };
    const shift = entry.seen === null || outputMissing || top < entry.seen.top ? null : top - entry.seen.top;
    if (record) {
      entry.seen = { top, screen, cursorRow: cursor?.y ?? null };
      if (entry.exit !== null) entry.exitSeen = true;
    }
    return {
      id: entry.id,
      state: entry.exit === null ? "running" : "exited",
      exit: entry.exit,
      screen,
      cursor,
      scrolledOff,
      outputMissing,
      previous,
      shift,
      ...(entry.kind === "background_job" ? { output: await this.#tail(entry, JOB_TAIL.lines) } : {}),
      ...(entry.logPath === undefined ? {} : { logPath: entry.logPath }),
    };
  }

  /** The entry's last lines of output (scrollback and screen), within JOB_TAIL's bytes. */
  async #tail(entry: Entry, lines: number): Promise<string> {
    await entry.writing;
    const buffer = entry.term.buffer.active;
    const all: Array<string> = [];
    for (let line = 0; line < buffer.length; line++) all.push(buffer.getLine(line)?.translateToString(true) ?? "");
    while (all.length > 0 && all[all.length - 1] === "") all.pop();
    return lastLines(all.join("\n"), { lines, bytes: JOB_TAIL.bytes });
  }

  /** The Container stopped or this object ends: every running entry ended with it (the host's exit frames say so too). */
  containerStopped(): void {
    for (const entry of this.#entries.values()) {
      if (entry.exit === null) {
        entry.exit = { code: null, signal: "the Workspace's Container stopped" };
        entry.endedAt = this.#deps.now();
      }
    }
  }
}

/** termctrl's `wait_for_text`: a literal substring, or a regex written `/source/flags`. */
export const patternOf = (pattern: string): ((screen: string) => boolean) => {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (regex !== null) {
    const compiled = new RegExp(regex[1]!, regex[2]!.replaceAll("g", ""));
    return (screen) => compiled.test(screen);
  }
  return (screen) => screen.includes(pattern);
};

export const describeExit = (exit: AgentExit): string => (exit.code !== null ? `exit code ${exit.code}` : `ended by ${exit.signal ?? "a signal"}`);
