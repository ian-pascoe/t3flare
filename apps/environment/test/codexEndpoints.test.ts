// Codex's Model endpoints (SPI-1167): its model list is the OpenAI Responses endpoints' models by slug, grouped by
// endpoint; other APIs are not Codex's. Each slug routes to its endpoint's provider; an old
// selection falls back to the default model (SPI-1176).
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
    // SPI-1171: Codex takes a ChatGPT sign-in through the relay as a Responses provider, and not a Copilot one.
    { id: "chatgpt", label: "ChatGPT", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "chatgpt", headers: {}, models: [model("gpt-6.1-sol")] },
    { id: "copilot", label: "GitHub Copilot", api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com", auth: "copilot", headers: {}, models: [model("gpt-6.1-sol")] },
  ],
};
describe("Codex's Model endpoints", () => {
  it("lists each Responses endpoint's models by slug, grouped by endpoint, the first the default; none without one", () => {
    const listed = codexModelsOf(endpoints);
    expect(listed.map((row) => [row.slug, row.subProvider, row.name, row.isDefault === true])).toEqual([
      ["openai/gpt-5-mini", "OpenAI", "GPT-5-MINI", true],
      ["gw/m1", "Anthropic", "M1", false],
      ["chatgpt/gpt-6.1-sol", "ChatGPT", "GPT-6.1-SOL", false],
    ]);
    // Without a Responses endpoint, Codex lists none.
    expect(codexModelsOf()).toEqual([]);
    expect(codexModelsOf({ revision: 1, endpoints: [endpoints.endpoints[1]!] })).toEqual([]);
  });

  it("routes a Responses endpoint's slug to its provider; an old selection to the default model (SPI-1176)", () => {
    const route = codexRouteFor(() => endpoints);
    expect(route("openai/gpt-5-mini")).toEqual({ provider: "t3flare-endpoint-openai", model: "gpt-5-mini" });
    // A ChatGPT sign-in's slug is its provider's (SPI-1171).
    expect(route("chatgpt/gpt-6.1-sol")).toEqual({ provider: "t3flare-endpoint-chatgpt", model: "gpt-6.1-sol" });
    // Old selections (bare ids, `anthropic/…`) and `default`: the first endpoint's first model.
    for (const old of ["gemini-3-flash", "gpt-6-luna", "anthropic/claude-haiku-5-5", "default"]) expect(route(old), old).toEqual({ provider: "t3flare-endpoint-openai", model: "gpt-5-mini" });
    // Another API's endpoint, or a Copilot sign-in (no endpoint of Codex's): its own provider, which Codex does not have.
    expect(route("claude/claude-haiku-5-5")).toEqual({ provider: "t3flare-endpoint-claude", model: "claude-haiku-5-5" });
    expect(route("copilot/gpt-6.1-sol")).toEqual({ provider: "t3flare-endpoint-copilot", model: "gpt-6.1-sol" });
    // No endpoint at all: nothing to fall back to.
    expect(codexRouteFor(() => undefined)("gpt-6-luna")).toEqual({ provider: "", model: "gpt-6-luna" });
  });
});
