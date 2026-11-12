# MCP tools reach agents through the Environment's MCP host

Status: accepted (tools step, 2026-11-12). Plan: [`docs/steps/tools-plan.md`](../steps/tools-plan.md) §3–§5, with its review changelog (H1–H3, M1, M3, M5, M7, M9–M13). Tickets: SPI-1001 (MCP part), SPI-1039.

Agents in t3flare had t3's own tools and nothing else. The owner wants Commissary's tools, and servers he adds himself such as Executor, for every agent kind, without a credential ever reaching an agent, a Session or a Container.

1. **One MCP host, in the Environment DO.** It holds:
   - the **MCP server set**: Commissary's endpoint, plus **direct servers** added in the harness panel (ADR-0026);
   - their inventory, each server's tools listed and cached for 10 minutes, capped at 200 tools and 256 KiB of schemas per server;
   - their credentials.

   Every MCP request goes through it.
2. **The engine is a Worker of its own**, `t3flare-mcp-<stage>`. It runs cloudpid's MCP core (`vendor/cloudpid/mcp`, official SDK 2.4.0) behind two entrypoints, `McpEngine` and `McpOAuth`. It has **no bindings** and `global_fetch_strictly_public`, and it makes every outbound MCP and OAuth request: discovery, registration, token exchange, refresh, list and call. Each request goes through a guard on every URL and hop, with `redirect: "manual"`. Its logs pass through cloudpid's `scrub.ts`. The Environment DO calls it over service bindings and sends the credential with each request; the engine keeps none.
3. **Commissary's key** is the Workers-only `MODEL_PROXY_API_KEY`, read through `toolsKeyOf(env)` so a dedicated key can replace it. It never enters a Container (owner decision; no new secret). A **direct server** signs in with a header the owner types once, or with OAuth that he completes in the panel (DCR or CIMD, PKCE, single-use `state`, an `iss` check, one refresh in flight). Its credentials are kept write-only in the Environment DO's secret store (ADR-0012's tools refinement).
4. **A tool's class is read or write.** It is pinned per (server, upstream name, definition hash) (review H3):
   - A direct server's tools are all **write** until the owner marks one read; its hint is shown only as a suggestion.
   - Commissary's tools take their first-seen hint.
   - A changed definition, or a hint that flips from write to read, stays write until the owner confirms it.
   - Colliding sanitised names are refused.
5. **One decision for every caller** (`decideCall`):
   - a read runs;
   - a write is refused in plan mode;
   - a **linked** caller's write asks, for that call only, in every mode, full access included (owner decision 3, D1's rule; checked before any session acceptance);
   - otherwise a write runs in full access or after "accept for the session", and asks in any other mode.

   Every server has a switch, "offered to linked threads", which is off by default (review M13).
6. **Durable agents** get MCP tools from the Session's `mcp` extension, namespaced `mcp__<server>__<tool>`. They are deferred by default (reached by `tool_search` or from a code mode script, ADR-0027). A server removed or disabled mid-turn answers a tool error, and its tools are gone at the next turn.
7. **CLI agents** get one entry per server at `http://computer.internal/t3flare/mcp/<server>`, the **MCP relay**. `WorkspaceProxy` hands each request to `EnvironmentDO.mcpRelay`, where an MCP server of ours ends the protocol and calls through the same host.
   - The CLI authenticates with a **tool handle**: a per-process bearer that the Workspace DO issues at spawn and revokes at exit. It never sits in a Container-wide file (review H2).
   - The relay decides with the **strictest** mode among the Workspace's live agent threads (review M7).
   - While the Workspace carries linked work's taint, every write from it asks (review H1).
   - A write that asks raises t3's card on the CLI thread's live turn. The CLI wrapper injects the card (U37's mechanism) with a per-call flag, and it never offers "trust this Workspace again" (review M9).
   - CLI tool timeouts are 900 s, so a 10-minute approval fits (review M11).
8. **t3's own tools for CLI agents** take the same relay at `/t3flare/mcp/t3` (SPI-1039, ADR-0022's tools refinement).
9. **Not offered:**
   - **Local stdio servers** are refused (ADR-0024's table): Container-only, with no secrets, and served over HTTP instead.
   - **Elicitation is not declared** by any t3flare client (OD-T7: later, under cloudpid ADR-0041's rules).
   - **MCP resources, prompts and apps** are not offered.
   - **Executor** is added directly, in `browser` elicitation mode, so the agent never holds the approval. The owner chose direct over Commissary. Its `skills`, `search`, `describe` and `resume` are marked read, and `call` and `execute` write.

## Considered options

- **The engine inside the Environment Worker.** Rejected: the SDK's heap and outbound fetches would share the isolate that holds t3, and outbound requests would need bindings-free isolation anyway (review M5, cloudpid's ADR-0038).
- **Commissary only** (Route A). Rejected: there is no upstream elicitation, no resources, a 240 s cap per call, and a dependency on Commissary being up. Commissary stays the recommended route for servers it fronts well.
- **The CLIs reach Commissary or the server directly with a key.** Rejected: a key in a Container (ADR-0016).
- **Hints as classes.** Rejected: upstream annotations are untrusted (Commissary's ADR-0038).
- **Write tools dropped for linked callers.** Rejected (review M1): every linked write asks instead.

## Consequences

- One more Worker per stage (ADR-0014's tools refinement).
- Per-server credentials now live in t3flare: an MCP-only exception to D5 (ADR-0012).
- Linked writes ask every call, which is approval fatigue by decision. Cards show the full arguments.
- Root in a Container can read another process's handle through `/proc`. A stolen handle is judged as its own thread, and while the Workspace is tainted it asks per call, while t3's own tools refuse it outright (`m5-relay-hostile.json`).
- The pi CLI gets t3's tools only. It has no MCP client of its own in the image, so Commissary and direct servers do not reach it yet (deferred).
