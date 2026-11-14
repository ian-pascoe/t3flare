// The text-generation setting's default (SPI-1163): while the owner has set no model, the setting names text generation's
// default model, a small model of the first Model endpoint that has one (else the Model proxy's), and follows it as the
// endpoints change. A model the owner picked is never replaced.
import { ProviderInstanceId } from "@t3tools/contracts";
import type { EndpointModel, ModelEndpoints } from "@t3flare/models/endpoints";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "t3/src/provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";
import { describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { syncTextGenerationDefault } from "../src/agents/seedSettings.ts";

const PI = ProviderInstanceId.make("piDurable");
const model = (id: string): EndpointModel => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, known: true });
const withModels = (...ids: ReadonlyArray<string>): ModelEndpoints => ({
  revision: 1,
  endpoints: ids.length === 0 ? [] : [{ id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: ids.map(model) }],
});

/** The Environment as the sync sees it: its endpoints now, the proxy, and the model it last wrote. */
const environment = (initial: ModelEndpoints, proxy = true) => {
  const state = { endpoints: initial, seeded: undefined as string | undefined };
  bindEnvironmentServices({
    modelProxy: proxy ? { url: "https://proxy.example", apiKey: "k" } : undefined,
    modelEndpoints: () => state.endpoints,
    seededTextModel: { get: () => state.seeded, set: (slug: string) => void (state.seeded = slug) },
  } as unknown as EnvironmentServices);
  return state;
};

/** The instances registered: Pi Durable, and Codex where the CLI agents are on. */
let registered: ReadonlyArray<string> = [PI];
const registry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (id: ProviderInstanceId) => Effect.succeed(registered.includes(id) ? ({} as never) : undefined),
} as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);

/** The Pi Durable instance as the Environment configures it, so t3's settings read keeps a selection of it. */
const INSTANCES = { providerInstances: { [PI]: { driver: "piDurable", config: {} } } } as Parameters<typeof ServerSettings.layerTest>[0];

type Settings = ServerSettings.ServerSettingsService["Service"];

/** Runs the sync once per step over one settings service (each step first changes what it will), then reads the setting. */
const settingsAfter = (overrides: Parameters<typeof ServerSettings.layerTest>[0], steps: ReadonlyArray<(settings: Settings) => Effect.Effect<unknown> | void>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      const seen: Array<string> = [];
      for (const step of steps) {
        const effect = step(service);
        if (effect !== undefined) yield* effect;
        yield* syncTextGenerationDefault;
        seen.push((yield* service.getSettings).textGenerationModelSelection.model);
      }
      return { seen, selection: (yield* service.getSettings).textGenerationModelSelection };
    }).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest({ ...INSTANCES, ...overrides }), registry))) as Effect.Effect<{ readonly seen: Array<string>; readonly selection: { readonly instanceId: string; readonly model: string } }>,
  );

const nothing = () => undefined;

describe("the text-generation setting's default", () => {
  it("names the first endpoint's small model when t3's default names an instance this Environment lacks", async () => {
    environment(withModels("gpt-5.4", "gpt-5-mini"));
    const { selection } = await settingsAfter({}, [nothing]);
    expect(selection).toMatchObject({ instanceId: PI, model: "openai/gpt-5-mini" });
  });

  it("replaces t3's own default (Codex's model) even where a Codex instance is registered", async () => {
    environment(withModels("gpt-5-mini"));
    registered = [PI, "codex"];
    try {
      const { selection } = await settingsAfter({}, [() => undefined]);
      expect(selection).toMatchObject({ instanceId: PI, model: "openai/gpt-5-mini" });
      const picked = await settingsAfter({ textGenerationModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" } }, [() => undefined]);
      expect(picked.selection).toMatchObject({ instanceId: "codex", model: "gpt-5.4" });
    } finally {
      registered = [PI];
    }
  });

  it("names the Model proxy's small model while no endpoint has one", async () => {
    environment(withModels("gpt-5.4"));
    const { selection } = await settingsAfter({}, [nothing]);
    expect(selection).toMatchObject({ instanceId: PI, model: "anthropic/claude-haiku-5-5" });
  });

  it("follows the endpoints while the owner has picked nothing, including the old seed of the proxy's model", async () => {
    const state = environment(withModels());
    const { seen } = await settingsAfter({ textGenerationModelSelection: { instanceId: PI, model: "anthropic/claude-haiku-5-5" } }, [
      nothing,
      () => void (state.endpoints = withModels("gpt-5-mini")),
      () => void (state.endpoints = withModels("gpt-5-nano")),
    ]);
    expect(seen).toEqual(["anthropic/claude-haiku-5-5", "openai/gpt-5-mini", "openai/gpt-5-nano"]);
  });

  it("never replaces a model the owner picked", async () => {
    const state = environment(withModels("gpt-5-mini", "gpt-5.4"));
    const { seen } = await settingsAfter({}, [
      () => undefined,
      (settings) => settings.updateSettings({ textGenerationModelSelection: { instanceId: PI, model: "openai/gpt-5.4" } }),
      () => void (state.endpoints = withModels("gpt-5-nano", "gpt-5.4")),
    ]);
    expect(seen).toEqual(["openai/gpt-5-mini", "openai/gpt-5.4", "openai/gpt-5.4"]);
  });

  it("says `default` when there is neither an endpoint with a small model nor a Model proxy", async () => {
    environment(withModels("gpt-5.4"), false);
    const { selection } = await settingsAfter({}, [nothing]);
    expect(selection).toMatchObject({ instanceId: PI, model: "default" });
  });
});
