# Step 4b: plan (CLI agents over ACP: Claude Code and OpenCode)

Date: 2026-11-12. Branch `step-4b`, from `origin/main` at b05e495. t3code pinned at `v0.1.9-nightly.20261111.4515`
(24e7747). Throwaway stage `step4b` (added to `STAGES` in `apps/environment/scripts/stage.ts` only when implementation
starts; prod is never deployed, run against or linked).

This is a plan to review, not a report; nothing in it is built. **Step 4b builds on step 4a**, which is being built now
on branch `step-4a` (plan: `docs/steps/step-4a-plan.md` on that branch, whose changelog F1–F10 and OD-3 override its
body and are assumed here). This branch **rebases on `step-4a` once 4a lands on `main`**; until then, 4b's stage work
runs on a branch cut from `step-4a`'s head (§8). Paths: `t3/` is `t3code/apps/server/src/`, `acp/` is
`t3code/packages/provider-acp/src/server/`, `reg/` is `t3code/packages/provider-acp-registry/src/server/`, `oc/` is
`t3code/packages/provider-opencode/src/server/`, `env/` is `apps/environment/src/`, `agents/` is `apps/agents/src/`.
Line numbers are from the pin and drift; the symbol beside each is the stable handle. "4a §x" and "4a Fn" refer to the
4a plan and its changelog.

## Changelog

None yet. Review findings and owner answers go here and override the body, as in 4a.

## Settled (not reopened here)

- **Every model call goes through the model proxy** (Commissary). Claude Code runs on Commissary's Anthropic Messages
  API with a proxy key, never a Claude subscription login; OpenCode likewise (ADR-0012). No vendor login is offered
  inside a Container, ACP's own "log in" auth methods included (ADR-0016).
- **The key reaches each CLI through an on-demand helper (A′)**, never the Container's environment or disk: 4a's
  `t3flare-model-key`, its route through computer's egress host, the Workspace DO's gate and the per-process nonce
  (4a §4.1, §4.2, F4). The key is 4a's `COMMISSARY_CONTAINER_API_KEY`; 4b adds no secret.
- **CLI agents get no t3 MCP tools yet** (4a OD-3): t3's `McpProviderSessions` is stubbed for these drivers too.
- **Vendor-login CLIs are refused** (D3). **Previews come last** (D4).
- 4a's channel, CLI homes on Container-local disk with only session state synced (F2), the scan before each pull (F3),
  one process per provider session (F1), the request allowlists (F5), byte frames and backpressure (F6), the hold
  (F7) and D1 for CLI processes (F8) are reused, not redesigned.

## Exit criterion, restated

`docs/plan.md`'s older wording for 4b was "Both run a turn with approvals; Claude on the Subscription login". ADR-0012
removed every Subscription login from t3flare, so the last clause becomes "Claude on the model proxy". The row already
reads "Both run a turn with approvals on a proxy model". In full:

> **On stage `step4b`, from the stock web client, a Claude Code thread and an OpenCode thread each run a turn on a model
> the proxy serves, in a Workspace's Container, in which a file edit and a command are each approved by the owner; a
> plan-mode turn of each edits nothing. Neither CLI is given, asks for or holds a vendor credential or login, neither
> calls a vendor host, every runtime mode fails closed, and no credential is on synced disk as far as 4a's
> in-Container scan before each pull can see.**

"Approved" means the CLI's own ACP `session/request_permission` reached t3 as a `permission` request that the client
answered, not an approval t3 or the CLI made by itself. "Fails closed" is defined in §5.1 and proved by M0 P4's matrix
and M5's hostile-repo case. "Calls a vendor host" and "on synced disk" are 4a §4.7 and §4.8's definitions, extended in
§4.5 and §4.6. Resume after Container sleep is in scope (M4) but is not part of the exit, as `docs/plan.md`'s row
does not ask for it.

## In one paragraph

Neither of t3's built-in drivers for these CLIs speaks ACP: t3's Claude provider runs the Claude Agent SDK inside t3's
server and spawns `claude` with Node's own `child_process`, and t3's OpenCode provider starts `opencode serve` on a
local port and talks HTTP and SSE to it. Both are out of reach from a Durable Object. ACP, t3's generic adapter for
agents that speak JSON-RPC over stdio (`@t3tools/provider-acp`), is: it spawns through `ChildProcessSpawner`, which
is exactly 4a's process channel. So 4b registers **two drivers of t3's own kinds (`claudeAgent` "Claude",
`opencode` "OpenCode") built on t3's ACP adapter** with flavors of ours, running `claude-agent-acp` (Zed's adapter
over the Claude Agent SDK, with the `claude` binary it drives) and `opencode acp` in the Workspace's Container. Each
CLI is pinned to the proxy and its key helper by **configuration a repository cannot override**: Claude Code's
managed settings (`apiKeyHelper`, the base URL, permission rules from managed settings only) and OpenCode's system
configuration and policies (one provider, no plugins or MCP servers of the repo's). Approvals are ACP permission
requests, and the rule that makes modes fail closed is that **the agent is always pinned to its asking mode and t3
decides**: t3's ACP permission policy auto-allows what the runtime mode allows and asks for the rest. ACP costs
parity against t3's native drivers (fork, live steering, subagents; usage-limit classification) and recovers the
structured plan for Claude; native drivers stay follow-ups.

## 1. What t3 does today, and the choice of ACP

### 1.1 Claude in t3: native, not ACP

- **Driver** `ClaudeDriver` (`t3/provider/Drivers/ClaudeDriver.ts`), kind `claudeAgent`, display "Claude". Its adapter
  is `createClaudeAdapterV2` (`t3/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, 12.5k lines) on
  `@anthropic-ai/claude-agent-sdk` `^0.3.321` (`query()`), in t3's own process.
- **Spawn.** `layerQueryRunner` (`ClaudeAdapterV2.ts:1149-1300`) gives the SDK a `spawnClaudeCodeProcess` that, unless
  the caller supplies one, calls `spawnClaudeProcessGroup` (`:374`): **`NodeChildProcess.spawn("/bin/sh", …)`**, Node's
  own `child_process`, not `ChildProcessSpawner`. Fork runs a Node "history worker" that reads Claude's session files
  from the local disk (`runClaudeWorker`, `:1102-1145`). Probes spawn `claude` for capabilities and usage.
- **In the cloud** the SDK is a generated throwing stub today (`apps/environment/build.ts` `DEPENDENCY_STUBS`: module-scope
  `randomUUID()`, which workerd refuses; fragility U9).
- What native gives that ACP does not: `canForkThread`, `supportsActiveSteering`, `emitsProposedPlan`, subagents,
  t3's MCP tools, usage-limit and reset classification (`claudeUsageLimits.ts`), usage meters, skills.

### 1.2 OpenCode in t3: an HTTP server, not ACP

- **Driver** `OpenCodeDriver` (`oc/driver.ts`), kind `opencode`, display "OpenCode". Two generations by the probed
  version: v1 (`opencode-ai`, `@opencode-ai/sdk`) and v2 (`@opencode/cli` from 2.2.5, `oc/v2/OpenCode2Server.ts`,
  `OpenCode2Client.ts`).
- **Spawn.** `OpenCodeRuntime.ts:513`: `opencode serve --hostname=127.0.0.1 --port=<free port>`, waits for "server
  listening on", then speaks HTTP and SSE to that port with a server password; the server's config comes through
  `OPENCODE_CONFIG_CONTENT` (`:58`, read from `process.env` as a fallback). A `serverUrl` setting connects to an
  existing server instead.
- 4a's channel carries stdin and stdout, not a TCP port. Running t3's native driver would need a second channel: HTTP
  and long-lived SSE from the Environment DO to a port in a Container, which ADR-0021 and the prod bug of 2026-11-11
  ("ReadableStream received over RPC disconnected prematurely") argue against.
- Native gives `canForkThread`, `supportsActiveSteering`, subagents and slash commands, which ACP does not.

### 1.3 ACP in t3

- `acp/adapter.ts` `makeAcpAdapterV2({ instanceId, flavor, selfInvocation, clientTerminals?, nativeLogging?,
  continuationRequests? })` is t3's generic ACP adapter. A **flavor** (`AcpAdapterV2Flavor`, `:298-552`) customises it:
  `makeRuntime`, `capabilities`, `sessionModeForPolicy`, `runtimeModeForSessionMode`, `permissionDisposition`,
  `approvalOptions`, `extractProposedPlanMarkdown`, `buildPrompt`, `promptFailure`, `requiresSignIn`, `resolveModelId`,
  `customModels`, `clientFileSystem` and more.
- `acp/AcpSessionRuntime.ts` `layer(options)` spawns the agent **through `ChildProcessSpawner`** (`:1452-1474`) and
  speaks newline-delimited JSON-RPC over stdio (`effect-acp`). This is the seam 4a's channel already implements, as for
  Codex `app-server` and `pi --mode rpc`.
- `reg/` is t3's "ACP Registry" driver (kind `acpRegistry`): it downloads registry agents, probes them by spawning, and
  special-cases Claude by the basename `claude-agent-acp` (`reg/adapter.ts` `isClaude`: `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`,
  `followAgentWorkState`, subagent extractors from `reg/claudeAcp.ts`). Neither `makeAcpRegistryAdapterV2` nor
  `claudeAcp.ts` is in that package's `exports`.
- The ACP registry today: `claude-acp` 0.106.0 (`claude-agent-acp` plus the `claude` it runs, built on
  `@anthropic-ai/claude-agent-sdk` 0.3.322, i.e. Claude Code 2.1.322) and `opencode` 2.2.7 (`opencode acp`).
- **ACP capabilities** (`AcpProviderCapabilitiesV2`, `acp/adapter.ts:657-720`): one provider thread per session
  (so 4a F1 holds by default), no fork, no active steering but steering by interrupt and restart, queued messages,
  rollback by t3 checkpoint, streamed tool output, todos, structured questions, `emitsProposedPlan: false`,
  `supportsMcpTools: false`, no runtime-mode switch in session (t3 restarts the agent on a mode change, as for pi).

### 1.4 The choice: ACP for both in 4b

ADR-0015 already chose ACP for both ("Claude runs as `@agentclientprotocol/claude-agent-acp` … OpenCode runs `opencode
acp`"); the code confirms it is the only path that reuses 4a's channel unchanged. What it costs, against t3's native
drivers, and what 4b claws back:

| | Native Claude | Claude over ACP (4b) | Native OpenCode | OpenCode over ACP (4b) |
|---|---|---|---|---|
| Fork | yes | **no** (t3's handoff fallback); `claude-agent-acp`'s ACP v2 has `session/fork`, a follow-up | yes | **no** (handoff) |
| Live steering | yes | interrupt and restart (`claude-agent-acp`: steering is ACP v1 only) | yes | interrupt and restart |
| Structured plan | yes | **yes, recovered**: our flavor reads `ExitPlanMode`'s plan (`extractProposedPlanMarkdown`) | no | no (todos only) |
| Subagents | yes | yes, as t3's registry flavor maps them (`claudeAcp.ts`) | yes | child sessions shown as tool calls |
| Usage-limit classification | yes | no in 4b (the proxy's 429 shows as the CLI reports it, retries held low), as 4a | yes | no in 4b |
| t3 MCP tools | yes | withheld (OD-3) | no | withheld |
| Rollback | yes | reported off by our wrapper in 4b (§3.3) | yes | off |

The two native drivers are **follow-ups with their own tickets**, not 4b: native Claude would put the real SDK in the
Environment Worker (a lazy import past the module-scope `randomUUID()`), restate `layerQueryRunner` with a
`spawnClaudeCodeProcess` over the channel, and replace the fork worker and the SDK's local-disk session reads; native
OpenCode needs an HTTP/SSE tunnel to a Container port. M0 P8 measures the first (half a day, time-boxed) so its ticket
starts from evidence. Owner confirmation of the parity cost is OD-1 (§12).

### 1.5 The latent leak in `AcpSessionRuntime`

`AcpSessionRuntime.ts:1410` and `:1427` build `{ ...process.env, ...options.spawn.env }`. Traced at the pin:

- `:1410` feeds `resolveLinuxCgroupTargetCommand`, a `PATH` lookup that runs only when a Linux cgroup lease exists
  (`ownDescendantProcessGroups` and platform `linux`). Our runtime options turn descendant ownership off
  (`ownDescendantProcessGroups: false`, `linuxCgroupController: null`), so it never runs.
- `:1427` is the env handed to `AgentScope.wrap`. In the cloud `HostProcess.Environment` has no `XDG_RUNTIME_DIR`, so
  `wrap` passes the command through unwrapped (4a §1.1) and that env is never used.
- The spawn itself (`:1452-1474`) sends `env: options.spawn.env` with `extendEnv: options.spawn.extendEnv ?? true`. On
  a laptop `extendEnv: true` is what merges t3's whole server environment into the agent's.

What reaches the CLI in t3flare is therefore only what 4a's spawner builds: **the profile's allowlist; t3's `env` and
`extendEnv` are read for named values and otherwise dropped** (4a §4.6). Three independent layers keep it that way: the
Workers' `nodejs_compat_do_not_populate_process_env` (the DO's `process.env` is empty; nothing in `env/` or `agents/`
writes it, checked at b05e495); our runtime options (`extendEnv: false`, no descendant ownership); and the spawner's
allowlist. Proof, not assertion: a Node test runs t3's real `AcpSessionRuntime.layer` against 4a's spawner with a
canary planted in `process.env` and in `spawn.env`, and asserts the launch carries neither; on the stage, a
stages-only fault route plants a canary in the Environment DO's `process.env` before a spawn, and the leak scan reads
`/proc/<pid>/environ` of `claude-agent-acp`, `claude` and `opencode` and finds exactly the profile's variable names
(M5).

## 2. On 4a's process channel

Nothing in the channel changes. 4b adds two CLI names to 4a's `CliName` (`env/agents/cliProfiles.ts`) and their routes:

- **Argv allowlist** (4a §2.1, F5's spirit). `claude-agent-acp` with no arguments; `opencode acp` exactly. Anything
  else (`--version`, `opencode serve`, `opencode auth login`, `opencode acp --login`, `claude …` directly) is refused
  with a clear error; our drivers send none of them. Same refusals as 4a for no cwd, a cwd outside a Workspace
  (scratch), and a fifth process.
- **Runtime options we pass** to `AcpSessionRuntime.layer` (our `flavor.makeRuntime`): `spawn: { command: <the CLI
  name>, args, cwd: runtimePolicy.cwd, env: {}, extendEnv: false, shell: false }`, `ownDetachedProcessGroup: true` (its
  stop then goes through 4a's `processGroup.ts` Shadow), `ownDescendantProcessGroups: false`, `linuxCgroupController:
  null`, `authenticateOnAuthRequired: false`, no `authMethodId`, `clientInfo` t3's. The adapter's `clientCapabilities`
  advertise no file system and no terminal (no `clientFileSystem` or `clientTerminals` in our flavors,
  `acp/adapter.ts:2368-2373`), so each agent reads, writes and runs commands **itself, in the Container**, and never
  asks the Environment DO to.
- **Two processes for Claude.** `claude-agent-acp` starts `claude` as its child; both carry `T3FLARE_EXEC` and share the
  launcher's session (`setsid --wait`), so 4a's marker kill takes both, and a `claude` orphaned by a killed adapter is
  found by the marker at the next open. P1 confirms the child keeps the marker (Claude Code's subprocess scrub, §4.1,
  must not strip it).
- **One ACP session per process.** `opencode acp` can serve many sessions, but t3's ACP adapter opens one process per
  provider session and reports `supportsMultipleProviderThreadsPerSession: false`; 4a's wrapper keeps that on the
  session entity too (F1).
- **The launcher** is 4a's: `/w/<id>` resolves to `/workspace/repo`, `cd` to t3's cwd, `ulimit -c 0`, `exec setsid
  --wait`. Profiles write their files before the exec (§4).

## 3. Driver registrations

Built like 4a's (`env/provider/cli/`), from t3's exported pieces, never t3's probing drivers, and listed in the
existing `builtInDrivers.ts` Shadow beside Pi Durable, Codex and Pi.

### 3.1 Kinds, snapshot and settings

- **Kinds**: t3's own `claudeAgent` (display "Claude") and `opencode` ("OpenCode"), so the stock clients' icons and names
  apply, and a later native driver keeps the same threads. The adapter under each is ACP, which the snapshot does not
  show; the clients read behaviour from the adapter's capabilities. (Rejected: kind `acpRegistry` with two instances:
  its settings form offers registry agent ids, downloads and a local command, all of which we refuse.)
- **Snapshot**: installed, version from the image manifest (§6), status `ready`, auth `authenticated` (the proxy is the
  account), models from the proxy's catalog (§3.4). `auto` dropped from `supportedRuntimeModes`, as 4a. No
  `snapshotForCwd` (no probe spawns in a project; slash commands and skills stay G10).
- **Settings**: t3's `ClaudeSettings` and `OpenCodeSettings` schemas, so the forms render. `binaryPath`, `homePath`,
  `launchArgs`, `customModels` (Claude) and `binaryPath`, `serverUrl`, `serverPassword`, `customModels` (OpenCode) are
  ignored, and the snapshot's message says so: a `serverUrl` must never make t3 connect anywhere. `textGenerators`
  stays locked (ADR-0023).
- **Text generation** for these threads (titles, commit and PR text) is the proxy's (`makePiDurableTextGeneration` with
  the thread's model), as 4a: no Container starts for a title.
- **Usage readers**: none.

### 3.2 The flavors

One module per CLI (`env/provider/cli/claudeFlavor.ts`, `opencodeFlavor.ts`), each an `AcpAdapterV2Flavor` passed to
`makeAcpAdapterV2` with `McpProviderSessions` stubbed (OD-3) and `selfInvocation` a constant (only t3's MCP bridge reads
it, and the stub leaves the bridge empty):

| Flavor field | Claude | OpenCode |
|---|---|---|
| `driver`, `capabilities` | `claudeAgent`; t3's ACP capabilities with `emitsProposedPlan: true` | `opencode`; t3's ACP capabilities |
| `makeRuntime` | §2's options, command `claude-agent-acp`, and `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1` in the profile (t3's registry flavor's choice) | §2's options, command `opencode`, args `["acp"]` |
| ACP-v2 work state, subagents | `followAgentWorkState: true` and `claudeAcp.ts`'s three extractors, imported by source path (not a package export; U-entry §13) | none |
| `sessionModeForPolicy` | always `default`; `plan` for a plan turn (§5) | always `build`; `plan` for a plan turn |
| `runtimeModeForSessionMode` | `default` → `approval-required`, `plan` → `approval-required`; every other mode → none, so t3 never applies it under a ceiling | `build`, `plan` → `approval-required`; others none |
| `permissionDisposition` | t3's `acpPermissionDisposition`, then our plan rule (§5.4) | same |
| `approvalOptions` | never offers an option that changes the agent's mode (§5.2) | `once` and `reject` only |
| `extractProposedPlanMarkdown` | `ExitPlanMode`'s `plan` input | none |
| `buildPrompt` | §3.5 | §3.5 |
| `resolveModelId` | the catalog id as is (§3.4) | `t3flare/<id>` |
| `requiresSignIn`, `promptFailure` | an ACP `auth_required` or a 401/403 is a failure naming `COMMISSARY_CONTAINER_API_KEY`, never a sign-in | same |
| `onUrlElicitation` | absent: URL elicitations (MCP OAuth) are declined | absent |

### 3.3 The wrapper

4a's `wrapper.ts` wraps both adapters unchanged in purpose: one process per session (F1), fork into another Workspace
refused, `supportsMcpTools: false`, the turn's state to the Workspace for the hold (F7), the 2 h cap, D1 (§5.6). For
4b it also:

- **strips native mode choices** from a turn's model selection: any option whose id is
  `ACP_SESSION_MODE_OPTION_ID` (`_t3/session-mode`) or whose category is `mode`, before the adapter applies it
  (`acp/adapter.ts:7302-7395` applies them unless a ceiling forbids; our snapshot never offers them, but a client or a
  link could send one);
- **reports `canRollbackThread: false`** in 4b. ACP rollback restores t3's checkpoint and opens a fresh agent session
  (`acp/adapter.ts:736`); restoring a checkpoint while a Container holds its own copy of the files is unproved in
  t3flare, and the Durable agents report it off too (parity G6). 4b follows whatever 4a's wrapper decides for Codex and
  Pi, and the decision is one line in the wrapper;
- **guards against mode drift** (§5.2).

### 3.4 Models

Both snapshots come from `environmentServices().catalog` (the proxy's `/v1/models`, 15 minutes), as 4a's do.

- **Claude**: the Claude family by default; the whole catalog if M0 P1 completes a tool turn on a GPT and a Gemini model
  through Claude Code and the proxy's translation (as 4a's P3 did for Codex). Thinking/effort options appear only for
  what `claude-agent-acp` advertises as an ACP config option and P1 maps (its option id and values are pinned by a
  test, U-entry). How `claude-agent-acp` accepts a catalog id under a custom base URL is P1's question; the order of
  fallbacks: the id is accepted as advertised once managed settings list the catalog (`availableModels`), or as one of
  the adapter's `customModels` (t3: "unadvertised model IDs … the agent validates them"), or set as the session's model
  through `_meta.claudeCode.options`. Claude Code's background model is pinned to the proxy's small Claude model
  (`ANTHROPIC_DEFAULT_HAIKU_MODEL`, the same id text generation uses).
- **OpenCode**: the whole catalog, as `t3flare/<real id>` in a provider of ours (§4.2), every model with the catalog's
  limits, as pi's `models.json` (4a §4.4). P2 checks a non-Claude model completes a tool turn.

### 3.5 Prompts and attachments

t3's ACP adapter inlines images it reads on the Environment side, but names every other attachment by its **path in
t3's State directory** (`providerMessageTextWithAttachmentPaths`, `acp/adapter.ts:7931`), which no Container can read.
Our `buildPrompt` follows SPI-993's rules for Durable agents: images inline (when the agent negotiated images), readable
text files as ACP `resource` blocks with their text, everything else named and not shown. A unit test pins it against
fixtures.

## 4. Credentials (A′)

### 4.1 Claude Code: `apiKeyHelper` in managed settings

Claude Code's documented hook is the `apiKeyHelper` setting (Claude Code docs, "Settings reference" → `apiKeyHelper`):
a shell command whose stdout Claude Code sends as **both** `X-Api-Key` and `Authorization: Bearer`; it caches the value
for `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` (default 5 minutes) and reruns it after a 401 or 403. In managed settings it
is "read from the highest-priority source only": a repository's `apiKeyHelper` is ignored when the managed file sets
one.

- **The managed file** `/etc/claude-code/managed-settings.json` is written by the profile on Container-local disk at each
  Claude spawn (not synced, not in the repo). Managed settings are the top of Claude Code's precedence; nothing in a
  repository's `.claude/` or `--settings` overrides a managed key. Its content (the full key list is fixed by M0 P1,
  P3 and P4 and pinned by a test):

  ```json
  { "apiKeyHelper": "/opt/t3flare/bin/t3flare-model-key claude",
    "env": { "ANTHROPIC_BASE_URL": "<MODEL_PROXY_URL>", "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<text generation's model>",
             "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
             "DISABLE_UPDATES": "1", "DISABLE_FEEDBACK_COMMAND": "1", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1",
             "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1", "CLAUDE_CODE_MAX_RETRIES": "1",
             "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1" },
    "skipWebFetchPreflight": true, "disableClaudeAiConnectors": true, "cleanupPeriodDays": 60,
    "permissions": { "defaultMode": "default", "disableBypassPermissionsMode": "disable", "allow": [], "ask": [] },
    "disableAutoMode": "disable", "allowManagedPermissionRulesOnly": true, "allowManagedHooksOnly": true,
    "allowManagedMcpServersOnly": true, "allowedMcpServers": [], "sandbox": { "enabled": false } }
  ```

- **`ANTHROPIC_BASE_URL` is pinned twice**, in the launch environment and in the managed `env`. A repository's
  `.claude/settings.json` can set `env.ANTHROPIC_BASE_URL` (it is not among the variables Claude Code ignores from
  project settings), and in SDK mode no trust prompt stands in the way; the managed value wins per variable. Without
  this, a cloned repo could send the helper's key to its own host. M0 P4 plants exactly that.
- **The launch environment** is 4a's allowlist plus `CLAUDE_CONFIG_DIR`, `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`,
  `CLAUDE_CODE_EXECUTABLE` (the npm install, §6), `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, and the managed `env`'s values
  again, so they hold before Claude Code reads its settings. A unit test pins it.
- **No login, ever.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are never set (`ANTHROPIC_AUTH_TOKEN` would stop
  the helper's 401 rerun). `CLAUDE_CONFIG_DIR` is a fresh local directory at each spawn, so no `.credentials.json`
  exists; ACP's login auth methods are never invoked (`authenticateOnAuthRequired: false`); an `auth_required` is a key
  failure (§3.2). P1's evidence: the first turn completes with no `authenticate` call and no login prompt on stderr.
- **The nonce.** 4a's helper sends `T3FLARE_MODEL_KEY_NONCE` from its environment. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`
  strips variables whose names look like credentials (`*KEY*`) from the environments of Claude's Bash commands, hooks
  and MCP servers, as Codex's `exclude` does (4a F4). P1 checks two things: a Bash command sees no nonce, and the
  helper, which Claude Code also runs, still does. If the scrub also strips it from the helper, the profile writes the
  nonce into the helper's command line in the managed file instead (`t3flare-model-key claude --nonce <n>`, a file the
  agent can read but a repo cannot set), and the grant count below is what bounds it.
- **Grants.** `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` is set to 24 h, so Claude Code asks at start and after a 401, not
  every 5 minutes. The route counts grants per Claude process as it does for Codex (4a's `CODEX_KEY_GRANTS`); the count
  is fixed from P1's measurement (each `claude` child `claude-agent-acp` starts asks once, and the adapter may restart
  it on a model change).

### 4.2 OpenCode: system configuration, one provider, and a key hook

OpenCode V2 reads `/etc/opencode/opencode.json(c)` (plus `agents/`, `commands/`, `skills/`, `plugins/` there) as
**system configuration, which outranks user and project configuration**, and its `policies` only ever tighten
(OpenCode docs, "Config" → Locations, "Policies"). The profile writes it at each OpenCode spawn on Container-local disk:

- **One provider.** `providers.t3flare = { name: "Model proxy", package: "@opencode/ai/providers/anthropic-compatible",
  settings: { baseURL: "<MODEL_PROXY_URL>/v1", headerTimeout, chunkTimeout }, models: { <catalog> } }`, and
  `policies: [{ provider.use * deny }, { provider.use t3flare allow }]`, so no catalog provider, environment variable,
  saved account or OpenCode's own free tier is usable. Anthropic Messages, as pi and the Durable agents use. Whether
  the base URL takes `/v1` is P2's to settle.
- **No repo code or servers.** `plugin.use` deny `*` (then allow our key plugin if §4.2's option (a) wins), `mcp.use`
  deny `*`, `skill.use` deny `*` for now (G10), `websearch.use` deny `*`, `integration.connect` deny `*` (no `/connect`).
  A repository's `.opencode/plugins/*.ts` would otherwise be loaded and run at startup with no approval (OpenCode
  docs, "Plugins" → Discover).
- **Quiet.** `update: "disable"`, `share: "disabled"`, `snapshot: false` (t3 has its own checkpoints), no LSP or
  formatter downloads, no models.dev catalog fetch: the exact keys and variables are P3's list.
- **The launch environment** is 4a's allowlist plus the `XDG_*_HOME` directories of §4.3 and P3's switches; never
  `OPENCODE_CONFIG_CONTENT` (t3's native runtime falls back to `process.env` for it, `OpenCodeRuntime.ts:58`; we do
  not use that runtime, and the spawner drops it if t3 ever sends it).

The key, which OpenCode can take from a stored login, an environment variable named in the provider's `env`, or
`settings.apiKey` with `{env:…}` or `{file:…}` substitution: none is acceptable under A′ (the environment and disk are
ruled out, and OpenCode has been seen writing substituted values back to its config file, anomalyco/opencode #9086).
Two candidates, settled by **M0 P2** in this order:

- **(a) A server plugin of ours** in `/etc/opencode/plugins/t3flare-key/`, image-baked, whose provider auth hook returns
  a `fetch` that runs `t3flare-model-key opencode` (cached in the process's memory until a 401) and sets `x-api-key`
  on each request to the proxy, and only to the proxy's host. At load it reads the nonce and deletes it from
  `process.env`, so the bash tool's children never see it. This is the shape OpenCode's own auth plugins use (an
  `auth.loader` returning `apiKey` and `fetch`); whether V2's plugin API still offers it is the probe's first question.
- **(b) A loopback key relay** if (a) does not hold: `t3flare-model-relay` (in the image, about 80 lines of Node), started
  by the launcher beside `opencode`, listening on `127.0.0.1:<port>`, which the provider's `baseURL` names. It asks the
  helper once, keeps the key in memory, adds `x-api-key`, and forwards to `MODEL_PROXY_URL` with streaming untouched.
  OpenCode itself never holds the key; any process in the Container can spend through the relay while it lives (the
  same exposure A′ accepts, without the key leaving). The relay dies with its OpenCode process (one session).

Either way: grants are counted per OpenCode process (one, plus a 401 rerun), the nonce never reaches OpenCode's shells,
and the provider names no key.

### 4.3 Where each CLI keeps state, and what is synced

All homes are 4a's: fresh at each spawn under `CLI_HOMES/<key>` on Container-local disk (F2); only session state is
linked into the synced harness directory `/workspace/.t3flare/`.

| | Claude Code (`CLAUDE_CONFIG_DIR=<home>/claude`, `HOME=/root`) | OpenCode (`XDG_*_HOME=<home>/…`) |
|---|---|---|
| Synced (resume) | `projects/` → `/workspace/.t3flare/claude/projects` (one JSONL per session, keyed by the cwd `/w/<id>`) | a snapshot of its session database in `/workspace/.t3flare/opencode/` (§7) |
| Container-local, fresh per spawn | `.claude.json` (global state, a random user id), `settings.json` (none written), `file-history/` (edit backups: code, not secrets), `shell-snapshots/`, `todos/`, `statsig/`, `plugins/` | data (the live database, `snapshot/`), config, cache (plugin and npm caches), state, logs |
| Never created | `.credentials.json` (no login), the repo's `.claude/settings.local.json` (`allowManagedPermissionRulesOnly` stops Claude saving rules) | `auth.json` (no `/connect`, `integration.connect` denied) |
| Image, not synced | `/etc/claude-code/managed-settings.json` (written per spawn) | `/etc/opencode/` (written per spawn; the key plugin is in the image) |
| Retention | `cleanupPeriodDays: 60` | the snapshot keeps the last 60 days of sessions (P5) |

### 4.4 A repository cannot redirect either CLI

A cloned repo is untrusted input. M0 P4 and M5's hostile-repo case plant, in the fixture:

- Claude: `.claude/settings.json` with `env.ANTHROPIC_BASE_URL` (a logging host), `apiKeyHelper`, `permissions.allow:
  ["Bash(*)", "Edit"]`, `defaultMode: "bypassPermissions"`, a `SessionStart` hook, `sandbox` with auto-allow; a
  `.mcp.json` with `enableAllProjectMcpServers`; `.claude/settings.local.json` with allow rules.
- OpenCode: `opencode.json` and `.opencode/opencode.json` with a provider `baseURL`, `permission: { "*": "allow" }`,
  a primary agent and a subagent with `allow` permissions, `.opencode/plugins/x.ts` that writes a marker file at load,
  an MCP server.

Pass: every write and every non-read command still asks at `approval-required`, the marker file does not exist, the
logging host saw nothing, and the proxy answered every model call.

### 4.5 "No credential on synced disk": what 4b adds

4a's definition and proof (4a §4.7 and F3: the scan before each pull, quarantine, kill, `ulimit -c 0`; the DO-side scan
as a second line) apply unchanged, with these additions:

- **Paths**: the synced `claude/projects/` and `opencode/` under `/workspace/.t3flare/`, the CLI homes, `/etc/claude-code`,
  `/etc/opencode`, and `/proc/*/environ` and `/proc/*/cmdline` of `claude-agent-acp`, `claude`, `opencode` and the
  relay if any.
- **The helper's output in transcripts**: Claude's JSONL and OpenCode's database snapshot contain no grant output (by
  the DO-side scan of the synced copy).
- **The canary** of §1.5 is absent from every process's environment.
- `acceptance.ts --claude`/`--opencode` call 4a's `/_t3flare/check/leak` after a real turn, after a resume and after a
  link-started turn.

### 4.6 "Calls no vendor host": hosts to turn off

4a's definition (the proxy's host and `computer.internal` only; the agent's own commands are its work) and proof (the
CONNECT logger on test stages, P10's default-then-configured run) apply. The hosts each CLI is documented to contact,
and how 4b turns each off; P3 records what each actually contacts with defaults and with the profile:

| CLI | Host | Purpose | Off by |
|---|---|---|---|
| Claude Code | `api.anthropic.com` | model calls (moved to the proxy), feature flags, telemetry events, the fast-mode check, WebFetch's domain preflight | `ANTHROPIC_BASE_URL`; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`; `skipWebFetchPreflight` (not covered by the non-essential switch) |
| | `http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com` | operational telemetry, error reports | `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` |
| | `downloads.claude.ai`, `storage.googleapis.com` | auto-update, plugin downloads | `DISABLE_UPDATES`; no plugins |
| | `claude.ai`, `platform.claude.com` | sign-in, token refresh | never reached: no login |
| | `mcp-proxy.anthropic.com` | claude.ai MCP connectors | `disableClaudeAiConnectors` |
| | `registry.npmjs.org` | official marketplace auto-install | `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` |
| OpenCode | `models.dev` | the model catalog | P3 names the switch; our provider lists its models itself |
| | `opencode.ai`, `*.opencode.ai` | update checks, share, the Console and free tier | `update: "disable"`, `share: "disabled"`, `provider.use` and `integration.*` policies |
| | `registry.npmjs.org`, GitHub | plugin installs, LSP and formatter downloads | `plugin.use` deny, LSP and formatter downloads off (P3) |

`WebFetch`, `WebSearch` (Claude) and OpenCode's web fetch reach what the agent asks for, which is the agent's work, and
ask first at `approval-required` like any tool.

### 4.7 Residual risk

As 4a §4.9: any process that can run the helper while the CLI lives can get the key (OpenCode's relay variant: can
spend through it). 4b's narrowing is the nonce kept out of shells (Claude's scrub; OpenCode's plugin deleting it or the
relay holding the key), the grant counts, the key's own scope and spend limit (4a's owner action), and the scan.
Because the Container's agent runs as root, it can rewrite `/etc/claude-code` and `/etc/opencode`; those files defend
against a repository's configuration, not against an agent already running commands, which A′ accepted.

## 5. Sandboxing, approvals and modes

### 5.1 The rule: the agent always asks, t3 decides

An ACP agent asks (`session/request_permission`) only when its own mode says to. t3's ACP adapter then applies
`acpPermissionDisposition` (`acp/clientPolicy.ts`): reads never ask; `approval-required` asks for everything else;
`auto-accept-edits` allows edits whose every path is inside the cwd and asks for the rest; `full-access` allows all.
An agent in a mode that does not ask (Claude's `acceptEdits`, `dontAsk` or `bypassPermissions`; an OpenCode agent with
`allow` rules) never reaches t3 at all. So:

- **Each agent is pinned to its asking mode** by our flavor (`sessionModeForPolicy`: Claude `default`, OpenCode `build`
  whose permissions are all `ask` except reads), whatever the runtime mode; **t3's disposition implements the runtime
  mode**. `full-access` is t3 auto-allowing each request, never the agent's bypass (Claude Code refuses
  `bypassPermissions` as root anyway, and the managed file disables it).
- **Native modes are never applied from outside**: not offered in the snapshot, stripped from model selections (§3.3),
  and `runtimeModeForSessionMode` places none of them under a ceiling.
- **Mode drift fails closed.** If the agent reports a mode change (`current_mode_update`) to anything but the pinned
  mode, the wrapper sets the pinned mode back before answering any further request; if that set fails, it interrupts
  the turn and ends the session with "the agent left its approval mode". This catches Claude's `ExitPlanMode` "auto-
  accept edits" choice and a model that switches its own mode.
- **Fail closed on the unknown**: `auto` and unknown runtime modes run as `approval-required` (4a's modefix); a request
  with an unknown tool kind asks; a permission request whose options include none of `allow_once`/`reject_once` is
  rejected.

| Runtime mode | What the agent asks (pinned) | t3's answer |
|---|---|---|
| `approval-required` | every edit, every command not known read-only | asks the owner |
| `auto-accept-edits` | same | edits inside the cwd allowed (lexical containment, below); commands ask |
| `full-access` | same | allowed |
| plan (interaction mode) | Claude `plan` mode, OpenCode `plan` agent | edits and deletes **denied**; commands ask; reads allowed |
| `auto`, unknown | as `approval-required` | as `approval-required` |

`clientPolicy.ts` resolves containment with `NodeFS.realpathSync` on the **Environment DO's** file system (the State
directory alias), where `/w/<id>/…` does not exist, so it falls back to lexical containment from the nearest existing
ancestor. That still answers "inside the cwd" for every path the agent names; it cannot see a symlink in the repo that
points outside, which then writes inside the Container only. A unit test pins the lexical behaviour against the alias;
P6 runs it in workerd.

### 5.2 Claude Code specifics

- The managed file (§4.1) pins `defaultMode: "default"`, disables bypass and auto modes, takes **permission rules from
  managed settings only** (a repo's `allow: ["Bash(*)"]` and `.claude/settings.local.json` are ignored, the "always
  allow" choices disappear from prompts, and Claude Code saves no rule into the repo), runs **managed hooks only**,
  allows **no MCP server**, and keeps Claude's own bash sandbox off: with it on, `autoAllowBashIfSandboxed` would run
  commands without asking t3. (Claude's sandbox uses bubblewrap, which works in a Cloudflare Container per 4a's stage
  P2; using it for `auto-accept-edits` is a follow-up.)
- "Accept for the session" in t3 picks `allow_always` when offered and `allow_once` otherwise
  (`selectPermissionOptionId`); with managed-only rules Claude offers no `allow_always`, so the session acceptance lives
  in t3, not in a file. P4 confirms.
- `ExitPlanMode` asks to leave plan mode with options that set the next mode. Our `approvalOptions` never offers the
  ones that pick `acceptEdits` or `bypassPermissions`; the drift guard is the backstop.
- Claude Code reads the repo's `CLAUDE.md` and `.claude/agents/`, `.claude/commands/`: instructions and prompts, which
  steer the model but not its permissions. Kept, as on a laptop.

### 5.3 OpenCode specifics

- `/etc/opencode/opencode.json` sets the permissions of the `build` and `plan` agents and of every subagent:
  `"*": "ask"`, reads (`read`, `glob`, `grep`, `list`) `allow`, `external_directory: "ask"`; `plan` with `edit: "deny"`.
  System configuration outranks a repo's, but a repo can add agents: `tool.use` policies deny launching any subagent
  the image does not define (`subagent:*` deny, then allow `general` and `explore`), and the mode option never selects
  a repo's primary agent (§3.3).
- OpenCode offers `once`, `always`, `reject`; `always` would be remembered by OpenCode for the session's later calls.
  Our `approvalOptions` offers `once` and `reject` only, so t3's "accept for session" is t3's own memory. P4 confirms
  what `always` persists and where.

### 5.4 Plan mode

- **Claude**: t3 switches the session to the agent's `plan` mode for a plan turn (`acp/adapter.ts:7413-7430`), Claude
  Code makes edits impossible there, and our flavor turns `ExitPlanMode`'s plan into t3's **proposed plan**
  (`emitsProposedPlan: true`; the plan toggle shows). Defence in depth: in plan, the flavor's disposition denies any
  `edit`, `delete` or `move` request.
- **OpenCode**: the `plan` agent with `edit: "deny"`, the same disposition rule; no proposed plan (todos only): the
  plan arrives as the agent's text, and the toggle follows t3's OpenCode presentation, which M3 records.
- A link-started plan turn (F6's `T3-Mode-Limit`) gets the same rules.

### 5.5 Approval plumbing over the channel

Each permission request is a JSON-RPC request from the agent on stdout, through the channel to t3, and the answer goes
back on stdin; t3's ACP adapter already holds the request until the client answers. Approvals do not survive an
Environment restart (`pendingRequestsSurviveRestart: false`, `approvalCallbacksAreLiveOnly: true`): the old process is
killed by the epoch rule (4a §2.6) and the continuation asks again. M2 measures the round trip of an auto-allowed
request at `full-access` (each tool call pays one; target under 300 ms p95 warm).

### 5.6 D1: every push from linked work asks while the process lives

Exactly 4a F8: a linked thread (`linkOrigin`) on Claude or OpenCode holds linked work under `cli:<thread>` in its
Workspace **while that thread's process lives**, released by marker when it ends; the credential helper's push then
asks through `EnvironmentDO.approveLinkedPush`, and 4a's wrapper raises a `permission` request (kind `git-push`, never
accepted for the session) injected into the ACP adapter's event stream and answered through its `respondToRequest`.
ACP gives this one extra wrinkle: the wrapper's request ids must not collide with the adapter's own pending ACP
requests, so they carry a `t3flare:` prefix and the wrapper answers them before delegating. If M5 finds t3 will not
take an injected request beside the agent's own, the fallback is 4a's: refuse linked pushes from these CLIs, reported
with a ticket.

## 6. The image

| | Claude Code | OpenCode |
|---|---|---|
| What | `@agentclientprotocol/claude-agent-acp` **0.106.0** (ACP registry `claude-acp`), with `@anthropic-ai/claude-agent-sdk` 0.3.322, i.e. Claude Code **2.1.322** | `opencode` **2.2.7** (ACP registry `opencode`) |
| How | Default: `npm ci --omit=dev --ignore-scripts` from a committed lock in `apps/sandbox-image/image/cli/` (beside 4a's pi), run by the image's Node, with `claude` from the SDK's platform package (`CLAUDE_CODE_EXECUTABLE` names it). Fallback: the release tarball `claude-agent-acp-linux-x64.tar.gz` (sha256 `7d27db34…7c6e`), which holds both binaries | the release tarball `opencode-linux-x64.tar.gz` (sha256 `89a6cee2…1ee`), checked in its own stage, as 4a does for Codex |
| Size (uncompressed) | tarball: `claude-agent-acp` 112 MB + `claude` 342 MB; npm: the JS adapter (a few MB) + the same `claude` | 259 MB |
| t3's manifest at the pin | `claudeAgent`: `>=2.1.280` supported | `opencode`: `>=2.0.18` supported |

- **The manifest** `apps/sandbox-image/src/clis.ts` gains `claude` and `opencode`; 4a's tests cover them: the Dockerfile's
  `ARG`s equal it, and the pins satisfy t3's compatibility manifest for the kinds we register (a nightly that raises a
  minimum fails with "bump the CLI in `clis.ts`"). The managed files and plugin are in the image; versions change only
  with a commit and a deploy (ADR-0024).
- **Size and cold start.** About +0.6 to +0.7 GB uncompressed on top of 4a's CLIs (about +330 MB compressed). Each CLI
  is its own layer after 4a's, so a bump rebuilds one. M0 P7 measures the image, the cold build and the first command's
  cold start (17–18 s before 4a); a cold start over 30 s is OD-2 (§12).
- **Memory.** `claude` (Bun) plus its Node adapter, or `opencode` (Bun): a few hundred MB each at idle, more during a
  turn. 4a's per-Workspace cap derived from its P9 becomes a **weight** per CLI from P7's numbers, so a Workspace can
  hold, say, one Claude and one Codex but not four Claudes; the bar stays 4a's (p95 peak under 2.4 GiB, 4a's OD-1
  otherwise, shared).
- **Licence.** Claude Code is Anthropic's proprietary software, used here under the owner's own Anthropic terms in the
  owner's private image (not redistributed); its use through a gateway with an API key is a documented configuration.

## 7. Lifetime and resume

4a §2.5–§2.8 and F7 apply unchanged (hold, idle release, heartbeat lapse, backstop, 2 h cap, the restart table, sync
before capture and stop).

- **Claude** resumes by ACP: t3 keeps the session id as the native thread id and reopens with `resumeSessionId`
  (`session/load`, or `session/resume` on ACP v2). Claude Code finds the session's JSONL under
  `projects/<encoded /w/<id>>/` in the synced directory; the cwd string is the same in every Container (4a's launcher).
  P5 cuts the last line in half and resumes, as 4a's P8 did.
- **OpenCode** keeps sessions in a SQLite database. A live database under computer's sync could be pulled torn (the
  database and its WAL at different moments), so the live one stays Container-local and the profile keeps a
  **snapshot**: after each turn ends (the wrapper's turn-end, which already reaches the Workspace for the hold), the
  Workspace DO runs `sqlite3 <db> "VACUUM INTO '<synced>/.opencode.db.tmp'"` and renames it into
  `/workspace/.t3flare/opencode/opencode.db`; a spawn copies the snapshot in before `opencode` starts. P5 proves
  `session/load` from a snapshot in a fresh data directory. If it cannot, OpenCode resumes by t3's handoff after a
  Container sleep, recorded as a parity P row.

## 8. Milestones, riskiest first

Each milestone is demoable on the throwaway stage `step4b` (never prod), has exit evidence in `docs/steps/step-4b/`
(the scripts' JSON and screenshots), lands with its tests, and keeps `bun run check` green at its head.

**Dependencies on 4a.** M0 needs nothing of 4a's code: its probes run in local Docker with 4a's probe harness
(`docs/steps/step-4a/probes/`: the `computer.internal` key sidecar, the CONNECT logger, an `--internal` network) and,
for P4, t3's Node server with a `docker exec -i` spawner (4a's P7 pattern); P6 is a build. M1 onward need 4a's M1
(channel, `ProcessHost`, `processGroup.ts` Shadow) and M2 (image CLI layer, profiles, key route and gate, `clis.ts`);
M5 needs 4a's M6 (leak scan, egress logger, D1 for CLIs, acceptance flags). **Before 4a merges**, 4b's code lives on a
branch cut from `step-4a`'s head and is rebased as 4a moves; stage `step4b` deploys that branch. **Nothing of 4b reaches
`main` before 4a's M6 has**, and this branch rebases on `main` once 4a lands.

### M0. Probes (local Docker first, then `step4b` where the platform matters)

| # | Probe | Where | Settles | Stop gate |
|---|---|---|---|---|
| P1 | Claude Code on Commissary through `claude-agent-acp`: starts with **no login prompt** and no `authenticate`; the managed `apiKeyHelper` and base URL; Commissary accepts Claude Code's requests (`anthropic-beta` headers, else `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`); a tool turn (Edit, Bash, thinking) on `claude-sonnet-5-5`, then on a GPT and a Gemini model; how a catalog id is selected (§3.4); helper runs per process and per restart; the scrub hides the nonce from Bash and not from the helper; the `claude` child keeps `T3FLARE_EXEC` | local Docker, real proxy | §3.4, §4.1 | no Claude model completes a tool turn → OD-3 |
| P2 | OpenCode on Commissary through `opencode acp`: the `t3flare` provider (Anthropic Messages, the base URL's `/v1`), the key hook (a) then (b), nonce hidden from bash, a tool turn on a Claude and a non-Claude model, `session/set_config_option` with `t3flare/<id>` | local Docker | §3.4, §4.2 | neither (a) nor (b) works → re-plan §4.2 before M1 (no owner decision: the relay is ours) |
| P3 | Egress: each CLI under the CONNECT logger with defaults, then with the profiles; WebFetch with and without the preflight switch; OpenCode's catalog, update, LSP and plugin downloads | local Docker | §4.6 | a vendor call no setting removes → named, blocked by proxying it to a refusing logger, raised with the owner |
| P4 | Permissions, through **t3's real ACP adapter** and our flavors (t3's Node server, `docker exec -i` spawner): runtime mode × interaction mode × tool kind for both CLIs; `ExitPlanMode`'s options and the drift guard; what `allow_always`/`always` persists; the hostile repo of §4.4 | local Docker | §5 | any case that runs an edit or a command at `approval-required` without asking → fix before M2 (fail closed), no exceptions |
| P5 | State and resume: Claude from a fresh `CLAUDE_CONFIG_DIR` with only `projects/` linked and a torn last line; OpenCode from a `VACUUM INTO` snapshot in a fresh data directory | local Docker; then `step4b` on computer's mount | §7 | OpenCode cannot resume from a snapshot → handoff fallback (§7) |
| P6 | The environment Worker with `@t3tools/provider-acp` and `effect-acp` imported (by 4a's drivers' route): build, deploy, the twice-in-one-isolate boot check, heap after boot, bundle size; `clientPolicy`'s `realpathSync` on the State-directory alias | `step4b` | §3, §5.1 | a module refuses to load in workerd → a counted Build shim or Shadow |
| P7 | Image and memory: both CLIs installed (npm and tarball variants for Claude), image size, cold build, first-command cold start; RSS of each CLI idle and during a turn that runs `npm ci && npm test` on the fixture | local, then `step4b` | §6 | cold start over 30 s → OD-2; peak over 2.4 GiB → 4a's OD-1 |
| P8 | Time-boxed (half a day), informs a follow-up only: the real Claude Agent SDK lazily imported in workerd, a `query()` whose `spawnClaudeCodeProcess` returns a Node-stream process over a fake channel | `step4b` | §1.4's follow-up ticket | none |

Exit: `docs/steps/step-4b/m0-*.json`, one per probe, and the plan's open choices (§3.4's model selection, §4.1's nonce,
§4.2's key hook, §4.6's switches, §6's install) closed in this plan's changelog.

### M1. Image, profiles and the key for both CLIs

Scope: §6 (installs, manifest, layers), the two profiles (argv allowlist, env allowlist, managed files, OpenCode's
system configuration, the key plugin or relay), 4a's key route extended to `cli=claude` and `cli=opencode` with their
grant counts, `docs/model-proxy.md`'s "CLI agents" section extended.

Demo on `step4b`: 4a's `POST /_t3flare/agents/cli-smoke` (stages only) gains both CLIs: through the channel and without
t3's drivers, `claude-agent-acp` (`initialize`, `session/new`, one prompt answering "ok") and `opencode acp` (the same)
on proxy models; the route answering 403 with no CLI alive; the Container half of the leak scan and the egress log.

Evidence: `m1-image.json` (sizes, build time, cold start), `m1-cli-smoke.json` (answers, grants, `/proc` scan, hosts).

Tests: profile snapshots (argv refusals, env allowlist, the managed JSON, OpenCode's system configuration from a catalog
fixture with Claude, GPT and unknown-vendor models); the gate's counts; the manifest tests; **Docker tests with the real
CLIs** in `bun run test:docker` (4a's harness: a scripted fake proxy for the Messages API, a stub `computer.internal`):
each CLI starts with its profile, completes a scripted tool turn over ACP, asks for permission when it should, and
leaves no key in its files or `/proc`; the hostile-repo fixture.

### M2. Claude Code in t3

Scope: §3 for Claude (driver, snapshot, flavor, wrapper additions, attachments), §5.1, §5.2, §5.4, text generation, the
2 h cap.

Demo from the stock web client on `step4b`, in `ian-pascoe/t3flare-fixture`: a Claude thread at `approval-required` on a
proxy Claude model edits a file and runs `bash test.sh`, each approved in the client; the diff; a plan-mode turn shows a
proposed plan and edits nothing; the same thread at `auto-accept-edits` edits without asking and asks for the command;
at `full-access` nothing asks; an image attachment and a text file reach the agent.

Evidence: `m2-claude-turn.json` (items, both approvals, checkpoint diff), `m2-modes.json` (every row of §5.1's table,
the drift guard tripped by a scripted mode change), `m2-latency.json` (approval round trips), `m2-*.png`.

Tests: the flavor (mode pinning, drift, plan disposition, option stripping, `approvalOptions`, sign-in refused, model
id), the snapshot (models, no `auto`, version, ignored settings), `buildPrompt`, the §1.5 canary test with t3's real
`AcpSessionRuntime`, and t3's ACP adapter in Node against a **recorded `claude-agent-acp` transcript** replayed through
our spawner (t3 records ACP replay fixtures this way, `t3code/apps/server/scripts/record-*-acp-replay-fixture.ts`). Acceptance gains
`--claude`.

### M3. OpenCode in t3

Scope: §3 for OpenCode, §5.3, §5.4.

Demo from the stock web client: an OpenCode thread at `approval-required` on a proxy Claude model and on a non-Claude
model, the same edit and `bash test.sh` with both approvals and the diff; `full-access` runs without asks; a plan turn
edits nothing; a subagent the repo defines is refused, `general` runs.

Evidence: `m3-opencode-turn.json`, `m3-modes.json`, `m3-*.png`.

Tests: as M2 for OpenCode, with a recorded `opencode acp` transcript. Acceptance gains `--opencode`.

### M4. Lifetime and resume

Scope: §7 end to end, on 4a's lifetime machinery.

Demo on `step4b` (4a's `scripts/cli-lifetime.ts` extended): a Claude turn in project A and an OpenCode turn in project
B overlap (two leases); turn 1 sets a code word, both Containers stop, turn 2 recalls it with the **same native id**
(Claude session id; OpenCode session id); an Environment restart mid-turn (the old epoch's processes, `claude` children
included, are gone before the new spawn; the continuation completes); a Workspace DO abort mid-turn (`runtime_error`,
then resume).

Evidence: `m4-two-at-once.json`, `m4-resume.json`, `m4-restarts.json`, `m4-holds.json` (memory and hold times for the
weights of §6).

Tests: the OpenCode snapshot hook (Node, fake exec): taken after a turn ends, never during one, copied in before spawn;
the epoch kill reaching a child process.

### M5. Proofs, D1, acceptance and documents

Scope: §4.4–§4.6 on the stage, §1.5's canary, §5.6, the bump's flags, the documents of §11, the owner's desktop demo.

Demo on `step4b`: `acceptance.ts --real-turn --claude --opencode --peer` pass; the hostile-repo fixture (a branch of
`t3flare-fixture`) runs a turn on each CLI and every write and command asks, no marker file, the logging host silent; a
link-started Claude task's `git push` asks on its thread and runs after approval, and a second push asks again; the leak
check reports zero with the canary planted; the egress log shows only the proxy's host. The owner's desktop app runs one
Claude and one OpenCode turn with an approval each.

Evidence: `m5-acceptance.json`, `m5-hostile-repo.json`, `m5-leak.json`, `m5-egress.json`, `m5-linked-push.json`,
`m5-desktop-*.png`, and the bump job's run on the branch (`gh workflow run bump.yml --ref step-4b`) with the new flags.

## 9. Tests

| Kind | What |
|---|---|
| Unit (Vitest, Node) | both flavors (mode pinning, drift guard, plan disposition, native-option stripping, approval options, sign-in refused, model ids, `buildPrompt`), both snapshots, both profiles (argv and env allowlists, the managed JSON, OpenCode's system configuration and policies), the key gate's counts for `claude`/`opencode`, the key plugin or relay (header only to the proxy's host, key never logged), the OpenCode snapshot hook, the §1.5 canary through t3's real `AcpSessionRuntime`, `clientPolicy`'s lexical containment on the alias, the manifest against the Dockerfile and t3's compatibility manifest |
| Node with t3's adapter | t3's ACP adapter through our flavors and spawner against recorded `claude-agent-acp` and `opencode acp` transcripts: approvals, plan, proposed plan, resume, a mode drift |
| Node with real CLIs in Docker | `bun run test:docker`: both CLIs with their profiles, a scripted fake proxy and a stub `computer.internal`: a tool turn each over ACP with a permission request, resume after `docker restart` with the synced directory as a volume, the hostile repo, no key on disk or in `/proc`, egress only to the fake proxy |
| Deployed acceptance | `acceptance.ts --claude`: clone the fixture, a Claude turn at `approval-required` with an edit and `bash test.sh` approved, the diff, a plan turn that edits nothing, the Container stopped, a second turn that recalls the first, the leak check, the egress log (test stages), the key route refused with no CLI alive. `--opencode`: the same for OpenCode on a Claude and a non-Claude model. `--peer` gains a linked Claude task's asking push |
| Nightly bump | `acceptance --real-turn --terminal --worktree --peer --codex --pi --claude --opencode` on the bump stage, `test:docker`, and the compatibility test |

## 10. Risks and unknowns

| # | Risk | Settled by | If it goes wrong |
|---|---|---|---|
| R1 | Commissary refuses Claude Code's requests (beta headers, the Bearer it also sends, its model ids) | P1 | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`; a fix in Commissary (OD-3) |
| R2 | `claude-agent-acp` will not take a catalog model id under a custom base URL | P1 | `availableModels`, `customModels`, `_meta` (§3.4); the Claude family by alias only as a last resort |
| R3 | OpenCode V2 has no plugin hook for the key | P2 | the loopback relay (§4.2 (b)) |
| R4 | An agent stops asking (a native mode, a repo's rules, an `always` approval, a repo-defined agent) and t3 never sees the request | P4, M5 hostile repo, drift guard | the guard ends the session; a failing P4 case blocks M2 |
| R5 | The scrub hides the nonce from Claude's helper too | P1 | the nonce in the managed helper command plus the grant count |
| R6 | The image grows ~0.7 GB and cold starts slow | P7 | OD-2 |
| R7 | Two CLI processes per Claude session (adapter and `claude`) leave an orphan | P1, M4 (epoch kill reaches the child) | marker kill by session; the orphan sweep at open |
| R8 | OpenCode's database cannot be resumed from a snapshot | P5 | handoff after a Container sleep, a parity P row |
| R9 | `provider-acp` and `effect-acp` do not bundle or boot in workerd | P6 | a counted shim or Shadow |
| R10 | An approval round trip per tool call makes `full-access` slow | M2's latency | batch nothing (correctness first); report, and consider Claude's bwrap sandbox for `auto-accept-edits` as a follow-up |
| R11 | t3 cannot take an injected request beside the agent's own (D1) | M5 | refuse linked pushes from these CLIs, as 4a's fallback |
| R12 | t3 or the CLIs move: the ACP adapter's flavor and options, `claudeAcp.ts`, mode and option ids, managed-settings keys, OpenCode's configuration and policies | bump's typecheck, `test:docker`, `--claude`/`--opencode` | §13's entries |
| R13 | Claude Code's 429 handling retries into spend | `CLAUDE_CODE_MAX_RETRIES=1`, OpenCode's retry setting (P2) | report; the follow-up shared with 4a turns the proxy's 429 into t3's usage limit for CLIs |
| R14 | 4a changes under 4b while both are in flight | the rebase rule (§8) | 4b adapts; 4a's changelog is the contract |

## 11. Documents

- **ADR-0015** refinement: t3's Claude and OpenCode drivers are not ACP (native SDK; `opencode serve` over HTTP); 4b
  registers t3's kinds over t3's ACP adapter; the parity table of §1.4; the fail-closed rule of §5.1; the native drivers
  as considered options with P8's evidence; the image pins.
- **ADR-0016** refinement: A′ for Claude Code (managed `apiKeyHelper`, the base URL pinned in managed `env`) and
  OpenCode (the plugin or the relay, system configuration and policies), with M0 and M5 evidence; the sentence "OpenCode
  and pi have no such hook that is known yet" closed.
- **ADR-0001** counts (expected unchanged by 4b: no Patch, no Shadow beyond 4a's; P6 may add one).
- `docs/parity.md`: "Claude, OpenCode" → W with the ACP differences (fork M→handoff, live steering P, rollback M,
  usage-limit classification M, OpenCode plan P); provider settings for CLIs P; G13 note (registry agents still M).
- `docs/upstream-fragility.md`: the entries of §13, and the bump table's rows for the new flags.
- `docs/model-proxy.md` (Claude Code and OpenCode on the Messages API, the key's scope), `docs/cost.md` (the larger
  image, CLI weights), `README.md` (status), `GLOSSARY.md` (**ACP flavor**, **Managed settings** as used here).
- `docs/steps/step-4b.md`: the report. `docs/plan.md`: the 4b row's exit as restated above.

## 12. Owner decisions and actions

Decisions (rare; two of three only if a probe says so):

- **OD-1 (confirm).** Ship Claude Code and OpenCode over ACP with §1.4's parity cost (no fork, steering by restart, no
  usage-limit classification for either; no structured plan for OpenCode; rollback off), and track native drivers as
  follow-up tickets. ADR-0015 already chose ACP; this confirms the cost now that t3's native drivers are known to be
  richer. Recommended: confirm.
- **OD-2 (only if P7 fails).** If the image with both CLIs cold-starts over 30 s: accept it, or ship one of the two CLIs
  per image variant later. Recommended: accept up to 45 s and measure in use; the Container stays warm while a CLI
  lives.
- **OD-3 (only if P1 fails).** If Commissary cannot serve Claude Code's requests: fix it in Commissary (the owner's
  project) before M2, or ship Claude Code limited to what works. Recommended: fix in Commissary.

Actions:

1. Confirm `COMMISSARY_CONTAINER_API_KEY`'s scope (4a's action 1) allows the Anthropic Messages API for every catalog
   model: Claude Code and OpenCode use it as pi does.
2. One session at the desktop near the end of M5 (a Claude and an OpenCode turn with an approval each), or let the
   agent drive the desktop app as in step 3.

## 13. Upstream fragility, new entries

Numbered after 4a's at merge (`main` already uses U28 for T3 Connect, so 4a's own numbers move too).

- **ACP flavors on t3's ACP adapter.** Our flavors call `makeAcpAdapterV2` and `AcpSessionRuntime.layer` by their
  option names (`sessionModeForPolicy`, `runtimeModeForSessionMode`, `permissionDisposition`, `approvalOptions`,
  `extractProposedPlanMarkdown`, `buildPrompt`, `ownDescendantProcessGroups`, `linuxCgroupController`,
  `authenticateOnAuthRequired`, `extendEnv`), strip `ACP_SESSION_MODE_OPTION_ID`, rely on `acpPermissionDisposition`,
  and import `reg/claudeAcp.ts` by source path. Breaks on a renamed option (typecheck) or a changed default (silent:
  e.g. a new client capability on by default). Detection: typecheck, the replay tests, `--claude`/`--opencode`, P4's
  matrix kept as a Docker test.
- **t3's kinds over a different adapter.** `claudeAgent` and `opencode` registered with ACP adapters and t3's settings
  schemas. Breaks when a client assumes the native adapter behind a kind (Claude-only UI, OpenCode's server settings).
  Detection: silent for client UI; the desktop demo; cheapest check: grep `t3code/apps/web` for kind switches at each
  bump (as U22).
- **The CLIs' configuration surfaces.** Claude Code's managed-settings keys and variables, `claude-agent-acp`'s mode ids,
  option ids, `ExitPlanMode` shape and `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2`; OpenCode's system configuration, policies,
  plugin API and ACP option ids. They move with the versions in `clis.ts`: re-run `test:docker`, P3's egress check and
  P4's matrix on every CLI bump.
- **CLI versions against t3's compatibility manifest** for `claudeAgent` and `opencode`: 4a's test, two more rows.
