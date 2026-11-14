// Text generation's default model (SPI-1163): a small model of the first Model endpoint that has one, in the owner's
// order; the cheapest such model by its known price, else the first listed.
import type { EndpointModel, ModelEndpoint, ModelEndpoints } from "@t3flare/models/endpoints";
import { defaultTextModel } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

const model = (id: string, output?: number): EndpointModel => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 8_000,
  cost: { input: 0, output: output ?? 0, cacheRead: 0, cacheWrite: 0 },
  known: output !== undefined,
});

const endpoint = (id: string, models: ReadonlyArray<EndpointModel>): ModelEndpoint => ({
  id,
  label: id,
  api: "openai-responses",
  baseUrl: `https://${id}.example/v1`,
  auth: "api-key",
  headers: {},
  models,
});

const of = (...endpoints: ReadonlyArray<ModelEndpoint>): ModelEndpoints => ({ revision: 1, endpoints });

describe("defaultTextModel", () => {
  it("is undefined with no endpoints", () => {
    expect(defaultTextModel(of())).toBeUndefined();
  });

  it("skips an endpoint with no small model and takes the next one's", () => {
    const endpoints = of(
      endpoint("big", [model("claude-opus-5-5", 25), model("gpt-5", 10), model("minimax-m2", 1)]),
      endpoint("commissary", [model("claude-sonnet-5-5", 15), model("claude-haiku-5-5", 5)]),
    );
    expect(defaultTextModel(endpoints)).toBe("commissary/claude-haiku-5-5");
  });

  it("takes the cheapest small model by its known price, before one with no known price", () => {
    const endpoints = of(endpoint("openai", [model("my-mini"), model("gpt-5-mini", 2), model("gpt-5-nano", 0.4), model("gpt-5.4", 10)]));
    expect(defaultTextModel(endpoints)).toBe("openai/gpt-5-nano");
  });

  it("knows the usual small families", () => {
    for (const id of ["claude-haiku-4-5", "gpt-4o-mini", "o4-mini", "gemini-3-flash", "gemini-2.5-flash-lite", "mistral-small-latest", "gpt-5-nano", "openai/gpt-5-mini"]) {
      expect(defaultTextModel(of(endpoint("e", [model(id)])))).toBe(`e/${id}`);
    }
  });

  it("takes the first listed when no small model has a known price", () => {
    expect(defaultTextModel(of(endpoint("local", [model("llama-3-8b"), model("qwen3-mini"), model("phi-4-mini")])))).toBe("local/qwen3-mini");
  });
});
