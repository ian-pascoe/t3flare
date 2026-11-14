// Codex's Model endpoints (SPI-1167): its model list is the Model proxy's, then the OpenAI Responses endpoints' models by
// slug, grouped by endpoint; other APIs are not Codex's. Each slug routes to its endpoint's provider.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { codexModelsOf, codexRouteFor } from "../src/provider/cli/codexEndpoints.ts";

const model = (id: string) => ({ id, name: id.toUpperCase(), reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoints: ModelEndpoints = {
  revision: 3,
  endpoints: [
    { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: [model("gpt-5-mini")] },
    { id: "claude", label: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "api-key", headers: {}, models: [model("claude-haiku-5-5")] },
    { id: "gw", label: "Anthropic", api: "openai-responses", baseUrl: "https://gw.example.com/v1", auth: "none", headers: {}, models: [model("m1")] },
  ],
};
const proxy = [{ slug: "gemini-3-flash", name: "Gemini 3 Flash", subProvider: "Anthropic", isCustom: false, capabilities: { optionDescriptors: [] } }];

describe("Codex's Model endpoints", () => {
  it("lists the proxy's models, then each Responses endpoint's by slug, grouped by endpoint", () => {
    expect(codexModelsOf(proxy, endpoints).map((row) => [row.slug, row.subProvider, row.name])).toEqual([
      ["gemini-3-flash", "Anthropic", "Gemini 3 Flash"],
      ["openai/gpt-5-mini", "OpenAI", "GPT-5-MINI"],
      // A label a proxy vendor has is told apart by the endpoint's id.
      ["gw/m1", "Anthropic · gw", "M1"],
    ]);
    expect(codexModelsOf(proxy)).toEqual(proxy);
  });

  it("routes a Responses endpoint's slug to its provider, and every other model to the proxy", () => {
    const route = codexRouteFor(() => endpoints);
    expect(route("openai/gpt-5-mini")).toEqual({ provider: "t3flare-endpoint-openai", model: "gpt-5-mini" });
    expect(route("claude/claude-haiku-5-5")).toEqual({ provider: "t3flare-proxy", model: "claude/claude-haiku-5-5" });
    expect(route("gemini-3-flash")).toEqual({ provider: "t3flare-proxy", model: "gemini-3-flash" });
    expect(codexRouteFor(() => undefined)("openai/gpt-5-mini")).toEqual({ provider: "t3flare-proxy", model: "openai/gpt-5-mini" });
  });
});
