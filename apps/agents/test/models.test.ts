// The Session's pi-ai models from the catalog (ADR-0012): pi-ai's own metadata for a Claude model it knows, a family's
// newest for a Claude model it does not, a generic Anthropic Messages model for any other model the proxy serves, all
// through the proxy's base URL and key; and a catalog read again is in force at the next lookup.
import type { Model } from "@earendil-works/pi-ai";
import { type Catalog, mergeLists, STATIC_CATALOG } from "@t3flare/models/catalog";
import { describe, expect, it } from "vitest";

import { proxyModels } from "../src/session/models.ts";

const PROXY = { url: "https://proxy.example", apiKey: "cms_key" };

const catalogOf = (...listed: Array<{ id: string; displayName?: string; contextWindow?: number; maxTokens?: number }>): Catalog => ({
  models: mergeLists(listed, undefined),
  fetchedAt: 1,
});

const listed = (models: ReturnType<typeof proxyModels>) => models.getModels("anthropic") as ReadonlyArray<Model<"anthropic-messages">>;

describe("proxyModels", () => {
  it("lists the static models, through the proxy, with pi-ai's price for each", () => {
    const models = listed(proxyModels(PROXY, () => STATIC_CATALOG));
    expect(models.map((model) => model.id)).toEqual(STATIC_CATALOG.models.map((model) => model.id));
    for (const model of models) {
      expect(model.baseUrl).toBe(PROXY.url);
      expect(model.api).toBe("anthropic-messages");
    }
    expect(models.find((model) => model.id === "claude-sonnet-5-5")?.cost.output).toBeGreaterThan(0);
  });

  it("has a model the proxy lists that pi-ai does not know: a Claude from its family's newest, any other generic", () => {
    const catalog = catalogOf(
      { id: "claude-sonnet-9-9", displayName: "Claude Sonnet 9.9", contextWindow: 900_000, maxTokens: 70_000 },
      { id: "gemini-3-flash", displayName: "Gemini 3 Flash", contextWindow: 1_000_000, maxTokens: 65_536 },
      { id: "deepseek-v4-pro" },
    );
    const models = listed(proxyModels(PROXY, () => catalog));
    const byId = Object.fromEntries(models.map((model) => [model.id, model]));

    // A newer Claude takes the family's price and thinking from pi-ai's newest, and the catalog's name and limits.
    expect(byId["claude-sonnet-9-9"]).toMatchObject({ name: "Claude Sonnet 9.9", baseUrl: PROXY.url, maxTokens: 70_000, contextWindow: 400_000 });
    expect(byId["claude-sonnet-9-9"]?.cost.output).toBeGreaterThan(0);
    expect(byId["claude-sonnet-9-9"]?.reasoning).toBe(true);

    // Any other model: a generic Anthropic Messages model with the limits the catalog gives, no price, no thinking.
    expect(byId["gemini-3-flash"]).toEqual({
      id: "gemini-3-flash",
      name: "Gemini 3 Flash",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: PROXY.url,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
    expect(byId["deepseek-v4-pro"]).toMatchObject({ name: "deepseek-v4-pro", contextWindow: 200_000, maxTokens: 32_000 });
  });

  it("is made again when the catalog is another one, and not otherwise", () => {
    let catalog = catalogOf({ id: "gemini-3-flash" });
    const models = proxyModels(PROXY, () => catalog);
    const first = listed(models);
    expect(listed(models)).toBe(first);
    catalog = catalogOf({ id: "gemini-3-flash" }, { id: "deepseek-v4-pro" });
    expect(listed(models).map((model) => model.id)).toEqual(["gemini-3-flash", "deepseek-v4-pro"]);
  });

  it("finds a model by its id, and only the catalog's", () => {
    const models = proxyModels(PROXY, () => catalogOf({ id: "gemini-3-flash" }));
    expect(models.getModel("anthropic", "gemini-3-flash")?.id).toBe("gemini-3-flash");
    expect(models.getModel("anthropic", "claude-opus-4-6")).toBeUndefined();
  });
});
