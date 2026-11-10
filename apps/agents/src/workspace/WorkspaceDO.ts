// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off globalTimers:off
// The Workspace DO (ADR-0008, ADR-0009; step 2a plan): one `@cloudflare/computer` Workspace, its files in this object's
// SQLite, its commands on the Worker Shell or, for real binaries, in the Container this object starts itself
// (`schedulingPolicy: "durable_object"`). Adapted from cloudpid@ae5a7b73:apps/server/src/workspace/Workspace.ts, which
// carries much more (Skills, Builds, spares, previews, snapshots); this keeps what step 2a needs and grows by milestone.
//
// It is a plain DurableObject: computer reaches it through `__getWorkspaceStub()` with raw Workers RPC, and its Worker
// Shell calls back into it through `WorkspaceServiceProxy` (exported by the Worker's entry).
import { Workspace as ComputerWorkspace, type WorkspaceStub } from "@cloudflare/computer";
import {
  ContainerBackend,
  type ContainerLaunchSpec,
  type IWorkspaceContainerAPI,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { COMMAND_ENV } from "@t3flare/sandbox-image";
import { DurableObject } from "cloudflare:workers";

import { BUDGET_NAME, type ContainerBudget, RENEW_EVERY_MS } from "../budget.ts";
import {
  CONTAINER_BACKEND,
  CONTAINER_IDLE_MS,
  CONTAINER_IGNORE,
  CONTAINER_INSTANCE,
  WORKER_SHELL_BACKEND,
  WORKSPACE_BINDING,
  WORKSPACE_CONTAINER,
  WORKSPACE_ROOT,
} from "./constants.ts";

export interface WorkspaceEnv {
  readonly LOADER: WorkerLoader;
  readonly CONTAINER_BUDGET: DurableObjectNamespace<ContainerBudget>;
  /** Overrides CONTAINER_IDLE_MS (tests). */
  readonly T3FLARE_CONTAINER_IDLE_MS?: string;
}

export interface ExecInput {
  /** A bash script, run on the chosen backend. */
  readonly script: string;
  readonly backend?: "container" | "worker-shell";
  /** Inside the Workspace (`/workspace/…`). */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly status: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

const LAST_USE_KEY = "t3flare:container-last-use";
const LEASED_KEY = "t3flare:container-leased";

const ContainerHost = withWorkspaceContainer(class extends DurableObject<WorkspaceEnv> {});

export class WorkspaceDO extends ContainerHost {
  readonly #workspace: ComputerWorkspace;
  readonly #container: ContainerBackend;
  /** Commands running now: the Container is not stopped under them. */
  #running = 0;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    const ref = { binding: WORKSPACE_BINDING, id: ctx.id.toString() };
    this.#container = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#budgeted(this.getWorkspaceContainer()) }),
      workspace: ref,
      name: WORKSPACE_CONTAINER,
      instance: CONTAINER_INSTANCE,
      // Unrestricted direct egress in part 1, as cloudpid's v1 (an allowlist is deferred, docs/plan.md).
      egress: { mode: "direct" },
      ignore: CONTAINER_IGNORE,
      connectTimeoutMs: 60_000,
    });
    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
      backends: [new WorkerShellBackend({ loader: env.LOADER, workspace: ref, ctx }), this.#container],
    });
  }

  /** The platform's Container API with the budget's lease taken before every start (step 2a cost guardrails). */
  #budgeted(api: IWorkspaceContainerAPI): IWorkspaceContainerAPI {
    const lease = async () => {
      const answer = await this.#budget().acquire(this.ctx.id.toString());
      if (!answer.ok) throw new Error(`t3flare: the Container cannot start: ${answer.reason}`);
      await this.ctx.storage.put(LEASED_KEY, true);
      await this.#noteUse();
      await this.#scheduleAlarm();
    };
    return {
      start: async (spec: ContainerLaunchSpec) => {
        await lease();
        return api.start(spec);
      },
      restart: async (spec: ContainerLaunchSpec) => {
        await lease();
        return api.restart(spec);
      },
      interceptOutboundHttp: (host, workspace) => api.interceptOutboundHttp(host, workspace),
      interceptAllOutboundHttp: (workspace, token) => api.interceptAllOutboundHttp(workspace, token),
      fetchPort: (port, input, init) => api.fetchPort(port, input, init),
      port: (port) => api.port(port),
      setInactivityTimeout: (ms) => api.setInactivityTimeout(ms),
      status: () => api.status(),
      exitInfo: () => api.exitInfo(),
    };
  }

  #budget() {
    return this.env.CONTAINER_BUDGET.get(this.env.CONTAINER_BUDGET.idFromName(BUDGET_NAME));
  }

  #idleMs(): number {
    const value = Number(this.env.T3FLARE_CONTAINER_IDLE_MS);
    return Number.isFinite(value) && value > 0 ? value : CONTAINER_IDLE_MS;
  }

  async #scheduleAlarm(): Promise<void> {
    const lastUse = (await this.ctx.storage.get<number>(LAST_USE_KEY)) ?? Date.now();
    const at = Math.min(lastUse + this.#idleMs(), Date.now() + RENEW_EVERY_MS);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
  }

  async #noteUse(): Promise<void> {
    await this.ctx.storage.put(LAST_USE_KEY, Date.now());
  }

  containerRunning(): boolean {
    return this.ctx.container?.running === true;
  }

  /** Runs `input.script` and waits for it. The Container backend starts the Container if it is stopped. */
  async exec(input: ExecInput): Promise<ExecResult> {
    const started = Date.now();
    const backend = input.backend === "worker-shell" ? WORKER_SHELL_BACKEND : CONTAINER_BACKEND;
    this.#running++;
    try {
      await this.#workspace.ready();
      const handle = await this.#workspace.runtime.exec(input.script, {
        backend,
        cwd: input.cwd ?? WORKSPACE_ROOT,
        encoding: "utf8",
        env: backend === CONTAINER_BACKEND ? { ...COMMAND_ENV, ...input.env } : { ...input.env },
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeoutMs: input.timeoutMs ?? 120_000,
      });
      const result = await handle.result();
      return {
        exitCode: result.exitCode,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        ms: Date.now() - started,
      };
    } finally {
      this.#running--;
      if (backend === CONTAINER_BACKEND) {
        await this.#noteUse();
        await this.#scheduleAlarm();
      }
    }
  }

  /** Reads a text file from the Workspace's own files (never the Container). Paths inside the Workspace. */
  async readText(path: string): Promise<string | null> {
    await this.#workspace.ready();
    try {
      return await this.#workspace.fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  /** Writes a text file into the Workspace's own files, as the agent's file tools do. */
  async writeText(path: string, text: string): Promise<void> {
    await this.#workspace.ready();
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
    await this.#workspace.fs.writeFile(path, text);
  }

  /** Whether the Container runs, and the budget's view. */
  async containerState(): Promise<{ readonly running: boolean; readonly leased: boolean; readonly lastUse: number | null }> {
    return {
      running: this.containerRunning(),
      leased: (await this.ctx.storage.get<boolean>(LEASED_KEY)) === true,
      lastUse: (await this.ctx.storage.get<number>(LAST_USE_KEY)) ?? null,
    };
  }

  /** Stops the Container now and frees its slot. */
  async stopContainer(): Promise<void> {
    if (this.ctx.container?.running === true) await this.ctx.container.destroy();
    await this.#release();
  }

  async #release(): Promise<void> {
    await this.#budget().release(this.ctx.id.toString());
    await this.ctx.storage.delete(LEASED_KEY);
  }

  /** Idle stop and the budget lease's renewal: the object's one alarm. */
  override async alarm(): Promise<void> {
    if (!this.containerRunning()) {
      if ((await this.ctx.storage.get<boolean>(LEASED_KEY)) === true) await this.#release();
      return;
    }
    const lastUse = (await this.ctx.storage.get<number>(LAST_USE_KEY)) ?? 0;
    if (this.#running === 0 && Date.now() - lastUse >= this.#idleMs()) {
      console.log(JSON.stringify({ t3flare: "container-idle-stop", workspace: this.ctx.id.toString() }));
      await this.stopContainer();
      return;
    }
    const renewed = await this.#budget().renew(this.ctx.id.toString());
    if (!renewed.ok) console.warn(JSON.stringify({ t3flare: "container-lease-lost", reason: renewed.reason }));
    await this.#scheduleAlarm();
  }

  /** computer's Workspace RPC (`getWorkspace()`, the Worker Shell's proxy): the caller disposes the stub. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  /** The Container's egress and computerd's callbacks reach the backend through the object's fetch. */
  override fetch(request: Request): Promise<Response> {
    return this.#container.handleFetch(request);
  }
}
