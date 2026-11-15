// Claude Code's Model endpoints (SPI-1168): with an Anthropic Messages endpoint, Claude Code runs on those endpoints
// through the model relay, its models their slugs (the relay routes each request by its model), its background model
// the text-generation model when that is one of theirs; with none, on the Model proxy as before.
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { claudeModelId, claudeModelsOf, claudeRelayOf } from "../src/provider/cli/claudeEndpoints.ts";

const model = (id: string, extra: { reasoning?: boolean; known?: boolean; output?: number } = {}) => ({
  id,
  name: id.toUpperCase(),
  reasoning: extra.reasoning ?? false,
  input: ["text" as const],
  contextWindow: 1,
  maxTokens: 1,
  cost: { input: 0, output: extra.output ?? 0, cacheRead: 0, cacheWrite: 0 },
  known: extra.known ?? false,
});
const endpoints: ModelEndpoints = {
  revision: 3,
  endpoints: [
    { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: [model("gpt-5-mini")] },
    { id: "comm", label: "Commissary", api: "anthropic-messages", baseUrl: "https://c.example/v1", auth: "api-key", headers: {}, models: [model("claude-sonnet-5-5", { reasoning: true }), model("claude-haiku-5-5")] },
    { id: "comm2", label: "Commissary", api: "anthropic-messages", baseUrl: "https://c2.example/v1", auth: "api-key", headers: {}, models: [model("claude-opus-5-5", { reasoning: true })] },
  ],
};
const proxy = [{ slug: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5", subProvider: "Anthropic", isCustom: false, capabilities: { optionDescriptors: [] } }];

describe("Claude Code's Model endpoints", () => {
  it("runs on the Anthropic Messages endpoints when there is one: their ids, their models' slugs, the background model", () => {
    expect(claudeRelayOf(endpoints, "openai/gpt-5-mini")).toEqual({
      endpoints: ["comm", "comm2"],
      models: ["comm/claude-sonnet-5-5", "comm/claude-haiku-5-5", "comm2/claude-opus-5-5"],
      backgroundModel: "comm/claude-haiku-5-5",
      opusModel: "comm2/claude-opus-5-5",
      sonnetModel: "comm/claude-sonnet-5-5",
    });
    expect(claudeRelayOf({ revision: 1, endpoints: [endpoints.endpoints[0]!] }, undefined)).toBeUndefined();
    expect(claudeRelayOf(undefined, undefined)).toBeUndefined();
  });

  it("ignores an Anthropic Messages endpoint that lists no model: alone, it leaves Claude Code on the proxy", () => {
    const empty = { ...endpoints.endpoints[1]!, id: "empty", models: [] };
    expect(claudeRelayOf({ revision: 1, endpoints: [empty] }, undefined)).toBeUndefined();
    expect(claudeRelayOf({ revision: 1, endpoints: [empty, endpoints.endpoints[2]!] }, undefined)?.endpoints).toEqual(["comm2"]);
    expect(claudeModelsOf(proxy, { revision: 1, endpoints: [empty] })).toEqual(proxy);
  });

  it("takes the text-generation model as the background model when it is an Anthropic Messages endpoint's model", () => {
    expect(claudeRelayOf(endpoints, "comm2/claude-opus-5-5")?.backgroundModel).toBe("comm2/claude-opus-5-5");
    // Another API's model, a model the endpoint no longer lists, or the proxy's: the endpoints' own small model.
    for (const text of ["openai/gpt-5-mini", "comm/gone", "anthropic/claude-haiku-5-5", "default", undefined]) expect(claudeRelayOf(endpoints, text)?.backgroundModel, text).toBe("comm/claude-haiku-5-5");
    // No small model among them: the first endpoint's first model.
    const big: ModelEndpoints = { revision: 1, endpoints: [endpoints.endpoints[2]!] };
    expect(claudeRelayOf(big, undefined)?.backgroundModel).toBe("comm2/claude-opus-5-5");
  });

  it("points Claude Code's opus and sonnet aliases at a slug of that family, else at the first model", () => {
    const haikuOnly: ModelEndpoints = { revision: 1, endpoints: [{ ...endpoints.endpoints[1]!, models: [model("claude-haiku-5-5"), model("my-sonnetish")] }] };
    // `sonnetish` is not the family's word; the first model stands in.
    expect(claudeRelayOf(haikuOnly, undefined)).toMatchObject({ opusModel: "comm/claude-haiku-5-5", sonnetModel: "comm/claude-haiku-5-5" });
  });

  it("lists the endpoints' models by slug, grouped by endpoint, with the effort picker on reasoning models; the proxy's without an endpoint", () => {
    const listed = claudeModelsOf(proxy, endpoints);
    expect(listed.map((row) => [row.slug, row.subProvider, row.name])).toEqual([
      ["comm/claude-sonnet-5-5", "Commissary · comm", "CLAUDE-SONNET-5-5"],
      ["comm/claude-haiku-5-5", "Commissary · comm", "CLAUDE-HAIKU-5-5"],
      ["comm2/claude-opus-5-5", "Commissary · comm2", "CLAUDE-OPUS-5-5"],
    ]);
    expect(listed[0]!.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual(["effort"]);
    expect(listed[1]!.capabilities?.optionDescriptors).toEqual([]);
    // The picker's default for a new thread is the first endpoint model, whatever proxy model t3 keeps listed.
    expect(listed.filter((row) => row.isDefault === true).map((row) => row.slug)).toEqual(["comm/claude-sonnet-5-5"]);
    expect(claudeModelsOf(proxy, { revision: 1, endpoints: [endpoints.endpoints[0]!] })).toEqual(proxy);
    expect(claudeModelsOf(proxy, undefined)).toEqual(proxy);
  });

  it("names an endpoint's model to Claude Code by its slug, and the proxy's by its id", () => {
    expect(claudeModelId("comm/claude-haiku-5-5", endpoints)).toBe("comm/claude-haiku-5-5");
    expect(claudeModelId("anthropic/claude-haiku-5-5", endpoints)).toBe("claude-haiku-5-5");
    expect(claudeModelId("claude-haiku-5-5", endpoints)).toBe("claude-haiku-5-5");
    // Another API's endpoint is not Claude Code's: its slug is read as the proxy's.
    expect(claudeModelId("openai/gpt-5-mini", endpoints)).toBe("gpt-5-mini");
  });
});
