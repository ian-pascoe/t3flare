// The `mcp` extension (ADR-0028; cloudpid's `packages/extensions/src/mcp.ts`, with t3-mcp's approval rule): the MCP
// server set's tools as the Environment's MCP host lists them (`McpView`), each a pi-durable tool
// `mcp__<server>__<tool>` that calls through `EnvironmentDO.mcpCall`. Exposure per server and tool: `direct` (offered),
// `deferred` (loaded with tool_search; scripts call it any time), `codemode` (scripts only), `hidden` (not installed).
//
// Every call is judged by `decideCall` inside `execute`, so a script's nested call is judged as a direct one: reads run;
// writes follow the thread's mode (plan refuses; full access runs; otherwise the owner is asked, and may accept the tool
// for the session); a linked thread's every write asks, that call only. A write is memoed before it is sent: a restart
// after that answers "cut off", never sends it twice (ADR-0022's rule; Commissary keeps no idempotency key).
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalConsole:off
import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, section, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { decideCall, type ToolClass } from "@t3flare/harness-registry/mcp";
import type { InteractionMode, RuntimeMode } from "@t3flare/session-protocol";

import { cardText } from "./cardText.ts";
import { type ApprovalStore, askOwner, cutOffResult, STARTED_MEMO } from "./permissions.ts";

/** The MCP host's view, as the Environment answers `mcpView` (apps/environment/src/mcp/host.ts). */
export interface McpView {
  readonly version: string;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly state: "available" | "stale" | "unavailable";
    readonly listedAt: number | null;
    readonly exposure: string;
    readonly tools: ReadonlyArray<{
      readonly name: string;
      readonly upstream: string;
      readonly description: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
      readonly class: ToolClass;
      readonly unconfirmed?: true;
      readonly exposure: string;
    }>;
  }>;
}

export type McpCallAnswer =
  | { readonly kind: "result"; readonly isError: boolean; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string; readonly mayHaveRun: boolean };

export interface McpHostOfSession {
  readonly store: ApprovalStore;
  readonly mode: () => RuntimeMode;
  readonly interaction: () => InteractionMode;
  readonly turn: () => string | null;
  /** A linked thread (sticky on the Session). */
  readonly linked: () => boolean;
  readonly call: (input: { readonly server: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly linked: boolean; readonly judged: ToolClass }) => Promise<McpCallAnswer>;
}

const result = (text: string, isError: boolean, details: Record<string, string>) => ({ output: [{ type: "text" as const, text }], isError, details });

const toolOf = (server: McpView["servers"][number], tool: McpView["servers"][number]["tools"][number], host: McpHostOfSession): ToolRegistration => {
  const details = { server: server.name, tool: tool.upstream, class: tool.class };
  return {
    name: tool.name,
    description: `${server.name} (MCP${server.kind === "commissary" ? ", through Commissary" : ""}; ${tool.class} tool): ${tool.description}`,
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as object,
    replay: "safe",
    ...(tool.exposure === "deferred" ? { deferred: true as const } : {}),
    ...(tool.exposure === "codemode" ? { callers: ["tools"] as const } : {}),
    async execute(args: Record<string, unknown>, api: ToolExecutionApi, context: Context) {
      const linked = host.linked();
      const verdict = decideCall({
        class: tool.class,
        mode: host.mode(),
        interaction: host.interaction(),
        linked,
        accepted: host.store.acceptedFor({ tool: tool.name, kind: "mcp-tool" }),
      });
      if (verdict.kind === "refuse") return result(verdict.reason, true, details);
      if (tool.class === "write" && (await api.memo<boolean>(STARTED_MEMO, context)) === true) return cutOffResult();
      if (verdict.kind === "ask") {
        const declined = await askOwner(
          host.store,
          {
            turn: host.turn(),
            tool: tool.name,
            kind: "mcp-tool",
            summary: cardText(`${server.name}: ${tool.upstream}\n${JSON.stringify(args, null, 2)}`),
            detail: `A ${tool.class} tool (${server.kind === "commissary" ? "Commissary's class" : "class set in the harness panel"}${tool.unconfirmed === true ? "; its definition changed since" : ""}).${
              verdict.perCall ? " A linked thread's write: this answer covers this call only." : ""
            }`,
            ...(verdict.perCall ? { perCall: true as const } : {}),
          },
          api,
          context,
        );
        if (declined !== undefined) return declined;
      }
      if (tool.class === "write") await api.memo(STARTED_MEMO, true, context);
      const answer = await host.call({ server: server.name, tool: tool.upstream, args, linked, judged: tool.class });
      if (answer.kind === "unavailable") return result(answer.message, true, details);
      return result(answer.text, answer.isError, details);
    },
  } as ToolRegistration;
};

/** The code mode namespaces of the view's servers: `tools.mcp__<server>__…`. */
export const mcpNamespaces = (view: McpView): ReadonlyArray<CodemodeNamespace> =>
  view.servers.map((server) => ({
    name: server.name,
    description: `MCP server ${server.name}${server.kind === "commissary" ? " (Commissary's toolkits)" : ""}`,
    prefix: `mcp__${server.name}__`,
  }));

/** The extension for `view`; installed again (replaced in place) when the view's version changes. */
export const mcpExtension = (view: McpView, host: McpHostOfSession): Extension =>
  defineExtension({
    name: "mcp",
    tools: view.servers.flatMap((server) => server.tools.filter((tool) => tool.exposure !== "hidden").map((tool) => toolOf(server, tool, host))),
    sections: [
      section("tool_sources", () => {
        if (view.servers.length === 0) return undefined;
        const lines = view.servers.map(
          (server) =>
            `- ${server.name}: ${server.tools.length} tools (mcp__${server.name}__*), ${
              server.state === "available" ? "available" : server.state === "stale" ? `stale since its last list failed` : "unavailable: never listed"
            }`,
        );
        return `MCP tool sources. Deferred tools are found with tool_search or, in code mode, searchTools()/describeNamespace(). Read tools run; write tools may ask the owner.\n${lines.join("\n")}`;
      }),
    ],
  });
