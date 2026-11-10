# Step 2a, part 1: plan (Durable agents on the proxy key)

Date: 2026-11-10. Branch `step-2a`, from `main` at bc956f4. t3code pinned at `v0.1.9-nightly.20261110.4478`.
cloudpid read at `ae5a7b73`. pi-durable read at `/tmp/ref/pi` (`packages/durable` 1.5.2).

This is a plan to review, not a report. It works inside the settled ADRs (0003, 0004, 0005, 0008, 0009, 0012,
0013, 0014, 0015, 0016, 0018) and the plan's row for 2a part 1. Where it refines an ADR, it says so in
[Refinements to the ADRs](#refinements-to-the-adrs). Owner decisions and actions are collected at the end in
[Owner decisions and actions](#owner-decisions-and-actions).

**Exit criteria (from `docs/plan.md`).** From the stock desktop client: clone a repo, run a turn that edits files
and runs `bash`, approve a tool call, see the diff, push and open a PR. An Environment restart mid-turn recovers
by continuation.

**Checks the plan names for 2a.** The pi-durable version rule (task 1, M0). How entangled cloudpid's extension
slices are (measured in M0 while copying them, reported in M3). Whether a `setup-token` token and the managed
ChatGPT token work through pi-ai belongs to part 2, but M1 records what pi-ai's `anthropic` and `openai-codex`
providers need, so part 2 starts from facts.

---

## 1. Layout

### New apps and packages

| Path | What it is | Origin |
|---|---|---|
| `apps/agents` | The `agents` Worker (ADR-0014): `SessionDO` (one per t3 thread), `WorkspaceDO` (one per Workspace, with the Container binding), `ContainerBudget` (a singleton DO that leases Container starts, max 3), a `WorkspaceShellProxy` entrypoint for the Worker Shell, and a default `fetch` that answers 404. Its own `build.ts` and `alchemy.run.ts` resources, deployed by `scripts/stage.ts` with the environment Worker. | new; the Workspace DO adapted from cloudpid |
| `apps/sandbox-image` | The Container image (Dockerfile, supervisor, memory guard, mise base toolchains, bootstrap and clone scripts). | copied from cloudpid, trimmed (section 5) |
| `packages/effect-durable` | Effect around pi-durable: `defineEffectTool`, `effectHook`, `frozenSection`, `effectTask`, `reachedWait`, the `Harness` facade, `sqlite` migrations. | copied whole, with its tests |
| `packages/computer-env` | `ComputerExecutionEnv`: pi-durable's `ExecutionEnv` over the Workspace DO, and the host half the Workspace DO serves. | copied whole, with its tests |
| `packages/agent-extensions` | The v1 toolset's extensions: `coding-tools`, `bash-routing`, `files`, `agents-md` (+ `agents-md-discovery`), `instructions`, and the helpers they import (`call-diff`, `images`, `result-bounds`, `stored-bytes`, `outputs` (trimmed), `conversation-target`, `harness`). Plus our own `permissions` extension (runtime modes and approvals, section 3). | copied from cloudpid `packages/extensions`, trimmed; `permissions` new, its wait adapted from cloudpid's `approvals.ts` |
| `packages/models` | The static model list in pi's `models.json` shape and the pi-ai `Model` objects built from it with the proxy's base URL. Shared by the Session DO (agents) and the provider (environment), so neither imports the other. | new; ids from cloudpid's `FALLBACK_CATALOG` and the owner's proxy |
| `packages/session-protocol` | Effect Schemas and TypeScript interfaces for the Session↔Environment contract (section 2): the push payload, the command inputs and answers, the cursor. Imported by both Workers. | new |
| `packages/workspace-client` | Schemas and a typed client for the Environment↔Workspace contract (section 2): file operations, search, isomorphic-git operations, Container git, provisioning. The environment Worker's Layers call the Workspace DO only through it. | new |
| `packages/github-app` | GitHub App JWT signing (RS256 through WebCrypto, PKCS#1 wrapped as PKCS#8), installation listing, and minting tokens with an explicit permission list and `repositories`. | copied from cloudpid `apps/server/src/github/app.ts`, `request.ts`, `config.ts`, and `packages/config/src/github-permissions.ts` |
| `packages/provider-pi-durable` | The t3 provider: a `ProviderDriver` (kind `piDurable`, display name "Pi (cloud)"), its `ProviderAdapterV2`, the differ, its `ProviderTextGeneration`, the snapshot (models from `packages/models`, thinking options through t3's `piModelCapabilities`), and the capabilities object. Imports only `@t3tools/provider-core/server/*`, contracts and shared, as t3's provider packages do. | new; shapes taken from `t3code/packages/provider-pi/src/server/*` |
| `packages/worker-build` | The Rolldown options alchemy uses (Cloudflare plugin, minify, `strictExecutionOrder`, `lazyBarrel`, `inlineConst`), lifted out of `apps/environment/build.ts`, so `apps/agents/build.ts` bundles the same way and uploads with `bundle: false` (ADR-0020). | moved, not new code |
| `infra/github-app-setup.ts`, `infra/src/github-app.ts` | `bun run --cwd infra github-app:setup`: the GitHub App's manifest flow (section 6). | copied from cloudpid, renamed `T3FLARE_*` |

Dependency patches (bun `patchedDependencies`, not t3 Patches) live in `patches/deps/`, and
`scripts/gen-workspace.ts` merges them after t3's generated ones. Expected: `@alchemy.run/cloudflare@2.0.0-beta.85`
(cloudpid's: Container enablement for Workers that bind each other, and the deployments-read retry), and
`@earendil-works/pi-durable@1.5.0` only if task 1 pins it. `@cloudflare/computer`'s `remount` patch is for
cloudpid's Skill mounts and is not taken.

### How the environment Worker uses them

Everything below is a Layer in `apps/environment/src/t3/composition.ts`, kept in a new
`apps/environment/src/agents/` directory, unless marked otherwise. Goal for the step: **0 new Patches, at most 2
new Shadows**; the build report counts them.

| t3 service or seam | Our Layer | Notes |
|---|---|---|
| `ProviderInstanceRegistry` (via `ProviderInstanceRegistryHydration.layer`) | ours, restating its ~60 lines with `drivers: [PiDurableDriver]` and our `deriveProviderInstanceConfigMap` (default instance for our driver) | The stock drivers come out for part 1: none can run in the DO, their probes only add spawn attempts and a "not installed" banner. CLI drivers return in 4a/4b with readiness wrappers (ADR-0015). Threads that named a removed instance show it as unavailable, as t3 does for a policy-blocked driver. |
| Effect `FileSystem` (platform) | a routing `FileSystem`: `/w/<ws>/…` to the Workspace DO through `workspace-client`, everything else to the State directory (ADR-0007) | Makes the stock `WorkspaceFileSystem`, `WorkspacePaths`, `KnownWorkspaces` and t3's attachment and project-file reads work on Workspaces unchanged. `/w` itself lists the Workspaces the Environment DO's registry holds. |
| `HostProcess.HomeDirectory` | `/w` | So the client's browse and its default clone destination (`~/<repo>`) land on `/w/<repo>`. |
| `WorkspaceEntries` | ours: `browse`, `list`, `search`, `searchContents`, `listIgnoredFiles` over the Workspace DO's `readdir`/`find`/`grep` (computer's), never the Container | The stock one needs fff's native index and `git ls-files`. |
| `VcsProcess` (also t3's `SourceControlHost.process`) | ours: the argv router (below) | Replaces `VcsProcess.layer` at the composition root. |
| `GitVcsDriver` and `VcsDriver` | the stock implementation wrapped: for a cwd under `/w`, `checkpoints.*`, `status`, `statusDetailsLocal`, `detectRepository`, `isInsideWorkTree`, `listWorkspaceFiles`, `filterIgnoredPaths`, `initRepository`/`initRepo` go to the Workspace DO (isomorphic-git, ADR-0009 items 1–2); every other method stays stock and reaches git through `VcsProcess` (ADR-0009 item 3) | One wrapped layer value replaces each `GitVcsDriver.layer` use in the composition. |
| `VcsStatusBroadcaster.layerAutomaticFetchInterval` | a constant "off" | ADR-0009: no automatic background fetch. |
| `ChildProcessSpawner` | unchanged: every spawn fails fast as "not found" | The rule: nothing outside a Workspace spawns, and no probe starts a Container. Git and `gh` reach a Container only through `VcsProcess`, by cwd. |
| `TextGeneration` | stock; it routes to the instance's `textGeneration`, which is our `ProviderTextGeneration` calling the model through the proxy from the Environment DO (pi-ai `complete`) | The plan's "cloud `TextGeneration` Layer" is our driver's text generation; no Layer swap is needed. Review guides stay refused (t3 asks for Codex or Claude). |
| `SourceControlRepositoryService` (clone) | the stock one wrapped: `prepareClone`/`cloneRepository` take a destination under `/w` with exactly one segment (the Workspace id), register the Workspace, and have the Workspace DO clone in its Container with a token for that one repo | Provided in our composition already, so a wrapper Layer is enough. A ghq-style nested destination is refused with a clear message. |
| `ManagedProjectFolders` (New project) | **not reachable by Layer**: it is built inside `runtimeLayer.layerProduction`'s private graph. M2 first tries routing (its `git init`/`commit` go through `GitVcsDriver.execute` → `VcsProcess`, its folder through `FileSystem`); if its `baseDir/projects` root cannot map onto `/w`, a Shadow of `ManagedProjectFolders.ts` (counted) sets the root to `/w` and provisions through `workspace-client`. Scratch threads stay unavailable. | Not on the exit criteria's path (clone is); kept small. |
| GitHub credentials (`GitHubCredentials` is built inside the GitHub driver) | none: the `VcsProcess` router answers `gh auth token --hostname github.com` itself with a token the Environment DO mints | t3 already asks `gh` for a token through `SourceControlHost.process`; answering that argv is our seam. |
| Session pushes | `SessionSink`, a service our composition builds and `Runtime` exposes, called by `EnvironmentDO.sessionPush` | Step 1's note: expose what 2a needs from `composition.ts` deliberately. |

**The `VcsProcess` router.** By command and cwd, in order:

1. `gh auth token [--hostname H] [--user U]` → stdout the Environment-side GitHub token (section 6), exit 0.
2. `git …` with cwd under `/w/<ws>` → the Workspace DO's `git` (real git in its Container, with a per-repo token
   in the command's environment for network operations).
3. `gh …` with cwd under `/w/<ws>` → the same Container, `gh` with `GH_TOKEN` for that repo (only if M4 finds t3
   shells out to `gh` for a PR operation; t3's GitHub provider mostly calls the GraphQL and REST APIs).
4. Anything else → `VcsProcessSpawnError` with a `NotFound` cause, at once, as today.

### The agents Worker

- `SessionDO`: one pi-durable Harness (`openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" })`), its
  root conversation, the v1 extensions, `HarnessOptions.env` building a `ComputerExecutionEnv` on its Workspace.
  Named `thread:<t3 threadId>` (`idFromName`). Host rules from cloudpid's overview (not its 4,700-line host):
  call `resume()` from the constructor and the alarm; arm the alarm before admitting work; a 60 s heartbeat while
  a task is live; handle `task_interrupted` with `restart_limit` by withdrawing the call's pending approval. One
  alarm, computed in one place from: the heartbeat, the turn deadline (2 h), and a push retry.
- `WorkspaceDO`: one `@cloudflare/computer` Workspace (SQLite VFS) and its Container, adapted from cloudpid's
  `Workspace.ts` (1,682 lines) keeping launch, idle stop, snapshots, the bootstrap, Container git, isomorphic-git
  status/changes, redaction, and the Worker Shell backend; dropping Skills, MCP bridge, Builds, spares, previews,
  comparisons, runs, secrets and notify. Named by Workspace id. One alarm: idle stop and snapshot.
- `ContainerBudget`: a singleton DO; a Workspace DO leases a slot before `ctx.container.start` and releases it at
  stop; a lease expires after its holder's idle time plus a margin, so a lost release does not leak a slot.
- Bindings: `SESSIONS`, `WORKSPACES`, `CONTAINER_BUDGET` (own classes), `ENVIRONMENT` (the environment Worker's
  `EnvironmentDO`, by `scriptName`), `LOADER` (Worker Loader, for the Worker Shell), the Container, and the secrets
  `MODEL_PROXY_API_KEY`, plus `MODEL_PROXY_URL`. The environment Worker gains `SESSIONS` and `WORKSPACES` (by
  `scriptName`), `T3FLARE_GITHUB_APP_ID`, `T3FLARE_GITHUB_APP_PRIVATE_KEY`, `MODEL_PROXY_URL` and
  `MODEL_PROXY_API_KEY`. The two Workers bind each other; see risk R2.
- Deploys: default deferred update (Sessions survive by design, ADR-0014). Worker names fixed:
  `t3flare-agents-<stage>`, `t3flare-environment-<stage>`. `scripts/stage.ts` gains stage `step2a`.

---

## 2. Contracts

### Session ↔ Environment (DO RPC, ADR-0005)

**Identity.** One Session per t3 thread. The provider thread's `nativeThreadRef` is
`{ driver: "piDurable", nativeId: "thread:<threadId>", strength: "strong" }`: t3's restart continuation requires a
strong native ref. The Session's root conversation is the provider thread.

**Commands: Environment → Session** (`SESSIONS.get(idFromName(nativeId))`, RPC methods on `SessionDO`). Each
carries an idempotency key and answers once applied; none is called from inside a SQL transaction (ADR-0005's
rule; the adapter calls them from its own fibers, outside t3's `withTransaction`).

| Method | Input | Answer |
|---|---|---|
| `open` | `threadId`, `workspaceId`, `cwd`, `runtimeMode`, `model`, `thinking` | `{ sessionId, cursor, busy }`; creates the Harness on first call |
| `submitTurn` | `providerTurnId` (key), `runId`, `attemptId`, `text`, `images` (inline, bounded), `model`, `thinking`, `runtimeMode` | `{ submissionId }`; `configure`s the root agent, then `submit` |
| `steer` | `providerTurnId`, key, `text`, `images` | `{ submissionId }` (pi-durable steer: joins the run at its next boundary) |
| `abort` | `providerTurnId` or `all: true`, `reason` | `{ aborted: boolean }`; also used by `resumeThread` after an Environment restart (ADR-0004) |
| `answer` | `requestId`, `decision` (`accept`, `acceptForSession`, `decline`, `cancel`), `feedback?` | `{ applied: boolean }` (false when the request is gone) |
| `snapshot` | `fromEntry?` | the whole state the differ needs (below), from `fromEntry` on |
| `close` | | stops pushing until the next `open`; the Harness keeps its state |

**Push: Session → Environment** (`ENVIRONMENT.get(idFromName("environment")).sessionPush(push)`). The Session
observes its root conversation (`Conversation.watch`), coalesces commits for about 100 ms while streaming, and
sends:

```ts
type SessionPush = {
  sessionId: string;          // "thread:<threadId>"
  epoch: string;              // random per Harness creation; a new epoch resets the adapter's cursor
  seq: number;                // durable counter, +1 per push
  prevSeq: number;            // seq of the previous push this Session sent
  entries: EntryRecord[];     // committed transcript entries after the last pushed entry, in id order, bounded (256 KiB)
  more: boolean;              // entries were cut at the bound: the adapter pulls a snapshot
  live: LiveStateSlim;        // pi.live without tool output, nested tools or partial tool arguments
  agent: { model; thinking }; // pi.agent's selection
  usage: UsageSlim;           // pi.usage totals and the last response's usage
  inbox: { pending: number }; // queued submissions
  approvals: PendingApproval[]; // our permissions extension's pending requests (section 3)
  turns: { [providerTurnId]: { submissionId; status: "queued" | "running" | "answered" | "failed" | "aborted" } };
};
```

The answer is `{ ok: true } | { ok: true, wantSnapshot: true }`. A push that fails (the Environment resetting) is
retried from the Session's alarm with backoff; the push itself wakes the Environment (the Session is the durable
party). `sessionPush` boots t3 if it is not running, then hands the push to `SessionSink`, which routes it to the
adapter's open provider session for that thread. With no open provider session the push is acknowledged and
dropped: the Session keeps its state, and the adapter pulls a snapshot when it opens one.

**Cursor and gaps.** The adapter stores, per Session, `{ epoch, seq, lastEntry }` in the Environment DO's
key-value storage after each applied push. A push with another `epoch`, or `prevSeq !== seq`, or `more: true`
makes the adapter call `snapshot({ fromEntry: lastEntry })` and re-diff. Every event the differ emits uses an id
derived from pi-durable's ids (section 3), so re-applying a range emits the same upserts, and at-least-once is
enough.

### Environment ↔ Workspace (DO RPC, through `packages/workspace-client`)

Called by the environment Worker's Layers (and by the Session's `ComputerExecutionEnv`, through
`computer-env`'s own wire for the agent's file tools). Named `WORKSPACES.get(idFromName(workspaceId))`.

| Group | Methods | Container? |
|---|---|---|
| Files | `stat`, `readFile(path, range?)`, `writeFile`, `readDirectory`, `makeDirectory`, `remove`, `rename`, `exists` | never (computer's VFS) |
| Search | `readdir`, `find(glob, limit)`, `grep(pattern, options)` | never |
| Git, in the DO (isomorphic-git, ADR-0009) | `detectRepository`, `status` (branch, upstream, files, and for a large repo the last real status plus the journal of written paths), `listFiles`, `filterIgnored`, `init`, `checkpoint.capture/has/restore/diff/listAuthoredPaths/delete` | no for repos within the guard (2,000 tracked files, 16 MB of packs, no `.gitattributes` diff rules); above it, checkpoint ops run real git in the Container (they run at turn boundaries, when the turn is using the Workspace anyway), and passive status serves the last real status plus the journal |
| Git, real | `git({ argv, cwd, stdin?, env?, timeoutMs })` → `{ exitCode, stdout, stderr, truncated }` | yes; starts it |
| Provisioning | `provision({ workspaceId, kind: "clone", repo: { host, owner, name, cloneUrl, branch? } })` with progress lines; `provision({ kind: "init" })`; `info()` | clone: yes; init: no |
| Container | `containerState()`, `stopContainer()` | |

The Workspace DO gets a GitHub token for its repo by asking the Environment DO (`ENVIRONMENT…githubToken({
workspaceId })`), which answers only for the repo its registry lists for that Workspace (section 6).

The Environment DO keeps a small registry table (our own, beside t3's): `workspaces(id, repo_host, repo_owner,
repo_name, created_at, state)`. It answers `/w` listings and token requests.

---

## 3. The differ and turn liveness

### What it reads

pi-durable's conversation view: committed transcript entries (`EntryRecord`s with ids), and the documents
`pi.live` (`run`, `generation` with its throttled partial `message` and `retry`, `tools` slots with `status`,
`runFailure`), `pi.agent`, `pi.usage`, `pi.inbox`, plus our `t3flare.approvals` document. It never reads an event
feed (ADR-0005).

### Mapping to `ProviderAdapterV2Event`s

| pi-durable state | t3 event | Id |
|---|---|---|
| `open` answered | `provider_session.updated` (`ready`), `provider_thread.updated` (`active`, strong native ref) | session id from t3; thread from `nativeId` |
| our `submitTurn`'s submission placed, `pi.live.run` present with it in `inputs` | `provider_turn.updated` `running` | `providerTurnId` from t3's `startTurn` (kept with the submission) |
| `generation.message` partial, text blocks | `turn_item.updated` `assistant_message` (streaming), then `message.updated` when its entry commits | `ti:<sessionId>:<entryId or "live:"+taskId+attempt>:<block>`; the live id is replaced by the entry's when it commits, with the same t3 item id kept in the adapter's map |
| thinking blocks | `turn_item.updated` `reasoning` | as above |
| tool call (`tools` slot, then its result entry) | `turn_item.updated`: `bash` → `command_execution` (command, exit, bounded final output); `edit`/`write` → `file_change` (path, the call's recorded patch); `read`, `ls`, `find`, `grep`, `image` → `dynamic_tool`; status from the slot, result from the entry | `ti:<sessionId>:call:<callId>` |
| pending approval in `t3flare.approvals` | `runtime_request.updated` (`approval_request`, kind `command` for `bash`, `file-change` for `edit`/`write`; `responseCapability: { type: "live", providerSessionId }`) plus its `node.updated` and `approval_request` turn item, as t3's Pi adapter emits them | `rr:<sessionId>:<callId>` |
| approval answered or withdrawn | `runtime_request.updated` resolved / cancelled | same |
| `pi.usage` | usage on `provider_turn.updated` (input, output, cache read/write, cost) and `provider_thread.updated`'s context usage, as the Pi adapter reports `get_session_stats` | |
| run ends with an answer, submission settled `answered` | `turn.terminal` `completed`, `threadDisposition: reusable` | |
| `runFailure.reason` `aborted` | `turn.terminal` `interrupted` (our abort for Stop) or `cancelled` (abort on re-open after a restart) | |
| `model_error` | `turn.terminal` `failed`; classified `usage_limit` (HTTP 429, a quota or rate-limit body, with the reset time from `retry-after`/`anthropic-ratelimit-*-reset` when the error carries it) else `provider_error`; the error text is never copied raw (t3's Pi adapter keeps only a leading HTTP status) | |
| `restart_limit`, `faulted`, `orphaned`, `interrupted`, `no_model`, `turn_limit` | `turn.terminal` `failed` with a fixed reason; `broken` only for `faulted`/`orphaned` | |
| our 2 h deadline | the Session aborts the run with reason `turn_deadline`; `turn.terminal` `failed`, reason "turn exceeded 2 hours" | |
| `generation.retry` | nothing (t3 shows the turn as running) | |

Dropped, per the plan's differ scope: subagents, nested tools, live tool output (`command_output.delta`),
compactions (a manual or automatic compaction shows as nothing; failure as a `system_notice` item), prompt
suggestions, plans and todos, MCP apps.

**Capabilities** (`OrchestrationV2ProviderCapabilities`): `runtimePolicy.enforcement: "client-boundary"` (the
hook runs in the agent harness, as Pi's does); one provider thread per session; model switch in session yes
(`configure` per turn); runtime-mode switch in session yes (the mode rides on each `submitTurn`);
`pendingRequestsSurviveRestart: false`; threads: create empty, read snapshot, native thread id yes; rollback and
fork no (deferred by the plan); turns: interrupt yes, active steering yes, queued messages yes,
`terminalStatusQuality: "strong"`; streaming text and reasoning yes, tool output no; tools: item ids, started and
completed yes; approvals: command and file-change yes, live-only, native request ids; planning, subagents and
structured questions no; context: synthetic user context and handoff summaries yes; checkpointing: the app
checkpoints the file system, the provider does not roll back; identity: thread and item ids strong, turn ids weak.
`canResumeAfterRestart: true`.

### Runtime modes and approvals

Our `permissions` extension is a `beforeTool` hook in the Session (ADR settled: runtime modes via a beforeTool
hook, default `full-access`). The driver offers `supportedRuntimeModes: ["approval-required",
"auto-accept-edits", "full-access"]`, `showInteractionModeToggle: false`.

- `full-access`: every call runs.
- `auto-accept-edits`: `read`, `ls`, `find`, `grep`, `edit`, `write`, `image` run; `bash` asks.
- `approval-required`: read-only tools run; `bash`, `edit`, `write` ask.
- An ask writes a pending request into the conversation's `t3flare.approvals` document (call id, tool, a bounded
  summary: the command, or the path with the patch's counts), marks the wait as progress (`reachedWait`), and waits
  for the answer, which `answer` writes into the same document. `acceptForSession` adds the tool to the Session's
  allow-list for its lifetime. A decline returns a tool error result ("Declined by the owner", with feedback).
- **Re-raised after a Session restart.** A Session DO evicted while it waits reruns the call; the hook finds the
  stored request and waits again, and the next push carries it again with the same request id, so t3 still shows
  it. Its restart count starts over at each rerun (the `reachedWait` mark).
- **Environment restart while an approval waits.** t3's startup recovery expires live requests as
  `not_resumable`, and `RestartContinuation` does not continue a run that had a request pending, so the thread
  waits for the owner. On re-open the adapter aborts the Session's in-flight turn (ADR-0004), which withdraws the
  pending approval. Documented, not fixed.

### Turn liveness (step 1's requirement)

The Environment resets itself when it has no client socket, no request in flight, no open run or provider session
and no claimable outbox effect (`apps/environment/src/host/idle.ts`). A Durable agent turn is driven through t3's
own orchestrator: `startTurn` is called on a run that t3 has already marked `running`, and the run stays `running`
(or `waiting` while an approval is pending) until our adapter emits `turn.terminal`. So a Durable agent turn is a
live run in t3's projection for its whole life, and the idle check keeps the Environment up under it, without a
client. Three rules keep that true:

1. The Session never starts work the adapter did not submit (no unsolicited runs; t3's Pi adapter stops a session
   that does this, ours refuses in the Session).
2. The adapter emits `turn.terminal` only from committed Session state (a settled submission or a `runFailure`),
   never from a timeout of its own; the 2 h cap lives in the Session.
3. Pushes are what wakes a reset Environment; nothing in the Environment needs a timer for 2a, so the one alarm
   stays the host's (`#scheduleArmExpiry`, `checkIdle`). If 2a needs one after all, it joins that computation.

A test in M1 runs a turn with no client attached and checks with the admin `idle-check` route that the verdict is
"open work" for the turn's whole length (a long turn: a `bash` `sleep 90` under `full-access`), then that the
object resets after it ends.

### Restart recovery (exit criterion)

`POST /_t3flare/restart` (`ctx.abort()`) mid-turn. Expected sequence, each step asserted by
`scripts/restart-mid-turn.ts`: the Session's next push fails, retries, and boots t3; t3's recovery terminalizes the
run and stops the provider session; `RestartContinuation` dispatches the continue prompt (its conditions hold: the
provider thread has a strong native ref and is `active`, the session was not `stopped` or `error`, the provider
turn was `running`, nothing was pending); the orchestrator opens a provider session and calls `resumeThread`, where
the adapter calls the Session's `abort({ all: true, reason: "environment-restart" })` before `startTurn` submits
the continue prompt; the old turn's terminal pushes are ignored because their `providerTurnId` is not open; the new
turn completes.

---

## 4. What is copied from cloudpid

Copied files get a header naming their source (`cloudpid@ae5a7b73:<path>`) and are then ours. Tests come with
them and must pass in our tree.

| From cloudpid | To | How |
|---|---|---|
| `packages/effect-durable/src/**` | `packages/effect-durable` | whole |
| `packages/computer-env/src/**` | `packages/computer-env` | whole |
| `packages/extensions/src/{coding-tools,bash-routing,files,agents-md,agents-md-discovery,instructions,call-diff,images,result-bounds,stored-bytes,conversation-target,harness}.ts`, the parts of `outputs.ts` they use | `packages/agent-extensions` | trimmed; anything reaching Registry, Environments, Secrets, MCP or Skills is cut |
| `packages/extensions/src/approvals.ts` | `packages/agent-extensions/src/permissions.ts` | the durable wait and answer only; `approval-cores.ts` and `approval-tools.ts` (Agent changes) are not taken |
| `apps/server/src/workspace/{Workspace,launch,idle,snapshots,toolchains,per-launch-backend,redact,alarm,binding,resource,git,prepare,changes,changes.collect,changes.repos,changes.setup}.ts` | `apps/agents/src/workspace/` | adapted: one repo per Workspace at `/w/<ws>` (cloudpid: `/workspace/<repo>`), no Environments' settings (fixed defaults), tokens from the Environment DO |
| `apps/server/src/github/{app,request,config}.ts`, `packages/config/src/github-permissions.ts` | `packages/github-app` | as is, permissions tightened (section 6) |
| `apps/sandbox-image/image/{Dockerfile,supervise,cloudpid-memory-guard,command.bash,mise.toml}`, `src/{toolchains,workspaces,changes,supervisor,memory-guard,index}.ts` | `apps/sandbox-image` | trimmed (section 5) |
| `infra/github-app-setup.ts`, `infra/src/github-app.ts` | `infra/` | renamed, one GitHub environment (`bump`) |
| `patches/@alchemy.run__cloudflare@2.0.0-beta.85.patch` | `patches/deps/` | as is |
| `docs/architecture/overview.md` → *Session host* rules | `apps/agents/src/session/host.ts` | re-implemented small, not copied |

### Task 1: the pi-durable version

Run first, before any other copying lands:

1. In a scratch checkout, copy cloudpid's `packages/effect-durable` and give it the newest upstream
   `@earendil-works/pi-durable` (1.5.2 on npm; also `/tmp/ref/pi` `main` at 058496b), unpatched, with the
   `@earendil-works/pi-ai` and `chord` versions that release depends on, and our `effect` 4.1.2.
2. Run its typecheck and `vitest run`, and the `computer-env` tests the same way.
3. If both pass, use upstream unpatched. Otherwise pin exactly what cloudpid runs: `@earendil-works/pi-durable`
   1.5.0 with `patches/@earendil-works__pi-durable@1.5.0.patch`, and the `pi-ai`/`chord` versions cloudpid's
   `bun.lock` resolves, copied into `patches/deps/` and pinned in our root `package.json`.
4. Record the commands, versions and output in `docs/steps/step-2a/pi-durable-version.json`.

Expected (not assumed): upstream 1.5.2 has no `ToolExecutionApi.progressed` (cloudpid's #647 patch, which
`reachedWait` needs), so the typecheck fails and we pin 1.5.0 with the patch. The approvals' durable wait depends
on that mark.

---

## 5. The Container image

- **Base:** cloudpid's `apps/sandbox-image` Dockerfile: `ubuntu:26.04` pinned by digest, computerd pinned to our
  `@cloudflare/computer` version (a test keeps them equal), mise with the base toolchains preinstalled into its
  system directory (`git`, `gh`, Node LTS, pnpm, Bun, Python, uv), the everyday CLI tools, `build-essential`,
  earlyoom under the supervisor.
- **Dropped for part 1:** Docker (Start Scripts' services), the MCP bridge, `cloudpid-notify`, Builds, the Run and
  Comparison scripts. **Kept:** the bootstrap (toolchains, git identity, credential helper reading the command's
  token), the clone script (`prepareWorkspaceScript`, one repo, into `/w/<ws>`), the Container-git status script.
  CLI agents (4a/4b) add their binaries to this image later (ADR-0015: one image).
- **Instance size:** cloudpid's default `cpu-1` custom size (1 vCPU, 3 GiB memory, 12 GB disk), chosen at each
  `ctx.container.start({ instance })` under `schedulingPolicy: "durable_object"`. Idle stop after 2 minutes, with a
  snapshot when the disk changed; `setInactivityTimeout` set so a Container outlives a DO eviction only within
  that bound.
- **Build and push:** `Cloudflare.Container("WorkspaceContainer", { schedulingPolicy: "durable_object", context:
  apps/sandbox-image/image })` in the stage's alchemy stack, bound to the `WorkspaceDO` (`containers: [...]`).
  alchemy builds `linux/amd64` with the local Docker (29.5.2 here, under emulation on Apple Silicon) and pushes to
  Cloudflare's registry; it rebuilds only when the context changes. In CI the GitHub runner's Docker does the same.
- **`ci:setup` changes** (`infra/github.ts`): add `Workers Containers Write` to the `t3flare-ci-bump` token (the
  Container application and the image push; cloudpid's deploy token has it for the same reason). Add the GitHub
  variable `MODEL_PROXY_URL` to the `bump` environment, read from `~/.config/t3flare/dev.env` at `ci:setup` time;
  `MODEL_PROXY_API_KEY` is already a secret there. The GitHub App's two secrets are written into `bump` by
  `github-app:setup` (section 6), not by `ci:setup`. Then `ci:setup` is rerun with the `admin` profile (it updates
  the token in place). `.github/workflows/bump.yml` gains the new secrets and variable in its env.

---

## 6. The GitHub App

**The app.** `t3flare`, registered under the owner's account through GitHub's manifest flow, public (so it can
also be installed on an organization, as cloudpid's is), no webhook. Its own app, not cloudpid's (ADR-0013).

**Permissions.** The App: `contents: write`, `pull_requests: write`, `workflows: write`, `checks: read`,
`statuses: read`, `actions: read`, `issues: read`, `metadata: read`. Every token is minted with an explicit
permission list and explicit `repositories`:

- **Container tokens** (git and `gh` in a Workspace's Container, reachable by the agent): the Workspace's one repo;
  `contents: write`, `pull_requests: write`, `workflows: write`, `metadata: read`. One hour, cached by the
  Environment DO until about 45 minutes remain.
- **Environment tokens** (t3's PR features through `gh auth token`; never reach a Container or a Session): the
  repos of the Cloud Environment's Projects plus, during a clone, the repo being cloned; the App's read
  permissions plus `pull_requests: write`.

The private key is held by the environment Worker only (a secret), and the Environment DO is the only minter
(ADR-0018's broker). The Workspace DO asks for its repo's token over RPC.

**`github-app:setup`** (`bun run --cwd infra github-app:setup`), what the owner does, once, at the end of M0 so
the app exists before M2:

1. Run the command in a terminal on this machine (it needs `gh` signed in as the owner and a browser).
2. A browser tab opens on a local page that posts the manifest to GitHub. On GitHub's "Create GitHub App" page,
   check the name `t3flare` and click **Create GitHub App**. GitHub returns to the local page, which says to go
   back to the terminal.
3. The script writes `T3FLARE_GITHUB_APP_ID` and `T3FLARE_GITHUB_APP_PRIVATE_KEY` into
   `~/.config/t3flare/dev.env` (0600, outside the repo, beside `MODEL_PROXY_*`) and into the GitHub environment
   `bump` of `ian-pascoe/t3flare` (`gh secret set`, the value on stdin). Nothing is printed. A lost key is replaced
   from the app's settings page.
4. A second tab opens GitHub's install page. Install it on the owner's account with **Only select repositories**:
   the fixture repo (below) and any repo the cloud should work on now (more can be added later in GitHub's
   settings). Press Enter in the terminal; the script mints a token per installation to check it, and says so.

**Where the secrets are read.** Local stages: `scripts/stage.ts` reads `~/.config/t3flare/dev.env` and passes
`MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY`, `T3FLARE_GITHUB_APP_ID` and `T3FLARE_GITHUB_APP_PRIVATE_KEY` to alchemy
as environment variables (alchemy binds them as Worker secrets); it never prints them, and refuses to deploy a
stage without them. CI (`bump`): the GitHub environment's secrets and variable, passed the same way by the
workflow.

**Fixture repo.** `ian-pascoe/t3flare-fixture`, private, small (a README, a `src/` with a few files, a
`test.sh`), used by the acceptance test and the bump job: clone, a turn edits a file and runs `bash test.sh`,
push a branch `t3flare/acceptance-<run>`, open a PR, then close it and delete the branch.

---

## 7. Sub-milestones

All on the stage `step2a` (`bun scripts/stage.ts deploy step2a`), destroyed at the end of the step. Evidence goes
to `docs/steps/step-2a/` as the scripts' own JSON, plus screenshots. Each milestone ends with `bun run check`
passing and a commit.

### M0. Foundations: version, two Workers, a Container (no t3 changes yet)

- Task 1 (pi-durable version), recorded.
- Copy `effect-durable`, `computer-env`, `github-app`, the sandbox image; `apps/agents` skeleton with `SessionDO`
  (empty Harness, faux model from pi-durable's testing provider), `WorkspaceDO` (computer Workspace + Container),
  `ContainerBudget`; `packages/worker-build`; stage `step2a` in `stage.ts`, deploying both Workers.
- `infra/github.ts` token change and `MODEL_PROXY_URL` variable; rerun `ci:setup`. `github-app:setup` ported;
  the owner runs it (section 6) and the fixture repo is made.
- Measure and record: how much of each cloudpid extension slice comes along (files, lines, imports cut).
- **Exit evidence** (`m0-foundations.json`): both Workers deployed; an admin route `/_t3flare/check/agents` makes
  the Environment DO call a Session DO and a Workspace DO, and the Session call back into the Environment DO
  (both directions of the cross-Worker binding); the Workspace DO starts a Container, runs `git --version` and
  `mise ls`, reports its start time, and stops it; a fourth concurrent Container start is refused by
  `ContainerBudget`; a token minted for the fixture repo can `git ls-remote` it from the Container.

### M1. A Durable agent answers in the stock client (no tools)

- `packages/models`, `packages/session-protocol`, `packages/provider-pi-durable` (driver, adapter, differ for
  text, reasoning, turn lifecycle, usage, usage-limit classification; text generation); our hydration Layer; the
  `SessionSink`; `EnvironmentDO.sessionPush`; the Session host's push loop, cursor, `snapshot`, one alarm.
- Day 1: a stub driver deployed first, to settle R1 (how the stock client shows a driver kind it does not know).
- **Exit evidence:** in the stock web client, the composer offers "Pi (cloud)" with the static models and the
  thinking picker; a message streams text and reasoning; Stop interrupts; a steer joins the run; a thread gets a
  generated title (`m1-chat.png`, `m1-acceptance.json` from a headless turn through `/ws`); the no-client liveness
  test (section 3) passes (`m1-liveness.json`); differ unit tests pass on views recorded from the deployed
  Session (`packages/provider-pi-durable/test/fixtures/*.json`).

### M2. Workspaces: clone, files, status

- `packages/workspace-client`; the routing `FileSystem`, `WorkspaceEntries`, `HomeDirectory=/w`, the clone wrapper,
  the `VcsProcess` router (Container git), the `GitVcsDriver` wrapper (status and detection in the DO), the
  Environment DO's Workspace registry and GitHub token minting; New project by routing or one Shadow.
- **Exit evidence:** from the stock web client, *Add project → Clone* of the private fixture repo lands at
  `/w/t3flare-fixture`; the file tree, file view and `@` search work; the branch shows in the header; the
  Container stopped after the clone and passive status did not start it again (`m2-clone.json` with the Container
  start log; `m2-clone.png`). New project creates `/w/<name>` with an initial commit.

### M3. Tools, approvals, diffs

- `packages/agent-extensions` (v1 toolset on `ComputerExecutionEnv`: `read`, `write`, `edit`, `bash`, `image`,
  `ls`, `find`, `grep`, AGENTS.md and instructions sections, the Worker Shell with `bash` routing to the Container);
  the `permissions` extension; the differ's tool, approval and file-change mapping; checkpoint ops in the DO with
  isomorphic-git and a unified diff that matches git's.
- **Exit evidence:** a turn in the fixture project edits a file and runs `bash test.sh` (in the Container); in
  `approval-required` mode the `bash` call waits, Approve runs it, Decline returns the error; the turn's diff opens
  in the client's diff panel (`m3-turn.png`, `m3-approval.png`, `m3-diff.png`, `m3-acceptance.json`); an approval
  survives a Session DO restart mid-wait (workerd test plus one deployed run).

### M4. Push and PR

- The `gh auth token` answer, Environment tokens naming the Projects' repos, Container tokens through the
  credential helper, commit message and PR content through our text generation, and whatever M4's trace shows t3
  needs from `gh`.
- **Exit evidence:** from the client, *Commit, push and create PR* on the turn's branch opens a PR on the fixture
  repo (`m4-pr.json` with its URL, then closed and the branch deleted; `m4-pr.png`).

### M5. Recovery, guardrails, acceptance, report

- `scripts/restart-mid-turn.ts` (section 3), five runs in a row; the 2 h cap (tested with an override to 2
  minutes on the stage); `ContainerBudget` under load; the acceptance test extended; the bump job deploying both
  Workers and running a real turn.
- **Exit evidence** (the plan's exit criteria, in order, from the stock desktop client paired with the stage):
  clone, a turn that edits files and runs `bash`, an approved tool call, the diff, push and PR, and an Environment
  restart mid-turn that continues (`m5-desktop-*.png`, `m5-restart.json`, `m5-acceptance.json`,
  `m5-bump-report.json`). Then `docs/steps/step-2a.md` (the report), ADR updates, GLOSSARY and plan updates,
  stage destroyed.

### Tests

- **Unit (Node):** the differ on recorded views (a recorder admin route on the Session dumps each push; fixtures
  for a simple answer, multi-turn, interrupt, steer, a tool round, an approval approved and declined, a model
  error, a 429 with a reset time, a gap and snapshot); event ids stable under re-diff; capabilities and snapshot;
  the `VcsProcess` router's table; path routing; Environment token scoping.
- **Checkpoint fidelity (Node, real git):** for fixture repos, the DO's `checkpoint.diff` output compared with
  `git diff` of the same refs, byte for byte, after edits, adds, deletes, renames and binary files.
- **workerd (`@cloudflare/vitest-plugin`):** Session DO with pi-durable's faux provider (submit, abort, steer,
  answer, a restart mid-approval, the push loop against a fake sink with dropped and reordered pushes, the 2 h
  deadline via a short override); Workspace DO file ops and isomorphic-git ops on real DO storage (no Container in
  workerd); the copied packages' own workerd tests.
- **Deployed:** `scripts/acceptance.ts` gains `--real-turn`: clone the fixture (the App's installation covers it on
  both stages), run a turn with a small model under `approval-required`, approve one call, check the turn items,
  the checkpoint diff and the tool output; for `step2a` also push and PR. `scripts/restart-mid-turn.ts`. The bump
  job runs `--real-turn` without push.

### Cost guardrails

- At most 3 Containers at once (`ContainerBudget`; `max_instances` does not apply to the `durable_object` policy).
- A turn may run at most 2 hours (the Session's alarm aborts it; t3 shows a failed turn).
- Containers stop after 2 idle minutes; `cpu-1` size; a Container is never started by passive status, file views,
  search or probes.
- Test turns use a small model and a bounded output; the bump job's real turn is one turn on the fixture.
- Stages are destroyed at the end of the step; Containers and images go with them.

---

## 8. Risks and how each is settled early

| # | Risk | Settled by | Fallback |
|---|---|---|---|
| R1 | The stock client may hide or misdraw a driver kind it does not know (`piDurable`): no icon, read-only settings; the composer's picker is unverified | M1 day 1, a stub driver on the stage | Register as kind `pi` (our driver replaces the stock Pi driver, which cannot run here; the client draws Pi's icon and settings form, whose fields we ignore) |
| R2 | The two Workers bind each other's DOs (`scriptName`), a cycle on a fresh stage | M0's first deploy, with cloudpid's alchemy patch for cycle peers | Two-pass first deploy, or the Session reaches the Environment through a `WorkerEntrypoint` service binding |
| R3 | pi-durable version: upstream lacks the `progressed` mark | Task 1 | Pin cloudpid's 1.5.0 + patch (the rule) |
| R4 | Checkpoint diffs from isomorphic-git differ from git's text, which t3's client parses | M3's fidelity tests | Checkpoint ops on the Container's git while it runs, the DO for capture only |
| R5 | Sessions and Workspaces can share an isolate's 128 MB in the agents Worker (isomorphic-git on a big repo beside Harnesses) | M3 measures heap after a status of a 2,000-file repo with two Sessions live | Lower the isomorphic-git guard; if not enough, a third Worker for Workspaces, which would amend ADR-0014 (owner) |
| R6 | t3 may shell out to `gh` for a PR step, or call GitHub with a host token outside `gh auth token` | M4 traces every argv `VcsProcess` sees during commit-push-PR | Run that `gh` in the Workspace's Container with its repo token |
| R7 | `ManagedProjectFolders` is not reachable by a Layer | M2 | One Shadow (counted); New project is not on the exit path |
| R8 | pi-ai in the environment bundle (text generation) adds size or startup | M1 build report (`dist/build-report.json`) | Call the Messages API with `fetch` directly |
| R9 | The Worker Loader (Worker Shell) on this account and compatibility date | M3, first `bash` call | `bash-routing` sends every command to the Container |
| R10 | Restart ordering: pushes arriving while t3 boots, the old turn's terminal racing the continuation | M5's five-run script, plus the workerd fake-sink test | Tighten the adapter's open-turn filter |
| R11 | Image build time under amd64 emulation (local) and in CI | M0 measures the first and a cached build | Build on CI only; cache layers |
| R12 | t3's text-generation model setting defaults to a driver we removed | M1: t3 falls back to a capable instance; check the title and commit message paths | Seed the setting once from our composition |

No risk needs the owner now. R5's fallback would.

---

## Refinements to the ADRs

To be written into the ADRs with the step's report, not before:

- **ADR-0013:** "each scoped to the Workspace's one repo" holds for every token that reaches a Container. The
  Environment DO's own tokens (t3 asks `gh` for one per host) name the Projects' repos instead, never reach an
  agent, and carry the App's read permissions plus `pull_requests: write`. The private key lives only in the
  environment Worker, and the Environment DO mints for the Workspace DOs (ADR-0018's broker).
- **ADR-0009:** as built (which `GitVcsDriver` methods go to the DO), the guard values, and that checkpoint ops
  above the guard use the Container's git.
- **ADR-0005:** the push payload, epoch and sequence, and the snapshot call, as built.
- **ADR-0014:** confirmed or amended by R5's measurement; the Worker Shell's entrypoint lives in the agents
  Worker (we bundle ourselves, so its entry exports it).
- **ADR-0008:** Workspace ids are the single path segment under `/w`, which t3's client chooses as the clone
  directory.

---

## Owner decisions and actions

**Decisions:** none required to start. One would arise only if R5's fallback is needed (a third Worker).

**Actions, in the order they are needed:**

1. **Review this plan** and say "go".
2. **End of M0: run `bun run --cwd infra github-app:setup`** on this machine (about 5 minutes; section 6:
   confirm the app on GitHub's page, then install it on your account with *Only select repositories*, choosing
   `t3flare-fixture` and any repo you want the cloud to use now).
3. **Consent to creating `ian-pascoe/t3flare-fixture`** (private) on your account with `gh`, in M0. Say no and
   name an existing small repo instead if you prefer.
4. **`ci:setup` rerun:** I run it in M0 with the `admin` profile, as step 1 did, to add *Workers Containers
   Write* and `MODEL_PROXY_URL`. Say if you would rather run it yourself.
5. **End of M5: the desktop client.** The exit criteria name the stock desktop client. I will drive the web
   client (same client code) for the automated evidence and try the desktop app through desktop automation on this
   machine; if that cannot pair with the stage, you run the five steps once in the desktop app (about 10
   minutes) and I record the result.
