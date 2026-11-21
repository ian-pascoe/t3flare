// Step 3+ (review finding 1): the CloudLink t3's HTTP routes get refuses the four relay-initiated calls, as t3's own
// managed-policy variant does, and passes the rest through to the real one.
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";
import * as CloudLink from "t3/src/cloud/CloudLink.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";

import { layerRefusingCloudLink } from "../src/connect/service.ts";

/** A well-formed proof request, as t3's own `cloud/http.test.ts` makes one: refused before it is read. */
const PROOF_REQUEST: RelayLinkProofRequest = {
  challenge: "challenge-1",
  relayIssuer: "https://relay.example.test",
  endpoint: { providerKind: "cloudflare_tunnel", httpBaseUrl: "https://environment.example.test", wsBaseUrl: "wss://environment.example.test" },
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
};

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
        linkProof: Effect.flip(link.linkProof(PROOF_REQUEST)),
        applyRelayConfig: Effect.flip(link.applyRelayConfig({} as never)),
        answerHealthRequest: Effect.flip(link.answerHealthRequest({} as never)),
        mintCredential: Effect.flip(link.mintCredential({} as never)),
      });
      const kept = [yield* link.linkState(), yield* link.unlink(), yield* link.updatePreferences({ publishAgentActivity: true })];
      return { refused: Object.fromEntries(Object.entries(refused).map(([name, error]) => [name, error._tag])), kept };
    }).pipe(Effect.provide(layer)),
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

it("Connect mutations are owner-only unless the stage admits its service token (review finding 6)", async () => {
  const { callerMayRun } = await import("../src/connect/admin.ts");
  const prod = false;
  const stage = true;
  expect(callerMayRun("POST /_t3flare/connect/sign-in", "service-token", prod)).toBe(false);
  expect(callerMayRun("POST /_t3flare/connect/import-token", "service-token", prod)).toBe(false);
  expect(callerMayRun("POST /_t3flare/connect/sign-in", "owner", prod)).toBe(true);
  expect(callerMayRun("POST /_t3flare/connect/sign-in", null, prod)).toBe(false);
  expect(callerMayRun("GET /_t3flare/connect/status", "service-token", prod)).toBe(true);
  expect(callerMayRun("POST /_t3flare/connect/relink", "service-token", stage)).toBe(true);
});
