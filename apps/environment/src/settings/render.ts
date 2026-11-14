// What an asked Settings change shows (plan D9, D10): the Open change's `shown`, built by the server from the stored
// settings before the change and the change as the registry will apply it, never from the agent's words. The card's text
// and the Change page are both rendered from it: this file renders the text (the card's prompt, and an Owner client's
// message `M`); `harness/changePage.ts` renders the page. No secret is ever in it: a header value is typed on the page and
// goes straight to the secret store, and a URL is shown without its query (plan D14).
import {
  applyEnvironmentChange,
  type EnvironmentKey,
  EXTENSIONS,
  type HarnessChange,
  mcpServersOf,
  ownEntry,
  resolveEnvironment,
  resolveHarness,
  settingOf,
  type StoredEnvironment,
  type StoredHarness,
  withoutQuery,
} from "@t3flare/harness-registry";
import type { McpTierChange } from "@t3flare/harness-registry";

/** One skill an install or update would keep, as previewed at its commit (plan D8, D10). */
export interface ShownSkill {
  readonly name: string;
  readonly description: string;
  /** Its folder in the repo (`""` for the repo's root). */
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  /** Its folder hash at the commit: the apply refuses another. */
  readonly digest: string;
  /** Its `SKILL.md` text, cut at `SKILL_MD_SHOWN` characters. */
  readonly skillMd: string;
  readonly skillMdCut?: true;
  /** Its files' paths in its folder, at most `PATHS_SHOWN`. */
  readonly paths: ReadonlyArray<string>;
  readonly morePaths?: number;
  /** Why it cannot be installed, as the preview tells: the apply refuses it. */
  readonly problems: ReadonlyArray<string>;
}

/** One thing a change moves, by kind (plan D10's table). */
export type ChangeItem =
  /** A scalar setting, a switch, an Exposure or a class: its name, before and after. */
  | { readonly kind: "scalar"; readonly name: string; readonly before: unknown; readonly after: unknown }
  /** The Variables: names added, changed and removed, with their values. */
  | {
      readonly kind: "variables";
      readonly name: string;
      readonly added: ReadonlyArray<readonly [string, string]>;
      readonly changed: ReadonlyArray<readonly [string, string, string]>;
      readonly removed: ReadonlyArray<readonly [string, string]>;
    }
  /** A `file` or multiline `text` setting: the whole text before and after (the renderer diffs it by line). */
  | { readonly kind: "text"; readonly name: string; readonly before: string; readonly after: string }
  | { readonly kind: "mcp-add"; readonly server: string; readonly url: string; readonly host: string; readonly auth: "none" | "header" | "oauth"; readonly header?: string }
  | { readonly kind: "mcp-remove"; readonly server: string; readonly url?: string }
  /** A header value for an existing header-auth Direct server: typed on the page. */
  | { readonly kind: "header-value"; readonly server: string; readonly header: string; readonly set: boolean }
  | { readonly kind: "sign-in"; readonly server: string; readonly url: string }
  | {
      readonly kind: "skills";
      readonly op: "install" | "update";
      readonly source: string;
      readonly repo: string;
      readonly ref: string | null;
      readonly commit: string;
      /** An update's kept commit. */
      readonly from?: string;
      readonly skills: ReadonlyArray<ShownSkill>;
    }
  | { readonly kind: "skill"; readonly op: "enable" | "disable" | "remove"; readonly name: string; readonly repo?: string; readonly commit?: string };

/** What an Open change's card and page render (plan D8's `shown`). */
export interface ChangeView {
  readonly entity: "harness" | "environment";
  /** What is changed, in words: "the Environment settings", "the MCP server set", "the Environment skills". */
  readonly subject: string;
  readonly revision: number;
  /** When it applies (plan D17). */
  readonly appliesAt: string;
  /** Why it is asked, from `tierOf`. */
  readonly reasons: ReadonlyArray<string>;
  readonly items: ReadonlyArray<ChangeItem>;
  /** Fixed lines: a Guard turned off, a new server's hint trust. */
  readonly lines: ReadonlyArray<string>;
}

export const SKILL_MD_SHOWN = 32 * 1024;
export const PATHS_SHOWN = 200;

/** The fixed line for a Guard turned off (plan D9), by extension; another Guard gets the generic line. */
const GUARD_OFF: Readonly<Record<string, string>> = { guardian: "This turns off the Guardian, which reviews risky tool calls." };

/** The fixed line for a new server (plan D9). */
export const HINT_TRUST_LINE = "Its tools' own read-only hints are trusted: a tool it marks read runs without a card.";

const asText = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value));

const textual = (schema: { readonly type: string; readonly multiline?: boolean }): boolean => schema.type === "file" || (schema.type === "text" && schema.multiline === true);

/** An extension change's items and lines, against the stored Harness settings it changes. */
export const extensionItems = (stored: StoredHarness, change: HarnessChange): { readonly items: Array<ChangeItem>; readonly lines: Array<string> } => {
  const entry = EXTENSIONS.find((each) => each.id === change.extension);
  const items: Array<ChangeItem> = [];
  const lines: Array<string> = [];
  if (entry === undefined) return { items, lines };
  const current = resolveHarness(stored).extensions[entry.id];
  if (change.enabled !== undefined && change.enabled !== current?.enabled) {
    items.push({ kind: "scalar", name: `${entry.id}: switch`, before: current?.enabled === true ? "on" : "off", after: change.enabled ? "on" : "off" });
    if (entry.guard === true && change.enabled === false) lines.push(GUARD_OFF[entry.id] ?? `This turns off ${entry.title}, a Guard.`);
  }
  for (const [key, after] of Object.entries(change.settings ?? {})) {
    const setting = Object.hasOwn(entry.settings, key) ? entry.settings[key] : undefined;
    const before = current?.settings[key];
    if (setting === undefined || before === after) continue;
    const name = `${entry.id}.${key}`;
    items.push(textual(setting.schema) ? { kind: "text", name, before: asText(before), after: asText(after) } : { kind: "scalar", name, before, after });
  }
  if (entry.guard === true && items.some((item) => item.kind !== "scalar" || item.name !== `${entry.id}: switch`)) lines.push(`This changes the settings of ${entry.title}, a Guard.`);
  return { items, lines };
};

/** An Environment change's items, against the stored Environment settings it changes. */
export const environmentItems = (stored: StoredEnvironment, settings: Readonly<Record<string, unknown>>): Array<ChangeItem> => {
  const applied = applyEnvironmentChange(stored, { settings });
  if (!applied.ok) return [];
  const before: Readonly<Record<string, unknown>> = resolveEnvironment(stored);
  const after: Readonly<Record<string, unknown>> = resolveEnvironment(applied.environment);
  return applied.changed.map((key: EnvironmentKey): ChangeItem => {
    const schema = settingOf(key).schema;
    if (schema.type === "variables") {
      const was = (before[key] ?? {}) as Readonly<Record<string, string>>;
      const now = (after[key] ?? {}) as Readonly<Record<string, string>>;
      return {
        kind: "variables",
        name: key,
        added: Object.entries(now).filter(([name]) => !Object.hasOwn(was, name)),
        changed: Object.entries(now)
          .filter(([name, value]) => Object.hasOwn(was, name) && was[name] !== value)
          .map(([name, value]) => [name, was[name]!, value] as const),
        removed: Object.entries(was).filter(([name]) => !Object.hasOwn(now, name)),
      };
    }
    if (textual(schema)) return { kind: "text", name: key, before: asText(before[key]), after: asText(after[key]) };
    return { kind: "scalar", name: key, before: before[key], after: after[key] };
  });
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * An MCP change's items and lines, against the stored Harness settings it changes. `secretSet` says whether a header
 * value is stored now (never the value).
 */
export const mcpItems = (stored: StoredHarness, change: McpTierChange, secretSet: (server: string) => boolean): { readonly items: Array<ChangeItem>; readonly lines: Array<string> } => {
  const servers = mcpServersOf(stored);
  const current = Object.hasOwn(servers, change.server) ? servers[change.server] : undefined;
  switch (change.op) {
    case "add": {
      const url = withoutQuery(change.url);
      return {
        items: [{ kind: "mcp-add", server: change.server, url, host: hostOf(change.url), auth: change.auth.kind, ...(change.auth.kind === "header" ? { header: change.auth.header } : {}) }],
        lines: [HINT_TRUST_LINE],
      };
    }
    case "remove":
      return { items: [{ kind: "mcp-remove", server: change.server, ...(current?.url === undefined ? {} : { url: withoutQuery(current.url) }) }], lines: [] };
    case "header-value":
      return { items: [{ kind: "header-value", server: change.server, header: current?.auth?.kind === "header" ? current.auth.header : "header", set: secretSet(change.server) }], lines: [] };
    case "sign-in":
      return { items: [{ kind: "sign-in", server: change.server, url: current?.url === undefined ? "" : withoutQuery(current.url) }], lines: [] };
    case "class":
      return { items: [{ kind: "scalar", name: `${change.server}/${change.tool}: class`, before: ownEntry(current?.classes, change.tool) ?? "its own hint", after: change.class ?? "its own hint" }], lines: [] };
    case "server": {
      const items: Array<ChangeItem> = [];
      if (current === undefined) return { items, lines: [] };
      if (change.enabled !== undefined && change.enabled !== current.enabled) items.push({ kind: "scalar", name: `${change.server}: switch`, before: current.enabled ? "on" : "off", after: change.enabled ? "on" : "off" });
      if (change.writes !== undefined && change.writes !== (current.writes ?? true)) {
        items.push({ kind: "scalar", name: `${change.server}: write tools`, before: (current.writes ?? true) ? "on" : "off", after: change.writes ? "on" : "off" });
      }
      if (change.exposure !== undefined && change.exposure !== current.exposure) items.push({ kind: "scalar", name: `${change.server}: Exposure`, before: current.exposure, after: change.exposure });
      for (const [tool, exposure] of Object.entries(change.toolExposure ?? {})) {
        const before = ownEntry(current.toolExposure, tool) ?? null;
        if (before === exposure) continue;
        items.push({ kind: "scalar", name: `${change.server}/${tool}: Exposure`, before: before ?? `the server's (${current.exposure})`, after: exposure ?? `the server's (${change.exposure ?? current.exposure})` });
      }
      return { items, lines: [] };
    }
  }
};

/** A skill's SKILL.md and paths as kept in `shown`: bounded so a record stays small. */
export const shownSkill = (skill: {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
  readonly digest: string;
  readonly problems: ReadonlyArray<string>;
  readonly skillMd?: string;
  readonly paths?: ReadonlyArray<string>;
}): ShownSkill => {
  const text = skill.skillMd ?? "";
  const paths = skill.paths ?? [];
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    files: skill.files,
    bytes: skill.bytes,
    digest: skill.digest,
    skillMd: text.slice(0, SKILL_MD_SHOWN),
    ...(text.length > SKILL_MD_SHOWN ? { skillMdCut: true as const } : {}),
    paths: paths.slice(0, PATHS_SHOWN),
    ...(paths.length > PATHS_SHOWN ? { morePaths: paths.length - PATHS_SHOWN } : {}),
    problems: skill.problems,
  };
};

/** One line of a line diff: kept (` `), removed (`-`) or added (`+`). */
export interface DiffLine {
  readonly op: " " | "-" | "+";
  readonly text: string;
}

/** Past this many lines on either side, a diff is the whole text removed and the whole text added. */
const DIFF_MAX_LINES = 2_000;

/** A line diff of `before` and `after` (a longest common subsequence of lines). */
export const lineDiff = (before: string, after: string): Array<DiffLine> => {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  // lengths[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const lines: Array<DiffLine> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: " ", text: a[i]! });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) lines.push({ op: "-", text: a[i++]! });
    else lines.push({ op: "+", text: b[j++]! });
  }
  while (i < a.length) lines.push({ op: "-", text: a[i++]! });
  while (j < b.length) lines.push({ op: "+", text: b[j++]! });
  return lines;
};

const shown = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : value === undefined ? "unset" : JSON.stringify(value));

const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`);

/** One item as text lines. */
const itemText = (item: ChangeItem): Array<string> => {
  switch (item.kind) {
    case "scalar":
      return [`- ${item.name}: ${shown(item.before)} to ${shown(item.after)}`];
    case "variables":
      return [
        `- ${item.name}:`,
        ...item.added.map(([name, value]) => `  added ${name}=${JSON.stringify(value)}`),
        ...item.changed.map(([name, before, after]) => `  changed ${name}: ${JSON.stringify(before)} to ${JSON.stringify(after)}`),
        ...item.removed.map(([name, value]) => `  removed ${name} (was ${JSON.stringify(value)})`),
      ];
    case "text": {
      const diff = lineDiff(item.before, item.after).filter((line) => line.op !== " ");
      return [`- ${item.name}: ${diff.filter((line) => line.op === "+").length} lines added, ${diff.filter((line) => line.op === "-").length} removed:`, ...diff.map((line) => `  ${line.op} ${line.text}`)];
    }
    case "mcp-add":
      return [
        `- Add the MCP server ${item.server} at ${item.url} (host ${item.host}), signing in ${item.auth === "header" ? `with the header ${item.header ?? ""}, whose value is typed on the Change page` : item.auth === "oauth" ? "with OAuth (started later, on the Change page)" : "with nothing"}.`,
      ];
    case "mcp-remove":
      return [`- Remove the MCP server ${item.server}${item.url === undefined ? "" : ` (${item.url})`}, with its stored secrets and sign-in.`];
    case "header-value":
      return [`- Set the value of ${item.server}'s header ${item.header} (one is ${item.set ? "set" : "not set"} now). The value is typed on the Change page.`];
    case "sign-in":
      return [`- Start an OAuth sign-in to ${item.server}${item.url === "" ? "" : ` at ${item.url}`}, in the owner's browser on the Change page.`];
    case "skills":
      return [
        item.op === "install"
          ? `- Install from ${item.source} at ${item.commit}${item.ref === null ? "" : ` (${item.ref})`}:`
          : `- Update ${item.skills[0]?.name ?? "a skill"} from ${item.repo} at ${item.from ?? "?"} to ${item.commit}:`,
        ...item.skills.map((skill) => `  ${skill.name} (${skill.path === "" ? "the repo's root" : skill.path}): ${skill.files} files, ${sizeOf(skill.bytes)}${skill.problems.length === 0 ? "" : `; cannot be installed: ${skill.problems.join("; ")}`}`),
      ];
    case "skill":
      return [`- ${item.op === "enable" ? "Enable" : item.op === "disable" ? "Disable" : "Remove"} the Environment skill ${item.name}${item.repo === undefined ? "" : ` (from ${item.repo}${item.commit === undefined ? "" : ` at ${item.commit.slice(0, 7)}`})`}.`];
  }
};

/**
 * The change in words (plan D12's `M`, and the head of the card's prompt): what changes, at which revision, why it
 * waits for the owner, the fixed lines, and when it applies. Written by the server alone.
 */
export const changeText = (view: ChangeView): string =>
  [
    `A change to ${view.subject} (revision ${view.revision}):`,
    ...view.items.flatMap(itemText),
    "",
    "It waits for the owner because:",
    ...view.reasons.map((reason) => `- ${reason}`),
    ...(view.lines.length === 0 ? [] : ["", ...view.lines]),
    "",
    view.appliesAt,
  ].join("\n");
