# Upstream fragility register

Where t3flare is most likely to break when it follows t3code's nightly tags ([ADR-0017](adr/0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md)): every coupling to t3's internals, and to the non-t3 dependencies that move with them, ranked by likelihood × blast radius. Read it when the nightly bump (`scripts/bump.ts`, `.github/workflows/bump.yml`) fails, or before changing a file it names.

Line numbers are from `main` at `b75fa52`, with t3code pinned at `v0.1.9-nightly.20261111.4515` (`24e7747`). They drift; the symbol beside each one is the stable handle, so grep for it. Entries marked **step 3** are on branch `step-3` (`88a7697`), not yet on `main`.

## If the nightly bump fails

1. **Find the failed step.** The run's summary (the workflow's Report step) prints `bump-report.json`; the artifact `bump-report` holds it whole, with each failed step's last 4000 characters in `steps[].detail` and the acceptance test's `failures` in `acceptance.failures`. The pin is unchanged: the job rolled back.
2. **Go to the entries for that step:**

   | Failed step (`bump.ts`) | Usual causes |
   | --- | --- |
   | find the newest nightly tag (`:98`) | t3 changed its tag format: `NIGHTLY` at `bump.ts:80` |
   | regenerate the workspace and install (`:157`) | t3 added a workspace setting ("classify it") or changed its lock's layout: [U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030); a patch no longer applies or matches nothing, or t3's lock moved a dependency: [U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins) |
   | lock matches t3's, one effect (`:161`) | a t3 importer installs other versions than in t3's lock, a second `effect`: [U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030), [U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins) |
   | check (`:167`) | `check:patches`: [U10](#u10-patches); `check:workspace`: [U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030); typecheck, lint or tests, by the file the error names: `t3/composition.ts` [U1](#u1-the-composition-root-restates-t3s-serverts); `provider/*` [U3](#u3-the-provider-contract-provideradapterv2-and-the-differ); `shadows/*` [U11](#u11-the-shadow-builtindriversts); `terminal/*` [U12](#u12-terminalmanager-through-makewithoptions-and-the-pty-adapter); `workspace/*` [U17](#u17-workspace-layers-workspaceentries-workspacefilesystem-homedirectory-and-checkpoints); `agents/seedSettings.ts` [U19](#u19-settings-seeds) |
   | deploy the bump stage (`:176`) | a module-load failure in workerd ([U9](#u9-build-shims)), a missing Shadow export ([U11](#u11-the-shadow-builtindriversts)), alchemy ([U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins)), compat flags ([U21](#u21-cloudflare-compatibility-date-and-flags)) |
   | acceptance test (`:180`) | by the failure's prefix and the report key: `sqlAdapter` [U8](#u8-the-sql-adapter-and-the-pragmas-it-answers); the reboot check [U9](#u9-build-shims); pairing [U16](#u16-auth-pairing-and-the-workers-route-prefixes); `realTurn` [U3](#u3-the-provider-contract-provideradapterv2-and-the-differ), [U6](#u6-the-process-routers-git-argv-table), [U17](#u17-workspace-layers-workspaceentries-workspacefilesystem-homedirectory-and-checkpoints); `step 2b:` [U12](#u12-terminalmanager-through-makewithoptions-and-the-pty-adapter), [U18](#u18-git-worktree-list-and-the-worktree-verbs); `peer:` (step 3) [U5](#u5-mcp-delegate_task-and-linkorigin-step-3); fixtures [U26](#u26-the-acceptance-tests-own-fixtures); `claude:`/`opencode:` (step 4b) [U33](#u33-our-acp-flavors-on-t3s-acp-adapter-step-4b), [U35](#u35-claude-codes-and-opencodes-configuration-surfaces-step-4b) |
   | stock t3 nightly links and forwards (step 3) | the laptop half of [U7](#u7-client-version-skew-desktop-mobile-laptop) |

3. **Reproduce on your machine.** In a worktree: `git -C t3code checkout <tag> && pnpm run relock && pnpm run check` (relock: gen-workspace, seed-lock, `pnpm install --no-frozen-lockfile`, verify-lock). That covers every step through tests; deploy and acceptance need the job's credentials (or a throwaway stage of your own, `apps/environment/scripts/stage.ts`). Restore with `git -C t3code checkout - && git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml mise.toml && pnpm install --frozen-lockfile`. Run pnpm from the repo, never inside `t3code/` (AGENTS.md).
4. **Land the fix with the pin.** A fix that needs the new tag cannot pass `pnpm run check` on the old pin. Push the fix on a branch and run the job there: `gh workflow run bump.yml --ref <branch> -f tag=<tag>` (if the `bump` environment admits the branch). On a pass it pushes `bump/<tag>` (your branch plus the pin commit) and opens the PR for the owner. A fix that works on both pins lands on `main` first and the next nightly picks it up. Until two nightlies have passed on pnpm and prod has deployed once more after the move to pnpm, hold bump PRs unmerged (ADR-0030, Rollback).
5. **Before closing:** if the break was silent until something else tripped over it, add the check to [Gaps in detection](#gaps-in-detection).

## How to read an entry

- **Where**: our side, then t3's side (paths under `t3code/` are the pinned submodule).
- **Breaks when**: the upstream change most likely to break it.
- **Detection**: the bump step that catches it (patches, typecheck, tests, deploy, acceptance with its flag), or **silent**, with the cheapest check that would catch it.
- **Blast radius**: what a user sees.
- **Fix**: where to look first.

The bump runs: the whole `pnpm run check` (`git apply --check` of the Patches, the workspace and lock checks, typecheck, lint and tests of every package); a deploy of the `bump` stage; then `acceptance --real-turn --terminal --worktree` (and `--peer` plus a stock npm t3 nightly as the laptop, step 3; `--codex --pi`, step 4a). Before the deploy, `test:docker` (step 4a): the pinned Codex and pi in Docker, launched by our profiles and request guard against the new t3, on the model proxy.

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
- **Detection**: typecheck catches a changed adapter method, a new capability key, and fields on the objects not cast. The casts hide a new required turn-item field from typecheck; `acceptance --real-turn` catches it when t3 rejects or mis-renders the item (assistant text, an edit, `bash`, two approvals, the checkpoint). **Silent**: a capability whose meaning changed, the restart-continuation predicate (no bump step restarts mid-turn; step 4a's `cli4a.ts restart-turn` proves it for the CLI agents by hand), the user-input shape (step 3; `--peer` does not ask a question). Cheapest checks: [T10](#gaps-in-detection) (build turn items with `satisfies`) and [T8](#gaps-in-detection) (a restart mid-turn in acceptance).
- **Blast radius**: high. Turns fail, items go missing, approvals cannot be answered, a restart ends a turn that should continue.
- **Fix**: diff t3's own Pi provider (`t3code/packages/provider-pi/src/server/`), whose shapes ours follows, and `ProviderAdapter.ts` between the two tags.

### U4. The descriptor's capability flags

- **Where**: `composition.ts` serves t3's own descriptor (`ServerEnvironment.make`, `t3code/apps/server/src/environment/ServerEnvironment.ts:186`; capabilities `:221-292`) through `cloudCapabilities` (`apps/environment/src/t3/capabilities.ts`), which strips every flag classified `strip` there, with `label: "t3flare"` and `platform: { os: "linux", machine: "cloud" }`. The stock clients decide which features to show from these flags. Settings with no flag are locked by t3flare's managed policy (`t3/managedPolicy.ts`, ADR-0023; t3's `ManagedPolicy.fromDocument`).
- **Breaks when**: t3 adds a flag for a feature that needs the host (a local browser, a native helper, a self-update path), which happens often; renames a flag; adds a setting for a host-bound feature; or changes the managed policy document's schema.
- **Detection**: typecheck (`CAPABILITIES … satisfies Record<keyof ExecutionEnvironmentCapabilities, …>`) and `test/capabilities.test.ts` fail on a new or removed flag, naming it (SPI-1012, T3). The policy test fails if t3 refuses the document. **Silent**: a new setting for a host-bound feature, and a flag t3 sends that its schema does not list.
- **Blast radius**: the clients show a button or panel that fails in the cloud.
- **Fix**: classify the new flag in `capabilities.ts` (keep, or strip with a one-line reason); lock a new host-bound setting in `managedPolicy.ts`.

### U5. MCP, `delegate_task` and `linkOrigin` (step 3)

- **Where** (all on `step-3`): `EnvironmentDO.mcp` (`apps/environment/src/environmentDO.ts:172`) forwards a Session's MCP call to t3's `/mcp` with `authorization`, `mcp-session-id` and `mcp-protocol-version`; the adapter hands t3's per-thread MCP credential to the Session (`provider/adapter.ts:114`, from `McpProviderSessions.read`) with t3's `T3_CODE_ORCHESTRATION_INSTRUCTIONS` (`@t3tools/provider-core/server/orchestrationInstructions`); the Session's `t3-mcp` extension offers every tool t3 lists but `T3_TOOL_DENYLIST` (`packages/harness-registry/src/t3Tools.ts`; owner, 2026-11-12, back to stock), splits `t3_thread_wait`/`t3_background_wait` into `WAIT_PIECE_MS` pieces (`:81-83`), and adds a `clientRequestId` to tools whose schema has one (`:149`, `:183`); the seeds `linkedEnvironmentsEnabled` and `enableAgentBrowserAccess` (`agents/seedSettings.ts:50`, `:67`).
- **Breaks when**: t3 renames or adds a tool, changes a tool's input schema or annotations, changes how `/mcp` authenticates or its session headers, changes the instructions to name tools we do not offer, or changes `linkOrigin`'s shape. Since `v0.1.10-nightly.20261112.4606`, t3 lists `tool_search` only to a client that sends `t3-tool-exposure: deferred` (`McpHttpServer.ts` `layerDeferredListing`); the Session sends no such header, so it gets every tool but `tool_search`, and `test/t3Guidance.test.ts` lists t3's tools the same way.
- **Detection**: `acceptance --peer` (step 3) catches a broken link, forwarded launch or fence; `test/t3Guidance.test.ts` fails when a denied name is no longer a t3 tool. **Silent**: a new tool that cannot work here is offered until someone denies it (stock t3's behaviour).
- **Blast radius**: delegation from the laptop to the cloud fails, or the agent loses a tool without notice.
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/mcp packages/provider-core/src/server/orchestrationInstructions.ts`, then deny a tool that cannot work here in `t3Tools.ts`.

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
- **Fix**: `node build.ts` and read `dist/build-report.json`; diff its `fsAlias` numbers against the last good build.

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

- **Where**: `apps/agents/src/workspace/staleReads.ts`: `kindOf` (`:56-74`) recognises t3's argv exactly: `status --porcelain=2 --branch -z [--no-ahead-behind]` (t3 `GitVcsDriverCore.ts:2124-2131`), `diff-index -M --numstat -z HEAD --` (`:2193`), `ls-files --others --exclude-standard -z --`, and the review diff's `REVIEW_PREFIX` (`:39-50`; t3 `GitVcsDriverCore.ts:88`, `GitVcsDriver.ts:1496-1498`). Each is answered from the last real answer patched with computer's write journal (at most `MAX_PATCHED_PATHS`); anything else gets the last answer alone (`staleRead`, called by `WorkspaceDO.ts` `#stale`). The two status shapes stand in for each other when one was never answered (`statusSibling`): t3's `statusDetails` (`readStatusDetailsLocal`, `GitVcsDriverCore.ts:2119`) sends the shape without `--no-ahead-behind`.
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

- **Where**: `processRouter.ts` `worktreeList` (`:325`) answers `git worktree list --porcelain [-z]` with the project's own entry and one per worktree Workspace, in `worktreeListPorcelain`'s format (`gitRoutes.ts:262`); `worktreeAdd` (`:247`) provisions a worktree Workspace and refuses `--detach`; `worktreeCommandOf` (`gitRoutes.ts:199`) and `worktreeDestinationOf` (`:241`, `/w/.wt/<project dir>/<one segment>`) read t3's argv. t3 calls `worktree list --porcelain -z` and falls back to newline records (`GitVcsDriverCore.ts:1227-1240`). After the add, t3 runs `git submodule init` and `git submodule update --init [--recursive]` in the worktree (setting `worktreeSubmodules`, built-in `recursive`; `GitVcsDriverCore.ts:4369-4440`); the Workspace keeps submodules Container-only by the paths `.gitmodules` names (`apps/agents/src/workspace/containerOnly.ts`, ADR-0009's 2026-11-11 refinement).
- **Breaks when**: t3 parses another porcelain key (`locked`, `prunable`), changes where it puts worktrees, adds a worktree verb, or checks submodules out somewhere `.gitmodules` does not name (they would sync into the DO: watch a worktree's `revision` in `GET /_t3flare/agents/workspaces`).
- **Detection**: `acceptance --worktree` (a worktree thread's setup script, its removal, the sweep's dry run). A new verb answers `unsupported` with a clear message.
- **Blast radius**: worktree threads that cannot start or be removed.
- **Fix**: the router trace on the bump stage, then `GitVcsDriverCore.ts` between tags.
- **Since `v0.1.10-nightly.20261112.4606`**: a new branch is made first in the project (`git branch --no-track -- <new> <start>`, then `branch --set-upstream-to` for a remote start), and the worktree is added without `-b`: `git -c checkout.workers=<n> worktree add -- <path> <new>`; t3 then refreshes the new worktree's index (`rev-parse --git-path index`, `update-index -q --refresh --force-write-index`). The path is `<worktrees dir>/<repo>/<branch prefix>-<16 hex>`, still one segment. `acceptance --worktree` passed on it. t3's commit now stages over stdin (`add -A --pathspec-from-file=- --pathspec-file-nul`), which no bump step exercises ([SPI-1091](https://linear.app/spiritledsoftware/issue/SPI-1091)).

### U19. Settings seeds

- **Where**: `agents/seedSettings.ts`: `textGenerationModelSelection` points at the Durable agent provider's small model when it names an instance we lack (`:13-25`); `fastWorktreeCheckout` is pinned off (`:32-39`); step 3 adds `linkedEnvironmentsEnabled` on (`:50`) and `enableAgentBrowserAccess` off (`:67`). Through `ServerSettings.ServerSettingsService.updateSettings`.
- **Breaks when**: t3 renames a setting or changes what its default means.
- **Detection**: typecheck catches a rename. A changed default is silent but rarely matters, because each seed checks the current value.
- **Blast radius**: generated titles and commit messages fail (no model), or a setting the cloud cannot honour comes back on.
- **Fix**: `apps/server/src/serverSettings.ts` and the contracts' settings schema between tags.

### U20. Dependencies that ride t3's lock: alchemy beta, `patches/deps`, transitive pins

- **Where**: the root workspace and lock follow t3's ([U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030)): t3's catalog, overrides and patches apply as they are and t3's packages resolve as in its lock, so a t3 bump moves alchemy (`t3code/pnpm-workspace.yaml:70`, `2.0.0-beta.85`), effect, zod and others under our own code too. Our own dependency patches are keyed by exact version (`patches/deps/@alchemy.run__cloudflare@2.0.0-beta.85.patch`, `patches/deps/@earendil-works__pi-durable@1.5.0.patch`; wired into `pnpm-workspace.yaml`'s `patchedDependencies` by `gen-workspace.ts`). `OUR_OVERRIDES` there holds a few of our core packages where Bun's pins held them (`workerd`, `@cloudflare/workers-types`, `@effect/sql-d1`). `@alchemy.run/cloudflare-runtime` is pinned at `2.0.0-beta.85` by hand in `apps/environment/package.json`, and `build.ts:2-4` works around beta.85 dropping `build.input.plugins` (ADR-0020). `@earendil-works/pi-durable` (1.5.0) and `@cloudflare/computer` (0.9.0) are ours alone, and their dependencies resolve within their own ranges (pnpm, unlike Bun's per-name pins, gives each package its declared version).
- **Breaks when**: t3 bumps alchemy; t3's lock moves a package pi-durable or computer depends on; `effect` resolves twice.
- **Detection**: when alchemy moves, the install fails on the `patches/deps` patch keyed to beta.85 (`ERR_PNPM_UNUSED_PATCH`), and on a patch that no longer applies; `verify-lock` fails on a second `effect` and on any t3-patched version installed unpatched; deploy catches an alchemy that cannot deploy.
- **Blast radius**: flaky or failed deploys of prod; agent runtime errors after a transitive move.
- **Fix**: re-cut the patch for the new version (`pnpm patch <pkg>@<version>`, edit, `pnpm patch-commit <dir> --patches-dir patches/deps`, then `pnpm run relock`), move `cloudflare-runtime` with alchemy, re-check ADR-0020's workaround.

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
- **Detection**: a pi-durable bump is our own change and runs `pnpm run check`; `--real-turn` runs one turn. A lost patch fails the install (U20).
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

### U27. The bump job checks less than `bun run check` (fixed)

Fixed by ADR-0030: `scripts/bump.ts` runs the whole `pnpm run check`, as prod's deploy does.

### U28. T3 Connect: the publish-only link and the publisher (step 3+)

- **Where**: `apps/environment/src/connect/service.ts` runs t3's `CliTokenManager.deviceAuthorizationLogin`, `store`, `getExisting`, `clear`; `CliState.setCliDesiredCloudLink`/`readCliDesiredLinkMode`; `CloudLink.reconcileDesiredLinkIfStillDesired`, `linkState`, `unlink`, `updatePreferences`; and reads and deletes t3's secret names (`cloud/config.ts`: `cloud-mint-ed25519-public-key`, `cloud-endpoint-runtime-config`, `cloud-relay-environment-credential`, `cloud-publish-agent-activity`; `cloud-cli-desired-link`, `cloud-cli-oauth-token`). `layerRefusingCloudLink` overrides four `CloudLink` methods by name. `connect/recorder.ts` matches `AgentAwarenessRelay`'s log messages ("publishing agent activity for thread", "agent activity publish completed", "… failed", "… deferred pending confirmation", "… retry budget exhausted") and their fields (`threadId`, `statePhase`, `ok`, `deliveries`, `cause`). `host/relayRoutes.ts` names the four relay routes. `src/t3/connectPublicConfig.ts` sets the `__T3CODE_BUILD_*` defines from `t3code/.env.example`. The relay's client API (`DELETE /v1/client/environment-links/:id`, `GET /v1/environments`, `GET /v2/client/devices`). The loopback-origin rule (`cloud/linkChecks.ts`).
- **Breaks when**: t3 renames a secret or a log message, adds a relay-initiated route or a `CloudLink` method that answers the relay, changes the mode default or the link step, moves the public values, or changes its retry and confirmation timings (the idle hold's bounds).
- **Detection**: typecheck catches a renamed method or export; `test/connectLink.test.ts` (t3's real `CloudLink` against a fake relay) a changed link step or secret name; `test/publishRecorder.test.ts` pins the message shapes, but a renamed message is **silent** (the recorder sees nothing, publishing still works); `test/connectPublicConfig.test.ts` fails on a changed `.env.example` value; `test/connectPhases.test.ts` a changed phase mapping. A new relay route is **silent**: cheapest check, extend T12 to list `/api/connect` and `/api/t3-connect` endpoints against `relayRoutes.ts` ([SPI-1034](https://linear.app/spiritledsoftware/issue/SPI-1034)).
- **Blast radius**: no phone notification (silent), or a relay route answered by t3.
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/cloud apps/server/src/relay/AgentAwarenessRelay.ts packages/contracts/src/relay.ts .env.example`; rerun `scripts/connect-m2.ts` on a linked stage.

### U29. Our Codex registration, client factory and request guard (step 4a)

- **Where**: `apps/environment/src/provider/cli/codexDriver.ts` calls t3's `makeCodexAdapterV2` (`t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`) with our `CodexAppServerClientFactoryShape` (t3's `layerAppServerClientFactory` restated without port discovery, spawning with the thread's cwd) and `CodexClient.layerChildProcess`; `provider/cli/codexGuard.ts` (back to stock, owner 2026-11-12: no allowlists) passes t3's requests but the provider pin, `feedback/*`, `account/*` and the per-turn policy; it once allowlisted app-server methods (the ones t3's adapter sends today) and thread config keys (`CODEX_THREAD_CONFIG` plus `shell_environment_policy.set.T3CODE_THREAD_ID`), and rewrites `turn/start`'s `approvalPolicy`/`approvalsReviewer`/`sandboxPolicy` from its mode table, reading `collaborationMode.mode`. `provider/cli/wrapper.ts` overrides `supportsMultipleProviderThreadsPerSession` (read by `Orchestrator.ts` `providerSessionIdFor` and `ProviderSessionManager.open`), and the fork error shape.
- **Breaks when**: t3 renames these exports or the factory's input; renames a `turn/start` field; starts naming a provider or policy in a thread config key the pin drops (dropped silently); changes its mode table (`codexPolicyForRuntimeMode`, which `turnPolicy` restates); stops reading the session capability for attaching threads.
- **Detection**: typecheck (exports, factory shape); `acceptance --codex` (a turn with approvals and a resume); `test/codexGuard.test.ts` (the mode table, written out). **Silent**: a new policy field, a changed mode table.
- **Blast radius**: Codex threads fail to start or turn; a mode runs with t3's own policy; a second project's thread could run in the first one's Container (F1) if the attach logic moved.
- **Fix**: diff `CodexAdapterV2.ts` between tags for `client.request(`, `codexThreadRuntimeParams`, `buildCodexTurnStartParams`; update `turnPolicy` and the pinned keys.

### U30. Our Pi registration, the extension copy and `processGroup.ts` (step 4a)

- **Where**: `provider/cli/piDriver.ts` calls `makePiAdapterV2` and imports `PiSettings` by path (`t3code/packages/provider-pi/src/…`, not exported); `agents/cliProfiles.ts` accepts only the flags `buildPiRpcLaunch` sends (`PI_FLAGS`), copies t3's extension from the State directory after checking it equals `PI_T3_MCP_EXTENSION_SOURCE`, and sets `T3_PI_RUNTIME_MODE`; `shadows/processGroup.ts` replaces `signalProcessGroup` (`rpc.ts`'s stop path); `build.ts` `FS_ALIAS_SKIP` keeps the `node:fs` alias out of the extension source's text; the wrapper drops events naming "t3-code MCP unavailable".
- **Breaks when**: t3 adds a pi flag (refused: `cli-spawn-refused` names it), renames the extension's variables or file, moves the source module (the skip no longer applies: pi exits 1 "Cannot find module …/shims/node-fs-promises.ts", logged as `cli-exited` with its stderr), stops importing `processGroup`, or changes the notice.
- **Detection**: `acceptance --pi`; `dist/build-report.json`'s `shadows` lists `processGroup.ts` (T5). **Silent**: a renamed mode variable (the extension would fall back to full access: `cliProfiles.test.ts` pins the name we set, not t3's).
- **Fix**: `git -C t3code diff <old>..<new> -- packages/provider-pi/src/server/mcpInjection.ts packages/provider-pi/src/server/mcpExtensionSource.ts packages/provider-pi/src/server/rpc.ts`.

### U31. CLI versions against t3's compatibility manifest (step 4a)

- **Where**: `apps/sandbox-image/src/clis.ts` (Codex 0.167.2, pi 1.5.2), the Dockerfile's `ARG`s and `image/cli/package-lock.json`; `apps/environment/test/cliManifest.test.ts` checks them against `model-manifest.json` (`resolveProviderCompatibility`) and `MINIMUM_PI_VERSION`.
- **Breaks when**: a nightly raises a minimum. **Detection**: tests ("bump the CLI in clis.ts"). **Fix**: bump the version, the digest and the lock together; re-run U32's checks.

### U32. The CLIs' own configuration surfaces (step 4a)

- **Where**: Codex's `-c` keys (`cliProfiles.ts` `codexOverrides`: the provider's `auth` command, `allow_login_shell`, the `features.*` that reach github.com and chatgpt.com, `shell_environment_policy.*`), pi's `models.json`/`settings.json` shape and its `PI_*` variables (`PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`).
- **Breaks when**: a CLI bump renames a key (Codex 0.167.2 already refuses a process-level `approval_policy="untrusted"`) or adds a default network call. These move with `clis.ts`, not with t3.
- **Detection**: `test:docker` (in the bump job) fails on a tunnel to any host but the proxy's, on an internal network whose only way out is a CONNECT logger; it covers the settings we pass, not a new call a CLI makes only in a feature we never use. Re-run M0's local probes (`docs/steps/step-4a/probes`: `p10b.sh`, `p8.sh`) on a CLI bump for what it does not cover; `acceptance --codex --pi` for the rest.

### U33. Our ACP flavors on t3's ACP adapter (step 4b)

- **Where**: `apps/environment/src/provider/cli/acpDriver.ts` calls `makeAcpAdapterV2` (`t3code/packages/provider-acp/src/server/adapter.ts`) and `AcpSessionRuntime.layer` by their option names (`sessionModeForPolicy`, `sessionConfigForPolicy`, `runtimeModeForSessionMode`, `ownedModelOptionIds`, `permissionDisposition`, `approvalOptions`, `promptFailure`, `requiresSignIn`, `resolveModelId`, `buildPrompt`, `registerExtensions`' `captureProposedPlan`, `followAgentWorkState`; `ownDetachedProcessGroup`, `ownDescendantProcessGroups`, `linuxCgroupController`, `processGroupPlatform`, `authenticateOnAuthRequired`, `extendEnv`, `requestLogger`), and imports `reg/claudeAcp.ts`'s extractors by source path. `acpFlavor.ts` `guardedRuntime` wraps the runtime's `setMode` (Claude's `auto`, falling back to `default` when not offered), `prompt`, `handleSessionUpdate` and `handleRequestPermission` (since the back-to-stock cut, owner 2026-11-12, it no longer ends a session whose agent changes mode), and reads ACP v2's `state_update` idle shape (`planTurnEnd`). It relies on t3's own approval options (no `approvalOptions` of ours since the cut), on `selectAutoApprovedPermissionOption` preferring `allow_once`, and on t3's plan handling moving a `mode`-category option to `plan`. Idle compaction's worker is not started (`composition.ts`) and its setting is locked (`managedPolicy.ts`).
- **Breaks when**: an option is renamed (typecheck); a default changes (silent: a new client capability on by default, the auto-approval preferring `allow_always`, a plan-mode change that stops using the mode option); the runtime gains a method our wrapper should guard (silent: it passes through); t3 starts calling `extractProposedPlanMarkdown` during a turn (harmless: the capture is deduplicated).
- **Detection**: typecheck; `test/acpAdapter.test.ts` (t3's adapter through our flavors against a scripted agent: the approval answers, the plan capture and denial, a mode change kept, Claude's `auto` and its fallback, OpenCode's auto-accepted edits and plan agent); `acceptance --claude --opencode`. **Silent**: ACP v2's plan-turn end (SPI-1047).
- **Blast radius**: from a turn that asks for nothing at `approval-required` to sessions that fail to open.
- **Fix**: `git -C t3code diff <old>..<new> -- packages/provider-acp/src/server/adapter.ts packages/provider-acp/src/server/AcpSessionRuntime.ts packages/provider-acp/src/server/clientPolicy.ts packages/provider-acp-registry/src/server/claudeAcp.ts`.

### U34. t3's kinds over a different adapter (step 4b)

- **Where**: `claudeAgent` and `opencode` are registered with ACP adapters and t3's own settings schemas (`ClaudeSettings`, `OpenCodeSettings`); t3's orchestrator still treats the kinds as native in places: `/goal` goes verbatim to `claudeAgent` (`Orchestrator.ts` `goalDriverFor`), idle compaction targets `claudeAgent` (`IdleCompactionService.ts`), OpenCode's goal support reads `supportsNativeGoals`.
- **Breaks when**: t3 adds behaviour keyed on the kind that assumes the native adapter (a Claude-only UI action, OpenCode's server settings, a native-only command), or the web client switches on the kind.
- **Detection**: **silent** for client UI and kind-keyed server paths. Cheapest check: grep `t3code/apps/server/src` and `t3code/apps/web/src` for `"claudeAgent"` and `"opencode"` at each bump (as U22).
- **Fix**: lock or strip what the cloud cannot honour (`managedPolicy.ts`, `capabilities.ts`), or refuse it in the flavor.

### U35. Claude Code's and OpenCode's configuration surfaces (step 4b)

- **Where**: `apps/environment/src/agents/acpProfiles.ts`: Claude Code's managed-settings keys (`apiKeyHelper`, `allowedProviders`, `availableModels`, `permissions.*`, `skipWebFetchPreflight`, `disableClaudeAiConnectors`, `sandbox`; the repository's `.claude/` is honoured otherwise since the back-to-stock cut, owner 2026-11-12), the variables pinned in its managed `env` (`CLAUDE_PINNED_EMPTY`) and its switches (`CLAUDE_CODE_*`, `DISABLE_*`); `claude-agent-acp`'s mode ids, option ids (`exit-plan-*`, `allow-once`), its `model`/`effort`/`mode` config options and `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2`; OpenCode's system configuration keys (`providers`, `policies` actions, `permissions` rules, `agents`, `plugins`, `snapshots`, `update`, `share`, `lsp`, `formatter`), its plugin API (`ctx.provider.transform`), its `OPENCODE_DISABLE_*` variables and its database tables (`permission`, `account*`, sanitised by the launcher); the image's launchers (`apps/sandbox-image/image/t3flare-claude-agent-acp`, `t3flare-claude-key`, `t3flare-opencode`, `opencode-key-plugin`).
- **Breaks when**: a CLI bump renames a key (OpenCode drops a statement it cannot read with only a log warning: the launcher ends the process on a diagnostic about our file), changes a mode or option id, renames its `auto` mode (t3's `auto` then stays in `default`), or adds a default network call. These move with `clis.ts`, not with t3.
- **Detection**: `test/acpProfiles.test.ts` validates OpenCode's file against the pinned 2.2.7 schema (`test/fixtures/opencode-2.2.7-config.schema.json`; refresh it with the CLI); `acceptance --claude --opencode`; re-run M0's probes (`docs/steps/step-4b/probes`: `p3.sh` egress, `p4-*.sh` hostile repo and modes) on a CLI bump; `test:docker` for these CLIs is SPI-1044.
- **Fix**: the CLI's own settings reference and changelog; then the profile and the probes.

### U36. Claude Code and OpenCode against t3's compatibility manifest (step 4b)

- **Where**: `apps/sandbox-image/src/clis.ts` (`claude` 2.1.322 through claude-agent-acp 0.106.0 and the SDK 0.3.322; `opencode` 2.2.7 and its tarball digest), the Dockerfile's `OPENCODE_*` ARGs and `image/claude/package-lock.json`; `cliManifest.test.ts` checks them against `model-manifest.json` for `claudeAgent` and `opencode`.
- **Breaks when**: a nightly raises a minimum. **Detection**: tests ("bump the CLI in clis.ts"). **Fix**: bump the version, the lock or digest together; re-run U35's checks.

### U37. Cards injected by the CLI wrapper (SPI-1040; the MCP relay's tool cards since the back-to-stock cut)

- **Where**: `apps/environment/src/provider/cli/wrapper.ts` raises the MCP relay's tool card (`cliAsk.ts`
  `approveCliTool`, ADR-0028) on a CLI thread's live turn: it emits `runtime_request.updated`, `node.updated` and `turn_item.updated` with an `approval_request` item (`t3code/packages/provider-core/src/server/ProviderAdapter.ts` `ProviderAdapterV2Event`) that the native agent never sent, with ids from `IdAllocator.derive.approvalNode`/`approvalTurnItem` and a runtime request id of its own prefix (`runtime-request:<driver>:t3flare-ask:`), and answers t3's `respondToRuntimeRequest` for that prefix itself. It learns the turn's `providerTurnId` from the adapter's `provider_turn.updated` whose `nodeId` is the turn's `rootNodeId` (as the ACP, Pi and Codex adapters emit it), numbers the card's turn item after the highest ordinal seen, and closes open cards before passing on `turn.terminal`. (Until the back-to-stock cut, owner 2026-11-12, it raised the push gateway's "Allow git push?" card too.)
- **Breaks when**: the event schema changes (typecheck); t3 validates a runtime request against the adapter's own state or snapshot (`readThreadSnapshot`) and drops ours; an adapter stops emitting its root `provider_turn.updated` before asking (the card is refused: "no live turn to ask on"); ordinals become unique per turn.
- **Detection**: typecheck; `test/cliCard.test.ts` (t3's ACP adapter wrapped, a scripted agent: the card's shape, the answers, withdrawal, the turn's end); `scripts/tools.ts` relay cases on a stage. **Silent**: t3 dropping the card without an error (the call is then refused after 10 minutes).
- **Blast radius**: relayed MCP writes from CLI threads that need a card are refused (fail closed).
- **Fix**: `git -C t3code diff <old>..<new> -- packages/provider-core/src/server/ProviderAdapter.ts apps/server/src/orchestration-v2/RunExecutionService.ts`; follow how t3 accepts and routes runtime requests.

### U38. Retired: t3's push argv, turned into expectations (SPI-992)

Retired with the push gateway (owner, 2026-11-12, back to stock): no Expectation is registered, and t3's own push goes
to GitHub as the agent's does.

### U39. Retired: no t3 path pushes for a linked agent (SPI-992)

Retired with the push gateway (owner, 2026-11-12, back to stock): a linked thread pushes under its own mode. Still
true and kept for another reason: `acpAdapterOptions` gives t3's ACP adapter no `clientTerminals`, since the
Environment DO runs no processes and an agent's commands belong in its Workspace (`test/cliCard.test.ts`).

### U40. Code mode and pi-codemode (tools step)

- **Where**: `apps/agents/src/extensions/codemode.ts` installs pi-durable's `codemode` and `tool-search` (`createCodemodeExtension` with a `RemoteCodemodeSandbox`, `callers`, `modelTools`, `deferred`, `pi.live.nestedTools`, `CodemodeToolDetails`); `apps/codemode-sandbox/src/worker.ts` hosts `CodemodeSandboxDurableObject` (`@earendil-works/pi-codemode/cloudflare`, its `quickjs-wasi/quickjs.wasm` import bundled by alchemy, `maxMemoryLimitBytes` 16 MiB). Approvals inside a script survive restarts through our pi-durable patch's `progressed` (#647) and its 64 KiB cap (#97), extending U24.
- **Breaks when**: a pi-durable or pi-codemode bump changes `CODEMODE_MODULE_VERSION` or the VM fingerprint (scripts in flight fail on replay), moves the wasm path, renames a live-doc field the differ reads, changes `maxMemoryLimitBytes`, or drops the patch.
- **Detection**: `apps/agents/test/codemodeGuards.test.ts` (nested calls run the guarded tools in each mode; replay across a restart with a pending approval; `progressed` present); `test/differNested.test.ts`; the stage's `scripts/tools.ts m1`, `hostile` and `probes` (P5). T9 (SPI-1018) for the patch. **Silent**: a fingerprint change shows only as failed scripts after a deploy with a script waiting.
- **Blast radius**: the Durable agent's code mode (scripts fail, "script failed, completed calls listed"); direct tool calls are unaffected.
- **Fix**: deploy a bump with no script waiting; re-check the live-doc fields against `dist/codemode/codemode.d.ts`; re-apply the patch.

### U41. Nested items in t3's thread (tools step)

- **Where**: `apps/environment/src/provider/differ.ts` turns a script's nested calls (`LiveSlim.nestedTools`) into child turn items with `OrchestrationV2TurnItem.parentItemId` and `ExecutionNode.parentNodeId`, ids from `IdAllocator.derive`, the way t3's own Pi provider shows codemode's nested calls (`t3code/packages/provider-pi/src/server/adapter.ts`).
- **Breaks when**: t3 changes how it validates or renders children, or its Pi provider stops nesting (then t3's clients may drop or flatten ours).
- **Detection**: typecheck (field shapes); `test/differNested.test.ts` (ids stable from live and committed states, `omittedCalls`); a look at a script's turn in the web client on a bump that touches the timeline.
- **Fix**: follow the Pi provider's current shape, or fall back to the script's summary item alone.

### U42. t3's MCP for CLI agents, as stock t3 hands it (SPI-1039)

- **Where**: `apps/environment/src/provider/cli/relayedMcp.ts` (`t3McpForCli`) rewrites only the `endpoint` of t3's `McpProviderSessionConfig` for each CLI driver, from t3's in-isolate address to `https://<T3FLARE_HOST>/mcp`; t3's per-thread bearer goes to the CLI unchanged (owner, 2026-11-12, back to stock; the first build's relay `mcp/t3Relay.ts` is gone). Codex takes it as `mcp_servers.t3-code` (`codexGuard.ts` `isT3Server`: https `/mcp`, one `Authorization`); pi through t3's `T3_MCP_URL_ENV`/`T3_MCP_BEARER_ENV` (`cliProfiles.ts`, https `/mcp` only); ACP agents as an HTTP `t3-code` entry built from the session's `T3_ACP_MCP_ENDPOINT`/`T3_ACP_MCP_AUTHORIZATION` (`acpDriver.ts`, since t3's own entry is a stdio bridge), admitted by Claude Code's `allowedMcpServers`. F7 relies on `t3_pending_request` answering `user_input` only.
- **Breaks when**: t3 changes how an adapter wires its MCP server or the environment variables carrying it, adds a direct-only server, or lets `t3_pending_request` answer approvals.
- **Detection**: `test/mcpRelay.test.ts` (Codex's and pi's t3 entries), `test/acpProfiles.test.ts`; the stage's `scripts/tools.ts cli-mcp <cli>` (`t3_thread_list` from each CLI) and `h6`; `acceptance --peer` F7. **Silent**: a CLI that quietly stops listing t3's tools (each CLI case fails, but only when run).
- **Fix**: follow the adapter's new wiring in `relayedMcp.ts` and `acpDriver.ts`.

### U43. The CLIs' MCP configuration surfaces (tools step; extends U32, U35)

- **Where**: `apps/environment/src/agents/cliProfiles.ts` (Codex `mcp_servers.<name>` with `bearer_token_env_var`, `default_tools_approval_mode="approve"`, `tool_timeout_sec` 900, `startup_timeout_sec`), `acpProfiles.ts` (Claude Code's managed `permissions.allow` for the relay's servers; OpenCode's tool permissions for the relay's tools and `t3-code`; the admission locks were removed, owner 2026-11-12, back to stock), the handles per process (review H2: never a Container-wide file).
- **Breaks when**: an image bump renames a key, changes a precedence (a repo's `opencode.json` or `.mcp.json` winning over ours) or a default timeout, or adds a CLI-side approval that answers before ours.
- **Detection**: `test/cliProfiles.test.ts` (snapshot of the managed files and argv); the stage's `cli-mcp <cli>` per CLI (read without a card, write asks, decline, full access, plan); `relay-hostile`.
- **Fix**: re-read the CLI's config reference at the new version; adjust the profile and its snapshot.

### U44. The MCP SDK pin, the vendored cloudpid MCP core, and Commissary's MCP contract (tools step)

- **Where**: `vendor/cloudpid/mcp` (`@cloudpid/mcp`, copied at cloudpid `93ba45a3`, OD-T10) on `@modelcontextprotocol/{client,core,server}` 2.4.0, run in `apps/mcp-worker` (no bindings, `global_fetch_strictly_public`); its OAuth helpers (`discoverOAuthServerInfo`, `selectResource`, `registerClient`, `startAuthorization`) for direct servers' sign-ins. Commissary's endpoint: its eras, `readOnlyHint` on read tools, its `<toolkit>_<tool>` names, its text fallbacks for pending approvals and connect links (like U25 for models).
- **Breaks when**: an SDK bump changes the client, the OAuth discovery or resource selection; a cloudpid sync changes `scrub.ts` or the call budget; Commissary changes its hints, fallbacks or name rule.
- **Detection**: the vendored core's tests and `apps/mcp-worker/test/sdk-isolation.test.ts` in `pnpm run check`; `test/mcpHost.test.ts`; the stage's `durable-mcp commissary` and `oauth`. **Silent**: a hint flip from write to read on a tool the owner never overrode (classes trust `readOnlyHint` since the back-to-stock cut, owner 2026-11-12, so the tool then runs without a card).
- **Fix**: sync from cloudpid as a copy (its README names the commit); re-run the stage cases.

### U45. Outbound-link policy Layers over t3's peer services (SPI-1061)

- **Where**: `apps/environment/src/t3/peerLinks.ts`, provided in `composition.ts` over t3's `PeerLinks`, `PeerForwarding` and `PeerLinkRequests` (`t3code/apps/server/src/peer/*`). Until a machine is registered (SPI-1061's M1), `link` is refused, `resolve` fails as `expired` (final: `PeerMcpClient` maps it to `capability_denied`, which `RemoteDelegation.isFinal` stops on), `list` is empty and probes nothing, `request` raises no link card, and no `PeerLinkError` carries a `cause`. Numbers U40–U44 belong to the tools step.
- **Breaks when**: a bump adds a method or a second path to a peer (a new service, a WS RPC that bypasses `PeerLinks`), renames or reshapes these services, or changes which failure reasons are final.
- **Detection**: typecheck (each wrapper spreads and overrides the whole service type); `test/peerLinks.test.ts` on t3's real layers (seeded row cannot be resolved, list empty, link refused, no cause); `acceptance --peer` check `outbound` (a web-client link attempt refused before any request; `GET /_t3flare/peer-links/count` is 0).
- **Fix**: wrap the new method or path in the same Layer; keep refusals on final reasons.

### U49. t3's orchestration guidance, filtered by the denylist (SPI-1060)

- **Where**: `packages/harness-registry/src/t3Guidance.ts` (re-exported by `apps/agents/src/extensions/t3-guidance.ts`) drops each bullet of t3's `T3_CODE_ORCHESTRATION_INSTRUCTIONS` and each sentence of an offered tool's description that names a denied tool (`T3_TOOL_DENYLIST`, `t3Tools.ts`), before the `t3_orchestration` section is rendered (`t3-mcp.ts`), for Durable agents (CLI agents get t3's full list and guidance, as stock t3 gives them); `peerLinks.ts` replaces `t3_environment_links`' `notListed` pointer at `t3_environment_link`. Since the back-to-stock cut (owner, 2026-11-12) it no longer fails closed on names it has not classified.
- **Breaks when**: t3 renames or drops a denied tool, restructures the instructions so a bullet no longer holds one tool's guidance, or names a denied tool in a tool result.
- **Detection**: `test/t3Guidance.test.ts` (every denied name, and each family's prefix, is still a t3 tool; the rendered prompt and descriptions name no denied tool) and `test/t3Mcp.test.ts`; `test/peerLinks.test.ts` for `notListed`. **Silent** for a denied tool named only in a result other than `t3_environment_links`.
- **Fix**: rename the entry in `t3Tools.ts`; extend the filter or the result rewrite.

### U50. The root workspace and lock are generated from t3's (ADR-0030)

- **Where**: `scripts/gen-workspace.ts` writes `pnpm-workspace.yaml` (our packages plus the t3 closure of `T3_ROOTS`; t3's settings by the `COPIED`/`ADJUSTED` allowlist; t3's patches only for packages we install; `OUR_OVERRIDES`, `OUR_ALLOWED_PEERS`, every build denied), `package.json`'s `packageManager`/`engines.node` and `mise.toml` from `t3code/pnpm-workspace.yaml` and `t3code/package.json`. `scripts/seed-lock.ts` copies t3's lock (both YAML documents; t3's importers re-keyed under `t3code/`) and `scripts/relock.ts` installs until the workspace settles. `scripts/verify-lock.ts` compares each t3 importer's transitive closure with t3's (`PEER_DRIFT` lists the three explained exceptions). t3's `.pnpmfile.cjs` does not run at our root (its hook guards mobile tarballs and Windows architectures only).
- **Breaks when**: t3 adds a top-level workspace setting; renames, splits or adds a package in the closure; changes its lock's document layout; moves a peer that our packages also bring (a new `PEER_DRIFT` case); bumps pnpm or Node (both follow t3's).
- **Detection**: the install step ("classify it" for a new setting; a missing importer); `verify-lock` (a moved version, with the importer and the keys); `check:workspace` (a stale generated file, or `t3code/node_modules/.pnpm` from a pnpm command run inside `t3code/`).
- **Blast radius**: the bump fails; nothing reaches prod.
- **Fix**: classify the new key in `gen-workspace.ts`; for a drift, find which of our packages pulls the other version (`pnpm why <name>`), and either pin it in `OUR_OVERRIDES` or list it in `PEER_DRIFT` with its reason.

## Gaps in detection

Checks worth adding, each closing a silent or late path above. Each has a ticket in Linear (team SPI, project ian-pascoe/t3flare).

| # | Check | Covers | Ticket |
| --- | --- | --- | --- |
| T1 | ~~The bump runs the whole `bun run check`~~ Done (ADR-0030): it runs `pnpm run check` | U27, U20 | [SPI-1010](https://linear.app/spiritledsoftware/issue/SPI-1010) |
| T2 | Fingerprint the t3 code we restate or emulate (the `server.ts` layer graph and routes, `TerminalManager.make`, `ServerEnvironment.make`'s capabilities, the git argv and `gh` schema literals); the bump fails on any change until the matching file of ours is reviewed | U1, U12, U13, U15 | [SPI-1011](https://linear.app/spiritledsoftware/issue/SPI-1011) |
| T3 | ~~A test of the descriptor's capability keys against a classified list (kept, stripped), failing on a new key~~ Done: `test/capabilities.test.ts` and typecheck | U4 | [SPI-1012](https://linear.app/spiritledsoftware/issue/SPI-1012) |
| T4 | A workerd test that runs t3's migrations, then each private-table query of `idle.ts` (and step 3's) and expects no `UnreadableTables`, and compares the status lists with t3's; the same for computer's VFS tables | U2, U23 | [SPI-1013](https://linear.app/spiritledsoftware/issue/SPI-1013) |
| T5 | Assert `dist/build-report.json` against the pin's: Shadows applied, alias importers, skipped dependency imports, stub names | U9, U11 | [SPI-1014](https://linear.app/spiritledsoftware/issue/SPI-1014) |
| T6 | Acceptance asserts from the router trace that t3's polls started no stopped Container and that patched read shapes were not answered `last-answer` | U6, U13 | [SPI-1015](https://linear.app/spiritledsoftware/issue/SPI-1015) |
| T7 | Acceptance asserts t3's source-control discovery shows GitHub signed in through the `gh` emulation | U15 | [SPI-1016](https://linear.app/spiritledsoftware/issue/SPI-1016) |
| T8 | Acceptance `--faults`: a usage limit through the stage's proxy fault arms and resumes; an Environment restart mid-turn continues the turn | U3, U14 | [SPI-1017](https://linear.app/spiritledsoftware/issue/SPI-1017) |
| T9 | ~~Fail install when a `patches/deps` patch names a version `bun.lock` does not resolve, and stop filtering "no longer applies"~~ Done (ADR-0030): pnpm fails on an unused or unappliable patch, and verify-lock on a t3-patched version left unpatched | U20, U24 | [SPI-1018](https://linear.app/spiritledsoftware/issue/SPI-1018) |
| T10 | The differ builds turn items with `satisfies`, not `as`, so a new required field fails typecheck | U3, U26 | [SPI-1019](https://linear.app/spiritledsoftware/issue/SPI-1019) |
| T11 | Run the acceptance `/ws` client built from the newest nightly's contracts against the bump stage | U7 | [SPI-1020](https://linear.app/spiritledsoftware/issue/SPI-1020) |
| T12 | A test that walks `EnvironmentHttpApi` for endpoints taking a credential and for path prefixes, against `BOOTSTRAP_EXCHANGE_PATHS` and `SERVER_PREFIXES` | U16 | [SPI-1021](https://linear.app/spiritledsoftware/issue/SPI-1021) |
| T13 | ~~Step 3: `--peer` fails on a tool from t3's `tools/list` that `t3-mcp.ts` neither allows nor denies~~ Moot since the denylist (owner, 2026-11-12, back to stock): a new tool is offered, as in stock t3 | U5 | [SPI-1022](https://linear.app/spiritledsoftware/issue/SPI-1022) |
| T14 | Acceptance fails on any `SQLITE_AUTH` refusal (`pragmaRefusals`), now that t3's storage PRAGMAs are answered | U8 | [SPI-1023](https://linear.app/spiritledsoftware/issue/SPI-1023) |

