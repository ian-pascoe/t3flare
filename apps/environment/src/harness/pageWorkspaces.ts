// The Settings page's Workspaces section (ADR-0044 §1, §4 and its Consequences): the Grace as one control, every
// Workspace with a project's Worktree Workspaces under it, what references it and when the Sweep would purge it, a Files
// column the script fills per row, and the Owner's acts: Purge now (behind the Workspace's own name typed), Restore,
// Stop Container, and the Sweep with its dry preview. Every string is escaped (page.ts's rule). Its behaviour is
// WORKSPACES_SCRIPT, part of the page's one script.
import { MAX_GRACE_DAYS } from "@t3flare/harness-registry";

import type { WorkspaceRow, WorkspacesView, WorkspaceStatus } from "../agents/workspaceView.ts";
import { icon } from "./pageIcons.ts";

/** The section's input: the view, or why it could not be read (the section says so, and offers nothing to act on). */
export type WorkspacesSectionInput = WorkspacesView | { readonly error: string };

type Escape = (text: string) => string;
type Time = (at: number) => string;

const PILLS: Readonly<Record<WorkspaceStatus, string>> = {
  "in use": "pill-ok",
  unreferenced: "pill-warn",
  tombstone: "pill-warn",
  "tombstone (kept)": "",
  purging: "pill-err",
  provisioning: "",
  failed: "pill-err",
};

/** A Grace in words: days, or the minutes or hours a Stage's override sets. */
const graceText = (ms: number): string => {
  const day = 24 * 60 * 60_000;
  if (ms % day === 0) return ms === day ? "a day" : `${ms / day} days`;
  if (ms % 3_600_000 === 0) return ms === 3_600_000 ? "an hour" : `${ms / 3_600_000} hours`;
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
};

/** The Grace control (ADR-0044 §1): "Purge after [n] days" or "Never purge", saved through the Environment settings. */
const graceForm = (escape: Escape, time: Time, view: WorkspacesView): string => {
  const state = !view.purging
    ? "Never purge: the Sweep marks what nothing references and purges nothing."
    : view.purgingSince === null
      ? "Purging starts its Grace at the next Sweep: nothing is purged before one Grace after it."
      : `Purging since ${time(view.purgingSince)}: nothing is purged before ${time(view.purgingSince + view.graceMs)}.`;
  const overridden = view.overridden
    ? `<div class="callout callout-warn" role="note">${icon("warn")}<div><strong>This Stage overrides the Grace</strong><p><code>T3FLARE_SWEEP_GRACE_MS</code> sets it to ${escape(graceText(view.graceMs))}. The days below are stored, and rule where nothing overrides them.</p></div></div>`
    : "";
  return `<form class="group" data-grace aria-labelledby="grace-title" novalidate>
<div class="row"><div><div class="row-title"><h3 id="grace-title">Grace</h3></div><p class="desc">How long the Sweep keeps a Workspace nothing references, a Tombstone, and a deleted thread's Session before it purges them. A change applies to what already waits, at the next Sweep, which it brings forward.</p></div>
<div class="row-extra"><fieldset class="grace-choices"><legend class="sr">When the Sweep purges</legend>
<div class="inline-field"><input type="radio" id="grace-days" name="grace" value="days"${view.purging ? " checked" : ""}><label for="grace-days">Purge after</label><input type="number" inputmode="numeric" id="grace-days-n" data-grace-days aria-label="Grace in days" required min="1" max="${MAX_GRACE_DAYS}" step="1" value="${escape(String(view.graceDays))}"><span class="hint">days</span></div>
<div class="inline-field"><input type="radio" id="grace-never" name="grace" value="never"${view.purging ? "" : " checked"}><label for="grace-never">Never purge</label></div>
<p class="hint">${state}</p></fieldset>
<div class="save"><span class="save-note" data-save-note aria-live="polite"></span><button type="submit" class="btn btn-sm" data-save disabled>Save</button></div></div></div>
${overridden}</form>`;
};

/** When the Sweep would purge it, in words, with the Sweep's own reason beneath. */
const purgeCell = (escape: Escape, time: Time, view: WorkspacesView, row: WorkspaceRow): string => {
  const when =
    row.purgeDue !== null
      ? time(row.purgeDue)
      : row.status === "in use"
        ? "never while referenced"
        : row.status === "tombstone (kept)"
          ? "never: kept"
          : !view.purging
            ? "never: purging is off"
            : row.status === "unreferenced"
              ? "dated at the next Sweep"
              : "—";
  // A date says it all; without one, the Sweep's own reason says why not.
  return `${when}${row.purgeDue !== null || row.planned.why === "" ? "" : `<span class="src">${escape(row.planned.why)}</span>`}`;
};

/** A Workspace path or branch, escaped, that wraps only after a `/` (never mid-name). */
const pathHtml = (escape: Escape, path: string): string => escape(path).replaceAll("/", "/<wbr>");

/** One Workspace's row; a worktree under its project is indented. */
const workspaceRow = (escape: Escape, time: Time, view: WorkspacesView, row: WorkspaceRow, nested: boolean): string => {
  const pill = PILLS[row.status];
  const references = row.references.length > 0 ? escape(row.references.join("; ")) : row.unreferencedSince === null ? "nothing" : `nothing since ${time(row.unreferencedSince)}`;
  const facts = [row.repo === null ? "" : escape(row.repo), row.deletedAt === null ? "" : `removed ${time(row.deletedAt)}`].filter((fact) => fact !== "").join(" · ");
  const purge = {
    id: row.id,
    name: row.confirmName,
    title: row.title,
    // Each member with its status: the dialog calls out a kept Tombstone (work a removal could not check).
    goes: [...row.worktrees, row].map((member) => ({ id: member.id, status: member.status })),
    sessions: row.sessions,
  };
  const actions = [
    row.can.purge
      ? `<button type="button" class="btn btn-sm btn-danger" data-workspace-purge="${escape(JSON.stringify(purge))}" aria-label="Purge now: ${escape(row.title)}">${icon("trash")}Purge now</button><span class="hint">purges its files for good</span>`
      : "",
    row.can.restore ? `<button type="button" class="btn btn-sm" data-workspace-restore="${escape(row.id)}" aria-label="Restore ${escape(row.title)}">Restore</button>` : "",
    row.can.stop ? `<button type="button" class="btn btn-sm" data-workspace-stop="${escape(row.id)}" aria-label="Stop the Container of ${escape(row.title)}">Stop Container</button>` : "",
  ].filter((action) => action !== "");
  return `<tr data-workspace="${escape(row.id)}"${nested ? ' class="wt"' : ""}><td data-label="Workspace"><div><strong>${pathHtml(escape, row.title)}</strong><span class="src"><code>${pathHtml(escape, row.id)}</code>${facts === "" ? "" : ` · ${facts}`}</span></div></td><td data-label="Status"><div><span class="pill${pill === "" ? "" : ` ${pill}`}">${escape(row.status)}</span>${
    row.lastError === null ? "" : `<span class="src">${escape(row.lastError)}</span>`
  }</div></td><td data-label="Referenced by"><div>${references}</div></td><td data-label="Purged"><div>${purgeCell(escape, time, view, row)}</div></td><td class="files" data-label="Files"><div data-workspace-usage="${escape(row.id)}">—</div></td><td class="actions" data-label="Act"><div class="workspace-actions">${actions.join("")}</div></td></tr>`;
};

/** The typed-name dialog (ADR-0044 §4): the script fills it from the Purge button's data, and posts the typed name. */
const PURGE_DIALOG = `<dialog class="dialog" data-purge-dialog aria-labelledby="purge-dialog-title">
<h3 id="purge-dialog-title">Purge <span data-purge-title></span> now?</h3>
<p class="desc">This purges its files for good, with its Container and its deleted threads' Sessions; nothing brings them back. These go:</p>
<ul class="purge-goes" data-purge-goes></ul>
<div class="callout callout-warn" role="note" data-purge-kept hidden>${icon("warn")}<div><strong>A kept Tombstone goes with it</strong><p>It holds work a removal could not check, which nothing else keeps: <span data-purge-kept-ids></span></p></div></div>
<p class="desc" data-purge-sessions></p>
<div class="field"><label for="purge-confirm">Type <code data-purge-name></code> to purge it</label><input type="text" id="purge-confirm" data-purge-confirm autocomplete="off" autocapitalize="none" spellcheck="false"></div>
<div class="dialog-foot"><button type="button" class="btn btn-sm" data-purge-cancel>Cancel</button><button type="button" class="btn btn-sm btn-destroy" data-purge-go disabled>${icon("trash")}Purge now</button></div>
</dialog>`;

/** Every Workspace (ADR-0044 §1), or the empty state; a failed read says so. */
export const workspacesSection = (escape: Escape, time: Time, input: WorkspacesSectionInput | undefined): string => {
  if (input === undefined) return "";
  const head = `<div class="section-head"><h2 id="workspaces-title">${icon("folder")}Workspaces</h2>${
    "error" in input ? "" : `<div class="section-actions"><button type="button" class="btn btn-sm" data-sweep-preview>Preview the Sweep</button><button type="button" class="btn btn-sm" data-sweep-run>${icon("play")}Run the Sweep</button></div>`
  }</div>
<p class="section-desc">Every Workspace's files, kept while something in t3 references them: a live or archived project or thread, an open run, an open Terminal. When nothing does, the Sweep purges them once the Grace has passed; a Tombstone is a removed worktree kept for its Grace. Purge now purges a Workspace nothing references at once, with its Worktree Workspaces.</p>`;
  if ("error" in input) {
    return `<section id="workspaces" aria-labelledby="workspaces-title">
${head}
<div class="group"><div class="callout" role="note">${icon("alert")}<div><strong>The Workspaces could not be read</strong><p class="mono">${escape(input.error)}</p><p>Nothing can be purged until they can: a Purge reads the references first, as the Sweep does.</p></div></div></div>
</section>`;
  }
  const rows = input.rows.flatMap((row) => [workspaceRow(escape, time, input, row, false), ...row.worktrees.map((worktree) => workspaceRow(escape, time, input, worktree, true))]);
  const table =
    rows.length === 0
      ? `<div class="empty"><span class="empty-icon">${icon("folder")}</span><h3>No Workspaces</h3><p>A project or a worktree thread in t3 makes one.</p></div>`
      : `<div class="table-wrap"><table class="stacked workspaces"><thead><tr><th scope="col">Workspace</th><th scope="col">Status</th><th scope="col">Referenced by</th><th scope="col">Purged</th><th scope="col" class="files">Files</th><th scope="col"><span class="sr">Act</span></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  return `<section id="workspaces" aria-labelledby="workspaces-title">
${head}
${graceForm(escape, time, input)}
<div class="group sweep-out" data-sweep-out aria-live="polite" hidden></div>
<div class="group">${table}</div>
<p class="section-desc">Files is the Workspace's own storage; a running Container's disk is not counted.</p>
${PURGE_DIALOG}
</section>`;
};

/** The section's behaviour, appended to the page's one script: answers go in with textContent, never as HTML. */
export const WORKSPACES_SCRIPT = `
// The Workspaces section (ADR-0044): the Grace's control, the Files column, the typed-name Purge, Restore, Stop, the Sweep.
const graceForm = document.querySelector("form[data-grace]");
if (graceForm !== null) {
  const save = graceForm.querySelector("[data-save]");
  const note = graceForm.querySelector("[data-save-note]");
  const days = graceForm.querySelector("[data-grace-days]");
  const never = () => graceForm.querySelector("[name=grace]:checked").value === "never";
  const sync = () => { days.disabled = never(); };
  for (const input of graceForm.querySelectorAll("input")) {
    input.addEventListener("input", () => { save.disabled = false; note.textContent = "Unsaved changes"; sync(); });
    input.addEventListener("change", sync);
  }
  sync();
  graceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!never() && !days.reportValidity()) return;
    const settings = never() ? { sweepPurges: false } : { sweepPurges: true, graceDays: Number(days.value) };
    if (await post("/_t3flare/settings/api/environment", { settings }, save)) done();
  });
}
const sizeOf = (bytes) => (bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KiB" : (bytes / 1048576).toFixed(1) + " MiB");
// One request per row, one at a time, after the table renders (ADR-0044 §1): none starts a Container.
(async () => {
  for (const cell of document.querySelectorAll("[data-workspace-usage]")) {
    try {
      const usage = await getJson("/_t3flare/settings/api/workspaces/usage?id=" + encodeURIComponent(cell.dataset.workspaceUsage));
      cell.textContent = sizeOf(usage.bytes) + (usage.containerRunning ? ", Container running" : "");
    } catch (error) { cell.textContent = "unknown"; }
  }
})();
const purgeDialog = document.querySelector("dialog[data-purge-dialog]");
if (purgeDialog !== null) {
  const typed = purgeDialog.querySelector("[data-purge-confirm]");
  const go = purgeDialog.querySelector("[data-purge-go]");
  let current = null;
  typed.addEventListener("input", () => { go.disabled = current === null || typed.value !== current.name; });
  purgeDialog.querySelector("[data-purge-cancel]").addEventListener("click", () => purgeDialog.close());
  for (const button of document.querySelectorAll("button[data-workspace-purge]")) {
    button.addEventListener("click", () => {
      current = JSON.parse(button.dataset.workspacePurge);
      purgeDialog.querySelector("[data-purge-title]").textContent = current.title;
      purgeDialog.querySelector("[data-purge-name]").textContent = current.name;
      purgeDialog.querySelector("[data-purge-goes]").replaceChildren(...current.goes.map((member) => el("li", member.id + " (" + member.status + ")")));
      const kept = current.goes.filter((member) => member.status === "tombstone (kept)").map((member) => member.id);
      purgeDialog.querySelector("[data-purge-kept-ids]").textContent = kept.join(", ");
      purgeDialog.querySelector("[data-purge-kept]").hidden = kept.length === 0;
      purgeDialog.querySelector("[data-purge-sessions]").textContent = current.sessions === 0 ? "No deleted thread's Session goes with it." : current.sessions + (current.sessions === 1 ? " deleted thread's Session goes" : " deleted threads' Sessions go") + " with it.";
      typed.value = "";
      go.disabled = true;
      purgeDialog.showModal();
      typed.focus();
    });
  }
  go.addEventListener("click", async () => {
    const response = await post("/_t3flare/settings/api/workspaces/purge", { id: current.id, confirm: typed.value }, go);
    purgeDialog.close();
    if (response !== undefined) done();
  });
}
for (const button of document.querySelectorAll("button[data-workspace-restore]")) {
  button.addEventListener("click", async () => {
    const id = button.dataset.workspaceRestore;
    if (!confirm("Restore " + id + "? The Tombstone is back at its path, and t3 lists the worktree again. Nothing references it yet, so its Grace starts over now, unless a thread in t3 takes the worktree again.")) return;
    if (await post("/_t3flare/settings/api/workspaces/restore", { id }, button)) done();
  });
}
for (const button of document.querySelectorAll("button[data-workspace-stop]")) {
  button.addEventListener("click", async () => {
    if (await post("/_t3flare/settings/api/workspaces/stop", { id: button.dataset.workspaceStop }, button)) done();
  });
}
const sweepOut = document.querySelector("[data-sweep-out]");
const showSweep = (preview) => {
  const list = el("ul");
  for (const row of preview.rows) list.append(el("li", row.id + ": " + row.action + ", " + row.why));
  const nodes = [el("p", preview.summary, preview.ok ? undefined : "err")];
  if (preview.rows.length > 0) nodes.push(list);
  if (preview.sessions.length > 0) nodes.push(el("p", "Sessions of deleted threads: " + preview.sessions.join(", "), "note"));
  if (preview.containers.length > 0) nodes.push(el("p", "Containers no Workspace holds: " + preview.containers.join(", "), "note"));
  sweepOut.replaceChildren(...nodes);
  sweepOut.hidden = false;
};
const previewing = document.querySelector("button[data-sweep-preview]");
if (previewing !== null && sweepOut !== null) {
  previewing.addEventListener("click", async () => {
    busy(previewing, true);
    try { showSweep(await getJson("/_t3flare/settings/api/workspaces/sweep")); } catch (error) { notify("err", error.message); }
    busy(previewing, false);
  });
}
const sweeping = document.querySelector("button[data-sweep-run]");
if (sweeping !== null && sweepOut !== null) {
  sweeping.addEventListener("click", async () => {
    if (!confirm("Run the Sweep now? It purges what is past its Grace, as it would at its next run.")) return;
    const response = await post("/_t3flare/settings/api/workspaces/sweep", {}, sweeping);
    busy(sweeping, false);
    if (response === undefined) return;
    showSweep(await response.json());
    setTimeout(() => location.reload(), 2500);
  });
}`;
