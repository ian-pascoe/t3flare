// Where a command waits for the Global mise config's lay-down (SPI-1150, ADR-0032's Global mise config refinement):
// "`mise install` runs before the first command of each Container start". Every command sent to the Container that is
// not a passive read waits for its Container's lay-down at the point it is sent, whoever sends it (a Durable agent's
// command reaches computer through the Workspace stub, never `WorkspaceDO.exec`); a Terminal or a CLI process waits
// before its spawn. A passive read (`WorkspaceDO.exec`'s `passive`, marked in its environment by `commandEnvOf`) never
// runs it.
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";

/** The variable `WorkspaceDO.exec` marks a passive read with; taken out before the command is sent. */
export const PASSIVE_MARKER = "T3FLARE_PASSIVE_READ";

/**
 * A Container command's environment from `WorkspaceDO.exec`: `base` under the caller's, the passive mark only when the
 * read is passive. A caller's own mark is dropped, so no active command can skip the lay-down.
 */
export const commandEnvOf = (base: Readonly<Record<string, string>>, env: Readonly<Record<string, string>> | undefined, passive: boolean): Record<string, string> => {
  const { [PASSIVE_MARKER]: _given, ...own } = env ?? {};
  return { ...base, ...own, ...(passive ? { [PASSIVE_MARKER]: "1" } : {}) };
};

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

/**
 * Where computer keeps the running Container's runtime id in the Workspace DO's storage (`@cloudflare/computer`
 * 0.11.2, `CurrentContainerRuntimeIdentity`): the id its connect answers. Read so a spawn learns the runtime without a
 * command or a connect. Checked by `globalMiseGate.test.ts` against the package's code.
 */
export const COMPUTER_RUNTIME_KEY = "computer:container-runtime-identity";

export interface SpawnReadiness {
  readonly running: () => boolean;
  /** The running Container's runtime id: the last connect's, else computer's stored one; undefined when unknown. */
  readonly runtime: () => Promise<string | undefined>;
  readonly ensure: (runtime: string | undefined) => Promise<unknown>;
  readonly log: (event: Record<string, unknown>) => void;
}

/**
 * Before a Terminal's or a CLI process's spawn: the running Container's lay-down has ended. It never runs a command,
 * connects or starts a Container (a stopped one is started by the spawn's own path, whose `true` waits as every active
 * command does, `GlobalMiseBackend`); a runtime it cannot learn, or a lay-down that fails, is logged and the spawn goes on.
 */
export const readyForSpawn = async (deps: SpawnReadiness): Promise<void> => {
  if (!deps.running()) return;
  try {
    const runtime = await deps.runtime();
    if (runtime === undefined) {
      deps.log({ t3flare: "global-mise-spawn", waited: false, reason: "the running Container's runtime is unknown" });
      return;
    }
    await deps.ensure(runtime);
  } catch (error) {
    deps.log({ t3flare: "global-mise-spawn", waited: false, reason: String(error).slice(0, 200) });
  }
};
