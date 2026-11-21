// The tools a Durable agent is offered, one Exposure each: the built-in tools (code mode and tool search among them) and
// t3's own MCP tools. A tool's Exposure is its switch: an extension is installed while any of its tools is not `hidden`,
// so turning code mode, tool search or web search on or off is setting its tool's Exposure. MCP servers' tools keep their
// own Exposure in the MCP server set (ADR-0028); t3's are kept here, since t3's server is not one of that set's.
//
// Settings stored before Exposures existed (extension switches, the offered-tools preset, web's `search`) still resolve:
// a tool with no Exposure of its own takes the one they gave it (`legacyOf`).
import type { HarnessLayer, StoredHarness } from "./index.ts";
import { defaultSettingsServer, type Exposure, type McpServerSetting, ownEntry, SETTINGS_SERVER } from "./mcp.ts";

/** The offered-tools presets (plan §2.2, OD-T4): the tools a preset offers direct; the others it defers. */
export const OFFERED_PRESETS = {
  /** B, the default: the core coding tools, `ask_user`, code mode, tool search and t3's own tools. */
  core: ["read", "edit", "write", "bash", "ls", "find", "grep", "ask_user", "codemode", "tool_search", "mcp__t3-code__*", "web_fetch", "web_search", "todo", "context_notes", "context_history", "context_rollover", "terminal_start", "terminal_send", "terminal_stop", "terminal_list", "terminal_wait"],
  /** A: code mode and tool search; every other tool through a script or a search. */
  "codemode-only": ["codemode", "tool_search"],
  /** C: everything direct. */
  everything: ["*"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type OfferedPreset = keyof typeof OFFERED_PRESETS;

export const EXPOSURES: ReadonlyArray<Exposure> = ["direct", "deferred", "codemode", "hidden"];
/** A tool that only turns something on or off: code mode's and tool search's own tools. */
const SWITCH: ReadonlyArray<Exposure> = ["direct", "hidden"];
/** A tool scripts may not call (a wait would block the script while the model works around it, ADR-0027). */
const DIRECT_ONLY: ReadonlyArray<Exposure> = ["direct", "deferred", "hidden"];

export interface BuiltinTool {
  readonly name: string;
  /** The harness registry's extension the tool comes from. */
  readonly extension: string;
  /** The Exposures it may have. */
  readonly exposures: ReadonlyArray<Exposure>;
}

const tools = (extension: string, names: ReadonlyArray<string>, exposures: ReadonlyArray<Exposure> = EXPOSURES): Array<BuiltinTool> =>
  names.map((name) => ({ name, extension, exposures }));

/** Every built-in tool, in the panel's order. `propose_plan` is not here: plan mode alone offers it. */
export const BUILTIN_TOOLS: ReadonlyArray<BuiltinTool> = [
  ...tools("codemode", ["codemode"], SWITCH),
  ...tools("tool-search", ["tool_search"], SWITCH),
  ...tools("coding-tools", ["read", "edit", "write", "bash"]),
  ...tools("files", ["ls", "find", "grep"]),
  ...tools("ask-user", ["ask_user"]),
  ...tools("web", ["web_fetch", "web_search"]),
  ...tools("todo", ["todo"]),
  ...tools("context", ["context_notes", "context_history", "context_rollover"]),
  ...tools("termctrl", ["terminal_start", "terminal_send", "terminal_stop", "terminal_list", "terminal_wait"]),
];

export const builtinTool = (name: string): BuiltinTool | undefined => BUILTIN_TOOLS.find((tool) => tool.name === name);

/** t3's MCP server as a Durable agent names it: its tools are `mcp__t3-code__<tool>`. */
export const T3_SERVER = "t3-code";

/** t3's tools that wait on t3: direct-only, as t3's Codex adapter registers them (ADR-0027). */
export const T3_DIRECT_ONLY: ReadonlySet<string> = new Set(["t3_thread_wait", "t3_background_wait"]);

/** The Exposures t3's tool `tool` may have. */
export const t3Exposures = (tool: string): ReadonlyArray<Exposure> => (T3_DIRECT_ONLY.has(tool) ? DIRECT_ONLY : EXPOSURES);

/** A t3 tool name as t3 lists it. */
const T3_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The most tools t3 lists, and the most of its tools the owner may set one by one. */
const MAX_T3_TOOLS = 200;

/** The tools' part of a settings layer. */
export interface ToolsLayer {
  /** Built-in tools, by name. */
  readonly tools?: Readonly<Record<string, Exposure>>;
  /** t3's tools: `exposure` for each tool without its own, and the owner's per tool by t3's name. */
  readonly t3?: { readonly exposure?: Exposure; readonly tools?: Readonly<Record<string, Exposure>> };
}

/** Every tool's Exposure, resolved. */
export interface ResolvedTools {
  /** Every built-in tool. */
  readonly tools: Readonly<Record<string, Exposure>>;
  /**
   * t3's tools: `exposure` for a tool with none of its own and no hint (a tool t3 marks `anthropic/alwaysLoad` is direct
   * unless the owner set it), `tools` the owner's.
   */
  readonly t3: { readonly exposure: Exposure; readonly tools: Readonly<Record<string, Exposure>> };
}

/** What settings from before Exposures say of a tool with no Exposure of its own. */
interface Legacy {
  /** Whether an extension's switch was turned off. */
  readonly off: (extension: string) => boolean;
  /** Whether web's `search` setting offered `web_search`. */
  readonly webSearch: boolean;
  /** The tools the preset offered (or `*`: tool search was off, so nothing was deferred). */
  readonly offered: ReadonlyArray<string>;
}

/** Whether `name` matches `pattern`, where `*` matches any run of characters. */
export const matchesToolPattern = (pattern: string, name: string): boolean => {
  if (!pattern.includes("*")) return pattern === name;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(name);
};

const presetOf = (preset: unknown): ReadonlyArray<string> =>
  typeof preset === "string" ? (ownEntry(OFFERED_PRESETS as Readonly<Record<string, ReadonlyArray<string>>>, preset) ?? OFFERED_PRESETS.core) : OFFERED_PRESETS.core;

/** The legacy settings of a stored layer. */
const legacyOf = (layer: HarnessLayer): Legacy => {
  const extensions = layer.extensions ?? {};
  const off = (extension: string) => ownEntry(extensions, extension)?.enabled === false;
  return {
    off,
    webSearch: ownEntry(extensions, "web")?.settings?.search === true,
    offered: off("tool-search") ? ["*"] : presetOf(ownEntry(extensions, "offered-tools")?.settings?.preset),
  };
};

/** The Exposure `offered` gives a tool: direct when offered, else deferred. */
const offeredExposure = (offered: ReadonlyArray<string>, name: string): Exposure => (offered.some((pattern) => matchesToolPattern(pattern, name)) ? "direct" : "deferred");

const legacyExposure = (legacy: Legacy, tool: BuiltinTool): Exposure => {
  if (legacy.off(tool.extension)) return "hidden";
  if (tool.name === "web_search" && !legacy.webSearch) return "hidden";
  if (tool.exposures === SWITCH) return "direct";
  return offeredExposure(legacy.offered, tool.name);
};

/** A stored Exposure when it is one `allowed` has, else undefined (a malformed one resolves as if unset). */
const validExposure = (value: unknown, allowed: ReadonlyArray<Exposure>): Exposure | undefined =>
  typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value) ? (value as Exposure) : undefined;

const resolveWith = (layer: ToolsLayer, legacy: Legacy): ResolvedTools => ({
  tools: Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, validExposure(ownEntry(layer.tools, tool.name), tool.exposures) ?? legacyExposure(legacy, tool)])),
  t3: {
    exposure: validExposure(layer.t3?.exposure, EXPOSURES) ?? offeredExposure(legacy.offered, `mcp__${T3_SERVER}__tool`),
    tools: Object.fromEntries(
      Object.entries(layer.t3?.tools ?? {}).flatMap(([tool, exposure]) => {
        const valid = validExposure(exposure, t3Exposures(tool));
        return valid === undefined ? [] : [[tool, valid]];
      }),
    ),
  },
});

/** Every tool's Exposure in a merged settings layer. */
export const resolveTools = (layer: HarnessLayer): ResolvedTools => resolveWith(layer, legacyOf(layer));

/**
 * The tools of a resolved view a Session kept from before Exposures existed (its `offered` and extension switches), so
 * a Session restarted before its next turn reads the settings offers what it offered.
 */
export const legacyResolvedTools = (view: {
  readonly offered?: ReadonlyArray<string>;
  readonly extensions: Readonly<Record<string, { readonly enabled: boolean; readonly settings: Readonly<Record<string, unknown>> }>>;
}): ResolvedTools =>
  resolveWith(
    {},
    {
      off: (extension) => ownEntry(view.extensions, extension)?.enabled === false,
      webSearch: ownEntry(view.extensions, "web")?.settings.search === true,
      offered: view.offered ?? OFFERED_PRESETS.core,
    },
  );

/** One change to the tools' Exposures: a preset applied first, then each tool named (`null`: back to its default). */
export interface ToolsChange {
  readonly preset?: OfferedPreset;
  readonly tools?: Readonly<Record<string, Exposure | null>>;
  readonly t3?: { readonly exposure?: Exposure; readonly tools?: Readonly<Record<string, Exposure | null>> };
}

/** The tools' layer with `entries` set (a `null` removes one); a Map, so a name like `__proto__` is a key like any other. */
const withEntries = (before: Readonly<Record<string, Exposure>> | undefined, entries: Iterable<readonly [string, Exposure | null]>): Record<string, Exposure> => {
  const map = new Map<string, Exposure>(Object.entries(before ?? {}));
  for (const [name, exposure] of entries) {
    if (exposure === null) map.delete(name);
    else map.set(name, exposure);
  }
  return Object.fromEntries(map);
};

/**
 * `preset` over `layer`: every built-in tool that is not hidden and is not a switch takes the Exposure the preset gives
 * it, and so do t3's tools (their default, and each tool the owner set but did not hide, kept as its own so a tool t3
 * asks for in every request is not widened to direct). Hidden tools stay hidden.
 */
const withPreset = (layer: HarnessLayer, preset: OfferedPreset): HarnessLayer => {
  const current = resolveTools(layer);
  const offered = OFFERED_PRESETS[preset];
  const builtins = BUILTIN_TOOLS.filter((tool) => tool.exposures !== SWITCH && current.tools[tool.name] !== "hidden").map((tool) => [tool.name, offeredExposure(offered, tool.name)] as const);
  const t3Preset = offeredExposure(offered, `mcp__${T3_SERVER}__tool`);
  const t3Exposure = current.t3.exposure === "hidden" ? "hidden" : t3Preset;
  const t3Tools = Object.entries(current.t3.tools)
    .filter(([, exposure]) => exposure !== "hidden")
    .map(([tool]) => [tool, t3Preset] as const);
  return { ...layer, tools: withEntries(layer.tools, builtins), t3: { exposure: t3Exposure, tools: withEntries(layer.t3?.tools, t3Tools) } };
};

/** The Exposure `offered` gives an MCP server's tools: a preset names them by server, so any tool name stands for all. */
const serverExposure = (offered: ReadonlyArray<string>, server: string): Exposure => offeredExposure(offered, `mcp__${server}__tool`);

/** What a preset leaves on an MCP server: hidden, and code mode only, as the old preset's wrap did (it only deferred). */
const KEPT_BY_PRESET: ReadonlyArray<Exposure> = ["hidden", "codemode"];

/**
 * `preset` over one MCP server, as the old preset's wrap did: its Exposure unless hidden or code mode only, and each
 * tool's own back to it (or, when the server keeps its own, the preset's); hidden and code-mode-only tools stay.
 */
const presetServer = (offered: ReadonlyArray<string>, name: string, server: McpServerSetting): McpServerSetting => {
  const exposure = serverExposure(offered, name);
  const kept = KEPT_BY_PRESET.includes(server.exposure);
  const own = Object.entries(server.toolExposure ?? {}).flatMap(([tool, each]): Array<readonly [string, Exposure]> =>
    KEPT_BY_PRESET.includes(each) ? [[tool, each]] : kept ? [[tool, exposure]] : [],
  );
  const { toolExposure: _toolExposure, ...rest } = server;
  return { ...rest, exposure: kept ? server.exposure : exposure, ...(own.length === 0 ? {} : { toolExposure: Object.fromEntries(own) }) };
};

/**
 * `preset` over the stored MCP servers (ADR-0042 §5): every Direct server and the Settings server's entry, the implied
 * one stored only when the preset moves it. An entry the set ignores (`mcpServersOf`) is kept as it is.
 */
const withPresetServers = (stored: StoredHarness, preset: OfferedPreset): StoredHarness["mcp"] => {
  const offered = OFFERED_PRESETS[preset];
  const servers = new Map<string, McpServerSetting>(Object.entries(stored.mcp?.servers ?? {}));
  for (const [name, server] of servers) {
    if ((name === SETTINGS_SERVER) !== (server.kind === "settings") || (server.kind !== "direct" && server.kind !== "settings")) continue;
    servers.set(name, presetServer(offered, name, server));
  }
  if (servers.get(SETTINGS_SERVER)?.kind !== "settings") {
    const implied = presetServer(offered, SETTINGS_SERVER, defaultSettingsServer());
    if (implied.exposure !== defaultSettingsServer().exposure) servers.set(SETTINGS_SERVER, implied);
  }
  return servers.size === 0 && stored.mcp === undefined ? undefined : { servers: Object.fromEntries(servers) };
};

const exposureProblem = (name: string, value: unknown, allowed: ReadonlyArray<Exposure>): string | undefined =>
  value === null || validExposure(value, allowed) !== undefined ? undefined : `${name}: one of ${allowed.join(", ")}, or null`;

/** `stored` with the tools `change` applied to Global and the revision bumped, or why it is refused. */
export const applyToolsChange = (
  stored: StoredHarness,
  change: ToolsChange,
): { readonly ok: true; readonly harness: StoredHarness } | { readonly ok: false; readonly error: string } => {
  if (change.preset !== undefined && (typeof change.preset !== "string" || !Object.hasOwn(OFFERED_PRESETS, change.preset))) {
    return { ok: false, error: `preset: one of ${Object.keys(OFFERED_PRESETS).join(", ")}` };
  }
  const named = Object.entries(change.tools ?? {});
  for (const [name, exposure] of named) {
    const tool = builtinTool(name);
    if (tool === undefined) return { ok: false, error: `${name}: not a built-in tool` };
    const problem = exposureProblem(name, exposure, tool.exposures);
    if (problem !== undefined) return { ok: false, error: problem };
  }
  if (change.t3?.exposure !== undefined && validExposure(change.t3.exposure, EXPOSURES) === undefined) return { ok: false, error: `t3 exposure: one of ${EXPOSURES.join(", ")}` };
  const t3Named = Object.entries(change.t3?.tools ?? {});
  for (const [tool, exposure] of t3Named) {
    if (!T3_TOOL_NAME.test(tool)) return { ok: false, error: `${tool}: not a t3 tool name` };
    const problem = exposureProblem(`${T3_SERVER}/${tool}`, exposure, t3Exposures(tool));
    if (problem !== undefined) return { ok: false, error: problem };
  }
  const base = change.preset === undefined ? stored.global : withPreset(stored.global, change.preset);
  const mcp = change.preset === undefined ? stored.mcp : withPresetServers(stored, change.preset);
  const t3Exposure = change.t3?.exposure ?? base.t3?.exposure;
  const global: HarnessLayer = {
    ...base,
    tools: withEntries(base.tools, named),
    t3: { ...(t3Exposure === undefined ? {} : { exposure: t3Exposure }), tools: withEntries(base.t3?.tools, t3Named) },
  };
  if (Object.keys(global.t3?.tools ?? {}).length > MAX_T3_TOOLS) return { ok: false, error: `t3 tools: at most ${MAX_T3_TOOLS} set one by one` };
  return { ok: true, harness: { ...stored, revision: stored.revision + 1, global, ...(mcp === undefined ? {} : { mcp }) } };
};

/**
 * Each tool whose Exposure moves between two resolved views: its label, before and after. `asksForDirect` says whether
 * t3 asks for one of its tools in every request (direct unless the owner set it); undefined when unknown (not listed),
 * where a move is judged as widening: not asking before, asking after.
 */
export const movedTools = (
  before: ResolvedTools,
  after: ResolvedTools,
  asksForDirect: (tool: string) => boolean | undefined = () => undefined,
): Array<{ readonly tool: string; readonly before: Exposure; readonly after: Exposure }> => {
  const moves: Array<{ tool: string; before: Exposure; after: Exposure }> = [];
  for (const tool of BUILTIN_TOOLS) {
    const from = before.tools[tool.name]!;
    const to = after.tools[tool.name]!;
    if (from !== to) moves.push({ tool: tool.name, before: from, after: to });
  }
  if (before.t3.exposure !== after.t3.exposure) moves.push({ tool: `${T3_SERVER} (tools without their own)`, before: before.t3.exposure, after: after.t3.exposure });
  for (const tool of [...new Set([...Object.keys(before.t3.tools), ...Object.keys(after.t3.tools)])].sort()) {
    const asks = asksForDirect(tool);
    const own = [ownEntry(before.t3.tools, tool), ownEntry(after.t3.tools, tool)] as const;
    const from = own[0] ?? (asks === true ? "direct" : before.t3.exposure);
    const to = own[1] ?? (asks !== false ? "direct" : after.t3.exposure);
    if (from !== to) moves.push({ tool: `${T3_SERVER}/${tool}`, before: from, after: to });
    // Its hint unknown, a stored change judged as no move still moves something: shown, at its worst case.
    else if (asks === undefined && own[0] !== own[1]) moves.push({ tool: `${T3_SERVER}/${tool} (t3's hint unknown)`, before: from, after: to });
  }
  return moves;
};

/**
 * Each MCP server's tools whose Exposure moves between two server sets (`mcpServersOf`): the server's default, and each
 * tool with its own Exposure on either side. A server on one side only is not a move of tools.
 */
export const movedServerTools = (
  before: Readonly<Record<string, McpServerSetting>>,
  after: Readonly<Record<string, McpServerSetting>>,
): Array<{ readonly server: string; readonly tool: string; readonly before: Exposure; readonly after: Exposure }> => {
  const moves: Array<{ server: string; tool: string; before: Exposure; after: Exposure }> = [];
  for (const [server, from] of Object.entries(before)) {
    const to = ownEntry(after, server);
    if (to === undefined) continue;
    if (from.exposure !== to.exposure) moves.push({ server, tool: `${server} (tools without their own)`, before: from.exposure, after: to.exposure });
    for (const tool of [...new Set([...Object.keys(from.toolExposure ?? {}), ...Object.keys(to.toolExposure ?? {})])].sort()) {
      const was = ownEntry(from.toolExposure, tool) ?? from.exposure;
      const is = ownEntry(to.toolExposure, tool) ?? to.exposure;
      if (was !== is) moves.push({ server, tool: `${server}/${tool}`, before: was, after: is });
    }
  }
  return moves;
};

/** One of t3's tools as a Session last listed it, for the panel's t3-code card. */
export interface T3ListedTool {
  readonly name: string;
  readonly description?: string;
  readonly readOnly: boolean;
  /** t3 asks for it in every request (`anthropic/alwaysLoad`): direct unless the owner sets it. */
  readonly asksForDirect: boolean;
}

/** t3's tools as a Session last listed them (t3 lists them per thread: one thread's list, the latest). */
export interface T3ToolListing {
  readonly listedAt: number;
  readonly tools: ReadonlyArray<T3ListedTool>;
  /** Tools t3 listed that a Durable agent is not offered (the denylist, ADR-0022). */
  readonly left: ReadonlyArray<string>;
}

/** The longest t3 tool description the panel keeps. */
export const MAX_T3_DESCRIPTION = 400;

/** `value` as a listing when it is a well-formed one (another Worker's report), its descriptions cut; else undefined. */
export const t3ToolListing = (value: unknown): T3ToolListing | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const { listedAt, tools, left } = value as Record<string, unknown>;
  if (typeof listedAt !== "number" || !Array.isArray(tools) || !Array.isArray(left) || tools.length > MAX_T3_TOOLS || left.length > MAX_T3_TOOLS) return undefined;
  const listed: Array<T3ListedTool> = [];
  for (const tool of tools as Array<unknown>) {
    if (tool === null || typeof tool !== "object") return undefined;
    const { name, description, readOnly, asksForDirect } = tool as Record<string, unknown>;
    if (typeof name !== "string" || !T3_TOOL_NAME.test(name) || typeof readOnly !== "boolean" || typeof asksForDirect !== "boolean") return undefined;
    listed.push({ name, readOnly, asksForDirect, ...(typeof description === "string" ? { description: description.slice(0, MAX_T3_DESCRIPTION) } : {}) });
  }
  if (!left.every((name) => typeof name === "string" && T3_TOOL_NAME.test(name))) return undefined;
  return { listedAt, tools: listed, left: left as ReadonlyArray<string> };
};

/** Whether t3 asks for its tool `tool` in every request, by `listing`; undefined when it is not listed. */
export const t3AsksForDirect =
  (listing: T3ToolListing | undefined) =>
  (tool: string): boolean | undefined =>
    listing?.tools.find((each) => each.name === tool)?.asksForDirect;
