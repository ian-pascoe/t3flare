// The harness panel's one script (ADR-0026), allowed by its SHA-256 hash in the CSP, so it is a constant. It only turns
// the page's controls into calls to the panel's JSON API (with the CSRF token from the page's meta tag) and shows their
// progress and outcome. It writes server answers with `textContent`, never as HTML. Without it the page still reads.
export const SCRIPT = `"use strict";
const csrf = document.querySelector('meta[name="t3flare-csrf"]').getAttribute("content");
const notice = document.getElementById("result");
const noticeText = notice.querySelector(".msg");
const notify = (tone, text) => {
  notice.dataset.tone = tone;
  noticeText.textContent = text;
  notice.hidden = false;
  notice.setAttribute("role", tone === "err" ? "alert" : "status");
};
notice.querySelector("[data-dismiss]").addEventListener("click", () => { notice.hidden = true; });
const busy = (element, on) => {
  if (element === null || element === undefined) return;
  element.setAttribute("aria-busy", on ? "true" : "false");
  element.disabled = on;
};
const post = async (path, body, control) => {
  busy(control, true);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-t3flare-csrf": csrf },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    if (response.ok) return response;
    notify("err", "Refused (" + response.status + "): " + (await response.text()).trim());
  } catch (error) {
    notify("err", "Could not reach the panel: " + (error && error.message ? error.message : String(error)));
  }
  busy(control, false);
  return undefined;
};
const done = () => location.reload();
for (const button of document.querySelectorAll("button[data-mcp]")) {
  button.addEventListener("click", async () => {
    const change = JSON.parse(button.dataset.mcp);
    if (change.op === "remove" && !confirm("Remove " + change.server + " and its sign-in? Agents lose its tools at their next turn.")) return;
    if (await post("/_t3flare/harness/api/mcp", change, button)) done();
  });
}
for (const select of document.querySelectorAll("select[data-mcp-exposure]")) {
  select.addEventListener("change", async () => {
    const server = select.dataset.mcpExposure;
    const change = select.dataset.tool === undefined
      ? { op: "server", server, exposure: select.value }
      : { op: "server", server, toolExposure: { [select.dataset.tool]: select.value === "" ? null : select.value } };
    if (await post("/_t3flare/harness/api/mcp", change, select)) done();
    else select.value = select.querySelector("option[selected]").value;
  });
}
for (const button of document.querySelectorAll("button[data-mcp-test]")) {
  button.addEventListener("click", async () => {
    const server = button.dataset.mcpTest;
    const out = document.querySelector('[data-test-result="' + CSS.escape(server) + '"]');
    out.dataset.tone = "";
    out.textContent = "Testing…";
    const response = await post("/_t3flare/harness/api/mcp/test", { server }, button);
    busy(button, false);
    if (response === undefined) { out.textContent = ""; return; }
    const answer = await response.json();
    if (answer.status === "ok") {
      out.dataset.tone = "ok";
      out.textContent = "Listed " + answer.tools + (answer.tools === 1 ? " tool" : " tools") + (answer.refused > 0 ? " (" + answer.refused + " refused)" : "") + " in " + answer.ms + " ms. Reload to see them.";
    } else {
      out.dataset.tone = "err";
      out.textContent = "Failed: " + (answer.error || answer.status);
    }
  });
}
for (const button of document.querySelectorAll("button[data-mcp-oauth]")) {
  button.addEventListener("click", async () => {
    const response = await post("/_t3flare/harness/api/mcp/oauth", { server: button.dataset.mcpOauth }, button);
    busy(button, false);
    if (response === undefined) return;
    const answer = await response.json();
    const target = new URL(answer.authorizationUrl);
    if (target.protocol !== "https:") { notify("err", "The sign-in URL is not https; not opened."); return; }
    window.open(target.toString(), "_blank", "noopener,noreferrer");
    notify("ok", "Finish signing in to " + button.dataset.mcpOauth + " in the new tab, then reload this page.");
  });
}
const adding = document.querySelector("form[data-mcp-add]");
if (adding !== null) {
  const kinds = adding.querySelectorAll("[name=auth]");
  const headerFields = adding.querySelector("[data-header-fields]");
  const kind = () => adding.querySelector("[name=auth]:checked").value;
  const showHeader = () => {
    const on = kind() === "header";
    headerFields.hidden = !on;
    for (const input of headerFields.querySelectorAll("input")) input.disabled = !on;
  };
  for (const input of kinds) input.addEventListener("change", showHeader);
  showHeader();
  adding.addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = (name) => adding.querySelector("[name=" + name + "]").value.trim();
    const body = { server: field("server"), url: field("url"), auth: { kind: kind() } };
    if (body.auth.kind === "header") {
      body.auth.header = field("header");
      body.value = adding.querySelector("[name=value]").value;
    }
    const response = await post("/_t3flare/harness/api/mcp/servers", body, adding.querySelector("[type=submit]"));
    adding.querySelector("[name=value]").value = "";
    if (response !== undefined) done();
  });
}
// A Variables list's rows as { NAME: "value" }; a row with neither a name nor a value is skipped. A name listed twice
// is refused here, before the save, since an object would keep only the last.
const variablesOf = (list) => {
  const variables = {};
  for (const row of list.querySelectorAll("[data-variable]")) {
    const name = row.querySelector("[data-variable-name]").value.trim();
    const value = row.querySelector("[data-variable-value]").value;
    if (name === "" && value === "") continue;
    if (Object.prototype.hasOwnProperty.call(variables, name)) throw new Error("The Variable " + JSON.stringify(name) + " is listed twice; keep one.");
    variables[name] = value;
  }
  return variables;
};
const settingsOf = (form) => {
  const settings = {};
  for (const input of form.querySelectorAll("[data-setting]")) {
    const kind = input.dataset.kind;
    settings[input.dataset.setting] = kind === "boolean" ? input.checked : kind === "integer" ? Number(input.value) : kind === "variables" ? variablesOf(input) : input.value;
  }
  return settings;
};
for (const list of document.querySelectorAll('[data-kind="variables"]')) {
  const rows = list.querySelector("[data-variable-rows]");
  const changed = () => list.dispatchEvent(new Event("input", { bubbles: true }));
  const removable = (row) => row.querySelector("[data-variable-remove]").addEventListener("click", () => { row.remove(); changed(); });
  for (const row of rows.querySelectorAll("[data-variable]")) removable(row);
  list.querySelector("[data-variable-add]").addEventListener("click", () => {
    const row = list.querySelector("[data-variable-template]").content.firstElementChild.cloneNode(true);
    rows.append(row);
    removable(row);
    row.querySelector("[data-variable-name]").focus();
    changed();
  });
}
const watchUnsaved = (form) => {
  const save = form.querySelector("[data-save]");
  const note = form.querySelector("[data-save-note]");
  for (const input of form.querySelectorAll("[data-setting]")) {
    input.addEventListener("input", () => {
      if (save !== null) save.disabled = false;
      if (note !== null) note.textContent = "Unsaved changes";
    });
  }
};
for (const form of document.querySelectorAll("form[data-environment]")) {
  const save = form.querySelector("[data-save]");
  watchUnsaved(form);
  // The cost table follows the size and budget inputs before a save: the budget column, the current row, the summary.
  const size = form.querySelector('[data-setting="containerSize"]');
  const budget = form.querySelector('[data-setting="containerBudget"]');
  const cost = () => {
    const count = Number(budget === null ? NaN : budget.value);
    if (!Number.isInteger(count) || count < 1) return;
    const containers = count + (count === 1 ? " Container" : " Containers");
    const head = document.querySelector("[data-budget-head]");
    if (head !== null) head.textContent = containers + ", an hour";
    let current = null;
    for (const row of document.querySelectorAll("tr[data-per-hour]")) {
      const per = Number(row.dataset.perHour);
      row.querySelector("[data-budget-hour]").textContent = "$" + (per * count).toFixed(2);
      row.querySelector("[data-budget-cell]").dataset.label = containers + ", an hour";
      if (size !== null && row.dataset.size === size.value) { row.setAttribute("aria-current", "true"); current = row; }
      else row.removeAttribute("aria-current");
    }
    const now = document.querySelector("[data-cost-now]");
    if (now !== null && current !== null) now.textContent = "With these settings, at most $" + (Number(current.dataset.perHour) * count).toFixed(2) + " an hour: " + containers + " of " + current.dataset.size + ", every vCPU busy.";
  };
  for (const input of [size, budget]) if (input !== null) { input.addEventListener("input", cost); input.addEventListener("change", cost); }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    let settings;
    try {
      settings = settingsOf(form);
    } catch (error) {
      notify("err", error.message);
      return;
    }
    if (await post("/_t3flare/harness/api/environment", { settings }, save)) done();
  });
}
for (const form of document.querySelectorAll("form[data-extension]")) {
  const save = form.querySelector("[data-save]");
  const send = async (control) => {
    const change = { extension: form.dataset.extension };
    const settings = settingsOf(form);
    if (Object.keys(settings).length > 0) change.settings = settings;
    const enabled = form.querySelector("[data-enabled]");
    if (enabled !== null) change.enabled = enabled.checked;
    if (await post("/_t3flare/harness/api/extensions", change, control)) done();
    else if (control !== save && enabled !== null) enabled.checked = !enabled.checked;
  };
  const switched = form.querySelector("[data-enabled]");
  if (switched !== null) switched.addEventListener("change", () => send(switched));
  watchUnsaved(form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.reportValidity()) send(save);
  });
}
// Environment skills (SPI-1148): every answer is built with textContent and createElement, never as HTML.
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
};
const kib = (bytes) => (bytes / 1024).toFixed(1) + " KiB";
const show = (out, ...nodes) => { out.replaceChildren(...nodes); };
const failed = (out, text) => show(out, el("p", text, "err"));
const getJson = async (path) => {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error("Refused (" + response.status + "): " + (await response.text()).trim());
  return response.json();
};
const preview = document.querySelector("[data-skill-preview]");
const installing = document.querySelector("form[data-skill-install]");
if (installing !== null && preview !== null) {
  installing.addEventListener("submit", async (event) => {
    event.preventDefault();
    const source = installing.querySelector("[name=source]").value.trim();
    show(preview, el("p", "Reading " + source + " from GitHub…"));
    const response = await post("/_t3flare/harness/api/skills/preview", { source }, installing.querySelector("[type=submit]"));
    busy(installing.querySelector("[type=submit]"), false);
    if (response === undefined) { show(preview); return; }
    const answer = await response.json();
    const nodes = [el("p", answer.repo + " at " + answer.commit.slice(0, 7) + (answer.ref === null ? " (the default branch)" : " (" + answer.ref + ")") + ". " + answer.note)];
    if (answer.how === "unauthenticated") nodes.push(el("p", "Read without a token, from GitHub's shared limit of 60 an hour.", "note"));
    const picks = [];
    for (const skill of answer.skills) {
      const row = el("label", undefined, "skill-pick");
      const box = el("input");
      box.type = "checkbox";
      box.value = skill.path;
      const blocked = skill.problems.length > 0 || skill.unchanged === true;
      box.disabled = blocked;
      box.checked = !blocked;
      const text = el("span");
      text.append(el("strong", skill.name), el("span", " " + skill.description));
      const notes = [skill.files + (skill.files === 1 ? " file, " : " files, ") + kib(skill.bytes)];
      if (skill.unchanged === true) notes.push("unchanged: installed with these files from this source");
      if (skill.replaces !== undefined) notes.push("replaces " + skill.name + " from " + skill.replaces.repo + (skill.replaces.path === "" ? "" : "/" + skill.replaces.path) + " at " + skill.replaces.commit);
      for (const problem of skill.problems) notes.push("cannot be installed: " + problem);
      text.append(el("span", notes.join("; "), skill.problems.length > 0 ? "note err" : "note"));
      row.append(box, text);
      picks.push(box);
      nodes.push(row);
    }
    for (const skip of answer.unreadable) nodes.push(el("p", (skip.path || "SKILL.md") + ": " + skip.message, "note"));
    if (answer.internal > 0) nodes.push(el("p", answer.internal + " internal skills left out; name one with owner/repo@skill.", "note"));
    if (answer.omitted > 0) nodes.push(el("p", answer.omitted + " more SKILL.md files not read; name a folder with a tree URL.", "note"));
    const install = el("button", "Install selected", "btn btn-primary btn-sm");
    install.type = "button";
    install.addEventListener("click", async () => {
      const folders = picks.filter((box) => box.checked).map((box) => box.value);
      if (folders.length === 0) { notify("err", "Pick at least one skill."); return; }
      const done = await post("/_t3flare/harness/api/skills/install", { source, commit: answer.commit, folders }, install);
      busy(install, false);
      if (done === undefined) return;
      const result = await done.json();
      const lines = result.results.map((entry) => entry.name + ": " + (entry.error === undefined ? entry.action : entry.error));
      notify(result.results.every((entry) => entry.error === undefined) ? "ok" : "err", lines.join(" · "));
      if (result.results.some((entry) => entry.error === undefined)) setTimeout(() => location.reload(), 1500);
    });
    nodes.push(install);
    show(preview, ...nodes);
  });
}
const outOf = (name) => document.querySelector('[data-skill-out="' + CSS.escape(name) + '"]');
for (const button of document.querySelectorAll("button[data-skill-view]")) {
  button.addEventListener("click", async () => {
    const name = button.dataset.skillView;
    const out = outOf(name);
    try {
      const view = await getJson("/_t3flare/harness/api/skills/view?name=" + encodeURIComponent(name));
      const list = el("ul");
      for (const file of view.files) {
        const item = el("li");
        if (file.url.startsWith("https://github.com/")) {
          const link = el("a", file.path);
          link.href = file.url;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          item.append(link, el("span", " " + kib(file.size)));
        } else item.textContent = file.path + " " + kib(file.size);
        list.append(item);
      }
      show(out, el("pre", view.skillMd), list);
    } catch (error) { failed(out, error.message); }
  });
}
for (const button of document.querySelectorAll("button[data-skill-check]")) {
  button.addEventListener("click", async () => {
    const name = button.dataset.skillCheck;
    const response = await post("/_t3flare/harness/api/skills/check", name === "" ? {} : { names: [name] }, button);
    busy(button, false);
    if (response === undefined) return;
    const answer = await response.json();
    for (const result of answer.results) {
      const out = outOf(result.name);
      if (out === null) continue;
      if (result.status === "current") { show(out, el("p", "Up to date at " + result.from + ".")); continue; }
      if (result.status !== "update") { failed(out, result.message); continue; }
      const parts = [["added", result.added], ["changed", result.changed], ["removed", result.removed]].filter(([, paths]) => paths.length > 0).map(([what, paths]) => what + ": " + paths.join(", "));
      const update = el("button", "Update to " + result.to, "btn btn-primary btn-sm");
      update.type = "button";
      update.addEventListener("click", async () => {
        const done = await post("/_t3flare/harness/api/skills/update", { name: result.name, commit: result.commit }, update);
        busy(update, false);
        if (done === undefined) return;
        const updated = await done.json();
        notify("ok", updated.name + " updated from " + updated.from.slice(0, 7) + " to " + updated.to.slice(0, 7) + ".");
        setTimeout(() => location.reload(), 1500);
      });
      show(out, el("p", "An update: " + result.from + " → " + result.to + ". " + (parts.length === 0 ? "" : parts.join("; ") + ".")), update);
    }
    if (answer.how === "unauthenticated") notify("ok", "Checked without a token, from GitHub's shared limit of 60 an hour." + (answer.note === undefined ? "" : " " + answer.note));
    else if (answer.note !== undefined) notify("ok", answer.note);
  });
}
for (const button of document.querySelectorAll("button[data-skill-remove]")) {
  button.addEventListener("click", async () => {
    const name = button.dataset.skillRemove;
    if (!confirm("Remove the Environment skill " + name + "? Agents lose it at their next turn.")) return;
    if (await post("/_t3flare/harness/api/skills/remove", { name }, button)) done();
  });
}
for (const input of document.querySelectorAll("input[data-skill-enable]")) {
  input.addEventListener("change", async () => {
    if (await post("/_t3flare/harness/api/skills/enable", { name: input.dataset.skillEnable, enabled: input.checked }, input)) done();
    else input.checked = !input.checked;
  });
}
const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
for (const time of document.querySelectorAll("time[data-local]")) {
  const at = new Date(time.getAttribute("datetime"));
  if (!Number.isNaN(at.getTime())) { time.title = time.textContent; time.textContent = format.format(at); }
}
const links = new Map([...document.querySelectorAll(".nav a")].map((link) => [link.getAttribute("href").slice(1), link]));
const mark = (id) => { for (const [key, link] of links) { if (key === id) link.setAttribute("aria-current", "location"); else link.removeAttribute("aria-current"); } };
if ("IntersectionObserver" in window) {
  const seen = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) { if (entry.isIntersecting) seen.add(entry.target.id); else seen.delete(entry.target.id); }
    const first = [...links.keys()].find((id) => seen.has(id));
    if (first !== undefined) mark(first);
  }, { rootMargin: "-20% 0px -60% 0px" });
  for (const id of links.keys()) { const section = document.getElementById(id); if (section !== null) observer.observe(section); }
}`;
