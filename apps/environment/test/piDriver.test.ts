// SPI-1170: the pi driver's model list (`provider/cli/piDriver.ts` `piSnapshot`): the endpoints' models when one lists a
// model, else none and the provider needs setup (SPI-1176), and the list follows each endpoint change at once while the
// driver's scope is open.
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { EndpointApi, ModelEndpoints } from "@t3flare/models/endpoints";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { PiSettings } from "../../../t3code/packages/provider-pi/src/settings.ts";
import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { endpointsChanged } from "../src/endpoints/changes.ts";
import { piSnapshot } from "../src/provider/cli/piDriver.ts";

const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false });
const endpoint = (id: string, api: EndpointApi, models: ReadonlyArray<string>) => ({ id, label: id, api, baseUrl: `https://${id}.example`, auth: "api-key" as const, headers: {}, models: models.map(model) });

const host = ProviderHost.ProviderHost.of({
  paths: { cwd: "/", baseDir: "/tmp", stateDir: "/tmp", providerStatusCacheDir: "/tmp", attachmentsDir: "/tmp" },
  settings: { get: Effect.succeed(DEFAULT_SERVER_SETTINGS), withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS), changes: Stream.empty, subscribe: Effect.succeed(Stream.empty) },
  shouldRunBackgroundWork: () => Effect.succeed(true),
  resolveAttachmentPath: () => null,
  credentials: () => Effect.die("not used"),
});

describe("pi's driver snapshot", () => {
  it("needs setup with no endpoint, lists the endpoints' models as soon as one lists a model, and needs setup again", async () => {
    let endpoints: ModelEndpoints = { revision: 1, endpoints: [endpoint("empty", "anthropic-messages", [])] };
    bindEnvironmentServices({ modelEndpoints: () => endpoints } as unknown as EnvironmentServices);
    const scope = Effect.runSync(Scope.make());
    const stamp = (draft: object) => ({ ...draft, instanceId: "pi", driver: "pi" }) as never;
    const config = { ...Schema.decodeSync(PiSettings)({}), enabled: true };
    const snapshot = await Effect.runPromise(piSnapshot(config, stamp).pipe(Effect.provideService(ProviderHost.ProviderHost, host), Scope.provide(scope)));
    const state = async () => {
      const now = await Effect.runPromise(snapshot.getSnapshot);
      return { models: now.models.map((entry) => entry.slug), status: now.status, message: now.message };
    };
    const settle = async (want: ReadonlyArray<string>) => {
      for (let i = 0; i < 50 && JSON.stringify((await state()).models) !== JSON.stringify(want); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      return state();
    };
    const setup = {
      models: [],
      status: "warning",
      message: "Pi has no Model endpoint to run on: it needs one that lists a model; add one on the Settings page (/_t3flare/settings), under Model endpoints.",
    };
    expect(await settle([])).toEqual(setup);
    endpoints = { revision: 2, endpoints: [endpoint("comm", "anthropic-messages", ["c"]), endpoint("gem", "google-generative-ai", ["g"])] };
    endpointsChanged();
    expect(await settle(["comm/c", "gem/g"])).toMatchObject({ models: ["comm/c", "gem/g"], status: "ready" });
    endpoints = { revision: 3, endpoints: [] };
    endpointsChanged();
    expect(await settle([])).toEqual(setup);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
