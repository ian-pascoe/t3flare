// The MCP rules every caller shares (ADR-0028): the Durable agent's `mcp` extension, the MCP host, and the CLI relay
// judge a call with the same function, and a tool's class is resolved the same way everywhere.

export type ToolClass = "read" | "write";
export type RuntimeModeName = "approval-required" | "auto-accept-edits" | "full-access" | (string & {});

/**
 * A call's verdict (plan §3.3): `run`, `refuse`, or `ask` the owner. A linked thread follows its own mode, as in stock t3
 * (owner, 2026-11-12, back to stock: the per-call rule for linked writes is removed).
 */
export type CallVerdict = { readonly kind: "run" } | { readonly kind: "ask" } | { readonly kind: "refuse"; readonly reason: string };

export const PLAN_REFUSAL = "Refused: this thread is in plan mode, which is read-only; this tool may change things outside it.";

export const decideCall = (input: {
  readonly class: ToolClass;
  readonly mode: RuntimeModeName;
  readonly interaction: string;
  /** The owner accepted this tool for the rest of the Session. */
  readonly accepted: boolean;
}): CallVerdict => {
  if (input.class === "read") return { kind: "run" };
  if (input.interaction === "plan") return { kind: "refuse", reason: PLAN_REFUSAL };
  if (input.mode === "full-access" || input.accepted) return { kind: "run" };
  return { kind: "ask" };
};

/** Where a server comes from: Commissary's endpoint (Route A) or added in the panel (Route B). */
export type ServerKind = "commissary" | "direct";

/**
 * A tool's class: the owner's choice in the panel, else the tool's own `readOnlyHint` (true: read; anything else: write),
 * as t3 does. Owner, 2026-11-12, back to stock: no definition-hash pins, and a direct server's tools are not write
 * until the owner marks them read.
 */
export const classOf = (tool: { readonly annotations?: { readonly readOnlyHint?: unknown } }, owner: ToolClass | undefined): ToolClass =>
  owner ?? (tool.annotations?.readOnlyHint === true ? "read" : "write");

/** pi's limit on a tool name. */
export const MAX_TOOL_NAME = 64;

/** `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_-]` of the tool's name as `_`. */
export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_").replace(/-/g, "_")}`;

/**
 * The tool names of a server's tools by upstream name, and the tools refused: names that collide once sanitised
 * (review H3: both are refused, so a lookalike cannot take a reviewed tool's name) or that are too long.
 */
export const toolNamesOf = (
  server: string,
  tools: ReadonlyArray<string>,
): { readonly names: Readonly<Record<string, string>>; readonly refused: ReadonlyArray<{ readonly tool: string; readonly reason: string }> } => {
  const byName = new Map<string, Array<string>>();
  for (const tool of tools) {
    const name = mcpToolName(server, tool);
    byName.set(name, [...(byName.get(name) ?? []), tool]);
  }
  const names: Record<string, string> = {};
  const refused: Array<{ tool: string; reason: string }> = [];
  for (const [name, upstream] of byName) {
    if (upstream.length > 1) for (const tool of upstream) refused.push({ tool, reason: `its name collides with ${upstream.filter((other) => other !== tool).join(", ")} as ${name}` });
    else if (name.length > MAX_TOOL_NAME) refused.push({ tool: upstream[0]!, reason: `${name} is longer than ${MAX_TOOL_NAME} characters` });
    else names[upstream[0]!] = name;
  }
  return { names, refused };
};

/** How a server's tools reach the Durable agent (cloudpid's Exposure). */
export type Exposure = "direct" | "deferred" | "codemode" | "hidden";

/** A direct server's sign-in (Route B). */
export type ServerAuth = { readonly kind: "none" } | { readonly kind: "header"; readonly header: string } | { readonly kind: "oauth" };

/** One MCP server as the harness settings keep it (no secret: header values and tokens are in the secret store). */
export interface McpServerSetting {
  readonly kind: ServerKind;
  /** Direct servers only (Commissary's comes from the deploy's config). */
  readonly url?: string;
  readonly auth?: ServerAuth;
  readonly enabled: boolean;
  readonly exposure: Exposure;
  readonly toolExposure?: Readonly<Record<string, Exposure>>;
  /** The owner's class overrides, by exact upstream tool name. */
  readonly classes?: Readonly<Record<string, ToolClass>>;
}

/** Names a direct server may not take: they are the relay's or t3's. */
export const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["commissary", "t3", "t3-code"]);

export const SERVER_NAME = /^[a-z0-9-]{1,20}$/;

export const defaultCommissary = (): McpServerSetting => ({ kind: "commissary", enabled: true, exposure: "deferred" });

/** Most tools taken from one server, and most bytes of their schemas (review M12). */
export const MAX_TOOLS_PER_SERVER = 200;
export const MAX_SCHEMA_BYTES = 256 * 1024;

/** The CLI relay's path prefix in the Container (`computer.internal/t3flare/mcp/<server>`, ADR-0028). */
export const MCP_RELAY_PREFIX = "/t3flare/mcp/";

/** CLI MCP timeouts (review M11): above a 10-minute approval hold plus a 270 s call. */
export const CLI_TOOL_TIMEOUT_SEC = 900;

/** The variable a CLI process reads its tool handle from (Codex's `bearer_token_env_var`). */
export const TOOL_HANDLE_ENV = "T3FLARE_TOOL_HANDLE";

/** A CLI process's MCP message, as the Workspace DO passes it to the Environment DO (the caller from the handle). */
export interface McpRelayInput {
  readonly workspace: string;
  readonly thread: string;
  readonly cli: string;
  readonly server: string;
  /** One JSON-RPC message (a request or a notification). */
  readonly message: unknown;
  /** Withdraws the call's card when the CLI goes away (`cancelAsk`). */
  readonly askId: string;
}

/** The relay's answer: a JSON-RPC response, nothing (a notification: 202), or a refusal before MCP (HTTP status). */
export type McpRelayAnswer = { readonly kind: "response"; readonly body: unknown } | { readonly kind: "accepted" } | { readonly kind: "refused"; readonly status: 401 | 403 | 404; readonly message: string };
