// @effect-diagnostics effectFnOpportunity:off
// SPI-1039 (ADR-0028, ADR-0022's refinement): t3's own MCP server for CLI agents, through the relay. t3's adapters read
// the thread's MCP config (`McpProviderSessions.read`) to wire `t3-code` into the CLI; here they get a copy whose
// endpoint is the relay's `/t3flare/mcp/t3` and whose bearer is the thread's process's tool handle. t3's real bearer
// stays in this module (the Environment DO's isolate) for the relay to swap back in: it never reaches a Container.
import { T3_RELAY_SERVER } from "@t3flare/harness-registry";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";

import { relayUrl } from "../../agents/cliProfiles.ts";
import type { CliSessions } from "./wrapper.ts";

/** t3's real `Authorization` by thread, as last read for a CLI session (memory: an Environment restart ends the CLIs). */
const credentials = new Map<string, string>();

/** The real bearer the relay sends t3 for `thread`, or undefined. */
export const t3CredentialOf = (thread: string): string | undefined => credentials.get(thread);

/** t3's MCP sessions as a CLI adapter reads them: the relay's endpoint and the process's handle in place of t3's. */
export const relayedMcp = (real: McpProviderSessions.McpProviderSessions["Service"], sessions: CliSessions): McpProviderSessions.McpProviderSessions["Service"] =>
  McpProviderSessions.McpProviderSessions.of({
    ...real,
    read: (threadId) =>
      real.read(threadId).pipe(
        Effect.map((config) => {
          if (config === undefined) return undefined;
          const session = [...sessions.values()].find((candidate) => candidate.thread === threadId);
          // No CLI session of this driver runs the thread: nothing to relay to, so no t3 tools (as before SPI-1039).
          if (session === undefined) return undefined;
          credentials.set(threadId, config.authorizationHeader);
          return { ...config, endpoint: relayUrl(T3_RELAY_SERVER), authorizationHeader: `Bearer ${session.toolHandle}` };
        }),
      ),
    clear: (threadId) =>
      real.clear(threadId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            credentials.delete(threadId);
          }),
        ),
      ),
  });
