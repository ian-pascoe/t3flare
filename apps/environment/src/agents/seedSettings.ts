// Text generation's model (risk R12): t3's default `textGenerationModelSelection` names the `codex` instance, which the
// Cloud Environment does not have, and t3's fallback only applies to an instance it has. While the setting still names
// an instance that is not registered, it is pointed at the Durable agent provider's small model, once per boot.
import { defaultInstanceIdForDriver } from "@t3tools/contracts";
import { SMALL_MODEL_SLUG } from "@t3flare/models";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "t3/src/serverSettings.ts";
import * as ProviderInstanceRegistry from "t3/src/provider/ProviderInstanceRegistry.ts";

import { PI_DURABLE_DRIVER } from "../provider/capabilities.ts";

export const layerSeedTextGenerationModel = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const current = yield* settings.getSettings;
    const named = current.textGenerationModelSelection.instanceId;
    if ((yield* registry.getInstance(named)) !== undefined) return;
    yield* settings.updateSettings({
      textGenerationModelSelection: { instanceId: defaultInstanceIdForDriver(PI_DURABLE_DRIVER), model: SMALL_MODEL_SLUG },
    });
    yield* Effect.logInfo("t3flare: text generation now uses the Durable agent provider", { replaced: named });
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("t3flare: text generation's model was not seeded", cause))),
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
