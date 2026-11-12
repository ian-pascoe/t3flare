// The harness registry (ADR-0026): every Pi Durable extension the harness panel shows, with its switch and its settings
// schema, and how the stored settings resolve for a Session. Imported by the Environment Worker (the panel and its API
// validate against it) and the agents Worker (the Session builds its registry from the resolved view). Later ports
// (pi-parity: web, todo, context, guardian…) add an entry here and appear in the panel without panel work.
//
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
  core: ["read", "edit", "write", "bash", "ls", "find", "grep", "ask_user", "codemode", "tool_search", "mcp__t3-code__*"],
  /** A: code mode and tool search; every other tool through a script or a search. */
  "codemode-only": ["codemode", "tool_search"],
  /** C: everything direct. */
  everything: ["*"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type OfferedPreset = keyof typeof OFFERED_PRESETS;

const CORE_LOCK = "a core extension: always on";

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

/** One scope's stored choices: per extension, its switch and the settings set explicitly. */
export interface HarnessLayer {
  readonly extensions?: Readonly<Record<string, { readonly enabled?: boolean; readonly settings?: Readonly<Record<string, SettingValue>> }>>;
}

/** What the Environment DO stores (`t3flare:harness:settings`). */
export interface StoredHarness {
  /** Bumped by every change; a Session reinstalls what changed when it sees a new one. */
  readonly revision: number;
  readonly global: HarnessLayer;
  /** Per-Project overrides, by project id: the later seam (empty now). */
  readonly overrides: Readonly<Record<string, HarnessLayer>>;
}

export const EMPTY_HARNESS: StoredHarness = { revision: 0, global: {}, overrides: {} };

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
