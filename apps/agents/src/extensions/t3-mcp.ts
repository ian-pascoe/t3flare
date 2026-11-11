// The `t3-mcp` extension (step 3, plan section 4.3; ADR-0022): t3's MCP tools in a Durable agent's Session, built from
// the catalog t3 lists for this thread's own credential (cloudpid's ADR-0030: an extension rebuilt from the MCP
// inventory). Calls go Session → Environment DO (`EnvironmentDO.mcp`) → t3's `/mcp`, never the public host and never
// from a Container: the credential lives in the Session's storage alone.
//
// - Names are t3's own, `mcp__t3-code__<tool>`, so t3's tool presentation and pending-work detection know them.
// - The allowlist fails closed: a tool t3 adds later is not offered until a bump adds it here.
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

import { type ApprovalStore, askOwner, cutOffResult, MAX_SUMMARY, planRefusal, STARTED_MEMO } from "./permissions.ts";

export const T3_MCP_SERVER = "t3-code";
export const t3ToolName = (name: string): string => `mcp__${T3_MCP_SERVER}__${name}`;

/**
 * The T3 tools a Durable agent is offered (plan section 4.3). Not offered: `request_secret` and `t3_attachment_*` (their
 * purpose is a secret or an upload URL for a shell, which is a Container), `preview_*`, `html_*`, `device_*` (no browser
 * or device in the cloud), `t3_environment_link`/`unlink` (cloud-to-elsewhere links are deferred, ADR-0011), and
 * `t3_worktree_*` (t3's worktree handoff runs git the router has not been audited for).
 */
export const T3_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  // orchestration
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_workflow_stop",
  "t3_background_wait",
  "create_threads",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_pending_request",
  "t3_queue",
  "t3_thread_search",
  "t3_thread_organize",
  "t3_thread_configure",
  "t3_thread_transfer",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "run_scheduled_task_now",
  // projects
  "t3_project_list",
  "t3_project_read",
  "t3_project_create",
  "t3_project_update",
  "t3_project_delete",
  "t3_project_clone",
  "t3_thread_launch",
  // pull requests
  "link_pull_request",
  "link_pull_requests",
  "unlink_pull_request",
  "unlink_pull_requests",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "read_pull_request_guide",
  "write_pull_request_guides",
  // environment
  "t3_environment_read",
  "t3_environment_links",
]);

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

/** The tools offered from one `tools/list`, and the listed ones the allowlist left out. */
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
  const tools = listed.filter((tool) => T3_TOOL_ALLOWLIST.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
  return {
    tools,
    hash: hashOf(JSON.stringify(tools)),
    left: listed.filter((tool) => !T3_TOOL_ALLOWLIST.has(tool.name)).map((tool) => tool.name).sort(),
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

const cut = (text: string, max = MAX_SUMMARY) => (text.length <= max ? text : `${text.slice(0, max)}…`);

const takesKey = (tool: CatalogTool) =>
  typeof tool.inputSchema?.properties === "object" && tool.inputSchema.properties !== null && "clientRequestId" in (tool.inputSchema.properties as object);

/** One tool of the catalog as a pi-durable tool. */
const toolOf = (tool: CatalogTool, host: T3McpHost): ToolRegistration => {
  const name = t3ToolName(tool.name);
  const readOnly = tool.annotations?.readOnlyHint === true;
  const keyed = takesKey(tool);
  return {
    name,
    description: tool.description ?? tool.title ?? tool.name,
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as object,
    // Every call may run again after a restart: an approval waits again, a keyed call is t3's same work, and the rest
    // refuse a second run below.
    replay: "safe",
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
            { turn: host.turn(), tool: name, kind: "mcp-tool", summary: cut(`${tool.name} ${JSON.stringify(input)}`) },
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

/** The extension for `catalog`; installed again (replaced in place) whenever the catalog's hash changes. */
export const t3McpExtension = (catalog: T3Catalog, host: T3McpHost): Extension =>
  defineExtension({
    name: "t3-mcp",
    tools: catalog.tools.map((tool) => toolOf(tool, host)),
    sections: [section("t3_orchestration", () => host.instructions()?.trim() || undefined)],
  });
