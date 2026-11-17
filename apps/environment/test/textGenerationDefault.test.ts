// The text-generation setting's default (SPI-1163): while the owner has set no model, the setting names text generation's
// default model, a small model of the first Model endpoint that has one (else the endpoints' default model; before the
// hard cut, SPI-1176, the Model proxy's small model), and follows it as the endpoints change. A model the owner picked is
// never replaced; a Pi Durable model from before the cut is not one the owner can still use, and is replaced.
import { ProviderInstanceId } from "@t3tools/contracts";
import type { EndpointModel, ModelEndpoints } from "@t3flare/models/endpoints";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ProviderInstanceRegistry from "t3/src/provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";
import { describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { layerSeedTextGenerationModel, syncTextGenerationDefault } from "../src/agents/seedSettings.ts";
import { endpointsChanged } from "../src/endpoints/changes.ts";

const PI = ProviderInstanceId.make("piDurable");
const model = (id: string): EndpointModel => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, known: true });
const withModels = (...ids: ReadonlyArray<string>): ModelEndpoints => ({
  revision: 1,
  endpoints: ids.length === 0 ? [] : [{ id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key", headers: {}, models: ids.map(model) }],
});

/** The Environment as the sync sees it: its endpoints now, and the model it last wrote. */
const environment = (initial: ModelEndpoints) => {
  const state = { endpoints: initial, seeded: undefined as string | undefined };
  bindEnvironmentServices({
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

  it("names the endpoints' default model while no endpoint has a small model (SPI-1176)", async () => {
    environment(withModels("gpt-5.4"));
    const { selection } = await settingsAfter({}, [nothing]);
    expect(selection).toMatchObject({ instanceId: PI, model: "openai/gpt-5.4" });
  });

  it("follows the endpoints while the owner has picked nothing, replacing a Pi Durable model from before the hard cut", async () => {
    for (const old of ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "claude-opus-5-5"]) {
      const state = environment(withModels());
      const { seen } = await settingsAfter({ textGenerationModelSelection: { instanceId: PI, model: old } }, [
        nothing,
        () => void (state.endpoints = withModels("gpt-5-mini")),
        () => void (state.endpoints = withModels("gpt-5-nano")),
      ]);
      expect(seen, old).toEqual(["default", "openai/gpt-5-mini", "openai/gpt-5-nano"]);
    }
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

  it("says `default` when no endpoint lists a model", async () => {
    environment(withModels());
    const { selection } = await settingsAfter({}, [nothing]);
    expect(selection).toMatchObject({ instanceId: PI, model: "default" });
  });
});

/** Runs `body` with the settings service `decorate` makes of the test one, then reads the setting. */
const withSettings = (
  overrides: Parameters<typeof ServerSettings.layerTest>[0],
  decorate: (settings: Settings) => Settings,
  body: Effect.Effect<unknown, unknown, ServerSettings.ServerSettingsService | ProviderInstanceRegistry.ProviderInstanceRegistry>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const inner = yield* ServerSettings.ServerSettingsService;
      yield* Effect.exit(body.pipe(Effect.provideService(ServerSettings.ServerSettingsService, decorate(inner))));
      return (yield* inner.getSettings).textGenerationModelSelection;
    }).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest({ ...INSTANCES, ...overrides }), registry))) as Effect.Effect<{ readonly instanceId: string; readonly model: string }>,
  );

describe("what counts as unset, clause by clause", () => {
  it("an instance this Environment does not have, though it is not t3's default", async () => {
    environment(withModels("gpt-5-mini"));
    const { selection } = await settingsAfter(
      { providerInstances: { [PI]: { driver: "piDurable", config: {} }, ghost: { driver: "ghost", config: {} } }, textGenerationModelSelection: { instanceId: ProviderInstanceId.make("ghost"), model: "ghost-1" } } as Parameters<typeof ServerSettings.layerTest>[0],
      [nothing],
    );
    expect(selection).toMatchObject({ instanceId: PI, model: "openai/gpt-5-mini" });
  });

  it("`default` on Pi Durable, though the record names another model", async () => {
    const state = environment(withModels("gpt-5-mini"));
    state.seeded = "openai/gpt-4o-mini";
    const { selection } = await settingsAfter({ textGenerationModelSelection: { instanceId: PI, model: "default" } }, [nothing]);
    expect(selection).toMatchObject({ instanceId: PI, model: "openai/gpt-5-mini" });
  });
});

describe("the sync's record and its order", () => {
  it("records the default only once the setting holds it", async () => {
    const state = environment(withModels("gpt-5-mini"));
    const failing = (settings: Settings): Settings => ({ ...settings, updateSettings: () => Effect.fail(new Error("write failed") as never) });
    const selection = await withSettings({}, failing, syncTextGenerationDefault);
    expect(selection.model).not.toBe("openai/gpt-5-mini");
    expect(state.seeded).toBeUndefined();
  });

  it("serialises two endpoint changes, so the second reads what the first wrote and follows it", async () => {
    // The setting holds the default the sync last wrote; the first change makes it gpt-5-nano, the second gpt-4o-mini.
    const state = environment(withModels("gpt-5-mini"));
    state.seeded = "openai/gpt-5-mini";
    const lists = [withModels("gpt-5-nano"), withModels("gpt-5.4", "gpt-4o-mini")];
    let reads = 0;
    bindEnvironmentServices({
      modelProxy: { url: "https://proxy.example", apiKey: "k" },
      modelEndpoints: () => lists[Math.min(reads++, 1)]!,
      seededTextModel: { get: () => state.seeded, set: (slug: string) => void (state.seeded = slug) },
    } as unknown as EnvironmentServices);
    // Writes that yield before they land, as the real settings service's file write does; the first is the slower, so
    // unserialised syncs would land the older default last.
    let writes = 0;
    const slow = (settings: Settings): Settings => ({
      ...settings,
      updateSettings: (patch) => Effect.sleep(writes++ === 0 ? 30 : 1).pipe(Effect.andThen(settings.updateSettings(patch))),
    });
    const selection = await withSettings(
      { textGenerationModelSelection: { instanceId: PI, model: "openai/gpt-5-mini" } },
      slow,
      Effect.all([syncTextGenerationDefault, syncTextGenerationDefault], { concurrency: "unbounded" }),
    );
    expect(selection.model).toBe("openai/gpt-4o-mini");
    expect(state.seeded).toBe("openai/gpt-4o-mini");
  });

  it("follows an endpoint change it hears, from the layer's subscription", async () => {
    const state = environment(withModels("gpt-5-mini"));
    const selection = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layerSeedTextGenerationModel);
          const service = yield* ServerSettings.ServerSettingsService;
          expect((yield* service.getSettings).textGenerationModelSelection.model).toBe("openai/gpt-5-mini");
          state.endpoints = withModels("gpt-5-nano");
          endpointsChanged();
          for (let tries = 0; tries < 50 && (yield* service.getSettings).textGenerationModelSelection.model !== "openai/gpt-5-nano"; tries++) yield* Effect.sleep(5);
          return (yield* service.getSettings).textGenerationModelSelection;
        }),
      ).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest({ ...INSTANCES }), registry))) as Effect.Effect<{ readonly model: string }>,
    );
    expect(selection.model).toBe("openai/gpt-5-nano");
  });

  it("interrupts a hung sync it forked when the layer's scope closes, so a later boot's sync runs", async () => {
    const state = environment(withModels("gpt-5-mini"));
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const inner = yield* ServerSettings.ServerSettingsService;
        // After the boot's sync, every settings read hangs (a stuck storage read).
        let reads = 0;
        const hanging: Settings = { ...inner, getSettings: Effect.suspend(() => (reads++ < 1 ? inner.getSettings : Effect.never)) };
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(layerSeedTextGenerationModel.pipe(Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, hanging))), scope);
        state.endpoints = withModels("gpt-5-nano");
        endpointsChanged();
        yield* Effect.sleep(20);
        // The runtime's disposal closes the layer's scope.
        yield* Scope.close(scope, Exit.void);
        // A later boot's sync (a fresh settings service) gets the permit and runs.
        return yield* syncTextGenerationDefault.pipe(
          Effect.as("ran"),
          Effect.timeout(1_000),
          Effect.catchCause(() => Effect.succeed("blocked")),
        );
      }).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest({ ...INSTANCES }), registry))) as Effect.Effect<string>,
    );
    expect(outcome).toBe("ran");
  });
});
