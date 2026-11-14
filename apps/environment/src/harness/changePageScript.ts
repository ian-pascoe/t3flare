// The Change page's one script (plan D10), allowed by its SHA-256 hash in the page's CSP, so it is a constant. It only
// sends the owner's Approve or Decline (with a typed header value, for a change that takes one) to the page's JSON API
// with the CSRF token from the meta tag, and shows the answer with `textContent`, never as HTML. A sign-in's approval
// answers its authorization URL, and the script sends the browser there (https only), as the panel's own sign-in does.
// No script computes a diff: the page is rendered by the server.
import { CHANGES_API_PATH } from "./paths.ts";

export const CHANGE_SCRIPT = `"use strict";
const csrf = document.querySelector('meta[name="t3flare-csrf"]').getAttribute("content");
const form = document.querySelector("form[data-change]");
const out = document.getElementById("result");
const say = (tone, text) => { out.dataset.tone = tone; out.textContent = text; out.hidden = false; };
const outcomes = {
  applied: "Applied.",
  declined: "Declined: nothing changed.",
  moved: "Not applied: the settings moved since the change was asked. Nothing changed.",
  expired: "Expired: nothing changed.",
  withdrawn: "Withdrawn: nothing changed.",
  failed: "Not applied: ",
};
if (form !== null) {
  const secret = document.querySelector("input[name=value]");
  const buttons = [...form.querySelectorAll("button[data-action]")];
  form.addEventListener("submit", (event) => event.preventDefault());
  for (const button of buttons) {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const body = { action };
      if (action === "approve" && secret !== null) {
        if (secret.value === "") { say("err", "Type the header value first."); secret.focus(); return; }
        body.value = secret.value;
      }
      for (const each of buttons) each.disabled = true;
      let response;
      try {
        response = await fetch(${JSON.stringify(`${CHANGES_API_PATH}/`)} + encodeURIComponent(form.dataset.change), {
          method: "POST",
          headers: { "content-type": "application/json", "x-t3flare-csrf": csrf },
          body: JSON.stringify(body),
          credentials: "same-origin",
        });
      } catch (error) {
        say("err", "Could not reach the panel: " + (error && error.message ? error.message : String(error)));
        for (const each of buttons) each.disabled = false;
        return;
      }
      if (secret !== null) secret.value = "";
      if (!response.ok) {
        say("err", "Refused (" + response.status + "): " + (await response.text()).trim());
        if (response.status !== 409) for (const each of buttons) each.disabled = false;
        return;
      }
      const answer = await response.json();
      if (typeof answer.authorizationUrl === "string") {
        const target = new URL(answer.authorizationUrl);
        if (target.protocol !== "https:") { say("err", "The sign-in URL is not https; not opened."); return; }
        say("ok", "Sending you to the sign-in…");
        location.assign(target.toString());
        return;
      }
      const text = (outcomes[answer.status] || answer.status) + (answer.status === "failed" ? String(answer.error || "") : "") + (answer.revision === undefined ? "" : " Revision " + answer.revision + ".");
      say(answer.status === "applied" || answer.status === "declined" ? "ok" : "err", text);
      form.hidden = true;
    });
  }
}
const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
for (const time of document.querySelectorAll("time[data-local]")) {
  const at = new Date(time.getAttribute("datetime"));
  if (!Number.isNaN(at.getTime())) { time.title = time.textContent; time.textContent = format.format(at); }
}`;
