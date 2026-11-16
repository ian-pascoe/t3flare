// @effect-diagnostics globalConsole:off
// ChatGPT plan usage on the Harness panel (SPI-1164): the owner starts the sign-in, opens the authorize link, pastes the
// address the browser lands on, and sees the account or why it failed; a ChatGPT endpoint is saved with the models its
// token lists; sign-out revokes and stops the endpoint's Sessions. The panel's answers, page and audit log never hold a
// token. Against the panel's real routes, a real endpoint store and broker, and a fake of OpenAI's authorization server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialBroker } from "../src/credentials/broker.ts";
import { chatgptSignIn } from "../src/credentials/chatgpt.ts";
import { sealedStore } from "../src/credentials/sealed.ts";
import type { Discovery } from "../src/endpoints/discover.ts";
import { endpointStore } from "../src/endpoints/store.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness, type HarnessCaller, type HarnessDeps } from "../src/harness/panel.ts";
import { harnessStore } from "../src/harness/store.ts";
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
  const now = () => NOW;
  const vendor = await fakeOpenAI({ now });
  const sealed = sealedStore(kv, "e".repeat(64), now);
  const signIns = credentialBroker({ kv, sealed, vendors: { chatgpt: chatgptSignIn({ fetch: vendor.fetch, now }) }, now });
  const endpoints = endpointStore(kv, sealed, signIns);
  const discovered: Array<{ baseUrl: string; apiKey: string | undefined }> = [];
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
      discover: async (target, apiKey) => {
        discovered.push({ baseUrl: target.baseUrl, apiKey });
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
    const response = await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), deps);
    return { status: response.status, text: await response.text() };
  };
  const page = async () => (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), deps)).text();
  /** Everything a token must never reach: the storage, the audit log, the console. */
  const leaks = () => {
    const places = [JSON.stringify([...kv.map.entries()]), JSON.stringify(store.auditLog(50)), logged.join("\n")];
    return vendor.secrets().filter((token) => places.some((place) => place.includes(token)));
  };
  return { kv, store, vendor, signIns, endpoints, deps, post, page, discovered, stopped, leaks, changes: () => changes, list: (next: Discovery) => void (listed = next) };
};

/** Start and paste, as the owner does; the answers' texts. */
const signIn = async (context: Awaited<ReturnType<typeof setup>>) => {
  const started = await context.post({ op: "start", id: "chatgpt", signIn: "chatgpt", label: "ChatGPT" });
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
    expect(context.discovered).toEqual([{ baseUrl: "https://api.openai.com/v1", apiKey: context.vendor.issued[0] }]);
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
    expect(await context.page()).toContain('data-sign-in-start="chatgpt"');
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
    expect((await context.post({ op: "start", id: "chatgpt", signIn: "nope", label: "ChatGPT" })).status).toBe(400);
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
    const started = await context.post({ op: "start", id: "openai", signIn: "chatgpt", label: "ChatGPT" });
    expect(started.status).toBe(400);
    expect(started.text).toMatch(/already an endpoint with an API key/);
  });
});
