# MCP tools reach agents through the Environment's MCP host

Status: accepted (tools step, 2026-11-12). Plan: [`docs/steps/tools-plan.md`](../steps/tools-plan.md) §3–§5, with its review changelog (H1–H3, M1, M3, M5, M7, M9–M13). Tickets: SPI-1001 (MCP part), SPI-1039.

Agents in t3flare had t3's own tools and nothing else. The owner wants Commissary's tools, and servers he adds himself such as Executor, for every agent kind, without a third-party server's credential ever reaching an agent, a Session or a Container.

1. **One MCP host, in the Environment DO.** It holds:
   - the **MCP server set**: Commissary's endpoint, plus **direct servers** added in the harness panel (ADR-0026);
   - their inventory, each server's tools listed and cached for 10 minutes, capped at 200 tools and 256 KiB of schemas per server;
   - their credentials.

   Every MCP request goes through it.
2. **The engine is a Worker of its own**, `t3flare-mcp-<stage>`. It runs cloudpid's MCP core (`vendor/cloudpid/mcp`, official SDK 2.4.0) behind two entrypoints, `McpEngine` and `McpOAuth`. It has **no bindings** and `global_fetch_strictly_public`, and it makes every outbound MCP and OAuth request: discovery, registration, token exchange, refresh, list and call. Each request goes through a guard on every URL and hop, with `redirect: "manual"`. Its logs pass through cloudpid's `scrub.ts`. The Environment DO calls it over service bindings and sends the credential with each request; the engine keeps none.
3. **Commissary's key** is the Workers-only `MODEL_PROXY_API_KEY`, read through `toolsKeyOf(env)` so a dedicated key can replace it. It never enters a Container (owner decision; no new secret). A **direct server** signs in with a header the owner types once, or with OAuth that he completes in the panel (DCR or CIMD, PKCE, single-use `state`, an `iss` check, one refresh in flight). Its credentials are kept write-only in the Environment DO's secret store (ADR-0012's tools refinement).
4. **A tool's class is read or write**: the tool's own `readOnlyHint` (true is read; anything else, write), as t3 does, unless the owner overrides it in the panel. Colliding sanitised names are refused. "Accept for the session" covers one tool definition (its hash): a changed definition asks again.
5. **One decision for every caller** (`decideCall`):
   - a read runs;
   - a write is refused in plan mode;
   - otherwise a write runs in full access or after "accept for the session", and asks in any other mode.

   A linked thread follows its own mode and sees every enabled server, as any thread does.
6. **Durable agents** get MCP tools from the Session's `mcp` extension, namespaced `mcp__<server>__<tool>`. They are deferred by default (reached by `tool_search` or from a code mode script, ADR-0027). A server removed or disabled mid-turn answers a tool error, and its tools are gone at the next turn.
7. **CLI agents** get one entry per server at `http://computer.internal/t3flare/mcp/<server>`, the **MCP relay**. `WorkspaceProxy` hands each request to `EnvironmentDO.mcpRelay`, where an MCP server of ours ends the protocol and calls through the same host.
   - The CLI authenticates with a **tool handle**: a per-process bearer that the Workspace DO issues at spawn and revokes at exit. It never sits in a Container-wide file (review H2).
   - The relay decides by the calling thread's own mode.
   - A write that asks raises t3's card on the CLI thread's live turn. The CLI wrapper injects the card (U37's mechanism), and it never offers "trust this Workspace again" (review M9).
   - CLI tool timeouts are 900 s, so a 10-minute approval fits (review M11).
8. **t3's own tools for CLI agents** come as stock t3 hands them: t3's per-thread MCP bearer, given to the CLI, at t3's public `/mcp` (t3 names its in-isolate address, which a Container cannot reach, so only the endpoint is rewritten; SPI-1039, ADR-0022's tools refinement). The relay's handles stay for third-party servers, whose credentials are real secrets.
9. **Not offered:**
   - **Local stdio servers** are refused (ADR-0024's table): Container-only, with no secrets, and served over HTTP instead.
   - **Elicitation is not declared** by any t3flare client (OD-T7: later, under cloudpid ADR-0041's rules).
   - **MCP resources, prompts and apps** are not offered.
   - **Executor** is added directly, in `browser` elicitation mode, so the agent never holds the approval. The owner chose direct over Commissary. `skills`, `search` and `describe` carry read hints; the owner marks `resume` read; `call` and `execute` are write.

## Considered options

- **The engine inside the Environment Worker.** Rejected: the SDK's heap and outbound fetches would share the isolate that holds t3, and outbound requests would need bindings-free isolation anyway (review M5, cloudpid's ADR-0038).
- **Commissary only** (Route A). Rejected: there is no upstream elicitation, no resources, a 240 s cap per call, and a dependency on Commissary being up. Commissary stays the recommended route for servers it fronts well.
- **The CLIs reach Commissary or the server directly with a key.** Rejected: a key in a Container (ADR-0016).
- **Pinned classes** (review H3, built first): a class pinned by definition hash, a direct server's tools write until marked read, a flipped hint write until confirmed. Removed (owner, 2026-11-12, back to stock). On stage the pin also misfired: Executor's `resume`, marked read, fell back to write after a relist (`m6-executor.json`).
- **Linked writes asked every call** (owner decision 3, review M1/M10/M13, built first): every linked write asked, the "offered to linked threads" switch, and a tainted Workspace judged as linked. Removed (owner, 2026-11-12, back to stock).
- **The strictest mode across the Workspace** (review M7, built first). Removed (owner, 2026-11-12, back to stock).
- **t3's tools through the relay with handles** (`/t3flare/mcp/t3`, SPI-1039 as first built: t3's bearer swapped in the Environment, an allowlist, and a tainted owner handle refused, review H1). Removed (owner, 2026-11-12, back to stock).

## Consequences

- One more Worker per stage (ADR-0014's tools refinement).
- Per-server credentials now live in t3flare: an MCP-only exception to D5 (ADR-0012).
- A tool's class trusts the server's hint. A server that lies about `readOnlyHint` gets its write run without a card in modes that run reads; the owner's override is the remedy. Cards show the full arguments.
- A linked thread at full access runs MCP writes without a card, as its link allows (t3's Link fence still bounds the link's mode).
- t3's per-thread MCP bearer is in a CLI's Container, as in stock t3 (ADR-0022's tools refinement): root in the Container can read it, and it reaches t3's tools for that thread until the thread's session ends.
- Root in a Container can read another process's relay handle through `/proc`. A stolen handle is judged as its own thread (`m5-relay-hostile.json`, recorded before the back-to-stock cut).
- The pi CLI gets t3's tools only. It has no MCP client of its own in the image, so Commissary and direct servers do not reach it yet (deferred).

## Back to stock (owner, 2026-11-12)

The owner chose to stay close to stock t3 (`docs/scope-audit.md`). Removed, each "owner, 2026-11-12, back to stock":

1. Linked threads and MCP: the per-call rule for linked writes, the "offered to linked threads" switch, judging a tainted Workspace as linked, and the strictest-mode rule (M7). Linked threads follow their own mode and see every enabled server.
2. t3's tools for CLI agents: `mcp/t3Relay.ts`, the handle swap and the tainted-owner-handle refusal (H1). The CLI gets t3's per-thread bearer, as stock t3 hands it, at t3's public `/mcp`. The relay with per-process handles stays for Commissary and direct servers.
3. Tool classes: definition-hash pins and write-until-marked for direct servers. Each tool's `readOnlyHint` is trusted, and the owner can override a class in the panel.

Rerun on stage after the cut: the panel at its new path (`m3-panel-safety.json`), each CLI's relay and t3 tools with t3's bearer, with a prompt-injection case (`m5-cli-*.json`), a Durable direct-server read and write (`m6-direct-durable.json`), and prompt injection on linked threads (`m5-injection.json`).
