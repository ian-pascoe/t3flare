# Step 4a: plan (CLI agents over stdio: Codex and the pi CLI)

Date: 2026-11-11. Branch `step-4a`, from `origin/main` at 5e8e4ac. t3code pinned at `v0.1.9-nightly.20261111.4515`
(24e7747). Throwaway stage `step4a` (added to `STAGES` in `apps/environment/scripts/stage.ts` only when implementation
starts; prod is never deployed, run against or linked).

This is a plan to review, not a report; nothing in it is built. Paths under `t3/` are `t3code/apps/server/src/`,
`pi/` is `t3code/packages/provider-pi/src/server/`, `env/` is `apps/environment/src/`, `agents/` is
`apps/agents/src/`. Line numbers are from the pin and drift; the symbol beside each is the stable handle.

## Changelog: owner confirmation and independent review (Fable), 2026-11-12

These override the plan below where they conflict. Each is verified against the code as its milestone reaches it;
the verdicts and any rebuttals, with evidence, are in the report (`docs/steps/step-4a.md`, § Review findings).

- **OD-3 confirmed (owner).** CLI agents get no t3 MCP tools in 4a. The parity cost is listed in `docs/parity.md`
  and a ticket brings them back after 4b. OD-1 and OD-2 apply only if their probe fails.
- **F1 (BLOCKER). One Codex app-server per provider instance.** With `supportsMultipleProviderThreadsPerSession`
  true, t3 derives the provider session from the instance (`Orchestrator.ts:1259-1272`, `CodexAdapterV2.ts:247`)
  and `ProviderSessionManager.open` attaches later threads to the live session without spawning (`:2428-2445`): a
  second project's thread would run in the first Workspace's Container. The wrapper reports `false` in
  `getCapabilities()` **and** on the session entity it returns (read at `ProviderSessionManager.ts:2534-2536`). M0
  gains P12 (two Codex threads in two Workspaces open two processes); M3 and M5 gain the same case. Forks across
  Workspaces are refused (`CodexAdapterV2.ts:8159-8176`; pi `adapter.ts:3335-3350`).
- **F2 (HIGH). Synced CLI homes are an agent-writable control plane.** The CLI homes are built fresh on
  Container-local disk at each spawn; only `sessions/` is synced. Codex: `CODEX_HOME` local, `sessions/` a symlink
  into `/workspace/.t3flare/codex/sessions`, `CODEX_SQLITE_HOME` local (the default, not a fallback). pi:
  `PI_CODING_AGENT_DIR` local, `PI_CODING_AGENT_SESSION_DIR` synced, `--no-approve` (no project trust), and a
  session retention bound. Replaces §2.7's layout and §4.4's synced `models.json`.
- **F3 (HIGH). Scan before the pull, not after.** The hash scanner runs in the Container on the changed files before
  each pull; a hit quarantines the file (never synced), kills the CLI and flags the key for rotation. The launcher
  sets `ulimit -c 0`. The DO-side redaction stays as a second line; the exit claim reads "no credential is ever on
  synced disk *as far as the in-Container scan before each pull can see*" (see the report). Replaces §4.9's "detect
  and contain".
- **F4 (HIGH). The nonce leaks to Codex's shells** when `ignore_default_excludes` is true. Codex gets `-c
  shell_environment_policy.exclude=["T3FLARE_MODEL_KEY_NONCE"]`; and for Codex the route grants **once per nonce**
  (with `refresh_interval_ms=0` Codex asks once, and again only after a 401).
- **F5 (MEDIUM). The request guard is an allowlist.** Methods and config keys are allowlisted (t3's own keys,
  `CODEX_THREAD_CONFIG`, `CodexAdapterV2.ts:1391-1397`, plus the thread-id shell variable), `thread/fork` included;
  `feedback/*` (uploads logs to the vendor) and `account/*` are refused. The process starts with `-c
  approval_policy="untrusted" -c sandbox_mode="read-only"`. `bwrap` is probed at each Container start.
- **F6 (MEDIUM). Channel specifics.** Byte frames end to end (TerminalHost decodes to strings; the process channel
  does not). One `processInput` in flight per key with contiguous `seq`; a failed write kills the process, never
  skips. Bounded Environment-side queues; `processOutput` awaits the offer (backpressure to the Workspace). The epoch
  is a durable boot counter, not a UUID. Handle and pid registries live on the DO instance, not in module state
  (module state survives `ctx.abort()`; `processRouter.ts:41,58,173` keeps module maps today); the reboot check
  covers it.
- **F7 (MEDIUM). The hold is decided in M1, not M5.** Default: the Workspace releases a CLI session's Container hold
  10 minutes after its last turn ends; idle CLI sessions end when the Container budget is full; the per-Workspace
  process cap is derived from P9's memory probe. Replaces §2.5's "decided in M5" and Patch 0003's conditionality.
- **F8 (MEDIUM). D1 for CLI processes.** Linked work is held under `cli:<thread>` while that thread's process lives
  (not only per turn), and released by marker when the process ends; `credentialDecision` (`linkedPush.ts:28-35`)
  otherwise returns the full token once nothing is active.
- **F9 (MEDIUM). Milestones.** P12 for F1. P8 gains a stop gate on DO CPU and rows per pull at 5, 20 and 50 MB
  rollouts, and resume from a torn last line. The DO-side leak scan moves to M3's exit. Nothing reaches `main` before
  M6. M5's resume proof is the protocol log (`thread/resume` or `switch_session` succeeding with no handoff
  transition), not a code word. P11's pi-mode question is answered: t3 restarts pi on a mode change. The Docker egress
  proof uses a network that reaches only the fake proxy and the stub host, with a logging resolver.
- **F10 (LOW).** `docs/parity.md` records withholding MCP. The wrapper filters pi's "t3-code MCP unavailable"
  warning.

## Settled (not reopened here)

- **Every model call goes through the model proxy** (Commissary). No vendor login; Codex never uses its ChatGPT
  sign-in, and t3's managed Codex mode (`setupMode: "managed"`) is not offered ([ADR-0012](../adr/0012-all-model-access-goes-through-the-model-proxy.md)).
- **ADR-0016 key delivery is option A′.** A CLI gets the Commissary key from a small helper only when it asks; the key
  is never in the Container's environment or on its disk. The key is `COMMISSARY_CONTAINER_API_KEY` (already a secret
  in the `prod` and `bump` GitHub environments and a line in `~/.config/t3flare/dev.env`). The helper asks the
  Workspace DO through computer's egress host, as the git credential helper does (step 2a).
- **t3's built-in providers.** Codex is t3's Codex driver (`codex app-server` over stdio); Pi is t3's Pi driver
  (`pi --mode rpc` over stdio), shown as "Pi", distinct from our "Pi Durable". Both run in the Workspace's Container.
- **Vendor-login CLIs are refused** (D3). **Previews come last** (D4).

## Exit criterion, restated

`docs/plan.md` row 4a already reads "each on a proxy model". The older wording ("A Codex turn on the ChatGPT login
runs in two Containers at once") predates ADR-0012's rewrite; under it the exit is:

> **A Codex turn and a Pi turn, each on a model the proxy serves, run at the same time in two Workspaces' Containers,
> and each resumes its own conversation after its Container slept. Neither CLI holds a vendor credential or calls a
> vendor host, and no credential is ever on synced disk.**

"At the same time" means the two turns' intervals overlap and both Workspaces hold a `ContainerBudget` lease at once
(the budget allows 3; a fourth start is refused with the budget's reason). "Resumes" means the next turn continues the
CLI's own native thread (Codex `thread/resume` of the same thread id, Pi `switch_session` to the same session file),
not t3's context handoff. "Calls a vendor host" and "on synced disk" are defined in §4.7 and §4.8, with how each is
proved.

## In one paragraph

t3 already drives both CLIs as child processes speaking JSON lines on stdin and stdout, through Effect's
`ChildProcessSpawner`. The Environment DO cannot run processes, so the step is a **process channel**: our spawner sends
`codex` and `pi` spawns whose cwd is in a Workspace to that Workspace DO, which runs them in its Container with the
platform's non-PTY `ctx.container.exec`, and streams their output back the way ADR-0021's terminals do (batched pushes
over DO RPC, no held stream), with stdin, signals and heartbeats going the other way. Both drivers are registered
through our existing `builtInDrivers.ts` Shadow, built from t3's own exported adapters but with **our** readiness
(image manifest and the proxy's catalog instead of spawning probes), **our** text generation (the proxy), and t3's
MCP credential withheld. Each spawn gets a **CLI profile**: a fixed environment, the proxy as its only model provider,
and a key helper (`t3flare-model-key`) that both CLIs support natively (Codex's model-provider `auth` command, pi's
`!command` API key). The Container is held while a CLI process lives; t3's own idle release ends idle sessions, and the
next turn resumes from the CLI's state directory, which lives in the synced Workspace beside the repo. One new Shadow
(`processGroup.ts`) is needed because t3's Pi adapter signals its process group with `process.kill` directly. The
riskiest unknowns (long-lived exec, Codex on Commissary's Responses API, `bwrap` in a Container, CLI state on
computer's FUSE mount, t3's behaviour when a CLI exits while idle) are settled in M0 before any of it is built.

## 1. What t3 and t3flare do today

### 1.1 Codex in t3

- **Spawn.** `CodexAdapterV2.ts` `layerAppServerClientFactory` (`:1580-1640`) is a Layer for the service
  `CodexAppServerClientFactory` (`:1385`). Its `open({ threadId, providerSessionId, runtimePolicy, settings,
  environment })` builds `codex app-server` (`codexAppServerArgs`, `t3/provider/codexLaunchArgs.ts:12`) with
  `CODEX_HOME` from `settings.homePath`, wraps it with `AgentScope` (systemd scopes on a laptop; the cloud's
  `HostProcess.Environment` has no `XDG_RUNTIME_DIR`, so it passes through), and spawns it **with no cwd**: the cwd
  is `runtimePolicy.cwd`, sent per thread in `thread/start` and `turn/start`. It also calls
  `PortDiscovery.trackAgent` (previews; not here).
- **Per-thread config** (`codexThreadRuntimeParams`, `:1407-1450`) puts t3's MCP server in the thread's config:
  `mcp_servers.t3-code = { url, http_headers: { Authorization: <t3's per-thread bearer> } }`. That is t3's MCP
  credential written into the Codex process over stdin.
- **Modes** (`codexRuntimeModeTurnDefaults`, `:722-760`): `approval-required` → `untrusted` + `readOnly` sandbox;
  `auto-accept-edits` → `on-request` + `workspaceWrite`; `auto` → `on-request` with Codex's `auto_review` reviewer;
  `full-access` → `never` + `dangerFullAccess`. Plan is Codex's native `collaborationMode: plan`
  (`emitsProposedPlan: true`). The presentation (`t3/provider/CodexProvider.ts:85`) lists every runtime mode,
  `auto` included, and shows the interaction-mode toggle.
- **The proxy shape exists already.** t3's managed mode (`t3/provider/CodexManagedRuntime.ts:22-31`) launches with
  `-c model_provider=…` and `model_providers.<id>={ base_url, wire_api="responses", requires_openai_auth=false,
  supports_websockets=false, auth={ command, args, timeout_ms, refresh_interval_ms } }`: Codex runs a command for its
  bearer token. Its comment: "Codex persists this provider ID in rollouts and needs it unchanged to resume."
- **Probes.** `CodexDriver.create` (`t3/provider/Drivers/CodexDriver.ts`) runs `checkCodexProviderStatus`, which
  spawns Codex (version, account, `model/list`), resolves maintenance (npm, mise), and offers `snapshotForCwd`
  (`:287`, a skills probe that spawns in the project's cwd). Codex text generation (`t3/textGeneration/CodexTextGeneration.ts`)
  spawns `codex exec`.
- **Attachments** are sent as `data:` URLs read on the server side (`resolveCodexAttachment`, `:3347`): nothing for the
  Container to read.
- **Compatibility.** `t3/provider/model-manifest.json`: Codex `>=0.156.0` supported, `>=0.159.0` recommended. npm's
  `@openai/codex` is at 0.167.2 today.

### 1.2 Pi in t3

- **Spawn.** `pi/adapter.ts` `openSession` (`:458-531`): cwd is `runtimePolicy.cwd`; it writes t3's pi extension
  into **t3's cache directory** (`materializePiT3McpExtension(host.paths.providerStatusCacheDir)`, which in the cloud
  is the State directory in DO SQLite), builds `pi --mode rpc … --extension <that path>` (`buildPiRpcLaunch`,
  `pi/mcpInjection.ts`), and spawns through `makePiRpcConnection` (`pi/rpc.ts:208-268`) with `extendEnv: false`,
  `detached: true` and `stdin: { stream: "pipe", endOnDone: false }`.
- **Stop.** `rpc.ts` signals the process **group** itself: `signalProcessGroup(pid, signal)`
  (`t3code/packages/provider-core/src/server/processGroup.ts`, 9 lines) is `process.kill(-pid, signal)`, and
  `hasExited()` is `signalProcessGroup(pid, 0)`. It never calls the handle's `kill`. In workerd `process.kill` cannot
  reach a Container process, so as it stands t3's TERM-then-KILL never happens and `hasExited` is wrong.
- **The extension is the permission hook.** "Always inject the permission hook even without MCP credentials; otherwise
  Supervised becomes unrestricted" (`adapter.ts:475`). It reads the mode from `T3_PI_RUNTIME_MODE`, and **a missing or
  unknown value means `full-access`** (`pi/mcpExtensionSource.ts` `runtimeMode()`, `:54-62`): it fails open. With
  `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` it also bridges t3's MCP tools (the bearer in pi's environment, which
  ADR-0022 rejected for Containers).
- **Resume.** The native thread id is pi's `sessionFile`, an absolute path (`adapter.ts:2533-2536`); reopening sends
  `switch_session` with it. The file must exist at the same path in the next Container.
- **No plan mode.** `emitsProposedPlan: false`, no interaction-mode handling, toggle hidden
  (`pi/status.ts:53-54`; modes `approval-required`, `auto-accept-edits`, `full-access`).
- **Probes.** `PiDriver.create` (`pi/driver.ts`) spawns pi for its status (`--version`, model discovery over RPC),
  its text generation, and `snapshotForCwd` (`discoverPiCommandsForCwd`, a spawn in the project's cwd per snapshot).
  Minimum pi 0.80.5, recommended `>=1.0.0`; npm's `@earendil-works/pi-coding-agent` is at 1.5.2.
- **pi's own configuration** (pi 1.5.2 docs): `PI_CODING_AGENT_DIR` moves the agent directory; `models.json` can
  override a provider's `baseUrl` and add models, and its `apiKey` may be `!command`, run at each request and never
  cached; `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY=0` turn off its own network activity. Step 3's
  laptop agent already ran t3's Pi provider on the proxy this way (`apps/environment/scripts/lib/laptopAgent.ts`).

### 1.3 Session lifetime in t3

`t3/orchestration-v2/ProviderSessionManager.ts` releases a provider session after **30 minutes idle**
(`DEFAULT_IDLE_TIMEOUT_MS`, `:59`; reason `idle_timeout`, `:1242`) and on a process that dies (`runtime_error`); the next
turn opens a new session and resumes the native thread. Pinned sessions (background work) may be kept up to 4 h. The
timeout is a `layerWithOptions` option, but `runtimeLayer.ts:134` composes the plain `.layer`.

### 1.4 What t3flare has

- **The process router** (`env/agents/processRouter.ts`) is t3's `ChildProcessSpawner`: `git` and `gh` only, each
  buffered (the command runs once stdin ends; the handle's `pid` is 1, `kill` is a no-op); everything else is
  `NotFound`.
- **Terminals** (`agents/workspace/terminalHost.ts`, ADR-0021) are the streaming template: a PTY exec per shell,
  output batched (16 ms near input, 100 ms otherwise, 32 KiB) and pushed to `EnvironmentDO.terminalOutput`, never
  dropped; input, resize and close as RPC; a heartbeat every 30 s and a kill at 90 s without one; a per-instance epoch;
  markers in storage to kill orphans; `T3FLARE_EXEC` markers and part 2's kill script (never `ExecProcess.kill()`).
- **The Workspace DO** (`agents/workspace/WorkspaceDO.ts`): Container start through the `ContainerBudget` lease
  (3 at once, `agents/budget.ts`), a 2-minute idle stop by alarm, `CONTAINER_INSTANCE` 1 vCPU / 3 GiB / 12 GB,
  computer's sync of `/workspace` with the DO's SQLite files (`CONTAINER_IGNORE` keeps dependency and cache
  directories Container-only, `/.t3flare/**` always synced), and the git credential helper: the Container's `curl
  http://computer.internal/t3flare/git-credential` reaches `WorkspaceProxy` (`agents/workspaceProxy.ts`), which
  forwards that one path to the Workspace DO's `fetch`, which asks the Environment DO for a token. Step 3's D1 lives
  there too (`credentialDecision`, linked work noted by Sessions, `approveGitPush`).
- **The image** (`apps/sandbox-image/image/Dockerfile`): Ubuntu 26.04, computerd 0.9.0, mise with Node 26.13, Bun,
  Python, git, gh; **`bubblewrap` is already an apt package in it**.

## 2. The process channel

### 2.1 Routing a spawn

The spawner (`processRouter.ts`, extended) answers a `StandardCommand` whose binary is `codex` or `pi` and whose cwd
is `/w/<id>/…` of a ready Workspace with a **CLI process**. Anything else keeps today's routes. Fail closed:

- Codex: only `app-server`; pi: only `--mode rpc` (and t3's `--fork` variant of it). Other argv (`--version`,
  `exec`, `--list-models`) are refused with a clear error; nothing in our drivers sends them (§3).
- No cwd, or a cwd outside a Workspace (t3's "No project" scratch folder): refused with "Codex and Pi run in a
  Workspace's Container; start the thread in a project" before any Container starts. Codex's spawn has no cwd at
  t3's layer, so **our own `CodexAppServerClientFactory` Layer** (§3.1) passes `runtimePolicy.cwd` as the spawn's cwd.
- At most 4 CLI processes per Workspace (each app-server is a few hundred MB); the fifth is refused.

### 2.2 The Environment side: a streaming handle

`ChildProcessSpawner.makeHandle` over a channel entry keyed by a fresh `key` (`proc-<uuid>`):

- `spawn` resolves only once the Workspace DO answers that the process **runs** (Container started through the
  budget, orphans killed, exec started). The budget's refusal or a failed start fails the spawn with its reason, which
  t3 reports as the session's open error. A cold start (~18 s, step 2a) is therefore spent before t3's
  `initialize` request, not under its timeout (M0 P7 checks t3's open timeouts).
- **stdin**: the sink's chunks go to `WorkspaceDO.processInput(key, seq, bytes)` in order, coalesced for 5 ms and cut
  at 1 MiB per RPC (a `data:` image can be several MB). `endOnDone: false` is honoured: the sink ending does not
  close the process's stdin; `endOnDone` true (the default) sends `processInput(key, seq, null)` = close.
- **stdout, stderr**: queues fed by `EnvironmentDO.processOutput` pushes (§2.4), deduplicated by `(key, stream, seq)`
  (a push retried after a lost answer can repeat). `all` interleaves them.
- **exitCode** resolves from the exit frame; `isRunning` from local state; **`pid`** is a unique synthetic number
  above 1 (`signalProcessGroup` refuses `pid <= 1`), registered for the `processGroup.ts` Shadow (§2.9).
- **kill(signal)** and the Shadow's `signalProcessGroup(pid, sig)` send `WorkspaceDO.processSignal(key, sig)`, which
  runs part 2's kill script on the key's marker (TERM, then KILL from 2 s when asked for KILL). `signal 0` answers
  from local state.
- **Scope**: `spawn` registers a finalizer in the caller's scope that kills the process if it still runs: when t3
  closes a session, the process goes even if t3's own stop path did nothing.
- **Heartbeat**: every 30 s the Environment sends `processHeartbeat(keys)` per Workspace with live handles; the answer
  names keys the Workspace does not know (its instance restarted), and those handles end (§2.6).

### 2.3 The Workspace side: `ProcessHost`

A sibling of `TerminalHost` in the Workspace DO (`agents/workspace/processHost.ts`), sharing its batching, push and
orphan code where it can:

- **Start**: refuse on a destroyed Workspace; start the Container through the budget if stopped; kill **every live
  CLI process of another Environment epoch** in this Workspace (see §2.6); write the profile's files (§4); then
  `ctx.container.exec(["bash", "-c", launcher], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })` without a
  PTY. The launcher (in `apps/sandbox-image/src/`, beside `terminalCommand`) makes t3's path `/w/<id>` resolve to
  `/workspace/repo` exactly as terminals do (bind mount, else symlink), `cd`s to t3's cwd, and ends in `exec setsid
  --wait <binary> …`, so the CLI leads its own session and group and **sees t3's own paths**: the file paths in its
  events are the ones t3 already shows, and Codex's `thread/start` cwd (`/w/<id>`) exists. The environment carries
  `T3FLARE_EXEC=<key>` (part 2's marker; Codex additionally gets `-c
  shell_environment_policy.set.T3FLARE_EXEC=<key>` so its shells keep it if its policy filters the environment).
- **Markers** of live CLI processes are kept in storage (with their Environment epoch); a new instance kills those it
  does not hold at its first open, as terminals do.
- **Output**: separate readers for stdout and stderr, each frame `{ key, stream, seq, data }`, batched like
  terminals (16 ms while the process had input in the last second, else 100 ms; 64 KiB per batch), pushed to
  `EnvironmentDO.processOutput({ workspace, epoch, frames })`; never dropped (a failed push goes back to the front and
  retries with backoff); reading pauses at 1 MiB pending. The exit frame carries the exec's exit code (129 when the
  stream broke without one).
- **Answers** to a push name unknown keys: the Environment that spawned them is gone; those processes are killed.
- **Heartbeat lapse**: a CLI process without a heartbeat for 90 s is killed (it ends with its Environment, as
  terminals do, ADR-0021 D1).

### 2.4 Streaming over RPC, and why push

ADR-0021 measured push against a held stream for terminals: held connections pin the Environment DO and count
against its 6 outgoing connections, and the prod bug of 2026-11-11 showed "ReadableStream received over RPC
disconnected prematurely" (`docs/steps/bigrepo/README.md`). JSON-RPC traffic is bursty (token deltas during a turn,
nothing between turns), which batching suits. The only ordering contract is per `(key, stream)`; a JSON line split
across frames is reassembled by t3's own line decoder. M1 measures a request-response round trip through the channel
(target: p95 under 150 ms when warm, against terminals' 95 ms echo p95).

`EnvironmentDO.processOutput` never boots t3 and is not a request for the idle check (as `terminalOutput`): an open run
keeps the Environment awake during a turn anyway (ADR-0003).

### 2.5 Lifetime and the Container's idle stop

ADR-0015 already says it: processes inside the Container are not activity, so the Workspace DO holds the Container
while a CLI process lives. The hold is bounded from above, so an idle app-server cannot keep a Container all day:

1. **t3's own idle release** ends an idle CLI session after 30 minutes (§1.3). Its finalizer kills the process
   through the channel; the Container then idles out after 2 minutes. If M0 P7 shows 30 minutes is too costly
   (`docs/cost.md`: about $0.03 per Container-hour plus 450 GB-s of Workspace DO duration), Patch 0003 sets
   `idleTimeoutMs` to 10 minutes in `runtimeLayer.ts:134` (one line, matching the terminals' prompt hold). Decided
   in M5 from the idle-stop logs, not up front.
2. **The heartbeat lapse** (90 s) ends processes whose Environment is gone.
3. **A backstop**: a CLI process with neither input nor output for 2 h 10 min (past the 2 h turn cap) is killed.
4. **The 2 h turn cap** (ADR-0015) is enforced for CLI turns by our adapter wrapper (§3), which interrupts the turn
   and fails it with "The turn ran longer than 2 hours", as the Durable agents do.

While a CLI process lives, the alarm renews the budget lease every 5 minutes (`RENEW_EVERY_MS`), as it does today.

### 2.6 When something restarts

| Event | What happens | Why it is safe |
|---|---|---|
| **Environment DO resets** (idle reset, deploy, eviction) | All handles go with the isolate. t3 boots, recovery cancels open runs and `RestartContinuation` re-prompts (ADR-0004); the continuation opens a new session and spawns a new CLI | The new spawn carries the new Environment epoch; `ProcessHost` kills **every process of an older epoch in that Workspace before starting it**, so two copies of one Codex thread never write the same rollout (t3's laptop analogue is `AgentScope.stopLeftoverAgents`). Without a continuation, the old processes end at the 90 s heartbeat lapse |
| **Workspace DO resets** with the Container running (rare: a running Container keeps its object across deploys, step 2a) | The exec handles go with it. What happens to an exec'd process whose DO went away is **M0 P1** | The new instance has a new epoch; the next heartbeat or input gets "unknown"; the handle ends with exit 129 and stderr "t3flare: the Workspace restarted"; t3 records `runtime_error`; the next turn reopens and resumes. Orphans are killed by stored markers at the next open |
| **Container stops** (idle stop with no CLI process, `workspace-stop`, delete) | `stopContainer` pulls pending writes first (§2.8), then exits frames for every process (code 129) | Only reached with no live CLI process, or by an explicit stop |
| **Container dies** (crash, OOM, a lost lease) | The exec streams end; exit frames go out | t3 sees the process exit; the next turn reopens |
| **CLI process dies** (earlyoom kills it, a crash) | Exit frame with its code | As above; the memory guard's note is on stderr (`command.bash`) and reaches t3's logs |

### 2.7 Resume after Container sleep

Each CLI's state lives in the synced Workspace, beside the repo and outside every t3 path (ADR-0016: "session-state
directories sit beside the repo … and are synced; they hold no secrets"):

- Codex: `CODEX_HOME=/workspace/.t3flare/codex` (rollouts in `sessions/`, `config.toml` unused, see §4.3).
- pi: `PI_CODING_AGENT_DIR=/workspace/.t3flare/pi` (`models.json`, `settings.json`, `sessions/`).

Both paths are the same string in every Container, so a Workspace's CLI finds its own files. Directories that are
caches or databases stay **Container-only** (new `CONTAINER_IGNORE` entries, placed after the `!/.t3flare/**`
negation and tested for precedence): Codex's `sqlite/`, `cache/`, `log/`, `tmp/`, `shell_snapshots/`; pi's package
and cache directories. Whether Codex rebuilds its thread index from rollouts after its SQLite state is gone, and
whether SQLite works at all on computer's FUSE mount, is **M0 P8**; if Codex needs its database, `CODEX_SQLITE_HOME`
(or its config equivalent) moves it to the Container's own disk and the rollouts remain the source.

The resume itself is t3's: a new session sends `thread/resume` (Codex) or `switch_session` (pi) with the native id t3
kept. M5 proves it is the same native thread, not a handoff.

### 2.8 File sync while a CLI works

A CLI writes in the Container; t3's diffs and checkpoints are made by the Workspace DO from its own files (ADR-0009).
Today only terminals pull (`TerminalSync`). It generalises to every Container writer:

- While a CLI process lives, the DO pulls when the CLI's output goes quiet (as on a terminal prompt) and pushes its
  own writes (client edits) every 2 s.
- A checkpoint capture or a diff while the Container runs pulls first, so a Codex turn's end checkpoint sees its last
  edit.
- `stopContainer` pulls before it stops (already done for terminals), so the last rollout lines are in the DO before
  the Container goes: this is what makes resume work.
- After each pull, the **sync guard** (§4.9) scans the changed files under `/.t3flare/codex/`, `/.t3flare/pi/` and the
  repo for the credentials the Workspace holds.

### 2.9 Shadows, Patches and Layers (ADR-0001)

| Change | Kind | Count after |
|---|---|---|
| Our `ChildProcessSpawner` (process router plus the channel) | Layer (ours, extended) | — |
| Our `CodexAppServerClientFactory` with the request guard (§3.1) | Layer | — |
| Our Codex and Pi driver registrations | inside the existing `builtInDrivers.ts` Shadow | Shadows unchanged by this |
| `@t3tools/provider-core/server/processGroup` → a registry of channel pids | **new Shadow** (a package-subpath import: `build.ts`'s `SHADOWS` gains package-path redirects, and T5's build report asserts it) | **Shadows 2** |
| `runtimeLayer.ts:134`, `idleTimeoutMs` 10 minutes | Patch 0003, **only if** M5's cost data asks for it | Patches 2, or 3 |

Rejected: replacing `globalThis.process.kill` at boot (a global monkeypatch is less visible than a Shadow and catches
every caller). Well inside ADR-0001's budget (about 10 Patches, 15 Shadows).

## 3. Driver registrations: readiness wrappers

ADR-0015: "our driver registrations wrap upstream's and replace the probe, and a spawn outside a Workspace fails
fast so probes never start a Container." Our drivers are **not** `CodexDriver.create`/`PiDriver.create` with the probe
swapped afterwards (their probes would already be forked); they are built from t3's exported pieces, like
`PiDurableDriver` (`env/provider/driver.ts`):

- **Kinds** `codex` and `pi`, t3's own, so the stock clients' icons, settings forms and the Codex plan toggle apply
  (U22's risk does not arise). Display names "Codex" and "Pi".
- **Snapshot**: installed `true`, version from the image manifest (§6), status `ready`, auth `authenticated` (the
  proxy is the account; no sign-in to nag about), models from the catalog (§4.5). The presentation copies t3's but
  **drops `auto` from `supportedRuntimeModes`** (t3 then refuses an explicit `auto` launch, as for Pi Durable, C1).
  No `snapshotForCwd` (pi's would spawn in every project; Codex's probes skills): slash commands and skills stay G10.
- **Adapter**: `createCodexAdapterV2` (`CodexAdapterV2.ts`) and `PiAdapterV2Driver.create` (`pi/adapter.ts:3687`),
  each run with **`McpProviderSessions` provided as a stub whose `read` answers nothing**, so t3's per-thread MCP
  credential never reaches either CLI (ADR-0022's rule). A thin wrapper around the returned `ProviderAdapterV2`
  reports `supportsMcpTools: false`, enforces the 2 h cap, tracks linked turns (§5.4), and handles plan mode for pi
  (§5.3).
- **Settings**: t3's `CodexSettings`/`PiSettings` schemas, so the forms render. `binaryPath` and `homePath` are
  ignored (the image's paths, §6); `launchArgs` are ignored in 4a (they could redirect the provider; the snapshot says
  so); Codex `setupMode: "managed"` is refused with "ChatGPT sign-in is not offered; t3flare uses the model proxy"
  (ADR-0012). `textGenerators` stays locked (ADR-0023).
- **Text generation** for a Codex or Pi thread (titles, commit and PR text) is the proxy's, through
  `makePiDurableTextGeneration` with the thread's model id: no Container starts for a title.
- **Usage readers**: none (`BUILT_IN_USAGE_DRIVERS` stays empty, ADR-0012).
- **Bundle**: the Codex and Pi adapters join the environment Worker (today 8.9 MB). M0 P6 checks it bundles, deploys
  (no module-scope I/O or randomness), boots twice in one isolate, and its heap after boot stays under step 0's bound.

### 3.1 Codex: the client factory and its request guard

Our `CodexAppServerClientFactory` Layer restates t3's 40-line `layerAppServerClientFactory` (without port discovery),
spawning with `cwd: runtimePolicy.cwd`, and wraps the client's requests before they reach stdin:

- `thread/start`, `thread/resume`: config keys under `mcp_servers.*`, `model_provider`, `model_providers.*`,
  `openai_base_url`, `chatgpt_base_url`, `shell_environment_policy.*` and `sandbox*` are dropped (defence in depth:
  the stub already keeps t3's MCP server out).
- `turn/start`: `approvalPolicy` and `sandboxPolicy` are replaced from **our** mode table (§5.1), whatever t3 or a
  launch asked; an unknown or `auto` runtime mode runs as `approval-required`; an unknown interaction mode runs as plan.
- Server-to-client approval requests pass through; in plan mode a file-change approval is declined by the guard.

## 4. Credentials (A′)

### 4.1 The key helper, per CLI

| | Codex | pi |
|---|---|---|
| Hook | model provider `auth = { command, args, timeout_ms, refresh_interval_ms }`; stdout is the bearer token (the shape t3's managed mode uses) | `models.json` `apiKey: "!t3flare-model-key pi"`; run at each request, not cached (pi docs, `models.md`) |
| Sent as | `Authorization: Bearer <key>` to `<MODEL_PROXY_URL>/v1/responses` | `x-api-key: <key>` to `<MODEL_PROXY_URL>/v1/messages` (pi's `anthropic-messages`) |
| Kept | in Codex's memory; re-run on a 401 (`refresh_interval_ms = 0`) | nowhere: one helper run per model request |
| To check (M0) | Commissary accepts a `cms_` key as a Bearer on its OpenAI endpoints (P3) | the helper's latency per request, through the egress host (P5) |

`/opt/t3flare/bin/t3flare-model-key` (in the image, ~10 lines of bash): `curl -fsS --max-time 30
http://computer.internal/t3flare/model-key?cli=<name>`, prints the body, exits non-zero on anything but 200. It never
writes a file, takes no argument that is a secret, and logs nothing.

### 4.2 The key route

- `WorkspaceProxy` forwards `/t3flare/model-key` as it forwards `/t3flare/git-credential`.
- The Workspace DO answers with `COMMISSARY_CONTAINER_API_KEY` (an agents Worker secret), `cache-control: no-store`,
  **only while this Workspace has a live CLI process**; otherwise 403. A Durable agent's shell in a Container with no
  CLI running gets nothing.
- Hardening, measured in M0 and kept if it holds: each CLI spawn gets a per-process nonce in
  `T3FLARE_MODEL_KEY_NONCE`, which the helper sends and the route checks against live processes. Codex's default shell
  policy drops variables named `*KEY*` from its commands' environment (M0 confirms), so Codex's own shells cannot pass
  the check by accident. pi's `bash` inherits its environment, so for pi it is not a boundary (§4.9).
- Each grant is logged as `model-key` with the Workspace, the CLI name and a count, never the value.

### 4.3 Codex's model provider

Our driver passes no launch arguments, so t3 spawns exactly `codex app-server` (`codexAppServerArgs`,
`t3/provider/codexLaunchArgs.ts:12`; `T3CODE_CODEX_LAUNCH_ARGS` is not in the cloud's environment). The spawner accepts
only that argv and appends the profile's `-c` overrides, the form t3's managed mode uses (`app-server -c …`):

```
model_provider="t3flare-proxy"
model_providers.t3flare-proxy={ name="Model proxy", base_url="<MODEL_PROXY_URL>/v1", wire_api="responses",
  requires_openai_auth=false, supports_websockets=false, request_max_retries=1, stream_max_retries=1,
  auth={ command="/opt/t3flare/bin/t3flare-model-key", args=["codex"], timeout_ms=30000, refresh_interval_ms=0 } }
check_for_update_on_startup=false   (and Codex's analytics and feedback off; the full list is fixed by P10)
```

- The provider id `t3flare-proxy` never changes: Codex stores it in rollouts and needs it to resume.
- Retries are kept low: ADR-0012 says nothing retries into spend, and the proxy's 429 already means every account is
  cooling down. Turning the proxy's 429 into t3's "Usage limit reached" for CLI agents is not in 4a (a follow-up; the
  error shows as Codex reports it).
- Codex's environment is fixed (§4.6); `OPENAI_*`, `CODEX_API_KEY` and the rest are never passed.

### 4.4 pi's `models.json`

Written by the profile into `/workspace/.t3flare/pi/models.json` at each spawn, from the catalog:

```json
{ "providers": { "anthropic": {
    "baseUrl": "<MODEL_PROXY_URL>",
    "apiKey": "!/opt/t3flare/bin/t3flare-model-key pi",
    "models": [ { "id": "gemini-3-flash", "name": "…", "api": "anthropic-messages", "contextWindow": …, "maxTokens": …,
                  "reasoning": false, "input": ["text"] }, … ] } } }
```

The Durable agents already reach every model as `anthropic/<real id>` through pi-ai's Anthropic provider and the
proxy's translation; pi's built-in `anthropic` provider with its `baseUrl` overridden does the same, so **Pi's model
ids are Pi Durable's** (`packages/models`: `anthropic/claude-sonnet-5-5`, …). Claude models pi already knows keep its
metadata; the rest are added from the catalog with the limits and capabilities `packages/models` assigns them
(whether pi merges a built-in provider's `models` with its own list or replaces it is P4's question; either way the
file lists every catalog model).
`settings.json` sets pi's retry count low (as Codex). The file holds a command, not a key.

### 4.5 Model lists match the dynamic catalog

Both snapshots are built from `environmentServices().catalog` (the proxy's `GET /v1/models`, kept for 15 minutes, the
static list before the first read), as Pi Durable's are:

- **Pi**: the whole catalog, grouped by vendor, with the thinking picker for Claude models (`snapshotModels`). The
  same list feeds `models.json`, so a picked model is always one pi knows.
- **Codex**: the catalog's models Codex can drive. Codex speaks only the Responses API; Commissary translates to
  other providers, but Codex depends on Responses features (custom tools such as `apply_patch`, reasoning items).
  **M0 P3** runs a tool-using Codex turn on a GPT model and on one Claude and one Gemini model: the snapshot lists the
  OpenAI family alone, or the whole catalog, by that result. Reasoning-effort options for GPT models come from t3's
  model manifest where it lists the model (`applyCodexModelCatalog`'s data), else none.
- A model the catalog later drops is refused at turn start with the catalog's answer, as Pi Durable does.

### 4.6 The CLI profiles' environment

An allowlist, never `process.env` (the Workers run with `nodejs_compat_do_not_populate_process_env`; ADR-0021's rule):
`PATH` (the image's), `HOME=/root`, `LANG`, the image's `COMMAND_ENV` minus `BASH_ENV`, `T3FLARE_EXEC`, the nonce,
`CODEX_HOME` or `PI_CODING_AGENT_DIR`, and for pi `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`,
`T3_PI_RUNTIME_MODE` (always set and valid, §5.2) and `T3_PI_MCP_EXTENSION_PATH`. Whatever t3 put in the spawn's env
that is not listed is dropped and named in the channel's trace (`T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` among them;
with the stub they are absent anyway).

### 4.7 "No credential is ever on synced disk": the definition and its proof

**Credentials**: `COMMISSARY_CONTAINER_API_KEY`, `MODEL_PROXY_API_KEY`, the GitHub App's private key and every token
minted from it, t3's per-thread MCP bearers, `T3_BOOTSTRAP_TOKEN`, `T3FLARE_ADMIN_TOKEN`, the Access service token's
secret.

**Synced disk** is everything computer syncs between a Container's `/workspace` and its Workspace DO: the repo, the
harness directory `/workspace/.t3flare/` (both CLI homes in it), and so the DO's SQLite files. The claim is extended to
where a credential could reach it from: the Container's environment and command lines (`/proc/*/environ`,
`/proc/*/cmdline`), the Container-only paths (`node_modules`, the CLI caches, `/root`, `/tmp`,
`/var/lib/computerd/state.db`), and the State directory and Session storage (step 3's leak check).

**Proof**, run by `acceptance.ts --codex`/`--pi` after a real turn, after a resume and after a link-started turn
(extending step 3's `POST /_t3flare/check/peer-leak` into `/_t3flare/check/leak`):

1. **DO side, plaintext**: the Workspace DO reads every file of its own (computer's file system, which is the synced
   tree) and searches for each credential's value; the Environment DO does the same over the State directory, t3's
   provider event logs and the Session storage. Answers name the credential and path, never the value.
2. **Container side, without sending a secret in**: a scanner in the image (`t3flare-leakscan`) extracts every
   token-shaped string (≥ 20 characters of base64url, `cms_…`, `ghs_…`, PEM headers) from the Container-only paths,
   `/proc/*/environ` and `/proc/*/cmdline`, and returns their SHA-256s; the Workspace DO compares them with the
   credentials' hashes. No credential crosses into the Container to be looked for.
3. **Absence of the helper's output**: the CLIs' transcripts (rollouts, pi sessions) contain no `model-key` grant
   output (by 1).

Expected result everywhere: zero. A Unit test pins the scanner's token extraction against fixtures holding each
credential shape.

### 4.8 "Calls no vendor host": the definition and its proof

**Allowed hosts** for a CLI process and its children's model traffic: the model proxy's host, and
`computer.internal` (the egress host: the key and git credential helpers). Everything an agent's own commands reach
(`npm install`, `git fetch` from GitHub) is the agent's work, not the CLI's, and stays allowed (egress is `direct`;
an allowlist is deferred).

**Proof**: on test stages only, `T3FLARE_EGRESS_LOG=1` adds `HTTPS_PROXY`/`HTTP_PROXY` (and `NODE_USE_ENV_PROXY=1`
for pi) to the CLI profiles, pointing at a CONNECT-logging proxy started beside the CLI (`t3flare-egress-log`, a
50-line Node script in the image, inert unless that variable is set), with `NO_PROXY=computer.internal`. Acceptance
reads its log after the turns: CONNECTs to the proxy's host only. M0 P10 first runs each CLI with the logger and no
`check_for_update`/`PI_OFFLINE` settings, to list what each would contact by default, and fixes the settings in §4.3
and §4.6 from that list. A unit test pins every profile's flags.

### 4.9 Residual risk and the hardening around it

A′ was chosen knowing "any process that can run the helper can get it" (ADR-0016). The sharp case is the CLI's own
agent: a prompt-injected command can run the helper, print the key into a tool result, and so into the CLI's
transcript (synced) and into the model's context (sent out through the proxy). What 4a adds:

- **Bound**: `COMMISSARY_CONTAINER_API_KEY` is a key of its own, never the Workers' `MODEL_PROXY_API_KEY`; the owner
  gives it a models-only scope, its own spend limit and, optionally, an expiry (§12).
- **Narrow**: the route answers only while a CLI process lives in that Workspace; the nonce keeps Codex's shells out by
  accident.
- **The repo cannot redirect the CLI.** A cloned repo can carry project configuration (Codex's `.codex/config.toml`
  for trusted projects, pi's `.pi/` settings and extensions after trust). M0 P11 checks whether either can change the
  model provider or its `baseUrl` in headless mode; the profiles then trust no project (Codex) and turn project
  configuration off where pi allows it, and a test plants such files in the fixture to show the proxy still answers.
- **Detect and contain**: the sync guard (§2.8) checks each pull's changed files for the Workspace's credentials; a hit
  is replaced by `[redacted by t3flare]` in the DO's copy and the Container's, logged as `credential-in-workspace`
  (an error), and named in the Workspace's health so acceptance fails on it.
- Not in 4a, recorded as follow-ups: running CLIs under a second user ID (`ContainerExecOptions.user` exists), and a
  key per Container start (needs Commissary to mint keys).

## 5. Sandboxing, approvals and modes

### 5.1 Codex's sandbox and the mode table

Codex sandboxes its commands on Linux with bubblewrap and Landlock, which need user namespaces. `bubblewrap` is
already in the image; whether a Cloudflare Container lets it create namespaces is **M0 P2** (`bwrap --unshare-all
--ro-bind / / true`, then Codex's own sandbox runner on a read-only and a workspace-write command).

| Runtime mode | With a working sandbox (t3's table) | Without one (fail closed) |
|---|---|---|
| `approval-required` | `untrusted` + `readOnly` | `untrusted` + `dangerFullAccess`: every command outside Codex's known-safe list and every patch asks |
| `auto-accept-edits` | `on-request` + `workspaceWrite` | `untrusted` + `dangerFullAccess`: as above (degraded to ask more, never less) |
| `auto`, unknown | as `approval-required` (modefix) | as `approval-required` |
| `full-access` | `never` + `dangerFullAccess` | `never` + `dangerFullAccess` |

Whether Codex asks for a patch under `untrusted` with `dangerFullAccess` is part of P2's matrix; if it does not, the
guard turns every file change into a request (Codex's `fileChange` approval) by keeping `readOnly` and answering
the sandbox's escalation requests as approvals. The table and its evidence go into ADR-0015's refinement.

### 5.2 Approvals through t3's normal flow

Both CLIs already raise approvals the way t3 renders them: Codex's server-to-client approval requests, pi's extension
`ctx.ui.confirm` (t3's Pi adapter turns it into a request). Nothing new is needed for them beyond keeping them on:

- pi: `T3_PI_RUNTIME_MODE` is **always set by the profile** to the session's mode, with `auto` and unknown mapped to
  `approval-required`; a spawn whose mode is missing gets `approval-required`, never the extension's `full-access`
  default.
- pi: the extension is **required**. The spawner copies t3's file from the State directory into
  `/workspace/.t3flare/pi/ext/` (as `bridgeIndex` does for git's temp indexes), checks its content equals t3's
  `PI_T3_MCP_EXTENSION_SOURCE`, rewrites `--extension` and `T3_PI_MCP_EXTENSION_PATH`, and refuses the spawn if any
  step fails. M4 checks pi reports the extension loaded (its extension status) before the first turn.
- Whether t3 respawns pi when a thread's runtime mode changes (the mode is fixed at spawn) is **M0 P11**. If it does
  not, the wrapper closes the session when the mode changes so the next turn spawns with the new one.

### 5.3 Plan mode

- **Codex**: native plan (`collaborationMode: plan`, the toggle shown), and the guard enforces read-only: `readOnly`
  sandbox where it works, `untrusted` always, every file-change request declined with "plan mode is read-only".
- **pi** has no plan mode. Its toggle stays hidden, but a link-started task can hand one down (F6). Preferred: a plan
  turn runs with the extension at `approval-required`, and the wrapper declines `edit`/`write` requests and lets
  `bash` ask (F-plan's rule for Durable agents). If M4 cannot make that hold (the mode is fixed at spawn, §5.2), a plan
  turn on pi is refused with "Plan mode is not available for the Pi CLI; use Codex or Pi Durable". Either way it
  fails closed.

### 5.4 Link-started work (ADR-0022's fence, D1)

- **t3's tools**: CLI agents get none in 4a (the MCP stub, §3), so no link-fenced tool is reachable from them and the
  bearer never enters a Container. F1–F3 hold trivially; F5/F6 are the mode table and plan rules above.
- **D1, every push from linked work asks.** A linked thread (`linkOrigin`, read as step 3's `linkedWorkOf`) on a CLI
  notes linked work in its Workspace at each turn start, as Sessions do, under `cli:<threadId>`, until the turn ends
  plus a margin. The credential helper's decision is step 3's: a fetch gets a read-only token; a push **asks**. For
  `cli:` work the Workspace DO asks `EnvironmentDO.approveLinkedPush`, and the adapter wrapper raises a `permission`
  request on that thread (kind `git-push`, never accepted for the session), injected into the wrapped adapter's event
  stream and answered through its `respondToRequest`. If M6 finds t3 will not accept a request injected beside a
  CLI's own, the fallback is to **refuse** such pushes (stricter than D1), reported as a deviation with a ticket.
- `--peer` acceptance gains a case: a link-started task on the cloud's Codex instance at `approval-required/plan`
  (F6: a file change is declined, a command asks), and the leak check after it.

## 6. The image

- **Codex**: the release tarball `codex-x86_64-unknown-linux-musl` of a pinned version, fetched and checked against
  its SHA-256 in its own stage (as mise is), installed as `/opt/t3flare/bin/codex`. Start at **0.167.2**, which t3's
  manifest marks supported (`>=0.156.0`, recommended `>=0.159.0`).
- **pi**: `npm ci --omit=dev --ignore-scripts` (t3's own install advice) of `@earendil-works/pi-coding-agent` at
  **1.5.2** from a committed `package.json` and `package-lock.json` in `apps/sandbox-image/image/cli/`, with the
  image's mise Node, into `/opt/t3flare/pi`; `/opt/t3flare/bin/pi` is a two-line wrapper with absolute paths. A lock,
  not a range, so a rebuild is the same image.
- **Not mise**: the base `mise.toml` is the projects' toolchains (a project asking for other versions would not
  remove them, but its shims would sit ahead on `PATH`); the CLIs are the platform's, at fixed paths that profiles
  name absolutely.
- **The manifest**: `apps/sandbox-image/src/clis.ts` (`{ codex: { version, sha256 }, pi: { version } }`) is read by
  the drivers' snapshots (the version shown), by a test that keeps the Dockerfile's `ARG`s equal to it, and by a test
  that **the pinned versions satisfy t3's compatibility manifest at the pin** (`model-manifest.json`, status
  `supported`): a nightly bump that raises a minimum fails with "bump the CLI in `clis.ts`". Versions change only with
  a commit and a deploy (ADR-0024: install and update are refused).
- Also in the image: `t3flare-model-key`, `t3flare-leakscan`, `t3flare-egress-log`, and the M1 probe program
  (`t3flare-probe`: echoes stdin lines, prints on demand to stdout or stderr, sleeps, starts a child that ignores TERM;
  reachable through the channel only on stages with `T3FLARE_FAULTS=1`).
- **Size and build time**: expected +150 to +250 MB (Codex's static binary, pi with its WebAssembly dependencies) and
  +1 to +2 minutes on a cold build under amd64 emulation (step 2a's first build was 389 s). The CLI layer sits after
  the mise layer so a CLI bump rebuilds only it. M2 records both numbers and the cold start of the first command
  (17–18 s before).
- **3 GiB**: computerd, a Codex app-server (a Rust process, a few hundred MB) or pi (Node, a few hundred MB), plus a
  Node repo's `npm ci` and tests (often 1–1.5 GB at peak) should fit, but earlyoom kills the largest process, which can
  be the CLI. **M0 P9** runs a Codex turn that installs and tests a mid-size Node repo and reads `memoryPeakBytes`
  (`container-idle-stop`). Bar: p95 peak under 2.4 GiB over M0's and M5's runs. Above it, 4 GiB is an owner decision
  (§12, OD-1). Either way, `docs/cost.md`'s right-size to 2 GiB (audit F3) now waits for CLI-turn data too.

## 7. Two Containers at once, and the budget

- Each Workspace has one Container; a CLI runs in its thread's Workspace. Two Workspaces (two projects, or a project
  and a worktree) each running a CLI turn hold two leases; a Durable agent's `bash` in either shares that Workspace's
  Container.
- The budget is unchanged (3, `MAX_CONTAINERS`; leases of 10 minutes renewed every 5 by the alarm while a CLI process
  lives). A start refused by the budget fails the CLI's spawn with the budget's text ("3 Containers are running, the
  most this deploy allows; try again when one stops."), which t3 shows as the session's open error; the thread can be
  retried.
- A CLI session holds its slot while it lives (up to t3's idle release, §2.5), longer than a Durable agent's command
  does. M5 measures how long slots stay held across the acceptance runs; if three idle CLI sessions can starve a
  fourth Workspace in practice, Patch 0003 (10-minute release) is the lever.

## 8. Milestones, riskiest first

Each milestone is demoable on the throwaway stage `step4a`, has exit evidence in `docs/steps/step-4a/` (the scripts'
JSON and screenshots), and lands with its tests; `bun run check` passes at each milestone's head.

### M0. Probes (local Docker first, then `step4a`)

| # | Probe | Where | Settles | Stop gate |
|---|---|---|---|---|
| P1 | A long-lived non-PTY `ctx.container.exec`: stdin pipe, separate stdout/stderr streams, a 35-minute life with 10-minute silences, exit codes; what happens to the process when the Workspace DO is aborted (`ctx.abort()`), and when the Container idles | stage (a hand-run admin route) | §2.3, §2.6 | exec cannot keep a process for 35 minutes or loses streams → the supervisor fallback ADR-0015 lists (a daemon in the image with output replay, reached through computer), re-planned before M1 |
| P2 | `bwrap` user namespaces in a Cloudflare Container; Codex's sandbox runner; the mode × sandbox matrix of what asks | stage | §5.1 | none (the fallback table is fail-closed) |
| P3 | Codex on Commissary: `codex app-server` with the §4.3 provider and the helper, a tool-using turn (`apply_patch`, a shell command, reasoning) on a GPT model, then on a Claude and a Gemini model; Bearer accepted; a 30-minute stream with idle gaps | local Docker with the real proxy | §4.1, §4.3, §4.5 | no GPT model completes a tool turn → OD-2 |
| P4 | pi on Commissary: `models.json` with `!command`, `anthropic` `baseUrl` override, a non-Claude model, retries | local Docker | §4.4 | none expected (step 3 ran it with `$ENV`) |
| P5 | The key route through the egress host: latency per call from the Container (pi calls it per request) | stage | §4.1 | over ~200 ms p95 → pi gets a per-process cache in the helper's memory (a tiny local socket), re-planned in M2 |
| P6 | The environment Worker with t3's Codex and Pi adapters imported: build, deploy, the twice-in-one-isolate boot check, heap after boot, bundle size; what `process.kill` does in workerd | stage | §2.9, §3 | a module refuses to load in workerd → a Build shim or Shadow for it, counted |
| P7 | t3 with a CLI session whose process exits while idle: what the client shows, and whether the next turn reopens and resumes the native thread; t3's open and `initialize` timeouts against an 18 s cold start | local (t3's Node server with a spawner that runs `docker exec -i`) | §2.5, §2.6 | t3 shows a session that died idle as an error to the owner → Patch 0003 moves into M5 as required |
| P8 | Codex and pi state on computer's FUSE mount: Codex's SQLite under `/workspace`, rollouts' size growth, resume after the database is gone (Container-only) | stage | §2.7 | resume needs state that cannot live on the mount → `CODEX_SQLITE_HOME` on local disk, with a rebuild check |
| P9 | Memory: a Codex turn that runs `npm ci && npm test` on a mid-size Node repo, peak from the cgroup | stage | §6 | over 2.4 GiB → OD-1 |
| P10 | Egress: each CLI under the CONNECT logger with default settings, then with §4.3/§4.6's | local Docker | §4.8 | a vendor call that no setting removes → named in the report, blocked by `NO_PROXY`-less proxying to a refusing logger, and raised with the owner |
| P11 | t3's Pi adapter: does a runtime-mode change respawn pi; does `--extension` from a bridged path load; Codex's default shell policy and the nonce; can a repo's `.codex/` or `.pi/` configuration change the provider in headless mode | local Docker | §4.2, §4.9, §5.2, §5.3 | none |

Exit: `docs/steps/step-4a/m0-*.json`, one per probe, and this plan's open choices closed in a changelog at its top.

### M1. The process channel

Scope: §2.1–§2.6 and §2.9's Shadow: the spawner's routes, the streaming handle, `ProcessHost`, the push path, epochs,
heartbeats, orphan kills, the Container hold, the `processGroup.ts` Shadow and `build.ts`'s package-path redirect.

Demo on `step4a`: an admin route `POST /_t3flare/agents/process-check` (stages only) runs `t3flare-probe` through t3's
`ChildProcessSpawner` in a Workspace and drives it: 200 request-response round trips (latency p50/p95), 4 MiB through
stdin and back, stderr separate, a 35-minute idle gap, `signalProcessGroup` TERM then KILL with the TERM-ignoring child
gone within 3 s, and the restart cases: the Environment restarted (the next open in the Workspace kills the old epoch's
process), the Workspace DO aborted (the handle ends with 129; the orphan is killed at the next open), the Container
stopped.

Evidence: `m1-channel.json` (latencies, sizes, each case's outcome, `ps` in the Container after each), `m1-restart.json`.

Tests: Node unit tests of the handle (ordering, dedupe by seq, `endOnDone`, exit, kill, unknown keys, finalizer) and of
`ProcessHost` with a fake exec (batching, backpressure, never-dropped pushes, epochs, lapses, the hold), as
`terminalHost.test.ts` does; the Shadow's registry; the router's refusals (no cwd, scratch, wrong argv, fifth process).

### M2. Image, CLI profiles and the key (A′)

Scope: §6's installs and manifest; the profiles (§4.3, §4.4, §4.6) built on the Environment side from the catalog and
`MODEL_PROXY_URL`; `t3flare-model-key`, the key route and its gate (§4.1, §4.2); the secret's wiring:

- `apps/environment/scripts/stage.ts`: `COMMISSARY_CONTAINER_API_KEY` joins `DEPLOY_SECRETS` (read from `dev.env` or
  the environment, never printed; a stage deploy refuses without it).
- `apps/environment/alchemy.run.ts`: bound to the **agents** Worker only, as `Config.Redacted` (the Workspace DO answers
  the route; the Environment never needs it).
- `.github/workflows/deploy-prod.yml` and `bump.yml`: `COMMISSARY_CONTAINER_API_KEY: ${{ secrets.… }}` in the deploy
  step's env, and the header comments listing required secrets.
- `infra/github.ts`: in the required list for the `prod` environment's secrets, set by `ci:setup` from `dev.env`; for
  `bump`, documented as set by hand like `MODEL_PROXY_API_KEY` (it already is).
- `docs/model-proxy.md`: a "CLI agents" section (the Responses API and Bearer for Codex, the Messages API for pi, the
  second key and how to scope it).

Demo on `step4a`: `POST /_t3flare/agents/cli-smoke` (stages only) runs, through the channel and without t3's drivers,
`codex app-server` (`initialize`, `model/list`, one `thread/start` + `turn/start` that answers "ok") and `pi --mode
rpc` (one prompt) on proxy models; then the leak check's Container half and the egress log.

Evidence: `m2-image.json` (image size before and after, cold build time, first-command cold start), `m2-cli-smoke.json`
(both answers, helper grants counted, `/proc` scan clean, egress hosts), the route answering 403 with no CLI alive.

Tests: profile snapshots (argv, env allowlist, Codex `-c` list, `models.json` from a catalog fixture with Claude,
GPT and unknown-vendor models); the route's gate and nonce; the manifest-versus-Dockerfile and manifest-versus-t3
compatibility tests; **Docker tests with the real CLIs** (`apps/sandbox-image/test/cli.docker.test.ts`, run by `bun
run test:docker` and by the bump job, not by `bun run check`): the image's `codex` and `pi` start with the profiles
against a local fake proxy (a scripted Responses and Messages server) and a stub `computer.internal` (Docker
`--add-host`), complete a scripted tool turn, and leave no key in their files or environment.

### M3. Codex in t3

Scope: §3 for Codex (driver, snapshot from manifest and catalog, the client factory and request guard, text
generation, settings handling), §5.1, §5.3 for Codex, the 2 h cap.

Demo from the stock web client on `step4a`: in the fixture project (`ian-pascoe/t3flare-fixture`), a Codex thread at
`approval-required` on a proxy GPT model edits a file and runs `bash test.sh`, each approved in the client; the diff;
a plan-mode turn proposes a plan and its attempted edit is declined; the same thread at `full-access` runs without
asks.

Evidence: `m3-codex-turn.json` (the turn's items, both approvals, the checkpoint diff), `m3-modes.json` (each mode's
asks, with and without the sandbox per P2), `m3-*.png`.

Tests: the guard (every mode, `auto` and unknown, plan, dropped config keys, declined file changes); the driver's
snapshot (models, no `auto`, version); text generation routed to the proxy; t3's Codex adapter in Node against a
replayed app-server transcript through our factory (t3 ships replay kits for its adapters,
`t3/orchestration-v2/Adapters/*testkit.ts`). Acceptance gains `--codex` (§9).

### M4. Pi in t3

Scope: §3 for pi, the extension bridge, the mode rules (§5.2) and plan (§5.3).

Demo from the stock web client: a Pi thread ("Pi", beside "Pi Durable") at `approval-required` on a proxy Claude
model and on a non-Claude model does the same edit and `bash test.sh` with both approvals and the diff; changing the
thread to `full-access` runs without asks; a plan turn (handed down through `T3-Mode-Limit` from the M3 laptop
harness) declines its edit or is refused, per §5.3.

Evidence: `m4-pi-turn.json`, `m4-modes.json` (including a spawn with no mode: `approval-required`, and a spawn whose
extension could not be bridged: refused), `m4-*.png`.

Tests: the bridge (copy, content check, refusal), the forced mode, plan handling, the Pi adapter against t3's Pi replay
kit (`PiAdapterV2.testkit.ts`) through our spawner. Acceptance gains `--pi`.

### M5. Lifetime, resume, two Containers

Scope: §2.5–§2.8 end to end; Patch 0003 decided here.

Demo on `step4a` (`scripts/cli-lifetime.ts`):

1. **Two at once**: a Codex turn in project A and a Pi turn in project B (each running a 60 s command at
   `full-access`, so they overlap), the budget's state read mid-turn (two leases), a third Workspace's Durable `bash`
   taking the third slot, and a fourth start refused with the budget's text.
2. **Resume after Container sleep**: turn 1 in each thread sets a code word and writes it to a file; both Containers
   stop (`workspace-stop`, and separately by idling out after t3's release); the leases are gone; turn 2 asks for the
   code word: each answers it, and t3's provider thread shows the **same native id** (Codex thread id; pi session
   file).
3. **Restarts**: an Environment restart mid-turn (the continuation runs; the old epoch's process is gone before the
   new one starts; the turn completes), a Workspace DO abort mid-turn (the turn fails as `runtime_error`; the next
   turn resumes), and one hour idle with no client (the Environment resets, heartbeats lapse, the processes and the
   Container stop; the next turn resumes).
4. **Holds**: idle-stop logs over the runs (`ranMs`, `memoryPeakBytes`) and how long CLI sessions held their slots.

Evidence: `m5-two-at-once.json`, `m5-resume.json`, `m5-restarts.json`, `m5-holds.json` (with the Patch 0003 decision
and its numbers).

Tests: sync before capture and before stop (Node, fake computer); the epoch kill before spawn; the Workspace's
reaction to the Environment's unknown answers.

### M6. Proofs, the link fence, acceptance and documents

Scope: §4.7–§4.9 (leak check both halves, sync guard, egress log), §5.4 (linked turns, D1 pushes), the bump's flags,
the documents in §11, and the owner's desktop demo.

Demo on `step4a`: `acceptance.ts --real-turn --codex --pi --peer` all pass; a link-started Codex task's `git push`
asks on its thread and runs after approval, and a second push asks again; the leak check reports zero; the egress log
shows only the proxy's host; a deliberately leaked key (a stage-only fault route writes the key into a file in the repo
through the Container) is redacted by the sync guard and fails the leak check, which then passes after the redaction.
The owner's desktop app (pin or newer) runs one Codex and one Pi turn with an approval each.

Evidence: `m6-acceptance.json`, `m6-leak.json`, `m6-egress.json`, `m6-linked-push.json`, `m6-desktop-*.png`, and the
bump job's run on the branch (`gh workflow run bump.yml --ref step-4a`) with the new flags.

## 9. Tests

| Kind | What |
|---|---|
| Unit (Vitest, Node) | the channel's handle and `ProcessHost` (fake exec), the router's routes and refusals, the `processGroup` Shadow's registry, CLI profiles (argv, env allowlist, Codex `-c`, `models.json` from a catalog fixture), the Codex request guard, pi's forced mode, extension bridge and plan rule, the key route's gate and nonce, the leak scanner's token extraction and hash compare, the sync guard's redaction, the CLI manifest against the Dockerfile and against t3's compatibility manifest, the drivers' snapshots |
| Node with t3's adapters | t3's Codex and Pi adapters through our factory and spawner against t3's replay kits (no model, no Container) |
| Node with real CLIs in Docker | `bun run test:docker`: the built image's `codex` and `pi` with the profiles, a scripted fake proxy and a stub `computer.internal`: a tool turn each, resume after `docker restart` with the synced directory as a volume, no key on disk or in `/proc` |
| Deployed acceptance | `acceptance.ts --codex`: clone the fixture, a Codex turn at `approval-required` with an edit and `bash test.sh` approved, the diff, the Container stopped, a second turn that recalls the first, the leak check, the egress log (test stages), the key route refused with no CLI alive. `--pi`: the same for pi on a Claude model. `--peer` gains the CLI case of §5.4 |
| Nightly bump | `acceptance --real-turn --terminal --worktree --peer --codex --pi` on the bump stage, `test:docker`, and the compatibility test (a raised minimum fails the bump with "bump the CLI in `clis.ts`") |

## 10. Risks and unknowns

| # | Risk | Settled by | If it goes wrong |
|---|---|---|---|
| R1 | Long-lived exec breaks or loses streams | P1, M1 | ADR-0015's considered supervisor daemon; re-plan |
| R2 | Commissary's Responses API cannot drive Codex's tools | P3 | Codex lists only what works; if nothing does, OD-2 |
| R3 | No user namespaces: Codex without a sandbox | P2 | the fail-closed table (§5.1); documented in ADR-0015 |
| R4 | t3's Pi permission hook fails open (missing mode, missing extension) | design (§5.2), M4 tests | the spawn is refused rather than run unguarded |
| R5 | `process.kill` in t3's Pi stop path | P6, the Shadow | — |
| R6 | CLI state on the FUSE mount (SQLite, large rollouts) | P8 | Container-only database; rollouts stay synced |
| R7 | Two CLIs in one thread's Workspace after an Environment restart | design (epoch kill), M5 | — |
| R8 | Container holds cost more than planned | M5's logs | Patch 0003 (10-minute release) |
| R9 | 3 GiB is not enough | P9 | OD-1 |
| R10 | The agent prints the key into its transcript (A′'s residual) | sync guard, leak check, the key's own limits | redaction, the error log; the owner revokes the key |
| R11 | A CLI calls a vendor host by default (update checks, telemetry, ChatGPT-only features) | P10 | settings fixed in profiles and pinned by tests |
| R12 | The adapters' bundle or boot breaks in workerd | P6 | a counted shim or Shadow |
| R13 | t3 cannot take a request injected beside a CLI's own (D1 for CLIs) | M6 | refuse linked CLI pushes, reported |
| R14 | t3 moves its Codex or Pi internals under our registrations | the bump's typecheck, `test:docker`, `--codex`/`--pi` | fragility entries U29–U32 (§13) |
| R15 | A cold Container start under t3's open timeouts | P7 | spawn returns only once the process runs; if `initialize` still times out, the open is retried once by the wrapper |

## 11. Documents

- **ADR-0015** refinement: the channel as built (push, not a stream; epochs; the hold and its bounds), the readiness
  wrappers, the mode table with P2's evidence, the CLI manifest; the title's "Codex in managed mode" corrected.
- **ADR-0016** refinement: A′ as built (both helpers, the route and its gate, the definitions and proofs of §4.7 and
  §4.8, the residual and its hardening), with M0 and M6 evidence; the open question closed.
- **ADR-0001** counts (Shadows 2; Patches 2 or 3).
- `docs/parity.md`: Codex and Pi CLI rows → W; provider settings for CLIs P (launch args ignored); t3's tools for CLI
  agents M (ticket).
- `docs/upstream-fragility.md`: U29–U32 (§13), and the bump table's rows for `test:docker` and the compatibility test.
- `docs/model-proxy.md` (§M2), `docs/cost.md` (CLI holds; F3 waits for CLI data), `README.md` (status, the second
  key), `GLOSSARY.md` (**Process channel**, **CLI profile**, **Key helper**).
- `docs/steps/step-4a.md`: the report.

## 12. Owner decisions and actions

Decisions (rare, and two of the three only if a probe says so):

- **OD-1 (only if P9 fails).** The Container from 3 GiB to 4 GiB for every Workspace: about a third more per
  Container-hour (`docs/cost.md`). Recommended only on P9's numbers.
- **OD-2 (only if P3 fails).** If Commissary's Responses API cannot run Codex's tool turns: fix it in Commissary (the
  owner's project) before M3, or ship Codex limited to the models that work. Recommended: fix in Commissary.
- **OD-3 (confirm).** CLI agents get no t3 tools (MCP) in 4a: t3 hands its per-thread bearer to the CLI's process,
  which ADR-0022 rules out for Containers. Bringing them back means a relay through the egress host with a Handle the
  Workspace DO swaps for the bearer: a follow-up ticket after 4b. Recommended: confirm the deferral.

Actions:

1. **Scope `COMMISSARY_CONTAINER_API_KEY` in Commissary** before M2's stage run: an empty tool scope (models only), its
   own spend limit, optionally an expiry; confirm it is not the key in `MODEL_PROXY_API_KEY`.
2. If the key is ever revoked or rotated: update `dev.env`, the `prod` environment (`bun run --cwd infra ci:setup`) and
   the `bump` environment (`gh secret set COMMISSARY_CONTAINER_API_KEY --env bump`).
3. One session at the desktop near the end of M6 (a Codex and a Pi turn with an approval each), or let the agent drive
   the desktop app as in step 3.

## 13. Upstream fragility, new entries

- **U29. Our Codex registration and client factory.** Restates `layerAppServerClientFactory`; calls
  `createCodexAdapterV2`, `codexAppServerArgs`, `codexAppServerEnvironment`; rewrites `turn/start` and `thread/*`
  params by name. Breaks on a renamed export (typecheck), a new spawn-time requirement, or new param names (silent:
  the guard must fail closed on a `turn/start` it cannot read, by refusing it). Detection: typecheck, the replay test,
  `--codex`.
- **U30. Our Pi registration, the extension bridge and `processGroup.ts`.** Relies on `buildPiRpcLaunch`'s argv and env
  names, `PI_T3_MCP_EXTENSION_SOURCE`, the extension's mode variable, `rpc.ts` signalling through
  `signalProcessGroup`. Breaks when t3 renames them or stops importing the module (silent: the Shadow would not
  apply; T5's build report asserts it does). Detection: the content check refuses spawns; `--pi`.
- **U31. CLI versions against t3's compatibility manifest.** A nightly raising a minimum fails the bump's test.
- **U32. The CLIs' own configuration surfaces.** Codex `-c` keys, the provider `auth` command, pi's `models.json`
  and environment variables move with the CLI versions in `clis.ts`, not with t3: re-run `test:docker` and P10's egress
  check on every CLI bump.
