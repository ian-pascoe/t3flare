// Shadow of t3code/apps/server/src/provider/builtInDrivers.ts (ADR-0001; step 2a). The Cloud Environment's provider
// drivers are the Durable agent driver alone: none of t3's CLI drivers can run in the Environment DO (ADR-0015 brings
// them back in Containers), and their probes would only add spawn attempts. Shadowed rather than restating the
// hydration Layer because `BUILT_IN_DRIVERS` is also read through `deriveProviderInstanceConfigMap` by
// `provider/providerInstallation.ts` and `terminal/Manager.ts`. Exports the same names as the module it replaces.
import type { AnyProviderDriver, ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";

import { PiDurableDriver, type PiDurableDriverEnv } from "../provider/driver.ts";

export type BuiltInDriversEnv = PiDurableDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [PiDurableDriver];

export type BuiltInUsageReadersEnv = ProviderUsageReaderEnv<typeof PiDurableDriver>;

/** No usage readers: the proxy key has no plan windows to read (part 2's Subscription logins add them). */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>> = [];
