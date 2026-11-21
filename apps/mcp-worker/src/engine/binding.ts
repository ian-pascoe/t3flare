import type { McpBridgeOptions } from "@t3flare/sandbox-image/mcp-bridge";

/** The name the Environment Worker binds `McpWorker`'s `McpEngine` entrypoint under, for `McpHost`. */
export const MCP_ENGINE_BINDING = "MCP_ENGINE";

/** The `McpWorker` entrypoint the Environment Worker binds as `MCP_ENGINE`. */
export const MCP_ENGINE_ENTRYPOINT = "McpEngine";

/** The name `McpWorker` would bind the agents Worker's `WorkspaceMcpBridge` entrypoint under. */
export const MCP_BRIDGE_BINDING = "MCP_BRIDGE";

/**
 * The agents Worker's entrypoint `McpWorker` would bind as `MCP_BRIDGE`. The agents Worker has none, so it is unbound.
 */
export const WORKSPACE_MCP_BRIDGE_ENTRYPOINT = "WorkspaceMcpBridge";

/**
 * What `MCP_BRIDGE` would answer (`WorkspaceMcpBridge`): `request`, the engine's, from the bridge in the Container of
 * Workspace object `workspace` (`ws:<id>`), or one of its own refusals (`McpBridgeRefusal`). It only gains.
 */
export interface McpBridgeBinding {
  mcpBridge(workspace: string, request: Request, options: McpBridgeOptions): Promise<Response>;
}
