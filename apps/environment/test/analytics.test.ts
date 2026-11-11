// Product analytics is off in the Cloud Environment (owner decision D1, SPI-995): t3's own AnalyticsService, with
// telemetry enabled as t3 defaults it, sends nothing under t3flare's managed policy. The control, with no policy,
// shows the test would see a send.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerConfig from "t3/src/config.ts";
import * as ManagedPolicy from "t3/src/policy/ManagedPolicy.ts";
import * as AnalyticsService from "t3/src/telemetry/AnalyticsService.ts";
import { describe, expect, it } from "vitest";

import { layerManagedPolicy } from "../src/t3/managedPolicy.ts";

/** Records two events and flushes them; returns the URLs t3 posted to. */
const sends = (policy: Layer.Layer<ManagedPolicy.ManagedPolicy, unknown>) => {
  const posted: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      posted.push(request.url);
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
    }),
  );
  const layer = AnalyticsService.layer.pipe(
    Layer.provideMerge(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3flare-analytics-" })),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: true, T3CODE_POSTHOG_KEY: "phc_test", T3CODE_POSTHOG_HOST: "http://ingest.test" }),
      ),
    ),
    Layer.provide(Layer.mergeAll(Layer.succeed(HostProcess.Platform, "linux"), Layer.succeed(HttpClient.HttpClient, client), policy)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("t3flare.test.one");
      yield* analytics.record("t3flare.test.two");
      yield* analytics.flush;
      return posted;
    }).pipe(Effect.provide(layer), Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
};

describe("product analytics", () => {
  it("sends without a policy (the control)", async () => {
    expect(await sends(ManagedPolicy.layerTest())).toEqual(["http://ingest.test/batch/"]);
  });

  it("sends nothing under t3flare's managed policy", async () => {
    expect(await sends(layerManagedPolicy)).toEqual([]);
  });
});
