// Where a command waits for the Global mise config's lay-down (SPI-1150, ADR-0032's Global mise config refinement):
// "`mise install` runs before the first command of each Container start". Every command sent to the Container that is
// not a passive read waits for its Container's lay-down at the point it is sent, whoever sends it (a Durable agent's
// command reaches computer through the Workspace stub, never `WorkspaceDO.exec`); a Terminal or a CLI process waits
// before its spawn. A passive read (`WorkspaceDO.exec`'s `passive`, marked in its environment) never runs it.
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";

/** The variable `WorkspaceDO.exec` marks a passive read with; taken out before the command is sent. */
export const PASSIVE_MARKER = "T3FLARE_PASSIVE_READ";

/** `inner` (the Container's backend) with every command but a passive read sent after its Container's lay-down. */
export class GlobalMiseBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly callable?: boolean;
  readonly #inner: WorkspaceBackend;
  readonly #ensure: (runtime: string | undefined) => Promise<unknown>;

  constructor(inner: WorkspaceBackend, ensure: (runtime: string | undefined) => Promise<unknown>) {
    this.#inner = inner;
    this.#ensure = ensure;
    this.id = inner.id;
    this.type = inner.type;
    this.description = inner.description ?? "";
    if (inner.callable !== undefined) this.callable = inner.callable;
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): Promise<BackendHandle> {
    const handle = await this.#inner.connect(host);
    const ensure = this.#ensure;
    const shell: BackendHandle["rpc"]["shell"] = {
      exec: async (input) => {
        if (input.env?.[PASSIVE_MARKER] !== undefined) {
          const { [PASSIVE_MARKER]: _marker, ...env } = input.env;
          return handle.rpc.shell.exec({ ...input, env });
        }
        await ensure(handle.runtimeId).catch(() => undefined);
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

export interface SpawnReadiness {
  readonly running: () => boolean;
  /** The runtime id of the Container computer last connected to; undefined before this instance connected. */
  readonly runtime: () => string | undefined;
  /** An active command on the Container (`true`): it connects, and so waits for the lay-down (`GlobalMiseBackend`). */
  readonly start: () => Promise<unknown>;
  readonly ensure: (runtime: string | undefined) => Promise<unknown>;
}

/** Before a Terminal's or a CLI process's spawn on the running Container: its lay-down has ended. */
export const readyForSpawn = async (deps: SpawnReadiness): Promise<void> => {
  if (!deps.running()) return;
  const runtime = deps.runtime();
  if (runtime === undefined) await deps.start();
  else await deps.ensure(runtime).catch(() => undefined);
};
