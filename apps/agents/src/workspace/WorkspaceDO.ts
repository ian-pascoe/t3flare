// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off globalTimers:off cryptoRandomUUID:off
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
import { KILL_SCRIPT, killCommand } from "@t3flare/sandbox-image/kill";
import { DurableObject } from "cloudflare:workers";

import type {
  CheckpointAnswer,
  CheckpointOp,
  CloneInput,
  FsAnswer,
  GitAnswer,
  GitRun,
  ProvisionInfo,
  TerminalAnswer,
  TerminalOpenInput,
} from "@t3flare/workspace-client";
import { HARNESS_ROOT, REPO_ROOT } from "@t3flare/workspace-client";

import * as git from "isomorphic-git";

import { BUDGET_NAME, type ContainerBudget, RENEW_EVERY_MS } from "../budget.ts";
import { environmentStub } from "../environment.ts";
import { changedBetween, currentRevision } from "./changeLog.ts";
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
import { isomorphicFs } from "./isoFs.ts";
import { allowedRead, parsePrimed, passiveDecision, primeArgvs, primeScript, withoutOwnGitDir } from "./gitDirReads.ts";
import { kindOf, patchAnswer } from "./staleReads.ts";
import { readCache, readKey } from "./readCache.ts";
import { TerminalHost } from "./terminalHost.ts";
import { TerminalSync } from "./terminalSync.ts";
import { parseBundleAnswer, parseTips, worktreeBundleScript, worktreeCloneScript, worktreeFinishScript } from "./worktreeScripts.ts";
import {
  CONTAINER_BACKEND,
  CONTAINER_IDLE_MS,
  CONTAINER_IGNORE,
  CONTAINER_INSTANCE,
  TERMINAL_IDLE_MS,
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
  /** Overrides CONTAINER_IDLE_MS (tests). */
  readonly T3FLARE_CONTAINER_IDLE_MS?: string;
  /** Overrides TERMINAL_IDLE_MS (the stage's idle-hold check). */
  readonly T3FLARE_TERMINAL_IDLE_MS?: string;
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
const LEASED_KEY = "t3flare:container-leased";
/** Where the Container's git credential helper asks this object for the repo's token (through computer's egress host). */
export const CREDENTIAL_PATH = "/t3flare/git-credential";
const WORKSPACE_ID_KEY = "t3flare:workspace-id";
/** The markers of the shells this object started (orphans after a restart are killed by them). */
const TERMINAL_MARKERS_KEY = "t3flare:terminal-markers";
/** How often terminals' heartbeats are checked while any is open. */
const TERMINAL_EXPIRE_EVERY_MS = 15_000;

/**
 * git's credential helper in the Container (ADR-0013): the command's own `T3FLARE_GIT_TOKEN` when the router gave one
 * (t3's push, fetch and pull), else a token asked of this Workspace DO at that moment (the agent's own git), which asks
 * the Environment DO: the Workspace's one repo, `workflows` only when opted in. Nothing is kept in a file or the shell.
 */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; t="${T3FLARE_GIT_TOKEN:-}"; ' +
  '[ -n "$t" ] || t="$(curl -fsS --max-time 30 http://computer.internal' + CREDENTIAL_PATH + ' 2>/dev/null)"; ' +
  '[ -n "$t" ] || exit 0; echo username=x-access-token; echo "password=$t"; }; f';

/** The last checkpoint captured: its commit, the files' revision then, and HEAD then (the alias above the guard). */
const LAST_CAPTURE_KEY = "t3flare:last-capture";

const ContainerHost = withWorkspaceContainer(class extends DurableObject<WorkspaceEnv> {});

export class WorkspaceDO extends ContainerHost {
  readonly #workspace: ComputerWorkspace;
  readonly #reads: ReturnType<typeof readCache>;
  readonly #container: ContainerBackend;
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
    this.#reads = readCache(ctx.storage.sql);
    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
      backends: [new WorkerShellBackend({ loader: env.LOADER, workspace: ref, ctx }), this.#container],
    });
    // The model's file tools reach Container-only paths through the Container (cloudpid's ADR-0018), as a script.
    this.#host = new WorkspaceEnvHost(this.#workspace, {
      patterns: () => Promise.resolve(withHarnessKept(CONTAINER_IGNORE)),
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
      pull: () => this.#syncEntries("pull"),
      push: () => this.#syncEntries("push"),
      revision: () => currentRevision(ctx.storage.sql),
      active: () => this.#terminals.size > 0,
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
    });
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
    const container = this.ctx.container;
    if (container === undefined || !container.running || markers.length === 0) return;
    const process = await container.exec(["bash", "-c", KILL_SCRIPT, "t3flare-kill", ...markers], {});
    const output = await process.output();
    console.log(JSON.stringify({ t3flare: "terminal-kill", markers: markers.length, answer: new TextDecoder().decode(output.stdout).trim() }));
  }

  /** One of `ComputerExecutionEnv`'s file operations (the Session's tools), answered as plain data. */
  async fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
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
    let at = Math.min(lastUse + this.#idleMs(), Date.now() + RENEW_EVERY_MS);
    // Open terminals: their heartbeats are checked and their hold measured at least every 30 s.
    if (this.#terminals.size > 0) at = Math.min(at, Date.now() + 30_000);
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
      if (backend === CONTAINER_BACKEND && input.passive !== true) {
        await this.#noteUse();
        await this.#scheduleAlarm();
      }
    }
  }

  /**
   * Kills the processes of the Session's commands `execIds` (step 2a part 2; apps/sandbox-image/src/kill.ts): those whose
   * environment carries one of the ids, by process group where the whole group is theirs. Nothing to do, and the
   * Container not started, when it is not running: a stopped Container has no processes.
   */
  async killExecs(execIds: ReadonlyArray<string>): Promise<{ readonly running: boolean; readonly signalled: number; readonly survivors: number }> {
    // A Container that stops between this check and the exec would be started again by it: the window is the length of
    // one RPC, and the kill then finds nothing.
    if (!this.containerRunning() || execIds.length === 0) return { running: false, signalled: 0, survivors: 0 };
    const result = await this.exec({ script: killCommand(execIds), passive: true, timeoutMs: 15_000 });
    const answer = /\{"signalled":(\d+),"survivors":(\d+)\}/.exec(result.stdout);
    if (answer === null) throw new Error(`t3flare: the kill script failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    return { running: true, signalled: Number(answer[1]), survivors: Number(answer[2]) };
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

  // -------------------------------------------------------------------------------------------------------------------
  // The Environment's file operations (its own files, never the Container) and git (step 2a plan, section 2)

  async fs(op: FsOp): Promise<FsAnswer<unknown>> {
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

  /** A passive read while the Container is stopped: its last real answer, patched with the paths written since. */
  async #stale(run: GitRun, key: string): Promise<GitAnswer> {
    const last = this.#reads.last(key);
    if (last === undefined) {
      const emulated = await this.#emulatedRead(run).catch(() => undefined);
      if (emulated !== undefined) return emulated;
      return { ran: false, reason: "container_stopped", detail: "needs the Workspace's Container, which is stopped, and has no earlier answer" };
    }
    const shape = (run.readScope ?? "repo") === "repo" && last.answer.exitCode === 0 ? kindOf(run.argv, run.env) : undefined;
    if (shape === undefined) return { ran: true, ...last.answer, ms: 0, cached: true, stale: "last-answer" };
    const global = currentRevision(this.ctx.storage.sql);
    const memo = this.#staleMemo.get(key);
    if (memo !== undefined && memo.global === global) return memo.answer;
    const started = Date.now();
    const journal = this.#journalSince(last.rev, global);
    let answer: GitAnswer;
    try {
      const repo = await this.#repo();
      if (journal.length > 0 && !(await withinGuard(repo))) {
        answer = { ran: true, ...last.answer, ms: 0, cached: true, stale: "last-answer" };
      } else {
        const stdout = await patchAnswer(shape.kind, last.answer.stdout, journal, await repoFacts(repo, shape.base));
        answer = { ran: true, ...last.answer, stdout, ms: Date.now() - started, cached: true, stale: "patched" };
      }
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "stale-read-patch-failed", kind: shape.kind, error: String(error).slice(0, 500) }));
      answer = { ran: true, ...last.answer, ms: 0, cached: true, stale: "last-answer" };
    }
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
        env: input.token === null ? {} : { T3FLARE_GIT_TOKEN: input.token },
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
  async worktreeClone(input: { readonly id: string; readonly url: string | null; readonly token: string | null }): Promise<{ readonly ok: boolean; readonly tips: ReadonlyArray<string>; readonly error?: string }> {
    this.#rememberId(input.id);
    const script = worktreeCloneScript({
      repo: REPO_ROOT,
      url: input.url,
      helper: CREDENTIAL_HELPER,
      name: this.env.T3FLARE_GIT_NAME ?? "t3flare",
      email: this.env.T3FLARE_GIT_EMAIL ?? "t3flare@users.noreply.github.com",
    });
    try {
      const result = await this.exec({ script, cwd: "/workspace", env: input.token === null ? {} : { T3FLARE_GIT_TOKEN: input.token }, timeoutMs: 15 * 60_000 });
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
    await this.#workspace.ready();
    const answer = await fileOps(this.#workspace).read(path, { offset, length });
    if (!("ok" in answer)) return { error: answer.message };
    return { bytes: answer.ok, done: answer.ok.byteLength < length };
  }

  /**
   * Step 3, in the worktree's object: copy the project's bundle (object to object, never through the Environment), fetch
   * it, check `ref` out at `commit`, copy `branch.<ref>.*`, and check HEAD.
   */
  async worktreeFinish(input: { readonly parent: string; readonly bundle: string | null; readonly ref: string; readonly commit: string; readonly config: ReadonlyArray<string> }): Promise<{ readonly ok: boolean; readonly head?: string; readonly error?: string }> {
    await this.#workspace.ready();
    const ops = fileOps(this.#workspace);
    let local: string | null = null;
    if (input.bundle !== null) {
      local = `${HARNESS_ROOT}/tmp/seed.bundle`;
      const project = this.env.WORKSPACES.get(this.env.WORKSPACES.idFromName(input.parent)) as unknown as WorkspaceDO;
      await ops.mkdir(`${HARNESS_ROOT}/tmp`, true);
      await ops.remove(local, { force: true });
      const CHUNK = 4 * 1024 * 1024;
      for (let offset = 0; ; offset += CHUNK) {
        const chunk = await project.readChunk(input.bundle, offset, CHUNK);
        if ("error" in chunk) return { ok: false, error: `the project's bundle could not be read: ${chunk.error}` };
        const wrote = await ops.write(local, chunk.bytes, { append: offset > 0 });
        if (!("ok" in wrote)) return { ok: false, error: `the bundle could not be written: ${wrote.message}` };
        if (chunk.done) break;
      }
    }
    const script = worktreeFinishScript({ bundle: local, ref: input.ref, commit: input.commit, config: input.config });
    try {
      const result = await this.exec({ script, cwd: REPO_ROOT, timeoutMs: 15 * 60_000 });
      const head = result.stdout.trim().split("\n").at(-1) ?? "";
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.slice(-1000) };
      if (head !== input.commit) return { ok: false, error: `HEAD is ${head}, not ${input.commit}` };
      await this.#prime().catch(() => undefined);
      return { ok: true, head };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 1000) };
    }
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

  async info(): Promise<ProvisionInfo> {
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
    this.#rememberId(input.t3Path.startsWith("/w/") ? input.t3Path.slice(3) : undefined);
    const answer = await this.#terminals.open(input);
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

  /** Diagnosis: the open terminals, the sync's counts, the last input. */
  terminalState(): { readonly epoch: string; readonly keys: ReadonlyArray<string>; readonly lastInput: number; readonly sync: Readonly<Record<string, number>> } {
    return { epoch: this.#epoch, keys: this.#terminals.keys(), lastInput: this.#terminals.lastInput, sync: { ...this.#terminalSync.stats } };
  }

  #terminalIdleMs(): number {
    const value = Number(this.env.T3FLARE_TERMINAL_IDLE_MS);
    return Number.isFinite(value) && value > 0 ? value : TERMINAL_IDLE_MS;
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
      // The shells' writes not yet pulled would go with the Container.
      await this.#terminalSync.pullNow().catch(() => undefined);
      await this.ctx.container.destroy();
    }
    this.#terminals.containerStopped();
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
    await this.#terminals.expire().catch(() => undefined);
    const lastUse = (await this.ctx.storage.get<number>(LAST_USE_KEY)) ?? 0;
    // Terminals hold the Container until their last input is older than the hold (review F10: output is not use).
    const held = this.#terminals.size > 0 && Date.now() - this.#terminals.lastInput < this.#terminalIdleMs();
    if (this.#running === 0 && !held && Date.now() - lastUse >= this.#idleMs()) {
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

  /**
   * The Container's egress and computerd's callbacks reach the backend through the object's fetch; the credential
   * helper's token request (`CREDENTIAL_PATH`) is answered here.
   */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === CREDENTIAL_PATH) return this.#credential();
    return this.#container.handleFetch(request);
  }

  /** This Workspace's id: the object's name, or the one the Environment told it (`clone`, `ensureCredentialHelper`). */
  #workspaceId(): string | undefined {
    return this.ctx.id.name ?? this.ctx.storage.kv.get<string>(WORKSPACE_ID_KEY);
  }

  #rememberId(id: string | undefined): void {
    if (id !== undefined && id !== "") this.ctx.storage.kv.put(WORKSPACE_ID_KEY, id);
  }

  async #credential(): Promise<Response> {
    const id = this.#workspaceId();
    if (id === undefined) return new Response("", { status: 404 });
    try {
      const { token } = await environmentStub(this.env.ENVIRONMENT).workspaceToken(id);
      console.log(JSON.stringify({ t3flare: "git-credential", workspace: id, granted: token !== null }));
      return new Response(token ?? "", { status: token === null ? 404 : 200, headers: { "cache-control": "no-store" } });
    } catch (error) {
      console.warn(JSON.stringify({ t3flare: "git-credential-failed", workspace: id, error: String(error).slice(0, 300) }));
      return new Response("", { status: 503 });
    }
  }

  /** Points the repo's git credentials at `CREDENTIAL_HELPER` (repos cloned before it existed). */
  async ensureCredentialHelper(id?: string): Promise<ExecResult> {
    this.#rememberId(id);
    return this.exec({ script: `git config credential.helper ${shellWord(CREDENTIAL_HELPER)} && git config --get credential.helper`, cwd: REPO_ROOT });
  }
}
