// The environment Worker's view of the agents Worker's Durable Objects (ADR-0014): their RPC methods, typed here so
// this Worker never imports the agents Worker's code (which is typed against the Workers globals, not Node's).
import type {
  AbortInput,
  AnswerInput,
  OpenAnswer,
  OpenInput,
  SessionState,
  SnapshotInput,
  SteerInput,
  SubmitTurnInput,
} from "@t3flare/session-protocol";
import type { CloneInput, FsAnswer, GitAnswer, GitRun, ProvisionInfo } from "@t3flare/workspace-client";

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
  clone(input: CloneInput): Promise<GitAnswer>;
  info(): Promise<ProvisionInfo>;
  exec(input: ExecInput): Promise<ExecResult>;
  containerState(): Promise<{ readonly running: boolean; readonly leased: boolean; readonly lastUse: number | null }>;
  stopContainer(): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
}

export interface SessionRpc {
  ping(echo: string): Promise<{ readonly session: string; readonly echo: string; readonly environment: unknown }>;
  open(input: OpenInput): Promise<OpenAnswer>;
  submitTurn(input: SubmitTurnInput): Promise<{ readonly submissionId: string }>;
  steer(input: SteerInput): Promise<{ readonly submissionId: string }>;
  abort(input: AbortInput): Promise<{ readonly aborted: boolean }>;
  answer(input: AnswerInput): Promise<{ readonly applied: boolean }>;
  snapshot(input?: SnapshotInput): Promise<SessionState>;
  dropTurns(): Promise<{ readonly dropped: number }>;
}

export type LeaseAnswer =
  | { readonly ok: true; readonly until: number; readonly running: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string; readonly running: ReadonlyArray<string> };

export interface BudgetRpc {
  acquire(holder: string): Promise<LeaseAnswer>;
  release(holder: string): Promise<void>;
  state(): Promise<{ readonly max: number; readonly leases: ReadonlyArray<{ readonly holder: string; readonly until: number }> }>;
}

/** A Durable Object namespace, as much of it as this Worker uses. */
export interface Namespace<T> {
  idFromName(name: string): unknown;
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
