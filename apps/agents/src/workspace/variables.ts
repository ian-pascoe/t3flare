// Variables (SPI-1152, ADR-0032's Variables refinement): where they reach a Workspace's commands. One function builds a
// command's environment with the Variables as its lowest layer (`commandEnv`); everything else wins over them:
// `COMMAND_ENV`, a CLI profile's environment, t3's own variables, and, inside the command, mise's `[env]` and whatever
// the command exports. A Workspace's Variables are those its last Container start took (`ContainerLaunch.variables`), so
// a running Container keeps its own.
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";

type Env = Readonly<Record<string, string>>;

/** A command's environment: `variables` first, then each layer over the one before. */
export const commandEnv = (variables: Env, ...layers: ReadonlyArray<Env | undefined>): Record<string, string> => Object.assign({}, variables, ...layers);

/**
 * One of the Workspace's computer backends (the Container's, the Worker Shell's) with the Variables under every command
 * it is sent: a Durable agent's commands and the Workspace DO's own. `variables` is read as each command is sent, after
 * computer has started the Container for it, so a command never runs with Variables its Container did not start with.
 */
export class VariablesBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly callable?: boolean;
  readonly #inner: WorkspaceBackend;
  readonly #variables: () => Env;

  constructor(inner: WorkspaceBackend, variables: () => Env) {
    this.#inner = inner;
    this.#variables = variables;
    this.id = inner.id;
    this.type = inner.type;
    this.description = inner.description ?? "";
    if (inner.callable !== undefined) this.callable = inner.callable;
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): Promise<BackendHandle> {
    const handle = await this.#inner.connect(host);
    const variables = this.#variables;
    // The handle's `rpc` may be an RPC stub (the Container's): each member is reached through it as computer would.
    const shell: BackendHandle["rpc"]["shell"] = {
      exec: (input) => handle.rpc.shell.exec({ ...input, env: commandEnv(variables(), input.env) }),
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
