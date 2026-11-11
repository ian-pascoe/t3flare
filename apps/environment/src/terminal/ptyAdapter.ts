// @effect-diagnostics globalTimers:off globalConsole:off globalDate:off extendsNativeError:off
// t3's PTY seam in the Cloud Environment (step 2b, ADR-0021). t3's TerminalManager spawns shells through `PtyAdapter`;
// here a shell is a bash the Workspace DO of the cwd starts under the platform's PTY exec in its Container. Input,
// size and close go to that DO over RPC; output comes back pushed (`EnvironmentDO.terminalOutput` → `deliver`).
//
// - The cwd names the Workspace (`/w/<id>/…`); a path outside every listed Workspace fails as "no such file", so t3
//   tries its next shell and then reports the error. Only bash and sh are shells here (zsh, fish: "not found").
// - The env is filtered through an allowlist (defence in depth beside the TerminalManager's fixed base env, review F0):
//   terminal and locale keys and t3's `T3CODE_*`; anything named like a credential is dropped and logged by name.
// - The pid is synthetic and unique here: pids of two Containers can collide, and t3 never sees a Container pid.
// - Writes are queued and flushed in order, one RPC in flight per terminal; nothing is sent before the open answered.
// - Liveness: one heartbeat per Workspace every 30 s. An answer from another Workspace DO instance (its epoch) or one
//   naming a terminal unknown ends that terminal here (review F11): the DO restarted and lost the shell.
import type { TerminalAnswer, TerminalFrame, TerminalOpenInput, TerminalPush, TerminalPushAnswer } from "@t3flare/workspace-client";

export const HEARTBEAT_EVERY_MS = 30_000;

/** The Workspace DO's terminal RPCs, as much as the adapter uses. */
export interface TerminalRemote {
  terminalOpen(input: TerminalOpenInput): Promise<TerminalAnswer>;
  terminalInput(key: string, data: string): Promise<TerminalAnswer>;
  terminalResize(key: string, cols: number, rows: number): Promise<TerminalAnswer>;
  terminalClose(key: string): Promise<TerminalAnswer>;
  terminalHeartbeat(keys: ReadonlyArray<string>): Promise<TerminalAnswer>;
}

export interface TerminalPlace {
  readonly workspace: string;
  /** `/w/<id>`. */
  readonly t3Path: string;
  readonly remote: TerminalRemote;
}

export interface SpawnInput {
  readonly shell: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Exit {
  readonly exitCode: number;
  readonly signal: number | null;
}

export class SpawnRefused extends Error {}

const SHELLS = new Set(["bash", "sh", "/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"]);

/** Env keys a terminal may receive. */
export const allowedEnvKey = (key: string): boolean =>
  ["TERM", "COLORTERM", "LANG", "NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE"].includes(key) ||
  key.startsWith("LC_") ||
  key.startsWith("T3CODE_");

const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** The allowlisted env; the dropped keys that look like credentials are returned by name for the log. */
export const filterTerminalEnv = (env: Readonly<Record<string, string | undefined>>): { readonly env: Record<string, string>; readonly droppedCredentials: ReadonlyArray<string> } => {
  const kept: Record<string, string> = {};
  const droppedCredentials: Array<string> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CREDENTIAL_NAME.test(key)) {
      droppedCredentials.push(key);
      continue;
    }
    if (allowedEnvKey(key)) kept[key] = value;
  }
  return { env: kept, droppedCredentials };
};

type Listener<A> = (value: A) => void;

/** One shell, as t3's `PtyProcess`. */
export class TerminalProcess {
  readonly pid: number;
  readonly key: string;
  readonly place: TerminalPlace;
  readonly #processes: TerminalProcesses;
  readonly #data = new Set<Listener<string>>();
  readonly #exit = new Set<Listener<Exit>>();
  #queue: Array<string> = [];
  #writing = false;
  #opened = false;
  #epoch: string | undefined;
  #nextSeq = 0;
  #closeSent = false;
  #pendingSize: { cols: number; rows: number } | undefined;
  exited: Exit | undefined;
  /** Whether a command runs in the foreground (the rc file's markers): t3's subprocess inspector reads it. */
  busy = false;

  constructor(processes: TerminalProcesses, pid: number, key: string, place: TerminalPlace) {
    this.#processes = processes;
    this.pid = pid;
    this.key = key;
    this.place = place;
  }

  get epoch(): string | undefined {
    return this.#epoch;
  }

  opened(answer: TerminalAnswer): void {
    this.#epoch = answer.epoch;
    this.#opened = true;
    if (this.#closeSent) {
      this.#closeSent = false;
      this.kill();
      return;
    }
    if (this.#pendingSize !== undefined) this.resize(this.#pendingSize.cols, this.#pendingSize.rows);
    this.#flush();
  }

  /** An answer from the Workspace DO: another instance, or this key unknown, ends the terminal. */
  checkAnswer(answer: TerminalAnswer): void {
    if (this.exited !== undefined) return;
    if ((this.#epoch !== undefined && answer.epoch !== this.#epoch) || answer.unknown.includes(this.key)) {
      this.emitData("\r\n\x1b[2mThe Workspace's terminal host restarted; this shell is gone.\x1b[0m\r\n");
      this.finish({ exitCode: 129, signal: null });
    }
  }

  write(data: string): void {
    if (this.exited !== undefined) return;
    this.#queue.push(data);
    queueMicrotask(() => this.#flush());
  }

  #flush(): void {
    if (!this.#opened || this.#writing || this.#queue.length === 0 || this.exited !== undefined) return;
    const data = this.#queue.join("");
    this.#queue = [];
    this.#writing = true;
    this.place.remote
      .terminalInput(this.key, data)
      .then((answer) => this.checkAnswer(answer))
      .catch((error: unknown) => console.warn(JSON.stringify({ t3flare: "terminal-input-failed", error: String(error).slice(0, 200) })))
      .finally(() => {
        this.#writing = false;
        this.#flush();
      });
  }

  resize(cols: number, rows: number): void {
    if (this.exited !== undefined) return;
    if (!this.#opened) {
      this.#pendingSize = { cols, rows };
      return;
    }
    this.place.remote
      .terminalResize(this.key, cols, rows)
      .then((answer) => this.checkAnswer(answer))
      .catch(() => undefined);
  }

  /** t3's SIGTERM, then SIGKILL after 1 s: one close RPC; the Workspace DO kills by marker (review F2). */
  kill(_signal?: string): void {
    if (this.exited !== undefined || this.#closeSent) return;
    this.#closeSent = true;
    if (!this.#opened) return; // sent once the open answers
    this.place.remote
      .terminalClose(this.key)
      .then((answer) => this.checkAnswer(answer))
      .catch((error: unknown) => {
        console.warn(JSON.stringify({ t3flare: "terminal-close-failed", error: String(error).slice(0, 200) }));
        this.finish({ exitCode: 129, signal: null });
      });
  }

  onData(listener: Listener<string>): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onExit(listener: Listener<Exit>): () => void {
    this.#exit.add(listener);
    if (this.exited !== undefined) {
      const exit = this.exited;
      queueMicrotask(() => listener(exit));
    }
    return () => this.#exit.delete(listener);
  }

  emitData(data: string): void {
    for (const listener of this.#data) listener(data);
  }

  /** Frames for this terminal, in the Workspace's order. */
  frame(frame: TerminalFrame): void {
    if (this.exited !== undefined || frame.seq < this.#nextSeq) return;
    this.#nextSeq = frame.seq + 1;
    if (frame.data !== undefined) this.emitData(frame.data);
    if (frame.exit !== undefined) this.finish({ exitCode: frame.exit.code, signal: null });
  }

  finish(exit: Exit): void {
    if (this.exited !== undefined) return;
    this.exited = exit;
    this.busy = false;
    this.#processes.forget(this);
    for (const listener of this.#exit) listener(exit);
  }
}

export interface TerminalProcessesDeps {
  /** The Workspace of a t3 path, when listed. */
  readonly place: (cwd: string) => TerminalPlace | undefined;
  readonly newKey: () => string;
}

/** Every terminal of this Environment DO instance: the adapter's state, and the push's receiver. */
export class TerminalProcesses {
  readonly #deps: TerminalProcessesDeps;
  readonly #byKey = new Map<string, TerminalProcess>();
  readonly #byPid = new Map<number, TerminalProcess>();
  #nextPid = 100_000;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(deps: TerminalProcessesDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#byKey.size;
  }

  /** Starts a shell (the open runs in the background; t3 gets the process at once). */
  spawn(input: SpawnInput): TerminalProcess {
    if (!SHELLS.has(input.shell)) throw new SpawnRefused(`ENOENT: ${input.shell} not found in the Cloud Environment (bash only)`);
    const place = this.#deps.place(input.cwd);
    if (place === undefined) throw new SpawnRefused(`ENOENT: no such file or directory, the cwd ${input.cwd} is in no Workspace`);
    const { env, droppedCredentials } = filterTerminalEnv(input.env);
    if (droppedCredentials.length > 0) console.warn(JSON.stringify({ t3flare: "terminal-env-dropped", keys: droppedCredentials }));
    const key = this.#deps.newKey();
    const process = new TerminalProcess(this, this.#nextPid++, key, place);
    this.#byKey.set(key, process);
    this.#byPid.set(process.pid, process);
    this.#startHeartbeat();
    place.remote
      .terminalOpen({ key, t3Path: place.t3Path, cwd: input.cwd, cols: input.cols, rows: input.rows, env })
      .then((answer) => process.opened(answer))
      .catch((error: unknown) => {
        process.emitData(`\x1b[31mt3flare: the terminal did not open: ${String(error).slice(0, 300)}\x1b[0m\r\n`);
        process.finish({ exitCode: 1, signal: null });
      });
    return process;
  }

  /** A Workspace's pushed output; answers the keys no live terminal here has (the Workspace DO kills them). */
  deliver(push: TerminalPush): TerminalPushAnswer {
    const unknown = new Set<string>();
    // The foreground's final state in this batch is set before any of its data is delivered: t3 reacts to a setup
    // script's sentinel by asking whether the terminal is idle, and the prompt's marker follows the sentinel.
    const lastBusy = new Map<string, boolean>();
    for (const frame of push.frames) if (frame.busy !== undefined) lastBusy.set(frame.key, frame.busy);
    for (const [key, busy] of lastBusy) {
      const process = this.#byKey.get(key);
      if (process !== undefined) process.busy = busy;
    }
    for (const frame of push.frames) {
      const process = this.#byKey.get(frame.key);
      if (process === undefined || (process.epoch !== undefined && process.epoch !== push.epoch)) {
        if (frame.exit === undefined) unknown.add(frame.key);
        continue;
      }
      process.frame(frame);
    }
    return { unknown: [...unknown] };
  }

  /** t3's subprocess inspector: from the markers, without an RPC. */
  busy(pid: number): boolean {
    return this.#byPid.get(pid)?.busy ?? false;
  }

  forget(process: TerminalProcess): void {
    this.#byKey.delete(process.key);
    this.#byPid.delete(process.pid);
    if (this.#byKey.size === 0) this.#stopHeartbeat();
  }

  /** One heartbeat per Workspace for its live terminals. */
  async beat(): Promise<void> {
    const byWorkspace = new Map<string, Array<TerminalProcess>>();
    for (const process of this.#byKey.values()) {
      if (process.epoch === undefined) continue; // still opening
      const list = byWorkspace.get(process.place.workspace) ?? [];
      list.push(process);
      byWorkspace.set(process.place.workspace, list);
    }
    await Promise.all(
      [...byWorkspace.values()].map(async (processes) => {
        try {
          const answer = await processes[0]!.place.remote.terminalHeartbeat(processes.map((process) => process.key));
          for (const process of processes) process.checkAnswer(answer);
        } catch (error) {
          console.warn(JSON.stringify({ t3flare: "terminal-heartbeat-failed", error: String(error).slice(0, 200) }));
        }
      }),
    );
  }

  #startHeartbeat(): void {
    this.#heartbeat ??= setInterval(() => void this.beat(), HEARTBEAT_EVERY_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }
}
