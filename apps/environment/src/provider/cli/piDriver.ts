// @effect-diagnostics globalConsole:off effectFnOpportunity:off
// The pi CLI in the Cloud Environment (step 4a, plan §3, §5.2, §5.3): t3's own Pi adapter (`makePiAdapterV2`) with
// t3flare's readiness (the image's version and the proxy's catalog, never a spawning probe), t3's MCP credential
// withheld (OD-3), the spawn's profile from `agents/cliProfiles.ts` (t3's permission extension required, its mode
// always set), plan turns refused, text generation through the proxy, and the wrapper. Shown as "Pi", beside "Pi Durable".
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { CLIS } from "@t3flare/sandbox-image/clis";
import { defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { haveProviderSnapshotSettingsChanged, makeProviderSnapshotSettingsSource } from "@t3tools/provider-core/server/snapshotSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makePiAdapterV2 } from "../../../../../t3code/packages/provider-pi/src/server/adapter.ts";
import { PiSettings } from "../../../../../t3code/packages/provider-pi/src/settings.ts";
import { environmentServices } from "../../agents/bindings.ts";
import { snapshotModels } from "../models.ts";
import { makePiDurableTextGeneration } from "../textGeneration.ts";
import { cliSnapshotForCwdOf } from "../skills.ts";
import { CLI_BUILT_IN_COMMANDS } from "./builtInCommands.ts";
import { t3McpForCli } from "./relayedMcp.ts";
import { type CliSessions, wrapCliAdapter } from "./wrapper.ts";

export const PI_CLI_DRIVER = ProviderDriverKind.make("pi");

/** t3's Pi presentation (`provider-pi/src/server/status.ts` `PI_PRESENTATION`): no plan toggle, no `auto`. */
const PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const decodeSettings = Schema.decodeSync(PiSettings);

/** pi's extension's notice when t3's MCP is absent: t3flare withholds it on purpose (OD-3, review F10). */
export const MCP_UNAVAILABLE_NOTICE = "t3-code MCP unavailable";

export type PiCliDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderContinuationRequests.ProviderContinuationRequests
  | ProviderHost.ProviderHost;

const snapshotOf = (enabled: boolean) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled,
      checkedAt,
      models: snapshotModels(environmentServices().catalog.current()),
      // SPI-1151: stock's `/compact` (t3's Pi adapter runs it as pi's RPC compaction).
      slashCommands: CLI_BUILT_IN_COMMANDS.pi,
      probe: { installed: true, version: CLIS.pi.version, status: "ready", auth: { status: "authenticated" } },
    });
  });

export const PiCliDriver: ProviderDriver<PiSettings, PiCliDriverEnv> = {
  driverKind: PI_CLI_DRIVER,
  metadata: { displayName: "Pi", supportsMultipleInstances: false, hasDefaultInstance: true },
  configSchema: PiSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("PiCliDriver.create")(function* ({ instanceId, displayName, accentColor, enabled, config }) {
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: PI_CLI_DRIVER, instanceId });
    const stamp = (draft: Omit<ServerProvider, "instanceId" | "driver">): ServerProvider => ({
      ...draft,
      instanceId,
      driver: PI_CLI_DRIVER,
      ...(displayName ? { displayName } : {}),
      ...(accentColor ? { accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey },
    });
    const effective = { ...config, enabled };
    const { catalog } = environmentServices();
    const settingsSource = yield* makeProviderSnapshotSettingsSource(effective);
    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({ provider: PI_CLI_DRIVER, packageName: null });
    const snapshot = yield* makeManagedServerProvider({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: settingsSource.getSettings,
      streamSettings: settingsSource.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) => snapshotOf(settings.provider.enabled).pipe(Effect.map(stamp)),
      checkProvider: Effect.promise(() => catalog.refresh()).pipe(
        Effect.flatMap(() => snapshotOf(effective.enabled)),
        Effect.map(stamp),
      ),
    }).pipe(Effect.orDie);
    yield* Effect.forkScoped(snapshot.refresh);
    const realMcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const sessions: CliSessions = new Map();
    // t3's own tools with t3's per-thread bearer, as stock t3 hands them, at t3's public `/mcp` (owner, 2026-11-12, back
    // to stock; relayedMcp.ts).
    const relayed = t3McpForCli(realMcpSessions, () => environmentServices().t3McpUrl());
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    // binaryPath and launchArgs are not used: the profile decides the binary and the flags (plan §3).
    const adapter = yield* makePiAdapterV2({
      instanceId,
      settings: { ...config, enabled, binaryPath: "pi", launchArgs: "" },
      environment: {},
      continuationRequests,
    }).pipe(Effect.provideService(McpProviderSessions.McpProviderSessions, relayed));
    return {
      instanceId,
      driverKind: PI_CLI_DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      // SPI-1151: the Workspace's Repo skills and Prompt templates at pi's roots (the ones its profile names by flag).
      snapshotForCwd: cliSnapshotForCwdOf({ machine: snapshot.getSnapshot, driver: PI_CLI_DRIVER, instanceId, agent: "pi" }),
      orchestrationAdapter: wrapCliAdapter(adapter, {
        sessions,
        dropEvent: (event) => JSON.stringify(event).includes(MCP_UNAVAILABLE_NOTICE),
      }),
      textGeneration: makePiDurableTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
