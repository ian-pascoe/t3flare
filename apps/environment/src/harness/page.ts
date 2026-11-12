// @effect-diagnostics globalDate:off
// The harness panel's page (ADR-0026): server-rendered HTML, no framework, no third-party script or font. Every string
// that is not a literal here is HTML-escaped (review H4: tool names, descriptions, errors and settings may be hostile).
// The one script and the one stylesheet are constants, allowed by their SHA-256 hashes in the CSP, never by `'self'`.
// The script only turns the forms into JSON API calls with the CSRF token from the page's meta tag.
import { EXTENSIONS, type ResolvedHarness, type SettingEntry } from "@t3flare/harness-registry";

import type { AuditEntry } from "./store.ts";

/** `text` safe in HTML text and in a double-quoted attribute. */
export const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const STYLE = `body{font:14px/1.45 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px;color:#1b1b1b;background:#fafafa}
h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
.ext{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px;margin:10px 0}
.ext h3{margin:0 0 4px;font-size:14px}.muted{color:#666}.locked{color:#8a5a00}
label{display:block;margin:6px 0}input[type=number]{width:8em}input[type=url]{width:36em;max-width:100%}
button{margin-top:6px}#result{white-space:pre-wrap;color:#8a0000}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;font-size:12px}`;

const SCRIPT = `"use strict";
const csrf = document.querySelector('meta[name="t3flare-csrf"]').getAttribute("content");
const result = document.getElementById("result");
const post = async (path, body) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-t3flare-csrf": csrf },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (response.ok) return response;
  result.textContent = "Refused: " + (await response.text());
  return undefined;
};
for (const button of document.querySelectorAll("button[data-mcp]")) {
  button.addEventListener("click", async () => {
    const change = JSON.parse(button.dataset.mcp);
    if (change.op === "remove" && !confirm("Remove " + change.server + " and its sign-in?")) return;
    const response = await post("/_t3flare/harness/api/mcp", change);
    if (response !== undefined) location.reload();
  });
}
for (const button of document.querySelectorAll("button[data-mcp-test]")) {
  button.addEventListener("click", async () => {
    const response = await post("/_t3flare/harness/api/mcp/test", { server: button.dataset.mcpTest });
    if (response !== undefined) result.textContent = JSON.stringify(await response.json());
  });
}
for (const button of document.querySelectorAll("button[data-mcp-oauth]")) {
  button.addEventListener("click", async () => {
    const response = await post("/_t3flare/harness/api/mcp/oauth", { server: button.dataset.mcpOauth });
    if (response === undefined) return;
    const answer = await response.json();
    const target = new URL(answer.authorizationUrl);
    if (target.protocol === "https:") window.open(target.toString(), "_blank", "noopener,noreferrer");
  });
}
const adding = document.querySelector("form[data-mcp-add]");
if (adding !== null) {
  const auth = adding.querySelector("[name=auth]");
  const headerFields = adding.querySelector("[data-header-fields]");
  const showHeader = () => { headerFields.hidden = auth.value !== "header"; };
  auth.addEventListener("change", showHeader);
  showHeader();
  adding.addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = (name) => adding.querySelector("[name=" + name + "]").value.trim();
    const body = { server: field("server"), url: field("url"), auth: { kind: auth.value } };
    if (auth.value === "header") {
      body.auth.header = field("header");
      body.value = adding.querySelector("[name=value]").value;
    }
    const response = await post("/_t3flare/harness/api/mcp/servers", body);
    adding.querySelector("[name=value]").value = "";
    if (response !== undefined) location.reload();
  });
}
for (const form of document.querySelectorAll("form[data-extension]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const change = { extension: form.dataset.extension };
    const settings = {};
    for (const input of form.querySelectorAll("[data-setting]")) {
      const kind = input.dataset.kind;
      settings[input.dataset.setting] = kind === "boolean" ? input.checked : kind === "integer" ? Number(input.value) : input.value;
    }
    if (Object.keys(settings).length > 0) change.settings = settings;
    const enabled = form.querySelector("[data-enabled]");
    if (enabled !== null) change.enabled = enabled.checked;
    const response = await fetch("/_t3flare/harness/api/extensions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-t3flare-csrf": csrf },
      body: JSON.stringify(change),
      credentials: "same-origin",
    });
    if (response.ok) location.reload();
    else result.textContent = "Refused: " + (await response.text());
  });
}`;

const sha256 = async (text: string): Promise<string> =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));

let hashes: Promise<{ readonly style: string; readonly script: string }> | undefined;

/** The page's Content-Security-Policy: nothing but its own constant style and script, and calls to its own origin. */
export const pageCsp = async (): Promise<string> => {
  hashes ??= Promise.all([sha256(STYLE), sha256(SCRIPT)]).then(([style, script]) => ({ style, script }));
  const { style, script } = await hashes;
  return [
    "default-src 'none'",
    `style-src 'sha256-${style}'`,
    `script-src 'sha256-${script}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
};

const field = (extension: string, key: string, setting: SettingEntry, value: unknown, locked: boolean): string => {
  const id = escapeHtml(`${extension}-${key}`);
  const attrs = `id="${id}" data-setting="${escapeHtml(key)}" data-kind="${setting.schema.type}"${locked ? " disabled" : ""}`;
  const label = `<span title="${escapeHtml(setting.description)}">${escapeHtml(setting.title)}</span>`;
  switch (setting.schema.type) {
    case "boolean":
      return `<label for="${id}"><input type="checkbox" ${attrs}${value === true ? " checked" : ""}> ${label}</label>`;
    case "integer":
      return `<label for="${id}">${label} <input type="number" ${attrs} min="${setting.schema.minimum}" max="${setting.schema.maximum}" value="${escapeHtml(String(value))}"></label>`;
    case "enum":
      return `<label for="${id}">${label} <select ${attrs}>${setting.schema.values
        .map((option) => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(option)}</option>`)
        .join("")}</select></label>`;
  }
};

const extensionCard = (resolved: ResolvedHarness, entry: (typeof EXTENSIONS)[number]): string => {
  const current = resolved.extensions[entry.id];
  const locked = entry.locked !== undefined;
  const settings = Object.entries(entry.settings).map(([key, setting]) => field(entry.id, key, setting, current?.settings[key], locked));
  const toggle =
    entry.default === "always"
      ? `<div class="muted">${locked ? `<span class="locked">Locked: ${escapeHtml(entry.locked ?? "")}</span>` : "Always on"}</div>`
      : `<label><input type="checkbox" data-enabled${current?.enabled === true ? " checked" : ""}> On</label>`;
  const editable = !locked && (entry.default !== "always" || settings.length > 0);
  return `<form class="ext" data-extension="${escapeHtml(entry.id)}"><h3>${escapeHtml(entry.title)} <span class="muted">(${escapeHtml(entry.id)})</span></h3>
<div class="muted">${escapeHtml(entry.description)}</div>${toggle}${settings.join("")}${editable ? "<button type=\"submit\">Save</button>" : ""}</form>`;
};

/** One server of the panel's MCP section (panel.ts `mcpOverview`). */
export interface McpRow {
  readonly name: string;
  readonly setting: { readonly kind: string; readonly enabled: boolean; readonly exposure: string; readonly url?: string; readonly auth?: { readonly kind: string } };
  readonly oauth?: { readonly signedIn: boolean };
  readonly status: string;
  readonly listedAt: number | null;
  readonly error: string | null;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly upstream: string; readonly class: string; readonly hinted: string; readonly exposure: string }>;
  /** The owner's overrides, by upstream name. */
  readonly overrides?: Readonly<Record<string, string>>;
  readonly refused: ReadonlyArray<{ readonly tool: string; readonly reason: string }>;
}

const action = (label: string, change: unknown) => `<button type="button" data-mcp="${escapeHtml(JSON.stringify(change))}">${escapeHtml(label)}</button>`;

const mcpSection = (rows: ReadonlyArray<McpRow>): string =>
  rows
    .map((row) => {
      const tools = row.tools
        .map((tool) => {
          const other = tool.class === "read" ? "write" : "read";
          const overridden = row.overrides?.[tool.upstream] !== undefined;
          const note = overridden ? ` <span class="muted">(set by you; the tool's hint says ${escapeHtml(tool.hinted)})</span>` : ' <span class="muted">(the tool\'s hint)</span>';
          return `<tr><td>${escapeHtml(tool.upstream)}</td><td>${escapeHtml(tool.class)}${note}</td><td>${escapeHtml(tool.exposure)}</td><td>${action(`Mark ${other}`, { op: "class", server: row.name, tool: tool.upstream, class: other })}${
            overridden ? action("Use the tool's hint", { op: "class", server: row.name, tool: tool.upstream, class: null }) : ""
          }</td></tr>`;
        })
        .join("");
      const refused = row.refused.map((r) => `<li>${escapeHtml(r.tool)}: ${escapeHtml(r.reason)}</li>`).join("");
      return `<div class="ext"><h3>${escapeHtml(row.name)} <span class="muted">(${escapeHtml(row.setting.kind)}${row.setting.url === undefined ? "" : `, ${escapeHtml(row.setting.url)}`})</span></h3>
<div class="muted">${row.setting.enabled ? "Enabled" : "Disabled"} · Exposure ${escapeHtml(row.setting.exposure)} · ${escapeHtml(row.status)}${
        row.listedAt === null ? "" : `, listed ${escapeHtml(new Date(row.listedAt).toISOString())}`
      }${row.error === null ? "" : ` · <span class="locked">${escapeHtml(row.error)}</span>`}</div>
<div>${action(row.setting.enabled ? "Disable" : "Enable", { op: "server", server: row.name, enabled: !row.setting.enabled })}<button type="button" data-mcp-test="${escapeHtml(row.name)}">Test</button>${
        row.setting.auth?.kind === "oauth"
          ? `<button type="button" data-mcp-oauth="${escapeHtml(row.name)}">${row.oauth?.signedIn === true ? "Sign in again" : "Sign in"}</button> <span class="muted">${row.oauth?.signedIn === true ? "signed in" : "not signed in"}</span>`
          : ""
      }${row.setting.kind === "direct" ? action("Remove", { op: "remove", server: row.name }) : ""}</div>
<table><tr><th>Tool</th><th>Class</th><th>Exposure</th><th></th></tr>${tools}</table>${refused === "" ? "" : `<ul>${refused}</ul>`}</div>`;
    })
    .join("\n");

/**
 * The form that adds a direct server (Route B). Each tool's class is its own `readOnlyHint` until the owner overrides it
 * (owner, 2026-11-12, back to stock); an OAuth server is signed in with its Sign in button once added. A header value
 * goes to the write-only secret store.
 */
const ADD_SERVER = `<form class="ext" data-mcp-add autocomplete="off"><h3>Add a server</h3>
<div class="muted">A remote MCP server over streamable HTTP (https only). Each tool's class is its own read-only hint until you change it; write tools follow the thread's mode.</div>
<label>Name <input name="server" required pattern="[a-z0-9-]{1,20}" placeholder="executor"></label>
<label>URL <input name="url" type="url" required placeholder="https://mcp.example.com/mcp"></label>
<label>Sign-in <select name="auth"><option value="oauth">OAuth (sign in after adding)</option><option value="header">A header</option><option value="none">None</option></select></label>
<div data-header-fields><label>Header name <input name="header" value="Authorization" pattern="[A-Za-z0-9-]{1,64}"></label>
<label>Header value <input name="value" type="password" autocomplete="new-password"> <span class="muted">stored write-only; never shown again</span></label></div>
<button type="submit">Add</button></form>`;

export interface PageInput {
  readonly mcp?: ReadonlyArray<McpRow>;
  readonly resolved: ResolvedHarness;
  readonly csrf: string;
  readonly audit: ReadonlyArray<AuditEntry>;
  readonly status: Readonly<Record<string, string | number | null>>;
}

/** The whole page. */
export const renderPage = (input: PageInput): string => {
  const status = Object.entries(input.status)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value === null ? "—" : String(value))}</td></tr>`)
    .join("");
  const audit = input.audit
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(new Date(entry.at).toISOString())}</td><td>${escapeHtml(entry.caller)}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.target)}</td><td>${escapeHtml(JSON.stringify(entry.after ?? null))}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="t3flare-csrf" content="${escapeHtml(input.csrf)}">
<title>t3flare harness</title><style>${STYLE}</style></head>
<body><h1>Pi Durable harness</h1>
<p class="muted">Settings revision ${input.resolved.revision}. Changes apply at a thread's next turn.</p>
<div id="result"></div>
<h2>Extensions</h2>
${EXTENSIONS.map((entry) => extensionCard(input.resolved, entry)).join("\n")}
<h2>MCP servers</h2>
${input.mcp === undefined || input.mcp.length === 0 ? '<p class="muted">No MCP server.</p>' : mcpSection(input.mcp)}
${ADD_SERVER}
<h2>Skills</h2>
<p class="muted">Deferred (SPI-1001).</p>
<h2>Status</h2>
<table>${status}</table>
<h2>Audit log</h2>
<table><tr><th>At</th><th>Caller</th><th>Action</th><th>Target</th><th>After</th></tr>${audit}</table>
<script>${SCRIPT}</script>
</body></html>`;
};
