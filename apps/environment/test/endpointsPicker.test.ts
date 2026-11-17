// The Pi Durable picker with Model endpoints (SPI-1162): every endpoint's models as `<endpointId>/<modelId>`, grouped by
// endpoint, a reasoning model with the thinking picker. They are its only models (SPI-1176): with none, the provider
// needs setup and points to the Harness panel, and an old selection falls back to the default model.
import type { ModelSelection } from "@t3tools/contracts";
import { type ModelEndpoints, NO_ENDPOINT_MESSAGE } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { modelOf } from "../src/provider/adapter.ts";
import { snapshotModels } from "../src/provider/models.ts";
import { readinessOf } from "../src/provider/readiness.ts";

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
  it("lists each endpoint's models by slug, grouped by endpoint, with thinking for reasoning models; the first the default", () => {
    const models = snapshotModels(ENDPOINTS);
    expect(models.map((entry) => `${entry.subProvider} ${entry.slug}`)).toEqual(["OpenAI openai/gpt-5-mini", "OpenAI openai/gpt-4.1", "Anthropic commissary/claude-haiku-5-5"]);
    const thinking = (slug: string) => models.find((entry) => entry.slug === slug)?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [];
    expect(thinking("openai/gpt-5-mini")).toEqual(["thinking"]);
    expect(thinking("openai/gpt-4.1")).toEqual([]);
    expect(models.find((entry) => entry.slug === "openai/gpt-5-mini")).toMatchObject({ name: "GPT-5 Mini", isCustom: false });
    expect(models.filter((entry) => entry.isDefault === true).map((entry) => entry.slug)).toEqual(["openai/gpt-5-mini"]);
  });

  it("keeps two endpoints with the same label in two groups, told apart by id", () => {
    const twin = { ...ENDPOINTS.endpoints[0]!, id: "openai-work", models: [model("gpt-5", "GPT-5", true)] };
    const models = snapshotModels({ revision: 3, endpoints: [ENDPOINTS.endpoints[0]!, twin] });
    expect([...new Set(models.map((entry) => entry.subProvider))]).toEqual(["OpenAI · openai", "OpenAI · openai-work"]);
  });

  it("the default is the first endpoint that lists a model's first model", () => {
    const empty = { ...ENDPOINTS.endpoints[0]!, id: "empty", models: [] };
    const models = snapshotModels({ revision: 4, endpoints: [empty, ...ENDPOINTS.endpoints] });
    expect(models.filter((entry) => entry.isDefault === true).map((entry) => entry.slug)).toEqual(["openai/gpt-5-mini"]);
  });

  it("is empty without an endpoint: there is nothing else to list (SPI-1176)", () => {
    expect(snapshotModels({ revision: 0, endpoints: [] })).toEqual([]);
    expect(snapshotModels()).toEqual([]);
  });
});

describe("the setup state (SPI-1176)", () => {
  it("needs setup with no model, its message pointing to the Harness panel; ready with one", () => {
    expect(readinessOf(snapshotModels(), null, NO_ENDPOINT_MESSAGE)).toEqual({
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "No Model endpoint is set up: add one in the Harness panel (/_t3flare/harness), under Model endpoints.",
    });
    expect(readinessOf(snapshotModels(ENDPOINTS), null, NO_ENDPOINT_MESSAGE)).toEqual({ installed: true, version: null, status: "ready", auth: { status: "authenticated" } });
    expect(readinessOf(snapshotModels(ENDPOINTS), "1.0", "setup", "a note")).toMatchObject({ status: "ready", message: "a note" });
  });
});

describe("a Pi Durable selection's model (modelOf)", () => {
  const selection = (slug: string, thinking?: string): ModelSelection =>
    ({ instanceId: "piDurable", model: slug, ...(thinking === undefined ? {} : { options: [{ id: "thinking", value: thinking }] }) }) as ModelSelection;

  it("is an endpoint's model by its slug, a model id holding `/` kept whole", () => {
    expect(modelOf(selection("commissary/claude-haiku-5-5", "low"), ENDPOINTS)).toEqual({ model: { provider: "commissary", modelId: "claude-haiku-5-5" }, thinking: "low" });
    expect(modelOf(selection("openai/vendor/x"), ENDPOINTS).model).toEqual({ provider: "openai", modelId: "vendor/x" });
  });

  it("runs an old selection (anthropic/…, a bare id, default) on the default model, the first endpoint's first", () => {
    // Even where an endpoint lists a model of the old id (`commissary`'s haiku, `openai`'s gpt-4.1): ADR-0034 §3, so
    // no endpoint answers for an old selection by accident.
    for (const old of ["anthropic/claude-haiku-5-5", "claude-haiku-5-5", "gpt-4.1", "anthropic/claude-sonnet-5-5", "claude-opus-5-5", "gpt-6-luna", "default"]) {
      expect(modelOf(selection(old, "high"), ENDPOINTS), old).toEqual({ model: { provider: "openai", modelId: "gpt-5-mini" }, thinking: "high" });
    }
  });

  it("keeps a removed endpoint's slug, so the turn fails saying it is gone, and has nothing to fall back to without an endpoint", () => {
    expect(modelOf(selection("gone/m"), ENDPOINTS).model).toEqual({ provider: "gone", modelId: "m" });
    expect(modelOf(selection("anthropic/claude-sonnet-5-5"), { revision: 0, endpoints: [] }).model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(modelOf(selection("claude-opus-5-5"), { revision: 0, endpoints: [] }).model).toEqual({ provider: "", modelId: "claude-opus-5-5" });
  });
});
