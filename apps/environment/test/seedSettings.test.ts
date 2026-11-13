// Step 3's seeded settings, on t3's own test settings service: Linked environments is turned on once per Environment
// (L1), so an owner who turns it off keeps it off; agent browser access is pinned off at each boot (L3), as the Cloud
// Environment has no browser.
import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "t3/src/serverSettings.ts";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { layerSeedLinkedEnvironmentsOn } from "../src/agents/seedSettings.ts";

const bindMarks = () => {
  const marks = new Map<string, number>();
  bindEnvironmentServices({ marks: { has: (key: string) => marks.has(key), set: (key: string) => void marks.set(key, 1) } } as unknown as EnvironmentServices);
  return marks;
};

/** Boots `seed` over `settings` (one boot), then reads the settings. */
const boot = (settings: Layer.Layer<ServerSettings.ServerSettingsService, unknown>, seed: Layer.Layer<never, never, ServerSettings.ServerSettingsService>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      return yield* service.getSettings;
    }).pipe(Effect.provide(Layer.provideMerge(seed, settings))),
  );

describe("seeded settings (step 3)", () => {
  it("turns Linked environments on at the first boot", async () => {
    const marks = bindMarks();
    const settings = await boot(ServerSettings.layerTest({ linkedEnvironmentsEnabled: false }), layerSeedLinkedEnvironmentsOn);
    expect(settings.linkedEnvironmentsEnabled).toBe(true);
    expect(marks.size).toBe(1);
  });

  it("leaves Linked environments off once the owner turned it off after the seed", async () => {
    bindMarks();
    await boot(ServerSettings.layerTest({ linkedEnvironmentsEnabled: false }), layerSeedLinkedEnvironmentsOn);
    const later = await boot(ServerSettings.layerTest({ linkedEnvironmentsEnabled: false }), layerSeedLinkedEnvironmentsOn);
    expect(later.linkedEnvironmentsEnabled).toBe(false);
  });
});
