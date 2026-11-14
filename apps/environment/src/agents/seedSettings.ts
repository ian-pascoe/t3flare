// Text generation's model (risk R12; SPI-1163): t3's default `textGenerationModelSelection` names the `codex` instance,
// which the Cloud Environment does not have, and t3's fallback only applies to an instance it has. While the owner has
// set no model, the setting names text generation's default, so the setting says which model that is: a small model of
// the first Model endpoint that has one (`defaultTextModel`), else the Model proxy's small model until the hard cut,
// else `default` (which fails saying to pick one). It is written at each boot and again whenever the endpoints change.
//
// "No model set" is: t3's own default (Codex's model, even where the CLI agents register a `codex` instance), an
// instance this Environment does not have, `default`, or the model this sync wrote last (kept in the Environment DO's
// storage, recorded only once the setting holds it). A setting written by the earlier seed (the proxy's small model, with
// no record kept) counts as unset too. Any other model is the owner's, and is never replaced; an owner who picks exactly
// one of those values is read as unset (upstream-fragility U67). One sync runs at a time, so two endpoint changes in a row
// never read the setting before the other has written it.
import { DEFAULT_SERVER_SETTINGS, defaultInstanceIdForDriver } from "@t3tools/contracts";
import { SMALL_MODEL_SLUG } from "@t3flare/models";
import { defaultTextModel, EMPTY_ENDPOINTS } from "@t3flare/models/endpoints";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as ServerSettings from "t3/src/serverSettings.ts";
import * as ProviderInstanceRegistry from "t3/src/provider/ProviderInstanceRegistry.ts";

import { onEndpointsChanged } from "../endpoints/changes.ts";
import { PI_DURABLE_DRIVER } from "../provider/capabilities.ts";
import { environmentServices } from "./bindings.ts";

/** One sync at a time, per isolate (the Environment DO is the only object in it). */
const syncing = Semaphore.makeUnsafe(1);

/** Points an unset text-generation setting at text generation's default model now. */
export const syncTextGenerationDefault = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const services = environmentServices();
  const current = (yield* settings.getSettings).textGenerationModelSelection;
  const instanceId = defaultInstanceIdForDriver(PI_DURABLE_DRIVER);
  const seeded = services.seededTextModel.get();
  const stock = DEFAULT_SERVER_SETTINGS.textGenerationModelSelection;
  const unset =
    (current.instanceId === stock.instanceId && current.model === stock.model) ||
    (yield* registry.getInstance(current.instanceId)) === undefined ||
    (current.instanceId === instanceId && (current.model === "default" || current.model === seeded || (seeded === undefined && current.model === SMALL_MODEL_SLUG)));
  if (!unset) return;
  const model = defaultTextModel(services.modelEndpoints?.() ?? EMPTY_ENDPOINTS) ?? (services.modelProxy === undefined ? "default" : SMALL_MODEL_SLUG);
  if (current.instanceId !== instanceId || current.model !== model) {
    yield* settings.updateSettings({ textGenerationModelSelection: { instanceId, model } });
    yield* Effect.logInfo("t3flare: text generation's default model", { model, replaced: `${current.instanceId}/${current.model}` });
  }
  // Recorded only once the setting holds it: a failed write leaves the record naming what the setting still holds.
  services.seededTextModel.set(model);
}).pipe(syncing.withPermits(1));

export const layerSeedTextGenerationModel = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = syncTextGenerationDefault.pipe(Effect.catchCause((cause) => Effect.logWarning("t3flare: text generation's default model was not set", cause)));
    yield* sync;
    // A changed endpoint list can change the default: an unset setting follows it at once.
    const context = yield* Effect.context<ServerSettings.ServerSettingsService | ProviderInstanceRegistry.ProviderInstanceRegistry>();
    const stopHearing = onEndpointsChanged(() => void Effect.runForkWith(context)(sync));
    yield* Effect.addFinalizer(() => Effect.sync(stopHearing));
  }),
);

/**
 * t3's fast worktree checkout (a copy-on-write cache on the Environment's own disk, macOS only) is off in the Cloud
 * Environment (step 2b): every worktree is a Workspace of its own, made by `git worktree add`. The capability is
 * stripped from the descriptor; a client that set the setting anyway has it turned off at each boot.
 */
export const layerPinFastWorktreeCheckoutOff = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    if (!(yield* settings.getSettings).fastWorktreeCheckout) return;
    yield* settings.updateSettings({ fastWorktreeCheckout: false });
    yield* Effect.logInfo("t3flare: fast worktree checkout turned off");
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("t3flare: fast worktree checkout was not pinned off", cause))),
);

/** Marks, in the Environment DO's storage, that L1 has turned Linked environments on (once). */
const LINKED_ENVIRONMENTS_SEEDED = "t3flare:seeded/linked-environments";

/**
 * Step 3 (L1): Linked environments (a Labs setting, off by default) is what lets the owner's laptop link to the Cloud
 * Environment (ADR-0011), so it is turned on once per Environment. An owner who turns it off in the cloud's Labs keeps
 * it off: the seed is recorded in the DO's storage and never runs again.
 */
export const layerSeedLinkedEnvironmentsOn = Layer.effectDiscard(
  Effect.gen(function* () {
    const marks = environmentServices().marks;
    if (marks.has(LINKED_ENVIRONMENTS_SEEDED)) return;
    const settings = yield* ServerSettings.ServerSettingsService;
    if (!(yield* settings.getSettings).linkedEnvironmentsEnabled) {
      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
      yield* Effect.logInfo("t3flare: Linked environments turned on");
    }
    marks.set(LINKED_ENVIRONMENTS_SEEDED);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("t3flare: Linked environments was not seeded", cause))),
);
