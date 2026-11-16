// OpenCode's Model endpoints (SPI-1169): with an endpoint whose API OpenCode speaks (Anthropic Messages, OpenAI
// Responses, OpenAI-compatible Completions) and that lists a model, OpenCode runs on those endpoints through the model
// relay, one provider each; its list is their models by slug, its model ids their providers'; with none, the proxy.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { opencodeEndpoints, opencodeModelId, opencodeModelsOf, opencodeRelayOf } from "../src/provider/cli/opencodeEndpoints.ts";

const model = (id: string, extra: { reasoning?: boolean } = {}) => ({
  id,
  name: id.toUpperCase(),
  reasoning: extra.reasoning ?? false,
  input: ["text" as const],
  contextWindow: 1,
  maxTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  known: false,
});
const endpoints: ModelEndpoints = {
  revision: 3,
  endpoints: [
    { id: "gem", label: "Gemini", api: "google-generative-ai", baseUrl: "https://g.example", auth: "api-key", headers: {}, models: [model("gemini-x")] },
    { id: "comm", label: "Commissary", api: "anthropic-messages", baseUrl: "https://c.example", auth: "api-key", headers: {}, models: [model("claude-sonnet-5-5", { reasoning: true }), model("claude-haiku-5-5")] },
    { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: [model("gpt-5-mini")] },
    { id: "or", label: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", auth: "api-key", headers: {}, models: [model("anthropic/claude-opus-5-5")] },
    { id: "empty", label: "Empty", api: "anthropic-messages", baseUrl: "https://e.example", auth: "none", headers: {}, models: [] },
  ],
};
const proxy = [{ slug: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5", subProvider: "Anthropic", isCustom: false, capabilities: { optionDescriptors: [] } }];

describe("OpenCode's Model endpoints", () => {
  it("takes every sign-in through the relay (SPI-1171): ChatGPT, Claude and GitHub Copilot", () => {
    const chatgpt = { id: "chatgpt", label: "ChatGPT", api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1", auth: "chatgpt" as const, headers: {}, models: [model("gpt-6.1-sol")] };
    const claude = { ...chatgpt, id: "claude", label: "Claude", api: "anthropic-messages" as const, baseUrl: "https://api.anthropic.com", auth: "claude" as const, models: [model("claude-haiku-5-5")] };
    const copilot = { ...chatgpt, id: "copilot", label: "GitHub Copilot", baseUrl: "https://api.individual.githubcopilot.com", auth: "copilot" as const };
    expect(opencodeEndpoints({ revision: 1, endpoints: [chatgpt] }).map((endpoint) => endpoint.id)).toEqual(["chatgpt"]);
    expect(opencodeRelayOf({ revision: 1, endpoints: [chatgpt] }, undefined)?.endpoints.map((endpoint) => endpoint.id)).toEqual(["chatgpt"]);
    expect(opencodeEndpoints({ revision: 1, endpoints: [...endpoints.endpoints, chatgpt, claude, copilot] }).map((endpoint) => endpoint.id)).toEqual(["comm", "openai", "or", "chatgpt", "claude", "copilot"]);
  });

  it("takes the endpoints of the three APIs OpenCode speaks that list a model, in the owner's order", () => {
    expect(opencodeEndpoints(endpoints).map((endpoint) => endpoint.id)).toEqual(["comm", "openai", "or"]);
    expect(opencodeEndpoints(undefined)).toEqual([]);
  });

  it("runs on them when there is one: the endpoints, the first model as the default, the small model by text generation's rule", () => {
    const relay = opencodeRelayOf(endpoints, undefined);
    expect(relay?.endpoints.map((endpoint) => endpoint.id)).toEqual(["comm", "openai", "or"]);
    expect(relay?.model).toBe("comm/claude-sonnet-5-5");
    expect(relay?.smallModel).toBe("comm/claude-haiku-5-5");
    // The text-generation model when it is one of theirs; another API's (Google's) or a stale one is not.
    expect(opencodeRelayOf(endpoints, "openai/gpt-5-mini")?.smallModel).toBe("openai/gpt-5-mini");
    for (const text of ["gem/gemini-x", "comm/gone", "anthropic/claude-haiku-5-5"]) expect(opencodeRelayOf(endpoints, text)?.smallModel, text).toBe("comm/claude-haiku-5-5");
    // Only another API's endpoint, or one with no model: the Model proxy.
    expect(opencodeRelayOf({ revision: 1, endpoints: [endpoints.endpoints[0]!, endpoints.endpoints[4]!] }, undefined)).toBeUndefined();
    expect(opencodeRelayOf(undefined, undefined)).toBeUndefined();
  });

  it("lists their models by slug, grouped by endpoint, the first the default; the proxy's when there is none", () => {
    const listed = opencodeModelsOf(proxy, endpoints);
    expect(listed.map((entry) => [entry.slug, entry.subProvider, entry.isDefault === true])).toEqual([
      ["comm/claude-sonnet-5-5", "Commissary", true],
      ["comm/claude-haiku-5-5", "Commissary", false],
      ["openai/gpt-5-mini", "OpenAI", false],
      ["or/anthropic/claude-opus-5-5", "OpenRouter", false],
    ]);
    // The effort picker on a reasoning model only.
    expect(listed[0]!.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual(["effort"]);
    expect(listed[1]!.capabilities?.optionDescriptors).toEqual([]);
    expect(opencodeModelsOf(proxy, { revision: 1, endpoints: [endpoints.endpoints[0]!] })).toEqual(proxy);
  });

  it("names an endpoint's model by its provider, a model id holding `/` kept whole, and anything else as the proxy's", () => {
    expect(opencodeModelId("comm/claude-haiku-5-5", endpoints)).toBe("t3flare-endpoint-comm/claude-haiku-5-5");
    expect(opencodeModelId("or/anthropic/claude-opus-5-5", endpoints)).toBe("t3flare-endpoint-or/anthropic/claude-opus-5-5");
    // The proxy's model, another API's endpoint, an endpoint that is gone: the proxy's id, which the relay's session does
    // not offer (t3's adapter refuses it before any request).
    expect(opencodeModelId("anthropic/claude-haiku-5-5", endpoints)).toBe("t3flare/claude-haiku-5-5");
    expect(opencodeModelId("gem/gemini-x", endpoints)).toBe("t3flare/gemini-x");
    expect(opencodeModelId("gone/m", undefined)).toBe("t3flare/m");
  });
});
