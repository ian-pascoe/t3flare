// Truthful capabilities (SPI-994, SPI-1012): every capability t3's descriptor can carry is classified, the stripped ones
// never reach a client, and t3flare's managed policy locks the settings of features the Cloud Environment does not do.
import { DEFAULT_SERVER_SETTINGS, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ManagedPolicy from "t3/src/policy/ManagedPolicy.ts";
import { describe, expect, it } from "vitest";

import { CAPABILITIES, cloudCapabilities } from "../src/t3/capabilities.ts";
import { layerManagedPolicy } from "../src/t3/managedPolicy.ts";

describe("the descriptor's capabilities", () => {
  it("classifies every capability t3's descriptor can carry, and nothing else", () => {
    const fields = Object.keys(ExecutionEnvironmentCapabilities.fields);
    const unclassified = fields.filter((key) => !Object.hasOwn(CAPABILITIES, key));
    expect(unclassified, "classify each as kept or stripped (with a reason) in apps/environment/src/t3/capabilities.ts").toEqual([]);
    const stale = Object.keys(CAPABILITIES).filter((key) => !fields.includes(key));
    expect(stale, "t3 no longer has these; remove them from apps/environment/src/t3/capabilities.ts").toEqual([]);
  });

  it("strips what the Cloud Environment does not do and keeps the rest", () => {
    const advertised = cloudCapabilities({
      repositoryIdentity: true,
      pullRequests: true,
      peerLinks: true,
      threadProjectFromScratch: true,
      npmReleaseLookup: true,
      cloudVoiceTranscription: true,
      voiceTranscription: true,
      serverBrowser: true,
      triage: true,
      serverSelfUpdate: "boot-service",
      localServerStop: true,
      fastWorktreeCheckout: true,
    } as ExecutionEnvironmentCapabilities);
    expect(advertised).toEqual({ repositoryIdentity: true, pullRequests: true, peerLinks: true });
  });
});

describe("t3flare's managed policy", () => {
  const policy = Effect.runPromise(
    Effect.gen(function* () {
      return yield* ManagedPolicy.ManagedPolicy;
    }).pipe(Effect.provide(layerManagedPolicy)),
  );

  it("is one t3 accepts, and tells clients what it locks", async () => {
    const { summary } = await policy;
    expect(summary?.organization).toBe("t3flare");
    expect(new Set(summary?.lockedSettings)).toEqual(
      new Set(["enableAgentDeviceAccess", "enableDeviceSupport", "guestSharingEnabled", "simlockDeviceHostsEnabled", "textGenerators"]),
    );
    expect(summary?.limits).toBeUndefined();
  });

  it("keeps guest links and the device panel off, whatever was stored", async () => {
    const { settings } = await policy;
    const stored = { ...DEFAULT_SERVER_SETTINGS, guestSharingEnabled: true, enableDeviceSupport: true };
    const applied = settings.applyLocks(stored);
    expect(applied.guestSharingEnabled).toBe(false);
    expect(applied.enableDeviceSupport).toBe(false);
    expect(settings.vetWrite(DEFAULT_SERVER_SETTINGS, stored, { guestSharingEnabled: true })).toMatchObject({ _tag: "Locked" });
  });
});
