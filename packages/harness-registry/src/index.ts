// The harness registry (ADR-0026): every Pi Durable extension the harness panel shows, with its switch and its settings
// schema, and how the stored settings resolve for a Session. Imported by the Environment Worker (the panel and its API
// validate against it) and the agents Worker (the Session builds its registry from the resolved view). Later ports
// (pi-parity: web, todo, context, guardian…) add an entry here and appear in the panel without panel work.
//
import {
  defaultCommissary,
  type Exposure,
  type McpServerSetting,
  RESERVED_SERVER_NAMES,
  SERVER_NAME,
  type ServerAuth,
  type ToolClass,
} from "./mcp.ts";

export * from "./mcp.ts";

// Settings are Global (the Cloud Environment) now; the stored shape has per-Project `overrides`, empty, resolved with
// cloudpid ADR-0027's merge (an Override's keyed settings merge over Global's key by key; lists are replaced whole) so a
// later step only adds a scope picker.

/** A setting's schema: the JSON Schema subset the panel renders as a form and the API validates against. */
export type FieldSchema =
  | { readonly type: "boolean"; readonly default: boolean }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number; readonly default: number }
  | { readonly type: "enum"; readonly values: ReadonlyArray<string>; readonly default: string };

export type SettingValue = boolean | number | string;

export interface SettingEntry {
  readonly title: string;
  readonly description: string;
  readonly schema: FieldSchema;
}

export interface ExtensionEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Whether the extension is on with no setting stored; `always` has no switch (on, and cannot be turned off). */
  readonly default: "on" | "off" | "always";
  readonly settings: Readonly<Record<string, SettingEntry>>;
  /** Why the panel cannot change it at all. */
  readonly locked?: string;
}

/** The offered-tools presets (plan §2.2, OD-T4): which non-MCP tools the model is offered without a search. */
export const OFFERED_PRESETS = {
  /** B, the default: the core coding tools, `ask_user`, code mode, tool search and t3's own tools. */
  core: ["read", "edit", "write", "bash", "ls", "find", "grep", "ask_user", "codemode", "tool_search", "mcp__t3-code__*", "web_fetch", "web_search", "todo", "context_notes", "context_history", "context_rollover"],
  /** A: code mode and tool search; every other tool through a script or a search. */
  "codemode-only": ["codemode", "tool_search"],
  /** C: everything direct. */
  everything: ["*"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type OfferedPreset = keyof typeof OFFERED_PRESETS;

const CORE_LOCK = "a core extension: always on";

/** The models `web_search` may ask (the proxy's Claude models; models.json). */
export const SEARCH_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;

export const EXTENSIONS: ReadonlyArray<ExtensionEntry> = [
  {
    id: "codemode",
    title: "Code mode",
    description:
      "The codemode tool: the model writes a JavaScript script whose tool calls run as nested calls, each judged exactly as a direct call (ADR-0027). Scripts run in the codemode sandbox Worker.",
    default: "on",
    settings: {
      inlineBudget: {
        title: "Inline budget",
        description: "Estimated tokens the tool declarations in the code mode section may use; past it, scripts find tools with searchTools().",
        schema: { type: "integer", minimum: 500, maximum: 20_000, default: 2_000 },
      },
    },
  },
  {
    id: "tool-search",
    title: "Tool search",
    description: "The tool_search tool, which loads a deferred tool for direct use. Off: every tool is offered directly.",
    default: "on",
    settings: {},
  },
  {
    id: "offered-tools",
    title: "Offered tools",
    description:
      "Which tools the model is offered without a search: core (coding tools, ask_user, code mode, tool search, t3's tools), code mode only, or everything. Tools not offered stay callable from scripts and by tool search.",
    default: "always",
    settings: {
      preset: {
        title: "Preset",
        description: "core: about 14.5k tokens of declarations per request; codemode-only: about 3k; everything: every tool direct.",
        schema: { type: "enum", values: Object.keys(OFFERED_PRESETS), default: "core" },
      },
    },
  },
  {
    id: "web",
    title: "Web tools",
    description:
      "web_fetch: one public page as Markdown, text or HTML, through an SSRF guard. web_search, when switched on below: a search-capable model behind the model proxy searches and cites its sources (no new key). Both are reads, allowed in every mode (SPI-1054).",
    default: "on",
    settings: {
      search: {
        title: "Web search",
        description: "Offer web_search. Off by default: each search is a model request on the proxy's spend.",
        schema: { type: "boolean", default: false },
      },
      searchModel: {
        title: "Search model",
        description: "The model that runs web_search's searches through the proxy (Commissary passes its web search tool to Claude, or to Codex as its own).",
        schema: { type: "enum", values: SEARCH_MODELS, default: "claude-haiku-5-5" },
      },
    },
  },
  {
    id: "todo",
    title: "Todo list",
    description:
      "todo: the agent's Task list for the thread, kept in the Session and shown as t3's todo list. It survives compaction and rollover, and plan mode allows it (SPI-1055).",
    default: "on",
    settings: {},
  },
  {
    id: "context",
    title: "Context management",
    description:
      "context_notes (named Notes kept across compaction and rollover), context_history (the thread's stored History, from before a Handoff too) and context_rollover (the agent hands off to a fresh context it writes itself). Notes and History stay in the Session's storage (SPI-1056).",
    default: "on",
    settings: {
      rolloverOnCompaction: {
        title: "Rollover on compaction",
        description:
          "When the context nears full, ask the agent to roll over with its own Handoff instead of a generated summary; a compaction that cannot wait uses the last saved Handoff. Off: pi-durable's own summary.",
        schema: { type: "boolean", default: true },
      },
    },
  },
  { id: "coding-tools", title: "Coding tools", description: "read, write, edit and bash (Worker Shell or Container).", default: "always", settings: {}, locked: CORE_LOCK },
  { id: "files", title: "File tools", description: "ls, find and grep.", default: "always", settings: {}, locked: CORE_LOCK },
  {
    id: "permissions",
    title: "Permissions",
    description: "The runtime and interaction modes' approvals, the linked-thread rules and path translation. Can never be turned off from the panel.",
    default: "always",
    settings: {},
    locked: "the thread's modes and the link fence depend on it",
  },
  { id: "ask-user", title: "Ask user", description: "ask_user: a question to the owner on the thread.", default: "always", settings: {}, locked: CORE_LOCK },
  { id: "t3-mcp", title: "T3 Code tools", description: "t3's own MCP tools (ADR-0022), through the Environment DO.", default: "always", settings: {}, locked: CORE_LOCK },
  { id: "project-context", title: "Project context", description: "The repo's AGENTS.md and CLAUDE.md in the prompt.", default: "always", settings: {}, locked: CORE_LOCK },
];

const entryOf = (id: string) => EXTENSIONS.find((entry) => entry.id === id);

/**
 * Extension `id` as `resolved` has it, or its defaults when `resolved` predates the entry (a Session keeps the view it
 * last took, and a deploy can add an entry before the Session's next turn reads the settings again).
 */
export const extensionOf = (
  resolved: ResolvedHarness,
  id: string,
): { readonly enabled: boolean; readonly settings: Readonly<Record<string, SettingValue>> } => {
  const taken = resolved.extensions[id];
  const entry = entryOf(id);
  if (entry === undefined) return taken ?? { enabled: false, settings: {} };
  const defaults = Object.fromEntries(Object.entries(entry.settings).map(([key, setting]) => [key, setting.schema.default]));
  return { enabled: taken?.enabled ?? entry.default !== "off", settings: { ...defaults, ...taken?.settings } };
};

/** One scope's stored choices: per extension, its switch and the settings set explicitly. */
export interface HarnessLayer {
  readonly extensions?: Readonly<Record<string, { readonly enabled?: boolean; readonly settings?: Readonly<Record<string, SettingValue>> }>>;
}

/** What the Environment DO stores (`t3flare:harness:settings`). */
export interface StoredHarness {
  /** Bumped by every change; a Session reinstalls what changed when it sees a new one. */
  readonly revision: number;
  readonly global: HarnessLayer;
  /** The MCP server set (ADR-0028), Environment-wide; Commissary's entry is implied until changed. */
  readonly mcp?: { readonly servers: Readonly<Record<string, McpServerSetting>> };
  /** Per-Project overrides, by project id: the later seam (empty now). */
  readonly overrides: Readonly<Record<string, HarnessLayer>>;
}

export const EMPTY_HARNESS: StoredHarness = { revision: 0, global: {}, overrides: {} };

/** The MCP server set with Commissary's entry (enabled by default, ADR-0028). */
export const mcpServersOf = (stored: StoredHarness): Readonly<Record<string, McpServerSetting>> => ({
  commissary: defaultCommissary(),
  ...stored.mcp?.servers,
});

/** One change to the MCP server set from the panel or a script. */
export type McpChange =
  | {
      readonly op: "server";
      readonly server: string;
      readonly enabled?: boolean;
      readonly exposure?: Exposure;
      readonly toolExposure?: Readonly<Record<string, Exposure | null>>;
    }
  /** The owner's class for a tool; `null` returns it to the tool's own hint. */
  | { readonly op: "class"; readonly server: string; readonly tool: string; readonly class: ToolClass | null }
  | { readonly op: "add"; readonly server: string; readonly url: string; readonly auth: ServerAuth }
  | { readonly op: "remove"; readonly server: string };

const EXPOSURES: ReadonlyArray<Exposure> = ["direct", "deferred", "codemode", "hidden"];

/** `url` as a direct server may have it (plan §5.3, review M5): HTTPS, a name not an IP literal, no userinfo, no port games. */
export const directUrlProblem = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a URL";
  }
  if (parsed.protocol !== "https:") return "only https";
  if (parsed.username !== "" || parsed.password !== "") return "no credentials in the URL";
  const host = parsed.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return "a public host name, not an address";
  return undefined;
};

/** `stored` with the MCP `change` applied and the revision bumped, or why it is refused. */
export const applyMcpChange = (
  stored: StoredHarness,
  change: McpChange,
): { readonly ok: true; readonly harness: StoredHarness } | { readonly ok: false; readonly error: string } => {
  const servers: Record<string, McpServerSetting> = { ...mcpServersOf(stored) };
  const current = servers[change.server];
  const save = (next: Record<string, McpServerSetting>) => ({ ok: true as const, harness: { ...stored, revision: stored.revision + 1, mcp: { servers: next } } });
  if (change.op === "add") {
    if (!SERVER_NAME.test(change.server)) return { ok: false, error: `${change.server}: a name of 1-20 of a-z, 0-9 and -` };
    if (RESERVED_SERVER_NAMES.has(change.server)) return { ok: false, error: `${change.server}: reserved` };
    if (current !== undefined) return { ok: false, error: `${change.server}: exists` };
    const problem = directUrlProblem(change.url);
    if (problem !== undefined) return { ok: false, error: `${change.server}: ${problem}` };
    if (change.auth.kind === "header" && !/^[A-Za-z0-9-]{1,64}$/.test(change.auth.header)) return { ok: false, error: `${change.server}: a header name` };
    return save({ ...servers, [change.server]: { kind: "direct", url: change.url, auth: change.auth, enabled: true, exposure: "deferred" } });
  }
  if (current === undefined) return { ok: false, error: `${change.server}: no such server` };
  if (change.op === "remove") {
    if (current.kind === "commissary") return { ok: false, error: "commissary: disable it instead" };
    const { [change.server]: _removed, ...rest } = servers;
    return save(rest);
  }
  if (change.op === "class") {
    if (change.class !== null && change.class !== "read" && change.class !== "write") return { ok: false, error: "class: read, write or null" };
    const { [change.tool]: _previous, ...classes } = current.classes ?? {};
    return save({ ...servers, [change.server]: { ...current, classes: change.class === null ? classes : { ...classes, [change.tool]: change.class } } });
  }
  if (change.exposure !== undefined && !EXPOSURES.includes(change.exposure)) return { ok: false, error: `exposure: one of ${EXPOSURES.join(", ")}` };
  const toolExposure: Record<string, Exposure> = { ...current.toolExposure };
  for (const [tool, exposure] of Object.entries(change.toolExposure ?? {})) {
    if (exposure === null) delete toolExposure[tool];
    else if (!EXPOSURES.includes(exposure)) return { ok: false, error: `exposure: one of ${EXPOSURES.join(", ")}` };
    else toolExposure[tool] = exposure;
  }
  return save({
    ...servers,
    [change.server]: {
      ...current,
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.exposure === undefined ? {} : { exposure: change.exposure }),
      toolExposure,
    },
  });
};

/** What a Session reads: secret-free, every extension resolved. */
export interface ResolvedHarness {
  readonly revision: number;
  readonly extensions: Readonly<Record<string, { readonly enabled: boolean; readonly settings: Readonly<Record<string, SettingValue>> }>>;
  readonly codemode: { readonly enabled: boolean; readonly inlineBudget: number };
  readonly toolSearch: { readonly enabled: boolean };
  /** Names or patterns (`*` matches any run) of the tools offered without a search. */
  readonly offered: ReadonlyArray<string>;
}

/** cloudpid ADR-0027's merge: the override's switch over Global's, its settings over Global's key by key. */
const merge = (base: HarnessLayer, over: HarnessLayer | undefined): HarnessLayer => {
  if (over?.extensions === undefined) return base;
  const extensions = { ...base.extensions };
  for (const [id, choice] of Object.entries(over.extensions)) {
    const before = extensions[id];
    extensions[id] = {
      ...before,
      ...(choice.enabled === undefined ? {} : { enabled: choice.enabled }),
      settings: { ...before?.settings, ...choice.settings },
    };
  }
  return { extensions };
};

/** The settings for a Session of `projectId` (Global only when it has no override). */
export const resolveHarness = (stored: StoredHarness, scope: { readonly projectId?: string } = {}): ResolvedHarness => {
  const layer = merge(stored.global, scope.projectId === undefined ? undefined : stored.overrides[scope.projectId]);
  const extensions: Record<string, { enabled: boolean; settings: Record<string, SettingValue> }> = {};
  for (const entry of EXTENSIONS) {
    const choice = layer.extensions?.[entry.id];
    const settings: Record<string, SettingValue> = {};
    for (const [key, setting] of Object.entries(entry.settings)) settings[key] = choice?.settings?.[key] ?? setting.schema.default;
    const enabled = entry.default === "always" || entry.locked !== undefined ? true : (choice?.enabled ?? entry.default === "on");
    extensions[entry.id] = { enabled, settings };
  }
  const toolSearch = extensions["tool-search"]!.enabled;
  const preset = extensions["offered-tools"]!.settings.preset as OfferedPreset;
  return {
    revision: stored.revision,
    extensions,
    codemode: { enabled: extensions.codemode!.enabled, inlineBudget: extensions.codemode!.settings.inlineBudget as number },
    toolSearch: { enabled: toolSearch },
    offered: toolSearch ? [...(OFFERED_PRESETS[preset] ?? OFFERED_PRESETS.core)] : ["*"],
  };
};

/** Why `value` does not fit `schema`, or undefined. */
const invalid = (schema: FieldSchema, value: unknown): string | undefined => {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "true or false";
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "an integer";
      if (value < schema.minimum) return `at least ${schema.minimum}`;
      return value > schema.maximum ? `at most ${schema.maximum}` : undefined;
    case "enum":
      return typeof value === "string" && schema.values.includes(value) ? undefined : `one of ${schema.values.join(", ")}`;
  }
};

/** One change from the panel or a script: an extension's switch, or some of its settings. */
export interface HarnessChange {
  readonly extension: string;
  readonly enabled?: boolean;
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** `stored` with `change` applied to Global and the revision bumped, or why it is refused. */
export const applyChange = (
  stored: StoredHarness,
  change: HarnessChange,
): { readonly ok: true; readonly harness: StoredHarness } | { readonly ok: false; readonly error: string } => {
  const entry = entryOf(change.extension);
  if (entry === undefined) return { ok: false, error: `${change.extension}: no such extension` };
  if (entry.locked !== undefined) return { ok: false, error: `${entry.id}: locked (${entry.locked})` };
  if (change.enabled !== undefined && entry.default === "always") return { ok: false, error: `${entry.id}: cannot be turned off` };
  for (const [key, value] of Object.entries(change.settings ?? {})) {
    const setting = entry.settings[key];
    if (setting === undefined) return { ok: false, error: `${entry.id}.${key}: no such setting` };
    const why = invalid(setting.schema, value);
    if (why !== undefined) return { ok: false, error: `${entry.id}.${key}: ${why}` };
  }
  const before = stored.global.extensions?.[entry.id];
  const next = {
    ...before,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    settings: { ...before?.settings, ...(change.settings as Record<string, SettingValue> | undefined) },
  };
  return {
    ok: true,
    harness: { ...stored, revision: stored.revision + 1, global: { extensions: { ...stored.global.extensions, [entry.id]: next } } },
  };
};
export { CARD_TEXT_MAX, cardText, visible } from "./cardText.ts";
export { isDeniedT3Tool, T3_TOOL_DENYLIST } from "./t3Tools.ts";
export { descriptionFor, guidanceFor, toolLikeNamesIn } from "./t3Guidance.ts";
