// Claude Code in the Cloud Environment (step 4b, plan §3): t3's `claudeAgent` kind ("Claude") over t3's ACP adapter,
// running `claude-agent-acp` in the Workspace's Container on the model proxy (acpDriver.ts, acpFlavor.ts).
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import { CLIS } from "@t3flare/sandbox-image/clis";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import * as Schema from "effect/Schema";

import { type AcpCliDriverEnv, createAcpCliInstance } from "./acpDriver.ts";

export const CLAUDE_CLI_DRIVER = ProviderDriverKind.make("claudeAgent");

const decodeSettings = Schema.decodeSync(ClaudeSettings);

/** Claude's presentation: the plan toggle (its proposed plan is recovered, review F1), and `auto` as Claude's own auto mode (back to stock, owner 2026-11-12). */
const PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
  supportsConversationRollback: false,
} as const;

export type ClaudeCliDriverEnv = AcpCliDriverEnv;

export const ClaudeCliDriver: ProviderDriver<ClaudeSettings, ClaudeCliDriverEnv> = {
  driverKind: CLAUDE_CLI_DRIVER,
  metadata: { displayName: "Claude", supportsMultipleInstances: false, hasDefaultInstance: true },
  configSchema: ClaudeSettings,
  // Idle compaction is never this instance's: it would start a Container for a `/compact` turn (review F7).
  defaultConfig: () => decodeSettings({ idleCompaction: "off" }),
  create: (input) => createAcpCliInstance({ cli: "claude", driver: CLAUDE_CLI_DRIVER, presentation: PRESENTATION, version: CLIS.claude.version }, input),
};
