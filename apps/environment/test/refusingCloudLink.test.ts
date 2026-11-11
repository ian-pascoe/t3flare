// Step 3+ (review finding 1): the CloudLink t3's HTTP routes get refuses the four relay-initiated calls, as t3's own
// managed-policy variant does, and passes the rest through to the real one.
import * as CloudLink from "t3/src/cloud/CloudLink.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";

import { layerRefusingCloudLink } from "../src/connect/service.ts";

it("refuses linkProof, applyRelayConfig, answerHealthRequest and mintCredential; keeps linkState, unlink and preferences", async () => {
  const calls: Array<string> = [];
  const names = [
    "linkProof", "applyRelayConfig", "linkState", "unlink", "updatePreferences", "answerHealthRequest", "mintCredential",
    "reconcileDesiredLinkIfStillDesired", "registerManagedTunnelRecovery", "recoverManagedTunnel",
    "startManagedTunnelIfOriginConfirmed", "releaseManagedTunnelOnShutdown",
  ];
  const real = Object.fromEntries(
    names.map((name) => [name, () => Effect.sync(() => (calls.push(name), { called: name }))]),
  ) as unknown as CloudLink.CloudLink["Service"];
  const layer = layerRefusingCloudLink.pipe(Layer.provide(Layer.succeed(CloudLink.CloudLink, real)));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const refused = yield* Effect.all({
        linkProof: Effect.flip(link.linkProof({} as never, {} as never) as unknown as Effect.Effect<unknown, { _tag: string }>),
        applyRelayConfig: Effect.flip(link.applyRelayConfig({} as never)),
        answerHealthRequest: Effect.flip(link.answerHealthRequest({} as never)),
        mintCredential: Effect.flip(link.mintCredential({} as never)),
      });
      const kept = [yield* link.linkState(), yield* link.unlink(), yield* link.updatePreferences({ publishAgentActivity: true })];
      return { refused: Object.fromEntries(Object.entries(refused).map(([name, error]) => [name, error._tag])), kept };
    }).pipe(Effect.provide(layer)) as Effect.Effect<{ refused: Record<string, string>; kept: Array<unknown> }>,
  );
  expect(result.refused).toEqual({
    linkProof: "ManagedPolicyRefusedError",
    applyRelayConfig: "ManagedPolicyRefusedError",
    answerHealthRequest: "ManagedPolicyRefusedError",
    mintCredential: "ManagedPolicyRefusedError",
  });
  expect(calls).toEqual(["linkState", "unlink", "updatePreferences"]);
});

it("t3flare's managed policy leaves T3 Connect allowed, so t3's own policy variant does not refuse the link (P5)", async () => {
  const ManagedLimits = await import("t3/src/policy/managedLimits.ts");
  const ManagedPolicy = await import("t3/src/policy/ManagedPolicy.ts");
  const { T3FLARE_POLICY, T3FLARE_POLICY_SOURCE } = await import("../src/t3/managedPolicy.ts");
  const policy = await Effect.runPromise(ManagedPolicy.fromDocument(T3FLARE_POLICY_SOURCE, T3FLARE_POLICY));
  expect(ManagedLimits.allowsConnect(policy)).toBe(true);
});
