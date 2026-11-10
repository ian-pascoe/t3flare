# Step 1: Platform

Date: 2026-11-10. Branch `step-1`. t3code pinned at **`v0.1.9-nightly.20261110.4478`** (still the newest
nightly at the end of the step). Plan row and checks: `docs/plan.md`, step 1.

The spike's `apps/environment` is now the platform: one build path, a tested DO SQLite adapter, a chunked
State directory, a host around t3 (boot counter, Safe mode, Pairing window, idle reset and alarm), admin
routes behind a per-stage Access application plus a token, lockfile pinning, `bun run check`, and a nightly
bump job. Every exit criterion was proved on the deployed stage `step1`, and the bump job ran end to end
against the stage `bump`. Both stages were destroyed at the end.

## Exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| With no client, the DO resets and later wakes on its alarm | **PASS** | `step-1/idle-reset.json` |
| Safe mode works, forced by the boot counter and by the toggle | **PASS** | `step-1/safe-mode.json` |
| No pairing token in Workers Logs across a boot | **PASS** | `step-1/logs-check.json` |
| Auth descriptor `remote-reachable`; the stock web client pairs with the armed bootstrap grant and opens a thread | **PASS** | `step-1/acceptance-step1.json`, `step-1/web-client-thread.png` |
| Heavy-query tests on the deployed stage with turn-item fixtures | **PASS** | `step-1/acceptance-step1.json` |
| `bun run bump` pins the newest nightly and runs the acceptance test against a deployed stage, end to end | **PASS** | `step-1/bump-report.json` (and `step-1/bump-rollback-on-failure.json`) |
| `bun run check` passes | **PASS** | about 8 s: patches, lock, typecheck, lint, 46 tests |

Details (`step-1/` is `docs/steps/step-1/`; every file is the scripts' own JSON output):

- **Idle reset and wake** (`bun scripts/stage.ts run step1 idle-reset --due-in-seconds 150`, idle delay 60 s).
  The script pairs, creates a project and a scheduled task due once at 19:13:45.665, then closes its socket
  and only polls the admin health route (which neither boots t3 nor counts as activity). At 19:12:27 the
  object had reset (a second construction in the same isolate, t3 stopped) with **the alarm at
  19:13:45.665**, the task's time; at 19:13:48 t3 was running again, **booted by the alarm**. The first run
  of this check failed: on production the alarm written just before `ctx.abort()` was lost (local workerd
  kept it). The host now awaits `ctx.storage.sync()` before resetting (ADR-0003 updated).
- **Safe mode** (`… run step1 safe-mode`). The fault route made the next three boots fail: three requests
  got 500 (each a failed boot), the fourth 503 `{"t3flare":"safe-mode","reason":"boot-failures"}` without a
  boot attempt; health showed `consecutiveFailures: 3` and the injected error. Turning safe mode off → 200;
  on by hand → 503 and t3 stopped (`reason: "manual"`); off again → 200.
- **No token in the logs** (`… run step1 logs-check`). `wrangler tail` streamed the Worker's logs while the
  script reset the object, booted t3 cold, armed pairing (a boot that seeds the bootstrap grant), paired
  (200) and disarmed (another boot). Two `booted` records were captured, one with `bootstrapSeeded: true`;
  zero occurrences of the bootstrap token, the admin token, `pairingUrl`, or an unredacted `token=` across
  the stream. The health route counted t3's pairing-URL line dropped once per boot (`droppedPairingLines`).
- **Auth and pairing** (acceptance). `/api/auth/session` reports `policy: "remote-reachable"`. The bootstrap
  token is refused (401) before arming, pairs (200) while armed, and is refused (401) after disarming. The
  stock web client, served as the Worker's assets, opened `/pair#token=…` while armed, landed in the app with
  the sidebar listing the threads, and opened a fixture thread showing its turn items
  (`web-client-thread.png`; the "Codex provider status" banner is t3 reporting no `codex` binary, expected
  until step 2a).
- **Heavy queries** (acceptance, 12 threads × 4 runs; 96 messages and **240 turn items** written through t3's
  own `EventSinkV2`, which stores the events and runs t3's projections). Thread window
  (`GET /api/orchestration/threads/:id/bounded`): 12/12 200 with all 20 turn items, at most 202 ms, 46 KB.
  `subscribeThread`: first value in 55 ms with 20 items. Shell snapshot (`subscribeShell`): all 12 threads
  listed, 556 ms, 77 KB. Search (`searchThreads` on the fixtures' marker word): 12 matches in 12 threads,
  42 ms; `searchThread` answered. The production-only CTE fallback ran **36 times with 0 failures**; 31
  compound SELECTs of up to 12 terms were regrouped; no statement other than t3's PRAGMAs was refused. Also:
  `withTransaction` rollback and a 300-parameter statement through t3's client pass.
- **Bump** (`bun run bump`, about 2 minutes). Newest nightly `v0.1.9-nightly.20261110.4478` (the current pin; no
  newer tag was published during the step, checked again at the end), workspace and lock regenerated and
  verified, `git apply --check` of the Patch, typecheck, lint and tests, build of the Worker and the web
  client, a first deploy of the `bump` stage (57 s), and the acceptance test against it: all passed. An
  earlier run failed at the lint step on a stray script of mine; it restored the submodule and the generated
  files and left the pin unchanged, as designed (`bump-rollback-on-failure.json`).

## What changed from the spike

- **Build (ADR-0020).** `build.ts` is the only build; `bun scripts/stage.ts deploy <stage>` the only deploy
  (build, web client, `alchemy deploy` with `bundle: false`). Patches are applied in memory after
  `git apply --check` (`bun build.ts --check` alone for a bump); the build fails on a Patch that does not
  apply. Each build writes `dist/build-report.json` (pin, commit, Patches, Shadows, Build shims, size: 9.19 MiB)
  and stamps the bundle so the health route reports what is running.
- **DO SQLite adapter (ADR-0006)** split out of the client into `src/platform/sqlAdapter.ts`: parameter
  inlining, compound regrouping, the CTE fallback, and one stats object with the last refused statements.
  Spike-only switches (forced materialisation, probes) are gone. Tests: equal results against Node's
  SQLite, DO SQLite's real limits in workerd, and the deployed acceptance test for the production-only cap.
- **State directory (ADR-0007)**: files above 4 MiB are stored in 4 MiB chunk rows; ranges read only the
  chunks they span; append, truncate, rename and remove keep chunks consistent; a versioned migration keeps
  a spike-era object's files. The `node:fs` shim commits buffered descriptor writes in one write.
- **Secret store**: unchanged in substance, moved to `src/platform/secretStore.ts`, tested on real DO storage.
- **Host** (`src/environmentDO.ts`, `src/host/`): boot record and Safe mode (`bootState.ts`), the Pairing
  window (arm/disarm, seeded only on an armed boot, refused at the front door outside it, an alarm to restart
  t3 without the grant when the window closes), the redacting Console, `ServerConfig.host` set to the
  Worker's public host, idle reset with one alarm (`idle.ts`), and the module-state registry for the
  twice-boot check (`moduleState.ts`). t3 still loads lazily on the first request; the Worker's global scope
  holds the front door, the guard and the DO class.
- **Admin routes** (`src/host/admin.ts`): `health`, `safe-mode`, `fault/boot-failures`, read-only `sql` (one
  statement, `SELECT`/`WITH`/`EXPLAIN`/schema PRAGMAs, run in a transaction that is always rolled back),
  `arm-bootstrap`, `disarm-bootstrap`, `restart` (abort or in place), `idle-check`, `check/reboot`,
  `check/sql`, `fixtures/turn-items`. The spike's probes (compound, nesting, force-materialise) and the RPC tap
  are removed. Guard: `src/access.ts` in the Worker, before the DO; local workerd (`bun run dev`) admits the
  admin token alone on loopback.
- **Access (ADR-0010)**, created per stage by `alchemy.run.ts` with the owner's `default` profile: an Access
  application with destination `<host>/_t3flare`, an Allow policy for the owner's email and a Service Auth
  policy for the stage's own service token. The Worker name is fixed (`t3flare-environment-<stage>`) so the
  destination is known before the Worker exists. The token's credentials are written to
  `apps/environment/.alchemy/stages/<stage>.access.json` (0600, gitignored), and the stage's random bootstrap
  and admin tokens to `<stage>.env.json`; `bun scripts/stage.ts run <stage> <script>` passes them to a script.
- **Lockfile pinning (ADR-0019)**: `scripts/gen-workspace.ts` pins 1,572 of the 1,811 packages in t3's
  `pnpm-lock.yaml`; 167 are at several versions there and cannot be pinned; what it cannot express is in
  `scripts/lock-pins.report.md`. `scripts/verify-lock.ts`: 20 of 950 shared packages differ (from 209 at the
  spike), all multi-version or our own direct dependencies; one `effect` (4.1.2).
- **Tooling**: `effect-tsgo tsrs` typecheck; oxlint, type-aware through tsrslint (linked by
  `scripts/link-tsrslint.sh`, as in cloudpid); Vitest 5 on Node with a `node` project and a `workerd`
  project (`@cloudflare/vitest-plugin`); `bun run check` runs them all at once. The typecheck needed `DOM` in
  `lib`: some dependency brings in `@types/react`, whose global `HTMLElement` stub broke type-checking of t3's
  `ServerBrowserPage.ts`.
- **Bump job (ADR-0017)**: `scripts/bump.ts` and `.github/workflows/bump.yml` (daily, and on demand; a
  passing new pin is pushed as `bump/<tag>` with a pull request).
- **Upstream drafts**: `docs/upstream/t3code-asks.md` (10 asks) and
  `docs/upstream/alchemy-plugins-dropped-on-update.md`.

## Patches, Shadows, Build shims

| Kind | Count | Items |
|---|---|---|
| Patch | **1** | `patches/0001-lazy-server-browser-ref-namespace.patch` (unchanged) |
| Shadow | **0** | |
| Build shim | **6** (as at the spike) | `node:fs`/`fs`/`node:fs/promises`/`fs/promises` alias of t3's modules (46 imports in 40 modules); `node:module`/`module` alias; `node:sea` stub; `@anthropic-ai/claude-agent-sdk` stub; `import.meta.url`/`dirname`/`filename` defines (counted as one) |
| Diagnostic transform | 1 | module-state probe: registers t3's module-level `let`/`var` and `Map`/`Set`/empty-container constants (191 bindings in 109 modules); changes no behaviour |

## Module-level state after a reset in a warm isolate

`/_t3flare/check/reboot` boots t3, disposes it and boots it again in the same isolate (what a reset with a
warm isolate does), checks both boots serve the descriptor with the same environment id, and lists the
registered bindings that no longer match their state at module evaluation. On production, every run found
the same two, both harmless, and no globals added:

- `packages/shared/src/observability.ts` `generatedServiceInstanceId`: a lazily generated id, kept for the
  isolate's life.
- `apps/server/src/mcp/McpSessionRegistry.ts` `activeMcpSessionRegistry`: set when the registry is acquired
  and cleared on release; replaced by the next boot. After `ctx.abort()` (no release) it points at the dead
  registry until the next boot, when nothing runs.

No Patch was needed. The idle-reset run also showed the warm isolate in practice: the object was
constructed twice and t3 booted three times in one isolate.

## ADR updates (in the same commit as this report)

- **0001**: step 1's counts and the diagnostic transform; the build refuses a Patch that fails `--check`.
- **0003**: the alarm must be made durable (`storage.sync()`) before `ctx.abort()`; what counts as due
  (outbox, scheduled tasks, usage-limit recovery, read with t3's own query) and as activity; the twice-boot
  findings.
- **0006**: the CTE fallback proven on production with turn items; where the adapter is tested.
- **0007**: 4 MiB chunk rows, range reads.
- **0010**: how step 1 implements it (Access only on the admin path, with a service-token policy; the
  Pairing window; the redacting Console; `remote-reachable`). The decision stands; the service-token policy
  is an addition, so CI and the acceptance test can call the admin routes.
- **0017**: the job as built; the point-in-time bookmark applies to stages with real data, not `bump`.
- **0019**: lock-pinning numbers. **0020**: the stage script is the only deploy path; the alchemy report draft.
- `GLOSSARY.md`: **Safe mode**, **Pairing window**. `docs/plan.md`: step 1 marked done; chunking wording.

## Owner actions

1. **GitHub secrets for the bump workflow** (repository `ian-pascoe/t3flare`, environment `bump`, created on
   the workflow's first run or by hand):
   - secret `CLOUDFLARE_API_TOKEN`: an account API token for account `4a76f86b5f2f8ed38206c6813459df1d` with
     *Workers Scripts Write*, *Secrets Store Write* (alchemy's state store), *Account Settings Read*,
     *Access: Apps and Policies Write* and *Access: Service Tokens Write*. (cloudpid's `infra/github.ts`
     shows how to mint one with alchemy's `admin` profile.)
   - variable `CLOUDFLARE_ACCOUNT_ID` = `4a76f86b5f2f8ed38206c6813459df1d`.
   - repository setting *Actions → General → Allow GitHub Actions to create and approve pull requests*, so
     the job can open the bump pull request with `GITHUB_TOKEN`.
2. **File the upstream drafts**: `docs/upstream/t3code-asks.md` and
   `docs/upstream/alchemy-plugins-dropped-on-update.md`.
3. **Access**: nothing to do. Each stage's Access application and service token are created by its deploy
   (the `default` profile had the scopes) and removed by its destroy. To use the admin routes from a browser,
   sign in to Access with the owner's email at `<host>/_t3flare/health` and send the admin token as
   `Authorization: Bearer …` (or use `bun scripts/stage.ts run <stage> admin …`).
4. Still open from the spike: whether to rotate `T3_BOOTSTRAP_TOKEN` after the first pairing. With the
   Pairing window the token is useless outside an armed window, so this step left it fixed per stage.

## What step 2a should know

- **One alarm.** A DO has one alarm, and the host now uses it twice (wake for t3's next due work after an
  idle reset; close the Pairing window). Anything else that needs a timer (Session pushes, turn deadlines)
  must go through the same place: extend `EnvironmentDO.#scheduleArmExpiry`/`checkIdle` into one "next alarm"
  computation rather than calling `setAlarm` elsewhere.
- **Writes before `ctx.abort()` must be synced.** On production an un-synced write is lost by the reset. Any
  code that resets the object (idle, restart, future recovery) should `await ctx.storage.sync()` first.
- **What keeps the Environment awake** is a client socket, a non-admin request in flight, a run or provider
  session in a live status in t3's projections, or a claimable outbox effect. Durable agent turns must show up
  as live runs/provider sessions in t3's projections (they do if the adapter writes them the usual way), or
  the Environment will reset under them after 60 s without a client.
- **t3's services from outside t3**: `Runtime.run(effect)` runs an effect against the context t3's layer graph
  built. Not every service is in that context (t3's `EventSinkV2` is not; the fixtures build a second one and
  restart t3 in place so its caches re-read SQL). Expose what 2a needs from `composition.ts` deliberately.
- **Deploys reach a running object only when it restarts** (spike); after `stage.ts deploy`, call
  `admin POST /_t3flare/restart` when the new code must run now. Production clocks do not advance during CPU
  work, so in-DO timings (`wallMs`) read 0.
- **t3 still spawns**: `git` and the CLIs fail as "not found" (`health.spawnAttempts`); *New project* fails
  (it runs `git init`); *Local folder* works.
- **Tests**: `apps/environment/test/` (`*.workerd.test.ts` run in workerd against real DO storage); stages:
  `bun scripts/stage.ts deploy|run|destroy step1|bump`; local: `bun run dev` (wrangler, admin token
  `local-admin-token`).

## Stages and deploys

`step1`: 3 deploys (create; the `sync()` fix; the usage-limit wake). `bump`: 1 deploy by the
bump job. Both destroyed with `bun scripts/stage.ts destroy <stage>` at the end, removing the Workers, their
Durable Objects, the Access applications and the service tokens.
