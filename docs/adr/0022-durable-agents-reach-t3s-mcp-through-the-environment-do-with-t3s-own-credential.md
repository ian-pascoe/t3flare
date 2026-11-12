# Durable agents reach t3's MCP through the Environment DO with t3's own provider-session credential, and no part of it enters a Container

A Durable agent uses t3's MCP tools (`delegate_task`, `t3_thread_*`, `t3_project_*`, pull requests, …) as t3's own Pi
provider does, but the call never leaves the platform's private paths. t3 issues each provider session a per-thread
credential (`McpProviderSessions`); the adapter reads it at every open and turn and hands it to the Session DO, which
keeps it in its own storage. The Session calls t3's `/mcp` through a Durable Object RPC on the Environment DO
(`EnvironmentDO.mcp`), which builds the request and hands it to t3's HTTP app, so t3's own auth, tool access, link fence
and mode ceiling run unchanged. The tools reach the agent as one pi-durable extension, `t3-mcp`, built from the catalog
t3 lists for that credential and installed again when its hash changes (cloudpid's ADR-0030), under t3's own names
(`mcp__t3-code__<tool>`), so t3's clients present them as they present its Pi provider's.

## Considered options

- **The public `/mcp` from the Session.** Works (the credential is a bearer), but sends a 24-hour credential over the
  public host, through the WAF, DNS and TLS, for a call between two objects of one deploy. Rejected.
- **A static catalog bundled from t3's toolkits.** No list call, but the catalog depends on the caller (capabilities,
  `hiddenFromSubagents`, `hiddenWhileLinksOff`, a link's fence) and on the pin; a static copy drifts silently. Rejected.
- **The credential in the Container, as t3's Pi puts `T3_MCP_BEARER_TOKEN` in pi's environment.** Every process the agent
  starts could read and reuse it. Rejected (ADR-0016's rule extended to t3's own credential).

## Consequences

- **The allowlist fails closed** (41 tools at the pin; replaced by a short denylist, owner 2026-11-12, back to stock: see the last refinement). Not offered: `request_secret` and `t3_attachment_*` (their
  purpose is a secret or an upload URL for a shell), `preview_*`, `html_*`, `device_*` (no browser or device), the link
  tools `t3_environment_link`/`unlink` (cloud-to-elsewhere links are deferred, ADR-0011), `t3_worktree_*`,
  `t3_environment_preferences_update`. A tool t3 adds later is not offered until a bump adds it.
- **Approvals as t3's Pi bridge decides:** a tool t3 annotates read-only never asks, nothing asks in full access,
  otherwise the call asks as a `permission` request. "Accept for the session" covers that tool by name only, never
  `bash` or another T3 tool (the `mcp-tool` approval kind). In plan mode only read-only tools run. t3's annotations are
  what they are: `t3_thread_read` and `task_status` are not read-only there, so they ask.
- **Replay:** a call cut off by a Session restart runs again. A tool that takes `clientRequestId` gets one from its task
  id, so the rerun is t3's same durable work. t3 scopes that key by provider session, so a rerun under a credential t3
  issued again is refused rather than repeated; any other state-changing call is not run again once started.
- **Waits** (`t3_thread_wait`, `t3_background_wait`) go to t3 in pieces of at most 50 s, each marked as progress, so no
  RPC is held for long and the Environment's idle check sees each piece as a request.
- A 401 (the Environment restarted, the session was released) is a tool error the model sees; the next turn brings a
  fresh credential. t3's orchestration instructions are a prompt section while the tools are installed.
- **The credential is never in a push, a snapshot, `/_t3flare/agents/session`, a Workspace or a Container.** The step 3
  leak check reads all of them for it, and for every other secret the Environment holds.
- `EnvironmentDO.mcp` boots t3 the way a Session push does: from the stored public host, never a made-up request's.

## Refinement (SPI-1004): what the allowlist withholds are parity refusals

**Superseded** by the back-to-stock refinement below (owner, 2026-11-12, back to stock).

The tools listed above as not offered are refusals by design, not omissions:
- `request_secret`: a credential typed into t3 (owner decision D5, ADR-0012's refinement).
- `t3_attachment_*`: an upload URL for a shell. Attachments reach a Durable agent through its prompt instead (SPI-993).
- `preview_*`, `html_*`, `device_*`: host-bound or not built yet (ADR-0024; previews come with SPI-1002).
- The link tools: cloud-to-elsewhere links (ADR-0011).

A bump that adds a tool leaves it withheld until it is classified here and in `T3_TOOL_ALLOWLIST`.

## Refinement (tools step, SPI-1039): CLI agents get t3's MCP as stock t3 hands it

A CLI agent gets t3's own MCP config: t3's per-thread bearer, at t3's public `/mcp` (owner, 2026-11-12, back to stock). t3 names its in-isolate address, which a Container cannot reach, so `relayedMcp.ts` rewrites only the endpoint (to `https://<T3FLARE_HOST>/mcp`). Codex's guard admits t3's entry only as an https `/mcp` with one `Authorization` header; pi's profile passes `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` only for an https `/mcp`; Claude Code admits that URL beside the relay's, and its t3 tools are not pre-allowed (Claude asks, through t3's card). The CLI sees t3's full tool list, as in stock t3; `T3_TOOL_ALLOWLIST` and the guidance filter apply to Durable agents only.

This sets aside this ADR's rule for CLI agents: t3's bearer is in the CLI's Container, and root there can read it. It reaches t3's tools for that thread until the thread's MCP session is cleared. t3's own auth, Link fence and mode ceiling run unchanged, and F7 holds: no agent answers a card (`m2-h6-proof.json`).

First built (and removed, owner, 2026-11-12, back to stock): a relay at `computer.internal/t3flare/mcp/t3` that swapped a per-process handle for t3's bearer in the Environment, applied the allowlist, the guidance filter and per-call linked asks, and refused an owner handle outright while the Workspace was tainted (review H1). Evidence after the cut: `m5-cli-{codex,claude,opencode,pi}.json` (`t3_thread_list`).

## Refinement (back to stock, owner 2026-11-12): a short denylist; `request_secret` offered

Owner, 2026-11-12, back to stock (scope audit rows 7 and 12). A Durable agent is offered every tool t3 lists for its
thread, as stock t3 offers it, but those that cannot work here (`T3_TOOL_DENYLIST`, `packages/harness-registry/src/t3Tools.ts`):
- `t3_attachment_*` and `t3_thread_send_attachments`: an upload URL for a shell, and sending what was uploaded.
  Attachments reach a Durable agent through its prompt (SPI-993).
- `html_*`, `preview_*`, `t3_preview_*`: headless Chromium on the host (`serverBrowser` stripped, ADR-0023).
- `device_*`: host-bound, locked off (ADR-0023).
- `t3_worktree_*`: its git is not routed through the process router yet.
- `t3_environment_link`/`unlink`: until SPI-1061 M1, with `peerLinks.ts`'s Layers (left to SPI-1061).

`request_secret` and `t3_environment_preferences_update` are offered again (D5 lifted, ADR-0012). A tool a nightly adds
is offered at once, as in stock t3. t3's guidance and the offered tools' descriptions are filtered only by the denylist:
a bullet or sentence naming a denied tool is dropped, everything else is t3's own text (U49). The classification test
is now "every denied name is still a real t3 tool" (`apps/environment/test/t3Guidance.test.ts`).

Known gap: `request_secret`'s `delivery: "file"` writes the value into t3's State directory, on the Environment, which
an agent's commands in a Container cannot read; `secretRef` and pasted values work as stock. SPI-1088.

