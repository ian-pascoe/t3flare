// The Model endpoints' store (SPI-1162): its own entity and revision, the models' metadata from pi-ai's catalog where it
// knows them (the owner's own fields win), and the API key sealed apart from the entity, write-only, refused when the
// Environment has no credentials key.
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
    expect(await store.apiKey("openai")).toBe("sk-test-openai-1");
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
    expect(await store.apiKey("openai")).toBe("sk-first");
    const before = store.keyMark("openai").fingerprint;
    await store.save(OPENAI, { apiKey: "sk-second" });
    expect(await store.apiKey("openai")).toBe("sk-second");
    expect(store.keyMark("openai").fingerprint).not.toBe(before);
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
    expect(store.keyMark("openai").set).toBe(false);
    await store.save(OPENAI, { apiKey: "sk-again" });
    expect(store.remove("openai")).toMatchObject({ ok: true, removed: { id: "openai" } });
    expect(store.load()).toMatchObject({ revision: 4, endpoints: [] });
    expect(await store.apiKey("openai")).toBeUndefined();
    expect(store.remove("openai")).toMatchObject({ ok: false });
  });

  it("refuses a reserved id, a credential in a header, and a plain-http base URL", async () => {
    const { store } = setup();
    expect(await store.save({ ...OPENAI, id: "anthropic" }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/reserved/) });
    expect(await store.save({ ...OPENAI, headers: { Authorization: "Bearer x" } }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/credential/) });
    expect(await store.save({ ...OPENAI, baseUrl: "http://api.openai.com/v1" }, { apiKey: "k" })).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
    expect(store.load().revision).toBe(0);
  });

  it("resolves an endpoint with its key for a caller that uses it", async () => {
    const { store } = setup();
    await store.save(OPENAI, { apiKey: "sk-use" });
    expect(await store.resolve("openai")).toMatchObject({ endpoint: { id: "openai" }, apiKey: "sk-use" });
    expect(await store.resolve("nope")).toBeUndefined();
  });
});
