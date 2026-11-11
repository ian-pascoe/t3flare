// t3flare's managed policy (ADR-0023): t3's own administrator policy, built in rather than read from a machine-wide file.
// It locks the settings for features the Cloud Environment does not do, so the stock clients show them as "Managed by
// t3flare" instead of offering a switch that fails. The capability flags are the other half (`./capabilities.ts`).
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as ManagedPolicy from "t3/src/policy/ManagedPolicy.ts";

const off = { value: false, locked: true } as const;

export const T3FLARE_POLICY = {
  schemaVersion: 1,
  organization: "t3flare",
  supportUrl: "https://github.com/ian-pascoe/t3flare",
  settings: {
    // Guest links arrive through routes the Environment does not mount (ADR-0010); the share link would 404.
    guestSharingEnabled: off,
    // The device hub and simulators are host-bound and unmounted (parity: Device hub).
    enableDeviceSupport: off,
    enableAgentDeviceAccess: off,
    simlockDeviceHostsEnabled: off,
    // Custom text generators hold a vendor key typed into t3: refused for now (owner decision D5).
    textGenerators: { value: {}, locked: true },
  },
} as const satisfies ManagedPolicyDocument;

/** Where t3 says the policy came from (its `path`): no file, the build itself. */
export const T3FLARE_POLICY_SOURCE = "t3flare:built-in";

/** t3's `ManagedPolicy` service from t3flare's policy, in place of `ManagedPolicy.layer` (which reads the host). */
export const layerManagedPolicy = Layer.effect(ManagedPolicy.ManagedPolicy, ManagedPolicy.fromDocument(T3FLARE_POLICY_SOURCE, T3FLARE_POLICY));
