# CLI agents run through the platform's exec; Codex in managed mode, Claude and OpenCode over ACP

CLI agents cannot run in a Durable Object (workerd's `child_process` is a stub, and the Claude Agent SDK statically imports it). We implement t3's `ChildProcessSpawner` service as RPC to a `ProcessHost` on the Workspace DO, which uses `ctx.container.exec` (streaming stdin, separate stdout and stderr, an explicit env, PTY). The Workspace DO keeps the Container awake with an alarm while processes live, since processes inside don't count as activity. Readiness comes from the image's manifest: our driver registrations wrap upstream's and replace the probe, and a spawn outside a Workspace fails fast so probes never start a Container.

- **Codex** runs `app-server` over stdio in t3's managed mode, where it calls a token helper and never sees `auth.json`.
- **Claude** runs as `@agentclientprotocol/claude-agent-acp` with a pinned `claude` binary, through t3's ACP adapter. It loses fork, live steering, a structured plan and usage-limit classification compared with t3's native Claude adapter.
- **OpenCode** runs `opencode acp`.
- The **pi CLI** is skipped; Durable agents cover it.

All are pre-installed in one image shared with Durable agents. At most 3 Containers run at once, and a turn may run at most 2 hours.

## Considered Options

- **Our own supervisor daemon with output replay**: add behind the same interface only if DO resets mid-turn prove common.
- **Running the Claude SDK and a slice of t3's adapter in the Container**: remoting at the adapter boundary.
