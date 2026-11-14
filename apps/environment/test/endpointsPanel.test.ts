// The Harness panel's Model endpoints routes (SPI-1162): their own entity and revision, write-only keys (the answer and
// the audit log carry the key's mark, never the key), the page's model-list read with the stored key, and the panel's
// guards (CSRF, Origin, JSON) as on its other routes.
import { describe, expect, it } from "vitest";

import { sealedStore } from "../src/credentials/sealed.ts";
import type { Discovery } from "../src/endpoints/discover.ts";
import { endpointStore } from "../src/endpoints/store.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness, type HarnessCaller, type HarnessDeps } from "../src/harness/panel.ts";
import { harnessStore } from "../src/harness/store.ts";

const HOST = "t3.example.dev";
const NOW = Date.UTC(2026, 10, 14, 10, 0);
const owner: HarnessCaller = { kind: "owner", subject: "owner-sub" };
const SECRET = "sk-panel-secret-0001";

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const setup = (caller: HarnessCaller = owner) => {
  const kv = memory();
  const store = harnessStore(kv);
  const endpoints = endpointStore(kv, sealedStore(kv, "d".repeat(64), () => NOW));
  const discovered: Array<{ baseUrl: string; apiKey: string | undefined }> = [];
  let changes = 0;
  const deps: HarnessDeps = {
    caller,
    host: HOST,
    store,
    now: () => NOW,
    endpoints: {
      store: endpoints,
      discover: async (target, apiKey): Promise<Discovery> => {
        discovered.push({ baseUrl: target.baseUrl, apiKey });
        return { ok: true, models: [{ id: "gpt-5-mini" }] };
      },
      changed: () => void changes++,
    },
  };
  return { store, endpoints, deps, discovered, changes: () => changes };
};

const headersOf = async (store: ReturnType<typeof setup>["store"]) => ({
  "content-type": "application/json",
  origin: `https://${HOST}`,
  "sec-fetch-site": "same-origin",
  [CSRF_HEADER]: await csrfToken(store.csrfKey(), "owner-sub", NOW),
});

const post = async (deps: HarnessDeps, path: string, body: unknown, headers: Record<string, string>) =>
  handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), deps);

const ENDPOINT = { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: { "OpenAI-Organization": "org-1" }, models: ["gpt-5-mini"] };

describe("Model endpoints on the Harness panel", () => {
  it("saves an endpoint with its key sealed: its own revision, audited with the key's mark only, listed without the key", async () => {
    const { store, endpoints, deps, changes } = setup();
    const response = await post(deps, "endpoints", { op: "save", endpoint: ENDPOINT, apiKey: SECRET }, await headersOf(store));
    expect(response.status).toBe(200);
    const answer = await response.text();
    expect(answer).not.toContain(SECRET);
    expect(JSON.parse(answer)).toMatchObject({ ok: true, revision: 1, key: { set: true } });
    expect(endpoints.load().revision).toBe(1);
    expect(store.load().revision).toBe(0);
    expect(changes()).toBe(1);
    const [entry] = store.auditLog(5);
    expect(entry).toMatchObject({ entity: "endpoints", action: "endpoint.add", target: "openai", caller: "owner:owner-sub", after: { api: "openai-responses", headers: ["OpenAI-Organization"], models: ["gpt-5-mini"], key: { set: true } } });
    expect(JSON.stringify(store.auditLog(5))).not.toContain(SECRET);
    // The header's value is not audited either: only its name.
    expect(JSON.stringify(store.auditLog(5))).not.toContain("org-1");

    const listed = await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/endpoints`), deps);
    const body = await listed.text();
    expect(body).not.toContain(SECRET);
    expect(JSON.parse(body)).toMatchObject({ revision: 1, credentialsKey: true, endpoints: [{ id: "openai", key: { set: true, setAt: NOW } }], presets: expect.any(Array) });
  });

  it("shows each endpoint on the page, escaped, with its slugs and never its key", async () => {
    const { store, deps } = setup();
    await post(deps, "endpoints", { op: "save", endpoint: { ...ENDPOINT, label: "<img src=x>" }, apiKey: SECRET }, await headersOf(store));
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), deps)).text();
    expect(html).toContain('id="endpoints"');
    expect(html).toContain("openai/gpt-5-mini");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain(SECRET);
  });

  it("removes an endpoint and its key, audited", async () => {
    const { store, endpoints, deps } = setup();
    await post(deps, "endpoints", { op: "save", endpoint: ENDPOINT, apiKey: SECRET }, await headersOf(store));
    const response = await post(deps, "endpoints", { op: "remove", id: "openai" }, await headersOf(store));
    expect(response.status).toBe(200);
    expect(endpoints.load()).toMatchObject({ revision: 2, endpoints: [] });
    expect(await endpoints.apiKey("openai")).toBeUndefined();
    expect(store.auditLog(1)).toMatchObject([{ entity: "endpoints", action: "endpoint.remove", target: "openai" }]);
  });

  it("reads a model list with the key given, or else the saved endpoint's own", async () => {
    const { store, deps, discovered } = setup();
    const given = await post(deps, "endpoints/discover", { endpoint: { ...ENDPOINT, id: "new" }, apiKey: "sk-typed" }, await headersOf(store));
    expect(await given.json()).toMatchObject({ ok: true, models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", known: true }] });
    await post(deps, "endpoints", { op: "save", endpoint: ENDPOINT, apiKey: SECRET }, await headersOf(store));
    await post(deps, "endpoints/discover", { endpoint: ENDPOINT }, await headersOf(store));
    expect(discovered).toEqual([
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-typed" },
      { baseUrl: "https://api.openai.com/v1", apiKey: SECRET },
    ]);
  });

  it("refuses a change without the page's token, from another origin, or form-encoded, and an invalid endpoint", async () => {
    const { store, endpoints, deps } = setup();
    const good = await headersOf(store);
    const body = { op: "save", endpoint: ENDPOINT, apiKey: SECRET };
    expect((await post(deps, "endpoints", body, { ...good, [CSRF_HEADER]: "" })).status).toBe(403);
    expect((await post(deps, "endpoints", body, { ...good, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(deps, "endpoints/discover", body, { ...good, [CSRF_HEADER]: "" })).status).toBe(403);
    expect((await post(deps, "endpoints", "op=save", { ...good, "content-type": "application/x-www-form-urlencoded" })).status).toBe(403);
    const invalid = await post(deps, "endpoints", { op: "save", endpoint: { ...ENDPOINT, id: "anthropic" }, apiKey: SECRET }, good);
    expect(invalid.status).toBe(400);
    expect(endpoints.load().revision).toBe(0);
    expect(store.auditLog(5)).toEqual([]);
  });

  it("lets the stage's script save without a CSRF token", async () => {
    const { deps, endpoints } = setup({ kind: "service-token" });
    const response = await post(deps, "endpoints", { op: "save", endpoint: ENDPOINT, apiKey: SECRET }, { "content-type": "application/json" });
    expect(response.status).toBe(200);
    expect(endpoints.load().endpoints).toHaveLength(1);
  });
});
