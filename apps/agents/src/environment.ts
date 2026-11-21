// The agents Worker's view of the Environment DO (ADR-0005): the RPC methods it calls, typed here so the agents Worker
// never imports the environment Worker's code. One Environment DO per deploy, named "environment" (ADR-0002).
export { ENVIRONMENT_NAME } from "@t3flare/session-protocol";
import { ENVIRONMENT_NAME } from "@t3flare/session-protocol";

import type { McpAsker, McpRpcAnswer, McpRpcRequest, SessionPush, SessionPushAnswer } from "@t3flare/session-protocol";
import type { TerminalPush, TerminalPushAnswer } from "@t3flare/workspace-client";
import type { GlobalMiseReport, McpRelayAnswer, McpRelayInput, ResolvedEnvironment, ResolvedHarness, T3ToolListing } from "@t3flare/harness-registry";
import type { SkillSet } from "@t3flare/skills";
import type { EndpointCredential, EndpointCredentialRequest, ModelEndpoints } from "@t3flare/models/endpoints";
import type { LimitReading } from "@t3flare/models/limits";
import type { ModelRelayTarget } from "@t3flare/models/relay";
import type { UsageEntry } from "@t3flare/models/usage";
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
  /**
   * The CLI relay's card for a call whose CLI went away (ADR-0028) is withdrawn; a Settings server call held under the
   * id (a relayed one, or a Session's `mcpCall` with this `stopId`) withdraws its Open change (plan D9).
   */
  cancelAsk(input: { readonly askId: string }): Promise<void>;
  /** A Session's call of t3's `/mcp` (step 3, ADR-0022): t3's HTTP app answers it, never over the public host. */
  mcp(input: McpRpcRequest): Promise<McpRpcAnswer>;
  /** A Workspace's terminal output (step 2b): never boots t3, and is not activity (ADR-0003). */
  terminalOutput(push: TerminalPush): Promise<TerminalPushAnswer>;
  /** The harness settings, resolved and secret-free (ADR-0026): read at a turn's start. Never boots t3. */
  harnessSettings(input: { readonly projectId?: string }): Promise<ResolvedHarness>;
  /** The Model endpoints (SPI-1162), secret-free: read at a turn's start. Never boots t3. */
  modelEndpoints(): Promise<ModelEndpoints>;
  /** A Model endpoint's API key at use time (ADR-0018), for the target the Session holds; null when it has none or moved. */
  endpointCredential(input: EndpointCredentialRequest): Promise<EndpointCredential>;
  /** The model relay's target for an endpoint (SPI-1167): its base URL and headers with its credential, or why not. */
  modelRelayTarget(input: { readonly endpointId: string }): Promise<ModelRelayTarget>;
  /** A Session's, text generation's or the model relay's usage records, kept for t3's Usage page (SPI-1173). Never boots t3. */
  recordUsage(input: { readonly entries: ReadonlyArray<UsageEntry> }): Promise<{ readonly kept: number }>;
  /** A Session's, text generation's or the model relay's limit readings, for t3's limit meters (SPI-1174). Never boots t3. */
  recordLimits(input: { readonly readings: ReadonlyArray<LimitReading> }): Promise<{ readonly kept: number }>;
  /** The Environment settings, resolved (ADR-0032): read before a Container start. Never boots t3. */
  environmentSettings(): Promise<ResolvedEnvironment>;
  /**
   * The Environment skill set (SPI-1148): every enabled Environment skill's files and the set's hash. The Workspace names
   * itself, so the Environment drops its last refusal. Never boots t3.
   */
  environmentSkillSet(input: { readonly workspace: string }): Promise<SkillSet>;
  /** A Workspace refused or could not mount the set `hash` (SPI-1148): shown on the Settings page's Status. */
  skillSetRefused(input: { readonly workspace: string; readonly hash: string; readonly message: string }): Promise<void>;
  /** A Global mise lay-down at a Container start (SPI-1150), for the panel's Status. Never boots t3. */
  noteGlobalMise(report: GlobalMiseReport): Promise<{ readonly kept: boolean }>;
  /** t3's tools as a Session listed them: the panel's t3-code card lists them for their Exposures. Never boots t3. */
  noteT3Tools(listing: T3ToolListing): Promise<{ readonly kept: boolean }>;
  /** The MCP tools this Session may install (ADR-0028). */
  mcpView(): Promise<McpView>;
  /** An MCP call the Session's tool has judged (`decideCall`); the server's questions come back through `asker` (SPI-1079). */
  mcpCall(input: {
    readonly server: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly judged: "read" | "write";
    readonly asker?: McpAsker;
    /** The Session's thread: the Environment derives the caller from it (the Settings server, plan D3). */
    readonly thread: string;
    /** The id a Stop names in `cancelAsk` (the Settings server's calls, plan D9). */
    readonly stopId?: string;
  }): Promise<McpCallAnswer>;
  /** A CLI process's MCP message through the relay (ADR-0028), its caller resolved by the Workspace DO. */
  mcpRelay(input: McpRelayInput): Promise<McpRelayAnswer>;
}

/**
 * What every recorder of usage sends a record with (SPI-1173): the Environment's `recordUsage`, after the answer, kept
 * alive by `waitUntil`. A failed send loses that record only, and is logged by the record's names, never a value.
 */
export const usageSender =
  (ctx: { waitUntil(promise: Promise<unknown>): void }, environment: () => Pick<EnvironmentRpc, "recordUsage">, warn: (line: string) => void = console.warn) =>
  (entry: UsageEntry): void => {
    let sent: Promise<unknown>;
    try {
      sent = environment().recordUsage({ entries: [entry] });
    } catch (error) {
      sent = Promise.reject(error);
    }
    ctx.waitUntil(
      sent.then(
        () => undefined,
        (error: unknown) => warn(JSON.stringify({ t3flare: "usage-record-failed", agent: entry.agent, endpoint: entry.endpointId, error: error instanceof Error ? error.name : "error" })),
      ),
    );
  };

/**
 * What every reader of limit headers sends a reading with (SPI-1174), as `usageSender` sends a usage record: the
 * Environment's `recordLimits`, after the answer's headers, kept alive by `waitUntil`. A failed send loses that reading
 * only, and is logged by its endpoint, never a value.
 */
export const limitsSender =
  (ctx: { waitUntil(promise: Promise<unknown>): void }, environment: () => Pick<EnvironmentRpc, "recordLimits">, warn: (line: string) => void = console.warn) =>
  (reading: LimitReading): void => {
    let sent: Promise<unknown>;
    try {
      sent = environment().recordLimits({ readings: [reading] });
    } catch (error) {
      sent = Promise.reject(error);
    }
    ctx.waitUntil(
      sent.then(
        () => undefined,
        (error: unknown) => warn(JSON.stringify({ t3flare: "limit-reading-failed", endpoint: reading.endpointId, error: error instanceof Error ? error.name : "error" })),
      ),
    );
  };

export const environmentStub = (namespace: DurableObjectNamespace): EnvironmentRpc =>
  namespace.get(namespace.idFromName(ENVIRONMENT_NAME)) as unknown as EnvironmentRpc;
