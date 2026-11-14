// The Pi Durable picker with Model endpoints (SPI-1162): every endpoint's models as `<endpointId>/<modelId>`, grouped by
// endpoint after the Model proxy's vendors, a reasoning model with the thinking picker; the proxy's models as before.
import { mergeLists } from "@t3flare/models/catalog";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { snapshotModels } from "../src/provider/models.ts";

const COST = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const model = (id: string, name: string, reasoning: boolean) => ({ id, name, reasoning, input: ["text" as const], contextWindow: 100_000, maxTokens: 10_000, cost: COST, known: true });

const ENDPOINTS: ModelEndpoints = {
  revision: 2,
  endpoints: [
    { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: [model("gpt-5-mini", "GPT-5 Mini", true), model("gpt-4.1", "GPT-4.1", false)] },
    { id: "commissary", label: "Anthropic", api: "anthropic-messages", baseUrl: "https://proxy.example", auth: "api-key", headers: {}, models: [model("claude-haiku-5-5", "Claude Haiku 5.5", true)] },
  ],
};

describe("snapshotModels with Model endpoints", () => {
  it("lists each endpoint's models by slug, grouped by endpoint after the proxy's, with thinking for reasoning models", () => {
    const catalog = { models: mergeLists([{ id: "claude-sonnet-5-5" }], undefined), fetchedAt: 1 };
    const models = snapshotModels(catalog, ENDPOINTS);
    expect(models.map((entry) => `${entry.subProvider} ${entry.slug}`)).toEqual([
      "Anthropic anthropic/claude-sonnet-5-5",
      "OpenAI openai/gpt-5-mini",
      "OpenAI openai/gpt-4.1",
      // An endpoint whose label is a proxy vendor's is told apart by its id, so the two groups never merge.
      "Anthropic · commissary commissary/claude-haiku-5-5",
    ]);
    const thinking = (slug: string) => models.find((entry) => entry.slug === slug)?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [];
    expect(thinking("openai/gpt-5-mini")).toEqual(["thinking"]);
    expect(thinking("openai/gpt-4.1")).toEqual([]);
    expect(models.find((entry) => entry.slug === "openai/gpt-5-mini")).toMatchObject({ name: "GPT-5 Mini", isCustom: false });
    expect(models.filter((entry) => entry.isDefault === true).map((entry) => entry.slug)).toEqual(["anthropic/claude-sonnet-5-5"]);
  });

  it("is the proxy's list alone without endpoints", () => {
    const catalog = { models: mergeLists([{ id: "claude-sonnet-5-5" }], undefined), fetchedAt: 1 };
    expect(snapshotModels(catalog, { revision: 0, endpoints: [] })).toEqual(snapshotModels(catalog));
  });
});
