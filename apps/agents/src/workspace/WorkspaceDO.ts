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
  ProvisionInfo,
} from "@t3flare/workspace-client";
import { HARNESS_ROOT, REPO_ROOT } from "@t3flare/workspace-client";

import * as git from "isomorphic-git";

import { BUDGET_NAME, type ContainerBudget, RENEW_EVERY_MS } from "../budget.ts";
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
import { kindOf, patchAnswer } from "./staleReads.ts";
import { readCache, readKey } from "./readCache.ts";
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
  /** The identity of commits the agent makes (step 2a; defaults below). */
  readonly T3FLARE_GIT_NAME?: string;
  readonly T3FLARE_GIT_EMAIL?: string;
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
      if (backend === CONTAINER_BACKEND && input.passive !== true) {
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
    const key = passive ? await readKey(run) : null;
    const rev = passive ? this.#reads.revision(run.readScope ?? "repo") : -1;
    if (key !== null) {
      const hit = this.#reads.get(key, rev);
      if (hit !== undefined) return { ran: true, ...hit, ms: 0, cached: true };
      if (!this.containerRunning()) return this.#stale(run, key);
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
      return { ran: true, ...answer, ms: result.ms };
    } catch (error) {
      return { ran: false, reason: "container_refused", detail: String(error).slice(0, 1000) };
    }
  }

  /** Stale answers made since the files last changed, by read key: a client polling status patches once per change. */
  readonly #staleMemo = new Map<string, { readonly global: number; readonly answer: GitAnswer }>();

  /** A passive read while the Container is stopped: its last real answer, patched with the paths written since. */
  async #stale(run: GitRun, key: string): Promise<GitAnswer> {
    const last = this.#reads.last(key);
    if (last === undefined) {
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
    const name = this.env.T3FLARE_GIT_NAME ?? "t3flare";
    const email = this.env.T3FLARE_GIT_EMAIL ?? "t3flare@users.noreply.github.com";
    const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=\${T3FLARE_GIT_TOKEN}"; }; f`;
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
      return { ran: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, ms: result.ms };
    } catch (error) {
      return { ran: false, reason: "container_refused", detail: String(error).slice(0, 1000) };
    }
  }

  async info(): Promise<ProvisionInfo> {
    await this.#workspace.ready();
    const ops = fileOps(this.#workspace);
    const repo = "ok" in (await ops.stat(REPO_ROOT));
    const git = "ok" in (await ops.stat(`${REPO_ROOT}/.git`));
    return { provisioned: repo, repo: git, containerRunning: this.containerRunning(), revision: this.#reads.revision(), gitRevision: this.#reads.revision("git-dir"), cachedReads: this.#reads.stats().rows };
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
