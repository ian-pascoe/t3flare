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
  /** A Workspace's Container token for its one repo, for the git credential helper (ADR-0013). */
  workspaceToken(id: string): Promise<{ readonly token: string | null }>;
  /** A Session's call of t3's `/mcp` (step 3, ADR-0022): t3's HTTP app answers it, never over the public host. */
  mcp(input: McpRpcRequest): Promise<McpRpcAnswer>;
  /** A Workspace's terminal output (step 2b): never boots t3, and is not activity (ADR-0003). */
  terminalOutput(push: TerminalPush): Promise<TerminalPushAnswer>;
}

export const environmentStub = (namespace: DurableObjectNamespace): EnvironmentRpc =>
  namespace.get(namespace.idFromName(ENVIRONMENT_NAME)) as unknown as EnvironmentRpc;
