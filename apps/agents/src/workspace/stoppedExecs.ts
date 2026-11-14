// Commands stopped before they started (SPI-1150, ADR-0032's Global mise config refinement): a Durable agent's command that
// timed out or was aborted while its Container started (and installed the Global mise config) is dispatched by
// computer once the connect returns, minutes later. The Session hands its id to the Workspace DO's `killExecs` when it
// stops it; the Workspace DO remembers the id here, and its backend refuses to send that command at all.
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";

/** How long a stopped id is remembered: longer than any connect (the lay-down's deadline is 13 minutes). */
export const STOPPED_REMEMBERED_MS = 30 * 60_000;

/** The variable a command's environment carries its exec id in (computer-env's `EXEC_MARKER`). */
const EXEC_MARKER = "T3FLARE_EXEC";

export class StoppedExecs {
  readonly #ids = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** The Session stopped these commands. */
  stopped(ids: ReadonlyArray<string>): void {
    const now = this.#now();
    for (const [id, at] of this.#ids) if (now - at > STOPPED_REMEMBERED_MS) this.#ids.delete(id);
    for (const id of ids) this.#ids.set(id, now);
  }

  has(id: string | undefined): boolean {
    return id !== undefined && this.#ids.has(id);
  }
}

/** `inner` refusing to send a command whose exec id was stopped before it was sent. */
export class StoppedExecsBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly callable?: boolean;
  readonly #inner: WorkspaceBackend;
  readonly #stopped: StoppedExecs;

  constructor(inner: WorkspaceBackend, stopped: StoppedExecs) {
    this.#inner = inner;
    this.#stopped = stopped;
    this.id = inner.id;
    this.type = inner.type;
    this.description = inner.description ?? "";
    if (inner.callable !== undefined) this.callable = inner.callable;
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): Promise<BackendHandle> {
    const handle = await this.#inner.connect(host);
    const stopped = this.#stopped;
    const shell: BackendHandle["rpc"]["shell"] = {
      exec: (input) => {
        if (stopped.has(input.env?.[EXEC_MARKER])) return Promise.reject(new Error("t3flare: the command was stopped before it started; it was not run"));
        return handle.rpc.shell.exec(input);
      },
      getExec: (input) => handle.rpc.shell.getExec(input),
      killExec: (input) => handle.rpc.shell.killExec(input),
      disposeExec: (input) => handle.rpc.shell.disposeExec(input),
    };
    return {
      ...handle,
      rpc: {
        get sync() {
          return handle.rpc.sync;
        },
        shell,
      },
    };
  }
}
