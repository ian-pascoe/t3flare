// The model relay's target (SPI-1167): what the Environment answers a Workspace DO for an endpoint, from the store's
// `resolve`: the endpoint's base URL, its own headers and its key in the header its API takes, or why not.
import { relayTargetOf } from "@t3flare/models/relay";
import { describe, expect, it } from "vitest";

import { sealedStore } from "../src/credentials/sealed.ts";
import { endpointStore } from "../src/endpoints/store.ts";

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const setup = (credentialsKey: string | undefined = "c".repeat(64)) => {
  const kv = memory();
  return { kv, store: endpointStore(kv, sealedStore(kv, credentialsKey, () => 5_000)) };
};

const target = async (store: ReturnType<typeof setup>["store"], id: string) => relayTargetOf(await store.resolve(id), id);

const endpoint = (extra: Record<string, unknown>) => ({ id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", models: ["gpt-5-mini"], ...extra });

describe("the model relay's target", () => {
  it("is the endpoint's base URL and headers, with its key as a bearer for the OpenAI APIs", async () => {
    const { store } = setup();
    await store.save(endpoint({ headers: { "X-Org": "acme" } }), { apiKey: "sk-relay-1" });
    expect(await target(store, "openai")).toEqual({
      ok: true,
      baseUrl: "https://api.openai.com/v1",
      headers: { "X-Org": "acme", authorization: "Bearer sk-relay-1" },
      key: "sk-relay-1",
    });
  });

  it("puts the key in the header each API takes", async () => {
    const { store } = setup();
    await store.save(endpoint({ id: "claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: ["claude-haiku-5-5"] }), { apiKey: "sk-ant-1" });
    await store.save(endpoint({ id: "gemini", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-3-flash"] }), { apiKey: "g-key-1" });
    expect(await target(store, "claude")).toMatchObject({ ok: true, headers: { "x-api-key": "sk-ant-1" }, key: "sk-ant-1" });
    expect(await target(store, "gemini")).toMatchObject({ ok: true, headers: { "x-goog-api-key": "g-key-1" }, key: "g-key-1" });
  });

  it("adds no credential for an endpoint with no auth", async () => {
    const { store } = setup();
    await store.save(endpoint({ id: "local", auth: "none", baseUrl: "https://models.example.com/v1" }), {});
    expect(await target(store, "local")).toEqual({ ok: true, baseUrl: "https://models.example.com/v1", headers: {}, key: null });
  });

  it("refuses an endpoint that is gone (404) or whose key no longer opens (503), naming no key", async () => {
    const { kv, store } = setup();
    expect(await target(store, "openai")).toMatchObject({ ok: false, status: 404 });
    await store.save(endpoint({}), { apiKey: "sk-relay-2" });
    // Another credentials key over the same storage: the sealed key is there but does not open.
    const other = endpointStore(kv, sealedStore(kv, "d".repeat(64), () => 6_000));
    const refused = await target(other, "openai");
    expect(refused).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(refused)).toContain("enter it again");
    expect(JSON.stringify(refused)).not.toContain("sk-relay-2");
    store.remove("openai");
    expect(await target(store, "openai")).toMatchObject({ ok: false, status: 404 });
  });
});
