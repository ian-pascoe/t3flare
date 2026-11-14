// @effect-diagnostics globalDate:off
// The Change page (ADR-0034, plan D10), M4 (SPI-1199): one Open change, server-rendered from its `shown` (render.ts), at
// `/_t3flare/harness/changes/<id>` under the panel's Access check, hash-only CSP and security headers. Every string that
// is not a literal here is made visible (control and bidi characters shown as `\u{…}`) and then HTML-escaped, so a
// hostile setting, server name, URL or SKILL.md is inert. No script computes a diff: the line diff is rendered here.
//
// It is the only place a header value is typed for an agent's change, and the only place a sign-in's authorization URL
// goes (in the POST's own answer, to this page's script): ADR-0034, O8.
import { visible } from "@t3flare/harness-registry";

import type { ChangeRecord } from "../settings/changes.ts";
import { type ChangeItem, lineDiff, type ShownSkill } from "../settings/render.ts";
import { fileUrl } from "../skills/api.ts";
import { CHANGE_SCRIPT } from "./changePageScript.ts";
import { escapeHtml } from "./page.ts";
import { STYLE } from "./pageStyle.ts";

/** `text` safe in HTML, with every control and format character shown. */
const safe = (text: string): string => escapeHtml(visible(text));

/** A value as JSON text, safe. */
const value = (raw: unknown): string => (raw === undefined ? '<span class="desc">unset</span>' : `<code>${safe(typeof raw === "string" ? raw : JSON.stringify(raw))}</code>`);

const time = (at: number): string => {
  const iso = new Date(at).toISOString();
  return `<time datetime="${iso}" data-local>${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC</time>`;
};

const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`);

/** A URL with its host set apart (plan D10: an MCP `add` shows where it goes). */
const urlWithHost = (url: string, host: string): string => {
  const at = host === "" ? -1 : url.indexOf(host);
  if (at < 0) return `<code>${safe(url)}</code>`;
  return `<code>${safe(url.slice(0, at))}<span class="url-host">${safe(host)}</span>${safe(url.slice(at + host.length))}</code>`;
};

const diffBlock = (before: string, after: string): string =>
  `<pre class="diff">${lineDiff(before, after)
    .map((line) => `<span class="${line.op === "+" ? "add" : line.op === "-" ? "del" : "ctx"}">${line.op} ${safe(line.text)}</span>`)
    .join("")}</pre>`;

const skillBlock = (repo: string, commit: string, skill: ShownSkill): string => {
  const files = skill.paths
    .map((path) => {
      const href = fileUrl({ repo, path: skill.path, commit }, path);
      return `<li><a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${safe(path)}</a></li>`;
    })
    .join("");
  return `<div class="change-block"><h3>${safe(skill.name)} <span class="ident">${safe(skill.path === "" ? "the repo's root" : skill.path)}</span></h3>
<p class="desc">${safe(skill.description)}</p>
<p class="desc">${skill.files} ${skill.files === 1 ? "file" : "files"}, ${sizeOf(skill.bytes)}; digest <code>${safe(skill.digest.slice(0, 16))}</code></p>${
    skill.problems.length === 0 ? "" : `<div class="callout" role="note"><div><strong>Cannot be installed</strong><ul>${skill.problems.map((problem) => `<li>${safe(problem)}</li>`).join("")}</ul></div></div>`
  }
<details open><summary>SKILL.md${skill.skillMdCut === true ? " (cut: open it on GitHub for the rest)" : ""}</summary><pre class="text">${safe(skill.skillMd)}</pre></details>
<details><summary>Files at the commit</summary><ul>${files}</ul>${skill.morePaths === undefined ? "" : `<p class="desc">and ${skill.morePaths} more</p>`}</details></div>`;
};

/** One item of the change, by kind (plan D10's table). */
const itemBlock = (item: ChangeItem, needsSecret: boolean): string => {
  switch (item.kind) {
    case "scalar":
      return `<div class="change-block"><h3>${safe(item.name)}</h3><dl class="kv"><div><dt>Before</dt><dd>${value(item.before)}</dd></div><div><dt>After</dt><dd>${value(item.after)}</dd></div></dl></div>`;
    case "variables": {
      const rows = [
        ...item.added.map(([name, after]) => `<tr><td data-label="Change"><div>added</div></td><td data-label="Name"><div><code>${safe(name)}</code></div></td><td data-label="Before"><div>—</div></td><td data-label="After"><div>${value(after)}</div></td></tr>`),
        ...item.changed.map(
          ([name, before, after]) =>
            `<tr><td data-label="Change"><div>changed</div></td><td data-label="Name"><div><code>${safe(name)}</code></div></td><td data-label="Before"><div>${value(before)}</div></td><td data-label="After"><div>${value(after)}</div></td></tr>`,
        ),
        ...item.removed.map(([name, before]) => `<tr><td data-label="Change"><div>removed</div></td><td data-label="Name"><div><code>${safe(name)}</code></div></td><td data-label="Before"><div>${value(before)}</div></td><td data-label="After"><div>—</div></td></tr>`),
      ];
      return `<div class="change-block"><h3>${safe(item.name)}</h3><div class="table-wrap"><table class="stacked"><thead><tr><th scope="col">Change</th><th scope="col">Name</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`;
    }
    case "text":
      return `<div class="change-block"><h3>${safe(item.name)}</h3>${diffBlock(item.before, item.after)}</div>`;
    case "mcp-add":
      return `<div class="change-block"><h3>Add the MCP server ${safe(item.server)}</h3><dl class="kv"><div><dt>URL</dt><dd>${urlWithHost(item.url, item.host)}</dd></div><div><dt>Host</dt><dd><strong>${safe(item.host)}</strong></dd></div><div><dt>Sign-in</dt><dd>${
        item.auth === "header" ? `a header, <code>${safe(item.header ?? "")}</code>` : item.auth === "oauth" ? "OAuth, started later" : "none"
      }</dd></div></dl>${needsSecret ? secretField(item.header ?? "header") : ""}</div>`;
    case "mcp-remove":
      return `<div class="change-block"><h3>Remove the MCP server ${safe(item.server)}</h3>${item.url === undefined ? "" : `<p><code>${safe(item.url)}</code></p>`}<p class="desc">Its stored header value and OAuth sign-in are deleted at once.</p></div>`;
    case "header-value":
      return `<div class="change-block"><h3>Set ${safe(item.server)}'s header value</h3><dl class="kv"><div><dt>Header</dt><dd><code>${safe(item.header)}</code></dd></div><div><dt>A value is set now</dt><dd>${item.set ? "yes" : "no"}</dd></div></dl>${needsSecret ? secretField(item.header) : ""}</div>`;
    case "sign-in":
      return `<div class="change-block"><h3>Sign in to ${safe(item.server)} with OAuth</h3>${item.url === "" ? "" : `<p><code>${safe(item.url)}</code></p>`}<p class="desc">Approve starts the sign-in and sends this browser to the server's authorization page.</p></div>`;
    case "skills":
      return `<div class="change-block"><h3>${item.op === "install" ? "Install Environment skills" : "Update an Environment skill"}</h3><dl class="kv"><div><dt>Source</dt><dd><code>${safe(item.source)}</code></dd></div><div><dt>Repository</dt><dd><code>${safe(item.repo)}</code></dd></div>${
        item.ref === null ? "" : `<div><dt>Ref</dt><dd><code>${safe(item.ref)}</code></dd></div>`
      }${item.from === undefined ? "" : `<div><dt>Kept at</dt><dd><code>${safe(item.from)}</code></dd></div>`}<div><dt>Commit</dt><dd><a href="${escapeHtml(`https://github.com/${item.repo}/tree/${item.commit}`)}" rel="noopener noreferrer" target="_blank"><code>${safe(item.commit)}</code></a></dd></div></dl></div>${item.skills
        .map((skill) => skillBlock(item.repo, item.commit, skill))
        .join("")}`;
    case "skill":
      return `<div class="change-block"><h3>${item.op === "enable" ? "Enable" : item.op === "disable" ? "Disable" : "Remove"} the Environment skill ${safe(item.name)}</h3>${
        item.repo === undefined ? "" : `<p class="desc">From <code>${safe(item.repo)}</code>${item.commit === undefined ? "" : ` at <code>${safe(item.commit.slice(0, 7))}</code>`}</p>`
      }</div>`;
  }
};

/** The header value's field: a password field, never filled, never echoed. */
const secretField = (header: string): string =>
  `<div class="field"><label for="change-value">Value of the header <code>${safe(header)}</code></label><input id="change-value" name="value" form="change-answer" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" aria-describedby="change-value-hint"><p class="hint" id="change-value-hint">Stored write-only in the Environment's secret store. It never reaches the agent.</p></div>`;

const STATE_TEXT: Readonly<Record<ChangeRecord["state"], string>> = {
  open: "Waiting for your answer",
  applying: "Being applied",
  applied: "Applied",
  declined: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired",
  moved: "Not applied: the settings moved",
  failed: "Not applied: it failed",
};

const head = (title: string, csrf: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="t3flare-csrf" content="${escapeHtml(csrf)}">
<title>${safe(title)} · t3flare</title><style>${STYLE}</style></head>`;

const foot = `<div id="result" class="notice" role="status" aria-live="polite" hidden></div></main>
<script>${CHANGE_SCRIPT}</script>
</body></html>`;

/** The page for an unknown id, or one pruned an hour after it closed. */
export const renderGonePage = (csrf: string): string =>
  `${head("Change", csrf)}<body><main class="change-main" id="main"><header class="page-head"><div><h1>This change is gone</h1><p>No change has this id: it closed over an hour ago, or never was. Nothing waits here.</p></div></header><p><a href="/_t3flare/harness#changes">The Harness panel's Open changes</a></p>${foot}`;

/** Who asked, as the page names them: an own agent's thread and kind, or an Owner client's label marked unverified. */
const askedBy = (record: ChangeRecord): string => {
  const caller = record.caller;
  if (caller.door === "own") return `${safe(caller.agent ?? "an agent")} on thread <code>${safe(caller.thread ?? caller.key)}</code>`;
  const who = caller.principal === "service-token" ? "the stage's service token" : "an Owner client of yours";
  return `${who}${caller.client === undefined ? "" : `, calling itself <code>${safe(caller.client.name)}</code> (unverified, from its ${safe(caller.client.source)})`}`;
};

/** The Change page for `record` (plan D10). `now` decides the time left. */
export const renderChangePage = (record: ChangeRecord, input: { readonly csrf: string; readonly now: number }): string => {
  const view = record.shown;
  const open = record.state === "open";
  const left = Math.max(0, Math.ceil(((record.expiresAt ?? record.createdAt) - input.now) / 60_000));
  const needsSecret = record.needsPage === "secret";
  const title = view === undefined ? "A change" : `A change to ${view.subject}`;
  const facts = [
    ["State", `<strong>${STATE_TEXT[record.state]}</strong>`],
    ["Asked by", askedBy(record)],
    ["Answered", record.mode === "card" ? "on its card on the thread, or here" : `in the client's ${safe(record.mode ?? "")} mode, or here`],
    ["Revision", `${view?.entity === "environment" ? "Environment" : "Harness"} settings at ${record.expectedRevision ?? "?"}`],
    ["Asked at", time(record.createdAt)],
    ...(open ? [["Time left", `${left} ${left === 1 ? "minute" : "minutes"} (until ${time(record.expiresAt ?? record.createdAt)})`]] : []),
    ...(record.closed === undefined
      ? []
      : [["Closed", `${time(record.closed.at)}${record.closed.by === undefined ? "" : ` by the ${safe(record.closed.by)}`}${record.closed.revision === undefined ? "" : `, revision ${record.closed.revision}`}`]]),
    ...(record.closed?.error === undefined ? [] : [["Why", safe(record.closed.error)]]),
    ["Change", `<code>${safe(record.id)}</code>`],
  ]
    .map(([term, detail]) => `<div><dt>${term}</dt><dd>${detail}</dd></div>`)
    .join("");
  const reasons = (view?.reasons ?? []).map((reason) => `<li>${safe(reason)}</li>`).join("");
  const lines = (view?.lines ?? []).map((line) => `<div class="callout callout-warn" role="note"><div><p>${safe(line)}</p></div></div>`).join("");
  const items = (view?.items ?? []).map((item) => itemBlock(item, open && needsSecret)).join("");
  const answer = open
    ? `<form class="group change-answer" id="change-answer" data-change="${escapeHtml(record.id)}" autocomplete="off" novalidate><button type="button" class="btn btn-primary" data-action="approve">${
        record.needsPage === "sign-in" ? "Approve and sign in" : "Approve"
      }</button><button type="button" class="btn" data-action="decline">Decline</button><p class="desc">The first answer wins: the card on the thread and this page answer the same change.</p></form>`
    : "";
  return `${head(title, input.csrf)}<body><main class="change-main" id="main">
<header class="page-head"><div><h1>${safe(title)}</h1><p>${safe(view?.appliesAt ?? "")}</p></div><a class="chip" href="/_t3flare/harness#changes">Open changes</a></header>
<dl class="group kv">${facts}</dl>
${lines}
<section class="group" aria-label="What changes">${items === "" ? '<div class="change-block"><p class="desc">Nothing to show.</p></div>' : items}</section>
<section class="group" aria-label="Why it waits"><div class="change-block"><h3>Why it waits for you</h3><ul>${reasons}</ul></div></section>
<section class="group" aria-label="The agent's call"><div class="change-block"><h3>The call</h3><pre class="text">${safe(`settings: ${record.tool}\n${JSON.stringify(record.args, null, 2)}`)}</pre></div></section>
${answer}
${foot}`;
};
