// Claude Code's Model endpoints (SPI-1168): with an Anthropic Messages endpoint, Claude Code runs on those endpoints
// through the model relay, its models their slugs (the relay routes each request by its model), its background model
// the text-generation model when that is one of theirs; with none, no model (it needs setup, and a spawn is refused:
// SPI-1176). A selection from before the hard cut falls back to the default model.
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

  it("takes a Claude sign-in through the relay (SPI-1171), and no other sign-in", () => {
    const signIn = { ...endpoints.endpoints[1]!, id: "claude", baseUrl: "https://api.anthropic.com", auth: "claude" as const };
    expect(claudeRelayOf({ revision: 1, endpoints: [signIn] }, undefined)?.endpoints).toEqual(["claude"]);
    expect(claudeRelayOf({ revision: 1, endpoints: [signIn, endpoints.endpoints[2]!] }, undefined)?.endpoints).toEqual(["claude", "comm2"]);
    // A Copilot sign-in speaks Responses, not Claude Code's API; a ChatGPT one too. Neither is Claude Code's.
    const copilot = { ...signIn, id: "copilot", api: "openai-responses" as const, auth: "copilot" as const };
    expect(claudeRelayOf({ revision: 1, endpoints: [copilot] }, undefined)).toBeUndefined();
  });

  it("ignores an Anthropic Messages endpoint that lists no model: alone, it leaves Claude Code with no endpoint", () => {
    const empty = { ...endpoints.endpoints[1]!, id: "empty", models: [] };
    expect(claudeRelayOf({ revision: 1, endpoints: [empty] }, undefined)).toBeUndefined();
    expect(claudeRelayOf({ revision: 1, endpoints: [empty, endpoints.endpoints[2]!] }, undefined)?.endpoints).toEqual(["comm2"]);
    expect(claudeModelsOf({ revision: 1, endpoints: [empty] })).toEqual([]);
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

  it("lists the endpoints' models by slug, grouped by endpoint, with the effort picker on reasoning models; none without an endpoint", () => {
    const listed = claudeModelsOf(endpoints);
    expect(listed.map((row) => [row.slug, row.subProvider, row.name])).toEqual([
      ["comm/claude-sonnet-5-5", "Commissary · comm", "CLAUDE-SONNET-5-5"],
      ["comm/claude-haiku-5-5", "Commissary · comm", "CLAUDE-HAIKU-5-5"],
      ["comm2/claude-opus-5-5", "Commissary · comm2", "CLAUDE-OPUS-5-5"],
    ]);
    expect(listed[0]!.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual(["effort"]);
    expect(listed[1]!.capabilities?.optionDescriptors).toEqual([]);
    // The picker's default for a new thread is the first endpoint model, whatever proxy model t3 keeps listed.
    expect(listed.filter((row) => row.isDefault === true).map((row) => row.slug)).toEqual(["comm/claude-sonnet-5-5"]);
    expect(claudeModelsOf({ revision: 1, endpoints: [endpoints.endpoints[0]!] })).toEqual([]);
    expect(claudeModelsOf(undefined)).toEqual([]);
  });

  it("names an endpoint's model to Claude Code by its slug; a selection from before the hard cut is the default model (SPI-1176)", () => {
    expect(claudeModelId("comm/claude-haiku-5-5", endpoints)).toBe("comm/claude-haiku-5-5");
    // The Model proxy's (`anthropic/…`, and its bare ids, t3's stock Claude default among them) and `default`.
    for (const old of ["anthropic/claude-haiku-5-5", "claude-haiku-5-5", "claude-opus-5-5", "default"]) expect(claudeModelId(old, endpoints), old).toBe("comm/claude-sonnet-5-5");
    // Another API's endpoint, or a gone one: kept, so Claude Code's session does not offer it and t3's adapter refuses it.
    expect(claudeModelId("openai/gpt-5-mini", endpoints)).toBe("openai/gpt-5-mini");
    expect(claudeModelId("gone/x", endpoints)).toBe("gone/x");
    // Nothing to fall back to without an endpoint: as it was.
    expect(claudeModelId("anthropic/claude-haiku-5-5", undefined)).toBe("anthropic/claude-haiku-5-5");
  });
});
