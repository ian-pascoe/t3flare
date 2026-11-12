# Pi harness parity (the owner's pi setup vs the Durable agent)

The second checklist beside [`parity.md`](parity.md): what the owner's local pi harness offers, and whether t3flare's Durable agent (pi-durable in `apps/agents/src/session/SessionDO.ts`) has it. First audit 2026-11-12, against the owner's `~/.pi/agent` (core pi, npm packages, `ian-pascoe/pi-extensions`, cloudpid, local extensions, `mcp.json`). Update rows as ports land; each gap has a Linear ticket (project ian-pascoe/t3flare).

The CLI agents (Codex, Pi CLI, Claude Code, OpenCode) run with clean, managed profiles (steps 4a, 4b), so none of the owner's extensions load there either; this checklist is about the Durable agent.

**Source for ports:** cloudpid's durable extensions (`~/src/cloudpid/packages/extensions/src`: `web`, `todo`, `context`, `tool-search`, `mcp`, `subagents`, `skills`, `secrets`, `browser`, `notify`), already written for pi-durable.

**Status:** **W** works · **C** covered another way · **M** missing (ticketed) · **D** deferred by the owner · **R** refused by design or N/A.

## Tools and extensions

| Owner's harness | Status | Where / why | Ticket |
|---|---|---|---|
| `read`, `write`, `edit`, `bash` | W | `extensions/coding-tools.ts`; `bash` routes between the Worker Shell and the Container | — |
| `ls`, `find`, `grep` | W | `extensions/files.ts` over the Workspace's files | — |
| AGENTS.md discovery | W | `extensions/project-context.ts` (root down to the working directory) | — |
| Approvals, plan mode | W | `extensions/permissions.ts`, t3's modes | — |
| Questions to the user | W | `extensions/ask-user.ts` (t3's `user_input` card) | — |
| pi-minimal-subagents | C | t3's `delegate_task`, `create_threads`, `t3_thread_*` (`extensions/t3-mcp.ts`, step 3) | — |
| Scheduled tasks | C | t3's `schedule_task` tools | — |
| `codemode`, `tool_search` | M | pi-durable 1.5.0 ships both; Commissary tools step, part 1 | tools step |
| MCP servers (pi-mcp-selector, `mcp.json`: Executor, REA, Superlogical) | M | Commissary tools step, parts 2 and 4 (Commissary toolkits, or t3flare-direct servers); `t3` is covered by t3's tools | tools step, SPI-1039 |
| pi-web-tools (`web_search`, `web_fetch`) | M | port cloudpid `web` | SPI-1054 |
| pi-todo | M | port cloudpid `todo`, shown as t3's todos (parity G5) | SPI-1055 |
| pi-context-management (notes, history, rollover) | M | port cloudpid `context` | SPI-1056 |
| pi-termctrl (terminals, background jobs) | M | Container PTYs through t3flare's terminal host | SPI-1057 |
| pi-guardian | M | model-reviewed gating on a Commissary model | SPI-1058 |
| pi-advisor | M | background advice on a Commissary model | SPI-1059 |
| Skills (pi-skills-selector, skill-gates) | D | owner, 2026-11-12: not for now (parity G10, SPI-1001) | SPI-1001 |
| pi-formatter | D | owner, 2026-11-12: not for now | — |
| pi-lsp, pi-dap | D | owner, 2026-11-12: not for now (need servers and debuggers in the image) | — |
| pi-autoresearch | D | owner, 2026-11-12: not for now | — |
| pi-fff (`fffind`, `ffgrep`) | D | owner, 2026-11-12: not for now (native library, Container only) | — |
| pi-secret (`secret_ask` and the rest) | R | D5: typed keys refused for now; credentials stay in the Environment (ADR-0012) | — |
| plannotator | R | needs a local browser; t3's plan mode replaces it (parity G5) | — |
| pi-git-checkpoints | C | t3 checkpoints every turn (rollback: parity G6) | — |
| pi-command-deck, pi-tps-tracker, pi-issues-selector, pi-bible-verses | R | terminal UI; t3's app is the UI | — |
| Local extensions (active-theme, continue-on-dot, paste-image-on-empty-paste, herdr-agent-state, tool-schemas, flow-title, subq) | R | terminal UI and local glue; t3 makes its own titles | — |
| cloudpid's extension | R | controls cloudpid; could return as an MCP server | — |

## Order

After the Commissary tools step (code mode, tool search, MCP): web tools (SPI-1054), todo (SPI-1055), context management (SPI-1056), terminals (SPI-1057), guardian (SPI-1058), advisor (SPI-1059).
