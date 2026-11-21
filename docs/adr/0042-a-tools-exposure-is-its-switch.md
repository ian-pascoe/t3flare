# A tool's Exposure is its switch; an extension with tools follows them

Status: accepted (2026-11-21). Refines [ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md) (the panel's extension registry) and [ADR-0027](0027-the-durable-agent-has-code-mode-in-a-sandbox-worker-and-its-guards-live-in-the-tools.md) §5 (the offered-tools preset).

The panel had one switch per extension, a preset for which tools are offered without a search, and a separate `web.search` boolean. Most of those switches only decide which tools the model gets, and the preset could not set one tool. The owner could not, for instance, drop `ask_user` for a harness whose question tools come from an MCP server: it was a locked core extension.

So every tool a Durable agent is offered has an **Exposure**, as MCP servers' tools already had (ADR-0028): `direct` (in every request), `deferred` (loaded by `tool_search`; scripts call it any time), `codemode` (code mode's scripts only) or `hidden` (callable by no one).

1. **Built-in tools** (`packages/harness-registry/src/tools.ts`, `BUILTIN_TOOLS`) each have one, coding and file tools included. `codemode` and `tool_search` are `direct` or `hidden`: hiding one turns code mode or tool search off.
2. **An extension with tools has no switch.** It is installed while any of its tools is not `hidden`; a hidden tool of an installed extension (one coding tool, one of three context tools) is wrapped to no callers. Its other settings (code mode's budget, web search's model, the Terminals' size) stay as settings.
3. **The fallbacks are the Session's**, not the settings': a `codemode` tool without code mode is deferred, and a `deferred` tool without tool search is direct. A tool its registration keeps for the model (t3's waits) is never code mode only.
4. **t3's own tools** have their Exposures in the Harness settings too, shown on an always-on `t3-code` card among the MCP servers, one tool per row. t3 decides which tools a thread has, and asks for some in every request (`_meta["anthropic/alwaysLoad"]`): such a tool is direct unless the owner sets it, and every other tool without its own takes the card's default. The panel cannot list t3's tools itself (they are per thread), so each Session reports the catalog it last listed, and the card shows it.
5. **Presets are buttons**, not a stored value: `core`, `codemode-only` and `everything` set every tool that is not hidden and is not a switch, t3's and MCP servers' included, in one change: a server's Exposure takes the preset's (`core` defers MCP servers' tools, `everything` makes them direct, as the old preset's wrap did), and each tool's own goes back to it; a code-mode-only server or tool is left as it is, as the wrap left it. A t3 tool the owner set takes the preset's Exposure as its own, so one t3 asks for in every request is not widened to direct.
6. **Change tiers** follow MCP Exposures (ADR-0035 §3): narrowing a tool is free, widening it (`hidden` up, or `codemode` to `deferred`/`direct`) is asked. A preset was free in either direction; now a preset that widens some tool is asked. Hiding `codemode` or `tool_search` is asked too, since the tools set to them fall back to a wider Exposure; a t3 tool's own Exposure cleared is judged with t3's hint, as asking for direct when the tool is not listed.
7. **Old settings still resolve.** A tool with no Exposure of its own takes the one the stored extension switches, preset and `web.search` gave it, and a Session restarted on a view from before this change reads its `offered` list. A built-in tool keeps what it had until the owner sets it. Two things move until a preset is applied again: an MCP server's tools take the server's own Exposure, which the stored preset's wrap used to override, and t3's tools that ask for every request are direct under the stored `codemode-only` preset (4: t3's hint is the default).

## Considered options

- **A per-tool Exposure inside the offered-tools extension, the extension switches kept** (built first). Rejected by the owner: two controls for one thing (a switch, and the tools it turns on).
- **One Exposure for all of t3's tools, the list read-only.** Simpler, but the owner wanted tools one by one.
- **Leaving t3's tools to t3's hints alone.** t3's hint is for Claude Code's tool search; which tools reach the model is the harness's choice, so the hint is a default, not a rule.

## Consequences

- `ResolvedHarness` has `tools` and `t3`; `offered` is only read from an older view. `extensionOf` answers an extension with tools from its tools.
- The Settings server gains `change_tools`; `change_extension` refuses a switch for an extension with tools.
- The t3-code card is empty until a thread's turn lists t3's tools, and shows the last thread's list: a tool t3 offers another thread only (`preview_*` with browser access off) can be missing from it, and takes the card's default.
