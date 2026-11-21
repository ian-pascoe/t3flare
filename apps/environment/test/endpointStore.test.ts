// The Model endpoints' store (SPI-1162): its own entity and revision, the models' metadata from pi-ai's catalog where it
// knows them (the owner's own fields win), and the API key sealed apart from the entity, write-only, refused when the
// Environment has no credentials key.
import { copilotModelApi, knownModel } from "@t3flare/models/known";
import { describe, expect, it } from "vitest";

import { sealedStore } from "../src/credentials/sealed.ts";
import { endpointStore } from "../src/endpoints/store.ts";
import { harnessStore } from "../src/harness/store.ts";

const KEY = "c".repeat(64);

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const setup = (options: { readonly credentialsKey?: string } = { credentialsKey: KEY }) => {
  const kv = memory();
  return { kv, store: endpointStore(kv, sealedStore(kv, options.credentialsKey, () => 5_000)) };
};

const OPENAI = { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1/", auth: "api-key", models: ["gpt-5-mini", { id: "my-tuned", name: "Mine", reasoning: true }] };

describe("endpointStore", () => {
  it("adds an endpoint with its models' metadata, its own revision, and its key sealed apart", async () => {
    const { kv, store } = setup();
    const saved = await store.save(OPENAI, { apiKey: "sk-test-openai-1" });
    expect(saved).toMatchObject({ ok: true, added: true, key: { set: true, setAt: 5_000 } });
    const { revision, endpoints } = store.load();
    expect(revision).toBe(1);
    expect(endpoints).toHaveLength(1);
    const [endpoint] = endpoints;
    expect(endpoint).toMatchObject({ id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {} });
    const known = endpoint!.models[0]!;
    expect(known).toMatchObject({ id: "gpt-5-mini", name: "GPT-5 Mini", reasoning: true, known: true });
    expect(known.cost.output).toBeGreaterThan(0);
    expect(endpoint!.models[1]).toMatchObject({ id: "my-tuned", name: "Mine", reasoning: true, known: false, contextWindow: 128_000, cost: { input: 0, output: 0 } });
    expect((await store.resolve("openai"))?.apiKey).toBe("sk-test-openai-1");
    expect(JSON.stringify([...kv.map.entries()])).not.toContain("sk-test-openai-1");
    // The Harness settings and the Environment settings are other entities: their revisions do not move.
    expect(harnessStore(kv).load().revision).toBe(0);
    expect(harnessStore(kv).loadEnvironment().revision).toBe(0);
  });

  it("keeps the key through an edit that does not give one, and replaces it when one is given", async () => {
    const { store } = setup();
    await store.save(OPENAI, { apiKey: "sk-first" });
    const edited = await store.save({ ...OPENAI, label: "OpenAI (work)", models: ["gpt-5"] }, {});
    expect(edited).toMatchObject({ ok: true, added: false });
    expect(store.load()).toMatchObject({ revision: 2, endpoints: [{ label: "OpenAI (work)", models: [{ id: "gpt-5" }] }] });
    expect((await store.resolve("openai"))?.apiKey).toBe("sk-first");
    const before = (await store.keyStatus("openai")).fingerprint;
    await store.save(OPENAI, { apiKey: "sk-second" });
    expect((await store.resolve("openai"))?.apiKey).toBe("sk-second");
    expect((await store.keyStatus("openai")).fingerprint).not.toBe(before);
  });

  it("refuses an API-key endpoint without a key, and any key without a credentials key", async () => {
    expect(await setup().store.save(OPENAI, {})).toMatchObject({ ok: false, error: expect.stringMatching(/API key/) });
    const { store } = setup({});
    expect(await store.save(OPENAI, { apiKey: "sk-x" })).toMatchObject({ ok: false, error: expect.stringMatching(/credentials key/) });
    expect(store.load().endpoints).toEqual([]);
    // An endpoint with no auth needs no key, and is stored without one.
    expect(await store.save({ ...OPENAI, id: "local", auth: "none" }, {})).toMatchObject({ ok: true });
  });

  it("drops the key when an endpoint switches to no auth, and with the endpoint when it is removed", async () => {
    const { store } = setup();
    await store.save(OPENAI, { apiKey: "sk-first" });
    await store.save({ ...OPENAI, auth: "none" }, {});
    expect((await store.keyStatus("openai")).set).toBe(false);
    await store.save(OPENAI, { apiKey: "sk-again" });
    expect(store.remove("openai")).toMatchObject({ ok: true, removed: { id: "openai" } });
    expect(store.load()).toMatchObject({ revision: 4, endpoints: [] });
    expect((await store.resolve("openai"))?.apiKey).toBeUndefined();
    expect(store.remove("openai")).toMatchObject({ ok: false });
  });

  it("refuses a reserved id, a credential in a header, and a plain-http base URL", async () => {
    const { store } = setup();
    expect(await store.save({ ...OPENAI, id: "anthropic" }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/reserved/) });
    expect(await store.save({ ...OPENAI, headers: { Authorization: "Bearer x" } }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/credential/) });
    expect(await store.save({ ...OPENAI, baseUrl: "http://api.openai.com/v1" }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
    expect(store.load().revision).toBe(0);
  });

  it("refuses to keep a saved key for an edit that moves the API or the base URL, and takes one given with it", async () => {
    const { store } = setup();
    await store.save(OPENAI, { apiKey: "sk-first" });
    for (const moved of [{ baseUrl: "https://evil.example/v1" }, { api: "openai-completions" }]) {
      expect(await store.save({ ...OPENAI, ...moved }, {})).toMatchObject({ ok: false, error: expect.stringMatching(/API key entered again/) });
    }
    expect(store.load()).toMatchObject({ revision: 1, endpoints: [{ baseUrl: "https://api.openai.com/v1", api: "openai-responses" }] });
    expect(await store.save({ ...OPENAI, baseUrl: "https://other.example/v1" }, { apiKey: "sk-other" })).toMatchObject({ ok: true });
    expect(await store.resolve("openai")).toMatchObject({ endpoint: { baseUrl: "https://other.example/v1" }, apiKey: "sk-other" });
  });

  it("refuses to keep a saved key for an edit that adds or changes a header", async () => {
    const { store } = setup();
    await store.save(OPENAI, { apiKey: "sk-first" });
    for (const headers of [{ "Helicone-Target-Url": "https://evil.example" }, {}]) {
      if (Object.keys(headers).length === 0) {
        await store.save({ ...OPENAI, headers: { "X-Org": "a" } }, { apiKey: "sk-first" });
        expect(await store.save({ ...OPENAI, headers: { "X-Org": "b" } }, {})).toMatchObject({ ok: false, error: expect.stringMatching(/API key entered again/) });
      } else expect(await store.save({ ...OPENAI, headers }, {})).toMatchObject({ ok: false, error: expect.stringMatching(/API key entered again/) });
    }
    // Two header names that differ only in case are one header given twice.
    expect(await store.save({ ...OPENAI, headers: { "X-Org": "a", "x-org": "b" } }, { apiKey: "sk-first" })).toMatchObject({ ok: false, error: expect.stringMatching(/given twice/) });
    // A gateway's auth header carries a credential too, in any case.
    expect(await store.save({ ...OPENAI, headers: { "CF-AIG-Authorization": "Bearer x" } }, { apiKey: "sk-first" })).toMatchObject({ ok: false, error: expect.stringMatching(/carries a credential/) });
    // The same headers under other-cased names are the same target.
    expect(await store.save({ ...OPENAI, headers: { "x-org": "a" } }, {})).toMatchObject({ ok: true });
  });

  it("seals no key for a refused save, and never pairs a stored key with a new endpoint", async () => {
    const { kv, store } = setup();
    for (let i = 0; i < 32; i++) await store.save({ ...OPENAI, id: `e${i}` }, { apiKey: `k${i}` });
    expect(await store.save({ ...OPENAI, id: "victim", baseUrl: "https://good.example/v1" }, { apiKey: "sk-owner" })).toMatchObject({ ok: false, error: expect.stringMatching(/at most 32/) });
    expect((await store.keyStatus("victim")).set).toBe(false);
    expect(JSON.stringify([...kv.map.keys()])).not.toContain("endpoint/victim/");
    store.remove("e0");
    // A key stored under an id with no endpoint (as an older build could leave) is never adopted by a keyless create.
    await sealedStore(kv, KEY).put("endpoint/victim/api-key", "sk-orphan");
    expect(await store.save({ ...OPENAI, id: "victim", baseUrl: "https://evil.example/v1" }, {})).toMatchObject({ ok: false, error: expect.stringMatching(/needs its API key/) });
    expect(await store.resolve("victim")).toBeUndefined();
    // A create with its own key replaces it.
    expect(await store.save({ ...OPENAI, id: "victim" }, { apiKey: "sk-new" })).toMatchObject({ ok: true });
    expect((await store.resolve("victim"))?.apiKey).toBe("sk-new");
  });

  it("gives a Session's request a key only for the endpoint's target now", async () => {
    const { store } = setup();
    await store.save({ ...OPENAI, headers: { "X-Org": "a" } }, { apiKey: "sk-now" });
    const target = { api: "openai-responses", baseUrl: "https://api.openai.com/v1", headers: { "x-org": "a" } } as const;
    expect(await store.credential({ endpointId: "openai", target })).toEqual({ apiKey: "sk-now" });
    expect(await store.credential({ endpointId: "openai", target: { ...target, baseUrl: "https://old.example/v1" } })).toEqual({ apiKey: null, changed: true });
    expect(await store.credential({ endpointId: "openai", target: { ...target, headers: {} } })).toEqual({ apiKey: null, changed: true });
    expect(await store.credential({ endpointId: "gone", target })).toEqual({ apiKey: null, changed: true });
  });

  it("refuses an IP literal, localhost, an internal host, or a bare query or fragment in the base URL", async () => {
    const { store } = setup();
    for (const baseUrl of ["https://api.openai.com/v1#", "https://api.openai.com/v1?"]) {
      expect(await store.save({ ...OPENAI, baseUrl }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/query or fragment/) });
    }
    for (const baseUrl of ["https://127.0.0.1/v1", "https://[::1]/v1", "https://localhost/v1", "https://localhost./v1", "https://api.localhost/v1", "https://llm.internal/v1", "https://2130706433/v1"]) {
      expect(await store.save({ ...OPENAI, baseUrl }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/public host name/) });
    }
  });

  it("marks a key the credentials key no longer opens as unreadable, and resolves it as such", async () => {
    const kv = memory();
    await endpointStore(kv, sealedStore(kv, KEY)).save(OPENAI, { apiKey: "sk-old" });
    const rotated = endpointStore(kv, sealedStore(kv, "e".repeat(64)));
    expect(await rotated.keyStatus("openai")).toMatchObject({ set: true, readable: false });
    expect(await rotated.resolve("openai")).toMatchObject({ apiKey: undefined, unreadable: true });
    expect(await endpointStore(kv, sealedStore(kv, KEY)).keyStatus("openai")).toMatchObject({ set: true, readable: true });
  });

  it("loses no update when two saves interleave", async () => {
    const { store } = setup();
    await Promise.all([store.save(OPENAI, { apiKey: "sk-a" }), store.save({ ...OPENAI, id: "other", label: "Other" }, { apiKey: "sk-b" })]);
    expect(store.load()).toMatchObject({ revision: 2 });
    expect(store.load().endpoints.map((endpoint) => endpoint.id).sort()).toEqual(["openai", "other"]);
  });
});

describe("pi-ai's GitHub Copilot catalog (SPI-1166)", () => {
  const copilot = { api: "openai-responses" as const, baseUrl: "https://api.individual.githubcopilot.com" };

  it("gives a Copilot endpoint's models Copilot's metadata and compat, first", () => {
    expect(knownModel("mai-code-1.1-flash", copilot)).toMatchObject({ reasoning: true });
    // Copilot's compat for a model OpenAI's catalog has too, not OpenAI's (no tool search on Copilot).
    expect(knownModel("gpt-6.1-sol", copilot)?.compat).not.toHaveProperty("supportsToolSearch");
    expect(knownModel("gpt-6.1-sol", { api: "openai-responses", baseUrl: "https://api.openai.com/v1" })?.compat).toHaveProperty("supportsToolSearch", true);
    expect(copilotModelApi("gpt-6.1-sol")).toBe("openai-responses");
    expect(copilotModelApi("claude-haiku-4.5")).toBe("anthropic-messages");
    expect(copilotModelApi("nope")).toBeUndefined();
  });

  it("is read for Copilot's own host only: its ids and prices are no other endpoint's", () => {
    expect(knownModel("mai-code-1.1-flash", { api: "openai-responses", baseUrl: "https://gw.example.com/v1" })).toBeUndefined();
    expect(knownModel("claude-haiku-4.5", { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" })).toBeUndefined();
  });
});
