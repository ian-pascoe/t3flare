// SPI-1176: where `web_search` runs (`searchChoice`): only an Anthropic Messages endpoint with an API key or no auth, the
// search model setting resolved among those alone (`modelSettingSlug`: `default`, or a value from before the hard cut,
// is their small model). And the model settings' fallback the Guardian and `web_search` share.
import { type EndpointApi, type EndpointAuth, type ModelEndpoints, modelSettingSlug } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { searchChoice } from "../../src/extensions/web/search.ts";

const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoint = (id: string, api: EndpointApi, auth: EndpointAuth, models: ReadonlyArray<string>) => ({ id, label: id, api, baseUrl: `https://${id}.example`, auth, headers: {}, models: models.map(model) });
const of = (...endpoints: Array<ReturnType<typeof endpoint>>): ModelEndpoints => ({ revision: 1, endpoints });

describe("searchChoice", () => {
  // First in the owner's order: endpoints search must skip (another API, a sign-in), each with a small model of its own.
  const endpoints = of(
    endpoint("resp", "openai-responses", "api-key", ["gpt-mini"]),
    endpoint("plan", "anthropic-messages", "claude", ["claude-haiku-5-5"]),
    endpoint("anth", "anthropic-messages", "api-key", ["claude-sonnet-5-5", "claude-haiku-5-5"]),
    endpoint("open", "anthropic-messages", "none", ["claude-haiku-5-5"]),
  );

  it("takes `default` and a value from before the hard cut as the small model of the usable endpoints only", () => {
    for (const setting of ["default", "claude-haiku-5-5", "anthropic/claude-haiku-5-5"]) {
      expect(searchChoice(setting, endpoints), setting).toMatchObject({ slug: "anth/claude-haiku-5-5", endpoint: { id: "anth" }, model: { id: "claude-haiku-5-5" } });
    }
  });

  it("takes a usable endpoint's slug, and refuses one of another API or of a sign-in", () => {
    expect(searchChoice("open/claude-haiku-5-5", endpoints)).toMatchObject({ slug: "open/claude-haiku-5-5", endpoint: { auth: "none" } });
    expect(searchChoice("resp/gpt-mini", endpoints)).toEqual({ error: "the search model resp/gpt-mini is not a model of an Anthropic Messages Model endpoint with an API key or no auth (the Harness panel's Web tools)" });
    expect(searchChoice("plan/claude-haiku-5-5", endpoints)).toMatchObject({ error: expect.stringContaining("plan/claude-haiku-5-5 is not a model") });
  });

  it("says so, pointing to the Harness panel, when no usable endpoint lists a model (sign-ins only, or another API)", () => {
    const signInsOnly = of(endpoint("plan", "anthropic-messages", "claude", ["claude-haiku-5-5"]), endpoint("resp", "openai-responses", "api-key", ["gpt-mini"]));
    expect(searchChoice("default", signInsOnly)).toEqual({
      error: "no Anthropic Messages Model endpoint with an API key or no auth lists a model to search with: add one in the Harness panel (/_t3flare/settings), under Model endpoints",
    });
  });
});

describe("modelSettingSlug: the Guardian's and web_search's model setting", () => {
  const endpoints = of(endpoint("anth", "anthropic-messages", "api-key", ["claude-sonnet-5-5", "claude-haiku-5-5"]));

  it("reads `default` and a value from before the hard cut as the endpoints' small model", () => {
    for (const setting of ["default", "claude-haiku-5-5", "anthropic/claude-haiku-5-5"]) expect(modelSettingSlug(setting, endpoints), setting).toBe("anth/claude-haiku-5-5");
  });

  it("keeps an endpoint's slug as it is (a removed one fails at use, saying so), and has none with no endpoint", () => {
    expect(modelSettingSlug("anth/claude-sonnet-5-5", endpoints)).toBe("anth/claude-sonnet-5-5");
    expect(modelSettingSlug("gone/x", endpoints)).toBe("gone/x");
    expect(modelSettingSlug("claude-haiku-5-5", of())).toBeUndefined();
  });
});
