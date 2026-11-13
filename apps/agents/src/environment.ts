// The agents Worker's view of the Environment DO (ADR-0005): the RPC methods it calls, typed here so the agents Worker
// never imports the environment Worker's code. One Environment DO per deploy, named "environment" (ADR-0002).
export { ENVIRONMENT_NAME } from "@t3flare/session-protocol";
import { ENVIRONMENT_NAME } from "@t3flare/session-protocol";

import type { McpAsker, McpRpcAnswer, McpRpcRequest, SessionPush, SessionPushAnswer } from "@t3flare/session-protocol";
import type { TerminalPush, TerminalPushAnswer } from "@t3flare/workspace-client";
import type { McpRelayAnswer, McpRelayInput, ResolvedEnvironment, ResolvedHarness } from "@t3flare/harness-registry";
import type { McpCallAnswer, McpView } from "./extensions/mcp.ts";

export interface EnvironmentRpc {
  agentsPing(message: string): Promise<{ readonly environment: string; readonly message: string }>;
  /** The Session's committed state (ADR-0005). */
  sessionPush(push: SessionPush): Promise<SessionPushAnswer>;
  /**
   * A Workspace's token for its one repo (ADR-0013), for the git credential helper in its Container: `contents: write`
   * (`workflows` only for an opted-in Workspace) and `pull_requests: write` for `gh`. With the repo and its expiry.
   */
  workspaceToken(id: string): Promise<{ readonly token: string | null; readonly expiresAt?: number; readonly repo?: { readonly owner: string; readonly name: string } }>;
  /** The CLI relay's card for a call whose CLI went away (ADR-0028) is withdrawn. */
  cancelAsk(input: { readonly askId: string }): Promise<void>;
  /** A Session's call of t3's `/mcp` (step 3, ADR-0022): t3's HTTP app answers it, never over the public host. */
  mcp(input: McpRpcRequest): Promise<McpRpcAnswer>;
  /** A Workspace's terminal output (step 2b): never boots t3, and is not activity (ADR-0003). */
  terminalOutput(push: TerminalPush): Promise<TerminalPushAnswer>;
  /** The harness settings, resolved and secret-free (ADR-0026): read at a turn's start. Never boots t3. */
  harnessSettings(input: { readonly projectId?: string }): Promise<ResolvedHarness>;
  /** The Environment settings, resolved (ADR-0032): read before a Container start. Never boots t3. */
  environmentSettings(): Promise<ResolvedEnvironment>;
  /** The MCP tools this Session may install (ADR-0028). */
  mcpView(): Promise<McpView>;
  /** An MCP call the Session's tool has judged (`decideCall`); the server's questions come back through `asker` (SPI-1079). */
  mcpCall(input: {
    readonly server: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly judged: "read" | "write";
    readonly asker?: McpAsker;
  }): Promise<McpCallAnswer>;
  /** A CLI process's MCP message through the relay (ADR-0028), its caller resolved by the Workspace DO. */
  mcpRelay(input: McpRelayInput): Promise<McpRelayAnswer>;
}

export const environmentStub = (namespace: DurableObjectNamespace): EnvironmentRpc =>
  namespace.get(namespace.idFromName(ENVIRONMENT_NAME)) as unknown as EnvironmentRpc;
