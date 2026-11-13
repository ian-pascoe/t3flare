// The CLI agents' built-in Slash commands (SPI-1151 §2): stock's static entries, each listed only where its stage run
// worked on t3flare's path (docs/steps/spi-1151.md): `/compact` for Codex and pi (t3's adapters turn it into the CLI's
// own compaction) and Codex's `/goal`. Not for Claude Code and OpenCode: t3's ACP adapter answers `/compact` "This
// provider does not support /compact" without a flavor that compacts (`supportsCompaction`, `compactSession`). Never
// `/feedback`: t3flare refuses that upload (ADR-0015). The CLIs' dynamic command lists are not listed.
import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import type { CliAgent } from "@t3flare/skills";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";

import { withPiBuiltinSlashCommands } from "../../../../../t3code/packages/provider-pi/src/server/commands.ts";

/** Stock's Codex `/goal` (`CodexProvider.ts`, its machine snapshot), restated: t3 does not export it. */
const CODEX_GOAL: ServerProviderSlashCommand = {
  name: "goal",
  description: "Set a goal Codex keeps working toward until it is done",
  input: { hint: "Objective, or pause, resume, clear" },
};

export const CLI_BUILT_IN_COMMANDS: Readonly<Record<CliAgent, ReadonlyArray<ServerProviderSlashCommand>>> = {
  codex: [COMPACT_SLASH_COMMAND, CODEX_GOAL],
  pi: withPiBuiltinSlashCommands([]),
  claude: [],
  opencode: [],
};
