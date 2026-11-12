// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off globalTimers:off cryptoRandomUUID:off globalFetch:off
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
import { type EnvRequest, type EnvResponse, type HostOperation, withHarnessKept, WorkspaceEnvHost } from "@t3flare/computer-env";
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { DurableObject } from "cloudflare:workers";

import type {
  CheckpointAnswer,
  CheckpointOp,
  CloneInput,
  FsAnswer,
  GitAnswer,
  GitRun,
  ProcessAnswer,
  ProcessInputAnswer,
  ProcessReadAnswer,
  ProcessReadInput,
  ProcessStartAnswer,
  ProcessStartInput,
  ProvisionInfo,
  TerminalAnswer,
  TerminalOpenInput,
} from "@t3flare/workspace-client";
import { HARNESS_ROOT, REPO_ROOT } from "@t3flare/workspace-client";

import * as git from "isomorphic-git";

import { CREDENTIAL_HELPER, CREDENTIAL_PATH } from "./credentialHelper.ts";
import { BUDGET_NAME, type ContainerBudget, RENEW_EVERY_MS } from "../budget.ts";
import { environmentStub } from "../environment.ts";
import { changedBetween, currentRevision } from "./changeLog.ts";
import { killInRunningContainer } from "./containerKill.ts";
import { authoredScript, captureScript, restoreScript, shellWord } from "./checkpointScripts.ts";
import { fileOps } from "./files.ts";
import {
  captureCheckpoint,
  deleteRef,
  diffCommits,
  type GitFs,
  parentsOf,
  type Repo,
  repoFacts,
  resolveCommit,
  withinGuard,
} from "./gitRepo.ts";
import { containerPatterns, ContainerOnlyBackend, submoduleDirsScript, submodulePaths } from "./containerOnly.ts";
import { isomorphicFs } from "./isoFs.ts";
import { CREDENTIAL_HELPER_VERSION } from "./credentialHelper.ts";
import { type Asked, EXPECTATION_MAX_MS, type LinkedWork, prunedLinkedWork, pushDecision, type PushExpectation, type Taint, taintAfter } from "./linkedPush.ts";
import { advertisedTips, pushCard, type ReportedCommit } from "./pushCard.ts";
import type { RefUpdate } from "./pushGateway.ts";
import { allowedRead, parsePrimed, passiveDecision, primeArgvs, primeScript, withoutOwnGitDir } from "./gitDirReads.ts";
import { type StaleOutcome, staleRead } from "./staleReads.ts";
import { readCache, readKey } from "./readCache.ts";
import { ModelKeyGate } from "./modelKey.ts";
import { type CredentialPattern, type LeakScanAnswer, type LeakScanInput, leakScanArgv, patternOf } from "@t3flare/sandbox-image/leakscan";
import { ProcessHost, type ProcessMarker } from "./processHost.ts";
import { TerminalHost } from "./terminalHost.ts";
import { TerminalSync } from "./terminalSync.ts";
import { carryInScript, carryOutScript, parseBundleAnswer, parseCarryOut, parseTips, worktreeBundleScript, worktreeCloneScript, worktreeFinishScript } from "./worktreeScripts.ts";
import {
  CONTAINER_BACKEND,
  CONTAINER_IDLE_MS,
  CONTAINER_IGNORE,
  CONTAINER_INSTANCE,
  TERMINAL_IDLE_MS,
  TERMINAL_PROMPT_IDLE_MS,
  WORKER_SHELL_BACKEND,
  WORKSPACE_BINDING,
  WORKSPACE_CONTAINER,
  WORKSPACE_ROOT,
} from "./constants.ts";

export interface WorkspaceEnv {
  readonly LOADER: WorkerLoader;
  /** This namespace: a worktree Workspace reads its project's bundle from the project's object (step 2b). */
  readonly WORKSPACES: DurableObjectNamespace;
  /** The Environment DO, the token broker (ADR-0018): the credential helper's tokens come from it. */
  readonly ENVIRONMENT: DurableObjectNamespace;
  /** The identity of commits the agent makes (step 2a; defaults below). */
  readonly T3FLARE_GIT_NAME?: string;
  readonly T3FLARE_GIT_EMAIL?: string;
  readonly CONTAINER_BUDGET: DurableObjectNamespace<ContainerBudget>;
  /** Overrides TERMINAL_PROMPT_IDLE_MS (the stage's idle-hold check). */
  readonly T3FLARE_TERMINAL_PROMPT_IDLE_MS?: string;
  /** Overrides CONTAINER_IDLE_MS (tests). */
  readonly T3FLARE_CONTAINER_IDLE_MS?: string;
  /** Overrides TERMINAL_IDLE_MS (the stage's idle-hold check). */
  readonly T3FLARE_TERMINAL_IDLE_MS?: string;
  /** This Worker's Session DOs (step 3, D1): a linked thread's Session approves each push from its Workspace. */
  readonly SESSIONS?: DurableObjectNamespace;
  /** Test stages only: the stage-only probes and faults answer. */
  readonly T3FLARE_FAULTS?: string;
  /** Step 4a (ADR-0016 A′): the CLI agents' own model proxy key, answered by the key route only. */
  readonly COMMISSARY_CONTAINER_API_KEY?: string;
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
  /** A read t3 makes on its own: it does not keep the Container up (no last-use update). */
  readonly passive?: boolean;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly status: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** One file operation of the Environment's (`fs`). */
export type FsOp =
  | { readonly op: "stat"; readonly path: string; readonly follow?: boolean }
  | { readonly op: "read"; readonly path: string; readonly range?: { readonly offset: number; readonly length: number } }
  | { readonly op: "write"; readonly path: string; readonly data: Uint8Array | string; readonly options?: { readonly append?: boolean; readonly exclusive?: boolean } }
  | { readonly op: "readdir"; readonly path: string }
  | { readonly op: "mkdir"; readonly path: string; readonly recursive?: boolean }
  | { readonly op: "remove"; readonly path: string; readonly options?: { readonly recursive?: boolean; readonly force?: boolean } }
  | { readonly op: "rename"; readonly path: string; readonly to: string }
  | { readonly op: "realPath"; readonly path: string }
  | { readonly op: "find"; readonly path: string; readonly pattern?: string; readonly limit?: number }
  | { readonly op: "grep"; readonly path: string; readonly pattern: string; readonly options?: { readonly ignoreCase?: boolean; readonly regex?: boolean; readonly limit?: number; readonly include?: string } };


const LAST_USE_KEY = "t3flare:container-last-use";
/** When the Container started (its lease taken): the idle stop logs its lifetime (cost audit F2). */
const STARTED_AT_KEY = "t3flare:container-started-at";
/**
 * Prints the memory peak (`peak <bytes>`) and CPU time (`usage_usec <µs>`) of the cgroup v2 the Container's commands run
 * in (`/cloudchamber` on the platform's microVM; the root cgroup has no `memory.peak`).
 */
const USAGE_SCRIPT = [
  "cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)",
  'peak=$(cat "$cg/memory.peak" 2>/dev/null) && echo "peak $peak"',
  `grep -E '^usage_usec ' "$cg/cpu.stat" 2>/dev/null`,
  "true",
].join("\n");
/** Set by `destroy()` (review F4): every RPC but provisioning refuses, so a purged Workspace is never recreated. */
const DESTROYED_KEY = "t3flare:destroyed";
/** A worktree's copy of its project's untracked files (step 2b, plan section 4.2), linked at the project's t3 path in its Container. */
export const PROJECT_ROOT_VIEW = `${HARNESS_ROOT}/project-root`;
const PROJECT_ROOT_MAX_FILES = 1000;
const PROJECT_ROOT_MAX_BYTES = 20 * 1024 * 1024;
const LEASED_KEY = "t3flare:container-leased";
export { CREDENTIAL_HELPER, CREDENTIAL_PATH };
/** Where the Container's key helper asks this object for the CLI agents' model key (step 4a). */
export const MODEL_KEY_PATH = "/t3flare/model-key";
const WORKSPACE_ID_KEY = "t3flare:workspace-id";
/** Step 3 (D1): linked Sessions that ran commands here, and until when each counts. */
const LINKED_WORK_KEY = "t3flare:linked-work";
/** SPI-992 (review H1): the Workspace's durable taint, set by linked work, cleared only by the owner. */
const TAINT_KEY = "t3flare:taint";
/** SPI-992 (review M2): t3's own pushes the router is running, by id. */
const EXPECTATIONS_KEY = "t3flare:push-expectations";
/** SPI-992 (review H1): the owner's Sessions that ran commands here lately, and until when each counts. */
const OWNER_COMMANDS_KEY = "t3flare:owner-commands";
/** A cached token is renewed this long before it expires. */
const TOKEN_RENEW_MS = 5 * 60_000;
/** The markers of the shells this object started (orphans after a restart are killed by them). */
const TERMINAL_MARKERS_KEY = "t3flare:terminal-markers";
/** Step 4a: the markers of the CLI processes this object started, with their Environment epoch. */
const PROCESS_MARKERS_KEY = "t3flare:process-markers";
/** Step 4a (review F6): this object's boot counter, the process channel's epoch. */
const BOOT_COUNT_KEY = "t3flare:boot-count";
/**
 * CLI processes per Workspace (plan §2.1, review F7): an idle Codex app-server measured 157–160 MB RSS on step4a
 * (docs/steps/step-4a/m3-memory.json), so four take about 0.65 GB of 3 GiB, beside computerd (~100 MB) and the agents'
 * own commands (an `npm ci` and its tests peak at 1–1.5 GB). A fifth start is refused with this reason.
 */
export const MAX_CLI_PROCESSES = 4;
/** Set when the sync guard found a credential in the Workspace: the key is to be rotated (review F3). */
const LEAK_FLAG_KEY = "t3flare:credential-leak";
/** Where the sync guard moves a file holding a credential: the Container's own disk, never synced. */
const QUARANTINE = "/var/lib/t3flare/quarantine";
/** Directories the sync guard never reads: they stay on the Container's disk (`CONTAINER_IGNORE`). */
const SCAN_SKIP = ["node_modules", ".venv", "target", ".cache", ".pnpm-store", "__pycache__", ".turbo", ".next", ".gradle"];
/** Linked work held while a linked thread's CLI process lives (review F8): until it exits, not a time. */
const LINKED_WHILE_ALIVE = Number.MAX_SAFE_INTEGER;
/** How often terminals' heartbeats are checked while any is open. */
const TERMINAL_EXPIRE_EVERY_MS = 15_000;


/** The last checkpoint captured: its commit, the files' revision then, and HEAD then (the alias above the guard). */
const LAST_CAPTURE_KEY = "t3flare:last-capture";
/** While a worktree is being made: its project's submodule paths (`#containerPatterns`). */
const SUBMODULE_HINT_KEY = "t3flare:submodule-hint";

/** t3's repository probe, answered from the Workspace's own files when it was never answered (`#emulatedRead`). */
const VCS_DETECT = "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir";

const ContainerHost = withWorkspaceContainer(class extends DurableObject<WorkspaceEnv> {});

export class WorkspaceDO extends ContainerHost {
  readonly #workspace: ComputerWorkspace;
  readonly #reads: ReturnType<typeof readCache>;
  readonly #container: ContainerOnlyBackend;
  /** The Session's `ComputerExecutionEnv` file operations (the agent's tools), answered here. */
  readonly #host: WorkspaceEnvHost;
  #hostReady: Promise<void> | undefined;
  /** Commands running now: the Container is not stopped under them. */
  #running = 0;
  /** This instance (review F11): the adapter learns from a new epoch that the old instance's terminals are gone. */
  readonly #epoch = crypto.randomUUID();
  readonly #terminals: TerminalHost;
  readonly #terminalSync: TerminalSync;
  #expireTimer: ReturnType<typeof setInterval> | undefined;
  /** The CLI processes (step 4a). */
  readonly #processes: ProcessHost;
  /** This object's boot counter (review F6): the process channel's epoch, durable, never a UUID. */
  readonly #boot: number;
  /** The key route's nonces: one per live CLI process, with its CLI and the grants it took. */
  readonly #keyGate = new ModelKeyGate(() => crypto.randomUUID());
  /** When the sync guard last scanned (its files changed after this are scanned next). */
  #lastScan = 0;
  /** A CLI process ran since the last scan: the next pull is scanned even if none runs now. */
  #cliSinceScan = false;
  /** Patterns of the git tokens this object handed to the Container lately, and of the gateway's write token (never handed). */
  readonly #tokenPatterns: Array<CredentialPattern> = [];
  /** The read-only token the credential helper is given (SPI-992), until shortly before it expires. */
  #readToken: { readonly token: string; readonly expiresAt: number } | undefined;
  /** The push gateway's write token and the repo it is for: in this object's memory only, never sent to the Container. */
  #pushToken: { readonly token: string; readonly expiresAt: number; readonly repo: { readonly owner: string; readonly name: string } } | undefined;
  /** The owner's questions about pushes in flight, by the gateway's ask id: how to withdraw each (review M7). */
  readonly #pushAsks = new Map<string, () => Promise<void>>();
  /** Ask ids withdrawn before their question was raised. */
  readonly #withdrawnAsks = new Set<string>();
  /** Test stages only (`probePush`): how long each gateway decision is held (P2). */
  #probeHoldMs = 0;
  /** Whether bubblewrap works in the running Container (review F5): probed once per Container start. */
  #sandbox: Promise<boolean> | undefined;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    const ref = { binding: WORKSPACE_BINDING, id: ctx.id.toString() };
    // Made again for each Container start whose ignore patterns differ: submodules stay on the Container's disk.
    this.#container = new ContainerOnlyBackend({
      make: (patterns) =>
        new ContainerBackend({
          container: () => ({ getWorkspaceContainer: () => this.#budgeted(this.getWorkspaceContainer()) }),
          workspace: ref,
          name: WORKSPACE_CONTAINER,
          instance: CONTAINER_INSTANCE,
          // Unrestricted direct egress in part 1, as cloudpid's v1 (an allowlist is deferred, docs/plan.md).
          egress: { mode: "direct" },
          ignore: [...patterns],
          connectTimeoutMs: 60_000,
        }),
      initial: containerPatterns(CONTAINER_IGNORE, []),
      patterns: () => this.#containerPatterns(),
      stop: async () => {
        if (this.ctx.container?.running === true) await this.ctx.container.destroy();
      },
      log: (event) => console.log(JSON.stringify({ ...event, workspace: this.#workspaceId() ?? null })),
    });
    this.#reads = readCache(ctx.storage.sql);
    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
      backends: [new WorkerShellBackend({ loader: env.LOADER, workspace: ref, ctx }), this.#container],
    });
    // The model's file tools reach Container-only paths through the Container (cloudpid's ADR-0018), as a script.
    this.#host = new WorkspaceEnvHost(this.#workspace, {
      patterns: async () => withHarnessKept(await this.#containerPatterns()),
      running: () => this.containerRunning(),
      run: async (script, scriptEnv) => {
        const result = await this.exec({ script, env: { ...scriptEnv }, cwd: WORKSPACE_ROOT });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    });
    const { BASH_ENV: _bashEnv, ...terminalEnv } = COMMAND_ENV;
    this.#terminalSync = new TerminalSync({
      now: () => Date.now(),
      running: () => this.containerRunning(),
      pull: async () => {
        await this.#scanBeforePull();
        return this.#syncEntries("pull");
      },
      push: () => this.#syncEntries("push"),
      revision: () => currentRevision(ctx.storage.sql),
      active: () => this.#terminals.size > 0 || this.#processes.size > 0,
    });
    this.#terminals = new TerminalHost({
      now: () => Date.now(),
      epoch: this.#epoch,
      running: () => this.containerRunning(),
      startContainer: async () => {
        try {
          await this.exec({ script: "true", timeoutMs: 180_000 });
        } catch (error) {
          // The budget's own reason, out of computer's connect-retry wrapping.
          const reason = /the Container cannot start: (.+?)(?:"|$)/s.exec(String(error))?.[1];
          throw new Error(reason === undefined ? String(error).slice(0, 300) : `the Container cannot start: ${reason}`);
        }
      },
      spawn: async (argv, options) => {
        const container = this.ctx.container;
        if (container === undefined) throw new Error("no Container binding");
        return container.exec([...argv], { pty: { cols: options.cols, rows: options.rows }, stdin: "pipe", env: options.env });
      },
      kill: (markers) => this.#killMarkers(markers),
      push: async (push) => {
        const id = this.#workspaceId();
        if (id === undefined) return { unknown: push.frames.map((frame) => frame.key) };
        return environmentStub(this.env.ENVIRONMENT).terminalOutput({ workspace: id, ...push });
      },
      baseEnv: terminalEnv,
      filesMayHaveChanged: (why) => this.#terminalSync.changed(why),
      remember: (markers) => ctx.storage.kv.put(TERMINAL_MARKERS_KEY, [...markers]),
      remembered: () => ctx.storage.kv.get<ReadonlyArray<string>>(TERMINAL_MARKERS_KEY) ?? [],
      beforeSpawn: async () => {
        if (this.containerRunning()) await this.#syncEntries("push");
      },
      projectRootView: PROJECT_ROOT_VIEW,
    });
    this.#boot = (ctx.storage.kv.get<number>(BOOT_COUNT_KEY) ?? 0) + 1;
    ctx.storage.kv.put(BOOT_COUNT_KEY, this.#boot);
    this.#processes = new ProcessHost({
      now: () => Date.now(),
      epoch: this.#boot,
      running: () => this.containerRunning(),
      startContainer: () => this.#startContainerFor("process"),
      spawn: async (argv, env) => {
        const container = this.ctx.container;
        if (container === undefined) throw new Error("no Container binding");
        return container.exec([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
      },
      kill: (markers) => this.#killMarkers(markers),
      baseEnv: terminalEnv,
      remember: (markers) => ctx.storage.kv.put(PROCESS_MARKERS_KEY, [...markers]),
      remembered: () => ctx.storage.kv.get<ReadonlyArray<ProcessMarker>>(PROCESS_MARKERS_KEY) ?? [],
      filesMayHaveChanged: (why) => this.#terminalSync.changed(why),
      maxProcesses: MAX_CLI_PROCESSES,
      allowProbe: env.T3FLARE_FAULTS === "1",
      beforeStart: async (input) => ({ env: { T3FLARE_MODEL_KEY_NONCE: this.#keyGate.issue(input.key, input.cli) }, sandbox: await this.#sandboxWorks() }),
      linkedWork: (thread, alive) => {
        const linked: Record<string, number> = { ...prunedLinkedWork(ctx.storage.kv.get<LinkedWork>(LINKED_WORK_KEY) ?? {}, Date.now()) };
        const name = `cli:${thread}`;
        if (alive) {
          linked[name] = LINKED_WHILE_ALIVE;
          ctx.storage.kv.put(TAINT_KEY, taintAfter(ctx.storage.kv.get<Taint>(TAINT_KEY) ?? null, name, Date.now()));
        } else delete linked[name];
        ctx.storage.kv.put(LINKED_WORK_KEY, linked);
      },
    });
  }

  /** The credentials the sync guard looks for: the CLI agents' key and the git tokens handed out lately. */
  async #patterns(): Promise<ReadonlyArray<CredentialPattern>> {
    const key = this.env.COMMISSARY_CONTAINER_API_KEY;
    return [...(key === undefined || key === "" ? [] : [await patternOf("model-key", key)]), ...this.#tokenPatterns];
  }

  async #rememberToken(token: string, name: "github-token" | "gateway-token" = "github-token"): Promise<void> {
    this.#tokenPatterns.push(await patternOf(name, token));
    if (this.#tokenPatterns.length > 20) this.#tokenPatterns.splice(0, this.#tokenPatterns.length - 20);
  }

  /** Runs the scanner in the running Container, straight through the platform's exec (no computer sync around it). */
  async #scan(input: Omit<LeakScanInput, "patterns">): Promise<LeakScanAnswer | undefined> {
    const container = this.ctx.container;
    if (container === undefined || !container.running) return undefined;
    const patterns = await this.#patterns();
    if (patterns.length === 0) return undefined;
    const process = await container.exec([...leakScanArgv({ ...input, patterns })], { stdout: "pipe", stderr: "pipe" });
    const output = await process.output();
    const text = new TextDecoder().decode(output.stdout as unknown as Uint8Array);
    try {
      return JSON.parse(text.trim().split("\n").at(-1) ?? "") as LeakScanAnswer;
    } catch {
      console.warn(JSON.stringify({ t3flare: "leakscan-failed", workspace: this.#workspaceId() ?? null, stderr: new TextDecoder().decode(output.stderr as unknown as Uint8Array).slice(0, 300) }));
      return undefined;
    }
  }

  /**
   * The sync guard (review F3): while a CLI process lives, the files changed since the last scan are scanned in the
   * Container before computer pulls them. A file with a credential is moved out of the synced tree, every CLI process is
   * killed, and the key is flagged for rotation.
   */
  async #scanBeforePull(): Promise<void> {
    // While a CLI process lives, and once more after the last one ended (what it wrote last).
    if (this.#processes.size === 0 && !this.#cliSinceScan) return;
    this.#cliSinceScan = this.#processes.size > 0;
    const started = Date.now();
    const answer = await this.#scan({ roots: ["/workspace"], since: this.#lastScan === 0 ? 0 : this.#lastScan - 2000, quarantine: QUARANTINE, skip: SCAN_SKIP }).catch(() => undefined);
    if (answer === undefined) return;
    this.#lastScan = started;
    if (answer.hits.length > 0) await this.#onLeak(answer.hits);
  }

  /** The scanner as a script suffix, its answer left in a file on the Container's disk (`#readScanResult`). */
  async #scanSuffix(): Promise<string | undefined> {
    const patterns = await this.#patterns();
    if (patterns.length === 0) return undefined;
    const started = Date.now();
    const argv = leakScanArgv({ patterns, roots: ["/workspace"], since: this.#lastScan === 0 ? 0 : this.#lastScan - 2000, quarantine: QUARANTINE, skip: SCAN_SKIP });
    this.#lastScan = started;
    const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    return `mkdir -p /var/lib/t3flare && ${argv[0]} -e "$(printf %s '${b64(argv[2]!)}' | base64 -d)" "$(printf %s '${b64(argv[3]!)}' | base64 -d)" > /var/lib/t3flare/last-scan.json 2>/dev/null`;
  }

  async #readScanResult(): Promise<void> {
    const container = this.ctx.container;
    if (container === undefined || !container.running) return;
    const process = await container.exec(["cat", "/var/lib/t3flare/last-scan.json"], { stdout: "pipe", stderr: "ignore" }).catch(() => undefined);
    if (process === undefined) return;
    const output = await process.output();
    try {
      const answer = JSON.parse(new TextDecoder().decode(output.stdout as unknown as Uint8Array)) as LeakScanAnswer;
      if (answer.hits.length > 0) await this.#onLeak(answer.hits);
    } catch {
      // No answer: the command's scan did not run.
    }
  }

  async #onLeak(hits: LeakScanAnswer["hits"]): Promise<void> {
    console.error(JSON.stringify({ t3flare: "credential-in-workspace", workspace: this.#workspaceId() ?? null, hits: hits.map((hit) => ({ name: hit.name, path: hit.path, quarantined: hit.quarantined ?? null })) }));
    this.ctx.storage.kv.put(LEAK_FLAG_KEY, { at: Date.now(), names: [...new Set(hits.map((hit) => hit.name))], paths: hits.map((hit) => hit.path).slice(0, 20) });
    for (const key of this.#processes.keys()) await this.#processes.signal(key).catch(() => undefined);
  }

  /**
   * The leak check (plan §4.7, acceptance): the Workspace's own files searched for each credential's value (the DO side),
   * and the Container's files, process environments and command lines scanned by hash (nothing sent in). Names and paths
   * only, never a value.
   */
  async leakCheck(): Promise<{ readonly do: ReadonlyArray<{ readonly name: string; readonly path: string }>; readonly container: LeakScanAnswer | null; readonly flagged: unknown }> {
    this.#alive();
    await this.#workspace.ready();
    const values: Array<[string, string]> = [];
    const key = this.env.COMMISSARY_CONTAINER_API_KEY;
    if (key !== undefined && key !== "") values.push(["model-key", key]);
    const found: Array<{ name: string; path: string }> = [];
    for (const [credential, value] of values) {
      // computer's own grep over the DO's files; only the paths are kept (the matched text would hold the value).
      const matches = await this.#workspace.fs.grep(value, WORKSPACE_ROOT, { regex: false, limit: 200 });
      for (const path of new Set(matches.map((match) => match.path))) found.push({ name: credential, path });
    }
    const container = (await this.#scan({ roots: ["/workspace", "/root", "/tmp", "/var/lib/t3flare", "/var/lib/computerd"], since: 0, procs: true, skip: [] }).catch(() => undefined)) ?? null;
    return { do: found, container, flagged: this.ctx.storage.kv.get(LEAK_FLAG_KEY) ?? null };
  }

  /** bubblewrap in the running Container (Codex's Linux sandbox needs user namespaces): once per Container start. */
  #sandboxWorks(): Promise<boolean> {
    this.#sandbox ??= (async () => {
      const container = this.ctx.container;
      if (container === undefined || !container.running) return false;
      try {
        const process = await container.exec(["bwrap", "--unshare-all", "--ro-bind", "/", "/", "true"], { stdout: "ignore", stderr: "ignore" });
        const works = (await process.exitCode) === 0;
        console.log(JSON.stringify({ t3flare: "sandbox-probe", workspace: this.#workspaceId() ?? null, works }));
        return works;
      } catch {
        return false;
      }
    })();
    return this.#sandbox;
  }

  /** Starts the Container for a terminal or a CLI process; the budget's own reason when refused. */
  async #startContainerFor(_what: "terminal" | "process"): Promise<void> {
    try {
      await this.exec({ script: "true", timeoutMs: 180_000 });
    } catch (error) {
      // The budget's own reason, out of computer's connect-retry wrapping.
      const reason = /the Container cannot start: (.+?)(?:"|$)/s.exec(String(error))?.[1];
      throw new Error(reason === undefined ? String(error).slice(0, 300) : `the Container cannot start: ${reason}`);
    }
  }

  /**
   * The ignore patterns the Container needs (`containerOnly.ts`): the static ones, and the submodules the repo's
   * `.gitmodules` names, or, while a worktree is being made, its project's (`SUBMODULE_HINT_KEY`).
   */
  async #containerPatterns(): Promise<ReadonlyArray<string>> {
    let gitmodules = "";
    try {
      await this.#workspace.ready();
      gitmodules = await this.#workspace.fs.readFile(`${REPO_ROOT}/.gitmodules`, "utf8");
    } catch {
      // No `.gitmodules`: no submodules.
    }
    const hint = this.ctx.storage.kv.get<ReadonlyArray<string>>(SUBMODULE_HINT_KEY) ?? [];
    return containerPatterns(CONTAINER_IGNORE, [...new Set([...hint, ...submodulePaths(gitmodules)])]);
  }

  /**
   * Before a command that may write (an action, the agent's, a terminal's start): a running Container started without
   * the patterns the repo's submodules need (a clone or a checkout that brought a `.gitmodules`) is stopped, so a
   * `git submodule update` never pulls a submodule into the DO's files; the command starts it again with them. Passive
   * reads go on in the running Container.
   */
  async #restartForSubmodules(): Promise<void> {
    // Never under a running command or an open terminal: the restart waits for the next quiet command.
    if (!this.containerRunning() || this.#running > 0 || this.#terminals.size > 0) return;
    const needed = await this.#containerPatterns();
    if (needed.every((pattern) => this.#container.patterns.includes(pattern))) return;
    console.log(JSON.stringify({ t3flare: "container-restart-for-submodules", workspace: this.#workspaceId() ?? null, patterns: needed }));
    await this.stopContainer();
  }

  /** One sync with the Container backend to completion (review F9: never the default backend). */
  async #syncEntries(direction: "pull" | "push"): Promise<number> {
    let entries = 0;
    for await (const progress of direction === "pull" ? this.#workspace.pull(CONTAINER_BACKEND) : this.#workspace.push(CONTAINER_BACKEND)) {
      entries += progress.entries;
    }
    return entries;
  }

  /** Part 2's kill script on terminal markers, run straight on the Container (never starting it). */
  async #killMarkers(markers: ReadonlyArray<string>): Promise<void> {
    const output = await killInRunningContainer(this.ctx.container, markers);
    if (output === undefined) return;
    console.log(JSON.stringify({ t3flare: "terminal-kill", markers: markers.length, answer: output.stdout.trim() }));
  }

  /** One of `ComputerExecutionEnv`'s file operations (the Session's tools), answered as plain data. */
  async fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    this.#alive();
    await this.#workspace.ready();
    this.#hostReady ??= this.#host.prepare(WORKSPACE_ROOT, Date.now());
    await this.#hostReady;
    return this.#host.handle(request);
  }

  /** No skills, prompt templates or nested instruction files in part 1 (the Session reads AGENTS.md itself). */
  skills(_cwd: string): Promise<ReadonlyArray<never>> {
    return Promise.resolve([]);
  }

  prompts(_cwd: string): Promise<ReadonlyArray<never>> {
    return Promise.resolve([]);
  }

  instructions(_directory: string): Promise<ReadonlyArray<never>> {
    return Promise.resolve([]);
  }

  /** The platform's Container API with the budget's lease taken before every start (step 2a cost guardrails). */
  #budgeted(api: IWorkspaceContainerAPI): IWorkspaceContainerAPI {
    const lease = async () => {
      let answer = await this.#budget().acquire(this.ctx.id.toString());
      if (!answer.ok && (await this.#reclaimFrom(answer.running))) answer = await this.#budget().acquire(this.ctx.id.toString());
      if (!answer.ok) throw new Error(`t3flare: the Container cannot start: ${answer.reason}`);
      await this.ctx.storage.put(LEASED_KEY, true);
      if ((await this.ctx.storage.get<number>(STARTED_AT_KEY)) === undefined) await this.ctx.storage.put(STARTED_AT_KEY, Date.now());
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

  /**
   * The budget is full (review F7): asks each holder to stop its Container if nothing there works, idle CLI sessions
   * included; answers whether one did.
   */
  async #reclaimFrom(holders: ReadonlyArray<string>): Promise<boolean> {
    for (const holder of holders) {
      if (holder === this.ctx.id.toString()) continue;
      try {
        // SAFETY: a holder is a Workspace DO's id (`#budgeted`); `releaseIfIdle` is its RPC.
        const stub = this.env.WORKSPACES.get(this.env.WORKSPACES.idFromString(holder)) as unknown as { releaseIfIdle(): Promise<{ readonly released: boolean; readonly reason: string }> };
        const answer = await stub.releaseIfIdle();
        if (answer.released) {
          console.log(JSON.stringify({ t3flare: "container-reclaimed", from: holder, for: this.#workspaceId() ?? null }));
          return true;
        }
      } catch (error) {
        console.warn(JSON.stringify({ t3flare: "container-reclaim-failed", from: holder, error: String(error).slice(0, 200) }));
      }
    }
    return false;
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
    let at = Math.min(lastUse + this.#idleMs(), Date.now() + RENEW_EVERY_MS);
    // Open terminals: their heartbeats are checked and their hold measured at least every 30 s.
    if (this.#terminals.size > 0 || this.#processes.size > 0) at = Math.min(at, Date.now() + 30_000);
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
    this.#alive();
    const started = Date.now();
    const backend = input.backend === "worker-shell" ? WORKER_SHELL_BACKEND : CONTAINER_BACKEND;
    if (backend === CONTAINER_BACKEND && input.passive !== true) await this.#restartForSubmodules().catch(() => undefined);
    this.#running++;
    try {
      await this.#workspace.ready();
      // The patterns this command's Container starts with, or started with (`containerOnly.ts`).
      // While a CLI process lives, the command's own pull (computer syncs when it ends) is guarded too (review F3): the
      // command runs in a subshell, then the scanner, before computer reads the files.
      const guard = backend === CONTAINER_BACKEND && input.passive !== true && this.#processes.size > 0 ? await this.#scanSuffix() : undefined;
      const body = guard === undefined ? input.script : `(\n${input.script}\n)\n__t3flare_rc=$?\n${guard}\nexit $__t3flare_rc`;
      const script = backend === CONTAINER_BACKEND ? `${submoduleDirsScript(await this.#containerPatterns())}${body}` : body;
      const handle = await this.#workspace.runtime.exec(script, {
        backend,
        cwd: input.cwd ?? WORKSPACE_ROOT,
        encoding: "utf8",
        env: backend === CONTAINER_BACKEND ? { ...COMMAND_ENV, ...input.env } : { ...input.env },
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeoutMs: input.timeoutMs ?? 120_000,
      });
      const result = await handle.result();
      if (guard !== undefined) await this.#readScanResult();
      return {
        exitCode: result.exitCode,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        ms: Date.now() - started,
      };
    } finally {
      this.#running--;
      if (backend === CONTAINER_BACKEND && input.passive !== true) {
        await this.#noteUse();
        await this.#scheduleAlarm();
      }
    }
  }

  /**
   * Kills the processes of the Session's commands `execIds` (step 2a part 2; apps/sandbox-image/src/kill.ts): those whose
   * environment carries one of the ids, by process group where the whole group is theirs. Nothing to do, and the
   * Container never started, when it is not running, even when it stops during the kill (`containerKill.ts`): a stopped
   * Container has no processes.
   */
  async killExecs(execIds: ReadonlyArray<string>): Promise<{ readonly running: boolean; readonly signalled: number; readonly survivors: number }> {
    const result = await killInRunningContainer(this.ctx.container, execIds);
    if (result === undefined) return { running: false, signalled: 0, survivors: 0 };
    const answer = /\{"signalled":(\d+),"survivors":(\d+)\}/.exec(result.stdout);
    if (answer === null) throw new Error(`t3flare: the kill script failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    return { running: true, signalled: Number(answer[1]), survivors: Number(answer[2]) };
  }

  /** Reads a text file from the Workspace's own files (never the Container). Paths inside the Workspace. */
  async readText(path: string): Promise<string | null> {
    this.#alive();
    await this.#workspace.ready();
    try {
      return await this.#workspace.fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  /** Writes a text file into the Workspace's own files, as the agent's file tools do. */
  async writeText(path: string, text: string): Promise<void> {
    this.#alive();
    await this.#workspace.ready();
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
    await this.#workspace.fs.writeFile(path, text);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The Environment's file operations (its own files, never the Container) and git (step 2a plan, section 2)

  async fs(op: FsOp): Promise<FsAnswer<unknown>> {
    this.#alive();
    await this.#workspace.ready();
    const ops = fileOps(this.#workspace);
    switch (op.op) {
      case "stat":
        return ops.stat(op.path, op.follow ?? true);
      case "read":
        return ops.read(op.path, op.range);
      case "write":
        return ops.write(op.path, op.data, op.options);
      case "readdir":
        return ops.readdir(op.path);
      case "mkdir":
        return ops.mkdir(op.path, op.recursive ?? false);
      case "remove":
        return ops.remove(op.path, op.options ?? {});
      case "rename":
        return ops.rename(op.path, op.to);
      case "realPath":
        return ops.realPath(op.path);
      case "find":
        return ops.find(op.path, op.pattern, op.limit ?? 5000);
      case "grep":
        return ops.grep(op.pattern, op.path, op.options ?? {});
    }
  }

  /**
   * Real git in the Container (ADR-0009 item 3). A passive read (`startContainer: false`, t3's own status polls) is
   * answered from the read cache while the repo is unchanged, and does not count as use: a client watching an idle
   * Workspace never keeps its Container up. A passive read the cache cannot answer runs in the Container only if it is
   * running; while it is stopped the read gets its last real answer patched with the write journal (`#stale`), and the
   * Container stays stopped (the parent's ruling on M2's deviation 2; ADR-0009 refinement).
   */
  async git(run: GitRun): Promise<GitAnswer> {
    if (this.#isDestroyed()) return { ran: false, reason: "container_refused", detail: "t3flare: this Workspace was deleted" };
    const passive = !run.startContainer;
    // Step 2b (root's ruling, ADR-0009 refinement): the allow-listed `.git` reads are keyed without env and own
    // `--git-dir`, so the answers primed while the Container was up match t3's later reads.
    const allowed = passive ? allowedRead(run.argv, REPO_ROOT) : undefined;
    const key = passive ? await readKey(allowed === undefined ? run : { argv: withoutOwnGitDir(run.argv, REPO_ROOT), cwd: run.cwd }) : null;
    const rev = passive ? this.#reads.revision(run.readScope ?? "repo") : -1;
    let startedBy: string | undefined;
    if (key !== null) {
      const hit = this.#reads.get(key, rev);
      const decision = passiveDecision({
        cachedNow: hit !== undefined,
        running: this.containerRunning(),
        hasLastAnswer: this.#reads.last(key) !== undefined,
        allowed: allowed !== undefined,
        emulated: allowed?.name === "remotes",
      });
      if (hit !== undefined) return { ran: true, ...hit, ms: 0, cached: true };
      if (decision === "stale") return this.#stale(run, key);
      if (decision === "run-starting-container") {
        startedBy = allowed!.name;
        console.log(JSON.stringify({ t3flare: "first-read-starts-container", read: allowed!.name, caller: allowed!.caller }));
      }
    }
    const script = `exec git ${run.argv.map(shellWord).join(" ")}`;
    try {
      const result = await this.exec({
        script,
        cwd: run.cwd,
        env: { ...this.#identityEnv(), ...run.env },
        ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
        timeoutMs: run.timeoutMs ?? 120_000,
        passive,
      });
      const answer = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      // Kept at the revision from before it ran: a change while it ran makes the next read run again.
      if (key !== null && result.status !== "timeout") this.#reads.put(key, rev, answer);
      // The Container is up: answer the allow-listed reads now (after an action, or a start a read caused).
      if (!passive || startedBy !== undefined) this.ctx.waitUntil(this.#prime().catch(() => undefined));
      return { ran: true, ...answer, ms: result.ms, ...(startedBy === undefined ? {} : { startedContainer: startedBy }) };
    } catch (error) {
      return { ran: false, reason: "container_refused", detail: String(error).slice(0, 1000) };
    }
  }

  #primedRev = -2;

  /**
   * Answers the allow-listed `.git` reads while the Container runs (root's ruling on step 2b M2): for the repo's branches
   * and remote-tracking refs, once per change of `.git`. Never starts the Container.
   */
  async #prime(): Promise<void> {
    if (!this.containerRunning()) return;
    const before = this.#reads.revision("git-dir");
    if (before === this.#primedRev) return;
    this.#primedRev = before;
    const listed = await this.exec({ script: "git for-each-ref --format='%(refname)' refs/heads refs/remotes", cwd: REPO_ROOT, passive: true });
    if (listed.exitCode !== 0 || !this.containerRunning()) return;
    const argvs = primeArgvs(listed.stdout.split("\n").filter((line) => line !== ""));
    const primed = await this.exec({ script: primeScript(argvs), cwd: REPO_ROOT, passive: true, timeoutMs: 60_000 });
    const rev = this.#reads.revision("git-dir");
    for (const answer of parsePrimed(primed.stdout)) {
      const argv = argvs[answer.index];
      if (argv === undefined) continue;
      this.#reads.put(await readKey({ argv, cwd: REPO_ROOT }), rev, { exitCode: answer.exitCode, stdout: answer.stdout, stderr: "" });
    }
    console.log(JSON.stringify({ t3flare: "git-reads-primed", reads: argvs.length }));
  }


  /**
   * A passive read with no earlier answer while the Container is stopped, answered from the repo's own files when its
   * shape is simple enough (step 2b: t3's worktree launch lists the project's remotes before anything starts it).
   */
  async #emulatedRead(run: GitRun): Promise<GitAnswer | undefined> {
    const args = run.argv.filter((arg, at, all) => !(arg === "--git-dir" || all[at - 1] === "--git-dir"));
    if (args.join(" ") === VCS_DETECT && run.cwd === REPO_ROOT) {
      // t3's VCS driver detection (`GitVcsDriver`'s repository probe, the first read of a project's thread launch):
      // what git answers at the root of a repo with its own `.git`, which is every Workspace's.
      if (!("ok" in (await fileOps(this.#workspace).stat(`${REPO_ROOT}/.git`, false)))) return undefined;
      return { ran: true, exitCode: 0, stdout: `true\n${REPO_ROOT}\n.git\n`, stderr: "", ms: 0, cached: true, stale: "patched" };
    }
    if (args[0] !== "remote" || (args.length > 1 && !(args.length === 2 && (args[1] === "-v" || args[1] === "--verbose")))) return undefined;
    const repo = await this.#repo();
    const remotes = await git.listRemotes({ fs: repo.fs, dir: repo.dir });
    const stdout = args.length === 1
      ? remotes.map((remote) => `${remote.remote}\n`).join("")
      : remotes.map((remote) => `${remote.remote}\t${remote.url} (fetch)\n${remote.remote}\t${remote.url} (push)\n`).join("");
    return { ran: true, exitCode: 0, stdout, stderr: "", ms: 0, cached: true, stale: "patched" };
  }

  /** Stale answers made since the files last changed, by read key: a client polling status patches once per change. */
  readonly #staleMemo = new Map<string, { readonly global: number; readonly answer: GitAnswer }>();

  /**
   * A passive read while the Container is stopped: its last real answer (or its sibling status shape's), patched with
   * the paths written since where the DO can afford it (`staleRead`).
   */
  async #stale(run: GitRun, key: string): Promise<GitAnswer> {
    const global = currentRevision(this.ctx.storage.sql);
    const memo = this.#staleMemo.get(key);
    if (memo !== undefined && memo.global === global) return memo.answer;
    const started = Date.now();
    let outcome: StaleOutcome;
    try {
      outcome = await staleRead(run, {
        last: async (argv) => (argv === run.argv ? this.#reads.last(key) : this.#reads.last(await readKey({ ...run, argv }))),
        journalSince: (rev) => this.#journalSince(rev, global),
        withinGuard: async () => withinGuard(await this.#repo()),
        facts: async (base) => repoFacts(await this.#repo(), base),
      });
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "stale-read-patch-failed", argv: run.argv.slice(0, 3), error: String(error).slice(0, 500) }));
      const last = this.#reads.last(key);
      outcome = last === undefined ? { found: false } : { found: true, answer: last.answer, stale: "last-answer" };
    }
    if (!outcome.found) {
      const emulated = await this.#emulatedRead(run).catch(() => undefined);
      if (emulated !== undefined) return emulated;
      return { ran: false, reason: "container_stopped", detail: "needs the Workspace's Container, which is stopped, and has no earlier answer" };
    }
    if (outcome.why !== undefined) console.log(JSON.stringify({ t3flare: "stale-read-last-answer", argv: run.argv.slice(0, 3), why: outcome.why }));
    const answer: GitAnswer = { ran: true, ...outcome.answer, ms: outcome.stale === "patched" ? Date.now() - started : 0, cached: true, stale: outcome.stale };
    this.#staleMemo.set(key, { global, answer });
    if (this.#staleMemo.size > 200) this.#staleMemo.delete(this.#staleMemo.keys().next().value!);
    return answer;
  }

  /** The repo's paths (relative, outside `.git`) written after revision `after` (computer's change log). */
  #journalSince(after: number, through: number): ReadonlyArray<string> {
    const prefix = `${REPO_ROOT}/`;
    return changedBetween(this.ctx.storage.sql, after, through)
      .map((changed) => changed.path)
      .filter((path) => path.startsWith(prefix) && path !== `${REPO_ROOT}/.git` && !path.startsWith(`${REPO_ROOT}/.git/`))
      .map((path) => path.slice(prefix.length));
  }

  #gitFs: GitFs | undefined;

  /** The repo, for isomorphic-git (a fresh parse cache per operation). */
  async #repo(): Promise<Repo> {
    await this.#workspace.ready();
    this.#gitFs ??= isomorphicFs(this.#workspace);
    return { fs: this.#gitFs, dir: REPO_ROOT, cache: {} };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Checkpoints (t3's `VcsCheckpointOps`, ADR-0009 items 1–2)

  /**
   * One of t3's checkpoint operations. Captures, diffs, ref checks and deletes run here with isomorphic-git and never
   * start the Container; a diff runs on the Container's git while it is running anyway (git's own text). A capture of a
   * repo above the guard makes the new ref an alias of the previous capture when nothing was written since, and runs
   * the Container's git otherwise. A restore, and the authored paths of a range where HEAD moved, run the Container's git.
   */
  async checkpoint(op: CheckpointOp): Promise<CheckpointAnswer> {
    this.#alive();
    try {
      const repo = await this.#repo();
      switch (op.op) {
        case "has":
          return { ok: true, value: (await resolveCommit(repo, op.ref)) !== null, by: "do" };
        case "delete":
          for (const ref of op.refs) await deleteRef(repo, ref);
          return { ok: true, value: null, by: "do" };
        case "capture":
          return await this.#capture(repo, op.ref);
        case "diff":
          return await this.#diff(repo, op);
        case "authored":
          return await this.#authored(repo, op.from, op.to);
        case "restore":
          return await this.#restore(repo, op.ref, op.fallbackToHead);
      }
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "checkpoint-failed", op: op.op, error: String(error).slice(0, 500) }));
      return { ok: false, error: String(error).slice(0, 1000) };
    }
  }

  async #capture(repo: Repo, ref: string): Promise<CheckpointAnswer> {
    const global = currentRevision(this.ctx.storage.sql);
    const head = await resolveCommit(repo, "HEAD");
    let answer: CheckpointAnswer;
    if (await withinGuard(repo)) {
      await captureCheckpoint(repo, ref, Math.floor(Date.now() / 1000));
      answer = { ok: true, value: null, by: "do" };
    } else {
      const previous = this.ctx.storage.kv.get<{ readonly commit: string; readonly rev: number; readonly head: string | null }>(LAST_CAPTURE_KEY);
      if (previous !== undefined && previous.head === head && this.#journalSince(previous.rev, global).length === 0) {
        await git.writeRef({ fs: repo.fs, dir: repo.dir, ref, value: previous.commit, force: true });
        answer = { ok: true, value: null, by: "alias" };
      } else {
        const result = await this.exec({ script: captureScript(ref), cwd: REPO_ROOT, env: this.#identityEnv(), timeoutMs: 10 * 60_000 });
        if (result.exitCode !== 0) return { ok: false, error: `git capture failed: ${result.stderr.slice(0, 1000)}` };
        answer = { ok: true, value: null, by: "container" };
      }
    }
    const commit = await resolveCommit(repo, ref);
    if (commit !== null) this.ctx.storage.kv.put(LAST_CAPTURE_KEY, { commit, rev: global, head });
    return answer;
  }

  async #diff(repo: Repo, op: Extract<CheckpointOp, { op: "diff" }>): Promise<CheckpointAnswer> {
    if (op.filePaths?.length === 0) return { ok: true, value: "", by: "do" };
    let from = await resolveCommit(repo, op.from);
    if (from === null && op.fallbackFromToHead) from = await resolveCommit(repo, "HEAD");
    const to = await resolveCommit(repo, op.to);
    if (from === null || to === null) return { ok: false, error: "Checkpoint ref is unavailable for diff operation." };
    if (this.containerRunning()) {
      const argv = [
        "-c", "diff.relative=false", "-c", "diff.suppressBlankEmpty=false", "diff",
        ...(op.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
        "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/",
        ...(op.ignoreWhitespace ? ["--ignore-all-space"] : []),
        `${from}^{commit}`, `${to}^{commit}`,
        ...(op.filePaths === undefined ? [] : ["--", ...op.filePaths.map((path) => `:(top,literal)${path}`)]),
      ];
      const result = await this.exec({ script: `exec git ${argv.map(shellWord).join(" ")}`, cwd: REPO_ROOT, passive: true });
      if (result.exitCode === 0) return { ok: true, value: result.stdout, by: "container" };
    }
    const value = await diffCommits(repo, from, to, { format: op.format, filePaths: op.filePaths, maxOutputBytes: op.maxOutputBytes });
    return { ok: true, value, by: "do" };
  }

  async #authored(repo: Repo, fromRef: string, toRef: string): Promise<CheckpointAnswer> {
    const from = await resolveCommit(repo, fromRef);
    const to = await resolveCommit(repo, toRef);
    if (from === null || to === null) return { ok: false, error: "Checkpoint ref is unavailable." };
    const [startHead] = await parentsOf(repo, from);
    const [endHead] = await parentsOf(repo, to);
    if (startHead === undefined || endHead === undefined || startHead === endHead) return { ok: true, value: null, by: "do" };
    // HEAD moved between the checkpoints (a commit, in the Container): its git lists the paths, as t3's driver does.
    const result = await this.exec({ script: authoredScript(from, to, startHead, endHead), cwd: REPO_ROOT, timeoutMs: 120_000 });
    if (result.exitCode !== 0) return { ok: false, error: result.stderr.slice(0, 1000) };
    return { ok: true, value: [...new Set(result.stdout.split("\0").filter((path) => path.length > 0))], by: "container" };
  }

  async #restore(repo: Repo, ref: string, fallbackToHead: boolean): Promise<CheckpointAnswer> {
    let commit = await resolveCommit(repo, ref);
    if (commit === null && fallbackToHead) commit = await resolveCommit(repo, "HEAD");
    if (commit === null) return { ok: true, value: false, by: "do" };
    const result = await this.exec({ script: restoreScript(commit), cwd: REPO_ROOT, timeoutMs: 10 * 60_000 });
    if (result.exitCode !== 0) return { ok: false, error: result.stderr.slice(0, 1000) };
    return { ok: true, value: true, by: "container" };
  }

  /** The agent's commit identity, for repos t3 made itself (`git init`, New project) that have none in their config. */
  #identityEnv(): Record<string, string> {
    const name = this.env.T3FLARE_GIT_NAME ?? "t3flare";
    const email = this.env.T3FLARE_GIT_EMAIL ?? "t3flare@users.noreply.github.com";
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  }

  /** Clones `input.url` into the Workspace's repo, in the Container, and sets the repo's identity and credentials. */
  async clone(input: CloneInput): Promise<GitAnswer> {
    this.#revive();
    this.#rememberId(input.id);
    const name = this.env.T3FLARE_GIT_NAME ?? "t3flare";
    const email = this.env.T3FLARE_GIT_EMAIL ?? "t3flare@users.noreply.github.com";
    const helper = CREDENTIAL_HELPER;
    const script = [
      "set -eu",
      `mkdir -p ${HARNESS_ROOT}/tmp`,
      `if [ -e ${REPO_ROOT}/.git ]; then echo "already cloned" >&2; exit 3; fi`,
      `rm -rf ${REPO_ROOT}`,
      `git -c credential.helper= -c ${shellWord(`credential.helper=${helper}`)} clone --progress -- ${shellWord(input.url)} ${REPO_ROOT}`,
      `cd ${REPO_ROOT}`,
      `git config credential.helper ${shellWord(helper)}`,
      `git config user.name ${shellWord(name)}`,
      `git config user.email ${shellWord(email)}`,
      `git rev-parse --abbrev-ref HEAD`,
    ].join("\n");
    try {
      const result = await this.exec({
        script,
        cwd: "/workspace",
        timeoutMs: input.timeoutMs ?? 15 * 60_000,
      });
      if (result.exitCode === 0) await this.#prime().catch(() => undefined);
      return { ran: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, ms: result.ms };
    } catch (error) {
      return { ran: false, reason: "container_refused", detail: String(error).slice(0, 1000) };
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Worktree Workspaces (step 2b, plan section 3.2): a full clone of the project's remote, seeded with the commits only
  // the project has by a git bundle, read straight from the project's object.

  /** Step 1, in the worktree's object: a fresh clone without checkout (or `git init` with no remote); answers its tips. */
  async worktreeClone(input: { readonly id: string; readonly url: string | null; readonly parent?: string }): Promise<{ readonly ok: boolean; readonly tips: ReadonlyArray<string>; readonly error?: string }> {
    this.#revive();
    this.#rememberId(input.id);
    // Review H1: a worktree of a tainted project is tainted (its project-root view carries the project's untracked files).
    const parentTaint = input.parent === undefined ? null : await this.#peer(input.parent).taint().catch(() => null);
    if (parentTaint !== null) this.ctx.storage.kv.put(TAINT_KEY, { since: parentTaint.since, by: [...parentTaint.by] });
    // A Container left by an earlier attempt starts again: its submodules' directories are mounts that the clone's
    // `rm -rf` of the repo cannot remove.
    if (this.containerRunning()) await this.stopContainer().catch(() => undefined);
    // The project's submodules, so the Container this clone starts keeps them local from the first command (t3 runs
    // `git submodule update` right after the checkout).
    const projectModules = input.parent === undefined ? null : await this.#peer(input.parent).readText(`${REPO_ROOT}/.gitmodules`).catch(() => null);
    this.ctx.storage.kv.put(SUBMODULE_HINT_KEY, projectModules === null ? [] : submodulePaths(projectModules));
    const script = worktreeCloneScript({
      repo: REPO_ROOT,
      url: input.url,
      helper: CREDENTIAL_HELPER,
      name: this.env.T3FLARE_GIT_NAME ?? "t3flare",
      email: this.env.T3FLARE_GIT_EMAIL ?? "t3flare@users.noreply.github.com",
    });
    try {
      const result = await this.exec({ script, cwd: "/workspace", timeoutMs: 15 * 60_000 });
      if (result.exitCode !== 0) return { ok: false, tips: [], error: result.stderr.slice(-1000) };
      return { ok: true, tips: parseTips(result.stdout) };
    } catch (error) {
      return { ok: false, tips: [], error: String(error).slice(0, 1000) };
    }
  }

  /**
   * Step 2, in the project's object: `ref`'s commit, and a bundle of what the new clone lacks: `ref` without the
   * clone's actual tips that this repo has (review F7: not `--not --remotes`, which trusts stale remote-tracking refs).
   * No bundle when the clone already has the commit. Also `ref`'s `branch.<ref>.*` config.
   */
  async worktreeBundle(input: { readonly ref: string; readonly tips: ReadonlyArray<string>; readonly name: string }): Promise<{ readonly ok: boolean; readonly commit?: string; readonly bundle?: string | null; readonly config?: ReadonlyArray<string>; readonly error?: string }> {
    this.#alive();
    const bundle = `${HARNESS_ROOT}/tmp/wt-${input.name.replace(/[^A-Za-z0-9-]/g, "")}.bundle`;
    const script = worktreeBundleScript({ ref: input.ref, tips: input.tips, bundle });
    try {
      const result = await this.exec({ script, cwd: REPO_ROOT, timeoutMs: 10 * 60_000 });
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.slice(-1000) };
      const answer = parseBundleAnswer(result.stdout);
      if (answer.commit === null) return { ok: false, error: `no commit for ${input.ref}` };
      return { ok: true, commit: answer.commit, bundle: answer.bundled ? bundle : null, config: answer.config };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 1000) };
    }
  }

  /** A slice of one of this object's own files (another Workspace DO copies a bundle with it). */
  async readChunk(path: string, offset: number, length: number): Promise<{ readonly bytes: Uint8Array; readonly done: boolean } | { readonly error: string }> {
    this.#alive();
    await this.#workspace.ready();
    const answer = await fileOps(this.#workspace).read(path, { offset, length });
    if (!("ok" in answer)) return { error: answer.message };
    return { bytes: answer.ok, done: answer.ok.byteLength < length };
  }

  /** Another Workspace DO of this namespace, by its Workspace id. */
  #peer(id: string): WorkspaceDO {
    return this.env.WORKSPACES.get(this.env.WORKSPACES.idFromName(id)) as unknown as WorkspaceDO;
  }

  /** Copies a file of Workspace `from`'s own files into this one's, object to object in 4 MiB chunks; the error, if any. */
  async #copyFrom(from: string, path: string, to: string): Promise<string | undefined> {
    const ops = fileOps(this.#workspace);
    await ops.mkdir(to.slice(0, to.lastIndexOf("/")), true);
    await ops.remove(to, { force: true });
    const CHUNK = 4 * 1024 * 1024;
    for (let offset = 0; ; offset += CHUNK) {
      const chunk = await this.#peer(from).readChunk(path, offset, CHUNK);
      if ("error" in chunk) return chunk.error;
      const wrote = await ops.write(to, chunk.bytes, { append: offset > 0 });
      if (!("ok" in wrote)) return wrote.message;
      if (chunk.done) return undefined;
    }
  }

  /**
   * Step 3, in the worktree's object: copy the project's bundle (object to object, never through the Environment), fetch
   * it, check `ref` out at `commit`, copy `branch.<ref>.*`, and check HEAD.
   */
  async worktreeFinish(input: { readonly parent: string; readonly bundle: string | null; readonly ref: string; readonly commit: string; readonly config: ReadonlyArray<string> }): Promise<{ readonly ok: boolean; readonly head?: string; readonly error?: string }> {
    await this.#workspace.ready();
    let local: string | null = null;
    if (input.bundle !== null) {
      local = `${HARNESS_ROOT}/tmp/seed.bundle`;
      const copied = await this.#copyFrom(input.parent, input.bundle, local);
      if (copied !== undefined) return { ok: false, error: `the project's bundle could not be copied: ${copied}` };
    }
    const script = worktreeFinishScript({ bundle: local, ref: input.ref, commit: input.commit, config: input.config });
    try {
      const result = await this.exec({ script, cwd: REPO_ROOT, timeoutMs: 15 * 60_000 });
      const head = result.stdout.trim().split("\n").at(-1) ?? "";
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.slice(-1000) };
      if (head !== input.commit) return { ok: false, error: `HEAD is ${head}, not ${input.commit}` };
      await this.#prime().catch(() => undefined);
      // The checkout's own `.gitmodules` now says which paths are submodules.
      this.ctx.storage.kv.delete(SUBMODULE_HINT_KEY);
      return { ok: true, head };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 1000) };
    }
  }

  /**
   * The project-root view's files (step 2b, plan section 4.2): this project's untracked files, gitignored ones included,
   * from its own files (never the Container; the Container-only paths are not here at all), up to `maxFiles` and
   * `maxBytes`. Tracked files are not in it: a worktree has them at its own commit.
   */
  async projectRootFiles(input: { readonly maxFiles: number; readonly maxBytes: number }): Promise<{ readonly files: ReadonlyArray<{ readonly path: string; readonly size: number }>; readonly capped: boolean }> {
    this.#alive();
    const repo = await this.#repo();
    const tracked = new Set(await git.listFiles({ fs: repo.fs, dir: repo.dir, cache: repo.cache }).catch(() => [] as Array<string>));
    const found = await fileOps(this.#workspace).find(REPO_ROOT, undefined, 50_000);
    if (!("ok" in found)) return { files: [], capped: false };
    const files: Array<{ path: string; size: number }> = [];
    let bytes = 0;
    let capped = false;
    for (const entry of found.ok) {
      if (entry.kind !== "file") continue;
      const path = entry.path.startsWith(`${REPO_ROOT}/`) ? entry.path.slice(REPO_ROOT.length + 1) : entry.path;
      if (path === ".git" || path.startsWith(".git/") || tracked.has(path)) continue;
      const stat = await fileOps(this.#workspace).stat(`${REPO_ROOT}/${path}`, false);
      const size = "ok" in stat ? stat.ok.size : 0;
      if (files.length >= input.maxFiles || bytes + size > input.maxBytes) {
        capped = true;
        continue;
      }
      files.push({ path, size });
      bytes += size;
    }
    return { files, capped };
  }

  /** Copies the project's untracked files into this worktree's project-root view (step 2b), object to object. */
  async seedProjectRoot(input: { readonly parent: string }): Promise<{ readonly files: number; readonly bytes: number; readonly capped: boolean; readonly names: ReadonlyArray<string> }> {
    this.#alive();
    await this.#workspace.ready();
    const ops = fileOps(this.#workspace);
    const listed = await this.#peer(input.parent).projectRootFiles({ maxFiles: PROJECT_ROOT_MAX_FILES, maxBytes: PROJECT_ROOT_MAX_BYTES });
    await ops.remove(PROJECT_ROOT_VIEW, { recursive: true, force: true });
    await ops.mkdir(PROJECT_ROOT_VIEW, true);
    let bytes = 0;
    for (const file of listed.files) {
      if ((await this.#copyFrom(input.parent, `${REPO_ROOT}/${file.path}`, `${PROJECT_ROOT_VIEW}/${file.path}`)) === undefined) bytes += file.size;
    }
    if (listed.capped) console.warn(JSON.stringify({ t3flare: "project-root-view-capped", files: listed.files.length, maxFiles: PROJECT_ROOT_MAX_FILES, maxBytes: PROJECT_ROOT_MAX_BYTES }));
    return { files: listed.files.length, bytes, capped: listed.capped, names: listed.files.slice(0, 20).map((file) => file.path) };
  }

  /** HEAD and its branch from this object's own files (isomorphic-git), never starting the Container (`worktree list`). */
  async worktreeHead(): Promise<{ readonly head: string | null; readonly branch: string | null }> {
    try {
      const repo = await this.#repo();
      const head = await resolveCommit(repo, "HEAD");
      const branch = (await git.currentBranch({ fs: repo.fs, dir: repo.dir, fullname: true })) ?? null;
      return { head, branch: typeof branch === "string" ? branch : null };
    } catch {
      return { head: null, branch: null };
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Deletion (step 2b, plan section 5; review F4 and F8)

  /** Whether `destroy()` ran and no provisioning has run since. */
  #isDestroyed(): boolean {
    return this.ctx.storage.kv.get<number>(DESTROYED_KEY) !== undefined;
  }

  /** Refuses an RPC on a purged Workspace (a Session reaching it by name, a stale caller), before computer touches storage. */
  #alive(): void {
    if (this.#isDestroyed()) throw new Error("t3flare: this Workspace was deleted");
  }

  /** Provisioning makes the Workspace again (a worktree at a reused path, review F5). */
  #revive(): void {
    this.ctx.storage.kv.delete(DESTROYED_KEY);
  }

  /**
   * Purges the Workspace: its terminals and Container, the budget's lease, the alarm, then all of its storage
   * (computer's file system, the read cache, the change log), leaving only the marker that refuses later RPCs, and
   * restarts the object so no in-memory computer state outlives the storage.
   */
  async destroy(): Promise<{ readonly destroyed: true }> {
    this.#terminals.containerStopped();
    this.#processes.containerStopped();
    await this.#terminals.settled().catch(() => undefined);
    if (this.ctx.container?.running === true) await this.ctx.container.destroy().catch(() => undefined);
    await this.#budget().release(this.ctx.id.toString()).catch(() => undefined);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(DESTROYED_KEY, Date.now());
    await this.ctx.storage.sync();
    console.log(JSON.stringify({ t3flare: "workspace-destroyed", workspace: this.ctx.id.name ?? this.ctx.id.toString() }));
    setTimeout(() => this.ctx.abort("t3flare: workspace destroyed"), 0);
    return { destroyed: true };
  }

  /** The project's ref tips (its Container), for what a removed worktree must carry home. */
  async refTips(): Promise<{ readonly ok: boolean; readonly tips: ReadonlyArray<string>; readonly error?: string }> {
    this.#alive();
    const result = await this.exec({ script: "git for-each-ref --format='%(objectname)' | sort -u", cwd: REPO_ROOT, timeoutMs: 120_000 });
    if (result.exitCode !== 0) return { ok: false, tips: [], error: result.stderr.slice(-500) };
    return { ok: true, tips: parseTips(`TIPS\n${result.stdout}`) };
  }

  /** In a worktree being removed: whether it is dirty, and a bundle of the refs its project cannot reach (F8). */
  async carryOut(input: { readonly projectTips: ReadonlyArray<string> }): Promise<{ readonly ok: boolean; readonly dirty: boolean; readonly carried: ReadonlyArray<{ readonly ref: string; readonly sha: string }>; readonly bundle: string | null; readonly error?: string }> {
    this.#alive();
    const bundle = `${HARNESS_ROOT}/tmp/carry.bundle`;
    const result = await this.exec({ script: carryOutScript({ projectTips: input.projectTips, bundle }), cwd: REPO_ROOT, timeoutMs: 10 * 60_000 });
    if (result.exitCode !== 0) return { ok: false, dirty: true, carried: [], bundle: null, error: result.stderr.slice(-500) };
    const answer = parseCarryOut(result.stdout);
    return { ok: true, dirty: answer.dirty, carried: answer.carried, bundle: answer.bundled ? bundle : null };
  }

  /** In the project: fetch a removed worktree's carried refs from its bundle (object to object) and give each a home. */
  async carryIn(input: { readonly worktree: string; readonly bundle: string; readonly dir: string; readonly carried: ReadonlyArray<{ readonly ref: string; readonly sha: string }> }): Promise<{ readonly ok: boolean; readonly lines: ReadonlyArray<string>; readonly error?: string }> {
    this.#alive();
    await this.#workspace.ready();
    const local = `${HARNESS_ROOT}/tmp/carry-in.bundle`;
    const copied = await this.#copyFrom(input.worktree, input.bundle, local);
    if (copied !== undefined) return { ok: false, lines: [], error: `the worktree's bundle could not be copied: ${copied}` };
    const result = await this.exec({ script: carryInScript({ bundle: local, dir: input.dir, carried: input.carried }), cwd: REPO_ROOT, timeoutMs: 10 * 60_000 });
    const lines = result.stdout.split("\n").filter((line) => /^(CREATED|FASTFORWARD|KEPT) /.test(line));
    if (result.exitCode !== 0) return { ok: false, lines, error: result.stderr.slice(-500) };
    return { ok: true, lines };
  }

  async info(): Promise<ProvisionInfo> {
    if (this.#isDestroyed()) return { provisioned: false, repo: false, containerRunning: this.containerRunning(), revision: 0, gitRevision: 0, cachedReads: 0, id: null, destroyed: true };
    await this.#workspace.ready();
    const ops = fileOps(this.#workspace);
    const repo = "ok" in (await ops.stat(REPO_ROOT));
    const git = "ok" in (await ops.stat(`${REPO_ROOT}/.git`));
    return { provisioned: repo, repo: git, containerRunning: this.containerRunning(), revision: this.#reads.revision(), gitRevision: this.#reads.revision("git-dir"), cachedReads: this.#reads.stats().rows, id: this.#workspaceId() ?? null };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Terminals (step 2b, ADR-0021): the Environment's PTY adapter calls these; output goes back by push.

  #terminalsChanged(): void {
    if (this.#terminals.size > 0) {
      this.#terminalSync.startPushing();
      this.#expireTimer ??= setInterval(() => {
        void this.#terminals.expire().catch(() => undefined);
        if (this.#terminals.size === 0 && this.#expireTimer !== undefined) {
          clearInterval(this.#expireTimer);
          this.#expireTimer = undefined;
        }
      }, TERMINAL_EXPIRE_EVERY_MS);
    }
  }

  async terminalOpen(input: TerminalOpenInput): Promise<TerminalAnswer> {
    this.#alive();
    this.#rememberId(input.t3Path.startsWith("/w/") ? input.t3Path.slice(3) : undefined);
    const answer = await this.#terminals.open(input);
    // An open is use, like a command (the Container's idle stop), but not input: it does not hold the Container (F1).
    await this.#noteUse();
    this.#terminalsChanged();
    await this.#scheduleAlarm();
    return answer;
  }

  terminalInput(key: string, data: string): Promise<TerminalAnswer> {
    return this.#terminals.input(key, data);
  }

  terminalResize(key: string, cols: number, rows: number): TerminalAnswer {
    return this.#terminals.resize(key, cols, rows);
  }

  terminalClose(key: string): Promise<TerminalAnswer> {
    return this.#terminals.close(key);
  }

  terminalHeartbeat(keys: ReadonlyArray<string>): TerminalAnswer {
    return this.#terminals.heartbeat(keys);
  }

  /** Diagnosis: the open terminals, the sync's counts, the last input, the output batches pushed. */
  terminalState(): { readonly epoch: string; readonly keys: ReadonlyArray<string>; readonly lastInput: number; readonly pushes: number; readonly sync: Readonly<Record<string, number>> } {
    return { epoch: this.#epoch, keys: this.#terminals.keys(), lastInput: this.#terminals.lastInput, pushes: this.#terminals.pushes, sync: { ...this.#terminalSync.stats } };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // CLI processes (step 4a, the process channel): the Environment's spawner calls these; output goes back by push.

  #processesChanged(): void {
    if (this.#processes.size > 0) {
      this.#terminalSync.startPushing();
      this.#expireTimer ??= setInterval(() => {
        void this.#terminals.expire().catch(() => undefined);
        void this.#processes.expire().catch(() => undefined);
        if (this.#terminals.size === 0 && this.#processes.size === 0 && this.#expireTimer !== undefined) {
          clearInterval(this.#expireTimer);
          this.#expireTimer = undefined;
        }
      }, TERMINAL_EXPIRE_EVERY_MS);
    }
  }

  async processStart(input: ProcessStartInput): Promise<ProcessStartAnswer> {
    this.#alive();
    this.#cliSinceScan = true;
    this.#rememberId(input.t3Path.startsWith("/w/") ? input.t3Path.slice(3) : undefined);
    if (this.containerRunning()) await this.#syncEntries("push").catch(() => undefined);
    const answer = await this.#processes.start(input);
    await this.#noteUse();
    this.#processesChanged();
    await this.#scheduleAlarm();
    return answer;
  }

  processInput(key: string, seq: number, data: Uint8Array | null): Promise<ProcessInputAnswer> {
    return this.#processes.input(key, seq, data);
  }

  processTurn(key: string, active: boolean): ProcessAnswer {
    return this.#processes.turn(key, active);
  }

  processSignal(key: string): Promise<ProcessAnswer> {
    return this.#processes.signal(key);
  }

  processHeartbeat(keys: ReadonlyArray<string>): ProcessAnswer {
    return this.#processes.heartbeat(keys);
  }

  /** The Environment's long poll of this Workspace's CLI output (and their heartbeat). */
  processRead(input: ProcessReadInput): Promise<ProcessReadAnswer> {
    return this.#processes.read(input);
  }

  /** Diagnosis: the live CLI processes and this object's boot counter. */
  processState(): { readonly epoch: number; readonly processes: ReturnType<ProcessHost["state"]>; readonly pushes: number } {
    return { epoch: this.#boot, processes: this.#processes.state(), pushes: this.#processes.pushes };
  }

  /**
   * The budget is full and another Workspace asks for a Container (review F7): if nothing here works (no command, no
   * terminal holding, no CLI process in a turn or recently used), the CLI processes end and the Container stops.
   */
  async releaseIfIdle(): Promise<{ readonly released: boolean; readonly reason: string }> {
    if (!this.containerRunning()) return { released: false, reason: "not running" };
    const reclaimable = this.#processes.reclaimable();
    const busy =
      this.#running > 0 ||
      this.#terminals.holdsContainer({ promptMs: this.#terminalPromptIdleMs(), busyMs: this.#terminalIdleMs() }) ||
      reclaimable.length < this.#processes.size;
    if (busy) return { released: false, reason: "in use" };
    const lastUse = (await this.ctx.storage.get<number>(LAST_USE_KEY)) ?? 0;
    if (this.#processes.size === 0 && Date.now() - lastUse < 30_000) return { released: false, reason: "used in the last 30 s" };
    console.log(JSON.stringify({ t3flare: "container-released-for-budget", workspace: this.#workspaceId() ?? null, processes: reclaimable.length, ...(await this.#usage()) }));
    await this.stopContainer();
    return { released: true, reason: "idle" };
  }

  #terminalIdleMs(): number {
    const value = Number(this.env.T3FLARE_TERMINAL_IDLE_MS);
    return Number.isFinite(value) && value > 0 ? value : TERMINAL_IDLE_MS;
  }

  #terminalPromptIdleMs(): number {
    const value = Number(this.env.T3FLARE_TERMINAL_PROMPT_IDLE_MS);
    return Number.isFinite(value) && value > 0 ? value : TERMINAL_PROMPT_IDLE_MS;
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
    if (this.ctx.container?.running === true) {
      // CLI processes end first (they flush their session files), then the writes not yet pulled come into the DO.
      const stopped = await this.#processes.stopAll().catch(() => 0);
      const pulled = await this.#terminalSync.pullNow().catch(() => -1);
      if (stopped > 0) console.log(JSON.stringify({ t3flare: "container-stop-cli", workspace: this.#workspaceId() ?? null, processes: stopped, pulled }));
      await this.ctx.container.destroy();
    }
    this.#terminals.containerStopped();
    this.#processes.containerStopped();
    this.#sandbox = undefined;
    await this.#release();
  }

  async #release(): Promise<void> {
    await this.#budget().release(this.ctx.id.toString());
    await this.ctx.storage.delete([LEASED_KEY, STARTED_AT_KEY]);
  }

  /** The stopping Container's memory peak and CPU time from its cgroup, and how long it ran (cost audit F2). */
  async #usage(): Promise<{ readonly memoryPeakBytes: number | null; readonly cpuUsageUsec: number | null; readonly ranMs: number | null }> {
    const startedAt = await this.ctx.storage.get<number>(STARTED_AT_KEY);
    const read = await this.exec({ script: USAGE_SCRIPT, passive: true, timeoutMs: 10_000 }).catch(() => undefined);
    const number = (pattern: RegExp) => {
      const match = read === undefined ? null : pattern.exec(read.stdout);
      return match === null ? null : Number(match[1]);
    };
    return { memoryPeakBytes: number(/^peak (\d+)$/m), cpuUsageUsec: number(/^usage_usec (\d+)$/m), ranMs: startedAt === undefined ? null : Date.now() - startedAt };
  }

  /** Idle stop and the budget lease's renewal: the object's one alarm. */
  override async alarm(): Promise<void> {
    if (this.#isDestroyed()) return;
    if (!this.containerRunning()) {
      if ((await this.ctx.storage.get<boolean>(LEASED_KEY)) === true) await this.#release();
      return;
    }
    await this.#terminals.expire().catch(() => undefined);
    await this.#processes.expire().catch(() => undefined);
    await this.#processes.killOrphans().catch(() => undefined);
    const lastUse = (await this.ctx.storage.get<number>(LAST_USE_KEY)) ?? 0;
    // Terminals hold the Container until their last input is older than the hold (review F10: output is not use).
    const held = this.#terminals.holdsContainer({ promptMs: this.#terminalPromptIdleMs(), busyMs: this.#terminalIdleMs() }) || this.#processes.holdsContainer();
    if (this.#running === 0 && !held && Date.now() - lastUse >= this.#idleMs()) {
      console.log(JSON.stringify({ t3flare: "container-idle-stop", workspace: this.ctx.id.toString(), ...(await this.#usage()) }));
      await this.stopContainer();
      return;
    }
    const renewed = await this.#budget().renew(this.ctx.id.toString());
    if (!renewed.ok) console.warn(JSON.stringify({ t3flare: "container-lease-lost", reason: renewed.reason }));
    await this.#scheduleAlarm();
  }

  /** computer's Workspace RPC (`getWorkspace()`, the Worker Shell's proxy): the caller disposes the stub. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    this.#alive();
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  /**
   * The Container's egress and computerd's callbacks reach the backend through the object's fetch; the credential
   * helper's token request (`CREDENTIAL_PATH`) is answered here.
   */
  override async fetch(request: Request): Promise<Response> {
    if (this.#isDestroyed()) return new Response("t3flare: this Workspace was deleted", { status: 410 });
    if (new URL(request.url).pathname === CREDENTIAL_PATH) return this.#credential(new URL(request.url));
    if (new URL(request.url).pathname === MODEL_KEY_PATH) return this.#modelKey(request);
    return this.#container.handleFetch(request);
  }

  /** This Workspace's id: the object's name, or the one the Environment told it (`clone`, `ensureCredentialHelper`). */
  #workspaceId(): string | undefined {
    return this.ctx.id.name ?? this.ctx.storage.kv.get<string>(WORKSPACE_ID_KEY);
  }

  #rememberId(id: string | undefined): void {
    if (id !== undefined && id !== "") this.ctx.storage.kv.put(WORKSPACE_ID_KEY, id);
  }

  /**
   * Step 3 (D1): a linked thread's Session notes, before each of its commands, that linked work is active here until
   * `until`; while it is, the gateway's pushes ask that Session's owner. It also taints the Workspace (review H1).
   */
  noteLinkedWork(input: { readonly session: string; readonly until: number }): Promise<void> {
    const linked = prunedLinkedWork(this.ctx.storage.kv.get<LinkedWork>(LINKED_WORK_KEY) ?? {}, Date.now());
    this.ctx.storage.kv.put(LINKED_WORK_KEY, { ...linked, [input.session]: Math.max(linked[input.session] ?? 0, input.until) });
    this.ctx.storage.kv.put(TAINT_KEY, taintAfter(this.ctx.storage.kv.get<Taint>(TAINT_KEY) ?? null, input.session, Date.now()));
    return Promise.resolve();
  }

  /** An owner's Session notes, before each of its commands, that it may be the one pushing (attribution, review H1). */
  noteOwnerCommand(input: { readonly session: string; readonly until: number }): Promise<void> {
    const owners = prunedLinkedWork(this.ctx.storage.kv.get<LinkedWork>(OWNER_COMMANDS_KEY) ?? {}, Date.now());
    this.ctx.storage.kv.put(OWNER_COMMANDS_KEY, { ...owners, [input.session]: Math.max(owners[input.session] ?? 0, input.until) });
    return Promise.resolve();
  }

  /** The Workspace's taint (review H1), or null. Read by a worktree made from it. */
  taint(): Promise<Taint | null> {
    return Promise.resolve(this.ctx.storage.kv.get<Taint>(TAINT_KEY) ?? null);
  }

  /** The owner trusts this Workspace again (admin route `workspace-trust`, or an owner-thread card): the taint is cleared. */
  trustAgain(input: { readonly by: string }): Promise<{ readonly cleared: Taint | null }> {
    const cleared = this.ctx.storage.kv.get<Taint>(TAINT_KEY) ?? null;
    this.ctx.storage.kv.delete(TAINT_KEY);
    console.log(JSON.stringify({ t3flare: "workspace-trusted", workspace: this.#workspaceId() ?? null, by: input.by, taint: cleared }));
    return Promise.resolve({ cleared });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The push gateway (SPI-992). Callers: `authorizePush` and `pushTarget` only the gateway (`WorkspaceProxy`, this
  // Worker, on the Container's egress); `expectPush`/`unexpectPush` only the Environment's process router. Neither is
  // reachable from the Container (its egress reaches this object only through `WorkspaceProxy`'s paths) or a Session.

  /** The router is about to run t3's `git push` with these updates (review M2): allowed while the command runs. */
  expectPush(input: { readonly id: string; readonly updates: PushExpectation["updates"]; readonly ttlMs?: number }): Promise<void> {
    const now = Date.now();
    const live = (this.ctx.storage.kv.get<ReadonlyArray<PushExpectation>>(EXPECTATIONS_KEY) ?? []).filter((e) => e.until > now && e.id !== input.id);
    const until = now + Math.min(input.ttlMs ?? EXPECTATION_MAX_MS, EXPECTATION_MAX_MS);
    this.ctx.storage.kv.put(EXPECTATIONS_KEY, [...live, { id: input.id, updates: input.updates.slice(0, 64), until }].slice(-32));
    return Promise.resolve();
  }

  /** t3's `git push` returned: its expectation, if not used, is gone. */
  unexpectPush(input: { readonly id: string }): Promise<void> {
    const now = Date.now();
    this.ctx.storage.kv.put(EXPECTATIONS_KEY, (this.ctx.storage.kv.get<ReadonlyArray<PushExpectation>>(EXPECTATIONS_KEY) ?? []).filter((e) => e.until > now && e.id !== input.id));
    return Promise.resolve();
  }

  /** The gateway's target: the Workspace's repo (from the registry) and the write token, minted outside the Container. */
  async pushTarget(): Promise<{ readonly repo: { readonly owner: string; readonly name: string }; readonly token: string } | null> {
    const id = this.#workspaceId();
    if (id === undefined) return null;
    if (this.#pushToken === undefined || this.#pushToken.expiresAt - Date.now() < TOKEN_RENEW_MS) {
      const minted = await environmentStub(this.env.ENVIRONMENT).workspaceToken(id, { purpose: "push" });
      if (minted.token === null || minted.repo === undefined) return null;
      this.#pushToken = { token: minted.token, expiresAt: minted.expiresAt ?? Date.now() + 30 * 60_000, repo: minted.repo };
      // The leak scan looks for it too: it must never be found in the Workspace (M2's assertion).
      await this.#rememberToken(minted.token, "gateway-token");
    }
    return { repo: this.#pushToken.repo, token: this.#pushToken.token };
  }

  /**
   * The gateway's question (SPI-992): may this request's exact ref updates reach GitHub? Answered by `pushDecision`;
   * an ask holds the request until the owner answers (PUSH_APPROVAL_MS). Every decision is logged, never a token.
   */
  async authorizePush(input: { readonly updates: ReadonlyArray<RefUpdate>; readonly pushOptions: ReadonlyArray<string>; readonly askId?: string }): Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }> {
    const id = this.#workspaceId() ?? null;
    if (this.#probeHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#probeHoldMs));
    const now = Date.now();
    const expectations = this.ctx.storage.kv.get<ReadonlyArray<PushExpectation>>(EXPECTATIONS_KEY) ?? [];
    const linked = this.ctx.storage.kv.get<LinkedWork>(LINKED_WORK_KEY) ?? {};
    const linkedCli = new Set(Object.keys(linked).filter((name) => name.startsWith("cli:")).map((name) => name.slice(4)));
    const owners = {
      sessions: Object.keys(prunedLinkedWork(this.ctx.storage.kv.get<LinkedWork>(OWNER_COMMANDS_KEY) ?? {}, now)),
      cli: [...new Set(this.#processes.state().flatMap((proc) => (proc.thread !== null && proc.inTurn && !linkedCli.has(proc.thread) ? [proc.thread] : [])))],
    };
    const taint = this.ctx.storage.kv.get<Taint>(TAINT_KEY) ?? null;
    const decision = pushDecision({ updates: input.updates, linked, taint, expectations, owners, now });
    const log = (outcome: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ t3flare: "push-gateway", workspace: id, outcome, decision: decision.kind, refs: input.updates.map((u) => u.ref).slice(0, 8), updates: input.updates.length, tainted: taint !== null, ...extra }));
    if (decision.kind === "allow") {
      if (decision.why === "expected") this.ctx.storage.kv.put(EXPECTATIONS_KEY, expectations.filter((e) => e.id !== decision.expectation));
      log("allowed", { why: decision.why });
      return { allow: true };
    }
    if (decision.kind === "refuse") {
      log("refused", { reason: decision.reason });
      return { allow: false, reason: decision.reason };
    }
    const answer = await this.#askPush(decision.on, input.updates, input.askId ?? crypto.randomUUID()).catch((error: unknown) => ({ approved: false, trust: false, reason: String(error).slice(0, 200) }));
    if (answer.approved && answer.trust && !decision.on.linked) await this.trustAgain({ by: decision.on.kind === "session" ? decision.on.name : `cli:${decision.on.thread}` });
    log(answer.approved ? "approved" : "declined", { on: decision.on, reason: answer.reason ?? null, trusted: answer.trust });
    return answer.approved ? { allow: true } : { allow: false, reason: answer.reason === "decline" || answer.reason === undefined ? "declined by the owner" : `not approved: ${answer.reason}` };
  }

  /** The gateway's git went away while its push was asked (review M7): the owner's card is withdrawn. */
  async cancelPushAsk(input: { readonly askId: string }): Promise<void> {
    const withdraw = this.#pushAsks.get(input.askId);
    if (withdraw === undefined) {
      this.#withdrawnAsks.add(input.askId);
      if (this.#withdrawnAsks.size > 64) this.#withdrawnAsks.delete(this.#withdrawnAsks.values().next().value!);
      return;
    }
    console.log(JSON.stringify({ t3flare: "push-ask-withdrawn", workspace: this.#workspaceId() ?? null }));
    await withdraw();
  }

  /** Asks `on` about the push, with a card built from GitHub's tips and what the Workspace reports (review M6). */
  async #askPush(on: Asked, updates: ReadonlyArray<RefUpdate>, askId: string): Promise<{ readonly approved: boolean; readonly trust: boolean; readonly reason?: string }> {
    if (this.#withdrawnAsks.delete(askId)) return { approved: false, trust: false, reason: "git went away" };
    const target = await this.pushTarget();
    const facts = target === null ? { tips: {}, defaultBranch: null } : await this.#githubFacts(target);
    const reported = await this.#reportedCommits(updates, facts.tips).catch(() => ({}));
    const workspace = this.#workspaceId() ?? "";
    if (on.kind === "cli") {
      // SPI-1040 (M3): a CLI thread is asked through the Environment, which raises the card on that thread's live turn.
      const card = pushCard({ updates, tips: facts.tips, defaultBranch: facts.defaultBranch, reported, linkLabel: on.linked ? "another environment" : null });
      const environment = environmentStub(this.env.ENVIRONMENT);
      this.#pushAsks.set(askId, () => environment.cancelPush({ askId }));
      try {
        const answer = await environment.approvePush({ thread: on.thread, workspace, linked: on.linked, askId, ...card });
        return { approved: answer.approved, trust: answer.trust === true, ...(answer.reason === undefined ? {} : { reason: answer.reason }) };
      } finally {
        this.#pushAsks.delete(askId);
      }
    }
    const sessions = this.env.SESSIONS;
    if (sessions === undefined) return { approved: false, trust: false, reason: "no Session binding" };
    // SAFETY: the Session DO answers `approveGitPush` (SessionDO.ts).
    const session = sessions.get(sessions.idFromName(on.name)) as unknown as {
      approveGitPush(input: { readonly workspace: string; readonly linked: boolean; readonly askId: string; readonly updates: ReadonlyArray<RefUpdate>; readonly tips: Readonly<Record<string, string>>; readonly defaultBranch: string | null; readonly reported: Readonly<Record<string, ReportedCommit>> }): Promise<{ readonly approved: boolean; readonly trust?: boolean; readonly reason?: string }>;
      cancelGitPush(input: { readonly askId: string }): Promise<void>;
    };
    this.#pushAsks.set(askId, () => session.cancelGitPush({ askId }));
    try {
      const answer = await session.approveGitPush({ workspace, linked: on.linked, askId, updates, tips: facts.tips, defaultBranch: facts.defaultBranch, reported });
      return { approved: answer.approved, trust: answer.trust === true, ...(answer.reason === undefined ? {} : { reason: answer.reason }) };
    } finally {
      this.#pushAsks.delete(askId);
    }
  }

  /** GitHub's tips (its receive-pack advertisement) and default branch, read with the gateway's token. Empty on failure. */
  async #githubFacts(target: { readonly repo: { readonly owner: string; readonly name: string }; readonly token: string }): Promise<{ readonly tips: Readonly<Record<string, string>>; readonly defaultBranch: string | null }> {
    const auth = { authorization: `Basic ${btoa(`x-access-token:${target.token}`)}`, "user-agent": "t3flare-push-gateway" };
    const [refs, repo] = await Promise.all([
      fetch(`https://github.com/${target.repo.owner}/${target.repo.name}.git/info/refs?service=git-receive-pack`, { headers: auth, redirect: "manual" })
        .then(async (response) => (response.ok ? advertisedTips(new Uint8Array(await response.arrayBuffer())) : {}))
        .catch(() => ({})),
      fetch(`https://api.github.com/repos/${target.repo.owner}/${target.repo.name}`, { headers: { authorization: `Bearer ${target.token}`, "user-agent": "t3flare-push-gateway", accept: "application/vnd.github+json" }, redirect: "manual" })
        .then(async (response) => (response.ok ? ((await response.json()) as { default_branch?: string }).default_branch ?? null : null))
        .catch(() => null),
    ]);
    return { tips: refs, defaultBranch: repo };
  }

  /** What the Workspace's git says about each new commit: its subject, and whether it descends from GitHub's tip. */
  async #reportedCommits(updates: ReadonlyArray<RefUpdate>, tips: Readonly<Record<string, string>>): Promise<Record<string, ReportedCommit>> {
    const wanted = updates.filter((u) => !/^0+$/.test(u.new)).slice(0, 16);
    if (wanted.length === 0 || !this.containerRunning()) return {};
    const script = wanted
      .map((u) => {
        const tip = tips[u.ref];
        return `printf 'C %s %s\\n' ${u.new} "$(git log -1 --format=%s ${u.new} 2>/dev/null | head -c 200 | base64 | tr -d '\\n')"` + (tip === undefined ? "" : `; git merge-base --is-ancestor ${tip} ${u.new} 2>/dev/null; printf 'A %s %s\\n' ${u.new} $?`);
      })
      .join("\n");
    const result = await this.exec({ script, cwd: REPO_ROOT, passive: true, timeoutMs: 20_000 });
    const out: Record<string, { subject: string; ancestor: Record<string, boolean> }> = {};
    for (const line of result.stdout.split("\n")) {
      const [kind, oid, value] = line.split(" ");
      if (oid === undefined || !/^[0-9a-f]{40,64}$/.test(oid)) continue;
      const entry = (out[oid] ??= { subject: "", ancestor: {} });
      if (kind === "C") entry.subject = value === undefined ? "" : new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))).trim();
      if (kind === "A" && (value === "0" || value === "1")) for (const u of wanted.filter((w) => w.new === oid)) entry.ancestor[u.ref] = value === "0";
    }
    return out;
  }

  /**
   * The credential helper's request (SPI-992): a read-only token, only for the current helper (`v=2`) asking about
   * `https://github.com` (an older helper in a repo's `.git/config` asks without them, and gets nothing).
   */
  async #credential(url: URL): Promise<Response> {
    const id = this.#workspaceId();
    if (id === undefined) return new Response("", { status: 404 });
    const params = url.searchParams;
    if (params.get("v") !== CREDENTIAL_HELPER_VERSION || params.get("protocol") !== "https" || params.get("host") !== "github.com") {
      console.warn(JSON.stringify({ t3flare: "git-credential-refused", workspace: id, why: "not the current helper, or not https://github.com" }));
      return new Response("", { status: 403, headers: { "cache-control": "no-store" } });
    }
    try {
      if (this.#readToken === undefined || this.#readToken.expiresAt - Date.now() < TOKEN_RENEW_MS) {
        const minted = await environmentStub(this.env.ENVIRONMENT).workspaceToken(id, { purpose: "read" });
        this.#readToken = minted.token === null ? undefined : { token: minted.token, expiresAt: minted.expiresAt ?? Date.now() + 30 * 60_000 };
        if (minted.token !== null) await this.#rememberToken(minted.token);
      }
      const token = this.#readToken?.token ?? null;
      console.log(JSON.stringify({ t3flare: "git-credential", workspace: id, granted: token !== null, readOnly: true }));
      return new Response(token ?? "", { status: token === null ? 404 : 200, headers: { "cache-control": "no-store" } });
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "git-credential-failed", workspace: id, error: String(error).slice(0, 300) }));
      return new Response("", { status: 503 });
    }
  }

  /**
   * Test stages only (SPI-992 M0/M2): `holdMs` holds every gateway request's decision that long (P2, the long-held
   * POST); `lapseLinked` ends every linked-work window now (the taint stays: H1's lapse without waiting 30 minutes);
   * `noteLinked` notes linked work as a linked Session would; `state` answers the policy's inputs.
   */
  probePush(op: { readonly holdMs?: number; readonly lapseLinked?: boolean; readonly noteLinked?: { readonly session: string; readonly ms: number } }): Promise<Record<string, unknown>> {
    if (this.env.T3FLARE_FAULTS !== "1") throw new Error("t3flare: probes answer on test stages only");
    if (op.holdMs !== undefined) this.#probeHoldMs = Math.max(0, Math.min(op.holdMs, 20 * 60_000));
    if (op.lapseLinked === true) this.ctx.storage.kv.put(LINKED_WORK_KEY, {});
    if (op.noteLinked !== undefined) void this.noteLinkedWork({ session: op.noteLinked.session, until: Date.now() + op.noteLinked.ms });
    return Promise.resolve({
      holdMs: this.#probeHoldMs,
      linked: this.ctx.storage.kv.get<LinkedWork>(LINKED_WORK_KEY) ?? {},
      taint: this.ctx.storage.kv.get<Taint>(TAINT_KEY) ?? null,
      expectations: (this.ctx.storage.kv.get<ReadonlyArray<PushExpectation>>(EXPECTATIONS_KEY) ?? []).map((e) => ({ id: e.id, refs: e.updates.map((u) => u.ref), until: e.until })),
      owners: this.ctx.storage.kv.get<LinkedWork>(OWNER_COMMANDS_KEY) ?? {},
    });
  }

  /** Test stages only (step 4a M1's restart case): this object's abort, as an eviction does. */
  probeProcess(op: { readonly op: "abort" }): { readonly aborting: boolean; readonly epoch: number } {
    if (this.env.T3FLARE_FAULTS !== "1") throw new Error("t3flare: probes answer on test stages only");
    if (op.op !== "abort") throw new Error("t3flare: the only probe is abort");
    setTimeout(() => this.ctx.abort("t3flare: probe abort"), 0);
    return { aborting: true, epoch: this.#boot };
  }

  /**
   * The key helper's request (step 4a, ADR-0016 A′): the CLI agents' model key, only for the nonce of a CLI process that
   * lives here, Codex's at most `CODEX_KEY_GRANTS` times. Each grant is logged without the value.
   */
  #modelKey(request: Request): Response {
    const refuse = (why: string) => {
      console.warn(JSON.stringify({ t3flare: "model-key-refused", workspace: this.#workspaceId() ?? null, why }));
      return new Response("", { status: 403, headers: { "cache-control": "no-store" } });
    };
    const value = this.env.COMMISSARY_CONTAINER_API_KEY;
    if (value === undefined || value === "") return refuse("no key bound");
    const decision = this.#keyGate.decide(request.headers.get("x-t3flare-nonce"), new Set(this.#processes.keys()));
    if (!decision.grant) return refuse(decision.why);
    console.log(JSON.stringify({ t3flare: "model-key", workspace: this.#workspaceId() ?? null, cli: decision.cli, key: decision.key, grants: decision.grants }));
    return new Response(value, { status: 200, headers: { "cache-control": "no-store", "content-type": "text/plain" } });
  }

  /** Points the repo's git credentials at `CREDENTIAL_HELPER` (repos cloned before it existed). */
  async ensureCredentialHelper(id?: string): Promise<ExecResult> {
    this.#alive();
    this.#rememberId(id);
    return this.exec({ script: `git config credential.helper ${shellWord(CREDENTIAL_HELPER)} && git config --get credential.helper`, cwd: REPO_ROOT });
  }
}
