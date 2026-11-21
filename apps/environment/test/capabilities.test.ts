// Truthful capabilities (SPI-994, SPI-1012): every capability t3's descriptor can carry is classified, the stripped ones
// never reach a client, and t3flare's managed policy locks the settings of features the Cloud Environment does not do.
import { DEFAULT_SERVER_SETTINGS, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ManagedPolicy from "t3/src/policy/ManagedPolicy.ts";
import { describe, expect, it } from "vitest";

import { CAPABILITIES, cloudCapabilities, unclassifiedCapabilities } from "../src/t3/capabilities.ts";
import { layerManagedPolicy } from "../src/t3/managedPolicy.ts";

describe("the descriptor's capabilities", () => {
  it("classifies only capabilities t3's descriptor can carry", () => {
    const fields = Object.keys(ExecutionEnvironmentCapabilities.fields);
    const stale = Object.keys(CAPABILITIES).filter((key) => !fields.includes(key));
    expect(stale, "t3 no longer has these; remove them from apps/environment/src/t3/capabilities.ts").toEqual([]);
  });

  it("strips a flag a nightly adds until it is classified, and names it", () => {
    expect(unclassifiedCapabilities(["repositoryIdentity", "someNewFlag"])).toEqual(["someNewFlag"]);
    expect(cloudCapabilities({ repositoryIdentity: true, someNewFlag: true } as unknown as ExecutionEnvironmentCapabilities)).toEqual({ repositoryIdentity: true });
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
    // Cloud voice transcription is kept: t3 calls the vendor over fetch with the key typed into its settings (D5 lifted,
    // owner 2026-11-12, back to stock).
    // G11 (ADR-0031): the server browser and stopping a listed server are kept.
    expect(advertised).toEqual({
      repositoryIdentity: true,
      pullRequests: true,
      peerLinks: true,
      threadProjectFromScratch: true,
      cloudVoiceTranscription: true,
      serverBrowser: true,
      localServerStop: true,
    });
  });

  it("advertises t3flare's own server Update only where it is configured (in-app updates plan D2, D14)", () => {
    const fromT3 = { repositoryIdentity: true, serverSelfUpdate: "boot-service", serverSelfUpdateProgress: true, serverUpdateStaging: true } as ExecutionEnvironmentCapabilities;
    expect(cloudCapabilities(fromT3)).toEqual({ repositoryIdentity: true });
    expect(cloudCapabilities(fromT3, { serverSelfUpdate: "respawn" })).toEqual({ repositoryIdentity: true, serverSelfUpdate: "respawn" });
    // The stock client takes no accepting-`ready` baseline for `respawn`, so an idle reset does not read as a failure.
    // t3's own update machinery is stripped whatever t3 says, with or without t3flare's own Update advertised.
    const stripped = Object.fromEntries(["serverSelfUpdateProgress", "serverUpdateStaging", "serverUpdateThreadContinuation", "serverInstallation", "npmReleaseLookup", "desktopAppUpdate"].map((key) => [key, true]));
    const withStripped = { repositoryIdentity: true, ...stripped } as unknown as ExecutionEnvironmentCapabilities;
    expect(cloudCapabilities(withStripped)).toEqual({ repositoryIdentity: true });
    expect(cloudCapabilities(withStripped, { serverSelfUpdate: "respawn" })).toEqual({ repositoryIdentity: true, serverSelfUpdate: "respawn" });
  });
});

describe("t3flare's managed policy", () => {
  const policy = Effect.runPromise(
    ManagedPolicy.ManagedPolicy.pipe(Effect.provide(layerManagedPolicy)),
  );

  it("is one t3 accepts, and tells clients what it locks", async () => {
    const { summary } = await policy;
    expect(summary?.organization).toBe("t3flare");
    expect(new Set(summary?.lockedSettings)).toEqual(
      new Set([
        "enableAgentDeviceAccess",
        "enableDeviceSupport",
        "enablePreviewTunnel",
        "guestSharingEnabled",
        "idleCompaction",
        "simlockDeviceHostsEnabled",
      ]),
    );
    expect(summary?.limits).toEqual({ telemetry: false, previewTunnel: false });
  });

  it("leaves custom text generators to the owner, as stock t3 does (D5 lifted)", async () => {
    const { settings } = await policy;
    expect(settings.vetWrite(DEFAULT_SERVER_SETTINGS, DEFAULT_SERVER_SETTINGS, { textGenerators: {} })).not.toMatchObject({ _tag: "Locked" });
    expect(settings.vetWrite(DEFAULT_SERVER_SETTINGS, DEFAULT_SERVER_SETTINGS, { guestSharingEnabled: true })).toMatchObject({ _tag: "Locked" });
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
