# Step 0 spike: t3's server core in one Durable Object

Date: 2026-11-10, 11:25–12:45 EST (about 1 h 20 min of the one-day timebox). Branch `spike/step-0`.
t3code pinned at **`v0.1.9-nightly.20261110.4478`** (`20c3dd3689`), the newest nightly tag at the start.

## Verdict: GO, with conditions

The stock t3 web client, served by the `environment` Worker, pairs with the bootstrap token, creates a
scratch project, lists threads and opens a thread with live `/ws` streams on a real deploy. t3's
orchestration, projections, auth and Effect RPC run unchanged inside one Durable Object over a plain
accepted WebSocket. Startup is 2–3 ms, the bundle is 9.2 MiB, the heap after boot about 69 MiB (local),
and a DO restart is survived. It took **1 Patch and 0 Shadows**.

The conditions, each needed before step 1 builds on this:

1. **Bundle ourselves and upload with `bundle: false`.** alchemy 2.0.0-beta.85 passes `build.input.plugins`
   to Rolldown on a Worker's first deploy, but on every update it bundles without them (it drops
   functions from the props it plans with). Our import-scoped aliases, stubs and patch then silently
   vanish, and the Worker fails at boot. See acceptance item 5.
2. **Keep a DO SQLite adapter in our SQL Layer** for limits t3's queries exceed: at most 5 terms in a
   compound SELECT, 50-byte LIKE patterns, more than 100 bound parameters, and, **on production only**,
   a cap of about 100 view/subquery expansions per statement that breaks t3's thread-history query.
   Local workerd does not reproduce the last one, so the step 1 acceptance test must run against a
   deployed stage (ADR-0017 already says so).
3. **Load t3 lazily inside the DO** (`await import()` on first request). Even then workerd evaluates
   dynamically imported modules as global scope: no randomness or timers at module init.
4. **Silence t3's startup pairing log**: every boot logs a fresh one-time pairing URL with its token,
   which lands in Workers Logs.

## Acceptance items

Deployed URL (stage `spike`, destroyed with `alchemy destroy --stage spike` at 12:41; it now answers 404): `t3flare-environment-spike-juxn3xepy62clmbe.ian-g-pascoe.workers.dev`.

### 1. Stock web client pairs, creates a scratch project, lists threads, opens a thread — PASS

- **Headless, automated** (`apps/environment/scripts/acceptance.ts`, Bun): discovers the descriptor,
  pairs through `POST /api/auth/browser-session` with the bootstrap token (what `/pair#token=…` does),
  opens `/ws` with t3's own `WsRpcGroup` over Effect RPC, then `projects.mutate` (project.create with
  `createWorkspaceRootIfMissing`), `orchestration.dispatchCommand` (thread.create), `orchestration.subscribeShell`
  (the new thread is listed) and `orchestration.subscribeThread` (first value carries the title).
  Against production, with a 120-thread fixture: `ok: true`, list of 122 threads, all in 1.2 s
  (`docs/spike/step-0-acceptance-prod.json`).
- **Stock web client in a browser** (agent-browser driving the `apps/web` build served as the Worker's
  assets): `/pair#token=…` pairs and lands in the app; *Add project → Local folder → `~/scratch-ui` →
  Create & Add* creates the project (folder in the State directory); the sidebar lists the threads; a
  thread opens (`docs/spike/step-0-deployed-thread.png`, local run in `step-0-local-thread.png`).
- A thread is created headlessly because there is no provider: the composer refuses to send until one
  exists ("Environment disconnected" is t3's label for *no provider available*, not a dropped socket).
  *New project* (the default in the Add-project picker) fails, because it runs `git init` and the DO
  has no `git`; *Local folder* works.
- The thread view first failed on production only (see item 4, expansion cap): the client's
  `GET /api/orchestration/threads/:id/bounded` returned 500 and `orchestration.subscribeThread` failed.
  The client fell back to the socket snapshot, which shows t3's client is resilient, but the stream
  failed too. Fixed in our SQL Layer (version 6); after it, every bounded snapshot returns 200 and
  `subscribeThread` emits.

### 2. Startup, bundle size, heap — PASS

| Check | Result | Limit | Evidence |
|---|---|---|---|
| Startup (`startup_time_ms`, real deploy) | **2–3 ms** (versions 4–6, prebuilt); 11–14 ms (versions 1–3, alchemy-bundled) | 1,000 ms | Cloudflare `GET …/workers/{id}/versions/{v}` via `apps/environment/probe.run.ts` |
| Startup, local profile (`wrangler check startup`) | 8.9 ms active | | `/tmp` cpuprofile |
| Bundle, uncompressed | **9.20 MiB** (9,646,353 bytes of JS; alchemy reported "Uploading worker (9.20 MB)") | 64 MiB | `bun build.ts`; deploy log |
| Bundle, gzip -9 | 2.4 MB | none | |
| Heap after boot (local workerd, after GC) | **68.7 MiB**; 56.8 MiB before t3 boots; 71.4 MiB after a web client session | 128 MB | V8 `Runtime.getHeapUsage` over the inspector |

Startup is tiny because the Worker's global scope holds only the front `fetch` and the DO class; t3
loads on the DO's first request. The production heap can't be read from inside a Worker; the local
figure is the same V8 and bundle.

### 3. A DO restart is survived — PASS

`POST /_t3flare/restart` calls `ctx.abort()` (what an eviction or deploy does to memory and sockets).
With the stock web client open on a thread: 121 threads before, 121 after; the client's supervisor
reconnected about 1 s later on its own (a new socket in the RPC tap), resubscribed, and
`subscribeServerConfig`, `subscribeShell` and `subscribeThread` all emitted a first value again. The
page kept the thread open (`docs/spike/step-0-after-restart.png`). Boot after a restart, with a warm
isolate, answered the next request in 0.2–0.48 s.

### 4. `withTransaction` with rollback; more than 100 parameters — PASS (on production)

`GET /_t3flare/probe/sql` on production:

- A rolled-back `withTransaction` leaves 0 rows; a nested savepoint rolled back on its own keeps the
  outer write (rows `[2]`).
- A 150-row insert and a 150-id `IN` list (300 parameters in all) return 150 rows; a label containing
  `'` and `?` round-trips. Both statements went through the inlining proxy.
- With the 120-thread fixture, **t3 itself never sent more than 100 parameters**: most of its id lists
  are a single `json_each(?)` parameter now. Sixteen `sql.in(...)` call sites remain (`ProjectionStore`,
  `ProjectionMaintenance`, `EffectOutbox`, `AuthSessions`, `ProjectStore`, `ScheduledTaskService`), so
  the proxy stays.

New DO SQLite limits found, all handled in our SQL Layer (`apps/environment/src/platform/sql.ts`):

| Limit | Local workerd | Production | t3's need | Handling |
|---|---|---|---|---|
| Terms in one compound SELECT | 5 | 5 | 12 (`ProjectionStore` thread window) | regroup `UNION` chains into nested subqueries of ≤5, left to right (tested against SQLite for equal results) |
| LIKE pattern length | 50 bytes | 50 bytes | t3's own patterns are short; our file store's prefix match was not | our store uses key ranges |
| Expression depth | 100 | 100 | not hit | |
| View/subquery expansions per statement | **none** | **≈100** (a chain of 98 CTEs passes) | `ProjectionStore`'s thread window inlines one CTE (`NOT MATERIALIZED`) into many references | on "VIEWs and/or subqueries nested too deep", run each CTE as its own statement and pass its rows to later ones as a `json_each` parameter; results compared equal locally on 12 statements; 8 uses on production fixed the thread view |
| PRAGMAs | `auto_vacuum` etc. refused (`SQLITE_AUTH`) | same | `Sqlite.layerSetup` sets six PRAGMAs | our composition runs only `runMigrations()`; t3's storage inspection logs a warning |

The first fallback tried scratch tables (`CREATE TABLE … AS`); the DDL broke a cursor t3 still had open,
so the shipped fallback does no DDL.

### 5. The import-scoped `node:fs` alias through alchemy's `build.input.plugins` — PARTIAL; fallback used

- The plugin **did run through alchemy** on the first deploy: "node:fs alias rewrote 42 imports in
  37 t3 modules", 17 dependency imports left on workerd's `node:fs`.
- On every **update**, alchemy (2.0.0-beta.85) bundled without our plugins. Evidence: the second deploy
  failed inside Rolldown with `handler.call` undefined in our plugin's `{ order, handler }` resolveId
  hook (the nested function was gone); with plain function hooks the update "succeeded", but the bundle
  in `.alchemy/bundles/` contained no shim, no stub and no patch, and production then failed at boot
  ("Disallowed operation called within global scope", from the unstubbed Claude SDK). A later deploy
  planned "no changes" for a different bundle. alchemy appears to copy the Worker props it plans with,
  dropping functions.
- **Fallback, as ADR-0007 allowed:** `build.ts` bundles with the same Rolldown options alchemy uses
  (its Cloudflare plugin, minify, `strictExecutionOrder`, `lazyBarrel`, `inlineConst`), and
  `alchemy.run.ts` uploads `dist/worker/` with `bundle: false`. Deploys 4–6 used it.
- The alias is now a `transform` of t3's own modules, not a `resolveId` hook: Cloudflare's Rolldown
  plugin claims `node:*` builtins in a `"pre"` resolveId hook, so a plain hook never sees them. It
  rewrites 46 import specifiers in 40 t3 modules (`build.ts`, `dist/fs-alias-report.json`).

### 6. Further checks from `docs/plan.md`

- **Cold-boot cost.** First request after a deploy, cold isolate and first-ever migrations: 2.51 s
  wall from the client. After `ctx.abort()` with the isolate warm: 0.2–0.48 s. Warm requests:
  0.11–0.24 s. Locally the dynamic import of t3 takes 0.59 s and the layer graph 0.44–0.74 s.
  `performance.now()` and `Date.now()` do not advance during CPU work on production (Spectre
  mitigation), so the DO cannot time its own boot; the client's wall time is the measure.
- **Streams the web client subscribes at connect, and their first value.** From a passive tap on the
  RPC socket (`platform/rpcTap.ts`), web client on production: `subscribeServerConfig`,
  `subscribeServerLifecycle` (twice), `orchestration.subscribeShell`, `subscribeProjectClones`,
  `subscribeVcsStatus`, `subscribeDeviceState`, `subscribeTerminalMetadata`; opening a thread adds
  `subscribeDiscoveredLocalServers`, `scheduledTasks.subscribe` and `orchestration.subscribeThread`.
  **Every one emitted a first value.** One `subscribeVcsStatus` ended in Failure after two values, for
  the non-Git scratch project (no `git`). Unary calls at connect (`vcs.listRefs`, `vcs.refreshStatus`,
  `server.discoverSourceControl`, `projects.readFile`, `assets.createUrl`, `getOlderSettledThreads`,
  `getArchivedShellSnapshot`) all succeeded.
- **Read latency behind open transactions.** Worse than ADR-0006 says: an open `storage.transaction()`
  closes the DO's input gate, so **nothing else runs** until it commits: a reader fiber whose 5 ms
  timer was due inside a 50 ms transaction was not even issued until the commit (`tx-committed@50`,
  `read-issued@50`). Reads also never see uncommitted writes. Latency behind a transaction is its whole
  remaining duration, for every request and socket. t3's transactions are SQL-only and short, so this
  is acceptable, but any transaction that awaits I/O would stall the Environment.
- **The bootstrap grant's scope.** It suffices for a first pairing. The token becomes t3's
  `desktopBootstrapToken`: a grant of `AuthStandardClientScopes` (wire scopes `orchestration:read`,
  `orchestration:operate`, `terminal:operate`, `relay:read`, `relay:write`, `access:read`,
  `access:write`, plus the finer `permissions`), **unbounded uses, valid 24 h from each boot, re-seeded
  at every boot**. Two browser pairings with it coexist (checked locally; the desktop rule that a new session replaces
  older ones does not apply to browser sessions). The auth descriptor reports policy
  `loopback-browser`, because `ServerConfig.host` is unset.

Also recorded: the processes t3 tried to spawn after boot and one client session (all fail as
"not found"): `git` (26), `gh`, `glab`, `az`, `fj`, `tea`, `cafe`, `origin`, `jj`, `codex`, `claude`,
`tailscale`, `hostnamectl`, `lsof`.

## Patches, Shadows and other changes

Totals: **Patches 1** (limit ~10), **Shadows 0** (limit ~15).

| Kind | Item | Why |
|---|---|---|
| Patch | `patches/0001-lazy-server-browser-ref-namespace.patch` (3 lines, `preview/ServerBrowserPage.ts`) | calls `randomUUID()` at module scope; workerd forbids randomness while evaluating modules, even from a dynamic import. Applied in memory while bundling; the submodule's tree is untouched. |
| Import-scoped builtin alias | `node:fs`, `fs`, `node:fs/promises`, `fs/promises` → `src/shims/node-fs*.ts` | ADR-0007: t3's synchronous State-directory writes go to DO SQLite |
| Import-scoped builtin alias | `node:module` → `src/shims/node-module.ts` | t3 `createRequire(import.meta.url)`s native packages at module scope (`@ff-labs/fff-node` in `WorkspaceSearchIndex.ts`), which no bundler can follow; they resolve to stubs that throw when used |
| Builtin stub | `node:sea` → `src/shims/node-sea.ts` | not in workerd; t3 only asks `isSea()` |
| Generated dependency stub | `@anthropic-ai/claude-agent-sdk` | calls `randomUUID()` at module scope; Claude runs in a Container later |
| Build defines | `import.meta.url`, `import.meta.dirname`, `import.meta.filename` | undefined in workerd; Node packages call `createRequire(import.meta.url)` and `path.resolve(import.meta.dirname, …)` at module scope |

Our Layers, in `apps/environment/src/t3/composition.ts` (server.ts's graph restated, departures marked
`t3flare:`): DO SQL client (ADR-0006; no Shadow needed, see below), State-directory `FileSystem` over
DO SQLite, POSIX `Path`, a process spawner and PTY that report every binary missing, a no-TTY
`Terminal`, Effect's web `HttpPlatform`, `HostProcess` references (Linux, home `/t3/home`, no network
interfaces), `ServerSecretStore` in DO key-value storage, `ServerEnvironment` with
`platform.machine: "cloud"` and reduced capabilities, `ServerConfig` built in code, no-op provider event
loggers, no scheduled-task webhook origin, no server restart, no event-loop monitor (no
`perf_hooks.monitorEventLoopDelay`), no response compression (workerd re-compressed t3's gzip and the
client rejected the body), and our `HttpServer` (`platform/httpServer.ts`). Routes mounted: the HTTP
API, `/ws`, assets, attachment upload, `/mcp`; not mounted: guest links, OTLP proxy, device hub,
server-browser stream, speech stream, static files.

## ADR corrections

- **ADR-0006 (SQL client Shadow).** No Shadow of `nodeSqliteClient` is needed. Importing it is harmless
  in workerd (`node:sqlite` and `node:worker_threads` are import-only stubs); only its `layer` would
  fail, and our composition provides `SqlClient` itself. `readOnly` just sets a Reference the DO client
  ignores. The ADR's limit list is incomplete (compound terms, LIKE length, the production-only
  expansion cap, refused PRAGMAs), and its "reads wait" is "everything waits". t3 now passes most id
  lists as one `json_each` parameter.
- **ADR-0007 (alias via `resolveId` through alchemy).** A `resolveId` alias cannot work: Cloudflare's
  Rolldown plugin claims `node:*` in a `"pre"` hook, and alchemy drops plugin functions on updates.
  It is a `transform` in our own build, uploaded with `bundle: false`. The alias also had to cover
  `node:module`. Files above 8 MB are not chunked yet (step 1).
- **ADR-0001 (Layer, then Shadow, then Patch).** Held, with a fourth tool the ADR doesn't name:
  import-scoped builtin aliases, stubs and build defines. Worth naming, and counting apart from
  Shadows. Patches are applied in memory at bundle time; `git apply --check` from `t3code/` validates
  them on a bump.
- **ADR-0019 / Bun.** Bun installs t3's subtree fine and applies all of t3's pnpm patches that match
  installed packages (18 for desktop/mobile packages warn as unused). It does not reuse t3's lockfile:
  209 of 993 packages shared with t3's lock resolve to other versions, and two broke things until
  pinned back (`@nodable/entities` 2.1.1 broke the web build's license check; `@anthropic-ai/sdk`
  1.6.0 broke typecheck). pnpm-only `overrides` forms (13 removals with `"-"`, `parent>child` edges)
  have no Bun equivalent; the generator flattens edges and lists what it drops.
- **ADR-0010.** The bootstrap token works as t3's `desktopBootstrapToken`. Its grant is reusable for
  24 h after each boot, and every boot also logs a new one-time pairing token. Step 1 should suppress
  that log and decide whether the Worker secret should be rotated after the first pairing.

## Surprises

- **workerd evaluates `await import()`ed modules as global scope.** Lazy import keeps startup at 2 ms,
  but module-init randomness and timers are still forbidden, so the Patch and the Claude SDK stub
  stay needed.
- **Production DO SQLite differs from local workerd.** The ~100 expansion cap exists only on
  production, and broke the stock client's thread view after everything passed locally.
- **Deploys don't reach a connected Environment** until it restarts: with a client connected, the DO
  kept running version 1 after version 2 was deployed, until we restarted it (deferred update,
  ADR-0004). A restart 2 s after a deploy still came back on the old version; 15 s later it got the new one.
- **Module state outlives a DO restart.** `ctx.abort()` resets the object, but a warm isolate keeps
  module-level state (our tap's counters survived, and so would any t3 module singleton). Boot after a
  reset skips module evaluation, which is why it takes 0.2–0.5 s against 2.5 s cold.
- **Clocks don't move during CPU work on production**, so in-DO timings read 0.
- Building `apps/web` rewrites `apps/web/src/routeTree.gen.ts` in the submodule; `prepare:web` restores it.
- t3's server logs a fresh pairing URL with a token on every boot (`localhost:443`, since there is no host).
- Deploys: the brief asked for exactly one real deploy. I made **six deploys to the same `spike`
  stage**: the second and third went to the alchemy update bug, the fifth was a diagnostic probe, and
  the sixth was the SQL fix for the production-only limit. No other stage or resource was created.

## Recommended changes to `docs/plan.md` for step 1

- Add to step 1: **our own Worker build** (`build.ts`) with `bundle: false`, until alchemy keeps
  `build.input.plugins` on updates (report upstream with the evidence above).
- Add a **DO SQLite adapter** as a named part of step 1: compound regrouping, CTE fallback, parameter
  inlining, and an error log, with an acceptance check that runs t3's heavy queries (thread window,
  shell, search) **against a deployed stage**, with a fixture that has turn items. The spike's threads
  had no turn items, so the CTE fallback is proven only on near-empty data.
- Step 1 exit criteria: also "no pairing token in Workers Logs" and an auth descriptor of
  `remote-reachable` (set `ServerConfig.host`).
- Re-examine ADR-0003's teardown with the finding that module state survives a reset: tearing down the
  Effect runtime is not a clean restart for t3's module-level singletons.
- Upstream asks (the "concrete list" step 1 sends): avoid module-scope randomness
  (`ServerBrowserPage.ts`); load native packages lazily instead of `createRequire` at module scope
  (`WorkspaceSearchIndex.ts`); keep compound SELECTs to 5 terms and CTE expansion small in
  `ProjectionStore` (or materialize); make `Sqlite.layerSetup`'s PRAGMAs optional; an option not to log
  the startup pairing URL.
- Step 2b's terminal and step 2a's VCS replace the "binary not found" spawner; until then *New project*
  fails and *Local folder* is the way to add a project.

## Where things are

- `apps/environment/`: `src/worker.ts` (front door and DO), `src/runtime.ts` (lazy boot),
  `src/t3/composition.ts` (composition root), `src/platform/` (SQL, State directory, HttpServer, RPC
  tap, services), `src/shims/`, `build.ts` (bundle, aliases, stubs, patches), `alchemy.run.ts`,
  `scripts/acceptance.ts`, `src/admin.ts` (`/_t3flare/*`: stats, boot, SQL/compound/nesting probes,
  restart), `probe.run.ts` (reads `startup_time_ms`).
- `scripts/gen-workspace.ts`: the root `package.json` workspace from t3's `pnpm-workspace.yaml`.
- `patches/`: the one Patch.
- Reproduce: `bun install`, `bun run --cwd apps/environment prepare:web`, then with `T3_BOOTSTRAP_TOKEN`
  and `T3FLARE_ADMIN_TOKEN` set: `bun run --cwd apps/environment deploy --stage <stage>` and
  `T3_URL=… bun apps/environment/scripts/acceptance.ts --threads 120`.
- Time cost of the Bun switch, kept separate: about 5 minutes (generator, install, two lockfile pins).
