// OpenCode in the Cloud Environment (step 4b, plan §3): t3's `opencode` kind ("OpenCode") over t3's ACP adapter,
// running `opencode acp` in the Workspace's Container on the model proxy (acpDriver.ts, acpFlavor.ts). Never t3's
// native OpenCode runtime: a `serverUrl` must never make t3 connect anywhere.
import { ProviderDriverKind } from "@t3tools/contracts";
import { CLIS } from "@t3flare/sandbox-image/clis";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as Schema from "effect/Schema";

import { type AcpCliDriverEnv, createAcpCliInstance } from "./acpDriver.ts";

export const OPENCODE_CLI_DRIVER = ProviderDriverKind.make("opencode");

const decodeSettings = Schema.decodeSync(OpenCodeSettings);

/** OpenCode's presentation: its `plan` agent behind t3's plan toggle (no proposed plan: todos and text), no `auto`. */
const PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  supportsConversationRollback: false,
} as const;

export type OpenCodeCliDriverEnv = AcpCliDriverEnv;

export const OpenCodeCliDriver: ProviderDriver<OpenCodeSettings, OpenCodeCliDriverEnv> = {
  driverKind: OPENCODE_CLI_DRIVER,
  metadata: { displayName: "OpenCode", supportsMultipleInstances: false, hasDefaultInstance: true },
  configSchema: OpenCodeSettings,
  // t3's OpenCode defaults to disabled (its native server needs a local install); here it is in the image.
  defaultConfig: () => decodeSettings({ enabled: true }),
  create: (input) => createAcpCliInstance({ cli: "opencode", driver: OPENCODE_CLI_DRIVER, presentation: PRESENTATION, version: CLIS.opencode.version }, input),
};
