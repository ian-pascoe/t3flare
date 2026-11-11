// The Durable agent provider (step 2a): a t3 ProviderDriver whose agents run on pi-durable in Session DOs of the agents
// Worker, with models through the deployment's model proxy (ADR-0012). Registered through the `builtInDrivers.ts` Shadow.
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
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { environmentServices } from "../agents/bindings.ts";
import { makePiDurableAdapter } from "./adapter.ts";
import { PI_DURABLE_DRIVER } from "./capabilities.ts";
import { snapshotModels } from "./models.ts";
import { PiDurableSettings } from "./settings.ts";
import { makePiDurableTextGeneration } from "./textGeneration.ts";

const PRESENTATION = {
  displayName: "Pi Durable",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const decodeSettings = Schema.decodeSync(PiDurableSettings);

export type PiDurableDriverEnv = ProviderHost.ProviderHost;

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
    probe: { installed: true, version: null, status: "ready", auth: { status: "authenticated" } },
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
    const { catalog } = environmentServices();
    // The snapshot's models are the catalog's: the copy kept from the last read, now; the proxy's list again at each check.
    const models = () => snapshotModels(catalog.current());
    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({ provider: PI_DURABLE_DRIVER, packageName: null });
    const settingsSource = yield* makeProviderSnapshotSettingsSource(effective);
    const snapshot = yield* makeManagedServerProvider({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: settingsSource.getSettings,
      streamSettings: settingsSource.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) => snapshotOf({ enabled: settings.provider.enabled, models: models() }).pipe(Effect.map(stamp)),
      checkProvider: Effect.promise(() => catalog.refresh()).pipe(
        Effect.flatMap(() => snapshotOf({ enabled: effective.enabled, models: models() })),
        Effect.map(stamp),
      ),
    }).pipe(Effect.orDie);
    // Read the proxy's list now rather than at the first interval: a fresh Environment starts with the kept copy.
    yield* Effect.forkScoped(snapshot.refresh);
    const textGeneration = makePiDurableTextGeneration();
    return {
      instanceId,
      driverKind: PI_DURABLE_DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter: makePiDurableAdapter(instanceId),
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
