// @effect-diagnostics globalDate:off
// The Harness panel's Model endpoints section (SPI-1162): each endpoint with its API, base URL, key mark and models, and
// one form that adds or edits an endpoint, filled from a preset or from the endpoint being edited. Every string is
// escaped (page.ts's rule). Its behaviour is ENDPOINTS_SCRIPT, part of the page's one script.
//
// SPI-1164: one "Sign in with <title>" form per sign-in kind (`SIGN_IN_KINDS`; ChatGPT plan usage first): start, open
// the authorize link, paste what it gives back (ChatGPT's: the 127.0.0.1 address the browser lands on, a page that does not
// load), and see the account or why it failed. A sign-in endpoint's card shows its account and token expiry, with Sign
// out. Each says plainly what is verified of it (its kind's `note`). SPI-1165 adds Claude, whose vendor offers no
// revocation: its Sign out says where the owner removes the grant (its kind's `revocation`).
import { endpointSlug, type EndpointApi, type EndpointPreset, isSignIn, type ModelEndpoint, SIGN_IN_KINDS, SIGN_INS, type SignIn } from "@t3flare/models/endpoints";

import type { SignInStatus } from "../credentials/broker.ts";
import type { SealedMark } from "../credentials/sealed.ts";
import { icon } from "./pageIcons.ts";

/** The section's input (endpoints/api.ts `endpointsOverview`). */
export interface EndpointsView {
  readonly revision: number;
  readonly credentialsKey: boolean;
  readonly endpoints: ReadonlyArray<ModelEndpoint & { readonly key: SealedMark; readonly signIn?: SignInStatus }>;
  /** Sign-ins under way (or failed) for endpoints not saved yet, by id. Absent without a Credential broker. */
  readonly signIns?: Readonly<Record<string, SignInStatus>>;
  readonly presets: ReadonlyArray<EndpointPreset>;
  readonly apis: ReadonlyArray<EndpointApi>;
}

type Escape = (text: string) => string;

const keyFact = (escape: Escape, endpoint: EndpointsView["endpoints"][number]): string => {
  if (endpoint.auth === "none") return "None";
  if (!endpoint.key.set) return '<span class="pill pill-warn">no key</span>';
  if (endpoint.key.readable === false) return '<span class="pill pill-err" title="This Environment\'s credentials key no longer opens it">cannot be read: enter it again</span>';
  return `Set${endpoint.key.fingerprint === null ? "" : ` <span class="ident" title="Fingerprint: an HMAC of the key, never the key">#${escape(endpoint.key.fingerprint)}</span>`}`;
};

/** When, as the page shows times (UTC, to the minute). */
const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** A sign-in's facts: the account, the token's expiry, a sign-in waiting for its paste, the last problem. */
const signInFacts = (escape: Escape, status: SignInStatus | undefined): string => {
  if (status === undefined) return "";
  const account = status.signedIn ? escape(status.email ?? "signed in") : '<span class="pill pill-warn">not signed in</span>';
  return `<div><dt>Account</dt><dd>${account}</dd></div>${status.signedIn && status.expiresAt !== null ? `<div><dt>Token</dt><dd>renews before ${escape(when(status.expiresAt))}</dd></div>` : ""}${
    status.pendingSince === null ? "" : `<div><dt>Sign-in</dt><dd>waiting for its paste since ${escape(when(status.pendingSince))}</dd></div>`
  }${status.problem === null ? "" : `<div><dt>Problem</dt><dd class="sign-in-problem">${escape(status.problem)}</dd></div>`}`;
};

const endpointCard = (escape: Escape, endpoint: EndpointsView["endpoints"][number]): string => {
  if (isSignIn(endpoint.auth)) return signInCard(escape, endpoint, endpoint.auth);
  const id = escape(`endpoint-${endpoint.id}`);
  // What the form needs to edit it: never the key, which the endpoint keeps unless a new one is typed.
  const editable = { id: endpoint.id, label: endpoint.label, api: endpoint.api, baseUrl: endpoint.baseUrl, auth: endpoint.auth, headers: endpoint.headers, models: endpoint.models.map((model) => model.id) };
  const models = endpoint.models
    .map(
      (model) =>
        `<li><code>${escape(endpointSlug(endpoint.id, model.id))}</code> ${escape(model.name)}${model.reasoning ? ' <span class="tag">thinking</span>' : ""}${model.known ? "" : ' <span class="tag" title="pi-ai\'s catalog does not know it: default limits, no price">unknown</span>'}</li>`,
    )
    .join("");
  return `<article class="group server" aria-labelledby="${id}" data-endpoint-row="${escape(endpoint.id)}">
<div class="server-head"><div><div class="server-name"><h3 id="${id}">${escape(endpoint.label)}</h3><span class="ident">${escape(endpoint.id)}</span><span class="tag">${escape(endpoint.api)}</span></div><p class="server-url">${escape(endpoint.baseUrl)}</p></div>
<dl class="facts"><div><dt>Models</dt><dd>${endpoint.models.length}</dd></div><div><dt>API key</dt><dd>${keyFact(escape, endpoint)}</dd></div>${
    Object.keys(endpoint.headers).length === 0 ? "" : `<div><dt>Headers</dt><dd>${Object.keys(endpoint.headers).map((name) => `<code>${escape(name)}</code>`).join(", ")}</dd></div>`
  }</dl></div>
<div class="server-actions"><button type="button" class="btn btn-sm" data-endpoint-edit="${escape(JSON.stringify(editable))}">Edit</button><span class="spacer"></span><button type="button" class="btn btn-sm btn-danger" data-endpoint-remove="${escape(endpoint.id)}" aria-label="Remove ${escape(endpoint.label)}">${icon("trash")}Remove</button></div>
<details class="tools"${endpoint.models.length <= 12 ? " open" : ""}><summary>${icon("chevron")}Models</summary><ul class="endpoint-models">${models}</ul></details></article>`;
};

/** A sign-in endpoint's card: its account and Sign out (or Sign in again), its models; no key, no Edit of its target. */
const signInCard = (escape: Escape, endpoint: EndpointsView["endpoints"][number], kind: SignIn): string => {
  const signIn = SIGN_IN_KINDS[kind];
  const id = escape(`endpoint-${endpoint.id}`);
  const editable = { id: endpoint.id, label: endpoint.label, api: endpoint.api, baseUrl: endpoint.baseUrl, auth: endpoint.auth, headers: {}, models: endpoint.models.map((model) => model.id) };
  const models = endpoint.models.map((model) => `<li><code>${escape(endpointSlug(endpoint.id, model.id))}</code> ${escape(model.name)}</li>`).join("");
  const action =
    endpoint.signIn?.signedIn === true
      ? `<button type="button" class="btn btn-sm" data-sign-in-out="${escape(endpoint.id)}" data-sign-in-title="${escape(signIn.title)}"${
          signIn.revocation === null ? "" : ` data-sign-in-revocation="${escape(signIn.revocation)}"`
        }>Sign out</button>`
      : `<button type="button" class="btn btn-sm btn-primary" data-sign-in-start="${escape(endpoint.id)}" data-sign-in-kind="${escape(kind)}" data-sign-in-label="${escape(endpoint.label)}">Sign in with ${escape(signIn.title)}</button>`;
  return `<article class="group server" aria-labelledby="${id}" data-endpoint-row="${escape(endpoint.id)}">
<div class="server-head"><div><div class="server-name"><h3 id="${id}">${escape(endpoint.label)}</h3><span class="ident">${escape(endpoint.id)}</span><span class="tag">${escape(signIn.title)} sign-in</span></div><p class="server-url">${escape(endpoint.baseUrl)}</p></div>
<dl class="facts"><div><dt>Models</dt><dd>${endpoint.models.length}</dd></div>${signInFacts(escape, endpoint.signIn)}</dl></div>
<p class="desc">${escape(signIn.note)}</p>
<div class="server-actions">${action}<button type="button" class="btn btn-sm" data-endpoint-edit="${escape(JSON.stringify(editable))}">Edit models</button><span class="spacer"></span><button type="button" class="btn btn-sm btn-danger" data-endpoint-remove="${escape(endpoint.id)}" aria-label="Remove ${escape(endpoint.label)}">${icon("trash")}Remove</button></div>
<details class="tools"${endpoint.models.length <= 12 ? " open" : ""}><summary>${icon("chevron")}Models</summary><ul class="endpoint-models">${models}</ul></details></article>`;
};

/** "Sign in with <title>", one per sign-in kind: its endpoint's id and label, the start, then the link and the paste field. */
const signInForm = (escape: Escape, view: EndpointsView, kind: SignIn): string => {
  if (view.signIns === undefined) return "";
  const signIn = SIGN_IN_KINDS[kind];
  const waiting = Object.entries(view.signIns).filter(([, status]) => status.kind === kind || status.kind === null);
  const notes = waiting
    .map(([id, status]) => `<div class="field wide"><dl class="facts"><div><dt>Endpoint</dt><dd><code>${escape(id)}</code></dd></div>${signInFacts(escape, status)}</dl></div>`)
    .join("");
  const at = (name: string) => escape(`sign-in-${kind}-${name}`);
  return `<form class="group add" id="${at("form")}" data-sign-in-form data-sign-in-kind="${escape(kind)}" data-sign-in-steps="${escape(signIn.paste.instructions)}" autocomplete="off" aria-labelledby="${at("title")}">
<div class="row"><div><div class="row-title"><h3 id="${at("title")}">Sign in with ${escape(signIn.title)}</h3></div><p class="desc">${escape(signIn.about)} Start, open the link and approve, then paste what it gives you back here.</p>
<div class="callout callout-warn" role="note">${icon("warn")}<div><strong>${escape(signIn.noteTitle)}</strong><p>${escape(signIn.note)}</p></div></div></div></div>
<div class="form-body">${notes}
<div class="field"><label for="${at("id")}">Id</label><input id="${at("id")}" name="id" type="text" required pattern="[a-z0-9](?:[a-z0-9\\-]{0,30}[a-z0-9])?" value="${escape(waiting[0]?.[0] ?? kind)}" autocapitalize="none" spellcheck="false"></div>
<div class="field"><label for="${at("label")}">Label</label><input id="${at("label")}" name="label" type="text" maxlength="60" value="${escape(signIn.title)}"></div>
<div class="field wide" data-sign-in-step${waiting.some(([, status]) => status.pendingSince !== null) ? "" : " hidden"}><p class="desc"><a data-sign-in-link target="_blank" rel="noopener noreferrer" hidden>Open the ${escape(signIn.title)} sign-in</a></p><label for="${at("paste")}">What the sign-in gave you</label><textarea id="${at("paste")}" name="pasted" rows="3" spellcheck="false" placeholder="${escape(signIn.paste.placeholder)}"></textarea><p class="hint">It holds a one-time code: paste it here only.</p></div>
</div>
<div class="form-foot"><p data-sign-in-note aria-live="polite"></p><button type="button" class="btn" data-sign-in-start>Start sign-in</button><button type="button" class="btn btn-primary" data-sign-in-finish>Finish sign-in</button></div>
</form>`;
};

const form = (escape: Escape, view: EndpointsView): string => `<form class="group add" id="endpoint-form" data-endpoint-form autocomplete="off" aria-labelledby="endpoint-form-title">
<div class="row"><div><div class="row-title"><h3 id="endpoint-form-title" data-endpoint-form-title>Add an endpoint</h3></div><p class="desc">Start from a preset, or fill it in. Read the model list to fill the models; pi-ai's catalog gives the limits, thinking and prices of models it knows.</p>
<p class="desc">${view.presets
  .map((preset) => `<button type="button" class="btn btn-sm" data-endpoint-preset="${escape(JSON.stringify(preset))}">${escape(preset.title)}</button>`)
  .join(" ")}</p></div></div>
<div class="form-body">
<div class="field"><label for="endpoint-id">Id</label><input id="endpoint-id" name="id" type="text" required pattern="[a-z0-9](?:[a-z0-9\\-]{0,30}[a-z0-9])?" placeholder="openai" autocapitalize="none" spellcheck="false" aria-describedby="endpoint-id-hint"><p class="hint" id="endpoint-id-hint">Fixed once saved: models are named id/model.</p></div>
<div class="field"><label for="endpoint-label">Label</label><input id="endpoint-label" name="label" type="text" required maxlength="60" placeholder="OpenAI"></div>
<div class="field"><label for="endpoint-api">API</label><select id="endpoint-api" name="api">${view.apis.map((api) => `<option value="${escape(api)}">${escape(api)}</option>`).join("")}</select></div>
<div class="field"><label for="endpoint-base">Base URL</label><input id="endpoint-base" name="baseUrl" type="url" required placeholder="https://api.openai.com/v1" autocapitalize="none" spellcheck="false"></div>
<fieldset class="wide"><legend>Auth</legend><div class="choices">
<label class="choice"><input type="radio" name="auth" value="api-key" checked><div><strong>API key</strong><span>Sealed, write-only</span></div></label>
<label class="choice"><input type="radio" name="auth" value="none"><div><strong>None</strong><span>A server that takes no key</span></div></label>
${SIGN_INS.map((kind) => `<label class="choice" hidden><input type="radio" name="auth" value="${escape(kind)}"><div><strong>${escape(SIGN_IN_KINDS[kind].title)} sign-in</strong><span>Its own sign-in, above</span></div></label>`).join("")}
</div></fieldset>
<div class="field wide" data-endpoint-key><label for="endpoint-key">API key</label><input id="endpoint-key" name="apiKey" type="password" autocomplete="new-password" aria-describedby="endpoint-key-hint"><p class="hint" id="endpoint-key-hint">Never shown again, only its fingerprint. Leave empty to keep the saved one.</p></div>
<div class="field wide"><label for="endpoint-headers">Headers</label><textarea id="endpoint-headers" name="headers" rows="2" spellcheck="false" placeholder="Name: value, one a line" aria-describedby="endpoint-headers-hint"></textarea><p class="hint" id="endpoint-headers-hint">Sent with every request. Not for credentials: those go in the API key.</p></div>
<div class="field wide"><label for="endpoint-models">Models</label><textarea id="endpoint-models" name="models" rows="5" spellcheck="false" placeholder="One model id a line" aria-describedby="endpoint-models-hint"></textarea><p class="hint" id="endpoint-models-hint">One id a line. Read model list replaces them with the endpoint's own list; keep the ones you want.</p></div>
</div>
<div class="form-foot"><p data-endpoint-note aria-live="polite">${icon("key")}Keys are sealed under this Environment's credentials key.</p><button type="button" class="btn" data-endpoint-discover>Read model list</button><button type="button" class="btn btn-ghost" data-endpoint-reset>Clear</button><button type="submit" class="btn btn-primary">Save endpoint</button></div>
</form>`;

/** The section, or nothing without the endpoints. */
export const endpointsSection = (escape: Escape, view: EndpointsView | undefined): string => {
  if (view === undefined) return "";
  const missingKey = view.credentialsKey
    ? ""
    : `<div class="callout callout-warn" role="note">${icon("warn")}<div><strong>No credentials key</strong><p>This Environment has no T3FLARE_CREDENTIALS_KEY, so it stores no API key. Deploy it again to get one.</p></div></div>`;
  const list =
    view.endpoints.length === 0
      ? `<div class="group"><div class="empty"><span class="empty-icon">${icon("key")}</span><h3>No Model endpoints</h3><p>Add one below. Its models show in Pi Durable's picker as endpoint/model at once, and reach a running thread at its next turn.</p></div></div>`
      : view.endpoints.map((endpoint) => endpointCard(escape, endpoint)).join("\n");
  return `<section id="endpoints" aria-labelledby="endpoints-title">
<div class="section-head"><h2 id="endpoints-title">${icon("key")}Model endpoints</h2><a class="btn btn-sm" href="#endpoint-form">${icon("plus")}Add endpoint</a></div>
<p class="section-desc">Your own ways to reach models: an API pi-ai speaks, at a base URL, with an API key. Pi Durable's picker lists each endpoint's models, grouped by endpoint, beside the Model proxy's. Revision ${view.revision}.</p>
${missingKey}<div class="stack">${list}
${SIGN_INS.map((kind) => signInForm(escape, view, kind)).join("\n")}
${form(escape, view)}</div>
</section>`;
};

/** The section's behaviour, appended to the page's one script (its CSP hash covers it). */
export const ENDPOINTS_SCRIPT = `
const endpointForm = document.querySelector("form[data-endpoint-form]");
if (endpointForm !== null) {
  const input = (name) => endpointForm.querySelector("[name=" + name + "]");
  const note = endpointForm.querySelector("[data-endpoint-note]");
  const keyField = endpointForm.querySelector("[data-endpoint-key]");
  const authOf = () => endpointForm.querySelector("[name=auth]:checked").value;
  const showKey = () => { keyField.hidden = authOf() !== "api-key"; };
  for (const radio of endpointForm.querySelectorAll("[name=auth]")) radio.addEventListener("change", showKey);
  const fill = (endpoint, editing) => {
    input("id").value = endpoint.id || "";
    input("id").readOnly = editing;
    input("label").value = endpoint.label || "";
    input("api").value = endpoint.api;
    input("baseUrl").value = endpoint.baseUrl || "";
    for (const radio of endpointForm.querySelectorAll("[name=auth]")) radio.checked = radio.value === (endpoint.auth || "api-key");
    input("apiKey").value = "";
    input("headers").value = Object.entries(endpoint.headers || {}).map(([name, value]) => name + ": " + value).join("\\n");
    input("models").value = (endpoint.models || []).join("\\n");
    endpointForm.querySelector("[data-endpoint-form-title]").textContent = editing ? "Edit " + endpoint.label : "Add an endpoint";
    showKey();
  };
  const headersOf = () => {
    const headers = {};
    for (const line of input("headers").value.split("\\n")) {
      if (line.trim() === "") continue;
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error("A header is Name: value, one a line.");
      headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return headers;
  };
  const endpointOf = () => ({
    id: input("id").value.trim(),
    label: input("label").value.trim(),
    api: input("api").value,
    baseUrl: input("baseUrl").value.trim(),
    auth: authOf(),
    headers: headersOf(),
    models: input("models").value.split("\\n").map((line) => line.trim()).filter((line) => line !== ""),
  });
  for (const button of document.querySelectorAll("button[data-endpoint-preset]")) {
    button.addEventListener("click", () => fill(JSON.parse(button.dataset.endpointPreset), false));
  }
  for (const button of document.querySelectorAll("button[data-endpoint-edit]")) {
    button.addEventListener("click", () => { fill(JSON.parse(button.dataset.endpointEdit), true); endpointForm.scrollIntoView(); input("label").focus(); });
  }
  endpointForm.querySelector("[data-endpoint-reset]").addEventListener("click", () => fill({ api: "openai-completions" }, false));
  const discover = endpointForm.querySelector("[data-endpoint-discover]");
  discover.addEventListener("click", async () => {
    let endpoint;
    try { endpoint = endpointOf(); } catch (error) { notify("err", error.message); return; }
    note.textContent = "Reading the model list…";
    const response = await post("/_t3flare/harness/api/endpoints/discover", { endpoint, apiKey: input("apiKey").value }, discover);
    busy(discover, false);
    if (response === undefined) { note.textContent = ""; return; }
    const answer = await response.json();
    if (!answer.ok) { note.textContent = "Could not read it: " + answer.error; return; }
    input("models").value = answer.models.map((model) => model.id).join("\\n");
    const known = answer.models.filter((model) => model.known).length;
    note.textContent = "Listed " + answer.models.length + " models, " + known + " known to pi-ai. Keep the ones you want, then save.";
  });
  endpointForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!endpointForm.reportValidity()) return;
    let endpoint;
    try { endpoint = endpointOf(); } catch (error) { notify("err", error.message); return; }
    const body = { op: "save", endpoint };
    if (input("apiKey").value !== "") body.apiKey = input("apiKey").value;
    const response = await post("/_t3flare/harness/api/endpoints", body, endpointForm.querySelector("[type=submit]"));
    input("apiKey").value = "";
    if (response !== undefined) done();
  });
  showKey();
}
/** One step of a sign-in on the panel's route: its JSON answer, or undefined when the panel refused it (already shown). */
const signInStep = async (body, control) => {
  const response = await post("/_t3flare/harness/api/endpoints/sign-in", body, control);
  busy(control, false);
  return response === undefined ? undefined : response.json();
};
const signInForms = new Map();
for (const form of document.querySelectorAll("form[data-sign-in-form]")) {
  const kind = form.dataset.signInKind;
  const field = (name) => form.querySelector("[name=" + name + "]");
  const note = form.querySelector("[data-sign-in-note]");
  const link = form.querySelector("[data-sign-in-link]");
  const start = async (id, label, control) => {
    note.textContent = "Starting…";
    const answer = await signInStep({ op: "start", id, signIn: kind, label }, control);
    if (answer === undefined) { note.textContent = ""; return; }
    field("id").value = id;
    field("label").value = label;
    link.href = answer.authorizeUrl;
    link.hidden = false;
    form.querySelector("[data-sign-in-step]").hidden = false;
    note.textContent = form.dataset.signInSteps;
    form.scrollIntoView();
  };
  signInForms.set(kind, start);
  form.querySelector("button[data-sign-in-start]").addEventListener("click", (event) => {
    if (!form.reportValidity()) return;
    void start(field("id").value.trim(), field("label").value.trim(), event.currentTarget);
  });
  const finish = form.querySelector("[data-sign-in-finish]");
  finish.addEventListener("click", async () => {
    const pasted = field("pasted").value.trim();
    if (pasted === "") { note.textContent = "Paste what the sign-in gave you first."; return; }
    note.textContent = "Finishing the sign-in…";
    const answer = await signInStep({ op: "complete", id: field("id").value.trim(), label: field("label").value.trim(), pasted }, finish);
    if (answer === undefined) { note.textContent = ""; return; }
    if (!answer.ok) { note.textContent = "The sign-in failed: " + answer.error; notify("err", "The sign-in failed: " + answer.error); return; }
    field("pasted").value = "";
    notify("ok", "Signed in as " + (answer.email || "your account") + ": " + answer.models + " models." + (answer.modelsProblem ? " The model list could not be read (" + answer.modelsProblem + "): add models with Edit models." : ""));
    setTimeout(done, 1500);
  });
}
for (const button of document.querySelectorAll("article button[data-sign-in-start]")) {
  button.addEventListener("click", () => void signInForms.get(button.dataset.signInKind)?.(button.dataset.signInStart, button.dataset.signInLabel, button));
}
for (const button of document.querySelectorAll("button[data-sign-in-out]")) {
  button.addEventListener("click", async () => {
    const id = button.dataset.signInOut;
    const revocation = button.dataset.signInRevocation;
    if (!confirm("Sign " + id + " out of " + button.dataset.signInTitle + "? Its running turns stop, and " + (revocation ? "its tokens are deleted here. " + revocation : "its sign-in is revoked where the vendor allows."))) return;
    const answer = await signInStep({ op: "sign-out", id }, button);
    if (answer === undefined) return;
    notify(answer.revoked ? "ok" : "err", answer.revoked ? "Signed out; the vendor revoked the sign-in." : answer.revocation ? "Signed out here. " + answer.revocation : "Signed out here, but the vendor did not confirm the revocation: disconnect t3flare in your account's settings.");
    setTimeout(done, 1500);
  });
}
for (const button of document.querySelectorAll("button[data-endpoint-remove]")) {
  button.addEventListener("click", async () => {
    const id = button.dataset.endpointRemove;
    if (!confirm("Remove the endpoint " + id + " and its key? A thread on one of its models fails its next turn until another model is picked.")) return;
    const response = await post("/_t3flare/harness/api/endpoints", { op: "remove", id }, button);
    if (response === undefined) return;
    const answer = await response.json();
    if (!answer.revocation) { done(); return; }
    notify("err", "Removed here. " + answer.revocation);
    setTimeout(done, 1500);
  });
}`;
