// @effect-diagnostics globalDate:off
// The Settings page (ADR-0026): server-rendered HTML, no framework, no third-party script or font. Every string
// that is not a literal here is HTML-escaped (review H4: tool names, descriptions, errors and settings may be hostile).
// The one script (pageScript.ts) and the one stylesheet (pageStyle.ts) are constants, allowed by their SHA-256 hashes in
// the CSP, never by `'self'`; the icons are an inline SVG sprite (pageIcons.ts). The script only turns the controls into
// JSON API calls with the CSRF token from the page's meta tag.
//
// Layout (SPI-1086), after T3 Code's settings: a quiet sidebar of sections (a sticky row of tabs on a phone), then each
// section as a 16px title over grouped, divided rows.
import {
  EMPTY_ENVIRONMENT,
  ENVIRONMENT_SETTINGS,
  type EnvironmentSettingEntry,
  type ExtensionEntry,
  EXTENSIONS,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  type ResolvedEnvironment,
  type ResolvedHarness,
  ownEntry,
  resolveEnvironment,
  visible,
} from "@t3flare/harness-registry";

import { type ContainerCostTable, containerCostTable } from "./containerCost.ts";
import { CHANGE_TTL_MS, durationText, OWNER_MODES, type OwnerMode } from "../settings/changes.ts";
import type { OwnerClientEntry } from "../settings/clients.ts";
import type { PageReason } from "../settings/types.ts";
import { type AskedBy, askedByText, sizeText } from "../settings/render.ts";
import type { AuditEntry } from "./store.ts";

import { brand, FAVICON } from "./pageBrand.ts";
import { ICON_SPRITE, icon, type IconName } from "./pageIcons.ts";
import { changePagePath } from "./paths.ts";
import { SCRIPT } from "./pageScript.ts";
import { endpointsSection, type EndpointsView } from "./pageEndpoints.ts";
import { STYLE } from "./pageStyle.ts";

/** `text` safe in HTML, with every control and format character shown as `\u{…}` (a hostile value is inert). */
export const visibleHtml = (text: string): string => escapeHtml(visible(text));

/** `text` safe in HTML text and in a double-quoted attribute. */
export const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const sha256 = async (text: string): Promise<string> =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));

const hashes = new Map<string, Promise<{ readonly style: string; readonly script: string }>>();

/**
 * A page's Content-Security-Policy: nothing but the one constant stylesheet and its own constant script (the panel's,
 * or the Change page's), calls to its own origin, and `data:` images (the favicon, pageBrand.ts).
 */
export const pageCsp = async (pageScript: string = SCRIPT): Promise<string> => {
  let pending = hashes.get(pageScript);
  if (pending === undefined) hashes.set(pageScript, (pending = Promise.all([sha256(STYLE), sha256(pageScript)]).then(([style, script]) => ({ style, script }))));
  const { style, script } = await pending;
  return [
    "default-src 'none'",
    `style-src 'sha256-${style}'`,
    `script-src 'sha256-${script}'`,
    "connect-src 'self'",
    "img-src data:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
};

/**
 * A UTC time the script rewrites into the reader's own zone; readable as is without it. The panel's and the Change
 * page's.
 */
export const time = (at: number): string => {
  const iso = new Date(at).toISOString();
  return `<time datetime="${iso}" data-local>${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC</time>`;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// ── Extensions ──────────────────────────────────────────────────────────────────────────────────────────────────

const field = (extension: string, key: string, setting: EnvironmentSettingEntry, value: unknown, locked = false): string => {
  const id = escapeHtml(`${extension}-${key}`);
  const hint = `<p class="hint" id="${id}-hint">${escapeHtml(setting.description)}</p>`;
  const attrs = `id="${id}" data-setting="${escapeHtml(key)}" data-kind="${setting.schema.type}" aria-describedby="${id}-hint"${locked ? " disabled" : ""}`;
  switch (setting.schema.type) {
    case "boolean":
      return `<div class="field"><div class="inline-field"><input type="checkbox" ${attrs}${value === true ? " checked" : ""}><label for="${id}">${escapeHtml(setting.title)}</label></div>${hint}</div>`;
    case "integer":
      return `<div class="field"><label for="${id}">${escapeHtml(setting.title)}</label><input type="number" inputmode="numeric" required ${attrs} min="${setting.schema.minimum}" max="${setting.schema.maximum}" step="1" value="${escapeHtml(String(value))}">${hint}</div>`;
    case "enum":
      return `<div class="field"><label for="${id}">${escapeHtml(setting.title)}</label><select ${attrs}>${setting.schema.values
        .map((option) => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(option)}</option>`)
        .join("")}</select>${hint}</div>`;
    case "text":
      return setting.schema.multiline === true
        ? `<div class="field"><label for="${id}">${escapeHtml(setting.title)}</label><textarea rows="4" maxlength="${setting.schema.maxLength}" ${attrs}>${escapeHtml(typeof value === "string" ? value : "")}</textarea>${hint}</div>`
        : `<div class="field"><label for="${id}">${escapeHtml(setting.title)}</label><input type="text" maxlength="${setting.schema.maxLength}" ${attrs} value="${escapeHtml(typeof value === "string" ? value : "")}">${hint}</div>`;
    case "variables": {
      // One row per Variable; the script adds rows from the template, removes them, and posts `{ NAME: "value" }`.
      const rows = Object.entries(value !== null && typeof value === "object" ? (value as Readonly<Record<string, string>>) : {}).map(([name, text]) => variableRow(name, text));
      return `<fieldset class="field" ${attrs}><legend class="sr">${escapeHtml(setting.title)}</legend><div class="variables" data-variable-rows>${rows.join("")}</div><template data-variable-template>${variableRow("", "")}</template><div><button type="button" class="btn btn-sm" data-variable-add>${icon("plus")}Add a Variable</button></div>${hint}</fieldset>`;
    }
    case "file":
      // No maxlength (it counts UTF-16 units; the API's byte limit refuses, whole). The newline after the tag is the one
      // an HTML parser drops, so a text that starts with one round-trips and an unrelated save changes nothing.
      return `<div class="field"><label for="${id}">${escapeHtml(setting.title)}</label><textarea class="file" rows="12" spellcheck="false" autocapitalize="none" autocomplete="off" ${attrs}>\n${escapeHtml(typeof value === "string" ? value : "")}</textarea>${hint}</div>`;
  }
};

/** One Variable's row: its name, its value (a text area, so a value with a line break survives a save), and Remove. */
const variableRow = (name: string, value: string): string =>
  `<div class="variable" data-variable><input type="text" data-variable-name aria-label="Name" value="${escapeHtml(name)}" maxlength="${MAX_VARIABLE_NAME_LENGTH}" placeholder="NAME" autocapitalize="none" spellcheck="false"><textarea rows="1" data-variable-value aria-label="Value" maxlength="${MAX_VARIABLE_VALUE_LENGTH}" placeholder="value" spellcheck="false">${escapeHtml(value)}</textarea><button type="button" class="btn btn-sm btn-danger" data-variable-remove aria-label="Remove this Variable">${icon("trash")}</button></div>`;

/** A locked extension's settings, shown and not editable. */
const lockedSettings = (entry: ExtensionEntry, current: ResolvedHarness["extensions"][string] | undefined): string => {
  const fields = Object.entries(entry.settings).map(([key, setting]) => field(entry.id, key, setting, current?.settings[key], true));
  return fields.length === 0 ? "" : `<div class="row-extra"><div class="fields">${fields.join("")}</div></div>`;
};

const extensionRow = (resolved: ResolvedHarness, entry: ExtensionEntry): string => {
  const current = resolved.extensions[entry.id];
  const titleId = escapeHtml(`ext-${entry.id}-title`);
  const head = `<div><div class="row-title"><h3 id="${titleId}">${escapeHtml(entry.title)}</h3><span class="ident">${escapeHtml(entry.id)}</span></div>
<p class="desc">${escapeHtml(entry.description)}</p></div>`;
  if (entry.locked !== undefined) {
    return `<div class="row"><div><div class="row-title"><h3>${escapeHtml(entry.title)}</h3><span class="ident">${escapeHtml(entry.id)}</span></div>
<p class="desc">${escapeHtml(entry.description)}</p></div><div class="row-control"><span class="state" title="Locked: ${escapeHtml(entry.locked)}">${icon("lock")}Always on<span class="sr">, locked: ${escapeHtml(entry.locked)}</span></span></div>${lockedSettings(entry, current)}</div>`;
  }
  const control =
    entry.default === "always"
      ? `<span class="state">${icon("check")}Always on</span>`
      : `<input type="checkbox" class="switch" role="switch" data-enabled aria-labelledby="${titleId}"${current?.enabled === true ? " checked" : ""}>`;
  const settings = Object.entries(entry.settings).map(([key, setting]) => field(entry.id, key, setting, current?.settings[key]));
  const extra =
    settings.length === 0
      ? ""
      : `<div class="row-extra"><div class="fields">${settings.join("")}</div><div class="save"><span class="save-note" data-save-note aria-live="polite"></span><button type="submit" class="btn btn-sm" data-save disabled>Save</button></div></div>`;
  return `<form class="row" data-extension="${escapeHtml(entry.id)}" aria-labelledby="${titleId}" novalidate>${head}<div class="row-control">${control}</div>${extra}</form>`;
};

const extensionsSection = (resolved: ResolvedHarness): string => {
  const adjustable = EXTENSIONS.filter((entry) => entry.locked === undefined);
  const core = EXTENSIONS.filter((entry) => entry.locked !== undefined);
  return `<section id="extensions" aria-labelledby="extensions-title">
<div class="section-head"><h2 id="extensions-title">${icon("extensions")}Extensions</h2></div>
<p class="section-desc">What Pi Durable's harness offers the model. A switch saves at once; a setting saves with its Save button.</p>
<div class="group">${adjustable.map((entry) => extensionRow(resolved, entry)).join("\n")}</div>
<h3 class="sub-head">Core, always on</h3>
<div class="group core">${core.map((entry) => extensionRow(resolved, entry)).join("\n")}</div>
</section>`;
};

// ── Environment ──────────────────────────────────────────────────────────────────────────────────────────────────

const dollars = (amount: number, digits: number) => `$${amount.toFixed(digits)}`;

const gib = (mib: number) => `${mib / 1024} GiB`;

const containers = (count: number) => `${count} ${count === 1 ? "Container" : "Containers"}`;

/** The worst case for the settings as they stand; the page's script rewrites it as the size or budget inputs change. */
const costNow = (costs: ContainerCostTable, size: string): string => {
  const row = costs.rows.find((entry) => entry.size === size);
  return row === undefined ? "" : `With these settings, at most ${dollars(row.budgetHour, 2)} an hour: ${containers(costs.budget)} of ${row.size}, every vCPU busy.`;
};

/**
 * Each size's resources and worst-case hour, one Container and the budget's. Each row carries its one-Container hour, so
 * the page's script recomputes the budget column, the current row and the summary as the inputs change.
 */
const costTable = (costs: ContainerCostTable, size: string): string => {
  const rows = costs.rows
    .map(
      (row) =>
        `<tr data-size="${escapeHtml(row.size)}" data-per-hour="${Number(row.perContainerHour.toFixed(6))}"${row.size === size ? ' aria-current="true"' : ""}><td data-label="Size"><div><code>${escapeHtml(row.size)}</code>${row.default ? ' <span class="tag">default</span>' : ""}</div></td><td data-label="vCPU"><div>${row.resources.vcpu}</div></td><td data-label="Memory"><div>${gib(row.resources.memoryMib)}</div></td><td data-label="Disk"><div>${row.resources.diskMb / 1000} GB</div></td><td data-label="One Container, an hour"><div>${dollars(row.perContainerHour, 3)}</div></td><td data-label="${containers(costs.budget)}, an hour" data-budget-cell><div data-budget-hour>${dollars(row.budgetHour, 2)}</div></td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="stacked"><thead><tr><th scope="col">Size</th><th scope="col">vCPU</th><th scope="col">Memory</th><th scope="col">Disk</th><th scope="col">One Container, an hour</th><th scope="col" data-budget-head>${containers(costs.budget)}, an hour</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

/**
 * The Environment settings (ADR-0032): one form rendered from their schema, the running Containers, and each size's cost.
 * A later setting (SPI-1150, SPI-1152) is a schema entry, rendered here without page work.
 */
const environmentSection = (environment: ResolvedEnvironment, costs: ContainerCostTable, running: PageInput["running"]): string => {
  const values: Readonly<Record<string, unknown>> = { ...environment };
  const entries = Object.entries(ENVIRONMENT_SETTINGS as Readonly<Record<string, EnvironmentSettingEntry>>);
  // The scalar settings share the Containers row; a list (the Variables) and a file (the Global mise config) each get a
  // row of their own. One form, one Save.
  const ownRow = (setting: EnvironmentSettingEntry) => setting.schema.type === "variables" || setting.schema.type === "file";
  const fields = entries.filter(([, setting]) => !ownRow(setting)).map(([key, setting]) => field("environment", key, setting, values[key]));
  const lists = entries
    .filter(([, setting]) => ownRow(setting))
    .map(([key, setting]) => `<div class="row"><div class="row-title"><h3>${escapeHtml(setting.title)}</h3></div><div class="row-extra"><div class="fields list">${field("environment", key, setting, values[key])}</div></div></div>`);
  const save = `<div class="row"><div class="save"><span class="save-note" data-save-note aria-live="polite"></span><button type="submit" class="btn btn-sm" data-save disabled>Save</button></div></div>`;
  return `<section id="environment" aria-labelledby="environment-title">
<div class="section-head"><h2 id="environment-title">${icon("container")}Environment</h2></div>
<p class="section-desc">What every Workspace's Container gets. A change applies at each Workspace's next Container start; a running Container keeps its size, idle time, Variables and Global mise config, and a lower budget stops none.</p>
<form class="group" data-environment aria-labelledby="environment-title" novalidate><div class="row"><div><div class="row-title"><h3>Containers</h3><span class="ident">revision ${environment.revision}</span></div><p class="desc">Their size, how long one may sit idle, and how many may run at once.</p></div>
<div class="row-extra"><div class="fields">${fields.join("")}</div></div></div>${lists.join("")}${save}</form>
<dl class="group kv"><div><dt>Running now</dt><dd>${
    running === null || running === undefined
      ? "unknown"
      : `${running.count} of ${environment.containerBudget}${running.holders.length === 0 ? "" : `: ${running.holders.map((holder) => `<code>${escapeHtml(holder)}</code>`).join(", ")}`}`
  }</dd></div></dl>
<h3 class="sub-head">Cost at worst</h3>
<p class="section-desc">Cloudflare's Workers Paid list prices, every vCPU busy the whole hour. Memory and disk are billed while a Container runs, CPU only while it works, so a real hour costs less.</p>
<p class="section-desc" data-cost-now aria-live="polite">${escapeHtml(costNow(costs, environment.containerSize))}</p>
<div class="group">${costTable(costs, environment.containerSize)}</div>
</section>`;
};

// ── MCP servers ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One server of the panel's MCP section (panel.ts `mcpOverview`). */
export interface McpRow {
  readonly name: string;
  readonly setting: {
    readonly kind: string;
    readonly enabled: boolean;
    readonly exposure: string;
    readonly url?: string;
    readonly auth?: { readonly kind: string; readonly header?: string };
    /** The Settings server's writes switch (plan D2). */
    readonly writes?: boolean;
  };
  readonly oauth?: { readonly signedIn: boolean };
  /** A header sign-in's value: whether it is set, when, and its fingerprint (never the value). */
  readonly secret?: { readonly set: boolean; readonly setAt: number | null; readonly fingerprint: string | null };
  readonly status: string;
  readonly listedAt: number | null;
  readonly error: string | null;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly upstream: string; readonly class: string; readonly hinted: string; readonly exposure: string }>;
  /** The owner's overrides, by upstream name. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** The owner's per-tool Exposure, by upstream name; a tool without one follows its server's. */
  readonly toolExposure?: Readonly<Record<string, string>>;
  readonly refused: ReadonlyArray<{ readonly tool: string; readonly reason: string }>;
}

const action = (label: string, change: unknown, options: { readonly className?: string; readonly ariaLabel?: string; readonly icon?: IconName } = {}) =>
  `<button type="button" class="btn ${options.className ?? "btn-sm"}" data-mcp="${escapeHtml(JSON.stringify(change))}"${
    options.ariaLabel === undefined ? "" : ` aria-label="${escapeHtml(options.ariaLabel)}"`
  }>${options.icon === undefined ? "" : icon(options.icon)}${escapeHtml(label)}</button>`;

const EXPOSURES = ["direct", "deferred", "codemode", "hidden"] as const;

/**
 * A select that saves an Exposure through the panel's JSON API (pageScript.ts). A server's carries its name; a tool's
 * also its upstream name and an empty option that returns it to the server's Exposure. A value outside the four (never
 * written by the API) is still shown, so the select never claims another.
 */
const exposureSelect = (row: McpRow, current: string, tool?: string): string => {
  const options: Array<readonly [string, string]> = [
    ...(tool === undefined ? [] : [["", `Server's (${row.setting.exposure})`] as const]),
    ...EXPOSURES.map((value) => [value, value] as const),
    ...(current === "" || (EXPOSURES as ReadonlyArray<string>).includes(current) ? [] : [[current, current] as const]),
  ];
  const label = tool === undefined ? `${row.name} exposure` : `${tool} exposure`;
  return `<select class="sel-sm" data-mcp-exposure="${escapeHtml(row.name)}"${tool === undefined ? "" : ` data-tool="${escapeHtml(tool)}"`} aria-label="${escapeHtml(label)}">${options
    .map(([value, text]) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(text)}</option>`)
    .join("")}</select>`;
};

/** The server's state as one pill: off, listed, failing, or not listed yet. */
const statusPill = (row: McpRow): string => {
  if (!row.setting.enabled) return '<span class="pill">Disabled</span>';
  if (row.setting.kind === "settings") return row.setting.writes === false ? '<span class="pill pill-ok">Read-only</span>' : '<span class="pill pill-ok">Read-write</span>';
  if (row.status === "ok") return '<span class="pill pill-ok">Connected</span>';
  if (row.status === "failed") return '<span class="pill pill-err">Error</span>';
  if (row.status === "never") return '<span class="pill">Not listed yet</span>';
  return `<span class="pill">${escapeHtml(row.status)}</span>`;
};

const signIn = (row: McpRow): string | undefined => {
  const auth = row.setting.auth;
  if (auth === undefined) return undefined;
  if (auth.kind === "none") return "None";
  if (auth.kind === "oauth") return row.oauth?.signedIn === true ? '<span class="pill pill-ok">OAuth, signed in</span>' : '<span class="pill pill-warn">OAuth, signed out</span>';
  if (auth.kind === "header") {
    const name = `<code>${escapeHtml(auth.header ?? "header")}</code>`;
    if (row.secret === undefined) return `Header ${name}`;
    return row.secret.set
      ? `Header ${name}, set${row.secret.fingerprint === null ? "" : ` <span class="ident" title="Fingerprint: an HMAC of the value, never the value">#${escapeHtml(row.secret.fingerprint)}</span>`}`
      : `Header ${name}, <span class="pill pill-warn">no value</span>`;
  }
  return escapeHtml(auth.kind);
};

const toolsTable = (row: McpRow): string => {
  if (row.tools.length === 0) {
    const why = row.status === "never" ? "Not listed yet: Test lists its tools." : row.status === "failed" ? "No tools: the last listing failed." : "This server offers no tools.";
    return `<p class="empty-tools">${why}</p>`;
  }
  const reads = row.tools.filter((tool) => tool.class === "read").length;
  const rows = row.tools
    .map((tool) => {
      const other = tool.class === "read" ? "write" : "read";
      const overridden = ownEntry(row.overrides, tool.upstream) !== undefined;
      const source = overridden ? `Set by you; its hint says ${escapeHtml(tool.hinted)}` : "The tool's own hint";
      // The Settings server's classes are fixed (plan D2): no class buttons.
      const change =
        row.setting.kind === "settings"
          ? ""
          : `${action(`Mark ${other}`, { op: "class", server: row.name, tool: tool.upstream, class: other }, { ariaLabel: `Mark ${tool.upstream} as ${other}` })}${
              overridden ? ` ${action("Use its hint", { op: "class", server: row.name, tool: tool.upstream, class: null }, { className: "btn-sm btn-ghost", ariaLabel: `Use ${tool.upstream}'s own hint` })}` : ""
            }`;
      return `<tr><td class="tool" data-label="Tool"><code>${escapeHtml(tool.upstream)}</code></td><td class="cls" data-label="Class"><div><span class="tag tag-${tool.class === "read" ? "read" : "write"}">${escapeHtml(tool.class)}</span><span class="src">${row.setting.kind === "settings" ? "Fixed" : source}</span></div></td><td class="exp" data-label="Exposure"><div>${exposureSelect(row, ownEntry(row.toolExposure, tool.upstream) ?? "", tool.upstream)}</div></td><td class="actions" data-label="Change"><div>${change}</div></td></tr>`;
    })
    .join("");
  return `<details class="tools"${row.tools.length <= 12 ? " open" : ""}><summary>${icon("chevron")}Tools <span>${plural(row.tools.length, "tool", "tools")}: ${reads} read, ${row.tools.length - reads} write</span></summary>
<div class="table-wrap"><table class="stacked tools-table"><thead><tr><th scope="col">Tool</th><th scope="col">Class</th><th scope="col">Exposure</th><th scope="col"><span class="sr">Change</span></th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
};

/** The Settings server's tag on its card; a Direct server, the owner's own, has none (SPI-1160). */
const kindTag = (kind: string): string => (kind === "settings" ? `<span class="tag">Settings server</span>` : "");

/**
 * The Settings server's access switch (plan D2): one three-way control, off, read-only and read-write, for both doors.
 * Three buttons through the panel's JSON API, the current one pressed.
 */
const settingsAccess = (row: McpRow): string => {
  const current = !row.setting.enabled ? "off" : row.setting.writes === false ? "read" : "write";
  const choices = [
    ["off", "Off", { op: "server", server: row.name, enabled: false }],
    ["read", "Read-only", { op: "server", server: row.name, enabled: true, writes: false }],
    ["write", "Read-write", { op: "server", server: row.name, enabled: true, writes: true }],
  ] as const;
  return `<div class="server-access" role="group" aria-label="${escapeHtml(row.name)} access">${choices
    .map(
      ([value, label, change]) =>
        `<button type="button" class="btn btn-sm${value === current ? " btn-primary" : ""}" aria-pressed="${value === current}" data-mcp="${escapeHtml(JSON.stringify(change))}">${label}</button>`,
    )
    .join("")}</div>`;
};

/** The Owner clients as the Settings server's card shows them (ADR-0035's 2026-11-15 refinement). */
export interface OwnerClientsView {
  /** The Owner-client endpoint's URL, when it is deployed. */
  readonly endpoint?: string;
  readonly clients: ReadonlyArray<OwnerClientEntry>;
  /** The panel's own Access `sub` (empty for the service token): its clients read as "you". */
  readonly viewer: string;
}

/** What each Elicitation mode means for the owner (plan D12), beside the mode select. */
const MODE_MEANINGS: Readonly<Record<OwnerMode, string>> = {
  browser: "the client sends you to the Change page (a link it opens, or one in its answer); you approve there. Works with every client.",
  native: "the client shows its own Accept / Decline form, and Accept applies the change. A client that declares no form gets the page instead.",
  model: "the client's agent gets a requestId, asks you in the chat and answers with resume. Only for a client whose agent you trust to relay your answer.",
};

/** Who a client's key names: you, the stage's service token, or another Access identity. */
const keyText = (key: string, viewer: string): string => (key === "service-token" ? "the service token" : key === viewer ? "you" : `Access identity ${key}`);

/**
 * The Owner clients on the Settings server's card: how to add one (the plain endpoint URL), and each client seen, with
 * its mode (set here alone; it applies at the client's next request) and Remove. Names are the clients' own labels.
 */
const ownerClientsBlock = (view: OwnerClientsView): string => {
  const add =
    view.endpoint === undefined
      ? `<p class="empty-tools">The Owner-client endpoint is not deployed on this Environment.</p>`
      : `<p class="desc">To add an Owner client (Claude Code, pi, Cursor, Codex, OpenCode), give it <code>${escapeHtml(view.endpoint)}</code> as a remote MCP server over streamable HTTP and sign in with Access when it asks. Use the URL as it is: no query. The client appears here at its first request, in browser; pick its mode below.</p>`;
  const meanings = `<ul class="desc">${OWNER_MODES.map((mode) => `<li><strong>${mode}</strong>: ${escapeHtml(MODE_MEANINGS[mode])}</li>`).join("")}</ul>
<p class="desc">A mode applies from the client's next request; a change it already asked keeps the mode it was asked in. The client must reconnect after a change to or from <strong>model</strong>: it learns of <code>resume</code> once, when it connects. A change that needs a secret, a sign-in or a skills install is approved on its page in every mode. <code>?elicitation_mode=</code> on the URL still overrides this, for clients that keep a query.</p>`;
  // No endpoint and no client kept: nothing to add and nothing to explain, so the "not deployed" line alone.
  if (view.endpoint === undefined && view.clients.length === 0) return `<details class="tools" open data-owner-clients><summary>${icon("chevron")}Owner clients <span>${plural(0, "client", "clients")}</span></summary>\n${add}</details>`;
  const rows = view.clients
    .map((client) => {
      const attrs = `data-client-key="${escapeHtml(client.key)}" data-client-name="${escapeHtml(client.clientName)}"`;
      const label = `${client.clientName} mode`;
      const select = `<select class="sel-sm" data-client-mode ${attrs} aria-label="${visibleHtml(label)}">${OWNER_MODES.map((mode) => `<option value="${mode}"${mode === client.mode ? " selected" : ""}>${mode}</option>`).join("")}</select>`;
      return `<tr><td class="tool" data-label="Client"><code>${visibleHtml(client.clientName)}</code> <span class="src">unverified label</span></td><td data-label="Who"><div>${escapeHtml(keyText(client.key, view.viewer))}</div></td><td data-label="Last seen"><div>${time(client.lastSeen)}</div></td><td class="exp" data-label="Mode"><div>${select}</div></td><td class="actions" data-label="Remove"><div><button type="button" class="btn btn-sm btn-danger" data-client-remove ${attrs} aria-label="${visibleHtml(`Remove ${client.clientName}`)}">${icon("trash")}Remove</button></div></td></tr>`;
    })
    .join("");
  const table =
    view.clients.length === 0
      ? `<p class="empty-tools">No Owner client has called yet.</p>`
      : `<div class="table-wrap"><table class="stacked tools-table"><thead><tr><th scope="col">Client</th><th scope="col">Who</th><th scope="col">Last seen</th><th scope="col">Mode</th><th scope="col"><span class="sr">Remove</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<details class="tools" open data-owner-clients><summary>${icon("chevron")}Owner clients <span>${plural(view.clients.length, "client", "clients")}</span></summary>
${add}${meanings}${table}</details>`;
};

const serverCard = (row: McpRow, owner?: OwnerClientsView): string => {
  const id = escapeHtml(`srv-${row.name}`);
  const name = escapeHtml(row.name);
  const facts = [
    ["Tools", row.status === "never" ? "—" : String(row.tools.length)],
    ["Listed", row.listedAt === null ? "Never" : time(row.listedAt)],
    ...(signIn(row) === undefined ? [] : [["Sign-in", signIn(row)!]]),
  ]
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
    .join("");
  const error =
    row.error === null
      ? ""
      : `<div class="callout" role="note">${icon("alert")}<div><strong>Last error</strong><p class="mono">${escapeHtml(row.error)}</p></div></div>`;
  const refused =
    row.refused.length === 0
      ? ""
      : `<div class="callout callout-warn" role="note">${icon("warn")}<div><strong>${plural(row.refused.length, "tool", "tools")} refused</strong><ul>${row.refused
          .map((r) => `<li><code>${escapeHtml(r.tool)}</code>: ${escapeHtml(r.reason)}</li>`)
          .join("")}</ul></div></div>`;
  const oauth =
    row.setting.auth?.kind === "oauth"
      ? `<button type="button" class="btn btn-sm${row.oauth?.signedIn === true ? "" : " btn-primary"}" data-mcp-oauth="${name}">${icon("login")}${row.oauth?.signedIn === true ? "Sign in again" : "Sign in"}</button>`
      : "";
  const remove =
    row.setting.kind === "settings" ? "" : action("Remove", { op: "remove", server: row.name }, { className: "btn-sm btn-danger", ariaLabel: `Remove ${row.name}`, icon: "trash" });
  return `<article class="group server" aria-labelledby="${id}">
<div class="server-head"><div><div class="server-name"><h3 id="${id}">${name}</h3>${kindTag(row.setting.kind)}${statusPill(row)}</div>${
    row.setting.url === undefined ? "" : `<p class="server-url">${escapeHtml(row.setting.url)}</p>`
  }${row.setting.kind === "settings" ? `<p class="server-url">t3flare's own settings, for agents: reads, and changes that wait for you when they widen what agents have.</p>` : ""}</div>
${
  row.setting.kind === "settings"
    ? settingsAccess(row)
    : `<button type="button" class="switch" role="switch" aria-checked="${row.setting.enabled === true}" aria-label="${name} enabled" data-mcp="${escapeHtml(JSON.stringify({ op: "server", server: row.name, enabled: !row.setting.enabled }))}"></button>`
}
<dl class="facts">${facts}</dl></div>${error}${refused}
<div class="server-actions">${row.setting.kind === "settings" ? "" : `<button type="button" class="btn btn-sm" data-mcp-test="${name}">${icon("play")}Test</button>`}${oauth}<label class="exposure">Exposure ${exposureSelect(row, row.setting.exposure)}</label><p class="test-result" data-test-result="${name}" role="status" aria-live="polite"></p><span class="spacer"></span>${remove}</div>
${toolsTable(row)}${row.setting.kind === "settings" && owner !== undefined ? ownerClientsBlock(owner) : ""}</article>`;
};

/**
 * The form that adds a direct server (Route B). Each tool's class is its own `readOnlyHint` until the owner overrides it
 * (owner, 2026-11-12, back to stock); an OAuth server is signed in with its Sign in button once added. A header value
 * goes to the write-only secret store.
 */
const ADD_SERVER = `<form class="group add" id="add-server" data-mcp-add autocomplete="off" aria-labelledby="add-title">
<div class="row"><div><div class="row-title"><h3 id="add-title">Add a server</h3></div><p class="desc">A remote MCP server over streamable HTTP. Each tool's class is its own read-only hint until you change it; write tools follow the thread's mode.</p></div></div>
<div class="form-body">
<div class="field"><label for="add-server-name">Name</label><input id="add-server-name" name="server" type="text" required pattern="[a-z0-9\\-]{1,20}" placeholder="executor" autocapitalize="none" spellcheck="false" aria-describedby="add-server-name-hint"><p class="hint" id="add-server-name-hint">1–20 of a–z, 0–9 and -. Tools are named mcp__name__tool.</p></div>
<div class="field"><label for="add-server-url">URL</label><input id="add-server-url" name="url" type="url" required placeholder="https://mcp.example.com/mcp" autocapitalize="none" spellcheck="false" aria-describedby="add-server-url-hint"><p class="hint" id="add-server-url-hint">https only, on a public host name.</p></div>
<fieldset class="wide"><legend>Sign-in</legend><div class="choices">
<label class="choice"><input type="radio" name="auth" value="oauth" checked><div><strong>OAuth</strong><span>Sign in after adding</span></div></label>
<label class="choice"><input type="radio" name="auth" value="header"><div><strong>Header</strong><span>A token sent with each call</span></div></label>
<label class="choice"><input type="radio" name="auth" value="none"><div><strong>None</strong><span>A public server</span></div></label>
</div></fieldset>
<div class="wide pair" data-header-fields hidden>
<div class="field"><label for="add-server-header">Header name</label><input id="add-server-header" name="header" type="text" value="Authorization" pattern="[A-Za-z0-9\\-]{1,64}" autocapitalize="none" spellcheck="false"></div>
<div class="field"><label for="add-server-value">Header value</label><input id="add-server-value" name="value" type="password" autocomplete="new-password" aria-describedby="add-server-value-hint"><p class="hint" id="add-server-value-hint">Stored write-only: never shown again, only its fingerprint.</p></div>
</div></div>
<div class="form-foot"><p>${icon("key")}Secrets go to the Environment's secret store.</p><button type="submit" class="btn btn-primary">${icon("plus")}Add server</button></div>
</form>`;

const mcpSection = (rows: ReadonlyArray<McpRow>, owner?: OwnerClientsView): string => `<section id="mcp" aria-labelledby="mcp-title">
<div class="section-head"><h2 id="mcp-title">${icon("server")}MCP servers</h2><a class="btn btn-sm" href="#add-server">${icon("plus")}Add server</a></div>
<p class="section-desc">Servers whose tools agents get, read at each call. Test lists a server's tools now.</p>
<div class="stack">${
  rows.length === 0
    ? `<div class="group"><div class="empty"><span class="empty-icon">${icon("server")}</span><h3>No MCP servers</h3><p>Add a remote server below. Agents get its tools at their next turn.</p></div></div>`
    : rows.map((row) => serverCard(row, owner)).join("\n")
}
${ADD_SERVER}</div>
</section>`;

// ── Skills, Status, Audit ───────────────────────────────────────────────────────────────────────────────────────

/** The Environment skills as the page shows them (panel.ts `skillsOverview`). */
export interface SkillsView {
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly repo: string;
    readonly path: string;
    readonly ref: string | null;
    readonly commit: string;
    readonly enabled: boolean;
    readonly savedAt: number;
    readonly files: number;
    readonly bytes: number;
  }>;
  readonly totals: { readonly count: number; readonly enabled: number; readonly disabled: number; readonly bytes: number; readonly disabledBytes: number; readonly maxBytes: number; readonly maxSkills: number };
  readonly unauthenticated: boolean;
}


/** One kept skill: its source at its commit, its switch, and its actions; the script fills its output area. */
const skillRow = (skill: SkillsView["skills"][number]): string => {
  const id = escapeHtml(`skill-${skill.name}`);
  const name = escapeHtml(skill.name);
  const where = `${skill.repo}${skill.path === "" ? "" : `/${skill.path}`}`;
  return `<div class="row" data-skill-row="${name}"><div><div class="row-title"><h3 id="${id}">${name}</h3><span class="ident">${escapeHtml(skill.commit.slice(0, 7))}</span>${skill.enabled ? "" : '<span class="pill">Disabled</span>'}</div>
<p class="desc">${escapeHtml(skill.description)}</p>
<p class="desc">From <code>${escapeHtml(where)}</code>${skill.ref === null ? " on the default branch" : ` at <code>${escapeHtml(skill.ref)}</code>`}, ${plural(skill.files, "file", "files")}, ${sizeText(skill.bytes)}, saved ${time(skill.savedAt)}.</p></div>
<div class="row-control"><input type="checkbox" class="switch" role="switch" data-skill-enable="${name}" aria-labelledby="${id}"${skill.enabled ? " checked" : ""}></div>
<div class="skill-extra"><div class="skill-actions"><button type="button" class="btn btn-sm" data-skill-view="${name}">${icon("play")}View</button><button type="button" class="btn btn-sm" data-skill-check="${name}">Check for updates</button><span class="spacer"></span><button type="button" class="btn btn-sm btn-danger" data-skill-remove="${name}" aria-label="Remove ${name}">${icon("trash")}Remove</button></div><div class="skill-out" data-skill-out="${name}" aria-live="polite"></div></div></div>`;
};

/**
 * The Environment skills (SPI-1148, ADR-0033): installed from GitHub for every Project, pinned to a commit, changed only
 * here. The install form's preview is the confirmation; the script renders it, and every answer, as text.
 */
const skillsSection = (view: SkillsView | undefined): string => {
  if (view === undefined) return "";
  const { totals } = view;
  const list =
    view.skills.length === 0
      ? `<div class="empty"><span class="empty-icon">${icon("skills")}</span><h3>No Environment skills</h3><p>Install one from GitHub below. Durable agents in every Project get it at their next turn.</p></div>`
      : view.skills.map(skillRow).join("\n");
  return `<section id="skills" aria-labelledby="skills-title">
<div class="section-head"><h2 id="skills-title">${icon("skills")}Skills</h2>${view.skills.length === 0 ? "" : '<button type="button" class="btn btn-sm" data-skill-check="">Check all for updates</button>'}</div>
<p class="section-desc">Environment skills, offered to Durable agents in every Project and served read-only in every Workspace at <code>/workspace/.agents/skills</code>. Each is pinned to the commit it was installed at, and beats a Repo skill of the same name. A change applies at each thread's next turn; the composer shows it at once. Repo skills load from each Workspace's own files, switched by the Skills extension above.</p>
<p class="section-desc" data-skill-totals>${plural(totals.count, "skill", "skills")} (${totals.enabled} enabled, ${totals.disabled} disabled) of ${totals.maxSkills}; ${sizeText(totals.bytes)} of ${sizeText(totals.maxBytes)}${totals.disabled === 0 ? "" : `, ${sizeText(totals.disabledBytes)} of it disabled`}. Disabled skills count toward the limits.</p>
${view.unauthenticated ? `<div class="callout callout-warn" role="note">${icon("warn")}<div><strong>Reads from GitHub are unauthenticated</strong><p>No repository with the GitHub App is a Project here, so public repos are read from GitHub's shared limit of 60 an hour for this Worker's address. Install the GitHub App on a repository and add it as a Project to read with its own limit.</p></div></div>` : ""}
<div class="group">${list}</div>
<form class="group add" id="install-skill" data-skill-install autocomplete="off" aria-labelledby="install-title">
<div class="row"><div><div class="row-title"><h3 id="install-title">Install from GitHub</h3></div><p class="desc">Preview shows the skills the source holds at its latest commit; pick them and install. Private repos need the GitHub App installed on them.</p></div></div>
<div class="form-body"><div class="field wide"><label for="install-source">Source</label><input id="install-source" name="source" type="text" required placeholder="owner/repo, owner/repo@skill, or https://github.com/owner/repo/tree/ref/path" autocapitalize="none" spellcheck="false"></div></div>
<div class="form-foot"><p></p><button type="submit" class="btn btn-primary">Preview</button></div>
<div class="skill-out" data-skill-preview aria-live="polite"></div>
</form>
</section>`;
};

/** A status value; an ISO time reads as a time. */
const statusValue = (value: string | number | null): string => {
  if (value === null) return "—";
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)) return time(Date.parse(value));
  return escapeHtml(String(value));
};

const statusSection = (status: Readonly<Record<string, string | number | null>>): string => {
  const rows = Object.entries(status)
    .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${statusValue(value)}</dd></div>`)
    .join("");
  return `<section id="status" aria-labelledby="status-title">
<div class="section-head"><h2 id="status-title">${icon("status")}Status</h2></div>
<dl class="group kv">${rows}</dl>
</section>`;
};

/** Each entity's name in the audit log; one this page does not know shows as stored. */
const ENTITY_LABELS: Readonly<Record<string, string>> = { harness: "Harness", environment: "Environment", endpoints: "Model endpoints", "owner-clients": "Owner clients" };

const auditSection = (audit: ReadonlyArray<AuditEntry>): string => {
  const body =
    audit.length === 0
      ? `<div class="empty"><span class="empty-icon">${icon("audit")}</span><h3>No changes yet</h3><p>Every change, here or from a script, is logged with who made it. Secrets are never logged.</p></div>`
      : `<div class="table-wrap"><table class="stacked"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Settings</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Change</th></tr></thead><tbody>${audit
          .map(
            (entry) =>
              `<tr><td class="when" data-label="When"><div>${time(entry.at)}</div></td><td class="who" data-label="Who"><div>${escapeHtml(entry.caller)}</div></td><td data-label="Settings"><div>${escapeHtml(ENTITY_LABELS[entry.entity] ?? String(entry.entity))}</div></td><td data-label="Action"><div><code>${escapeHtml(entry.action)}</code></div></td><td data-label="Target"><div>${escapeHtml(entry.target)}</div></td><td data-label="Change"><div><code class="change">${escapeHtml(JSON.stringify(entry.after ?? null))}</code></div></td></tr>`,
          )
          .join("")}</tbody></table></div>`;
  return `<section id="audit" aria-labelledby="audit-title">
<div class="section-head"><h2 id="audit-title">${icon("audit")}Audit log</h2></div>
<p class="section-desc">The latest ${audit.length === 0 ? "" : `${audit.length} `}changes, newest first.</p>
<div class="group">${body}</div>
</section>`;
};

/** The panel's Open changes list (plan D10): each change, who asked, and its page. */
export interface OpenChangeRow {
  readonly changeId: string;
  readonly subject: string;
  readonly tool: string;
  readonly reasons: ReadonlyArray<string>;
  readonly door: AskedBy["door"];
  readonly principal?: AskedBy["principal"];
  readonly thread?: string;
  readonly agent?: string;
  readonly client?: { readonly name: string; readonly source: string };
  readonly needsPage?: PageReason;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const openChangesSection = (rows: ReadonlyArray<OpenChangeRow>): string => {
  const body =
    rows.length === 0
      ? `<div class="empty"><h3>No open changes</h3><p>A change an agent asks for that widens what agents have waits here, and on its card, for ${durationText(CHANGE_TTL_MS)}.</p></div>`
      : `<div class="table-wrap"><table class="stacked"><thead><tr><th scope="col">Asked</th><th scope="col">Change</th><th scope="col">By</th><th scope="col">Expires</th><th scope="col"><span class="sr">Open</span></th></tr></thead><tbody>${rows
          .map(
            (row) =>
              `<tr><td data-label="Asked"><div>${time(Date.parse(row.createdAt))}</div></td><td data-label="Change"><div><code>${visibleHtml(row.tool)}</code>: ${visibleHtml(row.reasons.join("; "))}</div></td><td data-label="By"><div>${visibleHtml(askedByText(row))}</div></td><td data-label="Expires"><div>${time(Date.parse(row.expiresAt))}</div></td><td data-label="Open"><div><a class="btn btn-sm" href="${changePagePath(row.changeId)}">Open</a></div></td></tr>`,
          )
          .join("")}</tbody></table></div>`;
  return `<section id="changes" aria-labelledby="changes-title">
<div class="section-head"><h2 id="changes-title">Open changes</h2></div>
<p class="section-desc">Changes agents asked for that wait for your answer, here or on their card. The first answer wins.</p>
<div class="group">${body}</div>
</section>`;
};

export interface PageInput {
  readonly mcp?: ReadonlyArray<McpRow>;
  readonly resolved: ResolvedHarness;
  /** The Environment settings (ADR-0032); the defaults when not given. */
  readonly environment?: ResolvedEnvironment;
  readonly costs?: ContainerCostTable;
  /** The Containers running now (the budget's leases); null when the budget could not be read. */
  readonly running?: { readonly count: number; readonly holders: ReadonlyArray<string> } | null;
  readonly csrf: string;
  readonly audit: ReadonlyArray<AuditEntry>;
  readonly status: Readonly<Record<string, string | number | null>>;
  /** The Environment skills (SPI-1148); the section is left out without them. */
  readonly skills?: SkillsView;
  /** The Model endpoints (SPI-1162); the section is left out without them. */
  readonly endpoints?: EndpointsView;
  /** The Open changes (plan D10); the section is left out without them. */
  readonly openChanges?: ReadonlyArray<OpenChangeRow>;
  /** The Owner clients and the endpoint's URL; shown on the Settings server's card when given. */
  readonly ownerClients?: OwnerClientsView;
}

const navItem = (id: string, label: string, name: IconName, after = "") => `<a href="#${id}">${icon(name)}${label}${after}</a>`;

/** The whole page. */
export const renderPage = (input: PageInput): string => {
  const rows = input.mcp ?? [];
  const failing = rows.filter((row) => row.setting.enabled && row.status === "failed").length;
  const revision = String(input.resolved.revision);
  const environment = input.environment ?? resolveEnvironment(EMPTY_ENVIRONMENT);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="t3flare-csrf" content="${escapeHtml(input.csrf)}">
<title>Settings · t3flare</title>${FAVICON}<style>${STYLE}</style></head>
<body>${ICON_SPRITE}
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<aside class="side">
${brand()}
<nav class="nav" aria-label="Sections">
${input.openChanges === undefined ? "" : `${navItem("changes", "Open changes", "alert", `<span class="count">${input.openChanges.length}</span>`)}\n`}${navItem("extensions", "Extensions", "extensions", `<span class="count">${EXTENSIONS.length}</span>`)}
${navItem("mcp", "MCP servers", "server", failing > 0 ? `<span class="flag" role="img" aria-label="${plural(failing, "server", "servers")} failing"></span>` : `<span class="count">${rows.length}</span>`)}
${input.endpoints === undefined ? "" : `${navItem("endpoints", "Model endpoints", "key", `<span class="count">${input.endpoints.endpoints.length}</span>`)}\n`}${navItem("environment", "Environment", "container")}
${navItem("skills", "Skills", "skills")}
${navItem("status", "Status", "status")}
${navItem("audit", "Audit log", "audit", `<span class="count">${input.audit.length}</span>`)}
</nav>
<p class="side-foot">Harness revision <strong>${revision}</strong>, applied at each thread's next turn. Environment revision <strong>${environment.revision}</strong>: Container settings apply at each Container's next start, Environment skills at each thread's next turn.</p>
</aside>
<main id="main" tabindex="-1"><div class="content">
<header class="page-head"><div><h1>Settings</h1><p>t3flare's own settings for this Cloud Environment: the Harness settings (Pi Durable's extensions and MCP servers, applied at each thread's next turn) and the Environment settings (what every Container gets, applied at its next start).</p></div><span class="chip">Revision <strong>${revision}</strong></span></header>
<div id="result" class="notice" role="status" aria-live="polite" hidden><span class="notice-ico-ok">${icon("check")}</span><span class="notice-ico-err">${icon("alert")}</span><p class="msg"></p><button type="button" class="btn btn-ghost btn-sm" data-dismiss aria-label="Dismiss">${icon("x")}</button></div>
${input.openChanges === undefined ? "" : `${openChangesSection(input.openChanges)}\n`}${extensionsSection(input.resolved)}
${mcpSection(rows, input.ownerClients)}
${endpointsSection(escapeHtml, input.endpoints)}${environmentSection(environment, input.costs ?? containerCostTable(environment.containerBudget), input.running)}
${skillsSection(input.skills)}
${statusSection(input.status)}
${auditSection(input.audit)}
</div></main>
</div>
<script>${SCRIPT}</script>
</body></html>`;
};
