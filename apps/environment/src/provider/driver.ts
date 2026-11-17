// The Durable agent provider (step 2a): a t3 ProviderDriver whose agents run on pi-durable in Session DOs of the agents
// Worker, with models through the owner's Model endpoints (ADR-0034). Registered through the `builtInDrivers.ts` Shadow.
// With no endpoint that lists a model it needs setup (SPI-1176): its status says so and points to the Harness panel.
import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { buildServerProvider, type ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { NO_ENDPOINT_MESSAGE } from "@t3flare/models/endpoints";

import { environmentServices } from "../agents/bindings.ts";
import { refreshOnEndpointsChanged } from "../endpoints/changes.ts";
import { makePiDurableAdapter } from "./adapter.ts";
import { attachmentReader } from "./attachments.ts";
import { PI_DURABLE_DRIVER } from "./capabilities.ts";
import { snapshotModels } from "./models.ts";
import { readinessOf } from "./readiness.ts";
import { PiDurableSettings } from "./settings.ts";
import { environmentSkillsAccess, piDurableSnapshotForCwd } from "./skills.ts";
import { makePiDurableTextGeneration } from "./textGeneration.ts";

export const PRESENTATION = {
  displayName: "Pi Durable",
  // SPI-996: plan mode is enforced read-only in the Session, and its plan becomes t3's proposed plan.
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const decodeSettings = Schema.decodeSync(PiDurableSettings);

export type PiDurableDriverEnv = ProviderHost.ProviderHost | McpProviderSessions.McpProviderSessions | FileSystem.FileSystem;

const snapshotOf = Effect.fn("PiDurableDriver.snapshot")(function* (input: {
  readonly enabled: boolean;
  readonly models: ReadonlyArray<ServerProviderModel>;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: input.enabled,
    checkedAt,
    models: input.models,
    probe: readinessOf(input.models, null, NO_ENDPOINT_MESSAGE),
  });
});

export const PiDurableDriver: ProviderDriver<PiDurableSettings, PiDurableDriverEnv> = {
  driverKind: PI_DURABLE_DRIVER,
  metadata: { displayName: "Pi Durable", supportsMultipleInstances: false, hasDefaultInstance: true },
  configSchema: PiDurableSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("PiDurableDriver.create")(function* ({ instanceId, displayName, accentColor, enabled, config }) {
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: PI_DURABLE_DRIVER, instanceId });
    const stamp = (draft: ServerProviderDraft): ServerProvider => ({
      ...draft,
      instanceId,
      driver: PI_DURABLE_DRIVER,
      ...(displayName ? { displayName } : {}),
      ...(accentColor ? { accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey },
    });
    const effective = { ...config, enabled };
    // The snapshot's models are the Model endpoints' as stored now (SPI-1162), read through the services bound last: an
    // Environment DO that reset in a warm isolate binds them again.
    const models = () => snapshotModels(environmentServices().modelEndpoints?.());
    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({ provider: PI_DURABLE_DRIVER, packageName: null });
    const settingsSource = yield* makeProviderSnapshotSettingsSource(effective);
    const snapshot = yield* makeManagedServerProvider({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: settingsSource.getSettings,
      streamSettings: settingsSource.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) => snapshotOf({ enabled: settings.provider.enabled, models: models() }).pipe(Effect.map(stamp)),
      checkProvider: Effect.suspend(() => snapshotOf({ enabled: effective.enabled, models: models() })).pipe(Effect.map(stamp)),
    }).pipe(Effect.orDie);
    yield* Effect.forkScoped(snapshot.refresh);
    // A change to the Model endpoints reaches the picker at once, not at the next check.
    yield* refreshOnEndpointsChanged(snapshot.refresh);
    const textGeneration = makePiDurableTextGeneration();
    // t3's MCP credential per thread (step 3): the adapter hands it to the Session with each open and turn.
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    // t3's attachment store (SPI-993): the adapter turns a message's attachments into the Session's images and text.
    const attachments = attachmentReader(yield* ProviderHost.ProviderHost, yield* FileSystem.FileSystem);
    // SPI-1147: the Workspaces' Repo skills and Prompt templates, behind the Harness `skills` switch.
    const skills = environmentSkillsAccess();
    return {
      instanceId,
      driverKind: PI_DURABLE_DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      // SPI-1147: the thread's Repo skills and Prompt templates for t3's composer; t3's TTL keeps it fresh.
      snapshotForCwd: (cwd) =>
        snapshot.getSnapshot.pipe(
          Effect.flatMap((machine) => piDurableSnapshotForCwd(machine, cwd, skills)),
          Effect.mapError((cause) => new ProviderDriverError({ driver: PI_DURABLE_DRIVER, instanceId, detail: "Failed to read the Workspace's skills.", cause })),
        ),
      orchestrationAdapter: makePiDurableAdapter(instanceId, mcpSessions, attachments, skills),
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
