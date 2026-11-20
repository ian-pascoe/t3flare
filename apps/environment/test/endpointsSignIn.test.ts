// @effect-diagnostics globalConsole:off
// ChatGPT plan usage on the Harness panel (SPI-1164): the owner starts the sign-in, opens the authorize link, pastes the
// address the browser lands on, and sees the account or why it failed; a ChatGPT endpoint is saved with the models its
// token lists; sign-out revokes and stops the endpoint's Sessions. The panel's answers, page and audit log never hold a
// token. Against the panel's real routes, a real endpoint store and broker, and a fake of OpenAI's authorization server.
import * as fs from "node:fs";
import * as path from "node:path";

import { MODEL_ENDPOINTS_DOCS, SIGN_IN_KINDS, SIGN_INS } from "@t3flare/models/endpoints";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialBroker } from "../src/credentials/broker.ts";
import { chatgptSignIn } from "../src/credentials/chatgpt.ts";
import { claudeSignIn } from "../src/credentials/claude.ts";
import { copilotSignIn } from "../src/credentials/copilot.ts";
import { sealedStore } from "../src/credentials/sealed.ts";
import type { Discovery } from "../src/endpoints/discover.ts";
import { endpointStore } from "../src/endpoints/store.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { escapeHtml } from "../src/harness/page.ts";
import { CSRF_HEADER, handleHarness, type HarnessCaller, type HarnessDeps } from "../src/harness/panel.ts";
import { SCRIPT } from "../src/harness/pageScript.ts";
import { harnessStore } from "../src/harness/store.ts";
import { fakeAnthropic } from "./fixtures/fakeAnthropicAuth.ts";
import { fakeGitHubCopilot } from "./fixtures/fakeGitHubCopilot.ts";
import { fakeOpenAI } from "./fixtures/fakeOpenAIAuth.ts";

const HOST = "t3.example.dev";
const NOW = Date.UTC(2026, 10, 16, 10, 0);
const owner: HarnessCaller = { kind: "owner", subject: "owner-sub" };

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

let logged: Array<string> = [];
beforeEach(() => {
  logged = [];
  for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...args: Array<unknown>) => void logged.push(args.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

const setup = async () => {
  const kv = memory();
  const store = harnessStore(kv);
  let clock = NOW;
  const now = () => clock;
  const vendor = await fakeOpenAI({ now });
  const anthropic = fakeAnthropic();
  const github = fakeGitHubCopilot({}, now);
  const sealed = sealedStore(kv, "e".repeat(64), now);
  const signIns = credentialBroker({
    kv,
    sealed,
    vendors: { chatgpt: chatgptSignIn({ fetch: vendor.fetch, now }), claude: claudeSignIn({ fetch: anthropic.fetch, now }), copilot: copilotSignIn({ fetch: github.fetch, now }) },
    now,
  });
  const endpoints = endpointStore(kv, sealed, signIns);
  const discovered: Array<{ baseUrl: string; apiKey: string | undefined; headers: Readonly<Record<string, string>>; signIn: string | undefined }> = [];
  const stopped: Array<string> = [];
  let listed: Discovery = { ok: true, models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }, { id: "gpt-5-mini" }] };
  let changes = 0;
  const deps: HarnessDeps = {
    caller: owner,
    host: HOST,
    store,
    now,
    endpoints: {
      store: endpoints,
      signIns,
      discover: async (target, apiKey, signIn) => {
        // Which sign-in's list it is: Copilot's is read as its own catalog (discover.ts).
        discovered.push({ baseUrl: target.baseUrl, apiKey, headers: target.headers, signIn });
        return listed;
      },
      changed: () => void changes++,
      signedOut: async (endpointId) => void stopped.push(endpointId),
    },
  };
  const headers = {
    "content-type": "application/json",
    origin: `https://${HOST}`,
    "sec-fetch-site": "same-origin",
    [CSRF_HEADER]: await csrfToken(store.csrfKey(), "owner-sub", NOW),
  };
  const post = async (body: unknown, path = "endpoints/sign-in") => {
    const response = await handleHarness(new Request(`https://${HOST}/_t3flare/settings/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), deps);
    return { status: response.status, text: await response.text() };
  };
  const page = async () => (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
  /** Everything a token must never reach: the storage, the audit log, the console. */
  const leaks = () => {
    const places = [JSON.stringify([...kv.map.entries()]), JSON.stringify(store.auditLog(50)), logged.join("\n")];
    return [...vendor.secrets(), ...anthropic.secrets(), ...github.secrets()].filter((token) => places.some((place) => place.includes(token)));
  };
  return { kv, store, vendor, anthropic, github, advance: (ms: number) => void (clock += ms), signIns, endpoints, deps, post, page, discovered, stopped, leaks, changes: () => changes, list: (next: Discovery) => void (listed = next) };
};

/** Start and paste, as the owner does; the answers' texts. */
const signIn = async (context: Awaited<ReturnType<typeof setup>>) => {
  const started = await context.post({ op: "start", id: "chatgpt", signIn: "chatgpt", label: "ChatGPT", acknowledgedTerms: true });
  const { authorizeUrl } = JSON.parse(started.text) as { authorizeUrl: string };
  const done = await context.post({ op: "complete", id: "chatgpt", label: "ChatGPT", pasted: context.vendor.approve(authorizeUrl, { email: "owner@example.com" }) });
  return { started, done };
};

describe("ChatGPT plan usage on the Harness panel", () => {
  it("offers the sign-in with its unverified, Plus-or-Pro note", async () => {
    const { page } = await setup();
    const html = await page();
    expect(html).toContain("data-sign-in-start");
    expect(html).toMatch(/unverified/i);
    expect(html).toMatch(/Plus or Pro/);
  });

  it("starts a sign-in, shows the waiting paste, and completes it into a ChatGPT endpoint with its token's models", async () => {
    const context = await setup();
    const { started, done } = await signIn(context);
    expect(started.status).toBe(200);
    expect(JSON.parse(started.text).authorizeUrl).toMatch(/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/);
    expect(done.status).toBe(200);
    expect(JSON.parse(done.text)).toMatchObject({ ok: true, email: "owner@example.com", models: 2 });
    const [endpoint] = context.endpoints.load().endpoints;
    expect(endpoint).toMatchObject({ id: "chatgpt", label: "ChatGPT", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "chatgpt", headers: {} });
    expect(endpoint!.models.map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-5-mini"]);
    // The list was read at OpenAI with the sign-in's access token.
    expect(context.discovered).toEqual([{ baseUrl: "https://api.openai.com/v1", apiKey: undefined, headers: { authorization: `Bearer ${context.vendor.issued[0]}` }, signIn: "chatgpt" }]);
    expect(context.changes()).toBe(1);
    const html = await context.page();
    expect(html).toContain("owner@example.com");
    expect(html).toContain('data-sign-in-out="chatgpt"');
    expect(context.store.auditLog(5).map((entry) => entry.action)).toEqual(["endpoint.sign-in", "endpoint.sign-in.start"]);
    expect(context.leaks()).toEqual([]);
    for (const token of context.vendor.issued) expect(html + done.text + started.text).not.toContain(token);
  });

  it("gives a Session the access token for the endpoint's target only", async () => {
    const context = await setup();
    await signIn(context);
    const target = { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1", headers: {} };
    const credential = await context.endpoints.credential({ endpointId: "chatgpt", target });
    expect(credential).toEqual({ apiKey: context.vendor.issued[0], expiresAt: NOW + 3_600_000 });
    expect(await context.endpoints.credential({ endpointId: "chatgpt", target: { ...target, baseUrl: "https://elsewhere.example/v1" } })).toEqual({ apiKey: null, changed: true });
    // The relay does not carry a sign-in yet (SPI-1171): it refuses it.
    expect((await context.endpoints.resolve("chatgpt"))?.apiKey).toBeUndefined();
  });

  it("shows a refused exchange (a Free plan) at once, saves no endpoint, and leaves the problem on the page", async () => {
    const context = await setup();
    context.vendor.options.exchangeError = "invalid_grant";
    const { done } = await signIn(context);
    expect(done.status).toBe(200);
    expect(JSON.parse(done.text)).toMatchObject({ ok: false, error: expect.stringMatching(/invalid_grant.*Plus or Pro/) });
    expect(context.endpoints.load().endpoints).toEqual([]);
    expect(await context.page()).toContain("invalid_grant");
    expect(context.leaks()).toEqual([]);
  });

  it("signs out: revoked at OpenAI, the endpoint's Sessions stopped, its turns told to sign in again", async () => {
    const context = await setup();
    await signIn(context);
    const out = await context.post({ op: "sign-out", id: "chatgpt" });
    expect(JSON.parse(out.text)).toEqual({ ok: true, signedOut: true, revoked: true });
    expect(context.vendor.counts.revocations).toBe(1);
    expect(context.stopped).toEqual(["chatgpt"]);
    const target = { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1", headers: {} };
    expect(await context.endpoints.credential({ endpointId: "chatgpt", target })).toMatchObject({ apiKey: null, signedOut: true });
    // The endpoint stays, signed out, for a sign-in again.
    expect(context.endpoints.load().endpoints).toHaveLength(1);
    expect(await context.page()).toContain('data-sign-in-again="chatgpt"');
    expect(context.leaks()).toEqual([]);
  });

  it("revokes a fresh grant whose endpoint cannot be saved (32 endpoints already), and says so", async () => {
    const context = await setup();
    for (let index = 0; index < 32; index += 1) {
      const saved = await context.post({ op: "save", endpoint: { id: `e${index}`, label: `E${index}`, api: "openai-completions", baseUrl: "https://llm.example/v1", auth: "none", models: [] } }, "endpoints");
      expect(saved.status).toBe(200);
    }
    const { done } = await signIn(context);
    expect(JSON.parse(done.text)).toMatchObject({ ok: false, error: expect.stringMatching(/could not be saved \(at most 32 endpoints\), so the sign-in was revoked/) });
    expect(context.vendor.counts.revocations).toBe(1);
    expect(context.vendor.revoked.has(context.vendor.currentRefresh()!)).toBe(true);
    expect(await context.signIns.read("chatgpt")).toBeUndefined();
    expect(context.endpoints.load().endpoints.some((endpoint) => endpoint.id === "chatgpt")).toBe(false);
    expect(context.leaks()).toEqual([]);
  });

  it("removing a signed-in endpoint signs it out first", async () => {
    const context = await setup();
    await signIn(context);
    const removed = await context.post({ op: "remove", id: "chatgpt" }, "endpoints");
    expect(removed.status).toBe(200);
    expect(context.vendor.counts.revocations).toBe(1);
    expect(context.stopped).toEqual(["chatgpt"]);
    expect(context.signIns.status("chatgpt").clientId).toBeNull();
    expect(context.leaks()).toEqual([]);
  });

  it("refuses to start without a known sign-in kind", async () => {
    const context = await setup();
    expect((await context.post({ op: "start", id: "chatgpt", label: "ChatGPT" })).text).toMatch(/signIn is one of chatgpt/);
    expect((await context.post({ op: "start", id: "chatgpt", signIn: "nope", label: "ChatGPT", acknowledgedTerms: true })).status).toBe(400);
  });

  it("keeps a sign-in endpoint's auth: no key, no headers, no other target, no switch to a key", async () => {
    const context = await setup();
    await signIn(context);
    const base = { id: "chatgpt", label: "ChatGPT", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "chatgpt", models: ["gpt-5-mini"] };
    expect((await context.post({ op: "save", endpoint: base, apiKey: "sk-x" }, "endpoints")).text).toMatch(/takes no API key/);
    expect((await context.post({ op: "save", endpoint: { ...base, headers: { "X-A": "b" } } }, "endpoints")).text).toMatch(/no headers/);
    expect((await context.post({ op: "save", endpoint: { ...base, baseUrl: "https://elsewhere.example/v1" } }, "endpoints")).text).toMatch(/openai-responses at https:\/\/api\.openai\.com\/v1/);
    expect((await context.post({ op: "save", endpoint: { ...base, auth: "api-key" }, apiKey: "sk-x" }, "endpoints")).text).toMatch(/remove it/);
    // Its label and models are the owner's to edit.
    expect((await context.post({ op: "save", endpoint: { ...base, label: "ChatGPT Plus" } }, "endpoints")).status).toBe(200);
    expect(context.signIns.status("chatgpt").signedIn).toBe(true);
  });

  it("refuses a sign-in under an API-key endpoint's id", async () => {
    const context = await setup();
    await context.post({ op: "save", endpoint: { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", models: [] }, apiKey: "sk-key" }, "endpoints");
    const started = await context.post({ op: "start", id: "openai", signIn: "chatgpt", label: "ChatGPT", acknowledgedTerms: true });
    expect(started.status).toBe(400);
    expect(started.text).toMatch(/already an endpoint with an API key/);
  });
});

/** Start and paste a Claude sign-in, as the owner does: the code Anthropic's page shows. */
const claudeSignInFlow = async (context: Awaited<ReturnType<typeof setup>>) => {
  const started = await context.post({ op: "start", id: "claude", signIn: "claude", label: "Claude", acknowledgedTerms: true });
  const { authorizeUrl } = JSON.parse(started.text) as { authorizeUrl: string };
  const shown = context.anthropic.approve(authorizeUrl, { email: "owner@example.com" });
  // While the attempt waits for its paste, nothing secret of it is on the page, in the audit or in the storage.
  const waiting = await context.page();
  expect(context.leaks()).toEqual([]);
  for (const secret of context.anthropic.secrets()) expect(waiting).not.toContain(secret);
  const done = await context.post({ op: "complete", id: "claude", label: "Claude", pasted: shown });
  return { started, done, waiting };
};

const CLAUDE_TARGET = { api: "anthropic-messages" as const, baseUrl: "https://api.anthropic.com", headers: {} };

describe("Claude on the Harness panel (SPI-1165)", () => {
  it("offers the sign-in with its note: the owner's terms-of-service risk, a Pro or Max plan, no revocation", async () => {
    const html = await (await setup()).page();
    expect(html).toContain('data-sign-in-kind="claude"');
    expect(html).toContain("Sign in with Claude");
    expect(html).toContain("Your risk");
    expect(html).toMatch(/Anthropic&#39;s terms may not allow|Anthropic's terms may not allow/);
    expect(html).toMatch(/Pro or Max/);
    expect(html).toMatch(/claude\.ai/);
  });

  it("starts at claude.ai, takes the pasted code, and saves a Claude endpoint with the models its token lists", async () => {
    const context = await setup();
    context.list({ ok: true, models: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { id: "claude-haiku-5-5" }] });
    const { started, done, waiting } = await claudeSignInFlow(context);
    expect(JSON.parse(started.text).authorizeUrl).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    expect(waiting).toMatch(/waiting for its paste/);
    expect(JSON.parse(done.text)).toMatchObject({ ok: true, email: "owner@example.com", models: 2 });
    const [endpoint] = context.endpoints.load().endpoints;
    expect(endpoint).toMatchObject({ id: "claude", label: "Claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "claude", headers: {} });
    // The list was read at Anthropic with the sign-in's token as a bearer, with its OAuth beta.
    expect(context.discovered).toEqual([
      { baseUrl: "https://api.anthropic.com", apiKey: undefined, headers: { authorization: `Bearer ${context.anthropic.accessTokens[0]}`, "anthropic-beta": "oauth-2025-04-20" }, signIn: "claude" },
    ]);
    const html = await context.page();
    expect(html).toContain("owner@example.com");
    expect(html).toContain('data-sign-in-out="claude"');
    expect(html).toContain("data-sign-in-revocation=");
    expect(context.store.auditLog(5).map((entry) => entry.action)).toEqual(["endpoint.sign-in", "endpoint.sign-in.start"]);
    expect(context.leaks()).toEqual([]);
    for (const secret of context.anthropic.secrets()) expect(html + done.text).not.toContain(secret);
    // The start's answer is the authorize URL (its state and challenge are the browser's to carry), and no token.
    for (const token of context.anthropic.issued) expect(started.text).not.toContain(token);
  });

  it("reads a signed-in Claude endpoint's model list again with its token as a bearer, with the OAuth beta", async () => {
    const context = await setup();
    await claudeSignInFlow(context);
    const read = await context.post({ endpoint: { id: "claude", label: "Claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "claude" } }, "endpoints/discover");
    expect(read.status).toBe(200);
    expect(context.discovered.at(-1)).toEqual({
      baseUrl: "https://api.anthropic.com",
      apiKey: undefined,
      headers: { authorization: `Bearer ${context.anthropic.accessTokens[0]}`, "anthropic-beta": "oauth-2025-04-20" },
      signIn: "claude",
    });
    for (const token of context.anthropic.issued) expect(read.text).not.toContain(token);
  });

  it("drops a fresh grant whose endpoint cannot be saved (32 endpoints already), and says where to remove it", async () => {
    const context = await setup();
    for (let index = 0; index < 32; index += 1) {
      await context.post({ op: "save", endpoint: { id: `e${index}`, label: `E${index}`, api: "openai-completions", baseUrl: "https://llm.example/v1", auth: "none", models: [] } }, "endpoints");
    }
    const { done } = await claudeSignInFlow(context);
    expect(JSON.parse(done.text)).toMatchObject({ ok: false, error: expect.stringMatching(/could not be saved \(at most 32 endpoints\), so the sign-in was dropped here\. Anthropic offers no revocation to apps: .*claude\.ai/) });
    expect(await context.signIns.read("claude")).toBeUndefined();
    expect(context.leaks()).toEqual([]);
  });

  it("gives a Session the token for the endpoint's target only", async () => {
    const context = await setup();
    await claudeSignInFlow(context);
    expect(await context.endpoints.credential({ endpointId: "claude", target: CLAUDE_TARGET })).toEqual({ apiKey: context.anthropic.accessTokens[0], expiresAt: NOW + 28_800_000 });
    expect(await context.endpoints.credential({ endpointId: "claude", target: { ...CLAUDE_TARGET, baseUrl: "https://gw.example" } })).toEqual({ apiKey: null, changed: true });
    // The relay does not carry a sign-in yet (SPI-1171).
    expect((await context.endpoints.resolve("claude"))?.apiKey).toBeUndefined();
  });

  it("refuses another attempt's code at once, and keeps the attempt waiting", async () => {
    const context = await setup();
    const first = JSON.parse((await context.post({ op: "start", id: "claude", signIn: "claude", acknowledgedTerms: true })).text) as { authorizeUrl: string };
    const stale = context.anthropic.approve(first.authorizeUrl);
    await context.post({ op: "start", id: "claude", signIn: "claude", acknowledgedTerms: true });
    const done = await context.post({ op: "complete", id: "claude", pasted: stale });
    expect(JSON.parse(done.text)).toMatchObject({ ok: false, error: expect.stringMatching(/does not belong to the sign-in in progress/) });
    expect(context.anthropic.counts.exchanges).toBe(0);
    expect(context.signIns.status("claude").pendingSince).not.toBeNull();
    expect(context.leaks()).toEqual([]);
  });

  it("signs out: the tokens deleted here and the Sessions stopped; nothing sent to Anthropic, and the answer says where to remove the grant", async () => {
    const context = await setup();
    await claudeSignInFlow(context);
    const sent = context.anthropic.requests.length;
    const out = JSON.parse((await context.post({ op: "sign-out", id: "claude" })).text) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, signedOut: true, revoked: false, revocation: expect.stringMatching(/claude\.ai, under Settings, Claude Code/) });
    expect(context.anthropic.requests).toHaveLength(sent);
    expect(context.stopped).toEqual(["claude"]);
    expect(await context.endpoints.credential({ endpointId: "claude", target: CLAUDE_TARGET })).toMatchObject({ apiKey: null, signedOut: true });
    expect(await context.page()).toContain('data-sign-in-again="claude"');
    expect(context.leaks()).toEqual([]);
  });

  it("removing a signed-in Claude endpoint signs it out and says the grant stays at claude.ai", async () => {
    const context = await setup();
    await claudeSignInFlow(context);
    const removed = JSON.parse((await context.post({ op: "remove", id: "claude" }, "endpoints")).text) as Record<string, unknown>;
    expect(removed).toMatchObject({ ok: true, revocation: expect.stringMatching(/claude\.ai/) });
    expect(context.stopped).toEqual(["claude"]);
    expect(await context.signIns.read("claude")).toBeUndefined();
    expect(context.leaks()).toEqual([]);
  });

  it("refuses a Claude subscription's token as an API-key endpoint's key: only a Claude sign-in sends Claude Code's request shape", async () => {
    const context = await setup();
    const saved = await context.post(
      { op: "save", endpoint: { id: "anthropic-api", label: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "api-key", models: [] }, apiKey: "sk-ant-oat01-copied" },
      "endpoints",
    );
    expect(saved.status).toBe(400);
    expect(saved.text).toMatch(/Claude subscription's token, not an API key: use Sign in with Claude/);
    expect(context.endpoints.load().endpoints).toEqual([]);
    expect(JSON.stringify([...context.kv.map.entries()])).not.toContain("sk-ant-oat01-copied");
  });
});

/** A Copilot sign-in as the owner does it: start, enter the code at GitHub and approve, the page asking until it is done. */
const copilotSignInFlow = async (context: Awaited<ReturnType<typeof setup>>) => {
  const started = await context.post({ op: "start", id: "copilot", signIn: "copilot", label: "Copilot", acknowledgedTerms: true });
  const { device } = JSON.parse(started.text) as { device: { userCode: string; intervalSeconds: number } };
  // The page asks before the owner approved: still waiting, and nothing secret of the attempt anywhere.
  context.advance(device.intervalSeconds * 1000);
  const asked = await context.post({ op: "complete", id: "copilot", label: "Copilot" });
  const waiting = await context.page();
  expect(context.leaks()).toEqual([]);
  for (const secret of context.github.secrets()) expect(waiting + asked.text).not.toContain(secret);
  context.github.approve(device.userCode);
  context.advance(device.intervalSeconds * 1000);
  const done = await context.post({ op: "complete", id: "copilot", label: "Copilot" });
  return { started, asked, waiting, done, userCode: device.userCode };
};

const COPILOT_TARGET = { api: "openai-responses" as const, baseUrl: "https://api.individual.githubcopilot.com", headers: {} };
const EDITOR_HEADERS = { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" };

describe("GitHub Copilot on the Harness panel (SPI-1166)", () => {
  it("offers the device sign-in with its note: the owner's terms-of-service risk, a Copilot plan, no revocation; no paste field", async () => {
    const html = await (await setup()).page();
    const form = /<form[^>]*data-sign-in-kind="copilot"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toContain("Sign in with GitHub Copilot");
    expect(form).toContain("data-sign-in-device");
    expect(form).toContain("data-sign-in-code");
    expect(form).toContain("Check sign-in");
    expect(form).not.toContain('name="pasted"');
    expect(form).toContain("Your risk");
    expect(form).toMatch(/Copilot plan/);
    expect(form).toMatch(/github\.com, under Settings, Applications/);
  });

  it("starts GitHub's device flow, waits for the approval, and saves a Copilot endpoint whose base URL and headers stay the broker's", async () => {
    const context = await setup();
    context.list({ ok: true, models: [{ id: "gpt-6.1-sol" }, { id: "grok-4.7" }] });
    const { started, asked, waiting, done, userCode } = await copilotSignInFlow(context);
    expect(JSON.parse(started.text)).toEqual({ ok: true, authorizeUrl: "https://github.com/login/device", device: { userCode, expiresAt: NOW + 900_000, intervalSeconds: 5 } });
    expect(JSON.parse(asked.text)).toEqual({ ok: false, waiting: true, error: "Waiting for you to enter the code at GitHub and approve." });
    expect(waiting).toMatch(/waiting for approval at the vendor/);
    expect(JSON.parse(done.text)).toMatchObject({ ok: true, models: 2 });
    const [endpoint] = context.endpoints.load().endpoints;
    // The stored endpoint holds the sign-in's stand-in base URL and no headers: the token's own are the broker's.
    expect(endpoint).toMatchObject({ id: "copilot", label: "Copilot", api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com", auth: "copilot", headers: {} });
    // The list was read where the Copilot token says, with its bearer, the editor headers and the API version.
    expect(context.discovered).toEqual([
      {
        baseUrl: "https://api.individual.githubcopilot.com",
        apiKey: undefined,
        headers: { ...EDITOR_HEADERS, "X-GitHub-Api-Version": "2026-06-01", authorization: `Bearer ${context.github.copilotTokens[0]}` },
        // Read as Copilot's catalog.
        signIn: "copilot",
      },
    ]);
    const html = await context.page();
    expect(html).toContain('data-sign-in-out="copilot"');
    expect(html).toContain("https://api.individual.githubcopilot.com (from its GitHub Copilot token)");
    // Only the start and the end are audited, not each ask.
    expect(context.store.auditLog(5).map((entry) => entry.action)).toEqual(["endpoint.sign-in", "endpoint.sign-in.start"]);
    expect(context.leaks()).toEqual([]);
    for (const secret of context.github.secrets()) expect(html + done.text + started.text).not.toContain(secret);
  });

  it("gives a Session the Copilot token with the base URL its token names and the editor headers, for the endpoint's target only", async () => {
    const context = await setup();
    context.github.options.proxyHost = "proxy.business.githubcopilot.com";
    await copilotSignInFlow(context);
    // The list was read at the token's base URL, not the endpoint's stand-in.
    expect(context.discovered[0]).toMatchObject({ baseUrl: "https://api.business.githubcopilot.com" });
    const credential = await context.endpoints.credential({ endpointId: "copilot", target: COPILOT_TARGET });
    expect(credential).toEqual({ apiKey: context.github.copilotTokens[0], expiresAt: Math.floor(NOW / 1000) * 1000 + 10_000 + 1_800_000, baseUrl: "https://api.business.githubcopilot.com", headers: EDITOR_HEADERS });
    expect(await context.endpoints.credential({ endpointId: "copilot", target: { ...COPILOT_TARGET, baseUrl: "https://api.business.githubcopilot.com" } })).toEqual({ apiKey: null, changed: true });
    // The GitHub token never leaves the broker; the relay does not carry a sign-in yet (SPI-1171).
    expect(JSON.stringify(credential)).not.toContain(context.github.githubTokens[0]!);
    expect((await context.endpoints.resolve("copilot"))?.apiKey).toBeUndefined();
  });

  it("reads a signed-in Copilot endpoint's model list again at its token's base URL", async () => {
    const context = await setup();
    await copilotSignInFlow(context);
    const read = await context.post({ endpoint: { id: "copilot", label: "Copilot", api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com", auth: "copilot" } }, "endpoints/discover");
    expect(read.status).toBe(200);
    expect(context.discovered.at(-1)).toMatchObject({ baseUrl: "https://api.individual.githubcopilot.com", headers: { authorization: `Bearer ${context.github.copilotTokens[0]}`, "Copilot-Integration-Id": "vscode-chat" }, signIn: "copilot" });
    for (const token of context.github.issued) expect(read.text).not.toContain(token);
  });

  it("refuses an account without a Copilot plan at once, saves nothing, and says where to revoke the GitHub grant", async () => {
    const context = await setup();
    context.github.options.copilotStatus = 403;
    context.github.options.copilotBody = { message: "Forbidden", error_details: { notification_id: "subscription_ended" } };
    const { done } = await copilotSignInFlow(context);
    expect(JSON.parse(done.text)).toMatchObject({ ok: false, error: expect.stringMatching(/subscription_ended\): this GitHub account needs a Copilot plan\. Nothing was kept here; .* revoke it at github\.com/) });
    expect(context.endpoints.load().endpoints).toEqual([]);
    expect(context.leaks()).toEqual([]);
  });

  it("signs out: the tokens deleted here and the Sessions stopped; nothing sent to GitHub, and the answer says where to revoke the grant", async () => {
    const context = await setup();
    await copilotSignInFlow(context);
    const sent = context.github.requests.length;
    const out = JSON.parse((await context.post({ op: "sign-out", id: "copilot" })).text) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, signedOut: true, revoked: false, revocation: expect.stringMatching(/github\.com, under Settings, Applications/) });
    expect(context.github.requests).toHaveLength(sent);
    expect(context.stopped).toEqual(["copilot"]);
    expect(await context.endpoints.credential({ endpointId: "copilot", target: COPILOT_TARGET })).toMatchObject({ apiKey: null, signedOut: true });
    const html = await context.page();
    expect(html).toContain('data-sign-in-again="copilot"');
    expect(html).toContain("set by its GitHub Copilot token");
    expect(context.leaks()).toEqual([]);
  });

  it("keeps a Copilot endpoint's target: no headers of the owner's, no other base URL", async () => {
    const context = await setup();
    await copilotSignInFlow(context);
    const base = { id: "copilot", label: "Copilot", api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com", auth: "copilot", models: ["gpt-6.1-sol"] };
    expect((await context.post({ op: "save", endpoint: { ...base, headers: { "Copilot-Integration-Id": "x" } } }, "endpoints")).text).toMatch(/no headers/);
    expect((await context.post({ op: "save", endpoint: { ...base, baseUrl: "https://api.business.githubcopilot.com" } }, "endpoints")).text).toMatch(/openai-responses at https:\/\/api\.individual\.githubcopilot\.com/);
    expect((await context.post({ op: "save", endpoint: { ...base, label: "Copilot Pro" } }, "endpoints")).status).toBe(200);
  });
});

/** GitHub's anchor for a Markdown heading: lowercased, punctuation dropped, spaces to hyphens. */
const anchorOf = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");

describe("the owner's acknowledgement of the vendor's terms before a sign-in", () => {
  it("draws each sign-in form with its vendor's one-sentence acknowledgement, linking to the docs, and its Start disabled", async () => {
    const html = await (await setup()).page();
    for (const kind of SIGN_INS) {
      const { terms } = SIGN_IN_KINDS[kind];
      const form = new RegExp(`<form[^>]*data-sign-in-kind="${kind}"[\\s\\S]*?</form>`).exec(html)?.[0] ?? "";
      expect(form).toContain(`<input id="sign-in-${kind}-terms" name="acknowledgedTerms" type="checkbox" data-sign-in-terms>`);
      expect(form).not.toMatch(/data-sign-in-terms[^>]*checked/);
      expect(form).toContain(`<label for="sign-in-${kind}-terms">${escapeHtml(terms.acknowledgement)} <a href="${terms.docs}" target="_blank" rel="noopener noreferrer">`);
      expect(form).toContain('<button type="button" class="btn" data-sign-in-start disabled>Start sign-in</button>');
      expect(terms.acknowledgement).toMatch(new RegExp(`${terms.vendor}'s terms`));
      expect(terms.acknowledgement).toMatch(/is my responsibility/);
      expect(terms.acknowledgement).toMatch(/API key is the supported path/);
    }
  });

  it("links each acknowledgement to its own section of docs/model-endpoints.md", () => {
    const doc = fs.readFileSync(path.join(import.meta.dirname, "../../../docs/model-endpoints.md"), "utf8");
    const anchors = [...doc.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) => anchorOf(heading!));
    const docs = SIGN_INS.map((kind) => SIGN_IN_KINDS[kind].terms.docs);
    expect(new Set(docs).size).toBe(SIGN_INS.length);
    for (const link of docs) {
      expect(link.startsWith(`${MODEL_ENDPOINTS_DOCS}#`)).toBe(true);
      expect(anchors).toContain(link.slice(MODEL_ENDPOINTS_DOCS.length + 1));
    }
  });

  it("starts only from the form, enabling Start when the box is ticked and sending the acknowledgement", () => {
    expect(SCRIPT).toContain("const syncTerms = () => { startButton.disabled = !terms.checked; };");
    expect(SCRIPT).toContain('terms.addEventListener("change", syncTerms);');
    expect(SCRIPT).toContain('{ op: "start", id, signIn: kind, label, acknowledgedTerms: true }');
    // A signed-out card's button leads to its kind's form; nothing outside a form starts a sign-in.
    expect(SCRIPT).not.toContain("article button[data-sign-in-start]");
    expect(SCRIPT).toContain("article button[data-sign-in-again]");
  });

  for (const kind of SIGN_INS) {
    it(`refuses to start a ${SIGN_IN_KINDS[kind].title} sign-in without the acknowledgement, saying why, and starts nothing`, async () => {
      const context = await setup();
      const { title, terms } = SIGN_IN_KINDS[kind];
      for (const acknowledgedTerms of [undefined, false, "true", 1]) {
        const refused = await context.post({ op: "start", id: kind, signIn: kind, label: title, ...(acknowledgedTerms === undefined ? {} : { acknowledgedTerms }) });
        expect(refused.status).toBe(400);
        expect(refused.text).toContain(`acknowledge ${terms.vendor}'s terms first`);
        expect(refused.text).toContain("is your responsibility");
        expect(refused.text).toContain(terms.docs);
      }
      expect(context.signIns.status(kind).pendingSince).toBeNull();
      expect(context.anthropic.requests).toHaveLength(0);
      expect(context.github.requests).toHaveLength(0);
      expect(context.store.auditLog(5)).toEqual([]);
      // With it, the same start goes ahead, and the audit records the acknowledgement.
      const started = await context.post({ op: "start", id: kind, signIn: kind, label: title, acknowledgedTerms: true });
      expect(started.status).toBe(200);
      expect(context.signIns.status(kind).pendingSince).not.toBeNull();
      expect(context.store.auditLog(5)).toMatchObject([{ action: "endpoint.sign-in.start", target: kind, after: { signIn: kind, acknowledgedTerms: true } }]);
    });
  }
});
