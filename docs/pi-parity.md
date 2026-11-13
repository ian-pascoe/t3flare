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
| Approvals, plan mode | W | `extensions/permissions.ts`, t3's modes; `extensions/plan.ts` (`propose_plan`, t3's proposed plan) | SPI-996 |
| Questions to the user | W | `extensions/ask-user.ts` (t3's `user_input` card) | — |
| pi-minimal-subagents | C | t3's `delegate_task`, `create_threads`, `t3_thread_*` (`extensions/t3-mcp.ts`, step 3) | — |
| Scheduled tasks | C | t3's `schedule_task` tools | — |
| `codemode`, `tool_search` | W | `extensions/codemode.ts`, sandbox Worker `t3flare-codemode-<stage>` (ADR-0027); switchable in the Harness panel | — |
| MCP servers (pi-mcp-selector, `mcp.json`: Executor, REA, Superlogical) | W | `extensions/mcp.ts` over the Environment's MCP host (ADR-0028): Commissary toolkits, and Direct servers added in the Harness panel (Executor, in browser mode); REA and Superlogical once served over HTTP (stdio refused); `t3` is covered by t3's tools | — |
| Harness settings | W | the Harness panel (ADR-0026): extensions, offered tools, MCP servers; later ports register in its extension registry | — |
| pi-web-tools (`web_search`, `web_fetch`) | W | `extensions/web.ts` (cloudpid `web`): `web_fetch` through the SSRF guard, on by default; `web_search` asks a search-capable model through the model proxy (Commissary, no new key), off until switched on in the Harness panel (a model request per search). Both show as t3's web search items | SPI-1054 |
| pi-todo | W | `extensions/todo.ts` (cloudpid `todo`): the list in the Session's storage, shown as t3's `todo_list` rows and plan (parity G5) | SPI-1055 |
| pi-context-management (notes, history, rollover) | W | `extensions/context.ts` (cloudpid `context`): bounded Notes and stored History in the Session's storage, `context_rollover`, and automatic compaction as a Rollover (switchable); t3's idle compaction stays off (K9) | SPI-1056 |
| pi-termctrl (terminals, background jobs) | W | `extensions/termctrl.ts` and `workspace/agentTerminals.ts` (pi-termctrl): `terminal_*` and `bash`'s `background` as PTYs in the Workspace's container under a second terminal host (ADR-0021: 8 at once, they end with the container), screens rendered by a headless xterm in the Workspace DO; approvals as `bash`'s; exits told as steers or notes, never a run of their own; shown as t3's command items. On by default: nothing starts a container until used. No `/ps` panel (t3's UI) | SPI-1057 |
| pi-guardian | W | `extensions/guardian.ts` (pi-guardian): a `beforeTool` hook (code mode's nested calls too) reviews risky calls on a proxy model (Haiku by default) with pi-guardian's Tool Policy, policy prompt, Decision Table and Escalation Pass; a Rejection or Review Failure blocks the call and t3 shows a "Guardian blocked …" notice with the reason. Off by default; model, thinking, Tool Policies, Command Rules and Security Policy in the Harness panel. Beside t3's approvals. No `cd` proved harmless, no Allow once, no classifier | SPI-1058 |
| pi-advisor | W | `extensions/advisor.ts` (pi-advisor): a private Advisor Session in the Session's Harness reviews the run on pi-advisor's cadence and gives cited findings, delivered as pi-advisor does (Concerns and Blockers steer the running agent, Nits and after-answer findings are notes, a final Blocker continues the same run once), shown as "Advisor …" notices in t3; never a run t3 did not start. Off by default; model, cadence, thinking and corrective continuations in the panel. No `advisor_ask` | SPI-1059 |
| Skills (pi-skills-selector, skill-gates) | P | Repo skills (SPI-1147): `.pi/skills`, `.agents/skills` and `.claude/skills` from the thread's directory up to the repo root, listed as pi does (`<available_skills>`, frozen per context window; `extensions/skills.ts`), offered in t3's composer, and `$name`, `/skill:name` and Prompt templates (`.pi/prompts`) expanded at submit (embedded, not linked). Environment skills from GitHub are SPI-1148; no skill-gates | SPI-1147, SPI-1148 |
| pi-formatter | D | owner, 2026-11-12: not for now | — |
| pi-lsp, pi-dap | D | owner, 2026-11-12: not for now (need servers and debuggers in the image) | — |
| pi-autoresearch | D | owner, 2026-11-12: not for now | — |
| pi-fff (`fffind`, `ffgrep`) | D | owner, 2026-11-12: not for now (native library, Container only) | — |
| pi-secret (`secret_ask` and the rest) | M | D5 lifted (owner, 2026-11-12, back to stock): t3's own `request_secret` covers it for Durable agents (ADR-0022); a port is not needed | — |
| plannotator | R | needs a local browser; t3's plan mode replaces it (parity G5) | — |
| pi-git-checkpoints | C | t3 checkpoints every turn (rollback: parity G6) | — |
| pi-command-deck, pi-tps-tracker, pi-issues-selector, pi-bible-verses | R | terminal UI; t3's app is the UI | — |
| Local extensions (active-theme, continue-on-dot, paste-image-on-empty-paste, herdr-agent-state, tool-schemas, flow-title, subq) | R | terminal UI and local glue; t3 makes its own titles | — |
| cloudpid's extension | R | controls cloudpid; could return as an MCP server | — |

## Order

Done: web tools (SPI-1054), todo (SPI-1055), context management (SPI-1056), on branch `ports` ([`docs/steps/pi-ports-1.md`](steps/pi-ports-1.md)); terminals (SPI-1057), guardian (SPI-1058), advisor (SPI-1059), on branch `ports2` ([`docs/steps/pi-ports-2.md`](steps/pi-ports-2.md)). Every ticketed port is done; the rest is deferred by the owner or refused.
