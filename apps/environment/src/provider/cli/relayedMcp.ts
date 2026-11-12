// @effect-diagnostics effectFnOpportunity:off
// t3's own MCP server for CLI agents, as stock t3 hands it (owner, 2026-11-12, back to stock; SPI-1039): the CLI gets
// the thread's MCP config with t3's per-thread bearer. Only the endpoint is changed: t3 names its in-isolate address,
// which a Container cannot reach, so the CLI is given t3's public `/mcp` (ADR-0010: public, behind t3's own bearer).
// The relay's per-process handles stay for third-party servers (Commissary and direct ones), whose credentials are real
// secrets (ADR-0028).
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";

/** t3's MCP sessions as a CLI adapter reads them: t3's own config, at the endpoint a Container reaches. */
export const t3McpForCli = (real: McpProviderSessions.McpProviderSessions["Service"], publicUrl: () => string): McpProviderSessions.McpProviderSessions["Service"] =>
  McpProviderSessions.McpProviderSessions.of({
    ...real,
    read: (threadId) => real.read(threadId).pipe(Effect.map((config) => (config === undefined ? undefined : { ...config, endpoint: publicUrl() }))),
  });
