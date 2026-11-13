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
const settingsOf = (form) => {
  const settings = {};
  for (const input of form.querySelectorAll("[data-setting]")) {
    const kind = input.dataset.kind;
    settings[input.dataset.setting] = kind === "boolean" ? input.checked : kind === "integer" ? Number(input.value) : input.value;
  }
  return settings;
};
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
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.reportValidity() && (await post("/_t3flare/harness/api/environment", { settings: settingsOf(form) }, save))) done();
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
