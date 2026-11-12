// Shadow of t3code/apps/server/src/provider/builtInDrivers.ts (ADR-0001; step 2a). The Cloud Environment's provider
// drivers: the Durable agent driver, and (step 4a, ADR-0015) t3's Codex and Pi CLIs, run in the Workspaces' Containers
// through the process channel and registered by t3flare's own readiness wrappers (`provider/cli/`), never t3's probing
// drivers. Shadowed rather than restating the hydration Layer because `BUILT_IN_DRIVERS` is also read through
// `deriveProviderInstanceConfigMap` by `provider/providerInstallation.ts` and `terminal/Manager.ts`. Exports the same
// names as the module it replaces.
import type { AnyProviderDriver, ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";

import { PiDurableDriver, type PiDurableDriverEnv } from "../provider/driver.ts";
import { CodexCliDriver, type CodexCliDriverEnv } from "../provider/cli/codexDriver.ts";
import { PiCliDriver, type PiCliDriverEnv } from "../provider/cli/piDriver.ts";

export type BuiltInDriversEnv = PiDurableDriverEnv | CodexCliDriverEnv | PiCliDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [PiDurableDriver, CodexCliDriver, PiCliDriver];

export type BuiltInUsageReadersEnv = ProviderUsageReaderEnv<typeof PiDurableDriver>;

/** No usage readers: the proxy key has no plan windows to read; the subscriptions' windows are the model proxy's (ADR-0012). */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>> = [];
