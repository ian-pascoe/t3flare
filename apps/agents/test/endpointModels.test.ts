// The Session's pi-ai providers from the Model endpoints (SPI-1162): one provider per endpoint, under the endpoint's id, so
// a model's ref is `{ provider: <endpointId>, modelId }` (its slug `<endpointId>/<modelId>`); each model with the
// endpoint's API, base URL and the metadata stored with it; the key fetched at use time, never held by the provider.
import { createModels } from "@earendil-works/pi-ai";
import type { EndpointCredential, ModelEndpoints } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { endpointProviders } from "../src/session/models.ts";

const COST = { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 };

const ENDPOINTS: ModelEndpoints = {
  revision: 3,
  endpoints: [
    {
      id: "openai",
      label: "OpenAI",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      auth: "api-key",
      headers: { "OpenAI-Organization": "org-1" },
      models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", reasoning: true, input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000, cost: COST, known: true, thinkingLevelMap: { off: null } }],
    },
    {
      id: "commissary",
      label: "Commissary",
      api: "anthropic-messages",
      baseUrl: "https://proxy.example",
      auth: "api-key",
      headers: {},
      models: [{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 64_000, cost: COST, known: true }],
    },
    { id: "local", label: "Local", api: "openai-completions", baseUrl: "https://llm.example/v1", auth: "none", headers: {}, models: [] },
  ],
};

const modelsWith = (credential: (id: string) => Promise<EndpointCredential>) => {
  const models = createModels();
  for (const provider of endpointProviders(ENDPOINTS, { credential })) models.setProvider(provider);
  return models;
};

describe("endpointProviders", () => {
  it("makes one provider per endpoint, each model under the endpoint's id with its API, base URL and stored metadata", () => {
    const models = modelsWith(async () => ({ apiKey: "k" }));
    expect(models.getProviders().map((provider) => provider.id)).toEqual(["openai", "commissary", "local"]);
    expect(models.getModel("openai", "gpt-5-mini")).toMatchObject({
      id: "gpt-5-mini",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      name: "GPT-5 Mini",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: COST,
      thinkingLevelMap: { off: null },
    });
    expect(models.getModel("commissary", "claude-haiku-5-5")).toMatchObject({ api: "anthropic-messages", baseUrl: "https://proxy.example" });
    expect(models.getProvider("openai")?.headers).toEqual({ "OpenAI-Organization": "org-1" });
  });

  it("resolves each endpoint's key at use time, from the credential source", async () => {
    const asked: Array<string> = [];
    const models = modelsWith(async (id) => {
      asked.push(id);
      return { apiKey: `key-of-${id}` };
    });
    expect(asked).toEqual([]);
    expect((await models.getAuth("openai"))?.auth).toMatchObject({ apiKey: "key-of-openai", baseUrl: "https://api.openai.com/v1" });
    expect((await models.getAuth("commissary"))?.auth.apiKey).toBe("key-of-commissary");
    expect((await models.getAuth("local"))?.auth.apiKey).toBeUndefined();
    expect(asked).toEqual(["openai", "commissary"]);
  });

  it("fails an API-key endpoint whose key is gone with a message that says so", async () => {
    const models = modelsWith(async () => ({ apiKey: null }));
    await expect(models.getAuth("openai")).rejects.toThrow(/Model endpoint "openai" has no API key/);
  });

  it("fails an endpoint whose stored key no longer opens with a message to enter it again", async () => {
    const models = modelsWith(async () => ({ apiKey: null, unreadable: true }));
    await expect(models.getAuth("openai")).rejects.toThrow(/can no longer be read .*enter it again/);
  });
});
