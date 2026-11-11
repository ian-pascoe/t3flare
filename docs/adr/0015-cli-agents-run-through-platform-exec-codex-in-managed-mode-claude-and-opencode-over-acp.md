# CLI agents run through the platform's exec; Codex in managed mode, Claude and OpenCode over ACP

CLI agents cannot run in a Durable Object (workerd's `child_process` is a stub, and the Claude Agent SDK statically imports it). We implement t3's `ChildProcessSpawner` service as RPC to a `ProcessHost` on the Workspace DO, which uses `ctx.container.exec` (streaming stdin, separate stdout and stderr, an explicit env, PTY). The Workspace DO keeps the Container awake with an alarm while processes live, since processes inside don't count as activity. Readiness comes from the image's manifest: our driver registrations wrap upstream's and replace the probe, and a spawn outside a Workspace fails fast so probes never start a Container.

- **Codex** runs `app-server` over stdio in t3's managed mode, where it calls a token helper and never sees `auth.json`.
- **Claude** runs as `@agentclientprotocol/claude-agent-acp` with a pinned `claude` binary, through t3's ACP adapter. It loses fork, live steering, a structured plan and usage-limit classification compared with t3's native Claude adapter.
- **OpenCode** runs `opencode acp`.
- The **pi CLI** is skipped; Durable agents cover it.

All are pre-installed in one image shared with Durable agents. At most 3 Containers run at once, and a turn may run at most 2 hours.

## Refinement (2026-11-11): every CLI on the model proxy, and the pi CLI added

After [ADR-0012](0012-all-model-access-goes-through-the-model-proxy.md), no CLI uses a vendor sign-in:

- **Codex** runs `app-server` with a model provider whose `base_url` is the proxy's (Commissary serves the OpenAI Responses API), not in managed mode against OpenAI. t3's managed mode shows the shape: a `model_providers` entry with `wire_api = "responses"` and an `auth` command (`CodexManagedRuntime.ts`).
- **Claude Code** and **OpenCode** use the proxy through their own base-URL settings.
- The **pi CLI** is no longer skipped. It runs through t3's built-in Pi provider (`packages/provider-pi`), shown as "Pi", with a pi `models.json` that names the proxy. That provider spawns `pi --mode rpc` through `ChildProcessSpawner` and speaks JSON lines over stdio, as Codex's `app-server` does, so it shares Codex's process channel (step 4a). It is a CLI agent, distinct from the Durable agent provider, which t3 shows as "Pi Durable" (driver kind `piDurable`).

How the proxy key reaches each CLI is open ([ADR-0016](0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)).

## Considered Options

- **Our own supervisor daemon with output replay**: add behind the same interface only if DO resets mid-turn prove common.
- **Running the Claude SDK and a slice of t3's adapter in the Container**: remoting at the adapter boundary.

## Refinement (SPI-1004): vendor-login CLIs are refused (owner decision D3)

Stock t3 also drives CLIs that sign in to their vendor and reach no model through a base URL of the owner's choosing: Cursor, Antigravity, Kiro, Muse, Grok and Fx. Under ADR-0012 every model call goes through the model proxy, and none of these can be pointed at it. They are **refused**: they are not in the Workspace image, and t3flare registers no driver for them (`shadows/builtInDrivers.ts`), so t3 lists no such provider. The CLI agents are Codex, Claude Code, OpenCode and pi, as above. A vendor that later supports a custom base URL is a new decision, not a gap.
