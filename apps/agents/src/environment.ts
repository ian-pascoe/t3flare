// The agents Worker's view of the Environment DO (ADR-0005): the RPC methods it calls, typed here so the agents Worker
// never imports the environment Worker's code. One Environment DO per deploy, named "environment" (ADR-0002).
export { ENVIRONMENT_NAME } from "@t3flare/session-protocol";
import { ENVIRONMENT_NAME } from "@t3flare/session-protocol";

import type { McpRpcAnswer, McpRpcRequest, SessionPush, SessionPushAnswer } from "@t3flare/session-protocol";
import type { TerminalPush, TerminalPushAnswer } from "@t3flare/workspace-client";

export interface EnvironmentRpc {
  agentsPing(message: string): Promise<{ readonly environment: string; readonly message: string }>;
  /** The Session's committed state (ADR-0005). */
  sessionPush(push: SessionPush): Promise<SessionPushAnswer>;
  /**
   * A Workspace's token for its one repo (ADR-0013; SPI-992): `read` for the git credential helper in its Container
   * (and `pull_requests: write` for `gh`), `push` for the push gateway only (`contents: write`; never in a Container).
   * With the repo it is for and when it expires.
   */
  workspaceToken(id: string, options: { readonly purpose: "read" | "push" }): Promise<{ readonly token: string | null; readonly expiresAt?: number; readonly repo?: { readonly owner: string; readonly name: string } }>;
  /**
   * SPI-1040: asks the owner about a push on a CLI thread's live turn (the card the CLI wrapper raises). Refused with
   * no live turn, or no answer within the push approval wait. `trust`: the owner also trusted the Workspace again.
   */
  approvePush(input: { readonly thread: string; readonly workspace: string; readonly linked: boolean; readonly askId: string; readonly summary: string; readonly detail: string }): Promise<{ readonly approved: boolean; readonly trust?: boolean; readonly reason?: string }>;
  /** The push's git went away (review M7): the card `approvePush` raised is withdrawn. */
  cancelPush(input: { readonly askId: string }): Promise<void>;
  /** A Session's call of t3's `/mcp` (step 3, ADR-0022): t3's HTTP app answers it, never over the public host. */
  mcp(input: McpRpcRequest): Promise<McpRpcAnswer>;
  /** A Workspace's terminal output (step 2b): never boots t3, and is not activity (ADR-0003). */
  terminalOutput(push: TerminalPush): Promise<TerminalPushAnswer>;
}

export const environmentStub = (namespace: DurableObjectNamespace): EnvironmentRpc =>
  namespace.get(namespace.idFromName(ENVIRONMENT_NAME)) as unknown as EnvironmentRpc;
