// The Durable agent provider's instance settings (ADR-0012): models come from the proxy the deployment names, so the
// only setting is whether the instance is on. Kept browser-safe in shape, as t3's provider settings are.
import { makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PiDurableSettings = makeProviderSettingsSchema({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type PiDurableSettings = typeof PiDurableSettings.Type;
