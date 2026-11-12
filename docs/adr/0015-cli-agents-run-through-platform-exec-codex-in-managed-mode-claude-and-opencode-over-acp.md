# CLI agents run through the platform's exec; Codex on the model proxy, Claude and OpenCode over ACP

(The file name keeps the original title's "managed mode"; the 2026-11-11 refinement below replaced it.)

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

## Refinement (step 4a, 2026-11-12): the process channel as built

Codex and the pi CLI run as built in step 4a (`docs/steps/step-4a.md`); Claude Code and OpenCode are step 4b.

- **The channel.** t3's `ChildProcessSpawner` (the process router) answers `codex app-server` and `pi --mode rpc …` spawned in a Workspace by starting them in that Workspace's Container (`WorkspaceDO.processStart`, `agents/src/workspace/processHost.ts`) under the platform's non-PTY `exec`, and hands t3 a streaming handle (`apps/environment/src/agents/processChannel.ts`). Bytes end to end; stdin numbered without gaps, one write in flight, retried but never skipped; a spawn resolves once the process runs, so a cold start is spent before t3's `initialize`.
- **Pulled, not pushed.** The Environment reads output with a long poll per Workspace (`processRead`, also the processes' heartbeat), with a batch kept until acknowledged. A push (the Workspace calling the Environment, as terminals do, ADR-0021) nested one level deeper per request-response round trip, because each side answered inside the other's call, and hit the platform's "Subrequest depth limit exceeded" at the eighth round trip on step4a. A CLI is driven by its own output (request, response, next request); a terminal is driven by a person, so terminals keep the push.
- **Epochs** are durable boot counters (the Environment DO's and the Workspace DO's). A start from another Environment epoch first kills every process of that Workspace started under a different one; processes an earlier Workspace instance started are killed when the Environment heartbeats a key the new instance does not hold, and from the alarm. Stubs to a Workspace DO are made fresh for every call: a stub to an object that reset stays broken.
- **Lifetime.** A process holds its Container while its thread is in a turn and for 11 minutes after; t3's own idle release ends the session at 10 minutes (Patch 0003, all providers). A stop ends the CLI processes first (they flush their session files), then pulls. When the Container budget is full, a start asks the holders to stop a Container where nothing works (idle CLI sessions included). At most 4 CLI processes per Workspace (an idle Codex app-server is about 160 MB). The Environment's own idle reset (60 s without a client, ADR-0003) ends idle CLI processes at the Workspace's 90 s lapse; the next turn resumes the native thread in a new process.
- **Readiness wrappers.** Codex and Pi are registered by t3flare's drivers (`provider/cli/`) built from t3's `makeCodexAdapterV2` and `makePiAdapterV2`: the image's versions (`apps/sandbox-image/src/clis.ts`, checked against t3's compatibility manifest), the proxy's catalog, no spawning probe, text generation through the proxy, t3's MCP credential withheld (OD-3), and a wrapper that reports `supportsMultipleProviderThreadsPerSession: false` (one process per session, so per Workspace) and refuses forks into another Workspace.
- **Mode table** (M0 P2: bubblewrap works in Cloudflare Containers, probed at each start): Codex's per-turn policy comes from t3flare's guard: approval-required `untrusted` + read-only, auto-accept-edits `on-request` + workspace-write, full access `never`; `auto`, unknown and plan run as approval-required, plan declines file changes; without a sandbox everything but full access is `untrusted` with full access. The process default is `on-request` + read-only (Codex 0.167.2 refuses `untrusted` at process level). pi's permission extension is t3's own, required, copied into the process's home, and its mode always set (never the extension's full-access default); a plan turn on pi is refused.
- Shadows 2 (`builtInDrivers`, `processGroup`), Patches 3, a new Build shim exception (pi's extension source is skipped by the `node:fs` alias: its imports are text).

## Refinement (step 4b, 2026-11-12): Claude Code and OpenCode over t3's ACP adapter

Built in step 4b (`docs/steps/step-4b.md`); owner decision OD-1 confirmed shipping over ACP, with ACP flavor parity as SPI-1037.

- **Neither of t3's drivers for these CLIs speaks ACP.** t3's Claude provider runs the Claude Agent SDK in t3's process and spawns `claude` with Node's own `child_process`; t3's OpenCode provider runs `opencode serve` and talks HTTP and SSE to a local port. Both are out of reach from a Durable Object. t3flare registers **t3's own kinds** (`claudeAgent` "Claude", `opencode` "OpenCode") built on t3's generic ACP adapter (`makeAcpAdapterV2`) with flavors of ours (`apps/environment/src/provider/cli/acpDriver.ts`, `acpFlavor.ts`), spawning `claude-agent-acp` (0.106.0, Claude Code 2.1.322) and `opencode acp` (2.2.7) through 4a's process channel. The native drivers stay considered options: native Claude would put the SDK in the Worker and restate its spawn and fork worker; native OpenCode needs an HTTP/SSE tunnel to a Container port.
- **Every mode fails closed: the agent always asks, t3 decides.** Claude is pinned to `default`, OpenCode to its `build` agent; t3flare's disposition answers what they ask: reads allowed; `approval-required` asks; `auto-accept-edits` allows an edit only when every location it names is inside the thread's cwd and outside `.git/`, `.claude/`, `.opencode/` (t3's own rule had no containment without a sandbox policy, review F2); `full-access` allows; a plan turn denies edits and Claude's request to leave plan mode; `auto` and unknown modes ask. The approval card never offers "for the session" (it would pick the agent's own "always": a saved rule, or an auto mode). A session whose agent offers `auto` or `bypassPermissions`, or moves to a mode we did not pin, is ended with a named failure.
- **Claude's plan** becomes t3's proposed plan when Claude asks to leave plan mode (captured from the `ExitPlanMode` request, which is then denied, review F1); OpenCode's plan arrives as text and todos.
- **Repositories cannot redirect or loosen them.** Claude Code's managed settings (`/etc/claude-code`, installed per spawn by the image's launcher) pin the endpoint (`allowedProviders: ["customEndpoint"]`, the proxy URL, the proxy, CA, provider and auth variables pinned empty), managed permission rules, hooks and MCP servers only, no marketplaces, no skill shell execution, no repo hooks, MCP or agents. OpenCode's system configuration (`/etc/opencode`) has one provider and deny-by-default policies (providers, plugins, MCP, skills, web search, `/connect`, any subagent but `general` and `explore`), with every agent's rules asking. A hostile fixture (M0 P4 locally, M5 on stage) changed nothing.
- **Parity cost** (OD-1, `docs/parity.md`): no fork (both CLIs answer `session/fork`; SPI-1037), steering by interrupt and restart, rollback off, OpenCode without a structured plan; the proxy's 429 is t3's usage limit through the flavor's prompt failure. Idle compaction is not started (it would send `/compact` turns to `claudeAgent`); `/goal` reaches Claude, which declines it under managed hooks.
- Shadows unchanged (2: `builtInDrivers` now registers four CLI drivers, `processGroup`), Patches unchanged (3).
