// The environment Worker's view of the agents Worker's Durable Objects (ADR-0014): their RPC methods, typed here so
// this Worker never imports the agents Worker's code (which is typed against the Workers globals, not Node's).
import type { ContainerInstance } from "@t3flare/harness-registry";
import type { PortScan } from "@t3flare/sandbox-image/ports";
import type { PromptTemplate, SkillDiscovery } from "@t3flare/skills";
import type {
  AbortInput,
  AnswerInput,
  ForkAnswer,
  ForkInput,
  OpenAnswer,
  OpenInput,
  RollbackAnswer,
  RollbackInput,
  SessionState,
  SnapshotInput,
  SteerInput,
  SubmitTurnInput,
} from "@t3flare/session-protocol";
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

/** One file operation of the Workspace DO's (`fs`); paths inside the Workspace. */
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

export interface ExecInput {
  readonly script: string;
  readonly backend?: "container" | "worker-shell";
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

export interface WorkspaceRpc {
  fs(op: FsOp): Promise<FsAnswer<unknown>>;
  git(run: GitRun): Promise<GitAnswer>;
  checkpoint(op: CheckpointOp): Promise<CheckpointAnswer>;
  ensureCredentialHelper(id?: string): Promise<ExecResult>;
  killExecs(execIds: ReadonlyArray<string>): Promise<{ readonly running: boolean; readonly signalled: number; readonly survivors: number }>;
  /** G11: the Container's listeners; never starts it, not use. */
  listeners(): Promise<{ readonly running: boolean; readonly scan: PortScan | null }>;
  /** G11: stops one process group in the Container (TERM, then KILL); false when gone or not running. */
  stopProcessGroup(pgid: number, members: ReadonlyArray<number>): Promise<boolean>;
  /** G11: a configured `localhost` preview URL's web probe on the Container's port; never starts it, not use. */
  probePort(port: number, path: string): Promise<{ readonly status: number; readonly contentType: string | null; readonly location: string | null } | null>;
  clone(input: CloneInput): Promise<GitAnswer>;
  info(): Promise<ProvisionInfo>;
  exec(input: ExecInput): Promise<ExecResult>;
  /** The Container's state, with when it started and what it started with (ADR-0032), null while it never has. */
  containerState(): Promise<{
    readonly running: boolean;
    readonly leased: boolean;
    readonly lastUse: number | null;
    readonly startedAt: number | null;
    readonly launch: { readonly size: string; readonly instance: ContainerInstance; readonly idleMs: number; readonly budget?: number; readonly revision: number } | null;
  }>;
  stopContainer(): Promise<void>;
  readText(path: string): Promise<string | null>;
  /** SPI-1147: the Repo skills and Prompt templates of a thread in `cwd`, from the Workspace's own files. */
  skills(cwd: string): Promise<SkillDiscovery>;
  prompts(cwd: string): Promise<ReadonlyArray<PromptTemplate>>;
  writeText(path: string, text: string): Promise<void>;
  worktreeClone(input: { readonly id: string; readonly url: string | null; readonly parent?: string }): Promise<{ readonly ok: boolean; readonly tips: ReadonlyArray<string>; readonly error?: string }>;
  worktreeBundle(input: { readonly ref: string; readonly tips: ReadonlyArray<string>; readonly name: string }): Promise<{ readonly ok: boolean; readonly commit?: string; readonly bundle?: string | null; readonly config?: ReadonlyArray<string>; readonly error?: string }>;
  worktreeFinish(input: { readonly parent: string; readonly bundle: string | null; readonly ref: string; readonly commit: string; readonly config: ReadonlyArray<string> }): Promise<{ readonly ok: boolean; readonly head?: string; readonly error?: string }>;
  destroy(): Promise<{ readonly destroyed: true }>;
  refTips(): Promise<{ readonly ok: boolean; readonly tips: ReadonlyArray<string>; readonly error?: string }>;
  carryOut(input: { readonly projectTips: ReadonlyArray<string> }): Promise<{ readonly ok: boolean; readonly dirty: boolean; readonly carried: ReadonlyArray<{ readonly ref: string; readonly sha: string }>; readonly bundle: string | null; readonly error?: string }>;
  carryIn(input: { readonly worktree: string; readonly bundle: string; readonly dir: string; readonly carried: ReadonlyArray<{ readonly ref: string; readonly sha: string }> }): Promise<{ readonly ok: boolean; readonly lines: ReadonlyArray<string>; readonly error?: string }>;
  seedProjectRoot(input: { readonly parent: string }): Promise<{ readonly files: number; readonly bytes: number; readonly capped: boolean; readonly names: ReadonlyArray<string> }>;
  worktreeHead(): Promise<{ readonly head: string | null; readonly branch: string | null }>;
  terminalOpen(input: TerminalOpenInput): Promise<TerminalAnswer>;
  terminalInput(key: string, data: string): Promise<TerminalAnswer>;
  terminalResize(key: string, cols: number, rows: number): Promise<TerminalAnswer>;
  terminalClose(key: string): Promise<TerminalAnswer>;
  terminalHeartbeat(keys: ReadonlyArray<string>): Promise<TerminalAnswer>;
  /** Step 4a: the process channel (agents/src/workspace/processHost.ts). */
  processStart(input: ProcessStartInput): Promise<ProcessStartAnswer>;
  processInput(key: string, seq: number, data: Uint8Array | null): Promise<ProcessInputAnswer>;
  processTurn(key: string, active: boolean): Promise<ProcessAnswer>;
  processSignal(key: string): Promise<ProcessAnswer>;
  processHeartbeat(keys: ReadonlyArray<string>): Promise<ProcessAnswer>;
  processRead(input: ProcessReadInput): Promise<ProcessReadAnswer>;
  processState(): Promise<{ readonly epoch: number; readonly processes: ReadonlyArray<unknown>; readonly pushes: number }>;
  releaseIfIdle(): Promise<{ readonly released: boolean; readonly reason: string }>;
  /** Step 4a (plan §4.7): credentials in the DO's files (by value) and the Container (by hash); names and paths only. */
  leakCheck(): Promise<{ readonly do: ReadonlyArray<{ readonly name: string; readonly path: string }>; readonly container: unknown; readonly flagged: unknown }>;
  /** Step 4a M0 P1, test stages only. */
  probeProcess(op: unknown): Promise<unknown>;
  terminalState(): Promise<{ readonly epoch: string; readonly keys: ReadonlyArray<string>; readonly lastInput: number; readonly pushes: number; readonly sync: Readonly<Record<string, number>> }>;
}

export interface SessionRpc {
  ping(echo: string): Promise<{ readonly session: string; readonly echo: string; readonly environment: unknown }>;
  open(input: OpenInput): Promise<OpenAnswer>;
  submitTurn(input: SubmitTurnInput): Promise<{ readonly submissionId: string }>;
  steer(input: SteerInput): Promise<{ readonly submissionId: string }>;
  abort(input: AbortInput): Promise<{ readonly aborted: boolean }>;
  answer(input: AnswerInput): Promise<{ readonly applied: boolean }>;
  snapshot(input?: SnapshotInput): Promise<SessionState>;
  /** G6 (SPI-987): the conversation back to before the first dropped turn. */
  rollback(input: RollbackInput): Promise<RollbackAnswer>;
  /** G6 (SPI-997): a new thread's Session seeded from the source Session's conversation. */
  fork(input: ForkInput): Promise<ForkAnswer>;
  dropTurns(): Promise<{ readonly dropped: number }>;
  diagnostics(): Promise<Readonly<Record<string, number>>>;
  proxyFault(input: { readonly fixture: string; readonly resetAt: number }): Promise<{ readonly armed: { readonly fixture: string; readonly resetAt: number } }>;
  restart(): Promise<{ readonly restarting: true }>;
  destroy(): Promise<{ readonly destroyed: true }>;
  /** SPI-996: the owner's likely next message after an answered turn (t3's prompt suggestions); "" when none. */
  suggestPrompt(input: { readonly providerTurnId: string }): Promise<{ readonly text: string }>;
  /** Step 3: the T3 tools the Session offers and those its catalog left out (names only). */
  t3Tools(): Promise<{ readonly tools: ReadonlyArray<string>; readonly left: ReadonlyArray<string>; readonly hash: string | null; readonly credential: boolean }>;
}

export type LeaseAnswer =
  | { readonly ok: true; readonly until: number; readonly running: ReadonlyArray<string> }
  /** `max`: the budget the request was judged by (ADR-0032). */
  | { readonly ok: false; readonly reason: string; readonly running: ReadonlyArray<string>; readonly max?: number };

export interface BudgetRpc {
  /** `budget`: the Environment settings' Container budget, carried by a fresh start (ADR-0032). */
  acquire(holder: string, budget?: number): Promise<LeaseAnswer>;
  release(holder: string): Promise<void>;
  state(): Promise<{ readonly max: number; readonly leases: ReadonlyArray<{ readonly holder: string; readonly until: number }> }>;
}

/** A Durable Object namespace, as much of it as this Worker uses. */
export interface Namespace<T> {
  idFromName(name: string): unknown;
  idFromString?(id: string): unknown;
  get(id: unknown): T;
}

export interface AgentsBindings {
  readonly SESSIONS?: Namespace<SessionRpc>;
  readonly WORKSPACES?: Namespace<WorkspaceRpc>;
  readonly CONTAINER_BUDGET?: Namespace<BudgetRpc>;
}

export const byName = <T>(namespace: Namespace<T> | undefined, name: string, what: string): T => {
  if (namespace === undefined) throw new Error(`t3flare: the environment Worker has no ${what} binding`);
  return namespace.get(namespace.idFromName(name));
};
