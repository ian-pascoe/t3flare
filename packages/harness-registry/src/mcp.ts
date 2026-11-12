// The MCP rules every caller shares (ADR-0028): the Durable agent's `mcp` extension, the MCP host, and the CLI relay
// judge a call with the same function, and a tool's class is resolved the same way everywhere.

export type ToolClass = "read" | "write";
export type RuntimeModeName = "approval-required" | "auto-accept-edits" | "full-access" | (string & {});

/**
 * A call's verdict (plan §3.3, review M10): `run`, `refuse`, or `ask` the owner. `perCall`: the answer covers this call
 * only ("accept for the session" counts once), as for a linked thread's every write (D1's rule extended to MCP).
 */
export type CallVerdict = { readonly kind: "run" } | { readonly kind: "ask"; readonly perCall: boolean } | { readonly kind: "refuse"; readonly reason: string };

export const PLAN_REFUSAL = "Refused: this thread is in plan mode, which is read-only; this tool may change things outside it.";

export const decideCall = (input: {
  readonly class: ToolClass;
  readonly mode: RuntimeModeName;
  readonly interaction: string;
  /** A linked thread, or (CLI) a caller in a tainted Workspace. */
  readonly linked: boolean;
  /** The owner accepted this tool for the rest of the Session. */
  readonly accepted: boolean;
}): CallVerdict => {
  if (input.class === "read") return { kind: "run" };
  if (input.interaction === "plan") return { kind: "refuse", reason: PLAN_REFUSAL };
  // Linked before accepted: an acceptance stored by tool name must never let a linked write through.
  if (input.linked) return { kind: "ask", perCall: true };
  if (input.mode === "full-access" || input.accepted) return { kind: "run" };
  return { kind: "ask", perCall: false };
};

/** Where a server comes from: Commissary's endpoint (Route A) or added in the panel (Route B). */
export type ServerKind = "commissary" | "direct";

/** A tool's class as pinned (review H3): by its definition's hash, set from the hint once or by the owner. */
export interface ClassPin {
  readonly class: ToolClass;
  readonly hash: string;
  readonly by: "hint" | "owner";
}

export interface ToolForClass {
  readonly name: string;
  readonly hash: string;
  readonly annotations?: { readonly readOnlyHint?: unknown };
}

export interface ResolvedClass {
  readonly class: ToolClass;
  /** A pin to store: a Commissary tool's first sighting. */
  readonly pin?: ClassPin;
  /** The definition changed since its pin: write until the owner confirms. */
  readonly unconfirmed?: true;
  /** What the tool's hint says, shown to the owner as a suggestion. */
  readonly suggested?: ToolClass;
}

/**
 * A tool's class (review H3). Upstream hints are untrusted, so a hint never turns a pinned write into a read, and a
 * changed definition is write until the owner confirms it. A Commissary tool's first sighting pins its hint (Commissary
 * fronts toolkits the owner chose, and its admin override fixes a hint for every client); a direct server's tool is
 * write until the owner marks it read.
 */
export const classOf = (kind: ServerKind, tool: ToolForClass, pin: ClassPin | undefined): ResolvedClass => {
  const hinted: ToolClass = tool.annotations?.readOnlyHint === true ? "read" : "write";
  if (pin !== undefined) {
    if (pin.hash === tool.hash) return { class: pin.class };
    return { class: "write", unconfirmed: true, suggested: hinted };
  }
  if (kind === "commissary") return { class: hinted, pin: { class: hinted, hash: tool.hash, by: "hint" } };
  return { class: "write", suggested: hinted };
};

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
  /** Review M13: whether linked threads get this server at all; default off, for every server. */
  readonly linkedOffered: boolean;
  /** Pinned classes by exact upstream tool name (review H3). */
  readonly classes?: Readonly<Record<string, ClassPin>>;
}

/** Names a direct server may not take: they are the relay's or t3's. */
export const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["commissary", "t3", "t3-code"]);

export const SERVER_NAME = /^[a-z0-9-]{1,20}$/;

export const defaultCommissary = (): McpServerSetting => ({ kind: "commissary", enabled: true, exposure: "deferred", linkedOffered: false });

/** Most tools taken from one server, and most bytes of their schemas (review M12). */
export const MAX_TOOLS_PER_SERVER = 200;
export const MAX_SCHEMA_BYTES = 256 * 1024;

/** The CLI relay's path prefix in the Container (`computer.internal/t3flare/mcp/<server>`, ADR-0028). */
export const MCP_RELAY_PREFIX = "/t3flare/mcp/";

/** The relay's own server for t3's tools (SPI-1039). */
export const T3_RELAY_SERVER = "t3";

/** CLI MCP timeouts (review M11): above a 10-minute approval hold plus a 270 s call. */
export const CLI_TOOL_TIMEOUT_SEC = 900;

/** The variable a CLI process reads its tool handle from (Codex's `bearer_token_env_var`). */
export const TOOL_HANDLE_ENV = "T3FLARE_TOOL_HANDLE";

/** A CLI process's MCP message, as the Workspace DO passes it to the Environment DO (the caller from the handle). */
export interface McpRelayInput {
  readonly workspace: string;
  readonly thread: string;
  readonly cli: string;
  /** The process's thread came through a peer link. */
  readonly linked: boolean;
  /** The Workspace carries SPI-992's taint (review H1): the caller is treated as linked. */
  readonly tainted: boolean;
  /** The threads of the Workspace's live CLI processes (review M7: the strictest mode among them decides). */
  readonly threads: ReadonlyArray<string>;
  readonly server: string;
  /** One JSON-RPC message (a request or a notification). */
  readonly message: unknown;
  /** Withdraws the call's card when the CLI goes away (`cancelPush`). */
  readonly askId: string;
}

/** The relay's answer: a JSON-RPC response, nothing (a notification: 202), or a refusal before MCP (HTTP status). */
export type McpRelayAnswer = { readonly kind: "response"; readonly body: unknown } | { readonly kind: "accepted" } | { readonly kind: "refused"; readonly status: 401 | 403 | 404; readonly message: string };

/** How strict a thread's mode is for `decideCall` (review M7): the strictest of several wins. */
const MODE_RANK: Readonly<Record<string, number>> = { "full-access": 0, "auto-accept-edits": 1, "approval-required": 2 };

/**
 * The strictest of several threads' modes (review M7): a handle taken from a full-access thread is judged as the
 * Workspace's strictest live thread would be. Unknown modes count as the strictest; plan wins over everything.
 */
export const strictestMode = (modes: ReadonlyArray<{ readonly runtimeMode: string | undefined; readonly interactionMode: string | undefined }>): { readonly mode: RuntimeModeName; readonly interaction: string } => {
  if (modes.length === 0) return { mode: "approval-required", interaction: "default" };
  let rank = -1;
  let mode: RuntimeModeName = "full-access";
  let plan = false;
  for (const entry of modes) {
    if (entry.interactionMode === "plan") plan = true;
    const r = entry.runtimeMode === undefined ? 3 : (MODE_RANK[entry.runtimeMode] ?? 3);
    if (r > rank) {
      rank = r;
      mode = r === 3 ? "approval-required" : (entry.runtimeMode as RuntimeModeName);
    }
  }
  return { mode, interaction: plan ? "plan" : "default" };
};
