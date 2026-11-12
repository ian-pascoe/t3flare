// The `t3-mcp` extension (step 3, plan section 4.3; ADR-0022): t3's MCP tools in a Durable agent's Session, built from
// the catalog t3 lists for this thread's own credential (cloudpid's ADR-0030: an extension rebuilt from the MCP
// inventory). Calls go Session → Environment DO (`EnvironmentDO.mcp`) → t3's `/mcp`, never the public host and never
// from a Container: the credential lives in the Session's storage alone.
//
// - Names are t3's own, `mcp__t3-code__<tool>`, so t3's tool presentation and pending-work detection know them.
// - Every tool t3 lists for the thread is offered, as stock t3 offers it, but a short denylist of tools that cannot work
//   here (`T3_TOOL_DENYLIST`; owner, 2026-11-12, back to stock).
// - Approvals as t3's Pi bridge decides (provider-pi/src/server/mcpExtensionSource.ts): a tool annotated read-only never
//   asks, nothing asks in full access, otherwise the call asks, accepted for the session per tool name (review C4). In
//   plan mode only read-only tools run.
// - Replay: a call cut off by a Session restart runs again. A tool that takes `clientRequestId` gets one from its task id
//   when the model gave none, so the rerun returns t3's same durable work; t3 scopes that key by the provider session,
//   so a rerun under a credential t3 issued again (an Environment restart) is refused rather than repeated (review C9).
//   Any other tool that changes state is not run again once started.
// - A wait (`timeoutMs`) goes to t3 in pieces of at most 50 s from its start (review C9), each marked as progress.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalConsole:off
import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, section, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { InteractionMode, RuntimeMode } from "@t3flare/session-protocol";

import { cardText } from "./cardText.ts";
import { type ApprovalStore, askOwner, cutOffResult, planRefusal, STARTED_MEMO } from "./permissions.ts";
import { descriptionFor, guidanceFor, OTHER_MACHINES } from "./t3-guidance.ts";

export const T3_MCP_SERVER = "t3-code";
export const t3ToolName = (name: string): string => `mcp__${T3_MCP_SERVER}__${name}`;

/** The T3 tools a Durable agent is not offered: harness-registry's (ADR-0022). */
export { T3_TOOL_DENYLIST } from "@t3flare/harness-registry";
import { isDeniedT3Tool } from "@t3flare/harness-registry";

/** Tools that wait on t3 for up to `timeoutMs`: sent in pieces of at most WAIT_PIECE_MS. */
const WAIT_TOOLS: ReadonlySet<string> = new Set(["t3_thread_wait", "t3_background_wait"]);
/** `PeerForwarding.FORWARDED_WAIT_CHUNK_MS`'s length, from the wait's start. */
export const WAIT_PIECE_MS = 50_000;
/** A wait the model gave no `timeoutMs` for lasts this long at most, in pieces. */
const DEFAULT_WAIT_MS = 10 * 60_000;

export interface CatalogTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly [key: string]: unknown };
}

/** The tools offered from one `tools/list`, and the listed ones the denylist left out. */
export interface T3Catalog {
  readonly tools: ReadonlyArray<CatalogTool>;
  readonly hash: string;
  readonly left: ReadonlyArray<string>;
}

/** A stable hash of the offered tools (FNV-1a over their JSON), to see when the extension must be built again. */
const hashOf = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const catalogOf = (listed: ReadonlyArray<CatalogTool>): T3Catalog => {
  const tools = listed.filter((tool) => !isDeniedT3Tool(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
  return {
    tools,
    hash: hashOf(JSON.stringify(tools)),
    left: listed.filter((tool) => isDeniedT3Tool(tool.name)).map((tool) => tool.name).sort(),
  };
};

/** One tool call's answer from t3's `/mcp`, or why t3's tools could not be reached. */
export type McpCallAnswer =
  | { readonly kind: "result"; readonly text: string; readonly isError: boolean; readonly structured?: unknown }
  | { readonly kind: "unavailable"; readonly message: string };

export interface T3McpHost {
  readonly store: ApprovalStore;
  readonly mode: () => RuntimeMode;
  readonly interaction: () => InteractionMode;
  readonly turn: () => string | null;
  /** The provider session of t3's credential now; undefined without one. */
  readonly credential: () => string | undefined;
  /** t3's orchestration instructions, while the tools are installed. */
  readonly instructions: () => string | undefined;
  readonly call: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<McpCallAnswer>;
}

const CREDENTIAL_MEMO = "t3flare.t3-mcp.credential";

const textResult = (text: string, isError: boolean, tool: string) => ({
  output: [{ type: "text" as const, text }],
  isError,
  details: { server: T3_MCP_SERVER, tool },
});

const takesKey = (tool: CatalogTool) =>
  typeof tool.inputSchema?.properties === "object" && tool.inputSchema.properties !== null && "clientRequestId" in (tool.inputSchema.properties as object);

/** One tool of the catalog as a pi-durable tool; its description names no denied tool (SPI-1060). */
const toolOf = (tool: CatalogTool, host: T3McpHost): ToolRegistration => {
  const name = t3ToolName(tool.name);
  const readOnly = tool.annotations?.readOnlyHint === true;
  const keyed = takesKey(tool);
  return {
    name,
    description: descriptionFor(tool.description ?? tool.title ?? tool.name),
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as object,
    // Every call may run again after a restart: an approval waits again, a keyed call is t3's same work, and the rest
    // refuse a second run below.
    replay: "safe",
    // A wait is direct-only (ADR-0027, as t3's Codex adapter registers them): from a script it would block the script
    // while the model works around it.
    ...(WAIT_TOOLS.has(tool.name) ? { callers: ["model"] as const } : {}),
    async execute(input: Record<string, unknown>, api: ToolExecutionApi, context: Context) {
      const credential = host.credential();
      if (credential === undefined) return textResult("T3's tools are unavailable in this turn; they come back with the next turn.", true, tool.name);
      if (!readOnly) {
        if (host.interaction() === "plan") return planRefusal();
        // t3 scopes a clientRequestId by the provider session: under a credential issued again, a rerun would be new work.
        const first = await api.memo<string>(CREDENTIAL_MEMO, credential, context);
        if (first !== credential) return cutOffResult();
        if (!keyed && (await api.memo<boolean>(STARTED_MEMO, context)) === true) return cutOffResult();
        if (host.mode() !== "full-access" && !host.store.acceptedFor({ tool: name, kind: "mcp-tool" })) {
          const declined = await askOwner(
            host.store,
            { turn: host.turn(), tool: name, kind: "mcp-tool", summary: cardText(`${tool.name} ${JSON.stringify(input, null, 2)}`) },
            api,
            context,
          );
          if (declined !== undefined) return declined;
        }
        if (!keyed) await api.memo(STARTED_MEMO, true, context);
      }
      const args = keyed && typeof input.clientRequestId !== "string" ? { ...input, clientRequestId: `pi-durable:${String(api.taskId)}` } : input;
      const answer = WAIT_TOOLS.has(tool.name) ? await waitInPieces(host, tool.name, args, api, context) : await host.call(tool.name, args);
      if (answer.kind === "unavailable") return textResult(answer.message, true, tool.name);
      return textResult(answer.text, answer.isError, tool.name);
    },
  } as ToolRegistration;
};

/** A wait in pieces of at most WAIT_PIECE_MS from its start, until it is not a timeout or its time is up. */
const waitInPieces = async (
  host: T3McpHost,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  api: ToolExecutionApi,
  context: Context,
): Promise<McpCallAnswer> => {
  const total = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_WAIT_MS;
  const started = Date.now();
  for (;;) {
    const left = total - (Date.now() - started);
    const answer = await host.call(tool, { ...args, timeoutMs: Math.max(1_000, Math.min(WAIT_PIECE_MS, left)) });
    if (answer.kind !== "result" || answer.isError || Date.now() - started >= total) return answer;
    const timedOut = (() => {
      try {
        return (JSON.parse(answer.text) as { timedOut?: unknown }).timedOut === true;
      } catch {
        return false;
      }
    })();
    if (!timedOut) return answer;
    await api.progressed(context).catch(() => undefined);
  }
};

/**
 * The extension for `catalog`; installed again (replaced in place) whenever the catalog's hash changes. t3's guidance
 * is told without what names a denied tool, then our line on other machines (SPI-1060).
 */
export const t3McpExtension = (catalog: T3Catalog, host: T3McpHost): Extension =>
  defineExtension({
    name: "t3-mcp",
    tools: catalog.tools.map((tool) => toolOf(tool, host)),
    sections: [
      section("t3_orchestration", () => {
        const instructions = host.instructions();
        if (instructions === undefined) return undefined;
        return [guidanceFor(instructions), OTHER_MACHINES].filter((part) => part !== "").join("\n\n");
      }),
    ],
  });
