# Step 2a, part 1: plan (Durable agents on the proxy key)

Date: 2026-11-10. Branch `step-2a`, from `main` at bc956f4. t3code pinned at `v0.1.9-nightly.20261110.4478`.
cloudpid read at `ae5a7b73`. pi-durable read at `/tmp/ref/pi` (`packages/durable` 1.5.2).

This is a plan to review, not a report. It works inside the settled ADRs (0003, 0004, 0005, 0008, 0009, 0012,
0013, 0014, 0015, 0016, 0018) and the plan's row for 2a part 1. Where it refines an ADR, it says so in
[Refinements to the ADRs](#refinements-to-the-adrs). Owner decisions and actions are collected at the end.
Revisions 2 and 3 answer the plan reviews; their changes are listed in [Review changes](#review-changes-revision-2).

**Exit criteria (from `docs/plan.md`).** From the stock desktop client: clone a repo, run a turn that edits files
and runs `bash`, approve a tool call, see the diff, push and open a PR. An Environment restart mid-turn recovers
by continuation.

**Checks the plan names for 2a.** The pi-durable version rule (task 1, M0). How entangled cloudpid's extension
slices are (measured in M0 while copying them, reported in M3). Whether a `setup-token` token and the managed
ChatGPT token work through pi-ai belongs to part 2, but M1 records what pi-ai's `anthropic` and `openai-codex`
providers need, so part 2 starts from facts.

**Unverified facts, settled first.** Each has a named check in M0 or M1, before work depends on it: how the stock
client treats a driver kind it does not know (M0, step 0); the pi-durable version (M0, task 1); whether a
Workspace's Container can see its files at `/w/<ws>` (M0); what bindings a Worker Loader worker gets (M0); the
run's status in t3's projection while an approval is pending (M0 desk check, M1 test); Environment restart
mid-turn (end of M1, again in M5).

---

## 1. Layout

### New apps and packages

| Path | What it is | Origin |
|---|---|---|
| `apps/agents` | The `agents` Worker (ADR-0014): `SessionDO` (one per t3 thread), `WorkspaceDO` (one per Workspace, with the Container binding), `ContainerBudget` (a singleton DO that leases Container slots, max 3), the Worker Shell's `WorkspaceServiceProxy` entrypoint, and a default `fetch` that answers 404. Deployed with no public URL. Its folders: `src/session/`, `src/workspace/`, `src/extensions/` (the v1 toolset, copied from cloudpid's `packages/extensions` and trimmed, plus our `permissions` extension). Its own `build.ts`. | new; the Workspace DO adapted from cloudpid |
| `apps/sandbox-image` | The Container image (Dockerfile, supervisor, memory guard, mise base toolchains, bootstrap and clone scripts). | copied from cloudpid, trimmed (section 5) |
| `packages/effect-durable` | Effect around pi-durable: `defineEffectTool`, `effectHook`, `frozenSection`, `effectTask`, `reachedWait`, the `Harness` facade, `sqlite` migrations. | copied whole, with its tests |
| `packages/computer-env` | `ComputerExecutionEnv`: pi-durable's `ExecutionEnv` over the Workspace DO, and the host half the Workspace DO serves. | copied whole, with its tests; its `/workspace` constants stay (section 2, *Paths*) |
| `packages/models` | The static model list in pi's `models.json` shape and the pi-ai `Model` objects built from it with the proxy's base URL. Used by both Workers, so neither imports the other. | new; ids from cloudpid's `FALLBACK_CATALOG` and the owner's proxy |
| `packages/session-protocol` | Effect Schemas and interfaces for the Session↔Environment contract (section 2). Used by both Workers. | new |
| `packages/workspace-client` | Schemas and a typed client for the Environment↔Workspace contract (section 2), including the path translation. Used by the environment Worker's Layers and by the Workspace DO's server side. | new |
| `packages/github-app` | GitHub App JWT signing (RS256 through WebCrypto, PKCS#1 wrapped as PKCS#8), installation listing, minting tokens with an explicit permission list and `repositories`. A package because two places use it: the environment Worker and `infra/github-app-setup.ts` (which mints to check an installation). | copied from cloudpid `apps/server/src/github/{app,request,config}.ts` and `packages/config/src/github-permissions.ts` |
| `packages/worker-build` | The Rolldown options alchemy uses (Cloudflare plugin, minify, `strictExecutionOrder`, `lazyBarrel`, `inlineConst`), lifted out of `apps/environment/build.ts`, so `apps/agents/build.ts` bundles the same way and uploads with `bundle: false` (ADR-0020). | moved, not new code |
| `apps/environment/src/provider/` | The t3 provider, a folder of the environment Worker (its only user): a `ProviderDriver` (kind `piDurable`, display name "Pi (cloud)", settled in M0 step 0), its `ProviderAdapterV2`, the differ, its `ProviderTextGeneration`, the snapshot (models from `packages/models`, thinking options through t3's `piModelCapabilities`) and capabilities. Imports only t3's provider-core, contracts and shared, as t3's provider packages do. | new; shapes from `t3code/packages/provider-pi/src/server/*` |
| `apps/environment/src/agents/` | Our Layers for t3's seams (next table), the `SessionSink`, the Workspace registry, GitHub token minting. | new |
| `infra/github-app-setup.ts`, `infra/src/github-app.ts` | `bun run --cwd infra github-app:setup`: the GitHub App's manifest flow (section 6). | copied from cloudpid, renamed `T3FLARE_*` |

Dependency patches (bun `patchedDependencies`, not t3 Patches) live in `patches/deps/`, and
`scripts/gen-workspace.ts` merges them after t3's generated ones. Expected: `@alchemy.run/cloudflare@2.0.0-beta.85`
(cloudpid's: Container enablement for Workers that bind each other, and a deployments-read retry), and
`@earendil-works/pi-durable@1.5.0` if task 1 pins it. `@cloudflare/computer`'s `remount` patch serves cloudpid's
Skill mounts and is not taken.

### How the environment Worker uses them

Layers in `apps/environment/src/t3/composition.ts`, built in `apps/environment/src/agents/`, unless marked
otherwise. Budget for the step: **0 new Patches, at most 2 new Shadows**; the build report counts them. Expected:
1 Shadow (`builtInDrivers.ts`), and possibly a second (`ManagedProjectFolders.ts`).

| t3 service or seam | Ours | Notes |
|---|---|---|
| `provider/builtInDrivers.ts` | **Shadow**: `BUILT_IN_DRIVERS = [PiDurableDriver]`, `BUILT_IN_USAGE_DRIVERS = []`, `BuiltInDriversEnv` naming our driver's requirements | `BUILT_IN_DRIVERS` is read through `deriveProviderInstanceConfigMap` by the hydration and also by `provider/providerInstallation.ts:77` and `terminal/Manager.ts:1451`, so restating the hydration Layer would miss those and drift. With the Shadow, `ProviderInstanceRegistryHydration` stays stock. The stock drivers come out for part 1: none can run in the DO, and their probes only add spawn attempts and a "not installed" banner. CLI drivers return in 4a/4b (ADR-0015). |
| Effect `FileSystem` (platform) | a routing `FileSystem`: `/w/<ws>/…` to the Workspace DO through `workspace-client`; everything else to the State directory (ADR-0007) | For Effect callers: `WorkspacePaths`, `KnownWorkspaces`, t3's project-file reads. A path under `/w` whose Workspace id the registry does not list fails as not found before any DO is touched. `/w` itself lists the registry. |
| `WorkspaceFileSystem` | **ours** (`getMetadata`, `readFile`, `writeFile`) over `workspace-client`, with root containment (the resolved path must stay under its Workspace root; symlinks resolved by the Workspace DO) | The stock one imports `node:fs` and `node:fs/promises` directly (`workspace/WorkspaceFileSystem.ts` lines 158, 207, 248, 274, 292, 303, 363, 471), which our build aliases to the State-directory shim, not to the routing `FileSystem`. |
| `WorkspaceEntries` | **ours**: `browse`, `list`, `search`, `searchContents`, `listIgnoredFiles`, `refresh` over the Workspace DO's `readdir`/`find`/`grep`, never the Container | The stock one needs fff's native index, `git ls-files` and `node:fs`. |
| other `node:fs` users on `/w` paths | audited in M2 | ADR-0007's shim fails `/w/` paths with `ENOENT` and logs them as Shadow candidates. Known now: `vcs/removeEmptyDirectory.ts` and `vcs/worktreeCheckoutCache.ts` (worktrees, step 2b). |
| `HostProcess.HomeDirectory` | `/w` | So the client's browse and default clone destination (`~/<repo>`) land on `/w/<repo>`. M2 audits its readers (61 references across `apps/server` and the packages; 33 files in `apps/server` alone) for anything that writes under home. |
| `VcsProcess` (also t3's `SourceControlHost.process`) | **ours**: the argv router (below), deny-by-default for the Container | Replaces `VcsProcess.layer` at the composition root, so it also serves the stock `GitVcsDriver` copies built inside t3's private graphs (`orchestration-v2/runtimeLayer.ts:114` gives `ProviderEventIngestor` one; `ws.ts:3631` builds another). |
| `VcsDriverRegistry` | **ours**: `get("git")` returns our `VcsDriver` for a cwd under `/w`, the stock one elsewhere | The stock registry builds its git driver from the module function `GitVcsDriver.makeVcsDriver` (`vcs/VcsDriverRegistry.ts:63`), not from a Layer, so wrapping a Layer would miss it. Our `VcsDriver` answers `checkpoints.*`, `detectRepository`, `isInsideWorkTree`, `listWorkspaceFiles`, `listRemotes`, `filterIgnoredPaths` and `initRepository` from the Workspace DO (ADR-0009 items 1–2). |
| `GitVcsDriver` | stock, with `status`, `statusDetails`, `statusDetailsLocal`, `detectRepository`-style reads answered from the Workspace DO for `/w` where our composition provides it; t3's private copies go through the router, which answers the same reads from the DO (below) | So the behaviour does not depend on which copy a caller holds. |
| `VcsStatusBroadcaster.layerAutomaticFetchInterval` | a constant "off" | ADR-0009: no automatic background fetch. |
| `ChildProcessSpawner` | unchanged: every spawn fails fast as "not found" | Nothing outside a Workspace spawns, and no probe starts a Container. Git and `gh` reach a Container only through `VcsProcess`. |
| `TextGeneration` | stock; it routes to the instance's `textGeneration`, which is our `ProviderTextGeneration` calling the model through the proxy from the Environment DO (pi-ai `complete`) | The plan's "cloud `TextGeneration` Layer" is our driver's text generation; no Layer swap is needed. Review guides stay refused (t3 asks for Codex or Claude). |
| `SourceControlRepositoryService` (clone) | the stock one wrapped: `prepareClone`/`cloneRepository` take a destination under `/w` with exactly one segment (the Workspace id), register the Workspace, and have the Workspace DO clone in its Container with a token for that one repo | Provided in our composition, so a wrapper Layer is enough. A ghq-style nested destination is refused with a clear message. |
| `ManagedProjectFolders` (New project) | not reachable by a Layer (built inside `runtimeLayer.layerProduction`'s private graph). M2 first tries routing (its `git init`/`commit` go through `GitVcsDriver.execute` → `VcsProcess`, its folder through `FileSystem`); if its `baseDir/projects` root cannot map onto `/w`, a **Shadow** (the second) sets the root to `/w` and provisions through `workspace-client`. Scratch threads stay unavailable. | Not on the exit criteria's path (clone is). |
| GitHub credentials (`GitHubCredentials` is built inside t3's GitHub driver) | none: the router answers `gh auth token` with a token the Environment DO mints | t3 asks `gh` for a token through `SourceControlHost.process` (`GitHubCredentials.ts:153–172`). |
| Session pushes | `SessionSink`, a service our composition builds and `Runtime` exposes, called by `EnvironmentDO.sessionPush` | Step 1's note: expose what 2a needs from `composition.ts` deliberately. |

**The `VcsProcess` router.** By command, argv and cwd, in order:

1. `gh auth token [--hostname H] [--user U]` → stdout the Environment-side GitHub token (section 6), exit 0.
2. A cwd under `/w/<ws>` whose `<ws>` the registry does not list → `NotFound`, before any DO is touched.
3. `git` reads the Workspace DO answers itself → answered from the DO (isomorphic-git), in git's output format,
   with paths translated to `/w/<ws>`. The table is **bounded**: at most about 10 argv shapes, chosen from the M2
   trace by how often t3 sends them while the Container is stopped (candidates: `rev-parse --show-toplevel`/
   `--git-common-dir`/`--abbrev-ref HEAD`, `status --porcelain=v2`, `ls-files`, `check-ignore`, `remote -v`,
   `config --get`, `symbolic-ref`). Each one has a byte-for-byte test against real git on fixture repos, as the
   checkpoint diffs do; a shape without that test is not emulated. Any other read argv gets **the last real
   answer** for that exact argv (recorded when it last ran in the Container), invalidated when the write journal
   shows a write since, or by any git command that ran in the Container; with no valid recorded answer it falls
   to step 5.
4. `git` subcommands on the **Container allow-list** (built from the M2 trace of what t3 runs for clone, fetch,
   pull, commit, push, checkout/switch, branch, merge-base, diff of refs above the isomorphic guard) → the
   Workspace DO's real git in its Container, starting it, with the repo's token in the command's environment for
   network operations.
5. Any other `git` → run in the Container only if it is already running; if it is stopped, answer from the DO when
   step 3 can, else fail fast (`VcsProcessSpawnError`, detail "needs the Workspace's Container, which is stopped").
6. `gh …` with a cwd under `/w/<ws>` → only if M4's trace shows t3 needs it, by the same allow-list rule, with the
   Container token in `GH_TOKEN`.
7. Anything else → `NotFound` at once, as today.

The router logs every argv it sees with its decision and the environment variable names (not values) it was
given (`router-trace`, an admin route), which is how the allow-list and the table in step 3 are built in M2 and
checked in M4.

### The agents Worker

- `SessionDO`: one pi-durable Harness (`openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" })`), its
  root conversation, the v1 extensions, `HarnessOptions.env` building a `ComputerExecutionEnv` on its Workspace.
  Named `thread:<t3 threadId>` (`idFromName`). Host rules from cloudpid's overview (not its 4,700-line host):
  call `resume()` from the constructor and the alarm; arm the alarm before admitting work; a 60 s heartbeat while
  a task is live; on `task_interrupted` with `restart_limit`, withdraw the call's pending approval. One alarm,
  computed in one place from: the heartbeat, the turn deadline (2 h), the liveness push (60 s while a turn is
  live), and a push retry.
- `WorkspaceDO`: one `@cloudflare/computer` Workspace (SQLite VFS) and its Container, adapted from cloudpid's
  `Workspace.ts` (1,682 lines): keeps launch, idle stop, snapshots, the bootstrap, Container git, isomorphic-git
  status, redaction, the write journal, and the Worker Shell backend; drops Skills, MCP bridge, Builds, spares,
  previews, comparisons, runs, secrets and notify. Named by Workspace id. One alarm: idle stop, snapshot, and the
  budget lease's renewal.
- `ContainerBudget`: a singleton DO with 3 slots. A Workspace DO takes a lease before `ctx.container.start` and
  releases it when the Container stops. A lease lasts 10 minutes and is renewed from the Workspace DO's alarm
  every 5 minutes while its Container runs, so a running Container never loses its slot mid-turn and a lost
  release frees the slot within 10 minutes. A start with no free slot fails with a message the agent and t3 show
  ("3 Containers are running; try again when one stops").
- Exposure: `workersDev: false`, no preview URLs, no routes; reached only through Durable Object bindings. The
  Worker Shell's loaded Workers get only the `WorkspaceServiceProxy` binding (checked in M0).
- Bindings: `SESSIONS`, `WORKSPACES`, `CONTAINER_BUDGET` (own classes), `ENVIRONMENT` (the environment Worker's
  `EnvironmentDO`, by `scriptName`), `LOADER` (Worker Loader), the Container, `MODEL_PROXY_URL` and the secret
  `MODEL_PROXY_API_KEY`. The environment Worker gains `SESSIONS` and `WORKSPACES` (by `scriptName`),
  `T3FLARE_GITHUB_APP_ID`, `T3FLARE_GITHUB_APP_PRIVATE_KEY`, `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY`. The two
  Workers bind each other; see R2.
- Deploys: default deferred update (Sessions survive by design, ADR-0014). Worker names fixed:
  `t3flare-agents-<stage>`, `t3flare-environment-<stage>`. `scripts/stage.ts` gains the stage `step2a`.

---

## 2. Contracts

### Paths

`@cloudflare/computer` 0.9.0 fixes its working root: `WORKSPACE_ROOT = "/workspace"` is a constant
(`dist/index.d.ts:486`), the Worker Shell and the DO's file system use it, and the Container backend starts
computerd with `MOUNT_POINT: WORKSPACE_ROOT` (`backends/container/index.js:222`; the caller's `containerEnv` is
spread after it, so it might be overridable for the Container alone, untested). cloudpid's `computer-env` keys its
Container-only path rules on the same constant (`container-paths.ts:13–74`). So the root cannot vary per
Workspace on the DO's side, and the design is an explicit translation:

- **Inside a Workspace** (the DO's file system, the Worker Shell, the Container, and so the agent's tools and
  shell), the repo is at **`/workspace/repo`**, not at the mount root, as in cloudpid's layout (one directory per
  repo under `/workspace`). The agent's `cwd` is `/workspace/repo`. `computer-env` keeps its constants, and its
  Container-only rule (anything outside `/workspace` is the Container's, `container-paths.ts:70`) is unchanged.
- **Siblings of the repo** hold what is not the repo: the harness's files (temp files, `bash` spills) in
  `/workspace/.t3flare/` (cloudpid's `HARNESS_ROOT` rules, `container-paths.ts:16–19`, always synced), out of
  reach of an agent's `git clean -fdx`, its `grep` and its linters, with no `.git/info/exclude` entry needed; and
  room for step 4a's synced CLI session-state directory (ADR-0016) as another sibling.
- **Outside** (t3, its clients, the Environment DO), the repo root is `/w/<ws>` (ADR-0008); `/w/<ws>` ↔
  `/workspace/repo`.
- **The translation** happens in exactly four places:
  1. `workspace-client`: every path argument in, every path in an answer out.
  2. The `VcsProcess` router: the cwd in; out, absolute paths in the output of the git commands that print them
     (`rev-parse --show-toplevel`/`--git-dir`/`--git-common-dir`/`--absolute-git-dir`, `worktree list`), since t3
     parses those.
  3. **The Session's tools, on the way in.** t3 sends the agent text with `/w/<ws>/…` paths (`@` mentions, the
     restart continuation, handoff context), and the model may pass them to a tool; `computer-env` would treat such
     a path as Container-only and a `read` would start the Container. So the tools' path resolver (one function in
     `computer-env`, used by every file tool, `bash`'s `cwd` and `bash-routing`'s path words) normalises a leading
     `/w/<this ws>` to `/workspace/repo`. The prose of a message is never rewritten.
  4. The differ, on the way out, **structured fields only**: `file_change` paths, tool path arguments, `cwd`.
     Command output and assistant text are shown as the agent saw them (`/workspace/repo/…`).
- **In the Container**, the bootstrap tries to bind-mount `/workspace/repo` at `/w/<ws>`, so a stray absolute
  `/w/<ws>` path in a script or git config resolves there too. This is unproven: cloudpid's bootstrap only
  bind-mounts a directory over itself, best effort (`apps/sandbox-image/src/toolchains.ts:333–338`). If the mount
  fails, a symlink `/w/<ws>` → `/workspace/repo` is used, which only `pwd -P` and git's toplevel can tell apart,
  and the router translates those anyway.
- **M0 checks**, in two Workspaces: through the router, `git rev-parse --show-toplevel` with cwd `/w/<ws>` prints
  `/w/<ws>`; in the Container, `cd /w/<ws> && pwd -P && git rev-parse --show-toplevel` (recording whether the bind
  mount or the symlink is in place); a file the agent writes at `/workspace/repo/a.txt` is read by t3 at
  `/w/<ws>/a.txt`; a `read` of `/w/<ws>/a.txt` by the agent is served by the DO with the Container stopped. Also
  tried: `containerEnv.MOUNT_POINT` set to `/w/<ws>`, recorded but not adopted, since the DO and the Worker Shell
  would still see `/workspace`.

### Session ↔ Environment (DO RPC, ADR-0005)

**Identity.** One Session per t3 thread. The provider thread's `nativeThreadRef` is
`{ driver: "piDurable", nativeId: "thread:<threadId>", strength: "strong" }`: t3's restart continuation requires a
strong native ref. The Session's root conversation is the provider thread.

**Commands: Environment → Session** (`SESSIONS.get(idFromName(nativeId))`, RPC methods on `SessionDO`). Each
carries an idempotency key and answers once applied. None is called from inside a SQL transaction (ADR-0005); the
adapter calls them from its own fibers, outside t3's `withTransaction`.

| Method | Input | Answer |
|---|---|---|
| `open` | `threadId`, `workspaceId`, `runtimeMode`, `model`, `thinking` | `{ epoch, busy, turns }`; creates the Harness on first call |
| `submitTurn` | `providerTurnId` (key), `runId`, `attemptId`, `text`, `images` (inline, bounded), `model`, `thinking`, `runtimeMode` | `{ submissionId }`; `configure`s the root agent, then `submit` |
| `steer` | `providerTurnId`, key, `text`, `images` | `{ submissionId }` (joins the run at its next boundary) |
| `abort` | `providerTurnId` or `all: true`, `reason` | `{ aborted }`; withdraws the turn's pending approvals |
| `answer` | `requestId`, `decision` (`accept`, `acceptForSession`, `decline`, `cancel`), `feedback?` | `{ applied }` (false when the request is gone) |
| `snapshot` | `fromEntry?` | the state the differ needs, from `fromEntry` on |
| `close` | | stops pushing until the next `open`; the Harness keeps its state |

**Push: Session → Environment** (`ENVIRONMENT.get(idFromName("environment")).sessionPush(push)`). The Session
observes its root conversation (`Conversation.watch`), coalesces commits for about 100 ms while streaming, and
sends a push also every 60 s while a turn is live with nothing new (the liveness push, from its alarm):

```ts
type SessionPush = {
  sessionId: string;            // "thread:<threadId>"
  epoch: string;                // random per Harness creation; a new epoch resets the adapter's cursor
  seq: number;                  // +1 per push
  prevSeq: number;              // seq of the previous push this Session sent
  entries: EntryRecord[];       // committed entries after the last pushed one, in id order, bounded (256 KiB)
  more: boolean;                // cut at the bound: the adapter pulls a snapshot
  live: LiveStateSlim;          // pi.live without tool output, nested tools or partial tool arguments
  agent: { model; thinking };   // pi.agent's selection
  usage: UsageSlim;             // pi.usage totals and the last response's usage
  inbox: { pending: number };
  approvals: PendingApproval[]; // the permissions extension's pending requests, from the Session's own table
  turns: { [providerTurnId]: { submissionId; status: "queued" | "running" | "answered" | "failed" | "aborted" } };
};
type SessionPushAnswer = { ok: true; wantSnapshot?: true; orphans?: string[] /* providerTurnIds */ };
```

`sessionPush` counts as activity for the idle check (`Idle.requestStarted()`/`requestEnded()` around it), as
does `githubToken` (section 2, Workspace). It boots t3 if it is not running and waits for t3's command readiness
(so startup recovery has run), then hands the push to `SessionSink`:

- With an open provider session for the thread, the adapter applies it.
- **Orphans.** The adapter registers a turn in its open-turn map (`providerTurnId` → run) **before** it calls
  `submitTurn`, and removes it only after the turn's terminal is emitted. The orphan check consults that map first:
  a turn in it is never an orphan, so a push that arrives before `submitTurn` answers cannot abort a turn just
  starting. Only then, for each turn the push names as `queued` or `running` whose `providerTurnId` is not in the
  map and whose run t3 does not have open (terminal in t3's projection, or unknown), the answer lists it in `orphans`, and the Session aborts
  that turn and withdraws its approvals. This is what ends a Session turn after an Environment restart when t3
  does not continue the run: a pending runtime request blocks continuation (`RestartContinuation.ts:63–68`), the
  project's *continue after restart* setting is off, or the crash-loop guard stops it. When t3 does continue, the
  orphan abort comes first and is the same abort ADR-0004 asks `resumeThread` to do (which stays, idempotent).
- With no open provider session and no orphan, the push is acknowledged and dropped; the adapter pulls a snapshot
  when it opens one.

A push that fails (the Environment resetting) is retried from the Session's alarm with backoff; the push itself
wakes the Environment (the Session is the durable party).

**The inverse guard.** For each turn the adapter has open, if no push arrived for 2 minutes (the Session pushes at
least every 60 s while a turn is live), the adapter calls `snapshot`. If the Session reports the turn not live (no
such submission, another epoch, or settled) the adapter emits the terminal from what the snapshot shows, or
`failed` with reason "the agent's session lost this turn". If the call itself fails three times, the adapter emits
`failed` the same way. So a lost Session cannot leave a t3 run `running` forever, which would keep the Environment
awake (`idle.ts` counts open runs) indefinitely.

**Cursor and gaps.** The adapter keeps `{ epoch, seq, lastEntry }` per Session in memory, and persists only
`lastEntry` (DO key-value storage) at each turn's end. A push with another `epoch`, a `prevSeq` that is not the
last `seq`, or `more: true`, makes the adapter call `snapshot({ fromEntry: lastEntry })` and re-diff; opening a
provider session (after any restart) always does. Event ids are derived from pi-durable's own ids (section 3), so
re-applying a range emits the same upserts and at-least-once delivery is enough.

### Environment ↔ Workspace (DO RPC, through `packages/workspace-client`)

Called by the environment Worker's Layers (the Session's `ComputerExecutionEnv` uses `computer-env`'s own wire for
the agent's tools). Named `WORKSPACES.get(idFromName(workspaceId))`, only for ids the registry lists. Paths are
`/w/<ws>/…` at the client and `/workspace/…` in the DO (*Paths*, above).

| Group | Methods | Container? |
|---|---|---|
| Files | `stat`, `readFile(path, range?)`, `writeFile`, `readDirectory`, `makeDirectory`, `remove`, `rename`, `exists`, `realPath` | never (computer's VFS) |
| Search | `readdir`, `find(glob, limit)`, `grep(pattern, options)` | never |
| Git in the DO (isomorphic-git, ADR-0009) | `detectRepository`, `status` (branch, upstream, files; for a repo above the guard, the last real status plus the journal of written paths), `gitRead(argv)` (the router's step-3 table), `listFiles`, `filterIgnored`, `init`, `checkpoint.capture/has/restore/diff/listAuthoredPaths/delete` | never for a repo within the guard (2,000 tracked files, 16 MB of packs, no `.gitattributes` diff rules). Above it, see *Checkpoints above the guard* |
| Git, real | `git({ argv, cwd, stdin?, env?, timeoutMs, startContainer })` → `{ exitCode, stdout, stderr, truncated }` | only with `startContainer` (the router's allow-list); otherwise only if running |
| Provisioning | `provision({ kind: "clone", repo: { host, owner, name, cloneUrl, branch? } })` with progress lines; `provision({ kind: "init" })`; `info()` | clone: yes; init: no |
| Container | `containerState()`, `stopContainer()` | |

**Checkpoints above the guard.** t3 captures a checkpoint for every run (`Orchestrator.ts:11211` queues a
`checkpoint.capture` effect per run; `CheckpointService.ts:274/391` calls `captureCheckpoint`). For a repo above
the isomorphic-git guard, a capture asks the Workspace's write journal first: if nothing was written since the
previous checkpoint, the new ref is made an alias of the previous one in the DO, with no Container; otherwise it
runs real git in the Container, which the turn's writes have usually started already. So a question-only turn on
a large repo starts no Container.

The Workspace DO gets its repo's token by asking the Environment DO (`githubToken({ workspaceId })`), which
answers only for the repo its registry lists for that Workspace (section 6).

The Environment DO keeps a registry table (ours, beside t3's): `workspaces(id, repo_host, repo_owner, repo_name,
installation_id, created_at, state)`. It answers `/w` listings, the router's and `FileSystem`'s existence checks,
and token requests.

---

## 3. The differ and turn liveness

### What it reads

pi-durable's conversation view: committed transcript entries (`EntryRecord`s, each with `byTaskId`), and the
documents `pi.live` (`run`, `generation` with its throttled partial `message` and `retry`, `tools` slots with
`status`, `runFailure`), `pi.agent`, `pi.usage`, `pi.inbox`; plus the Session's pending approvals. Never an event
feed (ADR-0005).

### Mapping to `ProviderAdapterV2Event`s

| pi-durable state | t3 event | Id |
|---|---|---|
| `open` answered | `provider_session.updated` (`ready`), `provider_thread.updated` (`active`, strong native ref) | session id from t3; thread from `nativeId` |
| our submission placed, `pi.live.run` present with it in `inputs` | `provider_turn.updated` `running` | `providerTurnId` from t3's `startTurn`, kept with the submission |
| assistant text blocks: the live partial (`pi.live.generation.message`, produced by the run's current generation task), then the committed entry (whose `byTaskId` is that task) | `turn_item.updated` `assistant_message` while streaming, then `message.updated` at commit | `ti:<sessionId>:gen:<generationTaskId>:<blockIndex>` for both phases: the generation task is the same across its retries, and the committed entry names it in `byTaskId`, so the id needs no in-memory map and survives a restart. M1 checks on recorded views that one generation task commits one assistant entry. |
| thinking blocks | `turn_item.updated` `reasoning` | as above |
| tool call (`tools` slot, then its result entry) | `turn_item.updated`: `bash` → `command_execution` (command, exit, bounded final output); `edit`/`write` → `file_change` (path, the call's recorded patch); `read`, `ls`, `find`, `grep`, `image` → `dynamic_tool`; status from the slot, result from the entry | `ti:<sessionId>:call:<callId>` |
| pending approval | `runtime_request.updated` (`approval_request`, kind `command` for `bash`, `file-change` for `edit`/`write`; `responseCapability: { type: "live", providerSessionId }`), plus its `node.updated` and `approval_request` turn item, as t3's Pi adapter emits them | `rr:<sessionId>:<callId>` |
| approval answered or withdrawn | `runtime_request.updated` resolved / cancelled | same |
| `pi.usage` | usage on `provider_turn.updated` and context usage on `provider_thread.updated`, as the Pi adapter reports `get_session_stats` | |
| submission settled `answered` | `turn.terminal` `completed`, `reusable` | |
| `runFailure.reason` `aborted` | `turn.terminal` `interrupted` (Stop) or `cancelled` (an orphan or a re-open abort) | |
| `model_error` | `turn.terminal` `failed`: `usage_limit` when the error is an HTTP 429 or a quota body (reset time from `retry-after` when present), else `provider_error`; the raw error text is never copied (t3's Pi adapter keeps only a leading HTTP status) | |
| `restart_limit`, `faulted`, `orphaned`, `interrupted`, `no_model`, `turn_limit` | `turn.terminal` `failed` with a fixed reason; `broken` only for `faulted`/`orphaned` | |
| our 2 h deadline | the Session aborts with reason `turn_deadline`; `turn.terminal` `failed`, "turn exceeded 2 hours" | |
| `generation.retry` | nothing (t3 shows the turn as running) | |

Dropped, per the plan's differ scope: subagents, nested tools, live tool output (`command_output.delta`),
compactions (a failure becomes a `system_notice` item), prompt suggestions, plans and todos, MCP apps.

**Capabilities** (`OrchestrationV2ProviderCapabilities`): `runtimePolicy.enforcement: "client-boundary"` (the
check runs in the agent harness, as Pi's does); one provider thread per session; model switch in session yes
(`configure` per turn); runtime-mode switch in session yes (the mode rides on each `submitTurn`);
`pendingRequestsSurviveRestart: false`; threads: create empty, read snapshot, native thread id yes; rollback and
fork no (deferred by the plan); turns: interrupt yes, active steering yes, queued messages yes,
`terminalStatusQuality: "strong"`; streaming text and reasoning yes, tool output no; tools: item ids, started and
completed yes; approvals: command and file-change yes, live-only, native request ids; planning, subagents and
structured questions no; context: synthetic user context and handoff summaries yes; checkpointing: the app
checkpoints the file system, the provider does not roll back; identity: thread and item ids strong, turn ids weak.
`canResumeAfterRestart: true`.

### Runtime modes and approvals

The driver offers `supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"]` (default
`full-access`), `showInteractionModeToggle: false`.

**Where the check runs.** Not in a `beforeTool` hook. A hook gets a `HookApi`, which has no `progressed`
(`durable/src/harness/types.ts:972–990`), so it cannot mark a durable wait as progress; and `restartLimit`
(default 5) applies to the hook's task too (`types.ts:660–667`, `:1065`). A Session that waits for the owner does
no I/O, hibernates, and reruns the waiting call at each heartbeat, so a wait in a hook would end the call after
five reruns. cloudpid waits inside tool execution for this reason (`withApproval` in
`extensions/src/approvals.ts:314–323`, with `reachedWait` over `ToolExecutionApi.progressed`,
`effect-durable/src/tool.ts:55`).

So the `permissions` extension wraps the tools that can ask, with `wrapTool` (a `Wrap` is `{ tool, wrap(tool) }`,
`types.ts:419`; cloudpid's Secrets extension wraps tools this way, `secrets/extension.ts:662`): wrappers around
`bash`, `edit` and `write` whose `execute` checks the mode, asks if needed, waits, then calls the wrapped tool's
`execute` or returns the decline. A `beforeTool` hook is kept only for pure blocks with no wait (none in part 1;
plan mode would be one). The modes:

- `full-access`: every call runs.
- `auto-accept-edits`: `edit` and `write` run; `bash` asks.
- `approval-required`: `bash`, `edit`, `write` ask. Read-only tools are never wrapped.
- An ask stores the request in the Session's own table (keyed by the call's task, as cloudpid's
  `ApprovalsService` does: tool, a bounded summary of the command or the path with the patch's counts), marks the
  wait as progress (`reachedWait`), and waits for `answer`. `acceptForSession` adds the tool to the Session's
  allow-list for its life. A decline returns a tool error ("Declined by the owner", with the feedback). The request
  is settled when the call ends however it ends.
- **Re-raised after a Session restart.** A rerun of the call finds its stored request (same task, so same request
  id) and waits again; the next push carries it, so t3 still shows it. `reachedWait` starts its restart count over
  at each rerun.
- **Environment restart while an approval waits.** t3's startup recovery expires live requests as
  `not_resumable` and does not continue a run that had one pending. The next push gets the turn back as an orphan
  (section 2), and the Session aborts it and withdraws the approval; the thread waits for the owner's next
  message. Tested in M1 (synthetic approval) and M3 (real).

### Turn liveness (step 1's requirement)

The Environment resets when it has no client socket, no request in flight, no open run or provider session and no
claimable outbox effect (`apps/environment/src/host/idle.ts`). A Durable agent turn is driven through t3's own
orchestrator: `startTurn` is called on a run t3 has marked open, and it stays open until our adapter emits
`turn.terminal`. Rules that keep that true:

1. The Session never starts work the adapter did not submit.
2. The adapter emits `turn.terminal` only from committed Session state or the inverse guard (section 2); the 2 h
   cap lives in the Session.
3. Pushes and `githubToken` calls count as requests for the idle check, so `idleSince` moves when each ends. Today
   it moves only when a socket closes or a request ends (`idle.ts:29–39`; requests are counted only in
   `EnvironmentDO.fetch`, `environmentDO.ts:280`), and a DO RPC is neither, so without this a clientless turn's
   end would find `idleSince` as old as the turn and reset at the next check, cutting off work that follows the
   turn (title generation, checkpoint capture, the final projection).
4. Nothing in the Environment needs a timer for 2a, so the one alarm stays the host's (`#scheduleArmExpiry`,
   `checkIdle`). If 2a needs one after all, it joins that computation.

**The run's status while an approval is pending** is unverified: t3's projection may show the run as `running`
or `waiting` (both count as open in `idle.ts`; `RestartContinuation.ts` treats `waiting` as settled). M0 reads the
projector to say which; M1 asserts it with a synthetic approval (a test-only Session switch that raises one on a
text turn), before the real approvals of M3.

**M1's liveness test** (`scripts/liveness.ts`): with no client attached, a turn that runs long (a slow model
answer in M1; `bash sleep 90` again in M3), asserting through the admin `idle-check` route that the verdict is
"open work" for the whole turn, that the thread's title was generated after it, and that the object resets about
`IDLE_AFTER_MS` after the last push, not at once.

### Restart recovery (exit criterion)

`POST /_t3flare/restart` (`ctx.abort()`) mid-turn, asserted step by step by `scripts/restart-mid-turn.ts`: the
Session's next push fails, retries, and boots t3; t3's recovery terminalizes the run and stops the provider
session; the push's answer names the turn as an orphan and the Session aborts it; `RestartContinuation`
dispatches the continue prompt (its conditions hold: a strong native ref, the thread `active`, the session not
`stopped` or `error`, the provider turn `running`, nothing pending); the orchestrator opens a provider session,
`resumeThread` aborts again (a no-op), `startTurn` submits the continue prompt, and the new turn completes. Variants:
restart during a pending approval (no continuation; the turn is aborted, the approval withdrawn, the thread idle),
and restart with *continue after restart* off (the same). Run at the end of M1 on text-only turns, and in M5 with
tools, five times in a row.

---

## 4. What is copied from cloudpid

Copied files get a header naming their source (`cloudpid@ae5a7b73:<path>`) and are then ours. Tests come with
them and must pass in our tree.

| From cloudpid | To | How |
|---|---|---|
| `packages/effect-durable/src/**` | `packages/effect-durable` | whole |
| `packages/computer-env/src/**` | `packages/computer-env` | whole |
| `packages/extensions/src/{coding-tools,bash-routing,files,agents-md,agents-md-discovery,instructions,call-diff,images,result-bounds,stored-bytes,conversation-target,harness}.ts`, the parts of `outputs.ts` they use | `apps/agents/src/extensions/` | trimmed; anything reaching Registry, Environments, Secrets, MCP or Skills is cut |
| `packages/extensions/src/approvals.ts` (`withApproval`, the store, `settle`) | `apps/agents/src/extensions/permissions.ts` | the durable wait and answer only, behind `wrapTool`; `approval-cores.ts` and `approval-tools.ts` (Agent changes) are not taken |
| `apps/server/src/workspace/{Workspace,launch,idle,snapshots,toolchains,per-launch-backend,redact,alarm,binding,resource,git,prepare,changes,changes.collect,changes.repos,changes.setup}.ts` | `apps/agents/src/workspace/` | adapted: one repo at `/workspace/repo`, no Environment settings (fixed defaults), tokens from the Environment DO, the budget lease |
| `apps/server/src/github/{app,request,config}.ts`, `packages/config/src/github-permissions.ts` | `packages/github-app` | permissions tightened (section 6) |
| `apps/sandbox-image/image/{Dockerfile,supervise,cloudpid-memory-guard,command.bash,mise.toml}`, `src/{toolchains,workspaces,changes,supervisor,memory-guard,index}.ts` | `apps/sandbox-image` | trimmed (section 5) |
| `infra/github-app-setup.ts`, `infra/src/github-app.ts` | `infra/` | renamed, one GitHub environment (`bump`) |
| `patches/@alchemy.run__cloudflare@2.0.0-beta.85.patch` | `patches/deps/` | as is |
| `docs/architecture/overview.md` → *Session host* rules | `apps/agents/src/session/host.ts` | re-implemented small, not copied |

### Task 1: the pi-durable version

1. In a scratch checkout, copy cloudpid's `packages/effect-durable` and give it the newest upstream
   `@earendil-works/pi-durable` (1.5.2 on npm; also `/tmp/ref/pi` `main` at 058496b), unpatched, with the
   `pi-ai` and `chord` versions that release depends on, and our `effect` 4.1.2.
2. Run its typecheck and `vitest run`, and the `computer-env` tests the same way.
3. If both pass, use upstream unpatched. Otherwise pin exactly what cloudpid runs: `@earendil-works/pi-durable`
   1.5.0 with `patches/@earendil-works__pi-durable@1.5.0.patch`, and the `pi-ai`/`chord` versions cloudpid's
   `bun.lock` resolves, copied into `patches/deps/` and pinned in our root `package.json`.
4. Record the commands, versions and output in `docs/steps/step-2a/pi-durable-version.json`.

Expected (not assumed): upstream 1.5.2 has no `ToolExecutionApi.progressed` (cloudpid's #647 patch, which
`reachedWait` needs), so the typecheck fails and we pin 1.5.0 with the patch. The approvals' wait depends on that
mark.

---

## 5. The Container image

- **Base:** cloudpid's `apps/sandbox-image` Dockerfile: `ubuntu:26.04` pinned by digest, computerd pinned to our
  `@cloudflare/computer` version (a test keeps them equal), mise with the base toolchains preinstalled into its
  system directory (`git`, `gh`, Node LTS, pnpm, Bun, Python, uv), the everyday CLI tools, `build-essential`,
  earlyoom under the supervisor.
- **Dropped for part 1:** Docker, the MCP bridge, `cloudpid-notify`, Builds, the Run and Comparison scripts.
  **Kept:** the bootstrap (toolchains, git identity, the credential helper reading the command's token, the
  `/w/<ws>` bind mount), the clone script (`prepareWorkspaceScript`, one repo, into `/workspace/repo`), the
  Container-git status script. CLI agents (4a/4b) add their binaries to this image later (ADR-0015).
- **Instance size:** cloudpid's `cpu-1` custom size (1 vCPU, 3 GiB, 12 GB disk), chosen at each
  `ctx.container.start({ instance })` under `schedulingPolicy: "durable_object"`. Idle stop after 2 minutes, with a
  snapshot when the disk changed; `setInactivityTimeout` bounded by the idle time.
- **Build and push:** `Cloudflare.Container("WorkspaceContainer", { schedulingPolicy: "durable_object", context:
  apps/sandbox-image/image })` in the stage's alchemy stack, bound to the `WorkspaceDO` (`containers: [...]`).
  alchemy builds `linux/amd64` with the local Docker (29.5.2 here, emulated on Apple Silicon) and pushes to
  Cloudflare's registry; it rebuilds only when the context changes. In CI the runner's Docker does the same.
- **`ci:setup` changes** (`infra/github.ts`): add `Workers Containers Write` to the `t3flare-ci-bump` token (the
  Container application and the image push; cloudpid's deploy token has it for the same reason), and the GitHub
  variable `MODEL_PROXY_URL` to the `bump` environment, read from `~/.config/t3flare/dev.env` at `ci:setup` time
  (`MODEL_PROXY_API_KEY` is already a secret there). The App's two secrets reach `bump` through
  `github-app:setup`. `ci:setup` is then rerun with the `admin` profile (pending the owner's answer, below).
  `.github/workflows/bump.yml` passes the new secrets and variable.

---

## 6. The GitHub App

**The app.** `t3flare`, registered under the owner's account through GitHub's manifest flow, public (so it can
also be installed on an organization, as cloudpid's is), no webhook. Its own app, not cloudpid's (ADR-0013).

**Permissions.** The App asks for `contents: write`, `pull_requests: write`, `workflows: write`, `checks: read`,
`statuses: read`, `actions: read`, `issues: read`, `metadata: read`. Every token is minted with an explicit
permission list and explicit `repositories`:

- **Container tokens** (git and `gh` in a Workspace's Container; the agent can read them): the Workspace's one
  repo; `contents: write`, `pull_requests: write`, `metadata: read`. `workflows: write` only for a Workspace the
  owner opts in (a registry flag, off by default), so an agent cannot change a repo's CI unless asked to. One hour;
  the Environment DO caches each and mints a new one when less than 15 minutes remain.
- **Environment tokens** (t3's PR features, through `gh auth token`; they never reach a Container or a Session):
  the repos of the Cloud Environment's Projects that belong to one installation, plus during a clone the repo
  being cloned; the App's read permissions plus `pull_requests: write`. Handed out with at least 15 minutes left,
  because t3 caches the answer for 5 minutes (`GitHubCredentials.ts:33`, `TOKEN_TTL`).
- **One installation for t3's PR features.** t3 runs `gh auth token` with the server's own working directory
  (`GitHubCredentials.ts:153–172`) and caches the answer per host and account (`:236`), so the answer cannot depend
  on the repo t3 is about to call. A GitHub token belongs to one installation. So in part 1 the PR features work
  for the repos of one installation, the owner's account. Git itself (clone, push) works for any installed repo,
  because Container tokens are minted per Workspace. A second installation (an organization) is out of scope for
  part 1; with it, those repos' PR panels would fail as unauthorized.

The private key is held by the environment Worker only, and the Environment DO is the only minter (ADR-0018's
broker). The Workspace DO asks for its repo's token over RPC.

**`github-app:setup`** (`bun run --cwd infra github-app:setup`), what the owner does once, at the end of M0, so the
app exists before M2:

1. Run the command in a terminal on this machine (it needs `gh` signed in as the owner and a browser).
2. A browser tab opens on a local page that posts the manifest to GitHub. On GitHub's "Create GitHub App" page,
   check the name `t3flare` and click **Create GitHub App**. GitHub returns to the local page, which says to go
   back to the terminal.
3. The script writes `T3FLARE_GITHUB_APP_ID` and `T3FLARE_GITHUB_APP_PRIVATE_KEY` into
   `~/.config/t3flare/dev.env` (0600, outside the repo, beside `MODEL_PROXY_*`) and into the GitHub environment
   `bump` of `ian-pascoe/t3flare` (`gh secret set`, the value on stdin). Nothing is printed. A lost key is replaced
   from the app's settings page.
4. A second tab opens GitHub's install page. Install it on the owner's account with **Only select repositories**:
   the fixture repo and any repo the cloud should work on now (more can be added later). Press Enter in the
   terminal; the script mints a token for the installation to check it.

**Where the secrets are read.** Local stages: `scripts/stage.ts` reads `~/.config/t3flare/dev.env` and passes
`MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY`, `T3FLARE_GITHUB_APP_ID` and `T3FLARE_GITHUB_APP_PRIVATE_KEY` to alchemy
as environment variables (bound as Worker secrets); it never prints them, and refuses to deploy without them. CI
(`bump`): the GitHub environment's secrets and variable, passed the same way by the workflow.

**Fixture repo.** Proposed `ian-pascoe/t3flare-fixture`, private, small (a README, a `src/` with a few files, a
`test.sh`): clone, a turn edits a file and runs `bash test.sh`, push a branch `t3flare/acceptance-<run>`, open a
PR, then close it and delete the branch. Pending the owner's answer.

---

## 7. Sub-milestones

All on the stage `step2a` (`bun scripts/stage.ts deploy step2a`), destroyed at the end of the step. Evidence goes
to `docs/steps/step-2a/` as the scripts' own JSON, plus screenshots. Each milestone ends with `bun run check`
passing and a commit.

### M0. Foundations: the unverified facts, two Workers, a Container

- **Step 0, the driver kind** (R1), before any copying: the `builtInDrivers.ts` Shadow with a stub `piDurable`
  driver (a snapshot with one model, an adapter that answers a fixed text) on the environment Worker alone. Check in
  the stock web client: the composer's picker lists it and sends to it, its icon falls back cleanly (the client
  draws no package icon for an unknown kind, `ProviderInstanceIcon.tsx:103–104`), its settings card is read-only,
  and the usage and status surfaces do not break. Decide the kind (`piDurable`, or `pi` per R1's fallback).
- **Task 1**, the pi-durable version, recorded.
- Desk check: the run's status in t3's projection while a runtime request is pending (section 3).
- Copy `effect-durable`, `computer-env`, `github-app`, the sandbox image; `apps/agents` skeleton with `SessionDO`
  (empty Harness, pi-durable's faux model), `WorkspaceDO` (computer Workspace + Container), `ContainerBudget`;
  `packages/worker-build`; stage `step2a` in `stage.ts`, deploying both Workers.
- `infra/github.ts` change; `github-app:setup` ported; the owner runs it (section 6); the fixture repo exists.
- Measure: how much of each cloudpid extension slice comes along (files, lines, imports cut).
- **Exit evidence** (`m0-foundations.json`):
  - both Workers deployed; the agents Worker has no public URL (`workers.dev` off, a request to its would-be host
    fails);
  - `/_t3flare/check/agents` makes the Environment DO call a Session DO and a Workspace DO, and the Session call
    back into the Environment DO (both directions of the cross-Worker binding);
  - the Workspace DO starts a Container, runs `git --version` and `mise ls`, reports its start time, and stops it;
    a fourth concurrent start is refused by `ContainerBudget`, a lease is renewed while a Container runs past the
    lease time, and a dropped release frees its slot after the lease;
  - the *Paths* checks (section 2) in two Workspaces;
  - a Worker Shell command lists its own `env` bindings: only the Workspace proxy;
  - a Container token for the fixture repo can `git ls-remote` it, and cannot `git ls-remote` another installed
    repo.

### M1. A Durable agent answers in the stock client (no tools)

- `packages/models`, `packages/session-protocol`, the provider folder (driver, adapter, differ for text,
  reasoning, turn lifecycle, usage, usage-limit classification; text generation); the `SessionSink` with orphans;
  `EnvironmentDO.sessionPush` counted as activity; the Session's push loop with the liveness push, `snapshot`, one
  alarm; the adapter's inverse guard.
- **Exit evidence:** in the stock web client, the composer offers "Pi (cloud)" with the static models and the
  thinking picker; a message streams text and reasoning; Stop interrupts; a steer joins the run; the thread gets a
  generated title (`m1-chat.png`, `m1-acceptance.json` from a headless turn through `/ws`); the liveness test
  passes (`m1-liveness.json`); the synthetic approval shows the run's status and survives into the orphan abort
  on restart; **`scripts/restart-mid-turn.ts` passes on text-only turns**, with its two variants
  (`m1-restart.json`); a Session whose turn is lost (an admin route on the agents side drops its state) is ended by
  the inverse guard within 3 minutes; differ unit tests pass on views recorded from the deployed Session.

### M2. Workspaces: clone, files, status

- `packages/workspace-client` with the path translation; the routing `FileSystem`, our `WorkspaceFileSystem`,
  `WorkspaceEntries`, `HomeDirectory=/w` (with its readers audited), the clone wrapper, the `VcsProcess` router and
  its trace, our `VcsDriverRegistry`, the Environment DO's Workspace registry and token minting; New project by
  routing or the second Shadow; the `node:fs` audit for `/w` paths.
- **The router trace:** every argv t3 sends while cloning, browsing, opening the diff panel and showing status,
  with the router's decision; from it, the step-3 table (at most about 10 shapes, each with its byte-for-byte
  test) and the Container allow-list.
- **Memory (R5, moved here):** the agents isolate's heap after an isomorphic-git status of a 2,000-file repo, with
  two Sessions live in the same isolate.
- **Exit evidence:** from the stock web client, *Add project → Clone* of the private fixture repo lands at
  `/w/t3flare-fixture`; the file tree, file view, edits through the client and `@` search work; the branch shows
  in the header; the Container stopped after the clone and nothing passive started it again (`m2-clone.json` with
  the Container start log and the trace; `m2-clone.png`; `m2-memory.json`). A path under `/w` that the registry
  does not list fails without touching a DO. New project creates `/w/<name>` with an initial commit.

### M3. Tools, approvals, diffs

- The v1 toolset in `apps/agents/src/extensions/` on `ComputerExecutionEnv` (`read`, `write`, `edit`, `bash`,
  `image`, `ls`, `find`, `grep`, AGENTS.md and instructions sections, the Worker Shell with `bash` routing to the
  Container); the `permissions` wraps; the differ's tool, approval and file-change mapping with path translation;
  checkpoint ops in the DO with isomorphic-git, a unified diff that matches git's, and journal aliasing above the
  guard.
- **Exit evidence:** a turn in the fixture project edits a file and runs `bash test.sh` (in the Container); in
  `approval-required` the `bash` call waits, Approve runs it, Decline returns the error; the diff opens in the
  client's diff panel (`m3-turn.png`, `m3-approval.png`, `m3-diff.png`, `m3-acceptance.json`); an approval
  survives a Session DO restart mid-wait and more than 5 heartbeats of waiting (workerd test and one deployed
  run); a question-only turn on a repo above the guard starts no Container.

### M4. Push and PR

- The `gh auth token` answer and token lifetimes, Container tokens through the credential helper, commit message
  and PR content through our text generation, and what M4's trace shows t3 needs from `gh` (argv and environment
  variable names).
- **Exit evidence:** from the client, *Commit, push and create PR* on the turn's branch opens a PR on the fixture
  repo (`m4-pr.json` with its URL and the trace, then the PR closed and the branch deleted; `m4-pr.png`); a push
  that changes `.github/workflows/` fails without the Workspace's opt-in and succeeds with it.

### M5. Recovery with tools, guardrails, acceptance, report

- `scripts/restart-mid-turn.ts` with tools, five runs in a row, and its variants; the 2 h cap (an override to 2
  minutes on the stage); `ContainerBudget` under load; the acceptance test extended; the bump job deploying both
  Workers and running a real turn.
- **Exit evidence** (the plan's exit criteria, in order, from the stock desktop client paired with the stage):
  clone, a turn that edits files and runs `bash`, an approved tool call, the diff, push and PR, and an Environment
  restart mid-turn that continues (`m5-desktop-*.png`, `m5-restart.json`, `m5-acceptance.json`,
  `m5-bump-report.json`). Then `docs/steps/step-2a.md`, ADR updates, GLOSSARY and plan updates, stage destroyed.

### Tests

- **Unit (Node):** the differ on recorded views (a recorder admin route on the Session dumps each push; fixtures
  for a simple answer, multi-turn, interrupt, steer, a generation retry, a tool round, an approval approved and
  declined, a model error, a 429, a gap and snapshot, a re-diff after a restart): every id stable under re-diff and
  across live → committed; capabilities and snapshot; the router's table and allow-list; path translation both
  ways; Environment and Container token scoping.
- **Checkpoint fidelity (Node, real git):** the DO's `checkpoint.diff` output compared with `git diff` of the same
  refs, byte for byte, after edits, adds, deletes, renames, mode changes and binary files.
- **Emulated git reads (Node, real git):** each argv shape in the router's step-3 table (at most about 10)
  compared with real git's stdout, stderr and exit code on the same fixture repos, byte for byte, in clean, dirty,
  detached, unborn and no-upstream states; plus the recorded-answer cache's invalidation by a journal write and by
  a Container git command.
- **workerd (`@cloudflare/vitest-plugin`):** Session DO with pi-durable's faux provider (submit, abort, steer,
  answer, a restart mid-approval, more than `restartLimit` reruns while waiting, the push loop against a fake sink
  with dropped, reordered and orphaned pushes, a push that arrives before `submitTurn` answers (the turn must not
  be aborted), the liveness push, the 2 h deadline via a short override); Workspace
  DO file ops and isomorphic-git ops on real DO storage (no Container in workerd); `ContainerBudget` leases; the
  copied packages' own tests.
- **Deployed:** `scripts/acceptance.ts` gains `--real-turn`: clone the fixture, run a turn with a small model under
  `approval-required`, approve one call, check the turn items, the checkpoint diff and the tool output; for
  `step2a` also push and PR. `scripts/restart-mid-turn.ts`, `scripts/liveness.ts`. The bump job runs `--real-turn`
  without push.

### Cost guardrails

- At most 3 Containers at once (`ContainerBudget`, leases renewed while running; `max_instances` does not apply
  to the `durable_object` policy).
- A turn may run at most 2 hours (the Session's alarm aborts it; t3 shows a failed turn).
- Containers stop after 2 idle minutes; `cpu-1`; a Container is never started by passive status, file views,
  search, probes, or a git command outside the allow-list.
- A lost turn cannot keep the Environment awake (the inverse guard).
- Test turns use a small model and bounded output; the bump job's real turn is one turn on the fixture.
- Stages are destroyed at the end of the step; Containers and images go with them.

---

## 8. Risks and how each is settled early

| # | Risk | Settled by | Fallback |
|---|---|---|---|
| R1 | The stock client may mishandle a driver kind it does not know (`piDurable`) | M0 step 0, a stub driver | Register as kind `pi` (our driver replaces the stock Pi driver, which cannot run here; the client draws Pi's icon and settings form, whose fields we ignore) |
| R2 | The two Workers bind each other's DOs (`scriptName`), a cycle on a fresh stage | M0's first deploy, with cloudpid's alchemy patch for cycle peers | Two-pass first deploy, or a `WorkerEntrypoint` service binding |
| R3 | pi-durable version: upstream lacks `progressed` | Task 1 | Pin cloudpid's 1.5.0 + patch (the rule) |
| R4 | Checkpoint diffs from isomorphic-git differ from git's text, which t3's client parses | M3's fidelity tests | Checkpoint diffs on the Container's git while it runs |
| R5 | Sessions and Workspaces share an isolate's 128 MB in the agents Worker | M2's memory measurement | Lower the isomorphic-git guard; if not enough, a third Worker for Workspaces, which would amend ADR-0014 (owner) |
| R6 | t3 shells out to `gh` for a PR step, or reads a token some other way | M4's trace (argv and environment names) | Run that `gh` in the Workspace's Container with its repo token |
| R7 | `ManagedProjectFolders` is not reachable by a Layer | M2 | The second Shadow; New project is not on the exit path |
| R8 | pi-ai in the environment bundle (text generation) adds size or startup | M1 build report | Call the Messages API with `fetch` directly |
| R9 | The Worker Loader on this account, and what its loaded Workers can reach | M0 (bindings), M3 (first `bash`) | `bash-routing` sends every command to the Container |
| R10 | Restart ordering: pushes while t3 boots, the old turn's terminal racing the continuation | End of M1 (text), M5 (tools, five runs), the workerd fake-sink test | Tighten the orphan and open-turn filters |
| R11 | Image build time under amd64 emulation and in CI | M0 measures a first and a cached build | Build in CI only; cache layers |
| R12 | t3's text-generation model setting defaults to a driver we removed | M1: t3 falls back to a capable instance; check the title and commit-message paths | Seed the setting once from our composition |
| R13 | Path translation misses an absolute path t3 reads from git or from a tool result | M0's *Paths* checks, M2's trace, the differ's tests | Add the command to the router's translated set; the bind mount or symlink covers the Container; the tools' resolver covers `/w/<ws>` inputs |
| R14 | The run's status while an approval is pending, and whether t3 treats it as settled anywhere that matters | M0 desk check, M1 synthetic approval | Adjust the adapter's status reporting |

No risk needs the owner now. R5's fallback would.

---

## Refinements to the ADRs

To be written into the ADRs with the step's report, not before:

- **ADR-0013:** "each scoped to the Workspace's one repo" holds for every token that reaches a Container, and
  `workflows: write` is an opt-in per Workspace. The Environment DO's own tokens (t3 asks `gh` for one per host)
  name the Projects' repos of one installation, never reach an agent, and carry the App's read permissions plus
  `pull_requests: write`; PR features for a second installation are out of scope for now. The private key lives
  only in the environment Worker, and the Environment DO mints for the Workspace DOs (ADR-0018's broker).
- **ADR-0008:** inside a Workspace the repo is `/workspace/repo` (computer fixes the `/workspace` root); t3's
  `/w/<ws>` is translated at four named places (`workspace-client`, the router, the Session's tool path resolver,
  the differ's structured fields), and the Container also mounts or links `/w/<ws>`. Workspace ids are the single
  path segment under `/w` that t3's client chooses as the clone directory. The harness's files live beside the
  repo in `/workspace/.t3flare/`.
- **ADR-0009:** as built: our `VcsDriverRegistry`, the router's bounded DO-answered git table and its recorded-answer cache, the Container allow-list,
  checkpoint aliasing above the guard.
- **ADR-0005:** the push payload, epoch and sequence, the liveness push, orphans, the inverse guard and the
  snapshot call, as built.
- **Runtime modes:** the settled decision says "via a beforeTool hook"; it is a `wrapTool` wrap of the asking
  tools, because a hook cannot mark a durable wait as progress. Recorded where the runtime-mode decision is
  written (no ADR names it yet; the step report adds it to ADR-0012's neighbourhood or a new short ADR).
- **ADR-0014:** confirmed or amended by R5's measurement; the Worker Shell's entrypoint lives in the agents
  Worker (we bundle ourselves, so its entry exports it); the agents Worker has no public URL.

---

## Owner decisions and actions

**Decisions:** none required to start. One would arise only if R5's fallback is needed (a third Worker).

**Actions, in the order they are needed (two answers are pending):**

1. **Review this plan** and say "go".
2. **Fixture repo (pending):** consent to creating `ian-pascoe/t3flare-fixture` (private) with `gh` in M0, or name
   an existing small repo to use instead.
3. **`ci:setup` (pending):** I rerun it in M0 with the `admin` profile, as step 1 did, to add *Workers Containers
   Write* and `MODEL_PROXY_URL`; or you run it yourself.
4. **End of M0: run `bun run --cwd infra github-app:setup`** on this machine (about 5 minutes; section 6).
5. **End of M5: the desktop client.** I drive the web client (same client code) for the automated evidence and
   try the desktop app through desktop automation on this machine; if that cannot pair with the stage, you run the
   steps once in the desktop app (about 10 minutes) and I record the result.

---

## Review changes (revision 2)

Each finding of the review, checked against the source before changing anything:

| # | Finding | Checked | Outcome |
|---|---|---|---|
| 1 | Approval wait cannot live in `beforeTool` | Confirmed: `HookApi` has no `progressed` (`types.ts:972–990`); `restartLimit` covers hooks (`:660–667`, `:1065`); cloudpid waits in execution (`approvals.ts:314–323`, `tool.ts:55`) and wraps tools (`secrets/extension.ts:662`) | Changed: `wrapTool` wraps of `bash`/`edit`/`write`; `beforeTool` only for pure blocks; ADR refinement noted |
| 2 | Orphaned Session turns when continuation does not fire; lost Sessions leave runs open | Confirmed: `RestartContinuation.ts:63–68` blocks on a pending request; the setting and crash-loop guard can stop it | Changed: `orphans` in the push answer, the liveness push and the adapter's inverse guard; tests for a restart during an approval and with continuation off |
| 3 | Wrapping `GitVcsDriver.layer` misses callers | Confirmed: `VcsDriverRegistry.ts:63` uses `makeVcsDriver`; `runtimeLayer.ts:114` and `ws.ts:3631` build private copies | Changed: our `VcsDriverRegistry`; the router answers DO-backed reads and denies Container starts outside an allow-list built from the M2 trace |
| 4 | `WorkspaceFileSystem` uses `node:fs` directly | Confirmed (lines 2–3 imports; 158, 207, 248, 274, 292, 303, 363, 471) | Changed: our `WorkspaceFileSystem` with root containment; a `node:fs` audit for `/w` in M2 |
| 5 | `/w/<ws>` inside the Container is asserted, not shown | Confirmed and settled now: computer's `WORKSPACE_ROOT` is a constant, and computer-env keys on it | Changed: an explicit translation design (*Paths*), the bind mount, M0 checks. Partly rebutted: a per-Workspace root in the copied package cannot work, because computer's DO file system and Worker Shell fix `/workspace`. ADR-0008 names no `.agent-home`; the harness's files go to `/workspace/.t3flare/` |
| 6 | Restart tested last; turn end races idle reset | Confirmed: `idle.ts:29–39`, requests counted only in `fetch` (`environmentDO.ts:280`) | Changed: restart test at the end of M1 and in M5; `sessionPush` and `githubToken` count as requests; the liveness test checks the title and the reset timing |
| 7 | Restating hydration misses other `BUILT_IN_DRIVERS` readers | Confirmed: `providerInstallation.ts:77`, `terminal/Manager.ts:1451` | Changed: Shadow of `builtInDrivers.ts`, hydration stock |
| 8 | Differ ids not idempotent across live → committed | Confirmed: an id with the attempt changes on retry; `EntryRecord.byTaskId` exists (`types.ts:474`) | Changed: ids from the generation task for both phases; cursor in memory, `lastEntry` persisted at turn end; M1 checks one entry per generation task |
| 9 | Above the guard, every run's capture starts a Container | Confirmed: per-run `checkpoint.capture` effect (`Orchestrator.ts:11211`), `CheckpointService.ts:274/391` | Changed: alias the previous ref when the write journal is empty; R5 moved to M2 |
| 10 | `gh auth token` has no repo context; TTLs; `workflows: write` | Confirmed: cwd is the server's (`GitHubCredentials.ts:153–172`), cache per host/account (`:236`), `TOKEN_TTL` 5 minutes (`:33`) | Changed: the one-installation limit stated; tokens handed out with 15 minutes left; `workflows: write` opt-in per Workspace; the trace records environment names |
| 11 | agents Worker exposure | Accepted | Changed: no public URL, Loader bindings checked in M0, unlisted `/w` ids refused before any DO, `HomeDirectory` readers audited in M2 (61 references) |
| 12a | Usage-limit classification → part 2 | Not taken: the brief's settled differ scope lists "usage-limit classification", and it is one 429 rule with a recorded fixture | Kept, reduced to HTTP 429 or a quota body, reset from `retry-after` |
| 12b | `ContainerBudget` leases need renewal | Accepted | Changed: 10-minute leases renewed every 5 minutes while running |
| 12c | `github-app`, `provider-pi-durable`, `agent-extensions` as folders | Accepted for the provider and the extensions (one Worker each); not for `github-app`, which `infra/github-app-setup.ts` also imports to check an installation | Changed as stated |
| 12d | R1 before M0's copying | Accepted | M0 step 0 |
| — | Unverified: run status while an approval is pending; computer's mount point; Loader bindings | Mount point settled above; the other two scheduled | M0 desk check and M1 test (R14); M0 bindings check (R9) |

## Review changes (revision 3)

| # | Finding | Checked | Outcome |
|---|---|---|---|
| 1 | Repo at the mount root; harness files inside the repo; the bind mount unproven | Confirmed: cloudpid keeps `HARNESS_ROOT` beside its repos (`container-paths.ts:16–19`); its bootstrap only bind-mounts a directory over itself, best effort (`toolchains.ts:333–338`) | Changed: `/w/<ws>` ↔ `/workspace/repo`, harness in the sibling `/workspace/.t3flare/` (room for 4a's session-state sibling); the `/w/<ws>` bind mount is tried with a symlink fallback, and M0 records which |
| 2 | `/w/<ws>` paths reach the agent's tools and would start the Container | Confirmed: `isContainerOnly` treats any path outside `/workspace` as the Container's (`container-paths.ts:70`) | Changed: a fourth translation point, the tools' path resolver, normalises a leading `/w/<this ws>`; prose untouched; the differ translates only structured fields, not command output; M0 checks a `read` of `/w/<ws>/…` with the Container stopped |
| 3 | Orphan race at turn start | Accepted | Changed: the turn enters the adapter's open-turn map before `submitTurn`, and the orphan check consults the map first; a fake-sink test for a push before `submitTurn` answers |
| 4 | Emulated git reads unbounded and untested | Accepted | Changed: at most about 10 emulated argv shapes, each with a byte-for-byte test against real git; other reads get the last real answer per argv, invalidated by the write journal or a Container git command |
