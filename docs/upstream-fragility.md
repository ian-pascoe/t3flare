# Upstream fragility register

Where t3flare is most likely to break when it follows t3code's nightly tags ([ADR-0017](adr/0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md)): every coupling to t3's internals, and to the non-t3 dependencies that move with them, ranked by likelihood × blast radius. Read it when the nightly bump (`scripts/bump.ts`, `.github/workflows/bump.yml`) fails, or before changing a file it names.

Line numbers are from `main` at `b75fa52`, with t3code pinned at `v0.1.9-nightly.20261111.4515` (`24e7747`). They drift; the symbol beside each one is the stable handle, so grep for it. Entries marked **step 3** are on branch `step-3` (`88a7697`), not yet on `main`.

## If the nightly bump fails

1. **Find the failed step.** The run's summary (the workflow's Report step) prints `bump-report.json`; the artifact `bump-report` holds it whole, with each failed step's last 4000 characters in `steps[].detail` and the acceptance test's `failures` in `acceptance.failures`. The pin is unchanged: the job rolled back.
2. **Go to the entries for that step:**

   | Failed step (`bump.ts`) | Usual causes |
   | --- | --- |
   | find the newest nightly tag (`:82`) | t3 changed its tag format: `NIGHTLY` at `bump.ts:66` |
   | regenerate the workspace and install (`:129`) | t3's `pnpm-workspace.yaml` or lock moved a dependency: [U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins) |
   | lock matches t3's, one effect (`:135`) | a second `effect`: [U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins) |
   | patches apply (`:139`) | [U10](#u10-patches) |
   | typecheck, lint, test (`:143`) | by the file the error names: `t3/composition.ts` [U1](#u1-the-composition-root-restates-t3s-serverts); `provider/*` [U3](#u3-the-provider-contract-provideradapterv2-and-the-differ); `shadows/*` [U11](#u11-the-shadow-builtindriversts); `terminal/*` [U12](#u12-terminalmanager-through-makewithoptions-and-the-pty-adapter); `workspace/*` [U17](#u17-workspace-layers-workspaceentries-workspacefilesystem-homedirectory-and-checkpoints); `agents/seedSettings.ts` [U19](#u19-settings-seeds) |
   | deploy the bump stage (`:149`) | a module-load failure in workerd ([U9](#u9-build-shims)), a missing Shadow export ([U11](#u11-the-shadow-builtindriversts)), alchemy ([U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins)), compat flags ([U21](#u21-cloudflare-compatibility-date-and-flags)) |
   | acceptance test (`:153`) | by the failure's prefix and the report key: `sqlAdapter` [U8](#u8-the-sql-adapter-and-the-pragmas-it-answers); the reboot check [U9](#u9-build-shims); pairing [U16](#u16-auth-pairing-and-the-workers-route-prefixes); `realTurn` [U3](#u3-the-provider-contract-provideradapterv2-and-the-differ), [U6](#u6-the-process-routers-git-argv-table), [U17](#u17-workspace-layers-workspaceentries-workspacefilesystem-homedirectory-and-checkpoints); `step 2b:` [U12](#u12-terminalmanager-through-makewithoptions-and-the-pty-adapter), [U18](#u18-git-worktree-list-and-the-worktree-verbs); `peer:` (step 3) [U5](#u5-mcp-delegate_task-and-linkorigin-step-3); fixtures [U26](#u26-the-acceptance-tests-own-fixtures) |
   | stock t3 nightly links and forwards (step 3) | the laptop half of [U7](#u7-client-version-skew-desktop-mobile-laptop) |

3. **Reproduce on your machine.** In a worktree: `git -C t3code checkout <tag> && bun scripts/gen-workspace.ts && bun install && bun run check`. That covers every step through tests; deploy and acceptance need the job's credentials (or a throwaway stage of your own, `apps/environment/scripts/stage.ts`). Restore with `git -C t3code checkout - && git checkout -- package.json bunfig.toml bun.lock scripts/lock-pins.report.md && bun install`.
4. **Land the fix with the pin.** A fix that needs the new tag cannot pass `bun run check` on the old pin. Push the fix on a branch and run the job there: `gh workflow run bump.yml --ref <branch> -f tag=<tag>` (if the `bump` environment admits the branch). On a pass it pushes `bump/<tag>` (your branch plus the pin commit) and opens the PR for the owner. A fix that works on both pins lands on `main` first and the next nightly picks it up.
5. **Before closing:** if the break was silent until something else tripped over it, add the check to [Gaps in detection](#gaps-in-detection).

## How to read an entry

- **Where**: our side, then t3's side (paths under `t3code/` are the pinned submodule).
- **Breaks when**: the upstream change most likely to break it.
- **Detection**: the bump step that catches it (patches, typecheck, tests, deploy, acceptance with its flag), or **silent**, with the cheapest check that would catch it.
- **Blast radius**: what a user sees.
- **Fix**: where to look first.

The bump runs: `git apply --check` of the Patches; typecheck, lint and tests of `apps/environment` only ([U27](#u27-the-bump-job-checks-less-than-bun-run-check)); a deploy of the `bump` stage; then `acceptance --real-turn --terminal --worktree` (and `--peer` plus a stock npm t3 nightly as the laptop, step 3).

## The register, ranked

### U1. The composition root restates t3's `server.ts`

- **Where**: `apps/environment/src/t3/composition.ts` (790 lines) restates the module-private layer graph of `t3code/apps/server/src/server.ts` (1230 lines), with departures marked `t3flare:`. Notable ones: `layerConfig` builds `ServerConfig.of({…})` field by field (`:217-267`); `layerPersistence` runs only `runMigrations()`, skipping t3's `Sqlite.layerSetup` (`:271-273`; `t3code/apps/server/src/persistence/Sqlite.ts:14`); `VcsAutomaticFetchInterval` is zero (`:414`); `ServerRestart` is `null` (`:556`); the routes are `HttpApiBuilder.layer(EnvironmentHttpApi)` with every group, `layerAssetRoute`, `layerAttachmentUploadRoute`, `Ws.layer`, `McpHttpServer.layer` and `RemoteDelegation` (`:688-730`; t3's at `server.ts:783`, served at `server.ts:1192`); `ServerRuntimeStartup.layerWithOptions` (`:749`; t3 `serverRuntimeStartup.ts:719`). It also calls constructors t3 exports but never documents: `ServerEnvironment.make` (`environment/ServerEnvironment.ts:186`), `RepositoryIdentityResolver.make` (`project/RepositoryIdentityResolver.ts:253`), `ServerConfig.deriveServerPaths`/`ensureServerDirectories` (`config.ts:139`, `:177`). Step 3 adds two seeds to `layerRuntimeCoreDependenciesBase` (`:608-609` on `step-3`).
- **Breaks when**: almost every nightly touches `server.ts`. A new service a kept layer needs; a new field on `ServerConfig`; a new route, reactor, worker or startup hook added beside the ones we restate; a renamed export.
- **Detection**: typecheck catches a missing requirement (the final layer must need nothing) and a new required `ServerConfig` field. **Silent**: a new route outside the HttpApi groups (404, or the web client's HTML through the assets), a new reactor or background worker started in `server.ts` but not here (the feature just never runs), a changed default that our hand-built config pins. Cheapest check: [T2](#gaps-in-detection), fingerprinting the `server.ts` regions we restate so any change to them fails the bump with "review `composition.ts`".
- **Blast radius**: from a feature that silently never runs (PR watching, settlement, scheduled tasks) to an Environment that fails to boot (every client sees "the Environment failed to start").
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/server.ts` and port each change to the matching block of `composition.ts`, keeping or marking each departure `t3flare:`.

### U2. The idle reset reads t3's private tables

- **Where**: `apps/environment/src/host/idle.ts`: `openWork` counts `orchestration_v2_projection_runs` and `orchestration_v2_projection_provider_sessions` whose status is not in `SETTLED_RUN_STATUSES` / `SETTLED_SESSION_STATUSES`, and claimable `orchestration_v2_effect_outbox` rows; `nextDue` reads `scheduled_tasks.next_run_at` and `orchestration_v2_projection_threads.payload_json` at `$.limitRecovery.resetAt`, `$.limitRecovery.autoResume` and `$.snoozedUntil` (a copy of t3's `ProjectionStoreV2.getLimitRecoveryWakeAt`). Since SPI-1024 these reads fail safe (ADR-0003's refinement): `rows` turns any error into `UnreadableTables`, on which the idle check does not reset (it logs `idle-check-unreadable` and backs off 10 minutes) and an alarm boots t3; a status it does not know counts as open. Step 3 adds more such reads: `linkedWorkOf` reads `$.linkOrigin` (`provider/adapter.ts:80-95` on `step-3`) and `reraiseQuestionsAfterRestart` reads `orchestration_v2_projection_runtime_requests` with `$.responseCapability.type` and threads' `$.delegatedFrom` (`agents/questionRestart.ts:27-37` on `step-3`).
- **Breaks when**: t3 renames a table or column, adds a run or session status (`awaiting_…`), moves a field inside `payload_json`, or changes how it computes the next wake.
- **Detection**: **silent**, but no longer dangerous for `idle.ts`: a missing table or column keeps the Environment up and logs `idle-check-unreadable` (the health route shows `openWork`/`nextDue` as `{ unreadable }`); a new status reads as open. Still silent: a field moved inside `payload_json` (reads as null: a missed wake), a new resting status (the DO never sleeps), and step 3's reads below. Cheapest check: [T4](#gaps-in-detection), a workerd test that runs t3's migrations and runs each of these queries, and compares the status lists with t3's run-status literals.
- **Blast radius**: high. A read that fails, or a status a nightly adds, now keeps the DO resident (cost) instead of resetting it. A moved `payload_json` field still means a usage-limited thread never resumes; a wrong settled list would still let the Environment abort itself under a running turn, which ends the turn (ADR-0004). Step 3: a linked thread's push stops asking for approval, or a delegated question is not raised again after a restart.
- **Fix**: compare each query with t3's own (`ProjectionStoreV2`, `EffectOutbox`, the migrations under `t3code/apps/server/src/persistence/Migrations/`), and the status lists with `OrchestrationV2RunStatus` in `@t3tools/contracts`.

### U3. The provider contract: `ProviderAdapterV2` and the differ

- **Where**: `apps/environment/src/provider/adapter.ts` builds `ProviderAdapter.ProviderAdapterV2.of({…})` (`:75`; t3 `t3code/packages/provider-core/src/server/ProviderAdapter.ts:722`, its event union at `:83-204`, `ProviderAdapterV2SessionRuntime` at `:630`). `provider/differ.ts` maps the Session's pushes to `provider_turn.updated`, `node.updated`, `message.updated`, `turn_item.updated`, `runtime_request.updated` and `turn.terminal` (`emitItem` `:136`, `emitResponse` `:240`, `emitTool` `:280`, `emitApprovals` `:331`, `failureOf` `:451`, `diff` `:481`), and builds turn items with `as OrchestrationV2TurnItem` (`:203`, `:395`, `:423`) and tool calls with `as unknown as` (`:500`). `provider/capabilities.ts` declares `PiDurableCapabilities` (`:7-99`, `satisfies OrchestrationV2ProviderCapabilities`). The approval request is `kind: "approval_request"` with `requestKind` and `prompt` (`differ.ts:355-400`). Restart continuation needs the provider thread's `nativeThreadRef` to be strong and of our driver (`adapter.ts:249`, `:257`; t3 `orchestration-v2/RestartContinuation.ts:147-158`). Step 3: a question (`ask_user`) becomes a `user_input` request in the shape of t3's Pi provider (`questionView`, `differ.ts:362-381` on `step-3`), answers arrive as `answers` (`adapter.ts:472-485` on `step-3`), and `supportsMcpTools` and `supportsStructuredQuestions` turn on. Attachments (SPI-993): `provider/attachments.ts` follows the Pi provider's `resolvePromptPayload` (`t3code/packages/provider-pi/src/server/adapter.ts:2669`). It reads files through `ProviderHost.resolveAttachmentPath` and `resolveExtractedTextPath`, inlines images whose type `isProviderSendTurnSupportedImageMimeType` accepts, and passes files as text.
- **Breaks when**: orchestration-v2 is t3's most active area. A new required field on a turn item, node or runtime request; a new event the orchestrator expects (a `provider_session.updated` before a turn, say); a new capability key; a changed request kind or answer shape; a new condition in the restart-continuation predicate. For attachments: a new `ChatAttachment` type (it is named as not readable, unless its bytes are UTF-8), or a new prompt context the Pi provider adds (SPI-1028).
- **Detection**: typecheck catches a changed adapter method, a new capability key, and fields on the objects not cast. The casts hide a new required turn-item field from typecheck; `acceptance --real-turn` catches it when t3 rejects or mis-renders the item (assistant text, an edit, `bash`, two approvals, the checkpoint). **Silent**: a capability whose meaning changed, the restart-continuation predicate (no bump step restarts mid-turn), the user-input shape (step 3; `--peer` does not ask a question). Cheapest checks: [T10](#gaps-in-detection) (build turn items with `satisfies`) and [T8](#gaps-in-detection) (a restart mid-turn in acceptance).
- **Blast radius**: high. Turns fail, items go missing, approvals cannot be answered, a restart ends a turn that should continue.
- **Fix**: diff t3's own Pi provider (`t3code/packages/provider-pi/src/server/`), whose shapes ours follows, and `ProviderAdapter.ts` between the two tags.

### U4. The descriptor's capability flags

- **Where**: `composition.ts:449-475` serves t3's own descriptor (`ServerEnvironment.make`, `t3code/apps/server/src/environment/ServerEnvironment.ts:186`; capabilities `:221-292`) minus four host-bound flags (`serverBrowser`, `voiceTranscription`, `localServerStop`, `fastWorktreeCheckout`, `:455-461`), with `label: "t3flare"` and `platform: { os: "linux", machine: "cloud" }`. The stock clients decide which features to show from these flags.
- **Breaks when**: t3 adds a flag for a feature that needs the host (a local browser, a native helper, a self-update path), which happens often; or renames one of the four.
- **Detection**: typecheck catches a renamed stripped flag (the destructuring names a missing property). **Silent**: a new flag is advertised as is. Cheapest check: [T3](#gaps-in-detection), a test of the capability keys against a classified list.
- **Blast radius**: the clients show a button or panel that fails in the cloud.
- **Fix**: classify the new flag: keep it, or strip it in `composition.ts` with a `t3flare:` note. [SPI-994](https://linear.app/spiritledsoftware/issue/SPI-994) strips the flags that already fail.

### U5. MCP, `delegate_task` and `linkOrigin` (step 3)

- **Where** (all on `step-3`): `EnvironmentDO.mcp` (`apps/environment/src/environmentDO.ts:172`) forwards a Session's MCP call to t3's `/mcp` with `authorization`, `mcp-session-id` and `mcp-protocol-version`; the adapter hands t3's per-thread MCP credential to the Session (`provider/adapter.ts:114`, from `McpProviderSessions.read`) with t3's `T3_CODE_ORCHESTRATION_INSTRUCTIONS` (`@t3tools/provider-core/server/orchestrationInstructions`); the Session's `t3-mcp` extension offers only `T3_TOOL_ALLOWLIST` (`apps/agents/src/extensions/t3-mcp.ts:32-78`, `delegate_task` among them), splits `t3_thread_wait`/`t3_background_wait` into `WAIT_PIECE_MS` pieces (`:81-83`), and adds a `clientRequestId` to tools whose schema has one (`:149`, `:183`); the seeds `linkedEnvironmentsEnabled` and `enableAgentBrowserAccess` (`agents/seedSettings.ts:50`, `:67`).
- **Breaks when**: t3 renames or adds a tool, changes a tool's input schema or annotations, changes how `/mcp` authenticates or its session headers, changes the instructions to name tools we do not offer, or changes `linkOrigin`'s shape.
- **Detection**: `acceptance --peer` (step 3) catches a broken link, forwarded launch or fence. **Silent**: the allowlist fails closed, so a renamed tool just disappears from the agent. Cheapest check: [T13](#gaps-in-detection), failing `--peer` on a tool `tools/list` returns that is neither allowed nor denied.
- **Blast radius**: delegation from the laptop to the cloud fails, or the agent loses a tool without notice.
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/mcp packages/provider-core/src/server/orchestrationInstructions.ts`, then classify each tool in `t3-mcp.ts`.

### U6. The process router's git argv table

- **Where**: `apps/environment/src/agents/processRouter.ts` answers every process t3 spawns: `routeOf` (`:417`), `git` (`:197`), the clone (`:99`), `GIT_INDEX_FILE` bridging (`:177`), `git --version` as `GIT_VERSION` (`:369`), `-C` folding (`:372`), and a `NotFound` for every other binary. The rules are in `agents/gitRoutes.ts`: `PASSIVE` reads that never start a stopped Container (`:24-52`) and their writing forms (`writes`, `:55`), `NETWORK` verbs that get the repo token (`:82`), `GIT_DIR_ONLY` reads cached by `.git` revision (`:100`), `cloneRequestOf`, which expects `git clone … <url> <name>` with cwd `/w` (`:135`), `gitEnvOf`, which drops `GIT_TRACE2*` (`:170`). t3's side is `t3code/apps/server/src/vcs/GitVcsDriverCore.ts` and `GitVcsDriver.ts`.
- **Breaks when**: t3 adds a git read to its status poll or diff panel (a new subcommand, or a writing form of a passive one), a new remote verb, a new clone argv, or a new binary it spawns.
- **Detection**: `--real-turn` catches a clone t3 no longer sends in our shape; `--worktree` the worktree verbs. **Silent**: a new passive read missing from `PASSIVE` starts the Container on every poll; a new remote verb missing from `NETWORK` runs without a token (a private repo fails with git's own message); a new binary gets `NotFound` (in `spawnAttempts`). Cheapest check: [T6](#gaps-in-detection), asserting from the router trace (`GET /_t3flare/agents/router-trace`) that t3's polls did not start a stopped Container.
- **Blast radius**: Container cost (a Workspace nobody works in stays awake), or a push or fetch that fails.
- **Fix**: read the router trace on the bump stage, then `git -C t3code diff <old>..<new> -- apps/server/src/vcs`.

### U7. Client version skew: desktop, mobile, laptop

- **Where**: the stock clients and the laptop's t3 update themselves on the nightly channel while the cloud stays pinned (ADR-0017); the owner's desktop already runs a newer nightly than the pin. The cloud advertises `serverVersion` and `orchestrationProtocolVersion` (`t3code/packages/contracts/src/environment.ts:13`, value 2) through the descriptor `composition.ts:449-475` builds. The web client is built from the pin (`stage.ts deploy … --web`); desktop and mobile are not.
- **Breaks when**: a newer client calls a WebSocket method or HTTP endpoint the pin lacks, sends a field the pin's schema rejects, or expects a capability or stream the pin does not offer.
- **Detection**: on `main`, **silent**: acceptance runs the pin's own client. Step 3 adds a stock npm t3 at its newest nightly as the laptop (`bump.ts` step "a stock t3 nightly from npm links to the bump stage", on `step-3`), which covers the Peer link only. That step can also fail on a broken upstream nightly the pin does not contain: read its detail before blaming the pin. Cheapest check: [T11](#gaps-in-detection), running the acceptance `/ws` client from the newest nightly's `@t3tools/contracts` against the bump stage.
- **Blast radius**: the owner's desktop or phone shows errors, or features that fail, until the next bump lands.
- **Fix**: bump. If the bump itself is blocked, the skew lasts as long as the block, so the bump is the fix.

### U8. The SQL adapter and the PRAGMAs it answers

- **Where**: t3's SQL client is the stock `@effect/sql-sqlite-do` client over our adapter (`platform/sql.ts:16`, ADR-0006). `platform/sqlAdapter.ts` works around DO SQLite's limits: `MAX_BOUND_PARAMETERS` 100 (inlines literals, `:15`, `inlineParameters` `:80`, which assumes positional `?`), `MAX_COMPOUND_TERMS` 5 (regroups `UNION` chains, `:16`, `:211`), and on DO SQLite's "nested too deep" (`:360`) runs each CTE alone through `json_each` (`materializeCtes`, `:318`). It answers the read form of `PRAGMA auto_vacuum`, `page_count` and `freelist_count` with 0 (`STORAGE_PRAGMA_READ` `:399`, in `adaptedExec` `:402`), which DO SQLite refuses and t3's `DatabaseStorage` reads every minute (`t3code/apps/server/src/persistence/DatabaseStorage.ts:80-81`, `:108-111`): `auto_vacuum` 0 means t3 never runs `incremental_vacuum`. `PRAGMA page_size` and `ProjectionMaintenance`'s reads (`orchestration-v2/ProjectionMaintenance.ts:301-302`) go to DO SQLite as they are. t3's `Sqlite.layerSetup` PRAGMAs never run (U1).
- **Breaks when**: t3 adds a heavier query (more CTEs, a recursive one), a statement with numbered placeholders, a PRAGMA in another form (`PRAGMA main.page_count`, `pragma_page_count()`), or a new use of these PRAGMAs (a `VACUUM` when `auto_vacuum` is 0).
- **Detection**: acceptance step 5 runs t3's heavy queries on 12 threads × 4 runs of fixtures and fails on any statement DO SQLite refuses (`sqlStats.errors`, admin health), except refusals with `SQLITE_AUTH` (`scripts/acceptance.ts:252-254`), which it only counts as `pragmaRefusals`. Only the queries those flows run are covered. **Silent**: a new refused PRAGMA, or any statement refused as unauthorized. Cheapest check: [T14](#gaps-in-detection), failing on `pragmaRefusals` now that the storage PRAGMAs are answered.
- **Blast radius**: a thread or search that fails to load, for every client; a Storage page that errors.
- **Fix**: the statement is in `sqlStats.errors` (`GET /_t3flare/health`); reproduce it in `apps/environment/test/sqlAdapter.test.ts` (Node) and `sqlAdapter.workerd.test.ts`, which also pins the PRAGMA answers.

### U9. Build shims

- **Where**: `apps/environment/build.ts` (ADR-0001, ADR-0020):
  - the import-scoped `node:fs`/`fs`/`node:fs/promises`/`fs/promises` alias of t3's own modules onto the State directory in DO SQLite (`FS_ALIASES` `:40-48`, `t3NodeFsAlias` `:156`; shims `src/shims/node-fs.ts`, `node-fs-promises.ts`). It rewrites only imports matching `IMPORT_SPECIFIER` (`:150`: line-anchored `import … from`, `export … from`, `} from`, and `await import(…)`) in modules matching `T3_MODULE` (`:37`: `apps/server/src/` and `packages/*/src/`). At the pin it rewrites 45 imports in 39 modules and skips 4 dependency imports (`dist/build-report.json`);
  - `node:module`/`module` (`src/shims/node-module.ts`): `createRequire` hands back a throwing stub for `NATIVE` (`:37`: `@ff-labs/fff-node`, `node-pty`, `ffi-rs`, `transcribe-cpp`, `@napi-rs/keyring`). t3 calls `createRequire(import.meta.url)` at module scope in `workspace/WorkspaceSearchIndex.ts:31`, `terminal/NodePtyAdapter.ts:39`, `vcs/CheckoutCloner.ts:32`, `policy/ManagedPolicy.ts:209`, `outboundHttp.ts:7`, `preview/ServerBrowserContexts.ts:13` and `packages/provider-cursor/src/server/sdk.ts:5`;
  - the `node:sea` stub (`BUILTIN_STUBS` `:60`; imported by `cliCompileCache.ts:5`, `speech/native.ts:3`, `bin.ts:3`, `packages/shared/src/HostProcess.ts:6`);
  - the generated `@anthropic-ai/claude-agent-sdk` stub (`DEPENDENCY_STUBS` `:69-72`, `dependencyStubs` `:208-230`), which exports the real package's names as throwing functions, and silently exports none when the real package fails to import;
  - the `import.meta.url`/`dirname`/`filename` defines (`DEFINES` `:288-294`);
  - the module-state probe (`:247`), which feeds the twice-in-one-isolate boot check (ADR-0003).
- **Breaks when**: t3 reads or writes its State directory through an import form the regex misses (a dynamic `import()` without `await`, or a module outside `src/`), adds a native package loaded through `createRequire`, adds module-scope randomness or I/O (workerd forbids it at global scope, as Patch 0001 works around), or adds module-level state that survives an abort.
- **Detection**: deploy catches module-scope I/O and randomness (workerd refuses the upload) and an unstubbed native `require` at module load; acceptance's reboot check catches new module state that differs after a second boot. **Silent**: a State-directory write the alias missed lands on workerd's in-memory file system and is lost on the next reset; a stub that exports no names. Cheapest check: [T5](#gaps-in-detection), asserting the build report (importers, skipped dependency imports, stub names) against the pin's.
- **Blast radius**: from a setting or key that forgets itself after an idle reset, to an Environment that does not deploy.
- **Fix**: `bun build.ts` and read `dist/build-report.json`; diff its `fsAlias` numbers against the last good build.

### U10. Patches

- **Where**: `patches/0001-lazy-server-browser-ref-namespace.patch` makes `refNamespace` lazy (t3 `apps/server/src/preview/ServerBrowserPage.ts:93`: `NodeCrypto.randomUUID()` at module scope, which workerd refuses). `patches/0002-new-project-root-is-w.patch` sets `namedProjectsRoot` to `/w` (t3 `apps/server/src/project/ManagedProjectFolders.ts:356`), so New project makes a Workspace. Applied in memory at bundle time (`build.ts:109-145`); the submodule stays clean.
- **Breaks when**: t3 edits the lines a Patch touches or their context.
- **Detection**: the bump's "patches apply" step (`build.ts --check`, `git apply --check`). A Patch that still applies but whose surroundings changed meaning (another module-scope random value elsewhere; a second use of the projects root) is caught by deploy and by `--real-turn` respectively.
- **Blast radius**: none in production: the bump stops and the pin stays.
- **Fix**: rebase the Patch on the new tag (`git -C t3code diff` the file between tags), or drop it if t3 fixed the cause. ADR-0001's refinement: a tiny Patch beats a large Shadow.

### U11. The Shadow `builtInDrivers.ts`

- **Where**: `apps/environment/src/shadows/builtInDrivers.ts` replaces `t3code/apps/server/src/provider/builtInDrivers.ts` (exports at `:20`, `:33`, `:47`, `:58`): `BUILT_IN_DRIVERS = [PiDurableDriver]`, `BUILT_IN_USAGE_DRIVERS = []`. The redirect (`SHADOWS` `build.ts:54-57`, `shadows` `:183-203`) applies only to relative imports from t3's modules (today `provider/ProviderInstanceRegistryHydration.ts:24` and `usage/UsageService.ts:34`).
- **Breaks when**: t3 adds an export to the module (its importers find nothing in ours), renames the module, or imports it through a package path the redirect does not see.
- **Detection**: a new export that something imports fails the build (deploy step) or reads as `undefined`. **Silent**: an import the redirect misses brings t3's stock drivers back beside ours (probes, spawn attempts, CLI providers in the picker). Cheapest check: [T5](#gaps-in-detection), asserting the build report's `shadows` equals `SHADOWS`.
- **Blast radius**: the provider picker lists CLI agents that cannot run, or the Environment does not build.
- **Fix**: diff the original between tags and mirror its exports.

### U12. TerminalManager through `makeWithOptions`, and the PTY adapter

- **Where**: `apps/environment/src/terminal/layer.ts` restates `TerminalManager.make` (t3 `apps/server/src/terminal/Manager.ts:1481-1512`) and calls its exported `makeWithOptions` (`Manager.ts:1514`) with `terminalManagerOptions` (`layer.ts:54-68`): a fixed `env`, our `ptyAdapter` (`terminal/ptyAdapter.ts`, shells in the Workspace's Container, ADR-0021), bash, a `subprocessInspector` from the rc file's markers, smaller history limits; and without `registerTerminalProcesses` or `resolveProviderInstanceEnvironment`. The options object is built by a function, so TypeScript runs no excess-property check on it. `platform/services.ts:27` makes the DO's own `PtyAdapter` fail every spawn.
- **Breaks when**: t3 renames an option (`env` falls back to `options.env ?? process.env`, `Manager.ts:1529`, and `process.env` is empty under `nodejs_compat_do_not_populate_process_env`), adds an option `make` passes that matters here, or changes `PtySpawnInput`/`PtyProcess`.
- **Detection**: typecheck catches a new required option and a changed PTY interface; `acceptance --terminal` catches a terminal that does not echo. **Silent**: a renamed optional option is dropped. Cheapest check: [T2](#gaps-in-detection) fingerprints `Manager.make`.
- **Blast radius**: terminals that do not open, or open without `TERM`.
- **Fix**: diff `Manager.make` between tags and mirror it in `terminalManagerOptions`.

### U13. Stale reads: t3's status argv, patched while the Container is stopped

- **Where**: `apps/agents/src/workspace/staleReads.ts`: `kindOf` (`:56-74`) recognises t3's argv exactly: `status --porcelain=2 --branch -z [--no-ahead-behind]` (t3 `GitVcsDriverCore.ts:2124-2131`), `diff-index -M --numstat -z HEAD --` (`:2193`), `ls-files --others --exclude-standard -z --`, and the review diff's `REVIEW_PREFIX` (`:39-50`; t3 `GitVcsDriverCore.ts:88`, `GitVcsDriver.ts:1496-1498`). Each is answered from the last real answer patched with computer's write journal; anything else gets the last answer alone (`WorkspaceDO.ts` `#stale`, `:542-571`).
- **Breaks when**: t3 adds, drops or reorders a flag in any of these argv.
- **Detection**: **silent**: the read falls back to `last-answer`, which is right until a file changes while the Container is stopped. Cheapest check: [T6](#gaps-in-detection) (the router trace shows `stale-last-answer` for a status read) and [T2](#gaps-in-detection) (the argv literals still appear in t3's source).
- **Blast radius**: the diff panel and changed-files count lag what the agent wrote, until the Container next runs.
- **Fix**: update `kindOf` and the patchers to the new argv.

### U14. Usage-limit recovery and its `resetAt`

- **Where**: the differ turns the model proxy's limit into t3's failure with `resetAt` as an ISO string, at least `MIN_RESET_MS` (30 s) after the turn (`provider/differ.ts:428-446`). t3's `UsageLimitRecoveryWorker` parses it (`t3code/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:33`), drops one not after the run's end, and arms recovery by comparing `recovery.resetAt !== thread.usageLimitResetAt` as strings (`:42`). The idle reset's wake reads the armed value back (U2).
- **Breaks when**: t3 changes the format it stores or compares, the overdue window, or what arms auto-resume.
- **Detection**: **silent**: no bump step hits a usage limit. Cheapest check: [T8](#gaps-in-detection), an acceptance case using the stage-only proxy fault (`POST /_t3flare/agents/proxy-fault`).
- **Blast radius**: a usage-limited thread never resumes, or resumes in a loop.
- **Fix**: `UsageLimitRecoveryWorker.ts` between tags; `apps/environment/test/proxyFailure.test.ts` covers the classification, and `apps/environment/scripts/part2.ts` exercises the recovery by hand.

### U15. The `gh` emulation

- **Where**: `processRouter.ts` `ghRouteOf` (`:408-415`): `gh --version` answers `gh version 2.83.0 (t3flare)` (`:409`); `gh config get …` answers an empty line (`:410`, for t3's `config get http_unix_socket`, `packages/source-control-github/src/server/GitHubHttpClient.ts:21`); `gh auth token` mints the Environment's GitHub App token (`ghToken`, `:87`; t3 sends `--hostname <host> [--user <account>]`, `GitHubCredentials.ts:153-165`); `gh auth status --json hosts` answers `{ hosts: { "github.com": [{ state, active, host, login, tokenSource }] } }` (`ghAuthStatus`, `:398`). t3's parsers: discovery takes the first line of `--version` (`apps/server/src/sourceControl/SourceControlDiscovery.ts:81-102`); `authArgs` and `parseGitHubAuth` (`packages/source-control-github/src/server/GitHubSourceControlProvider.ts:190-197`); the schema (`gitHubAuthStatus.ts:5-19`, `parseGitHubAuthStatus` `:43`).
- **Breaks when**: t3 adds a required field to the auth schema, changes `authArgs`, gates on a newer gh version, or calls another `gh` subcommand (it gets `NotFound`).
- **Detection**: **silent**: the bump runs no PR flow (`--push` is not in its flags) and checks no source-control status. Cheapest check: [T7](#gaps-in-detection), an acceptance check that t3's source-control discovery reports GitHub signed in.
- **Blast radius**: GitHub shows as signed out; PR creation, checks and linking disappear.
- **Fix**: diff `packages/source-control-github/src/server/` between tags; match the emulated answers.

### U16. Auth, pairing, and the Worker's route prefixes

- **Where**: the Worker forwards only `SERVER_PREFIXES` (`/api`, `/oauth`, `/.well-known`, `/ws`, `/mcp`, `/_t3flare`; `apps/environment/src/worker.ts:25`) to the DO; everything else is the web client's assets. The DO refuses a bootstrap credential outside the Pairing window on `BOOTSTRAP_EXCHANGE_PATHS` (`/api/auth/browser-session`, `/oauth/token`; `environmentDO.ts:62`, `#refuseDisarmedBootstrap` `:467`), parsing the body with `presentsBootstrapToken` (`host/pairing.ts:82`); t3's endpoints are in `t3code/packages/contracts/src/environmentHttp.ts` (`browserSession` `:570`). Step 3's acceptance also checks `/oauth/mcp/decision` (F11).
- **Breaks when**: t3 adds a route prefix, a new endpoint that exchanges a bootstrap credential, or a new body shape for one.
- **Detection**: acceptance's pairing checks catch a changed `browser-session` flow. **Silent**: a new exchange path skips our refusal (t3's own grant still governs it, so this is the belt-and-braces layer, ADR-0010); a new route prefix is answered with the web client's HTML. Cheapest check: [T12](#gaps-in-detection), a test that walks `EnvironmentHttpApi` for endpoints taking a credential and for path prefixes.
- **Blast radius**: a gap in the Pairing window's guarantee, or a client feature that gets HTML instead of JSON.
- **Fix**: add the path to `BOOTSTRAP_EXCHANGE_PATHS` or the prefix to `SERVER_PREFIXES`.

### U17. Workspace layers: `WorkspaceEntries`, `WorkspaceFileSystem`, `HomeDirectory`, and checkpoints

- **Where**: `apps/environment/src/workspace/layers.ts` wraps t3's stock services so `/w/…` paths are the Workspace DO's files over RPC: `layerWorkspaceEntries` (`:90`; `browse`, `list`, `search`, `searchContents`, `:99-198`) and `layerWorkspaceFileSystem` (`:211`; `getMetadata`, `readFile`, `writeFile`, `:235-325`), which reads `HostProcess.HomeDirectory`, set to `/w` (`platform/services.ts:59`; the other `HostProcess` values at `:53-68`). `workspace/checkpoints.ts` wraps `VcsDriverRegistry` (`:84-91`) so each driver's `checkpoints.*` for `/w` paths are answered by the Workspace DO with isomorphic-git (`ours`, `:39-77`); `diffCheckpoints` copies input fields one by one (`:54-66`).
- **Breaks when**: t3 adds a method (typecheck), adds an input field (our `/w` branch drops it), or changes the diff text it parses from checkpoints.
- **Detection**: typecheck catches a new method or a changed signature; `--real-turn` checks the turn's checkpoint lists the edited file. **Silent**: a new input field, such as a context-lines option on `diffCheckpoints`, is ignored for Workspaces.
- **Blast radius**: a file browser, search or diff that behaves differently in the cloud than on a laptop.
- **Fix**: diff `apps/server/src/workspace/` and `vcs/VcsDriver.ts` between tags.

### U18. `git worktree list` and the worktree verbs

- **Where**: `processRouter.ts` `worktreeList` (`:325`) answers `git worktree list --porcelain [-z]` with the project's own entry and one per worktree Workspace, in `worktreeListPorcelain`'s format (`gitRoutes.ts:262`); `worktreeAdd` (`:247`) provisions a worktree Workspace and refuses `--detach`; `worktreeCommandOf` (`gitRoutes.ts:199`) and `worktreeDestinationOf` (`:241`, `/w/.wt/<project dir>/<one segment>`) read t3's argv. t3 calls `worktree list --porcelain -z` and falls back to newline records (`GitVcsDriverCore.ts:1227-1240`).
- **Breaks when**: t3 parses another porcelain key (`locked`, `prunable`), changes where it puts worktrees, or adds a worktree verb.
- **Detection**: `acceptance --worktree` (a worktree thread's setup script, its removal, the sweep's dry run). A new verb answers `unsupported` with a clear message.
- **Blast radius**: worktree threads that cannot start or be removed.
- **Fix**: the router trace on the bump stage, then `GitVcsDriverCore.ts` between tags.

### U19. Settings seeds

- **Where**: `agents/seedSettings.ts`: `textGenerationModelSelection` points at the Durable agent provider's small model when it names an instance we lack (`:13-25`); `fastWorktreeCheckout` is pinned off (`:32-39`); step 3 adds `linkedEnvironmentsEnabled` on (`:50`) and `enableAgentBrowserAccess` off (`:67`). Through `ServerSettings.ServerSettingsService.updateSettings`.
- **Breaks when**: t3 renames a setting or changes what its default means.
- **Detection**: typecheck catches a rename. A changed default is silent but rarely matters, because each seed checks the current value.
- **Blast radius**: generated titles and commit messages fail (no model), or a setting the cloud cannot honour comes back on.
- **Fix**: `apps/server/src/serverSettings.ts` and the contracts' settings schema between tags.

### U20. Dependencies that ride t3's lock: alchemy beta, `patches/deps`, transitive pins

- **Where**: `scripts/gen-workspace.ts` takes t3's catalog, overrides and patched dependencies, and pins every package t3's lock holds at one version (`:76-96`), so a t3 bump moves alchemy (`t3code/pnpm-workspace.yaml:70`, `2.0.0-beta.85`), effect, zod and others under our own code too. Our own dependency patches are keyed by exact version (`patches/deps/@alchemy.run__cloudflare@2.0.0-beta.85.patch`, `patches/deps/@earendil-works__pi-durable@1.5.0.patch`; wired at `gen-workspace.ts:139-148`). `@alchemy.run/cloudflare-runtime` is pinned at `2.0.0-beta.85` by hand in `apps/environment/package.json`, and `build.ts:2-4` works around beta.85 dropping `build.input.plugins` (ADR-0020). `@earendil-works/pi-durable` (1.5.0) and `@cloudflare/computer` (0.9.0) are ours alone, but their dependencies (`diff`, `zod`, `ai`, `vite`, `capnweb`) can be pinned to t3's versions.
- **Breaks when**: t3 bumps alchemy; t3's lock moves a package pi-durable or computer depends on; `effect` resolves twice.
- **Detection**: install and `verify-lock` catch a second `effect`; deploy catches an alchemy that cannot deploy. **Silent**: when alchemy moves, the `patches/deps` patch keyed to beta.85 names a version nothing resolves, so it is simply not applied; nothing checks the key resolves, and `bump.ts:133` filters lines saying "no longer applies" out of the install step's detail. The bugs it fixed come back as flaky deploys. Cheapest check: [T9](#gaps-in-detection).
- **Blast radius**: flaky or failed deploys of prod; agent runtime errors after a transitive move.
- **Fix**: re-cut the patch for the new version (`bun patch`), move `cloudflare-runtime` with alchemy, re-check ADR-0020's workaround.

### U21. Cloudflare compatibility date and flags

- **Where**: `COMPATIBILITY` in `apps/environment/build.ts:31-34` (date `2026-11-01`, `nodejs_compat`, `nodejs_compat_do_not_populate_process_env`), used by `alchemy.run.ts:139`, `:162`; the agents Worker's own in `apps/agents/build.ts:12` and `apps/agents/vitest.config.ts:18-19`.
- **Breaks when**: t3 uses a Node API workerd only offers after a later date, or reads configuration from `process.env` (empty here).
- **Detection**: deploy and acceptance catch it on paths they run. **Silent** on rarely run paths, and for `process.env` defaults.
- **Blast radius**: a feature that throws in the cloud alone.
- **Fix**: move the date (both Workers, both vitest configs), or provide the value through `ServerConfig` (U1).

### U22. The unknown provider kind `piDurable`

- **Where**: `PI_DURABLE_DRIVER = ProviderDriverKind.make("piDurable")` (`provider/capabilities.ts:5`); display name "Pi Durable" (`provider/driver.ts:28-29`, `:55`). `ProviderDriverKind` is an open branded slug (`t3code/packages/contracts/src/providerInstance.ts:17`). Step 2a's R1 found the stock clients accept an unknown kind.
- **Breaks when**: a client switches exhaustively over known kinds (icons, settings forms, usage), or contracts close the kind to a literal union.
- **Detection**: typecheck catches a closed union. **Silent** for client UI: acceptance has no UI, and desktop and mobile are not built from the pin.
- **Blast radius**: the provider is hidden or a client screen crashes, on whichever client changed.
- **Fix**: t3's web client is in the submodule (`t3code/apps/web`); grep it for the switch. Fallback recorded in step 2a's plan (R1): register as kind `pi`.

### U23. `@cloudflare/computer` 0.9.0's private VFS tables

- **Where**: the Workspace DO reads computer's SQLite VFS tables directly: `vfs_meta` (`k = 'rev'`), `vfs_nodes`, `vfs_dirents`, `vfs_changes`, `_vfs_push_cursor`, `_vfs_watermark` (`apps/agents/src/workspace/changeLog.ts:33-113`, `readCache.ts:56-84`). The read cache's revisions and the stale reads' write journal (U13) come from them.
- **Breaks when**: we bump computer and it changes its schema (a t3 bump does not move computer itself).
- **Detection**: **silent**: no test asserts the schema. Cheapest check: [T4](#gaps-in-detection).
- **Blast radius**: wrong cached git answers (status and diffs that do not change), or a Workspace DO that throws on every read.
- **Fix**: the computer release's schema; pin computer until the reads are ported.

### U24. pi-durable 1.5.0 with cloudpid's patch

- **Where**: `@earendil-works/pi-durable` 1.5.0 (`apps/agents/package.json`, `packages/computer-env`, `packages/effect-durable`), patched by `patches/deps/@earendil-works__pi-durable@1.5.0.patch` (codemode's details capped to 64 KiB, `dist/codemode/codemode.js`, `dist/harness/scheduler.js`, `dist/harness/tool.js`). Its runtime events reach t3 through the Session's pushes and the differ (U3).
- **Breaks when**: we bump pi-durable (the patch is keyed to 1.5.0), or a t3 bump moves one of its dependencies (U20).
- **Detection**: a pi-durable bump is our own change and runs `bun run check`; `--real-turn` runs one turn. A lost patch is silent (U20).
- **Blast radius**: every Durable agent turn.
- **Fix**: re-cut the patch against the new `dist/`; re-run `--real-turn`.

### U25. Commissary's `/v1/models` and the alias scheme

- **Where**: `packages/models/src/catalog.ts` reads `GET /v1/models` twice, without and with `anthropic-version: 2023-06-01` (`:138-146`), and reads aliases back to real ids (`CLOAK_PREFIX = "claude-fable-5-dd-"` `:41`, `realIdOf` `:80`); `proxyFailure.ts` classifies Commissary's errors into t3's failures (`classifyProxyFailure`, `:94`). The contract is in [`docs/model-proxy.md`](model-proxy.md).
- **Breaks when**: Commissary changes either list's shape, the alias prefix, or its error bodies. Commissary moves on its own schedule, not t3's.
- **Detection**: `apps/environment/test/catalog.test.ts` and `proxyFailure.test.ts` pin today's shapes; `--real-turn` runs against the job's real proxy. A changed alias prefix is silent: those models show by alias.
- **Blast radius**: missing or oddly named models in the picker; usage limits shown as plain errors.
- **Fix**: `docs/model-proxy.md`, then the two modules.

### U26. The acceptance test's own fixtures

- **Where**: `apps/environment/src/host/fixtures.ts` writes turn items through t3's `EventSink` (`t3/src/orchestration-v2/EventSink.ts`, `runtimeLayer.ts`), building t3 contract objects by hand; acceptance step 4 expects 5 turn items per run.
- **Breaks when**: t3 changes the event or turn-item shapes.
- **Detection**: acceptance fails loudly ("fixtures written"). This is a false alarm about production, but a true one about U3: the same shapes are what the differ emits.
- **Blast radius**: none in production.
- **Fix**: update the fixtures alongside the differ.

### U27. The bump job checks less than `bun run check`

- **Where**: `scripts/bump.ts:143-147` runs typecheck, lint and tests of `apps/environment` only; `scripts/check.ts:24-41` also covers `apps/agents`, `infra` and the packages.
- **Breaks when**: a t3 bump moves a dependency the agents Worker or a package uses (effect, zod, alchemy).
- **Detection**: the agents Worker's deploy and `--real-turn` catch a runtime break. A type or lint error passes the bump, and the owner's merge of its PR then fails prod's own `bun run check` (`.github/workflows/deploy-prod.yml:76`). Cheapest check: [T1](#gaps-in-detection).
- **Blast radius**: `main` holds a pin prod never deployed, and every later push to `main` fails its deploy until someone fixes it.
- **Fix**: run `bun run check` in the bump.

## Gaps in detection

Checks worth adding, each closing a silent or late path above. Each has a ticket in Linear (team SPI, project ian-pascoe/t3flare).

| # | Check | Covers | Ticket |
| --- | --- | --- | --- |
| T1 | The bump runs the whole `bun run check` | U27, U20 | [SPI-1010](https://linear.app/spiritledsoftware/issue/SPI-1010) |
| T2 | Fingerprint the t3 code we restate or emulate (the `server.ts` layer graph and routes, `TerminalManager.make`, `ServerEnvironment.make`'s capabilities, the git argv and `gh` schema literals); the bump fails on any change until the matching file of ours is reviewed | U1, U12, U13, U15 | [SPI-1011](https://linear.app/spiritledsoftware/issue/SPI-1011) |
| T3 | A test of the descriptor's capability keys against a classified list (kept, stripped), failing on a new key | U4 | [SPI-1012](https://linear.app/spiritledsoftware/issue/SPI-1012) |
| T4 | A workerd test that runs t3's migrations, then each private-table query of `idle.ts` (and step 3's) and expects no `UnreadableTables`, and compares the status lists with t3's; the same for computer's VFS tables | U2, U23 | [SPI-1013](https://linear.app/spiritledsoftware/issue/SPI-1013) |
| T5 | Assert `dist/build-report.json` against the pin's: Shadows applied, alias importers, skipped dependency imports, stub names | U9, U11 | [SPI-1014](https://linear.app/spiritledsoftware/issue/SPI-1014) |
| T6 | Acceptance asserts from the router trace that t3's polls started no stopped Container and that patched read shapes were not answered `last-answer` | U6, U13 | [SPI-1015](https://linear.app/spiritledsoftware/issue/SPI-1015) |
| T7 | Acceptance asserts t3's source-control discovery shows GitHub signed in through the `gh` emulation | U15 | [SPI-1016](https://linear.app/spiritledsoftware/issue/SPI-1016) |
| T8 | Acceptance `--faults`: a usage limit through the stage's proxy fault arms and resumes; an Environment restart mid-turn continues the turn | U3, U14 | [SPI-1017](https://linear.app/spiritledsoftware/issue/SPI-1017) |
| T9 | Fail install when a `patches/deps` patch names a version `bun.lock` does not resolve, and stop filtering "no longer applies" | U20, U24 | [SPI-1018](https://linear.app/spiritledsoftware/issue/SPI-1018) |
| T10 | The differ builds turn items with `satisfies`, not `as`, so a new required field fails typecheck | U3, U26 | [SPI-1019](https://linear.app/spiritledsoftware/issue/SPI-1019) |
| T11 | Run the acceptance `/ws` client built from the newest nightly's contracts against the bump stage | U7 | [SPI-1020](https://linear.app/spiritledsoftware/issue/SPI-1020) |
| T12 | A test that walks `EnvironmentHttpApi` for endpoints taking a credential and for path prefixes, against `BOOTSTRAP_EXCHANGE_PATHS` and `SERVER_PREFIXES` | U16 | [SPI-1021](https://linear.app/spiritledsoftware/issue/SPI-1021) |
| T13 | Step 3: `--peer` fails on a tool from t3's `tools/list` that `t3-mcp.ts` neither allows nor denies | U5 | [SPI-1022](https://linear.app/spiritledsoftware/issue/SPI-1022) |
| T14 | Acceptance fails on any `SQLITE_AUTH` refusal (`pragmaRefusals`), now that t3's storage PRAGMAs are answered | U8 | [SPI-1023](https://linear.app/spiritledsoftware/issue/SPI-1023) |

