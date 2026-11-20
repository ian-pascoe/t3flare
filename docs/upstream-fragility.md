# Upstream fragility register

Where t3flare is most likely to break when it follows t3code's release tags on the Deployment's t3 track ([ADR-0017](adr/0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md), [ADR-0041](adr/0041-a-deployment-follows-one-t3-track-set-as-a-deployment-setting.md); the Maintainer's follows stable, so each bump carries several nightlies' changes): every coupling to t3's internals, and to the non-t3 dependencies that move with them, ranked by likelihood × blast radius. Read it when the t3 bump (`scripts/bump.ts`, `.github/workflows/bump.yml`) fails, or before changing a file it names. The `Since v…-nightly…` notes below name the nightly a change first reached the pin in.

Line numbers are from `main` at `b75fa52`, with t3code pinned at `v0.1.9-nightly.20261111.4515` (`24e7747`). They drift; the symbol beside each one is the stable handle, so grep for it. Entries marked **step 3** are on branch `step-3` (`88a7697`), not yet on `main`.

## If the t3 bump fails

1. **Find the failed step.** The run's summary (the workflow's Report step) prints `bump-report.json`; the artifact `bump` holds it whole, with each failed step's last 4000 characters in `steps[].detail` (24000 for test:docker and the acceptance test, which also appends the stage's boot record) and the acceptance test's `failures` in `acceptance.failures`. The pin is unchanged: the job rolled back. The hourly job stops retrying a tag that failed the move, the lock check or `pnpm run check` twice on the same commit of main (`planT3`, its plan step logs why). A commit on main, a newer tag on the track or a run by hand (`gh workflow run bump.yml -f tag=<tag>`) tries again. On the Full gate, a failed acceptance test runs once more within the job (not on the Update gate, which must fail within 20 minutes). A pass on the second attempt keeps the first attempt's failures in `acceptanceRetry`, and the bump PR says so.
2. **Go to the entries for that step:**

   | Failed step (`bump.ts`) | Usual causes |
   | --- | --- |
   | find the newest `<track>` tag | t3 changed its tag format: `T3_TAG` in `src/updates/pins.ts` |
   | move t3code to `<tag>`, "does not contain the pin" | the newest tag on the track does not descend from the pin (a stable that promotes an older nightly than a nightly pin): nothing to fix; the bump waits for a later release on the track (ADR-0041) |
   | regenerate the workspace and install (`:157`) | t3 added a workspace setting ("classify it") or changed its lock's layout: [U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030); a patch no longer applies or matches nothing, or t3's lock moved a dependency: [U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins) |
   | lock matches t3's, one effect (`:161`) | a t3 importer installs other versions than in t3's lock, a second `effect`: [U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030), [U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins) |
   | check (`:167`) | `check:patches`: [U10](#u10-patches); `check:workspace`: [U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030); typecheck, lint or tests, by the file the error names: `t3/composition.ts` [U1](#u1-the-composition-root-restates-t3s-serverts); `provider/*` [U3](#u3-the-provider-contract-provideradapterv2-and-the-differ), but `provider/skills.ts`, `skillsSnapshot.test.ts` and `skillExpansion.test.ts` [U64](#u64-skills-and-prompt-templates-for-the-durable-agent-spi-1001); `provider/cli/claudeSkills.ts`, `builtInCommands.ts`, `cliSkills.test.ts` and `cliSkillDispatch.test.ts` [U65](#u65-the-cli-agents-skills-and-slash-commands-in-t3s-composer-spi-1151); `shadows/*` [U11](#u11-the-shadow-builtindriversts); `terminal/*` [U12](#u12-terminalmanager-through-makewithoptions-and-the-pty-adapter); `workspace/*` [U17](#u17-workspace-layers-workspaceentries-workspacefilesystem-homedirectory-and-checkpoints); `agents/seedSettings.ts` [U19](#u19-settings-seeds), [U67](#u67-text-generations-default-model-follows-the-model-endpoints-spi-1163); `provider/textGeneration.ts` and `endpointTextGeneration.test.ts` [U68](#u68-text-generation-names-the-endpoint-on-t3s-own-failures-spi-1163); `provider/cli/codexGuard.ts`, `codexEndpoints.ts`, `codexDriver.ts`, `cliProfiles.test.ts`'s Codex cases [U29](#u29-our-codex-registration-client-factory-and-request-guard-step-4a), [U69](#u69-codex-on-model-endpoints-through-the-model-relay-spi-1167); `provider/cli/claudeEndpoints.ts`, `acpProfiles.test.ts`'s relay cases [U75](#u75-claude-code-on-model-endpoints-through-the-model-relay-spi-1168); `provider/cli/opencodeEndpoints.ts`, `relayModels.ts`, `acpProfiles.test.ts`'s OpenCode relay cases [U76](#u76-opencode-on-model-endpoints-through-the-model-relay-spi-1169); `credentials/*`, agents' `session/planUsage.ts`, `sessionSignIn.test.ts` [U77](#u77-sign-ins-on-pi-ai-chatgpt-plan-usages-request-rules-and-the-credential-broker-spi-1164); `provider/cli/piEndpoints.ts`, `cliProcess.ts`'s line maps, `cliProfiles.test.ts`'s pi relay cases, `piSpawn.test.ts`, `piDriver.test.ts`, `piHandleCommand.test.ts` [U78](#u78-pi-on-model-endpoints-through-the-model-relay-spi-1170); `usage/records.ts`, `usage/readers.ts`, `usageRecords.test.ts`, `usagePage.test.ts`, agents' `workspace/relayUsage.ts`, `relayUsage.test.ts`, `sessionUsage.test.ts` [U79](#u79-the-usage-page-from-t3flares-own-usage-records-spi-1173); `models/src/failures.ts`, `redact.ts`, `modelFailures.test.ts`, `endpointFailures.test.ts` [U80](#u80-usage-limits-and-refused-credentials-classified-per-api-spi-1172); `credentials/claude.ts`, `claudeSignIn.test.ts`, `claudeBroker.test.ts`, agents' `claudeSignInShape.test.ts` [U81](#u81-the-claude-sign-in-on-pi-ai-claude-codes-oauth-client-and-request-shape-spi-1165); `credentials/copilot.ts`, `copilotSignIn.test.ts`, `copilotBroker.test.ts`, agents' `session/copilot.ts`, `copilotSignInShape.test.ts` [U82](#u82-the-github-copilot-sign-in-on-pi-ai-the-device-flow-the-copilot-token-and-its-request-shape-spi-1166); agents' `workspace/relaySignIns.ts`, `session/signInRequests.ts`, `session/claudeSignIn.ts`, `modelRelaySignIns.test.ts` [U83](#u83-subscription-sign-ins-through-the-model-relay-each-clis-request-on-a-vendors-subscription-shape-spi-1171); `models/src/limits.ts`, `usage/limits.ts`, `usage/limitSources.ts`, `limitMeters.test.ts`, agents' `limitReadings.test.ts` [U84](#u84-limit-meters-for-subscription-endpoints-vendors-limit-headers-and-t3s-limit-source-contract-spi-1174); `provider/readiness.ts`, the drivers' snapshots, `endpointsPicker.test.ts`, the CLIs' `*ModelId`/`codexModelRoute`/`piLineToPi` fallbacks, `setupStateSnapshots.test.ts`, `cliSpawnRefusal.test.ts` [U85](#u85-the-setup-state-and-the-fallback-of-old-selections-spi-1176) |
   | t3 code we restate, changed since its last review | never fails the bump: it lists each changed region or missing literal of the upstream fingerprint with our file to review and its entry, and each watched file whose bytes moved outside the watched regions (`upstreamFingerprint` in the report, the commit message and the PR's body). Such a pin does not land by itself: `land.yml`'s check refuses it ("this bump needs a person"), and an in-app Update of it fails there. Land it from a branch of your own (step 4). `unread` in its detail means the script could not run ([T2](#gaps-in-detection)) |
   | capability flags not yet classified | never fails the bump: it lists t3's new descriptor flags, stripped until classified ([U4](#u4-the-descriptors-capability-flags)). `unread` in its detail means `scripts/capabilities-unclassified.ts` could not import `@t3tools/contracts` |
   | the CLI agents in Docker (`:172`) | `skills.docker.test.ts`: a CLI moved a skill or command root; `envSkills.docker.test.ts`: a CLI stopped reading the Environment skill set through its link, or changed its winner of a same-named pair ([U65](#u65-the-cli-agents-skills-and-slash-commands-in-t3s-composer-spi-1151)); `claudeRelay.docker.test.ts`, `opencodeRelay.docker.test.ts` and `piRelay.docker.test.ts`: a CLI's path, key header or handle holders on the model relay ([U75](#u75-claude-code-on-model-endpoints-through-the-model-relay-spi-1168), [U76](#u76-opencode-on-model-endpoints-through-the-model-relay-spi-1169), [U78](#u78-pi-on-model-endpoints-through-the-model-relay-spi-1170)). Codex has no Docker test (its relay turns run on a stage: [U69](#u69-codex-on-model-endpoints-through-the-model-relay-spi-1167)) |
   | deploy the bump stage (`:176`) | a module-load failure in workerd ([U9](#u9-build-shims)), a missing Shadow export ([U11](#u11-the-shadow-builtindriversts)), alchemy ([U20](#u20-dependencies-that-ride-t3s-lock-alchemy-beta-patchesdeps-transitive-pins)), compat flags ([U21](#u21-cloudflare-compatibility-date-and-flags)) |
   | the bump stage starts its new build fresh (safe mode off) | the admin route `/_t3flare/safe-mode` refused past its retries (a deploy not yet serving, or the route moved); the stage's boot record (`stage.ts run bump health bootRecord,safeMode`) says why boots failed |
   | acceptance test (`:180`) | an uncaught `fetch failed` with `ECONNRESET`, no failures and a healthy boot record: Cloudflare's edge reset an HTTP/2 stream past `scripts/lib/resetRetry.ts`'s three attempts (not t3; rerun); otherwise by the failure's prefix and the report key: `sqlAdapter` [U8](#u8-the-sql-adapter-and-the-pragmas-it-answers); the reboot check [U9](#u9-build-shims); pairing [U16](#u16-auth-pairing-and-the-workers-route-prefixes); `realTurn` [U3](#u3-the-provider-contract-provideradapterv2-and-the-differ), [U6](#u6-the-process-routers-git-argv-table), [U17](#u17-workspace-layers-workspaceentries-workspacefilesystem-homedirectory-and-checkpoints); `step 2b:` [U12](#u12-terminalmanager-through-makewithoptions-and-the-pty-adapter), [U18](#u18-git-worktree-list-and-the-worktree-verbs); `peer:` (step 3) [U5](#u5-mcp-delegate_task-and-linkorigin-step-3); fixtures [U26](#u26-the-acceptance-tests-own-fixtures); `text generation names the Model endpoints' default` and the report's `modelEndpoint`/`textGeneration` (SPI-1175) [U67](#u67-text-generations-default-model-follows-the-model-endpoints-spi-1163); `claude:`/`opencode:` (step 4b) [U33](#u33-our-acp-flavors-on-t3s-acp-adapter-step-4b), [U35](#u35-claude-codes-and-opencodes-configuration-surfaces-step-4b) |
   | stock t3 nightly links and forwards (step 3) | the laptop half of [U7](#u7-client-version-skew-desktop-mobile-laptop); a refused launch model (`model_unavailable`): [U30](#u30-our-pi-registration-the-extension-copy-and-processgroupts-step-4a) |

3. **Reproduce on your machine.** In a worktree, from its root, first `export NPM_CONFIG_WORKSPACE_DIR=$PWD`: mise's value is the checkout the shell started in, so pnpm would act on that checkout instead, and the export holds for the restore's install too. Then `git -C t3code checkout <tag> && node scripts/relock.ts && pnpm run check` (relock: gen-workspace, seed-lock, `pnpm install --no-frozen-lockfile`, verify-lock; with node, not `pnpm run`: ADR-0030). That covers every step through tests; deploy and acceptance need the job's credentials (or a throwaway stage of your own, `apps/environment/scripts/stage.ts`). Restore with `git -C t3code checkout - && git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml mise.toml && pnpm install --frozen-lockfile`. Run pnpm from the repo, never inside `t3code/` (AGENTS.md).
4. **Land the fix with the pin.** Every bump run checks out the tip of `main`, whatever ref it was dispatched from (ADR-0037's trust split, `bump.yml`): a dispatch from a branch tests `main`, not the branch, and the acceptance test's own code is `main`'s too. So a fix, and any diagnostics added to the acceptance report, reach the bump job only by landing on `main`; then `gh workflow run bump.yml -f tag=<tag>` proves it (on a pass it pushes `bump/<tag>` and opens the PR). When the PR says the pin does not land by itself (the upstream fingerprint), the land check holds it until a person lands it (ADR-0037's SPI-1011 refinement). Cut a branch of your own from it (`git switch -c <name> origin/bump/<tag>`, then `git submodule update --init t3code`, or `--update` refuses): the hourly bump force-pushes `bump/<tag>`, which would drop a commit pushed there. Review each of our files the PR names against `git -C t3code diff <reviewedCommit> <tag> -- <file>`, fix them if needed, run `node apps/environment/scripts/upstream-fingerprint.ts --update`, commit, open a PR from your branch and merge it; then close the bump's PR, which yours supersedes. A fix that needs the new tag cannot pass `pnpm run check` on the old pin: make it work on both pins (a guard, a fallback), or prove it on a throwaway stage first (`apps/environment/scripts/stage.ts`). A pass that may be luck (a race, as [U18](#u18-git-worktree-list-and-the-worktree-verbs)'s 2026-11-18 entry, or any acceptance pass on its second attempt, which the PR's body flags) still proves the pin and stops the hourly job retrying that tag: hold its PR until the cause is fixed. Until two nightlies have passed on pnpm and prod has deployed once more after the move to pnpm, hold bump PRs unmerged (ADR-0030, Rollback).
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

- **Where**: `apps/environment/src/t3/composition.ts` (790 lines) restates the module-private layer graph of `t3code/apps/server/src/server.ts` (1230 lines), with departures marked `t3flare:`. Notable ones: `layerConfig` builds `ServerConfig.of({…})` field by field (`:217-267`); `layerPersistence` runs only `runMigrations()`, skipping t3's `Sqlite.layerSetup` (`:271-273`; `t3code/apps/server/src/persistence/Sqlite.ts:14`); `VcsAutomaticFetchInterval` is zero, provided above the whole server layer (`layer`), since t3 reads it in `GitVcsDriverCore`'s status reads as well as in `VcsStatusBroadcaster` and builds `GitVcsDriver` in several places (a `Context.Reference`: a missing override is t3's non-zero default, and typecheck says nothing); `RelayClientLedger` is a no-op (no relay client process, G12) and `KeepAwake` is not started (no host); `AgentScope` is t3's `make` without its `ProviderProcesses` layer (on Linux it reads `/proc/sys/kernel/random/boot_id`, which workerd lacks, so t3 failed to boot; its record and kill of a crashed server's CLI processes have nothing to act on here), the reference keeping its default; `ServerRestart` is `null` (`:556`); the routes are `HttpApiBuilder.layer(EnvironmentHttpApi)` with every group, `layerAssetRoute`, `layerAttachmentUploadRoute`, `Ws.layer`, `McpHttpServer.layer` and `RemoteDelegation` (`:688-730`; t3's at `server.ts:783`, served at `server.ts:1192`); `ServerRuntimeStartup.layerWithOptions` (`:749`; t3 `serverRuntimeStartup.ts:719`). It also calls constructors t3 exports but never documents: `ServerEnvironment.make` (`environment/ServerEnvironment.ts:186`), `RepositoryIdentityResolver.make` (`project/RepositoryIdentityResolver.ts:253`), `ServerConfig.deriveServerPaths`/`ensureServerDirectories` (`config.ts:139`, `:177`). Step 3 adds two seeds to `layerRuntimeCoreDependenciesBase` (`:608-609` on `step-3`).
- **Breaks when**: almost every nightly touches `server.ts`. A new service a kept layer needs; a new field on `ServerConfig`; a new route, reactor, worker or startup hook added beside the ones we restate; a renamed export.
- **Detection**: typecheck catches a missing requirement (the final layer must need nothing) and a new required `ServerConfig` field. **Silent**: a new route outside the HttpApi groups (404, or the web client's HTML through the assets), a new reactor or background worker started in `server.ts` but not here (the feature just never runs), a changed default that our hand-built config pins. The upstream fingerprint ([T2](#gaps-in-detection), `test/upstreamFingerprint.test.ts`) hashes every top-level statement of `server.ts` but its imports. Any change there fails `pnpm run check` with "review `apps/environment/src/t3/composition.ts` (U1)", and holds a bump for a person instead of landing by itself, until the fixture is updated after that review. What the review misses stays silent.
- **Blast radius**: from a feature that silently never runs (PR watching, settlement, scheduled tasks) to an Environment that fails to boot (every client sees "the Environment failed to start").
- **Since `v0.1.11-nightly.20261117.4825`**: ported t3's issues (`layerIssueService`, `ThreadIssueService` on the routes), `SecretCheck`, `UsageLimitResetFallback`, `EnvironmentTheme` above the settings, and the fetch interval's move to `vcs/VcsAutomaticFetchInterval.ts`. Stock t3 now reads that interval from a user setting; ours stays zero, so the setting does nothing here (a Workspace's git runs in its Container, not on a timer in this process). `AgentScope.make` still looks for `systemd-run`/`systemctl` to stop leftovers; workerd has neither, so it does nothing.
- **Since `v0.1.11-nightly.20261119.4928`**: `GitManager` needs `PullRequestService` (agents land a GitHub stack through it), provided as `server.ts` does; `McpHttpServer` gets its own `ProjectionStoreV2.layer`. t3's new `PreviewTunnel` (`layerPreview` and its `/api/preview/tunnel` route, a remote desktop's or phone's webview into the server's loopback ports) is not mounted: it dials this process's `127.0.0.1`, where nothing listens, so the route answers 404 as from an older server. A tunnel into a Workspace's Container would be new t3flare work beside G11's port discovery. Of the two new flags, `issueLinkedThreads` is kept and `accessTokenRenewal` stripped ([U4](#u4-the-descriptors-capability-flags)).
- **Since `v0.1.11-nightly.20261120.4979`**: `ws.ts`'s thread subscriptions need `ThreadViewers`, provided in `layerRuntimeDependencies` as `server.ts` does; it is the same memoized layer `RuntimeLayer.layerEventSink` uses, so both share one registry (a second instance would leave the sink ranking every thread unviewed, and typecheck would not say so). The routes get `ServerHttp.layerUnloggedSignedRequests`. The preview tunnel's new `enablePreviewTunnel` setting is locked off and its `previewTunnel` limit set to `false` in the managed policy ([U4](#u4-the-descriptors-capability-flags)).
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/server.ts` and port each change to the matching block of `composition.ts`, keeping or marking each departure `t3flare:`.

### U2. The idle reset reads t3's private tables

- **Where**: `apps/environment/src/host/idle.ts`: `openWork` counts `orchestration_v2_projection_runs` and `orchestration_v2_projection_provider_sessions` whose status is not in `SETTLED_RUN_STATUSES` / `SETTLED_SESSION_STATUSES`, and claimable `orchestration_v2_effect_outbox` rows; `nextDue` reads `scheduled_tasks.next_run_at` and `orchestration_v2_projection_threads.payload_json` at `$.limitRecovery.resetAt`, `$.limitRecovery.autoResume` and `$.snoozedUntil` (a copy of t3's `ProjectionStoreV2.getLimitRecoveryWakeAt`). Since SPI-1024 these reads fail safe (ADR-0003's refinement): `rows` turns any error into `UnreadableTables`, on which the idle check does not reset (it logs `idle-check-unreadable` and backs off 10 minutes) and an alarm boots t3; a status it does not know counts as open. Step 3 adds more such reads: `linkedWorkOf` reads `$.linkOrigin` (`provider/adapter.ts:80-95` on `step-3`), and SPI-1198's `threadLinkIn` reads `$.linkOrigin` and `$.lineage.parentThreadId` for the Settings server's caller ([U70](#u70-the-settings-servers-caller-threadlinkin-reads-the-thread-projection-spi-1198)) and `reraiseQuestionsAfterRestart` reads `orchestration_v2_projection_runtime_requests` with `$.responseCapability.type` and threads' `$.delegatedFrom` (`agents/questionRestart.ts:27-37` on `step-3`).
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

- **Where**: `composition.ts` serves t3's own descriptor (`ServerEnvironment.make`, `t3code/apps/server/src/environment/ServerEnvironment.ts:186`; capabilities `:221-292`) through `cloudCapabilities` (`apps/environment/src/t3/capabilities.ts`), which strips every flag classified `strip` there and sets the ones classified `advertise` from t3flare's own features (`serverSelfUpdate: "respawn"` on prod, [U88](#u88-the-respawn-server-update-and-its-outcome-in-app-updates-d2d7); ADR-0023's third classification), with `label: "t3flare"` and `platform: { os: "linux", machine: "cloud" }`. The stock clients decide which features to show from these flags. Settings with no flag are locked by t3flare's managed policy (`t3/managedPolicy.ts`, ADR-0023; t3's `ManagedPolicy.fromDocument`).
- **Breaks when**: t3 adds a flag for a feature that needs the host (a local browser, a native helper, a self-update path), which happens often; renames a flag; adds a setting for a host-bound feature; or changes the managed policy document's schema.
- **Detection**: a new flag no longer fails the bump (2026-11-19: t3 adds several a week, and two nightlies were blocked on one). An unclassified flag is **stripped** until it is classified, so the clients hide that feature, as they do for an older server. The bump's step "capability flags not yet classified" (`scripts/capabilities-unclassified.ts`) lists each one in the report (`unclassifiedCapabilities`), the pin's commit message and the bump PR's body. Typecheck (`satisfies { [K in keyof ExecutionEnvironmentCapabilities]?: … }`) and `test/capabilities.test.ts` still fail on a flag t3 removed or a misspelt key. The policy test fails if t3 refuses the document. The upstream fingerprint ([T2](#gaps-in-detection)) hashes `ServerEnvironment.make`'s capabilities object without its plain `flag: true` entries. A new unconditional flag passes, as above. A new conditional flag (`...(condition ? { flag: true } : {})`), or a changed condition or value on an existing one, holds the bump for review with "review `apps/environment/src/t3/capabilities.ts` (U4)": a host condition says something about whether the feature works in the cloud. **Silent**: a new setting for a host-bound feature. A new flag the clients need *present* for something that used to work without it is also silent, but acceptance catches it on the paths it covers.
- **Blast radius**: a stripped new feature stays hidden until it is classified. A flag wrongly kept makes the clients show a button or panel that fails in the cloud.
- **Fix**: classify the new flag in `capabilities.ts` (keep, strip with a one-line reason, or advertise t3flare's own value); lock a new host-bound setting in `managedPolicy.ts`. Classifying a flag is an excess key on a pin that lacks it, so the classification lands after the pin, in its own commit, unless the fix must land with the pin (step 4).
- **`previewTunnelSetting` (since `v0.1.11-nightly.20261120.4979`)**: stripped, and the policy locks `enablePreviewTunnel` off with the limit `previewTunnel: false`. The setting defaults to on, and t3's `allowsPreviewTunnel` (the setting and the limit) is what the web and mobile clients read before routing a loopback link through `/api/preview/tunnel`, which is not mounted here ([U1](#u1-the-composition-root-restates-t3s-serverts)); stripping the flag alone would hide the switch and leave the tunnel on.
- **`accessTokenRenewal` (since `v0.1.11-nightly.20261118.4903`)**: stripped. With it, a client pairs by exchanging a DPoP proof at `/oauth/token` (`client-runtime/src/connection/onboarding.ts`) and fails the pairing if that exchange fails, with no bearer fallback; no acceptance check pairs that way, and the proof binds the URL t3 sees behind the Worker. Without it, clients pair with a bearer as before. Keep it once acceptance pairs with a DPoP key.

### U5. MCP, `delegate_task` and `linkOrigin` (step 3)

- **Where** (all on `step-3`): `EnvironmentDO.mcp` (`apps/environment/src/environmentDO.ts:172`) forwards a Session's MCP call to t3's `/mcp` with `authorization`, `mcp-session-id` and `mcp-protocol-version`; the adapter hands t3's per-thread MCP credential to the Session (`provider/adapter.ts:114`, from `McpProviderSessions.read`) with t3's `T3_CODE_ORCHESTRATION_INSTRUCTIONS` (`@t3tools/provider-core/server/orchestrationInstructions`); the Session's `t3-mcp` extension offers every tool t3 lists but `T3_TOOL_DENYLIST` (`packages/harness-registry/src/t3Tools.ts`; owner, 2026-11-12, back to stock), splits `t3_thread_wait`/`t3_background_wait` into `WAIT_PIECE_MS` pieces (`:81-83`; t3 holds each at most 45 s, `MAX_WAIT_TIMEOUT_MS` in `apps/server/src/mcp/OrchestratorMcpService.ts`, and the `peer:` and outbound G1 acceptance checks floor a held wait at 1 s under that cap, `HELD_WAIT_FLOOR_MS` in `scripts/lib/peer.ts`: a change to the cap fails them), and adds a `clientRequestId` to tools whose schema has one (`:149`, `:183`); the seeds `linkedEnvironmentsEnabled` and `enableAgentBrowserAccess` (`agents/seedSettings.ts:50`, `:67`).
- **Breaks when**: t3 renames or adds a tool, changes a tool's input schema or annotations, changes how `/mcp` authenticates or its session headers, changes the instructions to name tools we do not offer, or changes `linkOrigin`'s shape (which also moves the Settings server's Linked-work check, [U70](#u70-the-settings-servers-caller-threadlinkin-reads-the-thread-projection-spi-1198)). Since `v0.1.10-nightly.20261112.4606`, t3 lists `tool_search` only to a client that sends `t3-tool-exposure: deferred` (`McpHttpServer.ts` `layerDeferredListing`); the Session sends no such header, so it gets every tool but `tool_search`, and `test/t3Guidance.test.ts` lists t3's tools the same way.
- **Detection**: `acceptance --peer` (step 3) catches a broken link, forwarded launch or fence; `test/t3Guidance.test.ts` fails when a denied name is no longer a t3 tool. **Silent**: a new tool that cannot work here is offered until someone denies it (stock t3's behaviour).
- **Blast radius**: delegation from the laptop to the cloud fails, or the agent loses a tool without notice.
- **Outbound direction (SPI-1061)**: a cloud Durable agent's `delegate_task` with a linked `environmentId` forwards `t3_project_list` and `t3_thread_launch` through t3's `PeerForwarding`, and t3's `RemoteDelegation` follows the Remote task from the Environment DO; the thread there carries `delegatedFrom` and `linkOrigin`. Detection: `scripts/outbound.ts --phase delegate` (C1) against the stage stand-in; see U46–U48.
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/mcp packages/provider-core/src/server/orchestrationInstructions.ts`, then deny a tool that cannot work here in `t3Tools.ts`.

### U6. The process router's git argv table

- **Where**: `apps/environment/src/agents/processRouter.ts` answers every process t3 spawns: `routeOf`, `git`, the clone, t3's temporary git material bridged into the Workspace (`gitBridge`, `bridgedGitEnv`; SPI-1186, below), `git --version` as `GIT_VERSION`, `-C` folding, and a `NotFound` for every other binary. The rules are in `agents/gitRoutes.ts`: `PASSIVE` reads that never start a stopped Container and their writing forms (`writes`), `NETWORK` verbs that get the repo token, `GIT_DIR_ONLY` reads cached by `.git` revision, `cloneRequestOf`, which expects `git clone … <url> <name>` with cwd `/w`, `gitEnvOf`, which drops `GIT_TRACE2*` and translates `GIT_ALTERNATE_OBJECT_DIRECTORIES` entry by entry (`alternatesInto`). t3's side is `t3code/apps/server/src/vcs/GitVcsDriverCore.ts` and `GitVcsDriver.ts`.
- **t3's temporary git material (SPI-1186)**: `agents/gitBridge.ts` leans on how t3 drafts a commit. `prepareCommitContext` (`GitVcsDriverCore.ts:2629`) makes `t3code-commit-index-*` with `makeTempDirectoryScoped` in its State directory, and runs git with `GIT_INDEX_FILE` (`<dir>/index`, a copy of the repo's), `GIT_OBJECT_DIRECTORY` (`<dir>/objects`, empty) and `GIT_ALTERNATE_OBJECT_DIRECTORIES` (`:2667-2672`): the repo's objects from `rev-parse --git-path index --git-path objects` (`:2636`), then each `alternate:` line of `count-objects -v` (`:2651`), every entry C-quoted (`quoted`, `:2655`) and joined with `:`. The review totals (`readUnifiedWorkingTreeReviewDiff`, `:3279`) make `t3code-review-index-*` with `makeTempFileScoped` and set `GIT_INDEX_FILE` alone. The bridge copies the index once and makes the object folder once per draft (`<harness>/tmp/index-<digest>/index`, `objects-<digest>`), and removes both when t3's own path is gone from the State directory (its scope ended: an interrupted draft's git may still run in the Container then); a Workspace's leftovers from an earlier isolate go on its first draft (which cannot see an overlapping older isolate's live draft during a deploy). An alternates entry on t3's side (`processRouter`'s `onT3Side`, the bridge's rule too) is dropped (logged `git-alternate-dropped`). The draft's two reads before its first write are on the Workspace DO's first-read allow-list and primed (`apps/agents/src/workspace/gitDirReads.ts`, ADR-0009's SPI-1186 refinement).
- **Breaks when**: t3 adds a git read to its status poll or diff panel (a new subcommand, or a writing form of a passive one), a new remote verb, a new clone argv, or a new binary it spawns. For the bridge: t3 sets another git path variable on its side (`GIT_COMMON_DIR`, `GIT_DIR`, a second index), reads a bridged file back itself, keeps its temp material past the draft's scope or in a place other than its State directory, changes the alternates list's quoting or separator, or changes the draft's two first reads (the allow-list matches their argv exactly).
- **Detection**: `--real-turn` catches a clone t3 no longer sends in our shape, and since SPI-1186 commits the turn's edit through t3's commit action (`lib/t3Commit.ts`), asserting the commit at HEAD lists the file: a variable the bridge misses fails it with git's `not a git repository` (t3 drops git's stderr, SPI-1182: read the router trace's detail). `--worktree` the worktree verbs. **Silent**: changed first reads of the draft lose the allow-list (a commit from a never-primed Workspace with its Container stopped fails; only `apps/agents/test/gitDirReads.test.ts` exercises that path, no stage case does), and bridged folders that are never reaped (`gitBridges` in the router trace, or `pgitobj.ts cleanup`). **Silent**: a new passive read missing from `PASSIVE` starts the Container on every poll; a new remote verb missing from `NETWORK` runs without a token (a private repo fails with git's own message); a new binary gets `NotFound` (in `spawnAttempts`). Cheapest check: [T6](#gaps-in-detection), asserting from the router trace (`GET /_t3flare/agents/router-trace`) that t3's polls did not start a stopped Container.
- **Blast radius**: Container cost (a Workspace nobody works in stays awake), or a push or fetch that fails.
- **Fix**: read the router trace on the bump stage, then `git -C t3code diff <old>..<new> -- apps/server/src/vcs`.

### U7. Client version skew: desktop, mobile, laptop

- **Where**: the stock clients and the laptop's t3 update themselves on their own update track while the cloud stays pinned (ADR-0017); a client on t3's nightly track runs ahead of a cloud on the stable t3 track (ADR-0041) by days of protocol, and meets t3's "switch tracks" note instead of an Update, so the Owner keeps the clients on the Deployment's track. The cloud advertises `serverVersion` (the stamped Server version, [U87](#u87-the-server-version-stamp-in-app-updates-d1)) and `orchestrationProtocolVersion` (`t3code/packages/contracts/src/environment.ts:13`, value 2) through the descriptor `composition.ts` builds (`layerServerEnvironment`). The web client is built from the pin (`stage.ts deploy … --web`, with `APP_VERSION`); desktop and mobile are not. Since ADR-0037 a stock client offers its server Update on prod ([U88](#u88-the-respawn-server-update-and-its-outcome-in-app-updates-d2d7)): the skew lasts until the owner presses it, not until the next manual merge. A client whose protocol is newer than the pin's reaches that Update through `client-runtime/src/connection/outdatedHostUpdate.ts` (`updateOutdatedHost`), which opens a bare `/ws` with no `orchestrationProtocol` query.
- **Breaks when**: a newer client calls a WebSocket method or HTTP endpoint the pin lacks, sends a field the pin's schema rejects, or expects a capability or stream the pin does not offer. For the protocol-blocked path: the pin's own `/ws` (`ws.ts` `hasCompatibleOrchestrationProtocol`) answers the bare socket 426 (true at `v0.1.11-nightly.20261117.4825`), and `OUTDATED_HOST_RESTART_TIMEOUT` (4 minutes) is shorter than an Update (5–18 minutes), so that path reports failure while the Update goes on.
- **Detection**: on `main`, **silent**: acceptance runs the pin's own client. The Full gate adds a stock npm t3 at the track's dist-tag (`latest` or `nightly`) as the laptop (`bump.ts` step "a stock t3 from npm (…) links to the bump stage"), which covers the Peer link only; it can also fail on a broken upstream release the pin does not contain: read its detail before blaming the pin. `test/outdatedHostUpdate.test.ts` runs t3's outdated-host update against our descriptor and answer, and records that its socket carries no protocol. Cheapest check: [T11](#gaps-in-detection), running the acceptance `/ws` client from the newest nightly's `@t3tools/contracts` against the bump stage.
- **Blast radius**: the owner's desktop or phone shows errors, or features that fail, until he presses Update. A protocol-blocked client cannot press it (426), and must be updated from a client on the pin's protocol or by the hourly bump's pull request.
- **Fix**: press Update (or merge the proposed pin). If the bump itself is blocked, the skew lasts as long as the block, so the bump is the fix.

### U87. The Server version stamp (in-app updates D1)

- **Where**: `apps/environment/serverVersion.ts` reads `git -C t3code tag --points-at HEAD` and names the pin by its tag on the Deployment's t3 track (`pinTagOf`: a stable's commit carries a nightly tag too, and `git describe`'s pick between them reported prod as stable while it tracked nightly, ADR-0041); `build.ts`'s `serverVersionStamp` plugin serves `t3code/apps/server/package.json` (by real path) with that version, so every `import packageJson from "../package.json"` in t3's server (about 20 readers: `ServerEnvironment.ts`, `serverRuntimeState.ts`, `cloud/selfUpdate.ts`, our `updates/selfUpdate.ts`) sees it; `scripts/stage.ts` passes it to `prepare:web` as `APP_VERSION`, which `t3code/apps/web/vite.config.ts` (`configuredAppVersion`) reads first. Off an exact tag the manifest's own version (`0.1.10`) stands, and `stage.ts deploy prod` refuses. t3's release CI does the same by writing the manifest (`t3code/scripts/update-release-package-versions.ts`).
- **Breaks when**: t3 reads its version some other way (a define, a generated module, `process.env`), moves the server manifest, renames `APP_VERSION`, or changes its tag format (`v<x.y.z>`, `v<x.y.z>-nightly.<date>.<run>`), or stops promoting a nightly's commit to a stable.
- **Detection**: acceptance step 2c asserts the tag, the descriptor's `serverVersion` and a web script's `APP_VERSION` agree (`scripts/lib/versionAgreement.ts`); deploy-prod's smoke check asserts `serverVersion` is the tag; `build.ts` prints the stamped version and `dist/build-report.json` records it. **Silent**: a reader that bypasses the manifest (a second version source) reports `0.1.10` while the descriptor is right.
- **Blast radius**: every stock client says the Environment is out of date (or not, when it is), and offers an Update to a version that is already running, which the target policy refuses.
- **Fix**: `git -C t3code grep -n "packageJson.version\|APP_VERSION"` between tags; stamp the new source.

### U88. The `respawn` server Update and its outcome (in-app updates D2–D7)

- **Where**: `apps/environment/src/updates/selfUpdate.ts` replaces `ServerSelfUpdate.layer` and `ServiceLauncherClient.layer` in `composition.ts` (`CloudSelfUpdate.layer` on the routes, `layerLauncherClient` as `layerLauncher`); `ws.ts` reads the service by tag (`[WS_METHODS.serverUpdateServer]`). It leans on: the `respawn` literal of `ServerSelfUpdateCapability` and `ServerSelfUpdateMethod` (`contracts/src/environment.ts`); the client's handling in `client-runtime/src/state/server.ts`: `respawn` takes no accepting-`ready` baseline (only `boot-service` does), the unary `serverUpdateServer` is used because `serverSelfUpdateProgress` is stripped, and the wait for a `ready` lasts `SERVER_UPDATE_RESUME_TIMEOUT` (32 minutes); `matchesServerUpdateReadyEvent` matches `ready.payload.updateOutcome.id` to the answer's `updateId`, and `validateServerUpdateReadyEvent` wants `committed` with `serverVersion` equal to the target, else fails with the outcome's `reason`; `serverRuntimeStartup.ts` puts `launcher.prepareTrial(...)`'s outcome on its startup `ready` (a failure there fails the boot, so ours never fails); `ServerLifecycleEvents.publish` keeps only the newest event per type and `ws.ts`'s `subscribeServerLifecycle` replays it, which is how the failed outcome reaches a client that reconnects.
- **Breaks when**: t3 drops or renames `respawn`, gives it a baseline, changes the outcome's shape or how the client matches it, shortens the resume timeout below an Update's length, changes `prepareTrial`'s signature, or stops replaying the newest `ready`.
- **Detection**: typecheck (the service shapes, the outcome schema, the literal); `test/updates.test.ts` (outcomes, `prepareTrial`), `test/capabilities.test.ts`, `test/outdatedHostUpdate.test.ts`. **Silent**: a client-side change in matching or timeouts: the client then reports a failure (or waits) while the Update lands. Cheapest check: a trial Update on a throwaway stage with an update target pointing at a fork.
- **Blast radius**: the Update lands, but the button says it failed, or spins until its timeout.
- **Fix**: `git -C t3code diff <old>..<new> -- packages/client-runtime/src/state/server.ts apps/server/src/cloud apps/server/src/serverRuntimeStartup.ts`.

### U92. The 32-minute resume timeout against the Update's length (in-app updates D7; review A2)

- **Where**: t3's `SERVER_UPDATE_RESUME_TIMEOUT` (32 minutes, `client-runtime/src/state/server.ts`) against the windows of `updates/records.ts` and `selfUpdate.ts`: a record expires `UPDATE_EXPIRY_MS` (110 minutes) after the DO **first sees its run started** (a status out of `queued`/`waiting`/`pending`/`requested`; not `run_started_at`, which can be the run's creation, review A10), a run that waits its turn in the `bump` group for `QUEUED_CEILING_MS` (3 hours) without starting has failed, a dispatch GitHub never lists within `UNLISTED_MS` (15 minutes) has failed, and a failed outcome is replayed at boot for `FAILED_REPLAY_MS` (35 minutes) after it settled. The run's own ceilings are plan's 5 minutes, the bump job's 20, publish's 15, the land's check 5 and its push and follow 60 (deploy-prod's 45 and a queue in its group): 105, leaving 5 for runners to pick up each job.
- **Breaks when**: t3 shortens the client's timeout, or an Update waits behind other bump runs (`queue: max`) longer than the client waits.
- **Detection**: **silent**: the client says it could not confirm the update; the record still settles, and a client that reconnects within the replay window sees the outcome.
- **Blast radius**: a misleading "could not confirm" for an Update that landed or failed later.
- **Fix**: keep the windows ordered: a run's job timeouts < `UPDATE_EXPIRY_MS` from its start; a settled outcome replayed longer than the client waits (35 > 32 minutes); a queued run's ceiling longer than any queue the hourly bump and Updates make.

### U8. The SQL adapter and the PRAGMAs it answers

- **Where**: t3's SQL client is the stock `@effect/sql-sqlite-do` client over our adapter (`platform/sql.ts:16`, ADR-0006). `platform/sqlAdapter.ts` works around DO SQLite's limits: `MAX_BOUND_PARAMETERS` 100 (inlines literals, `:15`, `inlineParameters` `:80`, which assumes positional `?`), `MAX_COMPOUND_TERMS` 5 (regroups `UNION` chains, `:16`, `:211`), and on DO SQLite's "nested too deep" (`:360`) runs each CTE alone through `json_each` (`materializeCtes`, `:318`). It answers the read form of `PRAGMA auto_vacuum`, `page_count` and `freelist_count` with 0 (`STORAGE_PRAGMA_READ` `:399`, in `adaptedExec` `:402`), which DO SQLite refuses and t3's `DatabaseStorage` reads every minute (`t3code/apps/server/src/persistence/DatabaseStorage.ts:80-81`, `:108-111`): `auto_vacuum` 0 means t3 never runs `incremental_vacuum`. `PRAGMA page_size` and `ProjectionMaintenance`'s reads (`orchestration-v2/ProjectionMaintenance.ts:301-302`) go to DO SQLite as they are. t3's `Sqlite.layerSetup` PRAGMAs never run (U1).
- **Breaks when**: t3 adds a heavier query (more CTEs, a recursive one), a statement with numbered placeholders, a PRAGMA in another form (`PRAGMA main.page_count`, `pragma_page_count()`), or a new use of these PRAGMAs (a `VACUUM` when `auto_vacuum` is 0).
- **Detection**: acceptance step 5 runs t3's heavy queries on 12 threads × 4 runs of fixtures and fails on any statement DO SQLite refuses (`sqlStats.errors`, admin health), except refusals with `SQLITE_AUTH` (`scripts/acceptance.ts:252-254`), which it only counts as `pragmaRefusals`. Only the queries those flows run are covered. **Silent**: a new refused PRAGMA, or any statement refused as unauthorized. Cheapest check: [T14](#gaps-in-detection), failing on `pragmaRefusals` now that the storage PRAGMAs are answered.
- **Blast radius**: a thread or search that fails to load, for every client. (The Storage page's database row no longer reads these answers: `t3/databaseStorage.ts`, U86.)
- **Fix**: the statement is in `sqlStats.errors` (`GET /_t3flare/health`); reproduce it in `apps/environment/test/sqlAdapter.test.ts` (Node) and `sqlAdapter.workerd.test.ts`, which also pins the PRAGMA answers.

### U9. Build shims

- **Where**: `apps/environment/build.ts` (ADR-0001, ADR-0020):
  - the import-scoped `node:fs`/`fs`/`node:fs/promises`/`fs/promises` alias of t3's own modules onto the State directory in DO SQLite (`FS_ALIASES` `:40-48`, `t3NodeFsAlias` `:156`; shims `src/shims/node-fs.ts`, `node-fs-promises.ts`). It rewrites only imports matching `IMPORT_SPECIFIER` (`:150`: line-anchored `import … from`, `export … from`, `} from`, and `await import(…)`) in modules matching `T3_MODULE` (`:37`: `apps/server/src/` and `packages/*/src/`). At the pin it rewrites 45 imports in 39 modules and skips 4 dependency imports (`dist/build-report.json`);
  - `node:module`/`module` (`src/shims/node-module.ts`): `createRequire` hands back a throwing stub for `NATIVE` (`:37`: `@ff-labs/fff-node`, `node-pty`, `ffi-rs`, `transcribe-cpp`, `@napi-rs/keyring`). t3 calls `createRequire(import.meta.url)` at module scope in `workspace/WorkspaceSearchIndex.ts:31`, `terminal/NodePtyAdapter.ts:39`, `vcs/CheckoutCloner.ts:32`, `policy/ManagedPolicy.ts:209`, `outboundHttp.ts:7`, `preview/ServerBrowserContexts.ts:13` and `packages/provider-cursor/src/server/sdk.ts:5`;
  - the `node:sea` stub (`BUILTIN_STUBS` `:60`; imported by `cliCompileCache.ts:5`, `speech/native.ts:3`, `bin.ts:3`, `packages/shared/src/HostProcess.ts:6`);
  - the generated `@anthropic-ai/claude-agent-sdk` stub (`DEPENDENCY_STUBS` `:69-72`, `dependencyStubs` `:208-230`), which exports the real package's names as throwing functions, and silently exports none when the real package fails to import;
  - the `import.meta.url`/`dirname`/`filename` defines (`DEFINES` `:288-294`);
  - the module-state probe (`:247`), which feeds the twice-in-one-isolate boot check (ADR-0003);
  - the Server version stamp (`serverVersionStamp`, counted as `buildShims.manifestStamps`), which serves t3's server manifest with the pin's version ([U87](#u87-the-server-version-stamp-in-app-updates-d1)).
- **Breaks when**: t3 reads or writes its State directory through an import form the regex misses (a dynamic `import()` without `await`, or a module outside `src/`), adds a native package loaded through `createRequire`, adds module-scope randomness or I/O (workerd forbids it at global scope, as Patch 0001 works around), or adds module-level state that survives an abort.
- **Detection**: deploy catches module-scope I/O and randomness (workerd refuses the upload) and an unstubbed native `require` at module load; acceptance's reboot check catches new module state that differs after a second boot. **Silent**: a State-directory write the alias missed lands on workerd's in-memory file system and is lost on the next reset; a stub that exports no names. Cheapest check: [T5](#gaps-in-detection), asserting the build report (importers, skipped dependency imports, stub names) against the pin's.
- **Blast radius**: from a setting or key that forgets itself after an idle reset, to an Environment that does not deploy.
- **Fix**: `node build.ts` and read `dist/build-report.json`; diff its `fsAlias` numbers against the last good build.

### U10. Patches

- **Where**: `patches/0001-lazy-server-browser-ref-namespace.patch` makes `refNamespace` lazy (t3 `apps/server/src/preview/ServerBrowserPage.ts:93`: `NodeCrypto.randomUUID()` at module scope, which workerd refuses). `patches/0002-new-project-root-is-w.patch` sets `namedProjectsRoot` to `/w` (t3 `apps/server/src/project/ManagedProjectFolders.ts:356`), so New project makes a Workspace. `patches/0004-scratch-root-is-a-workspace.patch` (parity G4) sets the No project folder to `/w/t3-scratch` (the probe's `scratchFolderRoot(config.baseDir, path)` call, `ManagedProjectFolders.ts:262`), so scratch threads run in a Workspace; only that call: t3's exported `scratchFolderRoot` stays stock, so its storage cleanup (which deletes idle scratch folders) and `restoreMissingWorktree`'s scratch recreation do not act on `/w/t3-scratch`; it applies after 0002 to the same file. `patches/0007-pi-relay-tools-are-judged-by-the-relay.patch` (SPI-1076) lets t3's pi extension's `tool_call` hook pass a tool of pi's built-in MCP client ([U71](#u71-pis-built-in-mcp-for-the-relay-and-patch-0007-spi-1076)). Applied in memory at bundle time (`build.ts:109-145`); the submodule stays clean. Typecheck reads t3's unpatched source, so a t3 type error that only this program sees (it has the DOM lib, which t3's server is checked without) does not fail the typecheck. `apps/environment/scripts/typecheck.ts` (`lib/typecheckFilter.ts`) runs the compiler and prints errors in `t3code/` files under a heading of their own, without failing. t3 checks those files under its own configuration, and the difference is not only the DOM lib: `@types/react/global.d.ts` declares empty `HTMLElement`/`SVGElement` too. Errors in our own files still fail, including the ones a change to t3's API causes there. Until 2026-11-19 each such error took a hand-written types-only shim (`t3TypeShims.d.ts`: `Locator.evaluate` for 4825, `SubtleCrypto.digest` for 4941), and each one blocked the bump until someone wrote it.
- **Breaks when**: t3 edits the lines a Patch touches or their context.
- **Detection**: the bump's "patches apply" step (`build.ts --check`, `git apply --check`). A Patch that still applies but whose surroundings changed meaning (another module-scope random value elsewhere; a second use of the projects root) is caught by deploy and by `--real-turn` respectively. A type error in t3's files that only this program sees does not fail the check. The bump counts these errors in its report (`t3TypeErrors`), its commit message and its PR's body. They are printed in the check's log under "error(s) in t3's own files". Read them when the count moves: workerd's APIs follow the web standards the DOM lib types, so one may mark a real difference at runtime. Acceptance catches that on the paths it covers.
- **Blast radius**: none in production: the bump stops and the pin stays.
- **Fix**: rebase the Patch on the new tag (`git -C t3code diff` the file between tags), or drop it if t3 fixed the cause. ADR-0001's refinement: a tiny Patch beats a large Shadow.

### U11. The Shadow `builtInDrivers.ts`

- **Where**: `apps/environment/src/shadows/builtInDrivers.ts` replaces `t3code/apps/server/src/provider/builtInDrivers.ts` (exports at `:20`, `:33`, `:47`, `:58`): `BUILT_IN_DRIVERS = [PiDurableDriver]`, `BUILT_IN_USAGE_DRIVERS = []`. The redirect (`SHADOWS` `build.ts:54-57`, `shadows` `:183-203`) applies only to relative imports from t3's modules (today `provider/ProviderInstanceRegistryHydration.ts:24` and `usage/UsageService.ts:34`). Parity batch 2: `BUILT_IN_USAGE_DRIVERS` lists four of our drivers again (Pi Durable, Codex, Claude Code, OpenCode), each with one scan reader (`usage/readers.ts` `usageReader`) that reads t3flare's own usage records ([U79](#u79-the-usage-page-from-t3flares-own-usage-records-spi-1173)). `test/usagePage.test.ts` runs t3's `UsageService` over this module.
- **Breaks when**: t3 adds an export to the module (its importers find nothing in ours), renames the module, or imports it through a package path the redirect does not see.
- **Detection**: a new export that something imports fails the build (deploy step) or reads as `undefined`. **Silent**: an import the redirect misses brings t3's stock drivers back beside ours (probes, spawn attempts, CLI providers in the picker). Cheapest check: [T5](#gaps-in-detection), asserting the build report's `shadows` equals `SHADOWS`.
- **Blast radius**: the provider picker lists CLI agents that cannot run, or the Environment does not build.
- **Fix**: diff the original between tags and mirror its exports.

### U12. TerminalManager through `makeWithOptions`, and the PTY adapter

- **Where**: `apps/environment/src/terminal/layer.ts` restates `TerminalManager.make` (t3 `apps/server/src/terminal/Manager.ts:1481-1512`) and calls its exported `makeWithOptions` (`Manager.ts:1514`) with `terminalManagerOptions` (`layer.ts:54-68`): a fixed `env`, our `ptyAdapter` (`terminal/ptyAdapter.ts`, shells in the Workspace's Container, ADR-0021), bash, a `subprocessInspector` from the rc file's markers, smaller history limits; and without `registerTerminalProcesses` or `resolveProviderInstanceEnvironment`. The options object is built by a function, so TypeScript runs no excess-property check on it. `platform/services.ts:27` makes the DO's own `PtyAdapter` fail every spawn.
- **Since `v0.1.11-nightly.20261117.4825`**: t3 checks a shell exists before spawning it (`SpawnExecutableResolution`, a `Context.Reference` whose default looks on this process's disk, where no shell is: every terminal failed with no output, caught only by `acceptance --terminal`). `layer.ts` provides `containerShell`: one of the PTY adapter's `SHELLS` is itself, any other none. The same reference is read by t3's Claude driver, the ACP registry and Muse, none of which runs here.
- **Breaks when**: t3 renames an option (`env` falls back to `options.env ?? process.env`, `Manager.ts:1529`, and `process.env` is empty under `nodejs_compat_do_not_populate_process_env`), adds an option `make` passes that matters here, or changes `PtySpawnInput`/`PtyProcess`.
- **Detection**: typecheck catches a new required option and a changed PTY interface; `acceptance --terminal` catches a terminal that does not echo. The upstream fingerprint ([T2](#gaps-in-detection)) hashes `Manager.make` and `TerminalManagerOptions`, so a renamed or added option holds the bump for review with "review `apps/environment/src/terminal/layer.ts` (U12)". **Silent**: what `makeWithOptions` does with the options, which is not hashed, such as a new default behind an optional one (`options.env ?? process.env` in `makeWithOptions`).
- **Blast radius**: terminals that do not open, or open without `TERM`.
- **Fix**: diff `Manager.make` between tags and mirror it in `terminalManagerOptions`.

### U13. Stale reads: t3's status argv, patched while the Container is stopped

- **Where**: `apps/agents/src/workspace/staleReads.ts`: `kindOf` (`:56-74`) recognises t3's argv exactly: `status --porcelain=2 --branch -z [--no-ahead-behind]` (t3 `GitVcsDriverCore.ts:2124-2131`), `diff-index -M --numstat -z HEAD --` (`:2193`), `ls-files --others --exclude-standard -z --`, and the review diff's `REVIEW_PREFIX` (`:39-50`; t3 `GitVcsDriverCore.ts:88`, `GitVcsDriver.ts:1496-1498`). Each is answered from the last real answer patched with computer's write journal (at most `MAX_PATCHED_PATHS`); anything else gets the last answer alone (`staleRead`, called by `WorkspaceDO.ts` `#stale`). The two status shapes stand in for each other when one was never answered (`statusSibling`): t3's `statusDetails` (`readStatusDetailsLocal`, `GitVcsDriverCore.ts:2119`) sends the shape without `--no-ahead-behind`.
- **Breaks when**: t3 adds, drops or reorders a flag in any of these argv.
- **Detection**: **silent**: the read falls back to `last-answer`, which is right until a file changes while the Container is stopped. The upstream fingerprint ([T2](#gaps-in-detection)) holds the bump for review with "review `apps/agents/src/workspace/staleReads.ts` (U13)" when `statusArgs` (in `readStatusDetailsLocal`), `REVIEW_DIFF_ARGS` or `PATCH_RENDER_PREFIX_ARGS` change, or when the status, `diff-index`, `ls-files` or review-diff argv no longer appears in `GitVcsDriverCore.ts`. That watches t3's side only: it does not check that `kindOf` matches it. Cheapest check for the rest: [T6](#gaps-in-detection) (the router trace shows `stale-last-answer` for a status read).
- **Since `v0.1.11-nightly.20261120.4979` ([SPI-1295](https://linear.app/spiritledsoftware/issue/SPI-1295))**: `kindOf` no longer matches two shapes t3 sends. The review diffs now end `--raw --numstat -z <ref> --` and `--patch <ref> --`, so neither review kind is patched and both get the last answer alone. A status read with `--untracked-files=normal` (when `status.showUntrackedFiles` hides untracked files) gets the last answer alone too. The fingerprint's fixture records this pin as reviewed anyway, and watches those review-diff tails as literals so the fix has a guard.
- **Blast radius**: the diff panel and changed-files count lag what the agent wrote, until the Container next runs.
- **Fix**: update `kindOf` and the patchers to the new argv.

### U14. Usage-limit recovery and its `resetAt`

- **Where**: the differ turns a Model endpoint's limit (SPI-1172, U80; the Model proxy's until the hard cut, SPI-1176) into t3's failure with `resetAt` as an ISO string, at least `MIN_RESET_MS` (30 s) after the turn (`provider/differ.ts:428-446`). t3's `UsageLimitRecoveryWorker` parses it (`t3code/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:33`), drops one not after the run's end, and arms recovery by comparing `recovery.resetAt !== thread.usageLimitResetAt` as strings (`:42`). The idle reset's wake reads the armed value back (U2).
- **Breaks when**: t3 changes the format it stores or compares, the overdue window, or what arms auto-resume.
- **Detection**: **silent**: no bump step hits a usage limit. Cheapest check: [T8](#gaps-in-detection), an acceptance case using the stage-only model fault (`POST /_t3flare/agents/proxy-fault`, its name the Model proxy's: a vendor-shaped answer since SPI-1176).
- **Blast radius**: a usage-limited thread never resumes, or resumes in a loop.
- **Fix**: `UsageLimitRecoveryWorker.ts` between tags; `modelFailures.test.ts` and `apps/agents/test/endpointFailures.test.ts` cover the classification, and `apps/environment/scripts/p1172.ts limit` (and `part2.ts limit`, with a vendor-shaped fault since SPI-1176) exercise the recovery by hand.

### U15. The `gh` emulation

- **Where**: `processRouter.ts` `ghRouteOf` (`:408-415`): `gh --version` answers `gh version 2.83.0 (t3flare)` (`:409`); `gh config get …` answers an empty line (`:410`, for t3's `config get http_unix_socket`, `packages/source-control-github/src/server/GitHubHttpClient.ts:21`); `gh auth token` mints the Environment's GitHub App token (`ghToken`, `:87`; t3 sends `--hostname <host> [--user <account>]`, `GitHubCredentials.ts:153-165`); `gh auth status --json hosts` answers `{ hosts: { "github.com": [{ state, active, host, login, tokenSource }] } }` (`ghAuthStatus`, `:398`). t3's parsers: discovery takes the first line of `--version` (`apps/server/src/sourceControl/SourceControlDiscovery.ts:81-102`); `authArgs` and `parseGitHubAuth` (`packages/source-control-github/src/server/GitHubSourceControlProvider.ts:190-197`); the schema (`gitHubAuthStatus.ts:5-19`, `parseGitHubAuthStatus` `:43`).
- **Breaks when**: t3 adds a required field to the auth schema, changes `authArgs`, gates on a newer gh version, or calls another `gh` subcommand (it gets `NotFound`).
- **Detection**: the upstream fingerprint ([T2](#gaps-in-detection)) holds the bump for review with "review `apps/environment/src/agents/processRouter.ts` (U15)" when the auth schema or its parser (`parseGitHubAuthStatus`, `ENVIRONMENT_TOKEN_SOURCE`, which read the `state` and `tokenSource` we emit), `discovery` (with `authArgs`), `parseGitHubAuth` or `GitHubCredentials`' `fromGh` change, or when the `authArgs`, `config get http_unix_socket` or first-line version read no longer appears. **Silent** beyond those: the bump runs no PR flow (`--push` is not in its flags) and checks no source-control status. Cheapest check: [T7](#gaps-in-detection), an acceptance check that t3's source-control discovery reports GitHub signed in.
- **Blast radius**: GitHub shows as signed out; PR creation, checks and linking disappear.
- **Fix**: diff `packages/source-control-github/src/server/` between tags; match the emulated answers.

### U16. Auth, pairing, and the Worker's route prefixes

- **Where**: the Worker forwards only `SERVER_PREFIXES` (`/api`, `/oauth`, `/.well-known`, `/ws`, `/mcp`, `/_t3flare`; `apps/environment/src/worker.ts:25`) to the DO; everything else is the web client's assets. The DO refuses a bootstrap credential outside the Pairing window on `BOOTSTRAP_EXCHANGE_PATHS` (`/api/auth/browser-session`, `/oauth/token`; `environmentDO.ts:62`, `#refuseDisarmedBootstrap` `:467`), parsing the body with `presentsBootstrapToken` (`host/pairing.ts:82`); t3's endpoints are in `t3code/packages/contracts/src/environmentHttp.ts` (`browserSession` `:570`). Step 3's acceptance also checks `/oauth/mcp/decision` (F11).
- **Breaks when**: t3 adds a route prefix, a new endpoint that exchanges a bootstrap credential, or a new body shape for one.
- **Detection**: acceptance's pairing checks catch a changed `browser-session` flow. **Silent**: a new exchange path skips our refusal (t3's own grant still governs it, so this is the belt-and-braces layer, ADR-0010); a new route prefix is answered with the web client's HTML. Cheapest check: [T12](#gaps-in-detection), a test that walks `EnvironmentHttpApi` for endpoints taking a credential and for path prefixes.
- **Blast radius**: a gap in the Pairing window's guarantee, or a client feature that gets HTML instead of JSON.
- **Fix**: add the path to `BOOTSTRAP_EXCHANGE_PATHS` or the prefix to `SERVER_PREFIXES`.

### U17. Workspace layers: `WorkspaceEntries`, `WorkspaceFileSystem`, `HomeDirectory`, and checkpoints

- **Where**: `apps/environment/src/workspace/layers.ts` wraps t3's stock services so `/w/…` paths are the Workspace DO's files over RPC: `layerWorkspaceEntries` (`:90`; `browse`, `list`, `search`, `searchContents`, `:99-198`) and `layerWorkspaceFileSystem` (`:211`; `getMetadata`, `readFile`, `writeFile`, `:235-325`), which reads `HostProcess.HomeDirectory`, set to `/w` (`platform/services.ts:59`; the other `HostProcess` values at `:53-68`). `workspace/checkpoints.ts` wraps `VcsDriverRegistry` (`:84-91`) so each driver's `checkpoints.*` for `/w` paths are answered by the Workspace DO with isomorphic-git (`ours`, `:39-77`); `diffCheckpoints` copies input fields one by one (`:54-66`). The Workspace DO's capture (`apps/agents/src/workspace/checkpointCapture.ts`, SPI-1100) first pulls the Container's writes, so a CLI agent's turn is in its checkpoint: it relies on t3 capturing through the driver's `captureCheckpoint` after the turn's last write (`CheckpointService.ts` `capture`).
- **Breaks when**: t3 adds a method (typecheck), adds an input field (our `/w` branch drops it), or changes the diff text it parses from checkpoints. t3 captures a turn some other way than through `checkpoints.captureCheckpoint`, or reads a checkpoint's files before capturing it.
- **Detection**: typecheck catches a new method or a changed signature; `--real-turn` checks the turn's checkpoint lists the edited file (a Durable agent's, written through the DO). **Silent**: a new input field, such as a context-lines option on `diffCheckpoints`, is ignored for Workspaces. A CLI agent's checkpoint that misses its writes (an empty turn diff): `apps/agents/test/checkpointCapture.test.ts` covers our side; the cheapest check of t3's side is the stage harness `scripts/p1100.ts`, outside the bump.
- **Blast radius**: a file browser, search or diff that behaves differently in the cloud than on a laptop.
- **Fix**: diff `apps/server/src/workspace/` and `vcs/VcsDriver.ts` between tags.

### U18. `git worktree list` and the worktree verbs

- **Where**: `processRouter.ts` `worktreeList` (`:325`) answers `git worktree list --porcelain [-z]` with the project's own entry and one per worktree Workspace, in `worktreeListPorcelain`'s format (`gitRoutes.ts:262`); `worktreeAdd` (`:247`) provisions a worktree Workspace and refuses `--detach` outside a scratch directory (a scratch checkout is U57); `worktreeCommandOf` (`gitRoutes.ts:199`) and `worktreeDestinationOf` (`:241`, `/w/.wt/<project dir>/<one segment>`) read t3's argv. t3 calls `worktree list --porcelain -z` and falls back to newline records (`GitVcsDriverCore.ts:1227-1240`). After the add, t3 runs `git submodule init` and `git submodule update --init [--recursive]` in the worktree (setting `worktreeSubmodules`, built-in `recursive`; `GitVcsDriverCore.ts:4369-4440`); the Workspace keeps submodules Container-only by the paths `.gitmodules` names (`apps/agents/src/workspace/containerOnly.ts`, ADR-0009's 2026-11-11 refinement).
- **Breaks when**: t3 parses another porcelain key (`locked`, `prunable`), changes where it puts worktrees, adds a worktree verb, or checks submodules out somewhere `.gitmodules` does not name (they would sync into the DO: watch a worktree's `revision` in `GET /_t3flare/agents/workspaces`).
- **Detection**: `acceptance --worktree` (a worktree thread's setup script, its removal, the sweep's dry run). A new verb answers `unsupported` with a clear message.
- **Blast radius**: worktree threads that cannot start or be removed.
- **Fix**: the router trace on the bump stage, then `GitVcsDriverCore.ts` between tags.
- **Since `v0.1.10-nightly.20261112.4606`**: a new branch is made first in the project (`git branch --no-track -- <new> <start>`, then `branch --set-upstream-to` for a remote start), and the worktree is added without `-b`: `git -c checkout.workers=<n> worktree add -- <path> <new>`; t3 then refreshes the new worktree's index (`rev-parse --git-path index`, `update-index -q --refresh --force-write-index`). The path is `<worktrees dir>/<repo>/<branch prefix>-<16 hex>`, still one segment. `acceptance --worktree` passed on it. t3's commit now stages over stdin (`add -A --pathspec-from-file=- --pathspec-file-nul`), which no bump step exercises ([SPI-1091](https://linear.app/spiritledsoftware/issue/SPI-1091)).
- **2026-11-18, `v0.1.11-nightly.20261117.4851`**: `--worktree` failed `worktree removed and out of the budget` with `leased: true` whenever the removal beat the worktree thread's first turn (setup about 9 s; runs of 12.5–13.5 s passed). The cause is t3's restore of a thread's missing worktree when its turn starts (`workspace/restoreMissingWorktree.ts`, called from `ProviderTurnStartService`; also on a send and a terminal launch). The test removed the worktree while the thread's first turn was still pending (the row's `references` listed `open run in thread …`), and t3 re-added it at the same path for that turn. Our router restored the tombstone (review F5), and the restored worktree took a lease. Since 4851 that restore clears a leftover folder (an empty one counts) entry by entry rather than removing the folder itself, which is when it began to succeed here. That is a removal undone by t3, not a leaked lease. The diagnostics showed it: the worktree's own DO reported `leased: false` and a stopped Container while the budget held a lease taken after the removal, and t3's post-add reads (`cat-file -e HEAD:.gitmodules`, `rev-parse --git-path index`) ran in the worktree after it. The acceptance test now waits for the thread's turn to settle before removing (`turnBeforeRemoval`), and its trace includes commands naming the worktree from the project (the `worktree add`). A user who removes a worktree under a pending turn sees the same restore: stock t3's behaviour. An earlier guess, a start racing the stop, led to PR #50: a tombstone closes its Workspace's Container (`apps/agents/src/workspace/containerGate.ts`, `WorkspaceDO.closeContainer`), refusing later starts until a restore or reprovisioning reopens it. It is kept as hardening; a restore reopens it, so the restored worktree runs.

### U19. Settings seeds

- **Where**: `agents/seedSettings.ts`, each through `ServerSettings.ServerSettingsService` (`getSettings`, `updateSettings`):
  - **Text generation's model:** `layerSeedTextGenerationModel` and `syncTextGenerationDefault`, since SPI-1163 their own entry, [U67](#u67-text-generations-default-model-follows-the-model-endpoints-spi-1163).
  - **Fast worktree checkout:** `layerPinFastWorktreeCheckoutOff` pins `fastWorktreeCheckout` off at each boot.
  - **Linked environments:** `layerSeedLinkedEnvironmentsOn` turns `linkedEnvironmentsEnabled` on once per Environment (step 3, L1), marked in the DO's storage.
  - Agent browser access is no longer pinned (G11: stock's default).
- **Breaks when**: t3 renames a setting or changes what its default means.
- **Detection**: typecheck catches a rename. A changed default is silent but rarely matters, because each seed checks the current value.
- **Blast radius**: a setting the cloud cannot honour comes back on (fast checkout), or the laptop cannot link (Linked environments).
- **Fix**: `apps/server/src/serverSettings.ts` and the contracts' settings schema between tags.

### U20. Dependencies that ride t3's lock: alchemy beta, `patches/deps`, transitive pins

- **Where**: the root workspace and lock follow t3's ([U50](#u50-the-root-workspace-and-lock-are-generated-from-t3s-adr-0030)): t3's catalog, overrides and patches apply as they are and t3's packages resolve as in its lock, so a t3 bump moves alchemy (`t3code/pnpm-workspace.yaml:70`, `2.0.0-beta.85`), effect, zod and others under our own code too. Our own dependency patches are keyed by exact version (`patches/deps/@alchemy.run__cloudflare@2.0.0-beta.85.patch`, `patches/deps/@earendil-works__pi-durable@1.5.0.patch`, and `patches/deps/@cloudflare__computer@0.11.2.patch`, which adds `Workspace.remount()` so a Workspace serves a new Environment skill set without restarting (ADR-0033; pnpm fails the install when it no longer applies); wired into `pnpm-workspace.yaml`'s `patchedDependencies` by `gen-workspace.ts`). `OUR_OVERRIDES` there holds a few of our core packages where Bun's pins held them (`workerd`, `@cloudflare/workers-types`, `@effect/sql-d1`). `@alchemy.run/cloudflare-runtime` is pinned at `2.0.0-beta.85` by hand in `apps/environment/package.json`, and `build.ts:2-4` works around beta.85 dropping `build.input.plugins` (ADR-0020). `@earendil-works/pi-durable` (1.5.0) and `@cloudflare/computer` (0.11.2) are ours alone, and their dependencies resolve within their own ranges (pnpm, unlike Bun's per-name pins, gives each package its declared version).
- **Breaks when**: t3 bumps alchemy; t3's lock moves a package pi-durable or computer depends on; `effect` resolves twice; computer is bumped (its `remount()` patch is re-cut against the new `dist/index.js`, and `apps/agents/test/skillSet.workerd.test.ts` shows it still serves a new set).
- **Detection**: when alchemy moves, the install fails on the `patches/deps` patch keyed to beta.85 (`ERR_PNPM_UNUSED_PATCH`), and on a patch that no longer applies; `verify-lock` fails on a second `effect` and on any t3-patched version installed unpatched; deploy catches an alchemy that cannot deploy.
- **Blast radius**: flaky or failed deploys of prod; agent runtime errors after a transitive move.
- **Fix**: re-cut the patch for the new version (`pnpm patch <pkg>@<version>`, edit, `pnpm patch-commit <dir> --patches-dir patches/deps`, then `node scripts/relock.ts`), move `cloudflare-runtime` with alchemy, re-check ADR-0020's workaround.

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

### U23. `@cloudflare/computer` 0.11.2's private VFS tables

- **Where**: the Workspace DO reads computer's SQLite VFS tables directly: `vfs_meta` (`k = 'rev'`), `vfs_nodes`, `vfs_dirents`, `vfs_changes`, `_vfs_push_cursor`, `_vfs_watermark` (`apps/agents/src/workspace/changeLog.ts:33-113`, `readCache.ts:56-84`). The read cache's revisions and the stale reads' write journal (U13) come from them. The in-DO git guard's file-size check (`repoFileSizes`, SPI-1050) walks `vfs_dirents` and reads `vfs_nodes.size`; `test/repoFileSizes.workerd.test.ts` runs it against a real computer Workspace. Their SQL is unchanged from 0.9.0 to 0.11.2 (SPI-1141); 0.11 adds its own `computer_pending_sync_*` tables, which we do not read. The Global mise config's spawn wait (SPI-1150) reads computer's runtime id from its storage key `computer:container-runtime-identity` (`{ id }`, `apps/agents/src/workspace/globalMiseGate.ts`); `test/globalMiseGate.test.ts` checks the key and shape against the installed package, and a change would silently fall back to the last connect's runtime, reopening the window where a replaced Container's spawn goes unwaited (a `global-mise-spawn` log appears only when no connect has happened either).
- **Breaks when**: we bump computer and it changes its schema (a t3 bump does not move computer itself).
- **Detection**: mostly **silent**: only `repoFileSizes.workerd.test.ts` exercises the schema (`vfs_dirents`, `vfs_nodes.size`), and `globalMiseGate.test.ts` pins the runtime-identity key and shape. Cheapest check for the rest: [T4](#gaps-in-detection).
- **Blast radius**: wrong cached git answers (status and diffs that do not change), or a Workspace DO that throws on every read.
- **Fix**: the computer release's schema; pin computer until the reads are ported.

### U24. pi-durable 1.5.0 with cloudpid's patch

- **Where**: `@earendil-works/pi-durable` 1.5.0 (`apps/agents/package.json`, `packages/computer-env`, `packages/effect-durable`), patched by `patches/deps/@earendil-works__pi-durable@1.5.0.patch` (codemode's details capped to 64 KiB, `dist/codemode/codemode.js`, `dist/harness/scheduler.js`, `dist/harness/tool.js`). Its runtime events reach t3 through the Session's pushes and the differ (U3).
- **Breaks when**: we bump pi-durable (the patch is keyed to 1.5.0), or a t3 bump moves one of its dependencies (U20).
- **Detection**: a pi-durable bump is our own change and runs `pnpm run check`; `--real-turn` runs one turn. A lost patch fails the install (U20).
- **Blast radius**: every Durable agent turn.
- **Fix**: re-cut the patch against the new `dist/`; re-run `--real-turn`.

### U25. Retired: Commissary's `/v1/models` and the alias scheme (SPI-1176)

The Model proxy's catalog (`packages/models/src/catalog.ts`), its static list and its failure classifier
(`proxyFailure.ts`) went at the hard cut (SPI-1176). What is left is the list parsing an endpoint's discovery reads
(`packages/models/src/lists.ts` `parseList`, and `realIdOf`, which reads Commissary's alias for a non-Claude model back
to its real id when an endpoint is at Commissary): `apps/environment/test/modelLists.test.ts` and
`endpointDiscover.test.ts` pin it. A changed alias prefix shows those models by alias in a Commissary endpoint's list.

### U26. The acceptance test's own fixtures

- **Where**: `apps/environment/src/host/fixtures.ts` writes turn items through t3's `EventSink` (`t3/src/orchestration-v2/EventSink.ts`, `runtimeLayer.ts`), building t3 contract objects by hand; acceptance step 4 expects 5 turn items per run.
- **Breaks when**: t3 changes the event or turn-item shapes.
- **Detection**: acceptance fails loudly ("fixtures written"). This is a false alarm about production, but a true one about U3: the same shapes are what the differ emits.
- **Blast radius**: none in production.
- **Fix**: update the fixtures alongside the differ.

### U27. The bump job checks less than `bun run check` (fixed)

Fixed by ADR-0030: `scripts/bump.ts` runs the whole `pnpm run check`, as prod's deploy does.

### U28. T3 Connect: the publish-only link and the publisher (step 3+)

- **Where**: `apps/environment/src/connect/service.ts` runs t3's `CliTokenManager.deviceAuthorizationLogin`, `store`, `getExisting`, `clear`; `CliState.setCliDesiredCloudLink`/`readCliDesiredLinkMode`; `CloudLink.reconcileDesiredLinkIfStillDesired`, `linkState`, `unlink`, `updatePreferences`; and reads and deletes t3's secret names (`cloud/config.ts`: `cloud-mint-ed25519-public-key`, `cloud-endpoint-runtime-config`, `cloud-relay-environment-credential`, `cloud-publish-agent-activity`; `cloud-cli-desired-link`, `cloud-cli-oauth-token`). `layerRefusingCloudLink` overrides four `CloudLink` methods by name. `connect/recorder.ts` matches `AgentAwarenessRelay`'s log messages ("publishing agent activity for thread", "agent activity publish completed", "… failed", "… deferred pending confirmation", "… retry budget exhausted; retrying every minute") and their fields (`threadId`, `statePhase`, `ok`, `deliveries`, `cause`). `host/relayRoutes.ts` names the four relay routes. `src/t3/connectPublicConfig.ts` sets the `__T3CODE_BUILD_*` defines from `t3code/.env.example`. The relay's client API (`DELETE /v1/client/environment-links/:id`, `GET /v1/environments`, `GET /v2/client/devices`). The loopback-origin rule (`cloud/linkChecks.ts`).
- **Breaks when**: t3 renames a secret or a log message, adds a relay-initiated route or a `CloudLink` method that answers the relay, changes the mode default or the link step, moves the public values, or changes its retry and confirmation timings (the idle hold's bounds).
- **Detection**: typecheck catches a renamed method or export; `test/connectLink.test.ts` (t3's real `CloudLink` against a fake relay) a changed link step or secret name; `test/publishRecorder.test.ts` pins the message shapes and fails when t3's `AgentAwarenessRelay.ts` no longer logs one of them; `test/connectPublicConfig.test.ts` fails on a changed `.env.example` value; `test/connectPhases.test.ts` a changed phase mapping. A new relay route is **silent**: cheapest check, extend T12 to list `/api/connect` and `/api/t3-connect` endpoints against `relayRoutes.ts` ([SPI-1034](https://linear.app/spiritledsoftware/issue/SPI-1034)).
- **Blast radius**: no phone notification (silent), or a relay route answered by t3.
- **Since `v0.1.11-nightly.20261120.4979`**: t3 no longer gives up after its five retries; it logs "… retry budget exhausted; retrying every minute" and retries every 60 s for as long as the process lives. The recorder records that as `exhausted` and releases the hold, but each later retry logs "publishing" and "… failed" and holds anew; only the cap (`PUBLISH_HOLD_CAP_MS`, 120 s after the last socket or request) ends them, so a relay that stays down still cannot keep the DO resident, and an idle reset ends the steady retries. Side effects while the relay is down: a reset after the last socket closes can slip from 60 s to about 120 s; `summary().pending` lists the thread every minute; each failing thread adds two entries a minute to the 100-entry log. No test covers a retry after `exhausted`. Also since then, `publishRecorder.test.ts` fails when `AgentAwarenessRelay.ts` no longer logs one of the messages; a rename was **silent** before (the recorder saw nothing, publishing still worked).
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/cloud apps/server/src/relay/AgentAwarenessRelay.ts packages/contracts/src/relay.ts .env.example`; rerun `scripts/connect-m2.ts` on a linked stage.

### U29. Our Codex registration, client factory and request guard (step 4a)

- **Where**: `apps/environment/src/provider/cli/codexDriver.ts` calls t3's `makeCodexAdapterV2` (`t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`) with our `CodexAppServerClientFactoryShape` (t3's `layerAppServerClientFactory` restated without port discovery, spawning with the thread's cwd) and `CodexClient.layerChildProcess`; `provider/cli/codexGuard.ts` (back to stock, owner 2026-11-12: no allowlists) passes t3's requests but the provider pin, `feedback/*`, `account/*` and the per-turn policy; it once allowlisted app-server methods (the ones t3's adapter sends today) and thread config keys (`CODEX_THREAD_CONFIG` plus `shell_environment_policy.set.T3CODE_THREAD_ID`), and rewrites `turn/start`'s `approvalPolicy`/`approvalsReviewer`/`sandboxPolicy` from its mode table, reading `collaborationMode.mode`. `provider/cli/wrapper.ts` overrides `supportsMultipleProviderThreadsPerSession` (read by `Orchestrator.ts` `providerSessionIdFor` and `ProviderSessionManager.open`), and the fork error shape. The guard's Model endpoint routing and the per-session process provider (SPI-1167) are [U69](#u69-codex-on-model-endpoints-through-the-model-relay-spi-1167).
- **Breaks when**: t3 renames these exports or the factory's input; renames a `turn/start` field; starts naming a provider or policy in a thread config key the pin drops (dropped silently); changes its mode table (`codexPolicyForRuntimeMode`, which `turnPolicy` restates); stops reading the session capability for attaching threads.
- **Detection**: typecheck (exports, factory shape); `acceptance --codex` (a turn with approvals and a resume); `test/codexGuard.test.ts` (the mode table, written out). **Silent**: a new policy field, a changed mode table.
- **Blast radius**: Codex threads fail to start or turn; a mode runs with t3's own policy; a second project's thread could run in the first one's Container (F1) if the attach logic moved.
- **Fix**: diff `CodexAdapterV2.ts` between tags for `client.request(`, `codexThreadRuntimeParams`, `buildCodexTurnStartParams`; update `turnPolicy` and the pinned keys.

### U30. Our Pi registration, the extension copy and `processGroup.ts` (step 4a)

- **Where**: `provider/cli/piDriver.ts` calls `makePiAdapterV2` and imports `PiSettings` by path (`t3code/packages/provider-pi/src/…`, not exported); `agents/cliProfiles.ts` accepts only the flags `buildPiRpcLaunch` sends (`PI_FLAGS`), copies t3's extension from the State directory after checking it equals `PI_T3_MCP_EXTENSION_SOURCE`, and sets `T3_PI_RUNTIME_MODE`; `shadows/processGroup.ts` replaces `signalProcessGroup` (`rpc.ts`'s stop path); `build.ts` `FS_ALIAS_SKIP` keeps the `node:fs` alias out of the extension source's text; the wrapper drops events naming "t3-code MCP unavailable".
- **Breaks when**: t3 adds a pi flag (refused: `cli-spawn-refused` names it), renames the extension's variables or file, moves the source module (the skip no longer applies: pi exits 1 "Cannot find module …/shims/node-fs-promises.ts", logged as `cli-exited` with its stderr), stops importing `processGroup`, or changes the notice.
- **Detection**: `acceptance --pi`; `dist/build-report.json`'s `shadows` lists `processGroup.ts` (T5). **Silent**: a renamed mode variable (the extension would fall back to full access: `cliProfiles.test.ts` pins the name we set, not t3's).
- **Since `v0.1.11-nightly.20261117.4825`**: t3 resumes a persisted pi session at spawn (`--session <file>`) rather than with a `switch_session` message; `cliProcess.ts` traces both, which is what `acceptance --pi`'s "resumed its native thread" reads. Also since then, t3's `t3_thread_launch` refuses a model its provider does not advertise (`model_unavailable`) before the Environment's fallback to the default model (U85) can take it, so a laptop's forwarded launch must name an endpoint's model; `peerAcceptance.ts` launches on the stage's endpoint model, and `peer-laptop.ts` on a model the stage's `server.refreshProviders` reply lists for `piDurable` (`providers[].models[].slug`).
- **Fix**: `git -C t3code diff <old>..<new> -- packages/provider-pi/src/server/mcpInjection.ts packages/provider-pi/src/server/mcpExtensionSource.ts packages/provider-pi/src/server/rpc.ts`.

### U31. CLI versions against t3's compatibility manifest (step 4a)

- **Where**: `apps/sandbox-image/src/clis.ts` (Codex 0.167.2, pi 1.5.2), the Dockerfile's `ARG`s and `image/cli/package-lock.json`; `apps/environment/test/cliManifest.test.ts` checks each against `model-manifest.json` (`resolveProviderCompatibility`).
- **Breaks when**: a nightly raises a minimum. **Detection**: tests ("bump the CLI in clis.ts"). **Fix**: bump the version, the digest and the lock together; re-run U32's checks.
- **Since `v0.1.11-nightly.20261120.4979`**: pi's minimum is the manifest's `pi` entry, as the other CLIs'; before, it was `MINIMUM_PI_VERSION` in provider-pi's `status.ts`. Also since then, t3's `ProviderAdapterRegistryV2` refuses `openSession` for any driver whose snapshot version the manifest rates `broken` (before, only Codex's handshake did), so a pin rated `broken` stops every session of that CLI, U36's included.

### U89. The provider-update runner contract (in-app updates D21)

- **Where**: `apps/environment/src/updates/cliUpdate.ts`: the pi CLI's, Codex's and Claude's drivers (`provider/cli/piDriver.ts`, `codexDriver.ts`, `acpDriver.ts`) return `makeProviderMaintenanceCapabilities` with `updateExecutable: "t3flare-cli-update"`, `updateArgs: [<cli>]`, `updateLockKey: "t3flare-cli:<cli>"` and a `lookupLatestVersion`, and an `enrichSnapshot` through `enrichProviderSnapshotWithVersionAdvisory`. t3's `provider/providerMaintenanceRunner.ts` runs the command through the `ChildProcessSpawner` (our `agents/processRouter.ts`, route `update`) with a 30-minute timeout (`UPDATE_TIMEOUT_MINUTES`); `resolveSpawnCommand` passes the name through on Linux; before running it checks compatibility against the manifest (`broken`/`unsupported` refuse), returns "Already up to date" when a refresh's advisory is `current`, waits for the instances sharing the lock key through the installation gate, and after it re-checks for `unchanged`. `ws.ts` routes `server.updateProvider` to the runner under `providers:manage`.
- **Who else spawns** (review A4): t3 paths that spawn a command a client can set, through the same spawner (the process router), among them a custom text generator's command (`textGeneration/`), a project's setup and worktree scripts, the external editor and opener (`process/externalLauncher.ts`, `shared/editor.ts`), a provider's binary path setting (our drivers ignore it), the 1Password secret provider's `op`, and the ACP registry's agent commands (installs refused). Any of them could name `t3flare-cli-update`, so the router answers it only as `isCliUpdateSpawn` says: exactly `t3flare-cli-update <cli>` with this isolate's token (`T3FLARE_CLI_UPDATE_TOKEN`, made at first use) in the spawn's environment. The token is in the capability's `update.env`, which the runner passes to the spawn and no client sees: the advisory carries `update.command` (`t3flare-cli-update <cli>`) and the runner's progress message the executable and argv. Anything else gets a missing binary.
- **Breaks when**: t3 changes `ProviderMaintenanceCapabilities` or `makeProviderMaintenanceCapabilities`, the runner's timeout, its use of the spawner, its lock-key or gate logic, or the RPC's authorization.
- **Detection**: typecheck; `test/cliUpdate.test.ts` (the token never in the command a client sees, and refused without it). **Silent**: the runner stops passing `update.env` to the spawn (every CLI update then fails as a missing binary), or starts sending it to clients (the token leaks, and a command a client sets could start a CLI bump on prod); a runner that times out sooner (the command is killed while CI goes on; pressing again joins the run), or one that no longer re-checks after the command (a success card for an unchanged pin).
- **Blast radius**: the card's Update button fails or hangs; the CLI bump itself still lands or fails in CI.
- **Fix**: `git -C t3code diff <old>..<new> -- apps/server/src/provider/providerMaintenanceRunner.ts packages/provider-core/src/server/maintenanceResolver.ts`.

### U90. The npm-to-release version mapping per CLI (in-app updates D22)

- **Where**: `lookupLatestCliVersion` (`updates/cliUpdate.ts`) and `scripts/cli-bump.ts`: Codex is npm's `@openai/codex@latest`, whose versions equal the `rust-v<version>` GitHub releases the Dockerfile downloads (`codex-x86_64-unknown-linux-musl.tar.gz`, `codex-aarch64-…` for test:docker); pi is `@earendil-works/pi-coding-agent`; Claude Code is the `claudeCodeVersion` of the `@anthropic-ai/claude-agent-sdk` the newest `@agentclientprotocol/claude-agent-acp` pins (`cliManifest.test.ts` also assumes SDK `0.3.N` ships Claude Code `2.1.N`).
- **Breaks when**: Codex's npm version stops matching a release tag or the tarball names change; the adapter pins the SDK by a range the lookup reads differently; the SDK drops `claudeCodeVersion`; pi's package moves.
- **Detection**: the CLI bump's `pin` step (a download or lock that fails), then `check` (`cliManifest.test.ts`); `test/cliPins.test.ts`. **Silent**: an advisory that names a version CI will not land (the card offers an Update that ends unchanged).
- **Blast radius**: a CLI update that fails or ends unchanged; the pin stays.
- **Fix**: `npm view <package> --json` and the release page; adjust `cliPins.ts` and the lookup.

### U32. The CLIs' own configuration surfaces (step 4a)

- **Where**: Codex's `-c` keys (`cliProfiles.ts` `codexOverrides`: the provider's `auth` command, `allow_login_shell`, the `features.*` that reach github.com and chatgpt.com, `shell_environment_policy.*`), pi's `models.json`/`settings.json` shape and its `PI_*` variables (`PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`).
- **Breaks when**: a CLI bump renames a key (Codex 0.167.2 already refuses a process-level `approval_policy="untrusted"`) or adds a default network call. These move with `clis.ts`, not with t3.
- **Detection**: `test:docker` (in the bump job) fails on a tunnel to any host at all for pi (`piRelay.docker.test.ts`), on an internal network whose only way out is a CONNECT logger; it covers the settings we pass, not a new call a CLI makes only in a feature we never use. Codex has no Docker run: its egress is checked only by `acceptance --codex` on the bump stage. Re-run M0's local probes (`apps/environment/scripts/probes/step-4a`: `p10b.sh`, `p8.sh`) on a CLI bump for what it does not cover; `acceptance --codex --pi` for the rest.

### U33. Our ACP flavors on t3's ACP adapter (step 4b)

- **Where**: `apps/environment/src/provider/cli/acpDriver.ts` calls `makeAcpAdapterV2` (`t3code/packages/provider-acp/src/server/adapter.ts`) and `AcpSessionRuntime.layer` by their option names (`sessionModeForPolicy`, `sessionConfigForPolicy`, `runtimeModeForSessionMode`, `ownedModelOptionIds`, `permissionDisposition`, `approvalOptions`, `promptFailure`, `requiresSignIn`, `resolveModelId`, `buildAttachmentPrompt`, `rewriteUserText`, `registerExtensions`' `captureProposedPlan`, `followAgentWorkState`; `ownDetachedProcessGroup`, `ownDescendantProcessGroups`, `linuxCgroupController`, `processGroupPlatform`, `authenticateOnAuthRequired`, `extendEnv`, `requestLogger`), and imports `reg/claudeAcp.ts`'s extractors by source path. `acpFlavor.ts` `guardedRuntime` wraps the runtime's `setMode` (Claude's `auto`, falling back to `default` when not offered), `prompt`, `handleSessionUpdate` and `handleRequestPermission` (since the back-to-stock cut, owner 2026-11-12, it no longer ends a session whose agent changes mode), and reads ACP v2's `state_update` idle shape (`planTurnEnd`). It relies on t3's own approval options (no `approvalOptions` of ours since the cut), on `selectAutoApprovedPermissionOption` preferring `allow_once`, and on t3's plan handling moving a `mode`-category option to `plan`. Idle compaction's worker is not started (`composition.ts`) and its setting is locked (`managedPolicy.ts`). Rollback is t3's (SPI-1100, SPI-1037): `acpCapabilities` keeps t3's `canRollbackThread` and `providerCanRollbackConversation`, and the wrapper (`wrapper.ts` `rollbackThread`) runs the adapter's `rollbackThread` under `CliSpawn`, because it starts a replacement agent process (`startReplacementAcpRuntime`) that must be the session's, with its thread and tool handle.
- **Breaks when**: an option is renamed (typecheck); a default changes (silent: a new client capability on by default, the auto-approval preferring `allow_always`, a plan-mode change that stops using the mode option); the runtime gains a method our wrapper should guard (silent: it passes through); another session method starts an agent process outside `openSession` and `rollbackThread` (silent: the process runs without the session's thread and tool handle); t3 starts calling `extractProposedPlanMarkdown` during a turn (harmless: the capture is deduplicated).
- **Detection**: typecheck; `test/acpAdapter.test.ts` (t3's adapter through our flavors against a scripted agent: the approval answers, the plan capture and denial, a mode change kept, Claude's `auto` and its fallback, OpenCode's auto-accepted edits and plan agent); `acceptance --claude --opencode`. **Silent**: ACP v2's plan-turn end (SPI-1047).
- **Blast radius**: from a turn that asks for nothing at `approval-required` to sessions that fail to open.
- **Since `v0.1.11-nightly.20261117.4825`**: `buildPrompt` (which replaced the whole prompt) became `buildAttachmentPrompt`, whose blocks t3 appends after its own text block (the instructions, the message and a `saved at` line per attachment). `acpPromptBuilder` now returns only the attachments' notes, readable files' text and images (`cliSkillDispatch.test.ts` checks the message goes once), and OpenCode's Skill embed moved to `rewriteUserText`.
- **Fix**: `git -C t3code diff <old>..<new> -- packages/provider-acp/src/server/adapter.ts packages/provider-acp/src/server/AcpSessionRuntime.ts packages/provider-acp/src/server/clientPolicy.ts packages/provider-acp-registry/src/server/claudeAcp.ts`.

### U34. t3's kinds over a different adapter (step 4b)

- **Where**: `claudeAgent` and `opencode` are registered with ACP adapters and t3's own settings schemas (`ClaudeSettings`, `OpenCodeSettings`); t3's orchestrator still treats the kinds as native in places: `/goal` goes verbatim to `claudeAgent` (`Orchestrator.ts` `goalDriverFor`), idle compaction targets `claudeAgent` (`IdleCompactionService.ts`), OpenCode's goal support reads `supportsNativeGoals`.
- **Breaks when**: t3 adds behaviour keyed on the kind that assumes the native adapter (a Claude-only UI action, OpenCode's server settings, a native-only command), or the web client switches on the kind.
- **Detection**: **silent** for client UI and kind-keyed server paths. Cheapest check: grep `t3code/apps/server/src` and `t3code/apps/web/src` for `"claudeAgent"` and `"opencode"` at each bump (as U22).
- **Fix**: lock or strip what the cloud cannot honour (`managedPolicy.ts`, `capabilities.ts`), or refuse it in the flavor.

### U35. Claude Code's and OpenCode's configuration surfaces (step 4b)

- **Where**: `apps/environment/src/agents/acpProfiles.ts`: Claude Code's managed-settings keys (`apiKeyHelper`, `allowedProviders`, `availableModels`, `permissions.*`, `skipWebFetchPreflight`, `disableClaudeAiConnectors`, `sandbox`; the repository's `.claude/` is honoured otherwise since the back-to-stock cut, owner 2026-11-12), the variables pinned in its managed `env` (`CLAUDE_PINNED_EMPTY`) and its switches (`CLAUDE_CODE_*`, `DISABLE_*`); `claude-agent-acp`'s mode ids, option ids (`exit-plan-*`, `allow-once`), its `model`/`effort`/`mode` config options and `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2`; OpenCode's system configuration keys (`providers`, `policies` actions, `permissions` rules, `agents`, `plugins`, `snapshots`, `update`, `share`, `lsp`, `formatter`), its plugin API (`ctx.provider.transform`), its `OPENCODE_DISABLE_*` variables and its database tables (`permission`, `account*`, sanitised by the launcher); the image's launchers (`apps/sandbox-image/image/t3flare-claude-agent-acp`, `t3flare-claude-key`, `t3flare-opencode`, `opencode-key-plugin`).
- **Breaks when**: a CLI bump renames a key (OpenCode drops a statement it cannot read with only a log warning: the launcher ends the process on a diagnostic about our file), changes a mode or option id, renames its `auto` mode (t3's `auto` then stays in `default`), or adds a default network call. These move with `clis.ts`, not with t3.
- **Detection**: `test/acpProfiles.test.ts` validates OpenCode's file against the pinned 2.2.7 schema (`test/fixtures/opencode-2.2.7-config.schema.json`; refresh it with the CLI); `acceptance --claude --opencode`; re-run M0's probes (`apps/environment/scripts/probes/step-4b`: `p3.sh` egress, `p4-*.sh` hostile repo and modes) on a CLI bump; `test:docker` for these CLIs is SPI-1044.
- **Fix**: the CLI's own settings reference and changelog; then the profile and the probes.

### U36. Claude Code and OpenCode against t3's compatibility manifest (step 4b)

- **Where**: `apps/sandbox-image/src/clis.ts` (`claude` 2.1.322 through claude-agent-acp 0.106.0 and the SDK 0.3.322; `opencode` 2.2.7 and its tarball digest), the Dockerfile's `OPENCODE_*` ARGs and `image/claude/package-lock.json`; `cliManifest.test.ts` checks them against `model-manifest.json` for `claudeAgent` and `opencode`.
- **Breaks when**: a nightly raises a minimum. **Detection**: tests ("bump the CLI in clis.ts"). **Blast radius**: since `v0.1.11-nightly.20261120.4979`, a pin the manifest rates `broken` refuses every session of that CLI ([U31](#u31-cli-versions-against-t3s-compatibility-manifest-step-4a)). **Fix**: bump the version, the lock or digest together; re-run U35's checks.

### U37. Cards injected by the CLI wrapper (SPI-1040; the MCP relay's tool cards since the back-to-stock cut)

- **SPI-1079**: the same mechanism raises MCP Server questions. An `mcp-elicitation` approval card, or a `user_input`
  card (runtime request `user_input`, item `user_input_request` with `questions`) answered from t3's `answers`, which
  t3 sends without a decision. Breaks too when t3 stops routing a live `user_input` response to the adapter, or reshapes
  `OrchestrationV2UserInputQuestion`. Detection: `test/cliCard.test.ts` (the SPI-1079 cases); the stage's
  `scripts/spi1079.ts codex`.

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

- **Where**: `apps/environment/src/agents/cliProfiles.ts` (Codex `mcp_servers.<name>` with `bearer_token_env_var`, `default_tools_approval_mode="approve"`, `tool_timeout_sec` 900, `startup_timeout_sec`), `acpProfiles.ts` (Claude Code's managed `permissions.allow` for the relay's servers; OpenCode's tool permissions for the relay's tools and `t3-code`; the admission locks were removed, owner 2026-11-12, back to stock), pi's `mcp.json` ([U71](#u71-pis-built-in-mcp-for-the-relay-and-patch-0007-spi-1076)), the handles per process (review H2: never a Container-wide file).
- **Breaks when**: an image bump renames a key, changes a precedence (a repo's `opencode.json` or `.mcp.json` winning over ours) or a default timeout, or adds a CLI-side approval that answers before ours.
- **Detection**: `test/cliProfiles.test.ts` (snapshot of the managed files and argv); the stage's `cli-mcp <cli>` per CLI (read without a card, write asks, decline, full access, plan); `relay-hostile`.
- **Fix**: re-read the CLI's config reference at the new version; adjust the profile and its snapshot.

### U44. The MCP SDK pin, the vendored cloudpid MCP core, and Commissary's MCP contract (tools step)

- **Where**: `vendor/cloudpid/mcp` (`@cloudpid/mcp`, copied at cloudpid `93ba45a3`, OD-T10) on `@modelcontextprotocol/{client,core,server}` 2.4.0, run in `apps/mcp-worker` (no bindings, `global_fetch_strictly_public`); its OAuth helpers (`discoverOAuthServerInfo`, `selectResource`, `registerClient`, `startAuthorization`) for direct servers' sign-ins. Commissary's endpoint: its eras, `readOnlyHint` on read tools, its `<toolkit>_<tool>` names, its text fallbacks for pending approvals and connect links (like U25 for models).
- **Breaks when**: an SDK bump changes the client, the OAuth discovery or resource selection; a cloudpid sync changes `scrub.ts` or the call budget; Commissary changes its hints, fallbacks or name rule.
- **Detection**: the vendored core's tests and `apps/mcp-worker/test/sdk-isolation.test.ts` in `pnpm run check`; `test/mcpHost.test.ts`; Commissary's MCP contract on a stage through `scripts/commissaryMcp.ts` (`add`, `durable`, `cli`), and `scripts/tools.ts`'s `oauth`. **Silent**: a hint flip from write to read on a tool the owner never overrode (classes trust `readOnlyHint` since the back-to-stock cut, owner 2026-11-12, so the tool then runs without a card).
- **Fix**: sync from cloudpid as a copy (its README names the commit); re-run the stage cases.

### U45. The `cause`-stripping Layer over t3's `PeerLinks` (SPI-1061)

- **Where**: `apps/environment/src/t3/peerLinks.ts` (`layerPeerLinksWithoutCause`), provided in `composition.ts` over t3's `PeerLinks` (`t3code/apps/server/src/peer/PeerLinks.ts`). Every method is t3's; `link`, `linkUnlessLinked`, `list`, `get`, `unlink` and `resolve` answer their `PeerLinkError` with t3's reason, message and `answeredAs` (the label of the environment that answered instead, which clients read as "wrong environment"; since `v0.1.11-nightly.20261120.4979`) and no `cause`, which can hold the transport error of a sign-in or a call and with it the request (an address, the pairing code, the bearer), and would go back over the WS RPC. Leak hygiene, not a gate (ADR-0029). Pre-B's refusals (`link` refused, stored links `expired`, an empty list, no link card, our `notListed`) were removed in SPI-1061; `PeerForwarding` and `PeerLinkRequests` are t3's own again. Numbers U40–U44 belong to the tools step.
- **Breaks when**: t3 adds a `PeerLinks` method that fails with a `PeerLinkError` (it would pass through with its `cause`), adds a second path that answers a `PeerLinkError` to a client without `PeerLinks`, or starts reading `cause` for something other than diagnostics.
- **Detection**: typecheck (the Layer spreads and overrides the service type); `test/peerLinks.test.ts` (t3's real `PeerLinks` links, lists, resolves and unlinks through the Layer; every method's error has no `cause`); `acceptance --peer` check `outbound` (a stock client's link reaches t3's own dial-out and its error has no `cause`); `scripts/outbound.ts --phase leak` (C6). The upstream fingerprint ([T2](#gaps-in-detection)) hashes `PeerLinks`' service interface and `PeerLinkError`'s fields, so a new method or field holds the bump for review with "review `apps/environment/src/t3/peerLinks.ts` (U45)".
- **Fix**: wrap the new method the same way.

### U46. t3's link card on a Durable agent's thread (SPI-1061)

- **Where**: `t3_environment_link` (offered to Durable agents since SPI-1061) raises t3's `link_request` turn item through `PeerLinkRequests.request`; the owner's client answers with `peerLinks.answerRequest`, and the outcome reaches the agent as a notification that starts a new run. Both pass through our Pi Durable provider adapter and differ like any turn item.
- **Breaks when**: t3 changes the `link_request` item's shape, how the outcome is delivered (a notification, a wake), or the answer's input.
- **Detection**: `scripts/outbound.ts --phase card` (C2: the card is raised, the answer links, the agent wakes, the code is in no transcript).
- **Fix**: follow t3's new item in the differ, if it stops showing; the card itself is t3's.

### U47. Routes from a Worker (SPI-1061)

- **Where**: an Outbound link's Route is a plain https address (T3 Connect's tunnel hostname, a Tailscale Funnel, or the owner's own Cloudflare Tunnel); t3's `PeerLinks` and `PeerMcpClient` fetch it from the Environment DO by workerd's `fetch`. It leans on: t3 deriving its MCP OAuth issuer and `resource` from `Host` and `X-Forwarded-Proto` (`t3code/docs/internals/environment-auth.md`), which every Route's proxy must pass; one bearer serving every address of a link (t3 checks the resource at sign-in only); `redirect: "manual"` on t3's peer client; and, on prod only, a same-zone fetch to a tunnel hostname in prod's own zone (the zone of `T3FLARE_DOMAIN`) reaching the tunnel (D23).
- **Breaks when**: t3 binds a session to the address it signed in at, stops deriving the issuer from forwarded headers, or Cloudflare changes same-zone routing or answers a Worker's fetch with a challenge.
- **Detection**: `scripts/outbound.ts --phase link` (G1, against the stage stand-in over a named tunnel); the owner's prod round trip (`docs/outbound-link.md`). Nothing a stage runs proves the same-zone path.
- **Fix**: per kind; a Route that cannot work from a Worker becomes a ticket, not a supported kind.

### U48. The idle check reads open Remote tasks and `peer_environment_links` (SPI-1061, extends U2)

- **Where**: `apps/environment/src/host/idle.ts` (`openRemoteTasks`) reads t3's `orchestration_v2_projection_subagents` with `ProjectionStoreV2.getOpenRemoteDelegatedTasks`' predicate (`origin`, `child_thread_id`, `payload_json`'s `$.remoteChild`, `$.result`, `$.status`, `$.remoteChild.stoppedThere`, `$.remoteChild.environmentId`), joined to `peer_environment_links.last_error` (NULL after `PeerMcpClient` recorded an answer). An open task whose machine answered holds the Environment up; one whose machine did not lets it reset, and `environmentDO.ts` keeps the retry (`t3flare:remote-task-retry`: 5, 15, then every 30 minutes) in DO storage, merged into the one alarm, with an alarm standing at most 5 minutes ahead while any task is open.
- **Breaks when**: a bump reshapes these tables or that predicate, or `PeerMcpClient` stops recording an outcome per call.
- **Detection**: fail-safe as U2: an unreadable table means "don't know", never "no work" (`test/idleRemoteTasks.test.ts`); `scripts/outbound.ts --phase long` (C4). **Silent**: a changed predicate that reads fewer tasks as open lets the Environment reset under a task whose machine answers; the alarm still brings it back.
- **Fix**: copy t3's new predicate into `openRemoteTasks`.

### U49. t3's orchestration guidance, filtered by the denylist (SPI-1060)

- **Where**: `packages/harness-registry/src/t3Guidance.ts` (re-exported by `apps/agents/src/extensions/t3-guidance.ts`) drops each bullet of t3's `T3_CODE_ORCHESTRATION_INSTRUCTIONS` and each sentence of an offered tool's description that names a denied tool (`T3_TOOL_DENYLIST`, `t3Tools.ts`), before the `t3_orchestration` section is rendered (`t3-mcp.ts`), for Durable agents (CLI agents get t3's full list and guidance, as stock t3 gives them); Since SPI-1061 the link tools are offered, so t3's own lines on linking pass, and `t3_environment_links`' `notListed` is t3's own. Since the back-to-stock cut (owner, 2026-11-12) it no longer fails closed on names it has not classified.
- **Breaks when**: t3 renames or drops a denied tool, restructures the instructions so a bullet no longer holds one tool's guidance, or names a denied tool in a tool result.
- **Detection**: `test/t3Guidance.test.ts` (every denied name, and each family's prefix, is still a t3 tool; the rendered prompt and descriptions name no denied tool) and `test/t3Mcp.test.ts`; `test/peerLinks.test.ts` (t3's `notListed` names no denied tool). **Silent** for a denied tool named only in a tool result.
- **Fix**: rename the entry in `t3Tools.ts`; extend the filter.

### U50. The root workspace and lock are generated from t3's (ADR-0030)

- **Where**: `scripts/gen-workspace.ts` writes `pnpm-workspace.yaml` (our packages plus the t3 closure of `T3_ROOTS`; t3's settings by the `COPIED`/`ADJUSTED` allowlist; t3's patches only for packages we install; `OUR_OVERRIDES`, `OUR_ALLOWED_PEERS`, every build denied), `package.json`'s `packageManager`/`engines.node` and `mise.toml` from `t3code/pnpm-workspace.yaml` and `t3code/package.json`. `scripts/seed-lock.ts` copies t3's lock (both YAML documents; t3's importers re-keyed under `t3code/`) and `scripts/relock.ts` installs until the workspace settles. `scripts/verify-lock.ts` compares each t3 importer's transitive closure with t3's (`PEER_DRIFT` lists the three explained exceptions). t3's `.pnpmfile.cjs` does not run at our root (its hook guards mobile tarballs and Windows architectures only).
- **Since in-app updates (ADR-0037)**: `seed-lock.ts` keeps t3flare's own resolutions (names t3 does not install) and `relock.ts` installs with `--fix-lockfile`; the land check (`land.ts` `t3LockRefusal`) then refuses a bump's lock that differs from main's outside t3's graph, catalog, overrides and patches. A pnpm change in how `--fix-lockfile` mends a carried-over entry, or in the lock's header (`catalogs` keeps only used entries; `overrides` records `catalog:` resolved), shows as a refused land with the entry named.
- **Breaks when**: t3 adds a top-level workspace setting; renames, splits or adds a package in the closure; changes its lock's document layout; moves a peer that our packages also bring (a new `PEER_DRIFT` case); bumps pnpm or Node (both follow t3's).
- **Detection**: the install step ("classify it" for a new setting; a missing importer); `verify-lock` (a moved version, with the importer and the keys); `check:workspace` (a stale generated file, or `t3code/node_modules/.pnpm` from a pnpm command run inside `t3code/`).
- **Blast radius**: the bump fails; nothing reaches prod.
- **Fix**: classify the new key in `gen-workspace.ts`; for a drift, find which of our packages pulls the other version (`pnpm why <name>`), and either pin it in `OUR_OVERRIDES` or list it in `PEER_DRIFT` with its reason.

### U51. Server questions as t3 cards, and the `t3_pending_request` fence (SPI-1079)

- **Where**: `apps/environment/src/mcp/elicitation.ts` makes t3 `mcp-elicitation` approval items and `user_input`
  questions (`OrchestrationV2UserInputQuestion`'s shape, as `provider-acp`'s `parseElicitationForm` builds them).
  `apps/environment/src/mcp/ownerOnly.ts` reads every `/mcp` body (`EnvironmentDO.fetch`, `EnvironmentDO.mcp`) and refuses
  a `tools/call` of `t3_pending_request` whose `requestId` carries `t3flare-elicit`, unless the action is `list`
  (`t3code/apps/server/src/mcp/toolkits/thread/tools.ts` `PendingRequestTool`). The Durable differ
  (`provider/differ.ts` `approvalView`, `questionView`) renders the Session's `mcp-elicitation` approvals and form
  questions.
- **Breaks when**:
  - t3 renames `t3_pending_request` or its `requestId`/`action` arguments, or adds another agent tool that answers
    `user_input` requests (the fence then lets an agent answer a form);
  - t3 starts letting `t3_pending_request` answer approvals (the `mcp-elicitation` cards);
  - t3 drops the `mcp-elicitation` request kind or changes how its web client renders it or a multi-question `user_input`.
- **Detection**: `test/mcpElicitation.test.ts` (`refuseOwnerOnly`), `test/differ.test.ts` (the SPI-1079 case);
  `scripts/spi1079.ts durable` (the fence case). **Silent**: a new t3 tool that answers questions (read the thread
  toolkit's diff on a bump: `git -C t3code diff <old>..<new> -- apps/server/src/mcp/toolkits/thread/`).
- **Blast radius**: an agent could answer an MCP server's form for the owner, which is the rule this ticket exists for.
- **Fix**: extend `ownerOnly.ts` to the new tool or argument.

### U52. Executor's pause contract ("Through your agent", SPI-1079)

- **Where**: `apps/environment/src/mcp/elicitation.ts` `isPausingServer` (a `resume` whose input has `requestId` and
  `response`), `pauseOf` (`structuredContent.status` `approval-required`/`input-required`, `requestId`, `elicitation`
  `{ message, requestedSchema, _meta }`, `expiresAt`); `mcp/host.ts` `#answerPauses` (`resume({ requestId, response })`,
  an approval as a bare `{ action: "accept" }`, a decline as `{ action: "decline" }`). Known from Executor's docs
  (`executor.sh/docs/mcp`), its MCP host's tests and pi-mcp-adapter's `executor-pauses.ts`, not yet from a live run.
- **Breaks when**: Executor renames the statuses or `resume`'s arguments, moves the request out of
  `structuredContent`, or starts accepting field values in an approval.
- **Detection**: `test/mcpElicitation.test.ts` (the fixture's shape); the stage's `scripts/spi1079.ts durable`
  against the fixture (`/executor-mcp`). **Silent** against the real Executor: a changed shape stops being recognised,
  and the pause reaches the agent as text, with its `requestId`. The agent still cannot call the hidden `resume`, so
  nothing is approved, but the call stalls. SPI-1092 runs it live.
- **Fix**: follow Executor's new shape in `pauseOf` and `isPausingServer`.

### U53. The pi-harness ports in t3's thread, and web search on a Model endpoint (SPI-1054, SPI-1055, SPI-1056)

- **Where**: `apps/environment/src/provider/differ.ts`:
  - `emitTool` shows `web_search` and `web_fetch` as t3's `web_search` turn item (`patterns`, `results`), as t3's ACP adapter shows a fetch (`t3code/packages/provider-acp/src/server/adapter.ts`, `case "fetch"`);
  - `emitTodo` shows the Session's Todo document as `todo_list` rows and a `plan.updated` artifact of kind `todo_list`, in OpenCode v2's shape (`t3code/packages/provider-opencode/src/server/v2/adapter.ts` `emitTodo`); step ids are `todo:<task id>`, which t3's ingestor uses for step durations (`ProviderEventIngestor.ts` `withPlanStepDurations`);
  - `toolTitle` titles the context tools' items. `provider/capabilities.ts` turns on `emitsTodoList` and `emitsPlanUpdated`.
  `apps/agents/src/extensions/web/search.ts` sends an Anthropic Messages request with the server tool `web_search_20250305` to an Anthropic Messages Model endpoint with an API key or no auth (the search model setting's, SPI-1176; the Model proxy's before) and reads `web_search_tool_result` blocks; Anthropic's API serves the tool, and Commissary translates it for Codex upstreams (`commissary/packages/translation/src/translator/codex/claude/request.ts`). The ports' documents (`t3flare.todo`, `t3flare.context`) and hooks (`beforeRequest`, `afterTool`, `beforeCompact`, `control.handoff`) lean on pi-durable 1.5.0 (U24).
- **Breaks when**: t3 changes the `todo_list` or `web_search` item shapes, the plan artifact, or how its web client groups todo rows (`MessagesTimeline.logic.ts`); the endpoint's server drops the web search server tool, or Anthropic retires `web_search_20250305`; a pi-durable bump changes the compaction hook, `ToolControl.handoff`, or `Tx.scanEntries`.
- **Detection**: typecheck; `test/differPorts.test.ts` decodes every item and the plan with t3's own schemas (closes T10 for these items); `apps/agents/test/{web/tools,todo,context}.test.ts`; `scripts/ports.ts turns` on a stage. **Silent**: an endpoint that stops searching answers `web_search` with an error naming the HTTP status, only when a thread searches.
- **Blast radius**: the web, todo and context tools' items render wrongly or not at all; `web_search` errors; the tools themselves keep working.
- **Fix**: follow the shapes t3's OpenCode and ACP adapters use; for search, check the endpoint's answer with `scripts/ports.ts turns` and switch `web.searchModel` to another endpoint's model.

### U54. The second pi-harness ports: agent Terminals, the Guardian and the Advisor (SPI-1057, SPI-1058, SPI-1059)

- **Where**:
  - `apps/agents/src/workspace/agentTerminals.ts` renders each agent Terminal with `@xterm/headless` 6.0.0, imported by path (`lib-headless/xterm-headless.mjs`, typed by `src/xterm-headless.d.ts`) since the package names a `module` entry it does not ship, and reads two internals: `_core._bufferService.buffers.normal.lines.onTrim` (scrolled-off lines) and `_core.coreService.isCursorHidden` (a hidden cursor). It runs under a second `TerminalHost` (`holdFirstInput: false`) and `terminalCommand`'s `command` form (`apps/sandbox-image/src/terminal.ts`).
  - `apps/environment/src/provider/differ.ts`: the terminal tools as `command_execution`, and the ports' entries (`t3flare.advice`, `t3flare.guardian`, `t3flare.terminal-exit`) as t3's `system_notice` on a `system` node, as t3's Pi provider shows its own notices (`t3code/packages/provider-pi/src/server/adapter.ts`).
  - The Guardian is a pi-durable `ToolTask` `beforeTool` hook that calls `api.models.completeSimple` and `api.memo`; the Advisor uses `GenerationTask`'s `afterTools` and `onYield` (`continue`), an ownerless conversation in the Session's Harness (`createConversation` with `extensions`, `tools`, `instructions`, `maxTurns`), and `submit` writes and steers with `whenIdle: "reject"`. All lean on pi-durable 1.5.0 (U24).
- **Breaks when**: an xterm bump renames those internals (scrolled-off lines then report nothing and gaps go unflagged; a hidden cursor shows as visible); t3 changes how it validates or renders `system_notice` or `command_execution`; a pi-durable bump changes hook signatures, `onYield`'s `continue`, writes with `model` (placed without starting a run), or how an ownerless conversation selects extensions.
- **Detection**: typecheck; `apps/agents/test/{agentTerminals,termctrl,guardian,advisor}.test.ts`; `apps/environment/test/differPorts2.test.ts` (each item decoded with t3's schemas); `scripts/ports2.ts turns` on a stage. **Silent**: the xterm internals. No test fills a Terminal's 1,000-line scrollback, so a renamed `onTrim` shows only as a missing `output_missing` notice in a long Terminal, and a renamed `isCursorHidden` as a cursor where none is.
- **Blast radius**: terminal results lose scrolled-off lines; notices stop showing in t3 (the tools and the model's text keep working); the Advisor's notes start a run or stop being placed (pi-durable semantics).
- **Fix**: follow xterm's new buffer API in `agentTerminals.ts`; t3's item shapes in the differ; pi-durable's hook API in the three extensions.

### U55. Plan mode's proposed plan, streamed command output and prompt suggestions (SPI-996)

- **Where**:
  - `apps/agents/src/extensions/plan.ts`: `propose_plan` (callers `model`, never deferred: `ALWAYS_OFFERED`) answers with pi-durable's `control.terminate`, so the plan ends the run (pi-durable 1.5.0, U24). Its text follows t3's Claude adapter's `ExitPlanMode` denial (`t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`).
  - `apps/environment/src/provider/differ.ts`: `emitProposedPlan` makes a `plan` node, a `proposed_plan` turn item and an `active` `proposed_plan` artifact, as t3's Codex and Claude adapters do; t3's Orchestrator implements only an `active` plan (`Orchestrator.ts`, "is not active") and completes it. A revised plan supersedes the last until a default-mode turn starts (`forgetProposedPlan`).
  - `emitOutputDelta` emits `command_output.delta` (`ProviderAdapter.ts`), keyed by the command item's id, from the tail of `pi.live.tools[].output` (`state.ts` `liveOf`, `TOOL_LIVE_OUTPUT_BYTES`), diffed by `sharedTail`. t3's `CommandOutputHub` releases it when the item settles.
  - `adapter.ts` `suggest`: `prompt_suggestion.updated` after a completed, non-delegated turn while `promptSuggestions` (t3's labs flag) is on; the Session's `suggestPrompt` asks Haiku with t3's `CODEX_PROMPT_SUGGESTION_PROMPT`, copied in `session/promptSuggestion.ts`.
- **Breaks when**: t3 changes the proposed-plan item or artifact, what Implement requires of a plan, `command_output.delta`'s shape or how the hub matches items, the prompt-suggestion event or its labs flag; pi-durable renames `pi.live` slots' `output` or changes `terminate`'s all-calls rule.
- **Detection**: typecheck; `apps/environment/test/differPlan.test.ts` (every event decoded with t3's `ProviderAdapterV2Event`, the capabilities with t3's schema); `apps/agents/test/{plan,liveOutput}.test.ts`; `scripts/p996.ts turns` on a stage. **Silent**: a renamed `pi.live` output field (commands stop streaming; the final output still lands), and a changed copy of t3's suggestion prompt.
- **Blast radius**: no proposed plan or a plan Implement refuses; output only at the end; no suggestions. Turns and tools keep working.
- **Fix**: follow t3's Codex adapter's shapes (`buildProposedPlanArtifacts`, `item/commandExecution/outputDelta`, `samplePromptSuggestion`).

### U56. Fork and rollback of Durable threads (SPI-997, SPI-987)

- **Where**:
  - `apps/environment/src/provider/adapter.ts`:
    - `rollbackThread` drops the provider turns after the target's ordinal (`ProviderAdapterV2RollbackTarget`, `providerThreadTurns`) and answers with the provider thread alone. t3's `CheckpointRollbackService` writes that thread back and restores the files (`t3code/apps/server/src/orchestration-v2/CheckpointRollbackService.ts`). t3's Pi adapter answers the same way.
    - `forkThread` runs in the target thread's session, as `ProviderTurnStartService` calls it. It registers a provider thread with `forkedFrom` and asks the Session to seed itself from the source Session's name (`nativeThreadRef`).
  - `provider/capabilities.ts`: `canRollbackThread`, `canForkThread`, `canForkFromTurn`, `providerCanRollbackConversation`, `providerRollbackReturnsSnapshot`, read by t3's `CommandPolicy.ts` (`ensureRollback`, `decideForkExecution`).
  - `apps/agents/src/session/branches.ts` and `SessionDO`'s conversation pointer (`t3flare:conversation`). These use pi-durable 1.5.0's `Conversation.fork`, `context({ at })`, write entries with `model`, session-wide monotonic entry ids, and `CodemodeStoreDoc`'s `fork: "asOf"` (U24).
- **Breaks when**: t3 changes the rollback target or input, what a rollback snapshot must hold, where `forkThread` is called or with which turn, or the policy's conditions. pi-durable changes fork semantics, entry ids or the write submission.
- **Detection**: typecheck (the adapter's input types); `apps/environment/test/forkRollbackPolicy.test.ts` (t3's own `CommandPolicy` takes the native fork and admits the rollback); `apps/agents/test/branches.test.ts` (a real Harness: the rollback forgets turns and rolls code mode's store back; the fork pages and seeds). Stage: `scripts/p997.ts fork` and `rollback`, outside the bump. **Silent**: a native fork that fails falls back to t3's portable handoff, so the thread still answers, from a summary. Cheapest check: run `p997.ts fork` in the bump's acceptance and require `native_fork`.
- **Blast radius**: "Revert to this message" fails, or rewinds the files but not the agent's memory. A fork loses tool detail (the handoff) or fails.
- **Fix**: compare with t3's Pi adapter's `rollbackThread` and `forkThread` (`t3code/packages/provider-pi/src/server/adapter.ts`).

### U57. Scratch checkouts, Codex's investigation, task webhooks' origin and the PR watch's wake (parity batch: G7, G4, G12)

- **Where**:
  - Scratch checkouts (G7): `apps/environment/src/agents/scratch.ts` (the registry), `platform/routingFileSystem.ts` (`makeTempDirectory[Scoped]` in `/w/.wt`, `remove` of the scratch directory), `agents/processRouter.ts` (`scratchAdd`, the `remove` route, `-C <checkout>` for git in it), `environmentDO.ts` `place` (a CLI in a checkout runs in its project's Container), `apps/agents/src/workspace/containerOnly.ts` `WORKTREE_GIT_DIRS`. t3's side: `t3code/apps/server/src/pullRequest/PullRequestReviewGuideService.ts` `checkoutHead` (`makeTempDirectoryScoped({ directory: worktreesDir, prefix: "review-guide-" })`, `<dir>/checkout`, `-c core.hooksPath=/dev/null worktree add --detach --quiet <path> <sha>`, `merge-base`, `readChange`'s two `diff`s) and `vcs/worktreeRemoval.ts` (`-c status.showUntrackedFiles=normal worktree remove --force -- <path>` off Windows).
  - Codex's investigation (G7): `provider/cli/codexInvestigation.ts` (`codex exec --json`, the last `item.completed` `agent_message`), `agents/cliProfiles.ts` `codexExecLaunch`, `agents/cliProcess.ts` (a stdin Stream piped in). t3's side: `TextGenerationOperations.Request.investigate`, `TextGeneration.ts` `INVESTIGATING_DRIVERS`, `CodexTextGeneration.runCodexJson`'s argv.
  - Webhook origin (G12): `t3/webhookOrigin.ts`, `composition.ts` `layerScheduledTaskWebhookOrigin`; t3's `ScheduledTaskWebhookOrigin`, `WEBHOOK_ROUTE_PREFIX` and `webhookEndpoint` (`ScheduledTaskService.ts`).
  - PR watch's wake (G12, extends U2): `host/idle.ts` `watchedPullRequests` reads `orchestration_v2_projection_threads.payload_json` `$.pullRequests[*].watch` and `$.archivedAt`, as `ProjectionStore.getThreadsWithPullRequests` and `PullRequestWatchReactor.pass` do; `PR_WATCH_WAKE_MS` (10 min) against t3's `SWEEP_MINUTES` (2).
- **Breaks when**: t3 changes the guide's checkout (a branch instead of `--detach`, another directory, another prefix, a FileSystem call on the checkout path such as `exists` before the add), Codex's `exec` flags or its `--json` event names, `ScheduledTaskWebhookOrigin`'s shape or the hook route, or where a watch is kept in the thread payload. A Codex bump that changes `exec`'s tools (SPI-1102).
- **Detection**: typecheck (`ScheduledTaskWebhookOrigin`, `WEBHOOK_ROUTE_PREFIX`); `test/scratchCheckout.test.ts` (t3's argv as written today, the profile, the event parser); `test/host.test.ts` (the watch query on a synthetic payload); `test/webhookOrigin.test.ts`. **Silent**: a changed guide flow (a refusal with the reason, in the router trace), a moved watch field (no wake while asleep: watches resume at the next boot). Cheapest check: `scripts/pbatch.ts guide` and `prwatch-start`/`prwatch-check` on a stage, outside the bump.
- **Blast radius**: review guides fail ("Codex gave no answer" or a git refusal); hook URLs missing; PR watches checked only while a client is connected.
- **Fix**: diff `PullRequestReviewGuideService.ts`, `CodexTextGeneration.ts`, `ScheduledTaskService.ts` and `PullRequestWatchReactor.ts` between tags.

### U58. Retired: Commissary's usage and limit readers (SPI-1176)

The Usage page's reader of Commissary's request log and the limit source of Commissary's accounts went with the Model
proxy at the hard cut (SPI-1176). The Usage page's readers are
[U79](#u79-the-usage-page-from-t3flares-own-usage-records-spi-1173); the limit-source Layer
(`usage/limitSources.ts`) is [U84](#u84-limit-meters-for-subscription-endpoints-vendors-limit-headers-and-t3s-limit-source-contract-spi-1174);
the rest of parity batch 2's leans (the ACP registry, the Storage page, OTLP) moved to
[U86](#u86-the-acp-registrys-refusals-the-storage-pages-database-row-otlp-from-settings-parity-batch-2-g13).

### U59. The preview browser: a Shadow of `ServerBrowserContexts`, the HTML-render bridge, and `@cloudflare/playwright` (G11)

- **Where**:
  - `apps/environment/src/shadows/serverBrowserContexts.ts`, replacing `t3code/apps/server/src/preview/ServerBrowserContexts.ts`: `presentAsChrome` and the class `ServerBrowser.make` builds with `new` (`contextFor`, `scratchPage`, `connectDesktopPage` refused, `clearProfile`, `close`) with stock's `Options` (`profilesDir`, `executable`, `launcher` and `diagnose` ignored; `idleBrowserMs`, `onContextClose` used). It wraps every page's `goto` (`translatePreviewUrl`), each `Download.saveAs`, and `FileChooser.setFiles`/`Locator.setInputFiles` on the fork's prototypes.
  - `src/shadows/publicProxy.ts`, replacing `htmlRender/publicProxy.ts` (`publicProxy`'s shape: `{ port, fakeIpHosts }`).
  - `src/preview/htmlBrowser.ts`: our process router answers `PreviewBrowser`'s executable (`src/preview/previewBrowser.ts`, a Layer) with a CDP bridge that speaks stock `headlessChrome.ts`'s `--remote-debugging-pipe` (fd 3/fd 4, NUL-delimited), rewrites its page origin `http://t3-page.localhost` to `https://t3-page.t3flare.internal`, and answers `Browser.close` and `--version` itself.
  - `@cloudflare/playwright` 1.4.0 (a port of Playwright 1.62.1) against t3's `playwright-core` pin (1.64.1 at `d8f3feff0c`), loaded by dynamic import; `playwright-core` is a dev dependency of `apps/environment` for its types only.
- **Breaks when**: t3 adds a method or option to `ServerBrowserContexts`, or calls it a new way; `ServerBrowser.ts` uses a Playwright API the fork lacks, or navigates by something other than `goto`/`reload`; `headlessChrome.ts` changes its page origin, its pipe framing, or how it ends the browser; `publicProxy.ts` gains an export; Browser Run changes `outboundByHost` (HTTP only, eight hosts, port 80), its `keepAlive` bounds or its `localhost` policy.
- **Detection**: the build fails on a missing Shadow export; `test/previews.test.ts` checks the Shadow keeps stock's exports and public methods, the URL translation and the bridge (fake socket). **Silent**: a Playwright call that exists but misbehaves over CDP; a new navigation path that skips `goto` (its `localhost` is refused, ERR_BLOCKED_BY_ADMINISTRATOR); a changed page origin in `headlessChrome.ts` (renders fail to load). Cheapest check: `scripts/previews.ts spike`, `op html-capture` and `browser` on a stage.
- **Blast radius**: no browser tabs, tabs that cannot reach `localhost`, or no HTML screenshots and heights (publishing still works).
- **Fix**: diff `ServerBrowserContexts.ts`, `headlessChrome.ts`, `publicProxy.ts` and `playwright-core` in `apps/server/package.json` between tags; read the fork's changelog.

### U60. Port discovery from each Container (G11)

- **Where**: `apps/environment/src/preview/portDiscovery.ts`, a Layer of `PortScanner.PortDiscovery` (eight methods; `watchAgentCommandStops`, Codex's hook for a stopped command, registers nothing and tells no watcher, since a stop here reads no process environments) reusing t3's `stoppableProcessGroup`; `DiscoveredLocalServer`, `DiscoveredLocalServerList`, `PreviewStopLocalServerError` and the configured-URL limits (`contracts/src/preview.ts`); `isLoopbackHost`; t3's projection tables for a thread's Workspace (`orchestration_v2_projection_threads.payload_json` `$.worktreePath`, `projection_projects.workspace_root`, as `deletion.ts` reads them, U2); the terminal Layer's `registerTerminalProcesses`/`unregisterTerminal` options and its inspector's `processIds`; `apps/sandbox-image/src/ports.ts` (the scan, in the image's Node, and the group stop).
- **Breaks when**: t3 adds a method or a field (a workspace or cwd on a server), renames `T3CODE_THREAD_ID`, changes the stop errors, stops calling `registerTerminalProcesses` from its inspector poll, or moves those projection fields; the image loses Node from mise's system directory.
- **Detection**: typecheck covers the service and contracts; `test/previews.test.ts` (attribution, review M7, configured URLs, the projection read); `apps/agents/test/portsScript.test.ts` runs the scan and stop on real processes in Docker. **Silent**: a renamed variable or moved projection field leaves agent servers unlisted (stock lists only owned ones). Cheapest check: `scripts/previews.ts browser`.
- **Blast radius**: servers missing from the list, or not stoppable.
- **Fix**: diff `PortScanner.ts`, `contracts/src/preview.ts` and `terminal/Manager.ts`'s inspector loop.

### U61. Patch 0005: the thread at `contextFor` (G11)

- **Where**: `patches/0005-server-browser-context-thread.patch`, the one `contexts.contextFor(` call in `ServerBrowser.ts`, gaining `snapshot.threadId`.
- **Breaks when**: the call moves, gains arguments, or a second call site appears.
- **Detection**: the patch fails to apply at bump (loud). **Silent**: a new call site without the thread opens its tab in the route-less browser, whose `localhost` reaches nothing.
- **Blast radius**: tabs that cannot reach the dev server.
- **Fix**: re-cut the patch.

### U62. Container previews and the carried-socket script (G11)

- **Where**: `apps/agents/src/workspace/containerPreview.ts` and `containerPreviewScript.ts` (ported from cloudpid@93ba45a3), `WorkspaceDO.containerPreview` with its use and hold accounting (`#someoneWorks`, `#previewHold`), `WorkspaceContainerPreviews` (agents Worker) and `ContainerPreviews` (Environment Worker), the eight ports in `@t3flare/workspace-client`.
- **Breaks when**: Browser Run starts routing WebSockets (the script becomes dead weight), a dev-server client changes how it opens sockets (Vite's `SharedWorker` ping), or Containers change `getTcpPort`.
- **Detection**: `apps/agents/test/containerPreview.test.ts` (Host and Location, refusals, the script). **Silent**: HMR stops while pages still load. Cheapest check: `scripts/previews.ts browser` (its HMR line).
- **Blast radius**: no live reload; pages still load.
- **Fix**: compare with cloudpid's current `container-preview*.ts`, which meets the same breakage first.

### U63. MCP apps through the CLI wrapper and the MCP host (G11)

- **Where**: `provider/cli/wrapper.ts` (no longer strips `mcpApps`); `ProviderAdapterV2McpApps` (`provider-core/src/server/ProviderAdapter.ts`); `mcp/relay.ts` (`_meta.ui` in `tools/list`, `structuredContent`, `resources/read` of a `ui://` URI) and `mcp/host.ts` (`readAppResource`, through the vendored engine's `resources/read` with `app: true`); `appUriOfMeta` from `@cloudpid/mcp/types`.
- **Breaks when**: t3 changes `ProviderAdapterV2McpApps`; Codex's app-server renames `mcpServerStatus/list`, `mcpServer/tool/call` or `mcpServer/resource/read`; the ext-apps spec moves its `_meta` key.
- **Detection**: typecheck covers the adapter shape; `test/mcpHost.test.ts` and `test/mcpRelay.test.ts` cover the pass-through and the refusals. **Silent**: a moved `_meta` key shows plain tool rows.
- **Blast radius**: apps show as ordinary tool rows.
- **Fix**: diff `mcpApps/`, `CodexAdapterV2.ts`'s `mcpApps`, and the ext-apps spec version t3 pins.

### U64. Skills and Prompt templates for the Durable agent (SPI-1001)

Ranked last on its merits, not only by date: every break here leaves turns running (low blast radius), and the hook
and field shapes it leans on fail typecheck rather than silently.

- **Where**:
  - `apps/environment/src/provider/driver.ts`: `snapshotForCwd` on the Pi Durable instance, failing with
    `ProviderDriverError` (imported from `@t3tools/provider-core/server/errors`).
  - `apps/environment/src/provider/skills.ts`: the snapshot's entries as `ServerProviderSkill` and
    `ServerProviderSlashCommand` (`t3code/packages/contracts/src/server.ts`); the expansion, which matches mentions with
    `matchInlineSkills` (`@t3tools/shared/inlineSkills`) and embeds the `<skill name location>` block mirrored from t3's
    Pi provider (`t3code/packages/provider-pi/src/server/mcpExtensionSource.ts`, its `input` hook).
  - `apps/environment/src/provider/attachments.ts`: `turnPrompt` runs the expansion when its caller passes the thread's
    skills (the Pi Durable adapter; of the ACP builders, OpenCode's since SPI-1151, [U65](#u65-the-cli-agents-skills-and-slash-commands-in-t3s-composer-spi-1151)).
  - `packages/skills/src/discovery.ts`: `SKILL_TOKEN_REGEX`, a copy of t3's mention token
    (`t3code/packages/shared/src/inlineSkills.ts`), which `isMentionable` applies to decide which names t3 can mention.
    Copied, not imported: the agents Worker loads no t3 code (`apps/agents/build.ts`).
  - t3: `ProviderInstance.snapshotForCwd` (`provider-core/src/server/driver.ts`) and
    `ProviderRegistry.refreshWorkspaceSnapshot`, with the directory `ProjectService.workspaceScanDirectory` passes; the
    composer's `$name` insertion (`apps/web/src/components/chat/ChatComposer.tsx`).
  - Environment skills (SPI-1148): the snapshot lists them with `scope: "user"` and a `path` outside `/w/<id>`
    (`/workspace/.agents/skills/<name>/SKILL.md`), which t3's chip opens with `projects.readFile` in the project's cwd
    (`apps/web/src/components/chat/SkillInlineText.tsx` `skillInstructionsOpener`) and answers with its own read error
    (`docs/steps/spi-1001/env-install-public.json`); their expansion embeds the Environment's own row under that path.
- **Breaks when**: t3 renames or re-types the hook, `ProviderDriverError` or the snapshot's fields; changes the mention
  grammar or what the composer inserts for a picked skill; changes its Pi provider's skill block; passes the hook
  another directory; filters or re-scopes a snapshot skill by its `scope` or its path being outside the project, or
  makes the chip's "View instructions" fail harder than a read error.
- **Detection**: the bump's check step (`pnpm run check`): typecheck for the hook, the error and the fields; the tests
  `apps/environment/test/skillsSnapshot.test.ts`, `apps/environment/test/skillExpansion.test.ts` (pins on
  `matchInlineSkills`, on the copied `SKILL_TOKEN_REGEX`'s source and on its answers matching t3's for a table of names,
  and on the composer's inserted text) and `packages/skills/src/discovery.test.ts` (the mentionable names). Stage: `scripts/p1001.ts`, outside the bump. **Silent**: a client that sends skills another way leaves
  `$name` unexpanded, and a changed Pi provider block goes unnoticed (ours stays as it was); a chip that stops opening an
  Environment skill's path is only seen on a stage (`scripts/penvsk.ts public`). Cheapest check: the source-text test,
  and a diff of `mcpExtensionSource.ts` and `SkillInlineText.tsx` in the bump PR.
- **Blast radius**: the composer lists no skills or commands for Pi Durable, or a picked skill reaches the agent as
  plain `$name`. A grammar change also changes which names the agent's listing and the composer offer, since discovery
  skips a name t3 cannot mention. Turns still run.
- **Fix**: compare with t3's Pi provider (`packages/provider-pi/src/server/driver.ts` `snapshotForCwd`,
  `mcpExtensionSource.ts`).

### U65. The CLI agents' Skills and Slash commands in t3's composer (SPI-1151)

Ranked last with U64: every break here leaves turns running. A moved root or a changed hook fails a check; a changed
CLI behaviour over ACP is the silent part.

- **Where**:
  - `packages/skills/src/cliRoots.ts`: `CLI_ROOTS`, each CLI's repo Skill roots and command directories as the M0
    probe found them for the pins in `apps/sandbox-image/src/clis.ts` (Codex 0.167.2, pi 1.5.2, Claude Code 2.1.322 with
    `claude-agent-acp` 0.106.0, OpenCode 2.2.7); discovery and `discoverPrompts` take them.
  - `apps/environment/src/provider/skills.ts` (`cliSnapshotForCwd`, `cliSnapshotForCwdOf`) and the four drivers
    (`provider/cli/codexDriver.ts`, `piDriver.ts`, `acpDriver.ts`): `snapshotForCwd` on t3's `codex`, `pi`,
    `claudeAgent` and `opencode` instances, as on Pi Durable's (U64); the machine snapshots carry
    `provider/cli/builtInCommands.ts`: provider-core's `COMPACT_SLASH_COMMAND`, provider-pi's
    `withPiBuiltinSlashCommands` (`packages/provider-pi/src/server/commands.ts`, by path) and a restated copy of
    Codex's `/goal` entry (`apps/server/src/provider/CodexProvider.ts`).
  - `provider/cli/claudeSkills.ts`: `planClaudeSkillDispatch`, imported from t3's server by path
    (`apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts`), for its native form (a sole opening mention becomes
    `/name rest`); applied in `wrapCliAdapter`'s `startTurn` (`rewriteTurnText`). Every other mention is matched with
    `SKILL_TOKEN_REGEX` (`@t3flare/skills`, U64's copy) and gets a note in stock's wording, once per Skill. Stock
    differs: it notes only an earlier user-only Skill and sends the last mention as a native block of its own, which one
    ACP text cannot carry; an opening mention followed by others stays native and unnoted here. It leans on the ACP adapter's native-slash rule
    (`packages/provider-acp/src/server/adapter.ts` `isNativeSlashCommand`, and `t3AcpPromptWithInstructions` leaving a
    leading `/` unwrapped): a leading `/name` goes alone, without t3's instructions or runtime block.
  - `provider/cli/acpDriver.ts` `acpPromptBuilder`: OpenCode's Skill embed in the flavor's `rewriteUserText` (the ACP
    adapter's hook on the typed text, before t3's attachment lines and instructions), with the turn's cwd from the wrapper (`CliTurn`); its block
    mirrors OpenCode 2.2.7's `Skill.toModelOutput` (`packages/core/src/skill.ts`).
  - pi: the profile's `--skill` and `--prompt-template` (`agents/cliProfiles.ts` `piRepoResourceArgs`; pi 1.5.2
    `dist/cli/args.js`, loaded whatever the trust), and t3's pi extension's `$name` input hook
    (`packages/provider-pi/src/server/mcpExtensionSource.ts`), which embeds a picked Skill from what pi loaded.
  - Codex parses `$name` itself (`makeCodexAdapterV2` passes the text through).
  - SPI-1153, Environment skills: each profile links the read-only mount into the CLI's user-level root
    (`$CLAUDE_CONFIG_DIR/skills`, `$XDG_CONFIG_HOME/opencode/skills`, and Codex's `$CODEX_HOME/skills/t3flare-environment`,
    a directory inside its root, which Codex walks following directory links; the root itself stays writable for
    Codex's bundled `.system` Skills), and pi's profile names it first with `--skill`. Each `CLI_ROOTS` root's
    `environment` records the CLI's own winner of a Repo skill there and an Environment skill of its name, probed one
    root at a time (Claude Code keeps its user-level Skill, pi its first; OpenCode keeps one in `.opencode/skills` or
    `.opencode/skill` but the Environment's over one in `.agents/skills`; Codex lists both and skips an ambiguous bare
    `$name`). The snapshot, Claude's rewrite and OpenCode's embed follow it (`environmentPrecedenceOf`,
    `withEnvironmentSkillsFor`).
- **Breaks when**: a CLI bump moves a root or changes a same-named pair's winner (a Repo pair's, or a Repo and
  Environment pair's), or stops following a linked root or directory; t3's mention grammar moves, since
  both patterns must keep up with it: stock planner's `SKILL_MENTION_PATTERN` (which decides the native form) and the
  copied `SKILL_TOKEN_REGEX` (which finds the mentions to note; U64 pins it to `inlineSkills.ts`, not to the planner);
  t3 changes the hook, the
  native-slash rule, `rewriteUserText`'s input, `planClaudeSkillDispatch`'s shape or note, the pi extension's hook, or
  its static command entries; `claude-agent-acp` stops expanding a leading `/name`; OpenCode changes its skill
  tool's output, or starts returning a command's reply over ACP (its repo commands would then be worth listing).
- **Detection**: the bump's check step: typecheck for the hook and the imports; `apps/environment/test/cliSkills.test.ts`
  (discovery with `CLI_ROOTS` against the recorded `apps/environment/test/fixtures/spi-1151/m0-roots.json`; the built-ins and the `/goal`
  pin), `skillsSnapshot.test.ts`, `cliSkillDispatch.test.ts` (the rewrite and the embed through t3's real ACP adapter
  against the scripted agent; the note's wording and the planner's pattern pinned to `ClaudeSkillDispatch.ts`), `cliProfiles.test.ts` (pi's flags). The
  bump's `test:docker` step: `test/docker/skills.docker.test.ts` re-runs the probe on the pinned CLIs and holds
  `CLI_ROOTS` to it, failing with "moved a skill root: update CLI_ROOTS"; `test/docker/envSkills.docker.test.ts`
  re-runs SPI-1153's probe (the set read through each link, each root's winner against its `environment`, a write
  through the link refused). **Silent**: R6 (Claude's native expansion)
  and OpenCode's command reply are stage facts; cheapest check: `scripts/pcli.ts` on a stage after a CLI bump. So is
  when a running CLI sees a changed Environment skill set (SPI-1153: at its next process start; Claude Code and OpenCode
  serve a removed Skill from their caches until then): `scripts/pclienv.ts`.
- **Blast radius**: the composer lists a CLI's Skills or commands wrongly or not at all, or a picked Skill reaches the
  CLI as plain `$name` (Claude Code, OpenCode). Turns still run, and the CLIs still load their own Skills.
- **Fix**: re-run the probe (`T3FLARE_SKILLS_PROBE_OUT=… pnpm run test:docker`) and update `CLI_ROOTS` and
  `m0-roots.json`; diff `ClaudeSkillDispatch.ts`, the ACP adapter's `resolvePromptParts`, `mcpExtensionSource.ts` and
  `CodexProvider.ts`'s slash commands between tags.

### U66. Patch 0006: a removed endpoint's models leave the picker (SPI-1162, SPI-1176)

Ranked last with U64 and U65: a break leaves turns running. The patch failing to apply is loud; a new retention path is
the silent part, and costs only stale entries in the picker.

- **Where**: `patches/0006-endpoint-models-are-not-retained.patch`, the first line of `shouldRetainMissingProviderModels` in `ProviderRegistry.ts`: `piDurable`, `codex`, `claudeAgent`, `opencode` and `pi` retain no missing model (the CLI drivers since SPI-1176). Stock t3 keeps every model a non-Codex, non-OpenCode driver stops listing (`mergeProviderModels`), Codex's on a `warning` probe and pi's while its auth is `unknown`, and persists them, so a removed Model endpoint's models, and the Model proxy's from before the hard cut, would stay in the picker for good, and a provider in the setup state would still list models.
- **Breaks when**: the function is renamed or moved, or t3 adds another retention path.
- **Detection**: the patch fails to apply at bump (loud). **Silent**: a new retention path keeps a removed endpoint's models in the picker; `scripts/p1162.ts` checks they leave Pi Durable's, `scripts/p1176.ts` that every provider lists none in the setup state.
- **Blast radius**: stale models in the picker; a turn on one fails with the removed-model message.
- **Fix**: re-cut the patch.

### U67. Text generation's default model follows the Model endpoints (SPI-1163)

Ranked with U64 to U66: a break leaves turns running; titles and commit text fail or run on a model the owner did not
pick, each failure saying which.

- **Where**: `syncTextGenerationDefault` in `agents/seedSettings.ts`, run by `layerSeedTextGenerationModel` at boot and on
  each endpoint change. It leans on t3 in five places:
  - **The "unset" test** compares the setting with `DEFAULT_SERVER_SETTINGS.textGenerationModelSelection`
    (`packages/contracts/src/settings.ts`, `DEFAULT_SERVER_SETTINGS`; today `codex` / `DEFAULT_TEXT_GENERATION_MODEL`,
    `gpt-6-luna`).
  - **t3's default survives a registered `codex` instance.** The CLI agents register `codex` (step 4a), so stock's
    default names an instance this Environment has. The sync treats that exact value as unset. An owner who picks
    exactly `codex`/`gpt-6-luna`, or exactly the default the sync last wrote, is read as unset too: the pick is
    replaced at every boot and every endpoint change.
  - **`ProviderInstanceRegistry.getInstance`** (`apps/server/src/provider/ProviderInstanceRegistry.ts`) answers
    whether the named instance exists. A name with no instance counts as unset.
  - **The settings read is t3's resolved one.** `ServerSettingsService.getSettings` passes the stored value through
    `resolveTextGenerationProvider` (`apps/server/src/serverSettings.ts`), which swaps a disabled or unknown instance
    for a fallback. The sync sees that fallback, not the stored value.
  - **`Effect.runForkWith(context)`** is fired from the `onEndpointsChanged` listener, with the layer's context
    (`ServerSettingsService`, `ProviderInstanceRegistry`), outside t3's own fibers. Each sync is forked into the layer's
    scope (`Effect.forkIn`), so the runtime's disposal interrupts one still running, and is bounded by
    `SYNC_TIMEOUT_MS` (30 s) under a module semaphore. Its finalizer stops the listener when the layer's scope closes.
- **The stage scripts' leans (SPI-1175).** The acceptance test's §1b (`scripts/acceptance.ts`) and the evidence script
  `scripts/p1175.ts`, through the helpers in `scripts/lib/client.ts`, drive t3's own WebSocket API as a client does:
  - **`server.updateSettings` with `providerInstanceMutation`** (`enablePiDurable`: upsert `piDurable`, enabled). A new
    Environment has the Durable agent off, and `resolveTextGenerationProvider` swaps a selection on an instance that is
    off for its fallback (Codex), so the check turns it on first, as the client's onboarding does.
  - **`server.getConfig` → `settings.textGenerationModelSelection`** (`textGenerationSetting`,
    `waitForTextGenerationSetting`): the resolved selection, compared with `defaultTextModel` of the panel's endpoints.
  - **`thread.metadata.update` with `regenerateTitle: true`**, after a `title` reset, and the thread projection's
    `lastTitleRegeneration` (`requestId`, `status`, `message`) (`regenerateTitle`, p1175 only).
- **Breaks when**:
  - t3 renames `providerInstanceMutation`, `server.getConfig`'s `settings`, `regenerateTitle` or `lastTitleRegeneration`,
    or moves the resolved selection out of `getConfig`: the acceptance test fails ("text generation names the Model
    endpoints' default") or p1175 times out, a false alarm about production but a true one about these RPCs;
  - t3 stops deriving its default text-generation selection from `DEFAULT_SERVER_SETTINGS` (a default applied
    elsewhere, such as at decode or by a migration): the sync, which reads that constant live, no longer recognises the
    stored default as unset, and the setting stays on it;
  - `getSettings` resolves differently: the sync replaces a fallback, or misses an unset value;
  - the registry or the layer's scope changes shape: typecheck catches it.
- **Detection**: `apps/environment/test/textGenerationDefault.test.ts` runs the sync on t3's own test settings service,
  including stock's default with `codex` registered, and the subscription. `apps/environment/scripts/p1163.ts` checks the setting on a
  fresh stage, and so does every t3 bump's acceptance test once the `bump` environment has `T3FLARE_MODEL_ENDPOINT`
  (SPI-1175; before that it skips the check). A default no longer taken from the constant, with a still-registered instance, is **silent** outside that script.
- **Blast radius**: generated titles and commit text run on t3's stock model, or fail (no such instance), instead of the
  endpoints' default.
- **Fix**: diff `DEFAULT_SERVER_SETTINGS.textGenerationModelSelection` and `resolveTextGenerationProvider` between tags.

### U68. Text generation names the endpoint on t3's own failures (SPI-1163)

Ranked with U64 to U67: a break leaves titles and commit text working; only an error's wording loses its endpoint.

- **Where**: `makePiDurableTextGeneration` in `apps/environment/src/provider/textGeneration.ts` wraps each of
  `ProviderTextGeneration`'s six operations (`namingEndpoint`), so a failure on an endpoint's model is prefixed
  `The Model endpoint "e" (model m): …`. It leans on t3's `TextGenerationOperations`
  (`packages/provider-core/src/server/textGenerationOperations.ts`) in three ways:
  - **The six operations** of `ProviderTextGeneration` are listed by hand.
  - **The failures after the reply** are only `generatedThreadTitle`'s placeholder title and
    `withoutInvestigation`'s refusal; both are prefixed by the wrapper.
  - **The sanitizers cannot fail**: `sanitizeCommitSubject`, `sanitizePrTitle`, `sanitizeFeatureBranchName` and
    `formatGeneratedBranchName` are plain string functions with fallbacks.
- **Breaks when**: t3 adds an operation, or adds a step after decoding that can fail.
- **Detection**: a new operation fails typecheck (the returned object must be a `ProviderTextGeneration`). **Silent**: a
  new failing step after decoding goes through the wrapper, so it is still named; a failure the wrapper never sees (a
  new runner outside `fromRunner`) is not. `apps/environment/test/endpointTextGeneration.test.ts` covers the two known
  failures.
- **Blast radius**: an error text that doesn't name the endpoint.
- **Fix**: diff `textGenerationOperations.ts` between tags and wrap any new operation or failure.

### U69. Codex on Model endpoints through the model relay (SPI-1167)

Ranked after U29, which it extends: a break fails Codex turns on endpoints (loudly, but with t3's generic text), or,
for the shell exclusion, puts the model handle in an agent's commands. (The Model proxy's path beside it went at the hard
cut, SPI-1176: a model from before it, a bare id, runs on the default model, the first endpoint's first.)

- **Where**: `apps/environment/src/provider/cli/codexGuard.ts`, `codexDriver.ts`, `codexEndpoints.ts`,
  `agents/cliProfiles.ts` and `provider/cli/wrapper.ts`, against Codex's app-server protocol
  (`t3code/packages/effect-codex-app-server`) and t3's `CodexAdapterV2.ts`:
  - **The guard rewrites thread requests.** On `thread/start`, `thread/resume` and `thread/fork` with a `model` that is an
    endpoint's slug, it sets `model` to the model's own id and `modelProvider` to `t3flare-endpoint-<id>`; on
    `turn/start` it sets `model` and `collaborationMode.settings.model` the same way.
  - **Codex runs a thread's turns only on its process's provider**: `turn/start` fails with "This chat uses <a>, but
    your current provider is <b>" otherwise, whatever the thread's `modelProvider` or its config's `model_provider`
    (measured on p1167). So the process's `-c model_provider` is the session's model's (`codexProcessProvider`), and the
    guard refuses a turn whose model is another provider's.
  - **The guard reads the thread openers' answers**: `modelProvider` and `thread.id` of the `thread/start`,
    `thread/resume` and `thread/fork` responses give each thread's provider.
  - **The session's model**: `wrapper.ts` reads `input.modelSelection.model` in `openSession` (the spawn's provider).
  - **t3 resumes in the same process on a model change** within the Codex instance (`thread/resume` with the new model,
    then `turn/start`); it never asks the adapter's `planSelectionTransition`, so no session restart can be planned
    from the driver.
  - **A refused turn's reason is only in the log**: t3 shows `ProviderAdapterTurnStartError`'s generic "The provider
    could not start this turn"; `codexDriver.ts` logs `codex-turn-start-failed` with the cause.
  - **The handle stays out of Codex's shells**: `shell_environment_policy.exclude` lists `T3FLARE_MODEL_HANDLE` (with the
    Tool handle), and the provider reads it through `env_key`.
- **Breaks when**: Codex renames `modelProvider` in the thread params or responses, or `thread.id`; starts accepting a
  per-thread provider (the refusal becomes needless) or rejects a provider set by `-c`; changes `env_key` or
  `shell_environment_policy.exclude`; t3 starts restarting the session on a model change, or stops passing
  `modelSelection` to `openSession`, or surfaces the cause's text. And a CLI starts requiring a request header the
  relay's allowlist drops (a new `openai-*` or `anthropic-*` header, `forwardedHeadersOf` in `@t3flare/models/relay`):
  its requests fail or lose a feature at the endpoint; the relay log's `dropped` field names the header.
  Or a CLI's API path starts holding a literal `%`, a control character or a multiply encoded escape: the relay
  refuses the path (400, `modelRelay.ts` `leavesBase`).
- **Detection**: typecheck (the response shapes, `ProviderAdapterV2OpenSessionInput.modelSelection`);
  `test/codexGuard.test.ts`, `test/codexEndpoints.test.ts`, `test/cliProfiles.test.ts` (the rewrite, the routing, the
  process provider, the exclusion); `scripts/p1167.ts` on a stage (a turn with tools, a resume, the refused switch,
  the shell's environment). **Silent**: a renamed response field (the thread's provider is then unknown and the
  refusal skipped; Codex's own error follows); a dropped exclusion in a new Codex (the handle reaches the agent's
  commands; only the stage script's shell check sees it); t3 starting to restart sessions (the refusal still fires on
  the first turn).
- **Blast radius**: Codex threads on endpoints fail to start or turn, with t3's generic message; or the model handle
  in Codex's shells (any command could spend through the endpoint while the process lives).
- **Fix**: diff `CodexAdapterV2.ts` (`codexThreadRuntimeParams`, `buildCodexTurnStartParams`, `planSelectionTransition`)
  and the app-server schema (`ThreadStartParams`, `ThreadStartResponse`, `TurnStartParams`) between tags; update the
  guard, `codexProcessProvider` and the exclusion; re-run `p1167.ts`.
- Claude Code's leans on the relay, and the model-routed URL, are [U75](#u75-claude-code-on-model-endpoints-through-the-model-relay-spi-1168); OpenCode's are [U76](#u76-opencode-on-model-endpoints-through-the-model-relay-spi-1169); pi's are [U78](#u78-pi-on-model-endpoints-through-the-model-relay-spi-1170).

### U70. The Settings server's caller: `threadLinkIn` reads the thread projection (SPI-1198)

- **Where**: `apps/environment/src/provider/threadCaller.ts` `threadLinkIn` (through `threadLinkOf`,
  `provider/adapter.ts`) reads `orchestration_v2_projection_threads.payload_json` at `$.linkOrigin` and
  `$.lineage.parentThreadId`, by `thread_id`, and walks the lineage up to `MAX_LINEAGE` (32) threads. It decides whether
  a Settings server write may run (ADR-0035, plan D3): `own` only when every row up the lineage is there and carries no
  link origin; a missing row, a row that is not JSON, a loop, a too-deep lineage, or a `parentThreadId` that is present
  but not a non-empty string is `unknown`; any `linkOrigin` is `linked`. t3's side: the projection's thread payload
  (`t3code/apps/server/src/persistence/Migrations/`, `ProjectionStoreV2`) and `OrchestrationV2Thread`'s `linkOrigin` and
  `lineage` in `@t3tools/contracts`.
- **Breaks when**: t3 renames the table or `payload_json`, moves `linkOrigin` or `lineage.parentThreadId` inside the
  payload, stops writing a projection row for a thread before its first turn, or marks Linked work some other way (a
  field beside `linkOrigin`).
- **Detection**: **silent**, but fails closed for a moved field only in part: a renamed table, a moved `lineage` or a
  missing row reads `unknown`, so every own agent's write is refused (`UNKNOWN_REFUSAL` in the tool result and a
  `settings-refused` log line with `reason: unknown-thread`); a moved `linkOrigin` reads as no link, so Linked work
  could write. `test/settingsCaller.test.ts` pins our reading of the shapes, not t3's. Cheapest check: T4's workerd
  test, extended to write a linked thread and a child through t3's own projector and run `threadLinkIn` on both.
- **Blast radius**: a moved `linkOrigin`: a laptop's linked thread could change the cloud's settings without the
  Settings server telling it apart (its cards still go to the owner). Anything else: agents cannot change settings
  until it is fixed; reads and the panel are unaffected.
- **Fix**: compare both JSON paths with `OrchestrationV2Thread` in `@t3tools/contracts` and t3's projector for the
  thread row, and `linkedWorkOf` (`provider/adapter.ts`, which reads `$.linkOrigin` too, U2 and U5).

### U71. pi's built-in MCP for the relay, and Patch 0007 (SPI-1076)

- **Where**: `apps/environment/src/agents/cliProfiles.ts` `piMcpJson` writes `$PI_CODING_AGENT_DIR/mcp.json`, pi 1.5.2's
  user-level file: one `mcpServers.<server>` per relayed server with `url` (`relayUrl`), `headers.Authorization: "Bearer
  ${T3FLARE_TOOL_HANDLE}"` (pi expands `${VAR}` in a header from the process's environment; the handle is in no file),
  `timeout` 900 (pi's per-request timeout, which progress notifications reset) and `exposure: "deferred"` (found through
  pi's `tool_search`). It rests on pi's behaviour as M0's P16 found it (`docs/steps/settings-mcp/m0-pi.json`, spike
  branch `settings-mcp-m0-spike`): `PI_OFFLINE=1` does not stop MCP connects; `--mode rpc` loads the built-in MCP;
  `--no-extensions` (t3's fork launch, which gets no `mcp.json`) turns it off; a project's `.pi/mcp.json` is read only
  under project trust, which `PI_SETTINGS`' `defaultProjectTrust: "never"` and `--no-approve` keep off.
  `patches/0007-pi-relay-tools-are-judged-by-the-relay.patch` adds `isRelayedMcpTool` to the `tool_call` hook of t3's pi
  extension (`t3code/packages/provider-pi/src/server/mcpExtensionSource.ts`, beside `isReadOnlyMcpTool`): outside full
  access a tool named `mcp__<server>__…` whose server is one the profile names in `T3FLARE_RELAY_SERVERS`
  (`RELAY_SERVERS_ENV`, comma-separated, set by `piLaunch` beside the handle, the same list as `mcp.json`; SPI-1199
  review) and whose `pi.getAllTools()` entry (one per name, the one pi runs) has `sourceInfo.path === "builtin:mcp"` is
  not asked, because the relay judges it and asks on the thread; without the Patch a relay read would ask once and a
  write twice. Every other tool is asked as stock t3 asks, including pi's resource tools (`read_mcp_resource`, also from
  `builtin:mcp`), a tool of another extension under an `mcp__` name, and a `builtin:mcp` tool of a server the relay does
  not serve this process. A relayed server matches as pi names its tools: `mcp__<server>__` with every character but
  letters, digits and `_` replaced by `_` (pi 1.5.2 `docs/mcp.md`; the code is `createMcpToolName` in
  `@earendil-works/pi-mcp`'s `src/naming.ts`, bundled into pi, `.replace(/[^A-Za-z0-9_]/g, "_")`), so `my-docs` is
  `mcp__my_docs__…` (SPI-1200 review; server names are `[a-z0-9-]{1,20}`, `SERVER_NAME`). After the prefix, a name whose
  rest starts with `_` or holds `__` is asked: it may be the tool of a server whose name only starts like a relayed one
  (`settings--x` and `settings__x` give `mcp__settings__x__…`, `settings-` gives `mcp__settings___…`; SPI-1201 review).
- **Breaks when**: pi renames `mcp.json` or its keys, drops `${VAR}` expansion in headers, changes the `builtin:mcp`
  source path or `getAllTools`' `sourceInfo`, lets `PI_OFFLINE` stop MCP, stops turning MCP off with `--no-extensions`,
  or reads a project's `mcp.json` without trust; pi changes how it names a server's tool (`mcp__<server>__<tool>`, the
  character replacement, or where it puts the hash suffix of colliding tool names), so the prefix no longer matches; t3
  edits the hook's lines.
- **Detection**: the Patch failing to apply (`check:patches`, loud); `test/piRelayPatch.test.ts` applies the Patch as
  `build.ts` does and runs the hook against a stand-in for pi's API (the relay's tools pass; bash, write, t3's tools, a
  look-alike extension tool, a resource tool, an unlisted tool, a `builtin:mcp` tool of an unnamed server, and every
  tool when no server is named are asked; a hyphenated server matches by pi's `_` name and a longer name does not, nor
  `settings--x`, `settings__x`, `settings-` or `commissary_`); `test/cliProfiles.test.ts` T-pi-1 pins the file, the
  environment (the handle and `T3FLARE_RELAY_SERVERS`) and the fork. **Silent**: a renamed source path (pi asks the
  extension's "Allow …?" before the relay's card: more asks, fail closed); a changed `mcp.json` shape or expansion (pi
  lists none of the relay's tools). Cheapest check: `scripts/tools.ts cli-mcp pi` on a stage (the read raises no
  request, the write only the relay's card); or a `test:docker` case running the image's pi against a relay stand-in
  (not built).
- **Blast radius**: a moved source label or tool-name shape: an extra ask per relay call (fail closed). A `builtin:mcp`
  server from elsewhere is asked as any tool is, unless it takes a relayed server's name, which pi's own config keeps
  unique per name and project trust (off) would be needed to override.
- **Fix**: re-read pi's `docs/mcp.md`, `docs/extensions.md` and `docs/security.md` at the new version; rerun M0's P16
  probe (`scripts/settings-spike` on the spike branch); re-cut the Patch with `git diff` of a copy of the file, as the
  other Patches are cut (paths relative to `t3code/`, `a/` and `b/` prefixes, which `build.ts` reads).

### U72. The Owner-client endpoint: Access managed OAuth (beta) and the hand-written MCP versions (SPI-1200)

- **Where**: `apps/environment/src/settings/endpointLayout.ts` (layout (B): `<host>/_t3flare/mcp`;
  `OWNER_ENDPOINT_EXCLUDED_STAGES` keeps prod out of it until owner step 1 passes, and the t3 bump's `bump` for
  good, ADR-0036), the `SettingsAccess` application in `apps/environment/alchemy.run.ts` (`oauthConfiguration`,
  `pathCookieAttribute` on it and on `AdminAccess`, passed `as never` to alchemy's `Cloudflare.Access.Application`; on
  prod and `bump` neither), `worker.ts`'s branch for it (`verifySettingsRequest` against `T3FLARE_ACCESS_SETTINGS_AUD`;
  unset on prod and `bump`, so 404 `not_configured`); the
  Access `sub` of the endpoint's assertion, which keys an Owner client's caps, Open changes and reads (`capKeyOf`,
  `owner:<sub>`) and decides who answers its Open changes on the Change page (`answererProblem` in
  `settings/openChanges.ts`: the page's `sub` must equal the asker's; P13, the same `sub` in an OAuth-derived and a
  browser assertion, is pending owner step 1); and `apps/environment/src/settings/endpoint.ts`, which hand-writes MCP
  2026-07-28 (`server/discover`, `_meta` `io.modelcontextprotocol/*`, `resultType`, `input_required` with
  `inputRequests` and `requestState`; `-32022` with `data.supported` and `requested`, `-32020` for a missing or
  mismatched `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` (Base64 sentinel decoded), and 404 with `-32601`, each
  checked against the spec's `schema/2026-07-28/schema.ts` and its Streamable HTTP page on 2026-11-14, SPI-1200 review)
  and 2025-11-25 to 2024-11-05 (session id, an unknown `MCP-Protocol-Version` answered 400 and a missing one read as
  2025-03-26, `elicitation/create` with `mode: "url"` and `elicitationId` on the call's SSE stream, the response POST
  answered 202). It rests on M0 (`docs/steps/settings-mcp/m0-access-oauth.json`, `m0-clients.json`, copied from the
  spike branch `settings-mcp-m0-spike`): the more specific Access application wins a path; a token of one application is
  refused at another's (tested with a service-token stand-in only; the OAuth bearer case is owner step 1,
  `docs/steps/settings-mcp/m5a-stage-run.md` items 1-4, so layout (B) is unproven until then); Access answers no root or
  path-inserted well-known document, so clients find the authorization server only from the 401's `WWW-Authenticate`
  `resource_metadata`; `resource` is accepted with or without the query at authorize; the query reaches the origin
  (no longer relied on by the named clients: Claude Code's discovery fails with one, U74); and Claude Code 2.1.322's
  2026 traffic as captured (P17).
- **Breaks when**: Access (in beta) starts answering the host's root `/.well-known/oauth-*` documents (t3's own `/mcp`
  sign-in would find Access's server instead of t3's), changes how path-scoped applications nest or how it scopes
  tokens and cookies, or refuses a path-scoped or queried `resource`; alchemy renames `oauthConfiguration` or
  `pathCookieAttribute`; the MCP spec or a named client changes the 2026 shapes (a key under `_meta`, `resultType`, the
  `input_required` result, `server/discover`'s result) or stops falling back to `initialize`; Access gives the owner a
  different `sub` in the endpoint's OAuth-derived assertion than in his browser's at the panel, or changes it over time
  (an Owner client's change could no longer be answered on the Change page, "only the owner who asked answers this
  change", and its caps would restart under the new key).
- **Detection**: `test/settingsEndpoint.test.ts` and `test/settingsModes.test.ts` pin our reading of the shapes, not a
  client's; `test/access.test.ts` the audiences and `test/workerRouting.test.ts` the Worker's branch (its order, the
  endpoint's audience, the panel's refused, local mode). `scripts/smoke.ts` asserts on every prod deploy, and
  `scripts/acceptance.ts` step 2b on every acceptance run, that the host's root
  `/.well-known/oauth-authorization-server` and `oauth-protected-resource` are still t3's (its issuer, its `/mcp`
  resource): nothing checks them between deploys. The `sub` (P13) is `m5a-stage-run.md` item 2 and
  `test/openChanges.test.ts` ("page: an Owner client's change by the same sub only"); a later change of it is silent
  until a page answer is refused. **Silent** for Access's token scoping and real clients: the stage run of
  `m5a-settings-owner-browser.json` (a named client signs in, reads, makes a free and an asked change).
- **Blast radius**: an Access change: Owner clients cannot sign in, or (root well-knowns) t3's own MCP clients cannot.
  A client's shape change: that client gets errors or the link in the result; own agents and the panel are unaffected.
- **Fix**: rerun M0's probes (`scripts/settings-spike` on the spike branch); if Access breaks layout (B), move to (C) by
  replacing `endpointLayout.ts`, the worker branch and `SettingsAccess` (plan D13); for a client, compare with the
  spec's `schema.ts` for the version and the client's traffic.

### U73. The Owner-client endpoint's `native` and `model` modes: client forms and Executor's pause (SPI-1201)

- **Where**: `apps/environment/src/settings/endpoint.ts` (`deliverNative`, `heldStream`, the response POST's `native`
  branch, the `requestState` retry's `native` branch, `resume`) and `server.ts` (`ownerPause`, `ownerResume`,
  `EMPTY_SCHEMA`, `PAUSE_LINE`), `tools.ts` (`RESUME_TOOL`). `native` asks a form with an empty `requestedSchema`
  (`{ type: "object", properties: {} }`) and reads only the answer's `action`: 2026 as `input_required` with
  `mode: "form"`; 2025-11-25 and 2025-06-18 (no `mode` key there) as `elicitation/create` on the call's SSE stream, held
  until the client's response POST, the stream's end or the change's expiry, with `notifications/progress` (when the
  call carried `_meta.progressToken`) or an SSE comment every 15 s. It rests on M0's P14 (`m0-clients.json`, spike
  branch): Claude Code 2.1.322 shows an empty form as Accept / Decline on both versions, posts the 2025 answer as its
  own JSON-RPC response, and keeps the dialog open when the server cuts the stream (then posts a stale answer, which
  finds the change withdrawn); OpenCode 2.2.7 accepts an empty form by itself under `permission: allow`. `model`
  copies Executor's pause (U52) so that a host with ADR-0028's pausing rule reads it: `structuredContent.status`
  `approval-required`, `requestId`, `elicitation { mode: "form", message, requestedSchema }`, `expiresAt`, and a
  `resume` whose input has `requestId` and `response { action, content }` (`isPausingServer`); M0 saw Claude Code's
  agent read such a result, not call `resume` itself, and ask the user.
- **Breaks when**: a client starts rendering an empty `requestedSchema` as nothing to answer, or refuses it (plan §9:
  `native` would need a one-boolean form); a client stops posting the 2025 answer as its own POST (it would hold to
  the change's expiry), or drops its form when a stream has been held a while; the spec moves the 2026 form to other
  keys; Executor changes its pause or `resume` shape, so hosts built for it (ours, U52, included) stop reading this
  server's Pause as one.
- **Detection**: `test/settingsModes.test.ts` pins our side of each shape, and imports `pauseOf` and
  `isPausingServer`, so a change to our own reading of Executor's shape fails there. **Silent** for real clients: the
  stage run of `m5b-settings-owner-modes.json` (`docs/steps/settings-mcp/m5b-stage-run.md`).
- **Blast radius**: `native` or `model` with that client: the question is not shown or not answered, and the change
  waits on its Change page until it expires (the page still answers it, so nothing applies unseen). `browser`, own
  agents and the panel are unaffected.
- **Fix**: for a client, compare its traffic with the spec's `schema.ts` and M0's capture; if an empty form is the
  problem, ask a one-boolean form (`{ approve: { type: "boolean" } }`) and read `content.approve` with `accept`; for
  Executor, follow U52's fix in `ownerPause` and `RESUME_TOOL` too.

### U74. Owner clients' URL without a query, and the mode keyed by `clientInfo.name` (SPI-1201)

- **Where**: `apps/environment/src/settings/clients.ts` (the kept modes, by Access `sub` or `service-token` and the
  client's `clientInfo.name`), `endpoint.ts` (`modeOf`: the query, else the kept mode, else `browser`; the name from
  2026 `_meta` `io.modelcontextprotocol/clientInfo`, from `initialize`'s `clientInfo`, or from the 2025 session token
  that kept it), the Settings server's card on the panel (`page.ts` `ownerClientsBlock`, `panel.ts` `changeClient`).
  It rests on the psmcp stage run of 2026-11-15: Claude Code 2.1.322 added with `…/_t3flare/mcp?elicitation_mode=…`
  could not sign in (its OAuth discovery, with a query on the URL, fell back to the origin's root authorization server
  instead of the 401's per-path `resource_metadata`), and signed in with the plain URL. ADR-0036's refinement of that
  date.
- **Breaks when**: a client changes its `clientInfo.name` between releases (its kept mode no longer applies: it is
  listed again in `browser`, the safe default), sends none (always `browser`), or two clients send the same name (they
  share a mode); a client stops sending `clientInfo` in 2026 `_meta`; Claude Code fixes its discovery (nothing breaks:
  the query becomes usable again, and the panel still decides without one).
- **Detection**: `test/settingsClients.test.ts` pins our side (the resolution order, keys, the cap, the throttle, the
  panel's guard, no other writer). **Silent** for a client's name change: the panel's list shows a new row in
  `browser` and the client asks in `browser` until the owner sets it.
- **Blast radius**: a client in the wrong mode, always toward `browser` for an unknown name; nothing applies unseen.
- **Fix**: set the new name's mode on the panel and remove the old row; if a client's discovery starts tolerating the
  query and the owner prefers it, the override still works as it did.

### U75. Claude Code on Model endpoints through the model relay (SPI-1168)

Ranked after U69, which it extends: a break fails Claude Code turns on endpoints, or puts the model handle in the
environment of Claude's shells. (The Model proxy's path went at the hard cut, SPI-1176.) The handle is never out of reach of the
Container's commands (ADR-0016's SPI-1168 refinement, item 3): Claude's Bash can run the handle helper, or read the
launcher's `/proc/<pid>/environ`, as a Codex shell can read its parent's. What this entry guards is that no
environment or file holds it beyond that.

- **Where**: `apps/environment/src/agents/acpProfiles.ts` (`claudeManagedSettings` with a `ClaudeRelay`),
  `provider/cli/claudeEndpoints.ts`, `provider/cli/acpDriver.ts` (`resolveModelId`, the model list), the image's
  `t3flare-claude-agent-acp`, `t3flare-claude-handle` and `claude-handle-unset.cjs`, and the relay's model-routed URL
  (`apps/agents/src/workspace/modelRelay.ts`, `MODEL_ROUTED_ID`). It leans on Claude Code 2.1.322 and claude-agent-acp
  0.106.0 in these ways:
  - **One base URL per process**: `ANTHROPIC_BASE_URL`, read from the managed `env`; no per-model base URL.
  - **The model id goes to the wire verbatim**: an `availableModels` entry `<endpointId>/<modelId>` is sent as the
    body's top-level `model` (measured locally and on p1168), and Claude still recognises the family in it (it sent
    thinking and context-management betas for `comm2/claude-sonnet-4-5`).
  - **`apiKeyHelper`'s output is sent as `x-api-key` and `authorization: Bearer`**; the relay takes either.
  - **claude-agent-acp starts `claude` with its own `process.env`**: the preload's delete keeps the handle out of
    `claude`'s environment, and so out of the environment of its Bash, hooks and helpers.
  - **Claude Code resolves its own aliases through `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`**: its `default` model
    (`claude-opus-5-5` unpinned) and its subagents' `sonnet`/`opus` are pinned to slugs (`familyModelOf`: the family's
    first model pi-ai's catalog knows, since a resumed session calls the alias and a dated model an endpoint lists may
    be dead, SPI-1176), so every request the routed URL gets names one (`test:docker` runs a session whose model nobody sets; p1168's log has no routed refusal). The
    session's model list is `default` plus `availableModels`.
  - **t3's ACP adapter refuses a model not in that list before any request** (`validateModelSelection`: "The requested
    model is not available in this session"), so a model that is no endpoint's slug fails with t3's "The agent did not
    accept the model" and spends nothing. A stale non-slug (t3's stock `claudeAgent` default `claude-opus-5-5` from
    `DEFAULT_MODEL_BY_PROVIDER`, a draft's or thread's earlier proxy model) never gets there since SPI-1176: the
    flavor's `resolveModelId` (`claudeModelId`) names the default model, the list's first, in its place. A model switch is checked by Claude Code with one non-streaming request.
  - **The web picker's default is the first `isDefault` model** (`getDefaultProviderInstanceModel`): the endpoints'
    first, which `claudeModelsOf` marks, ahead of any proxy model t3 kept listed from before the hard cut.
  - **The managed settings file is the Container's** (`/etc/claude-code/managed-settings.json`): every Claude process
    in a Container shares it, so it holds nothing of one process's.
  - **t3's provider registry would keep a Claude snapshot's earlier models** (`ProviderRegistry.ts`
    `shouldRetainMissingProviderModels` is true for `claudeAgent` in stock t3: 123 rows on p1168, 121 of them the
    proxy's). Patch 0006 makes it false since SPI-1176 (U66), so the picker lists exactly the endpoints' models. A
    stale selection runs on the default model (`claudeModelId`, SPI-1176).
- **Breaks when**: Claude Code adds an alias or a model id it resolves without these variables (the routed URL
  refuses it, 400: the relay log names `routed` with a null endpoint); t3's adapter stops validating the model against
  the session's list (a stale non-slug then reaches the relay and gets its 400 instead of t3's message); Claude Code
  reads its base URL per model, or rewrites or validates a model id with a `/` (the relay
  sees no slug: 400); stops sending the helper's key in either header; claude-agent-acp starts `claude` with an
  environment it saved before the preload ran (the handle reaches the environment of Claude's shells), or Node starts
  overwriting the start environment's memory (`process.title`; the helper then finds no handle and Claude has no key),
  or claude-agent-acp's command line changes (the helper's launcher check fails closed: Claude has no key); Claude Code
  starts calling a body-less endpoint it needs (`GET /v1/models`: the routed URL answers 400, logged with `routed`
  and a null endpoint); a thread's request grows past the routed URL's 16 MiB cap: it gets 413, and so does every later
  turn of that thread, compaction included, since Claude Code re-sends the history (a new thread is the way out; the
  cap is `MAX_ROUTED_BODY_BYTES` in `routedBody.ts`, the body held whole while it is scanned: one buffer with a declared
  length, under twice the cap while a buffer without one grows); or Claude Code starts requiring a header the allowlist drops (the relay log's `dropped` names
  it; p1168's list is in `docs/steps/spi-1168/p1168.json`).
- **Detection**: `test/acpProfiles.test.ts`, `test/claudeEndpoints.test.ts`, `test/claudeSpawn.test.ts`,
  `apps/agents/test/modelRelayRoute.test.ts` and `routedBody.test.ts` (the routed URL);
  `test/docker/claudeRelay.docker.test.ts` in `test:docker` (the real launcher, preload and helper: the routed
  requests with the handle, a Bash command's environment, the processes holding the handle, the helper's refusal of
  a forged launcher record); `scripts/p1168.ts` on a stage (the turn, the switch, the holders, the shell's `env`, the
  leak scan, the relay log). **Silent**: the handle reaching the environment of Claude's shells between `test:docker`
  runs (only it and the stage script check holders); a new dropped header Claude needs for a feature but not for a
  turn. Not detectable, by design: a command reading the handle through the helper or `/proc` (the residual above).
- **Blast radius**: Claude Code turns on endpoints fail, or the model handle in the environment of Claude's shells
  (inherited by every command and child, where today a command must go and read it); either way spending stays
  bounded to the process's endpoints and life.
- **Fix**: on a Claude Code bump, re-run `p1168.ts`; diff claude-agent-acp's spawn of `claude` (its `env` option) and
  Claude Code's settings schema (`availableModels`, `apiKeyHelper`, `modelOverrides`).

### U76. OpenCode on Model endpoints through the model relay (SPI-1169)

Ranked after U75, which it parallels: a break fails OpenCode turns on endpoints, sends the model handle somewhere
other than the relay, or puts it in the environment of OpenCode's shells, MCP servers or plugins. The Model proxy path
keeps its plugin branch. As for Codex and Claude Code, the handle is never out of reach of the Container's commands
(ADR-0016's SPI-1169 refinement): a shell can read setsid's `/proc/<pid>/environ`. What this entry guards is that no
other environment or file holds it, and that it goes into no request but the relay's.

- **Where**: `apps/environment/src/agents/acpProfiles.ts` (`opencodeConfig` with an `OpenCodeRelay`,
  `OPENCODE_PACKAGES`, `opencodeServes`, `OPENCODE_HANDLE_HOLDERS`), `provider/cli/opencodeEndpoints.ts`,
  `provider/cli/relayModels.ts`, `provider/cli/acpDriver.ts` (`resolveModelId`, the model list), the image's
  `opencode-key-plugin` (`index.js`, and `relay.js`, its pure guard) and `t3flare-opencode`. It leans on OpenCode 2.2.7
  in these ways:
  - **A base URL per provider, by package**: `@opencode/ai/providers/anthropic-compatible` appends `/messages` to a
    base URL holding `/v1`; `openai-compatible` appends `/chat/completions`, `openai-compatible-responses` `/responses`
    (measured in `test:docker` and on p1169).
  - **A configured provider's model is sent by its own id**: `t3flare-endpoint-<id>/<model>` reaches the wire as
    `<model>`; a model id holding `/` is the provider's model whole (split at the first `/`).
  - **Configuration precedence**: the system file (`/etc/opencode`) outranks a repository's for each key it sets, and
    a model's own `package` and `settings.baseURL` win over its provider's. So the profile pins both on every endpoint
    model; a repository's model-level ones for those models do nothing (`test:docker`). A model or variant the
    repository adds to an endpoint's provider is not pinned (the system file cannot remove it, and the configuration
    is applied after every plugin transform, so a plugin cannot either).
  - **The plugin API**: `ctx.provider.transform`'s `editor.update(id, …)` patches a provider by id, and applies when
    the configuration adds it (the configured providers are not in `editor.list()` when a plugin's transform runs);
    the plugin sets each endpoint provider's API key to a placeholder, without which `openai-compatible-responses`
    refuses to send ("provider authentication required"). `ctx.session.hook("http.request", …, { providerID })`
    gets each request as sent, after every setting (a variant's included) applies: the plugin puts the handle in the
    key header (`x-api-key` or `authorization`) only when the URL is the relay's for that provider's endpoint
    (`relay.js` `putHandle`). The relay never redirects (it answers 502, `modelRelay.ts`), which matters because a
    cross-origin redirect would carry `x-api-key` (fetch strips only `authorization`). If the hook stops running, requests carry the placeholder and the relay answers 401
    (fails closed); if it starts running before a variant's settings apply, the URL check still holds.
  - **`opencode acp` runs its server as a child** (`opencode serve --stdio`), where plugins run. The launcher starts
    `opencode acp` without the handle, and the plugin reads it from the launch chain's setsid (by its command line
    and the process's marker, `relay.js` `handleFrom`, walking up from the server's parent). A repository's
    `{env:T3FLARE_MODEL_HANDLE}` (OpenCode substitutes from `process.env`) finds nothing. This needs setsid to fork:
    `setsid --wait` forks only when its caller is a process-group leader and otherwise execs in place
    (`packages/computer-env/src/shell.ts`, `sandbox-image/src/process.ts`), leaving no process with the handle and
    every turn a 401 (fails closed). It forks today; `test:docker` cannot catch a platform change here (its bash is
    PID 1, always a leader), only `p1169.ts` on a stage can. `HOLDER_CMDLINE` (`relay.js`) and
    `OPENCODE_HANDLE_HOLDERS` are literals tied to neither `processCommand`'s `setsid --wait` nor the profile's argv;
    a change there also fails closed, caught only by `test:docker` and p1169.
  - **The plugin trusts the profile's copy of the configuration** (`/var/lib/t3flare/cli/<marker>/opencode.json`) for
    which providers are the relay's: a provider is one only with an endpoint provider id, one of the three packages,
    and the relay's base URL for that endpoint (`relayProviders`, tested in `opencodeKeyPlugin.test.ts`). The process
    command (`@t3flare/sandbox-image/process`) makes the home fresh (`rm -rf`, `mkdir -m 700`) and writes the file
    `0600`, root's; the launcher installs the same file as `/etc/opencode/opencode.json` (`0644`). Every process in
    the Container is root, so a command can rewrite either. That gains it nothing it lacks: the handle still goes only
    to the relay's URL for an endpoint of the process's handle, and a root command can read setsid's environment anyway.
  - **OpenCode watches `/etc/opencode` and reloads it live** (its config watcher; read in the source, not measured
    here). The file is the Container's: a newer OpenCode spawn's configuration reaches running processes. A provider
    the running process's plugin did not see at its start gets no placeholder, then the hook gives it no handle
    (fails closed); an Environment whose endpoints change while OpenCode processes run can break them until their next
    process. **Silent**: nothing tests the live reload; **Detection**: a 401 on a running OpenCode process right after
    another OpenCode spawn in the same Container.
  - **The session offers only the allowed providers' models** (and models a repository adds to them): t3's adapter
    refuses any other model (an endpoint's that is gone) before any request, as for Claude Code (U75). A proxy-era
    model (`anthropic/<id>`) is named as the default model (`opencodeModelId`, SPI-1176).
  - **t3's registry replaces a ready OpenCode snapshot's models** (`ProviderRegistry.ts`
    `shouldRetainMissingProviderModels`, which patch 0006 makes false for `opencode` since SPI-1176, U66), so a model
    that left the endpoints leaves OpenCode's picker.
- **Breaks when**: OpenCode renames or reshapes a provider package or its path (the relay log shows the new path, the
  endpoint answers 404); drops or renames the `http.request` hook or its `request` (no handle: the relay answers 401);
  stops honouring the system file's model-level pins over a repository's (a repository moves an endpoint model, with
  its prompts, elsewhere; still without the handle); runs a plugin in a process that is not a child of `opencode acp`
  under the launch chain's setsid (no handle: 401); starts writing provider settings back to a file (the placeholder
  on disk, not the handle); or starts requiring a header the allowlist drops (the relay log's `dropped` names it;
  p1169's list is in `docs/steps/spi-1169/p1169.json`).
- **Detection**: `test/acpProfiles.test.ts` (the configuration and its pins, against the pinned schema),
  `test/opencodeEndpoints.test.ts`, `test/opencodeSpawn.test.ts`, `test/opencodeKeyPlugin.test.ts` (the plugin's
  provider guard, its request guard, where it reads the handle, and its constants against their TypeScript sources);
  `test/docker/opencodeRelay.docker.test.ts` in `test:docker` (the real launcher and plugin: each API's path and key
  header, a switch across three endpoints in one session, a hostile repository configuration (model-level `baseURL`
  and `package`, an added model with `{env:T3FLARE_MODEL_HANDLE}`, an added variant with its own `baseURL`) sending
  no handle anywhere but the relay, a shell's, a repository MCP server's and a repository plugin's environment, the
  processes holding the handle); `scripts/p1169.ts` on a stage. **Silent**: the handle reaching a shell's environment
  between `test:docker` runs; a new dropped header OpenCode needs for a feature but not for a turn; the profile's copy
  or `/etc/opencode` rewritten by a command in the Container (by design: such a command can read the handle already).
  Not detectable, by design: a command reading setsid's `/proc/<pid>/environ` (the residual).
- **Blast radius**: OpenCode turns on endpoints fail; or the model handle in the environment of OpenCode's shells, or
  in a request to a URL a repository chose. Either way spending stays bounded to the process's endpoints and life,
  and from inside the Container only (the relay is the Container's egress host).
- **Fix**: on an OpenCode bump, refresh the schema fixture, re-run `opencodeRelay.docker.test.ts` and `p1169.ts`, and
  diff the provider packages' paths, the plugin API (`provider.transform`, `editor.update`, `session.hook`'s
  `http.request`) and the configuration's precedence for model-level settings.

### U77. Sign-ins on pi-ai: ChatGPT plan usage's request rules and the Credential broker (SPI-1164)

Ranked after U76: a break fails turns on a sign-in endpoint (ChatGPT plan usage), which is unverified against OpenAI
anyway, or loosens how its tokens are held. Nothing here reaches t3; the leans are on pi-ai 1.5.0 and on OpenAI's docs.

- **Where**: `apps/agents/src/session/planUsage.ts` (`planUsagePayload`, `PLAN_USAGE_REFUSED_FIELDS`, `PLAN_USAGE_COMPAT`),
  `session/models.ts` (`SIGN_IN_REQUESTS`, `signInProvider`: the payload rules through pi-ai's `onPayload`, the compat
  overrides on the sign-in endpoint's models), `apps/environment/src/credentials/broker.ts` (pi-ai's `CredentialStore`
  types, re-exported from `@t3flare/models/endpoints`), `credentials/chatgpt.ts` (OpenAI's endpoints and codes). It leans
  on pi-ai 1.5.0 and OpenAI in these ways:
  - **pi-ai's own plan-usage handling is not reached.** pi-ai's `openai-responses` drops `max_output_tokens`,
    `temperature`, `prompt_cache_retention` and `prompt_cache_options`, and makes no `configuration_update` items, only
    when `isChatGPTSignIn(model, apiKey)` holds: provider `openai`, base URL `https://api.openai.com/v1`, a key not
    starting `sk-`. A sign-in endpoint's provider is its own id, so `planUsagePayload` restates that scrubbing (and OpenAI's
    longer list of refused fields, `system` items as `developer`, no `configuration_update` items, no `tool_search`
    tool), and `PLAN_USAGE_COMPAT` turns off `supportsMidConvoEffort` (so the thinking level goes as
    `reasoning.effort`, not pinned to medium with `configuration_update` items) and `supportsToolSearch`.
  - **`onPayload` and `fetch` in a provider's stream options** (`ProviderRequestOptions`), as the Session's recording
    fetch already leans on (SPI-1162).
  - **The tool form.** For catalog models with `supportsAdditionalTools` (gpt-5.6 and gpt-6 families) pi-ai sends tools
    as an `additional_tools` input item, OpenAI's documented form for plan usage; older or unknown models get flat
    `function` tools, which OpenAI's preview page does not list as supported.
  - **pi-ai's `CredentialStore` interface** (`read`, `list`, `modify`, `delete`): the broker implements its types only;
    nothing calls pi-ai's `refreshStoredOAuthCredential` (the broker renews under its own lock).
  - **OpenAI's flow** (developers.openai.com/siwc/token-sharing-open-source, read 2026-11-16): the authorize and token
    URLs, the loopback redirect's shape, the refresh-ending codes, discovery's `revocation_endpoint`, `/v1/models`'s
    `models[].slug` shape.
- **Breaks when**: pi-ai renames `onPayload`, changes `configuration_update` or `additional_tools` handling, adds a
  request field plan usage refuses, or changes `getCompat`'s keys (`supportsMidConvoEffort`, `supportsToolSearch`);
  OpenAI changes its refused fields, its tool form, or its OAuth endpoints and codes.
- **Detection**: `apps/agents/test/sessionSignIn.test.ts` (the body on the wire, a reasoning catalog model's effort with no
  `configuration_update` item and its `additional_tools`, every refused field absent), `endpointText.test.ts`'s sign-in
  case, `apps/environment/test/chatgptSignIn.test.ts` and `credentialBroker.test.ts` (against a fake of OpenAI's
  server). **Silent**: a change on OpenAI's side (the fake is ours; only a real Plus or Pro sign-in would see it), a new
  pi-ai field plan usage refuses (the test lists ours, not pi-ai's).
- **Blast radius**: a ChatGPT turn refused by OpenAI (400 `subscription_sharing_unsupported_capability`, shown as a model
  error), or its thinking level ignored. No token leaves the Session or the broker either way.
- **Fix**: on a pi-ai bump, diff `api/openai-responses.js` (`isChatGPTSignIn`, `buildParams`, `getConfigurationUpdateEffort`)
  and `openai-responses-shared.js` (`additional_tools`) against `planUsage.ts`; on an OpenAI change, its "Preview
  limitations" and "Errors and recovery" pages.

### U78. pi on Model endpoints through the model relay (SPI-1170)

Ranked after U76, which it parallels: a break fails pi turns on endpoints, or puts the model handle in the environment
of pi's shells. (The Model proxy's `models.json` went at the hard cut, SPI-1176: a launch without an endpoint is refused.) As for the other CLIs, the handle is never out
of reach of the Container's commands (ADR-0016's SPI-1170 refinement): a command pi's bash tool runs can run the
handle command or read setsid's `/proc/<pid>/environ`. What this entry guards is that no other environment or file
holds it, and that it goes into no request but the relay's.

- **Where**: `apps/environment/src/agents/cliProfiles.ts` (`piRelayModelsJson`, `piRelaySettings`, `PI_HANDLE_COMMAND`,
  `PI_HANDLE_HOLDERS`), `provider/cli/piEndpoints.ts` (the endpoints, the list, the RPC line maps),
  `agents/cliProcess.ts` (`handleOf`'s `LineMaps`), `provider/cli/piDriver.ts`, and the image's `t3flare-pi` and
  `t3flare-pi-handle`. It leans on pi 1.5.2 (`@earendil-works/pi-coding-agent`, its bundled pi-ai) and on t3's Pi
  adapter (`t3code/packages/provider-pi/src/server/adapter.ts`, `rpc.ts`) in these ways:
  - **Which endpoints**: the relay's (`relayedEndpoints`, no sign-in until SPI-1171) that list a model (`piServes`).
  - **`models.json` from the agent directory alone** (`dist/core/model-runtime.js` `ModelRuntime.create`,
    `agent-session-services.js`): a provider's `baseUrl`, `api` and `apiKey`, and a model's own `baseUrl` and `api`,
    which win (`provider-composer.js` `modelFromJson`). No project `models.json`; a repository's `.pi/extensions`,
    `.pi/settings.json` (`extensions`, `packages`) load only under project trust, off here (`test:docker`'s hostile
    `.pi/`). An extension's `registerProvider` would win over `models.json`: only t3's extension is passed.
  - **An API key's `!command` runs per request, uncached** (`provider-composer.js` `composeApiKeyAuth`'s `resolve` →
    `resolve-config-value.js` `resolveConfigValueUncached`; `model-runtime.js` `prepareRequest`), with pi's
    environment, through `/bin/sh`, its stdout trimmed; the availability check does not run it. A failing command
    fails the request ("Failed to resolve API key … from shell command").
  - **pi-ai's paths and key headers by API**: the relay URL plus `/v1/messages` (`x-api-key`; a key holding
    `sk-ant-oat` would go as a Bearer), `/responses` and `/chat/completions` (Bearer), `/models/<model>:streamGenerateContent`
    (`x-goog-api-key`), `/v1/chat/completions` for Mistral (Bearer); each in the relay's `KEY_HEADERS`.
  - **pi's RPC names a model as `{ provider, modelId }`**: t3's adapter sends `set_model` with the slug split at its
    first `/` (or the pair pi reported), and reads `provider` in responses (`get_available_models`, `get_state`,
    `set_model`) and in `message_end`'s message. `piLineToPi` and `piLineFromPi` map exactly these. pi's session files
    keep its own ids (`t3flare-endpoint-<id>`), so a session resumes in a new process (`switch_session`).
  - **The launch chain**: `setsid --wait /opt/t3flare/bin/pi --mode rpc …` → the launcher → `env -u
    T3FLARE_MODEL_HANDLE` → Node running pi (which titles itself `pi`). The handle command walks up its own ancestry
    to the first process whose command line starts `setsid --wait /opt/t3flare/bin/pi` and checks its marker. This
    needs setsid to fork, as U76 says (`setsid --wait` forks only when its caller is a process-group leader; otherwise
    no process holds the handle and every request fails closed). `test:docker`'s setsid is PID 1, which the walk
    includes.
  - **pi's HTTP client honours the proxy variables** (`dist/core/http-dispatcher.js`: undici's `EnvHttpProxyAgent`,
    which reads `no_proxy` before `NO_PROXY`, with `proxyTunnel: true`). An owner's `HTTP_PROXY` Variable reaches pi's
    environment, so the launcher adds the relay's host (`computer.internal`) to both no-proxy variables, each keeping its
    own entries, and leaves `*` as it is (`piHandleCommand.test.ts` pins the cases); `test:docker` sets the proxy and
    sees no CONNECT. If pi changes its client or how it reads them, the relay's request, with the
    handle, may go through the owner's proxy (`test:docker`'s proxy check fails).
  - **PATH**: the launcher and the handle command name every program by its absolute path (`/usr/bin/env`, `tr`,
    `head`, `sed`, `cut`, `grep`); they need those paths in the image (merged `/usr`; Ubuntu's uutils and Debian's
    coreutils both have them). `test:docker` puts hostile ones first on PATH. The handle command takes only a process
    marker's shape (`isProcessMarker`), so a marker holding a newline cannot match another line of the holder's
    environment. Since SPI-1209 the process command that starts every CLI process (`processCommand`) and its shell
    (`PROCESS_SHELL`) name theirs by absolute path too, keeping setsid's name in argv (`exec -a setsid`), so the
    holder's command line is still `setsid --wait /opt/t3flare/bin/pi …` (ADR-0016 item 7).
  - **t3's registry replaces a pi snapshot's models** (`ProviderRegistry.ts` `shouldRetainMissingProviderModels`, which
    patch 0006 makes false for `pi` since SPI-1176, U66; stock t3 keeps them while pi's auth is `unknown`, as in the
    setup state), so a model that left the endpoints leaves the picker.
  - **A stale proxy model** (`anthropic/<id>`) would name pi's built-in `anthropic` provider, which has no key here:
    since SPI-1176 the channel's `piLineToPi` names the default model's provider and id in a `set_model` of
    `anthropic` instead (t3's Pi adapter sends a slug as `{ provider, modelId }`, `resolvePiModelSlug`).
- **Breaks when**: pi starts caching a command's key, or resolving it before a request (harmless while the handle is
  fixed for the process's life), or stops running it (no key: every request fails); pi reads a `models.json` or
  provider settings from a project without trust, or lets `modelOverrides` set a `baseUrl` (a repository could move an
  endpoint's provider with the handle: the hostile `.pi/` in `test:docker` would see it); pi-ai changes an API's path
  or key header (the relay log shows the new path, or the relay answers 401 for a header it does not read); pi adds an
  RPC field carrying a provider that t3 reads (t3 shows `t3flare-endpoint-<id>/…` there; the turn still runs) or a
  command naming a model that is not `set_model` (pi gets t3's endpoint id as a provider: "Model not found"); the
  launcher loses its `env -u` (the handle reaches pi's environment and its shells': `test:docker` fails); a CLI header the allowlist drops becomes
  required (the relay log's `dropped` names it; p1170's list is in `docs/steps/spi-1170/p1170.json`).
- **Detection**: `test/cliProfiles.test.ts` (the relay cases), `test/piEndpoints.test.ts`, `test/piSpawn.test.ts`,
  `test/piDriver.test.ts`,
  `test/piHandleCommand.test.ts` (the launcher and the handle command against `MODEL_HANDLE_ENV`, `PI_HANDLE_HOLDERS`,
  `HANDLE`, both Dockerfiles); `test/docker/piRelay.docker.test.ts` in `test:docker` (five APIs' paths and key
  headers, a switch across them in one session with pi's bash tool, a stale proxy model, a hostile repository `.pi/`,
  a bash command's environment, the holders, a resume in a new process with a new handle, hostile programs on PATH, a
  proxy Variable, pi's real RPC lines mapped, the handle command's refusals); `scripts/p1170.ts` on a
  stage. **Silent**: the handle reaching a shell's environment between `test:docker` runs; a new RPC provider field
  t3 reads (cosmetic); a new dropped header pi needs for a feature but not for a turn. Not detectable, by design: a
  command reading setsid's `/proc/<pid>/environ` or running the handle command (the residual).
- **Blast radius**: pi turns on endpoints fail; or the model handle in the environment of pi's shells. Either way
  spending stays bounded to the process's endpoints and life, and from inside the Container only.
- **Fix**: on a pi bump, re-read `resolve-config-value.js`, `provider-composer.js` and `model-runtime.js` for the
  key's resolution and the `baseUrl`'s sources, pi's `docs/models.md`, `docs/rpc.md` and `docs/security.md`; re-run
  `piRelay.docker.test.ts` and `p1170.ts`.

### U79. The Usage page from t3flare's own usage records (SPI-1173)

Ranked after U78: a break leaves the Usage page short or wrong (costs, attribution), never a turn. The relay's reader
is a pass-through observer: a vendor change that it cannot read loses records, and the answer still reaches the CLI.

- **Where**: the records (`@t3flare/models/usage`: `UsageEntry`, `usageEntryOf`, `usageOfPiAnswer`, `tokensOf`); the
  Session's and text generation's hook on every endpoint provider's answer (`apps/agents/src/session/models.ts`
  `answering`, the `answered` access field; `session/endpoints.ts`, `endpointText.ts`); the relay's reader
  (`workspace/relayUsage.ts`, wired in `modelRelay.ts` and `workspaceProxy.ts`); the one sender all three use
  (`environment.ts` `usageSender`); the Environment's `recordUsage` RPC (`usage/records.ts` `acceptUsage`), its
  store (`usage/records.ts`) and the scan readers (`usage/readers.ts` `usageReader`, in the Shadow's
  `BUILT_IN_USAGE_DRIVERS`, U11).
- **Every endpoint, counted once, ours**: every endpoint, Commissary's included, is counted from our own records only.
- It leans on:
  - **pi-ai's answers**: an `AssistantMessageEventStream`'s `result()` resolves with the final message (an error's
    too), whose `usage` is `input` (uncached), `cacheRead`, `cacheWrite`, `output`, `reasoning` (a part of `output`)
    and `cost.total` (pi-ai 1.5.0, `dist/types.d.ts` `Usage`; `dist/utils/event-stream.js`).
  - **The vendors' usage fields** (`relayUsage.ts`'s header lists them by API): Anthropic's `message_start` and
    `message_delta` usage (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`);
    OpenAI Responses' `response.*` events' `response.usage` (`input_tokens` with `input_tokens_details.cached_tokens`
    inside it, `output_tokens_details.reasoning_tokens`); Chat Completions' last chunk's `usage` (`prompt_tokens`,
    `prompt_tokens_details.cached_tokens`, `completion_tokens`); Google's `usageMetadata` (`promptTokenCount`,
    `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, apart from the candidates) and
    `modelVersion`; Mistral's `conversation.response.done` usage. Only `data:` lines holding `"usage` or `"model` are
    parsed; a line or body over 4 MiB stops the reading. A stream the CLI cancels, or that fails, is recorded with what
    was read (Anthropic's input is in its first event); a cut JSON body is not.
  - **The CLIs ask for Chat Completions' usage**: a stream carries it only when the request has
    `stream_options.include_usage`. pi asks (pi-ai `dist/api/openai-completions.js:568`, unless a model's compat sets
    `supportsUsageInStreaming: false`); OpenCode 2.2.7 asks (`packages/ai/src/protocols/openai-chat.ts:900`, unless a
    model sets `streamUsage: false`, which our system configuration does not). Codex and Claude Code do not speak it.
    The relay adds nothing to a request: a CLI that stops asking leaves its Chat Completions requests unrecorded.
  - **t3's usage service**: `ProviderUsageReader`'s `scan` kind and `UsageRecord`'s fields
    (`provider-core/src/server/usage.ts`), `rateModel` priced by the rate table when `reportedCostUsd` is null
    (`usagePricing.ts` `recordRate`, `priceUsage`), and a bucket per source path (`usageAggregation.ts`
    `#placeInWindow`, `UsageService.ts` `aggregator.add(record, dir)`); `UsageProviderKind`'s `pi`, `codex`, `claude`,
    `opencode`. The retention (92 days) is t3's `CACHE_RETENTION_DAYS`, restated. t3's record counts are our rows (a
    quarter hour of one session on one model), not requests; showing requests would need a Patch, so it is left.
- **Breaks when**: pi-ai renames a usage field or stops resolving `result()` for a failed answer (no records from
  Sessions or text generation, or from failed answers only); a vendor moves its usage (a CLI's records stop, or count
  0: the reader keeps the last value it saw, so a moved cache count shows as uncached input); a CLI stops asking for
  Chat Completions' usage (above); t3 renames `UsageRecord` fields, drops `rateModel`, or changes how the scan kind's
  sources are bucketed (typecheck, or the page loses the split by source); t3 changes its retention (ours stays 92
  days).
- **Detection**: typecheck (`UsageRecord`, `ProviderUsageScan`, pi-ai's `AssistantMessage`; and the `usage` options of
  `SessionEndpoints`, `generateEndpointText` and `handleModelRelay` are required, so a recorder left unwired does not
  build); `relayUsage.test.ts` (each API's shapes, a broken stream, a failed answer holding usage, the 4 MiB cap, a
  cancelled and a failed stream (under Node; on workerd see the report's Unproven), a throwing record), `sessionUsage.test.ts` (pi-ai's answer through a Session's
  endpoint provider and text generation; `usageSender`), `usageRecords.test.ts` (the rollup and its quarter hour, the
  split, a dated model, t3's aggregator pricing an unpriced model, retention, the row cap and the hourly prune, a
  failed source, the stale and future guards, the read window's floor, and `acceptUsage` as the RPC runs it, every endpoint counted once), `usagePage.test.ts` (t3's `UsageService` over the
  Shadow). **Silent**: a vendor's new usage shape (records stop for that API; the relay still answers). Cheapest check:
  a turn per agent on a stage (`scripts/p1176.ts` runs one each), then t3's Usage page.
- **Blast radius**: the Usage page undercounts an agent or an API, or misprices a model. Never a turn, never a key: a record holds counts, names and a time.
- **Fix**: on a pi-ai bump, re-read `Usage` in `dist/types.d.ts` and `openai-completions.js`'s `stream_options`; on an
  OpenCode bump, `openai-chat.ts`'s; on a vendor's change, add its shape to `relayUsage.ts` with a recorded answer in
  `relayUsage.test.ts`; on a t3 bump, diff `provider-core/src/server/usage.ts`, `UsageService.ts` and
  `usageAggregation.ts`.
### U80. Usage limits and refused credentials, classified per API (SPI-1172)

Ranked after U79: a break shows a usage limit as a plain model error (no pause, no auto-resume) or retries what cannot
succeed; nothing in t3 is touched. The leans are on the vendors' error shapes, on pi-ai 1.5.0 and pi-durable 1.5.0.

- **Where**: `packages/models/src/failures.ts` (`ROWS`, `KINDS`, `read`), `packages/models/src/redact.ts` (`SHAPES`),
  `apps/agents/src/session/modelLimits.ts` (`proxyLimits.ts` until SPI-1176; `recordingFetch`'s `failureHeaders`/`errorBodyOf`, `classifyEndpoint`, the
  vendor-shaped `faultAnswer` cases), `endpointText.ts`, `workspace/modelRelay.ts` and `relayFailures.ts` (an error
  answer's redacted body, a stream's error events, the process's last answer), the differ's `endpointFailureOf`, and
  the CLI wrapper's `relayedEvent` with `provider/cli/relayFailure.ts`. It leans on:
  - **The vendors' error shapes** (packages/models/test/fixtures/vendors.json, each with its source, read 2026-11-16):
    Anthropic's `error.type`, `error.details.error_code` (`enforced_spend_limit_reached`) and `retry-after`; OpenAI's
    `error.type`/`error.code` (`insufficient_quota`, `credit_balance_exhausted`, the spend-limit codes,
    `server_is_overloaded`) and `x-ratelimit-reset-*` Go durations; ChatGPT's Codex backend's `usage_limit_reached` with
    `resets_at` (codex-rs `api_bridge.rs`); plan usage's `subscription_sharing_*` codes and `{detail}` admission bodies.
  - **Anthropic's unified limit headers**, which Anthropic does not document: `anthropic-ratelimit-unified-status:
    rejected` and `anthropic-ratelimit-unified-reset` in epoch seconds, as Claude Code 2.1.325's client reads them.
  - **pi-ai's error text** for an error inside a stream: the Responses `response.failed` event as `<code>: <message>`
    and an `error` event as `Error Code <code>: …` (`openai-responses-shared.js`); Anthropic's as the JSON body.
  - **pi-ai's retry patterns** (`utils/retry.js`): a stopped failure's text names its class, never its code (`rate_limited`
    would match `rate.?limit`), so it matches none; a retried code's text is worded to match one (`overloaded`, `server
    error`, `rate limit`, `service unavailable`); pi-durable's `afterResponse` hook and `AssistantMessage.provider` (the
    endpoint's id), as U24 and step 2a part 2 already lean on.
  - **pi-durable's default retries** (`DEFAULT_RETRY_POLICY`: 3, from 2 s doubling, pi-ai's `retryDelayMs`): a rate
    limit resetting within their 14 s (`SHORT_RESET_MS`) is retried, a later one pauses at once.
  - **t3's adapter events** (U3): a failed `turn.terminal` and an `error` turn item carry `failure`, which the CLI
    wrapper replaces; a failure t3 raises outside the adapter's events (a session that fails to open) is not seen.
  - **The vendors' stream error events** (`relayFailures.ts`' `sseErrors`): Anthropic's `{"type":"error","error":{…}}`,
    OpenAI Responses' `error` and `response.failed`, an OpenAI-compatible Completions chunk that is only
    `{"error":{…}}`, Mistral Conversations' `conversation.response.error`, in a `text/event-stream` that passes on as it
    comes. A `data:` line is held only while its opening, whitespace taken out, could still be one of these. The leans:
    the event's `type` (or a Completions chunk's `error`) is its first key, as every vendor sends it, so an error
    event that names another key first passes unredacted and unreported; and an event split over several `data:`
    lines, or a stream ending its lines with a bare `\r`, passes the same way. No vendor sends either.
  - **One relay record per CLI process, for its turn** (`RelayFailures`). A CLI's requests are not all its turn's own (a
    title or summary on a small model), so a success clears only a passing failure and a passing failure never hides a
    stop. Residual: a background request's stop during the turn (its own usage limit) becomes the turn's failure; a stop
    the CLI later got past (its own retry after a short reset) stays until the turn ends; the record is in the Workspace
    DO's memory, gone after a restart.
- **Breaks when**: a vendor renames a code or moves a reset (Anthropic documents its unified headers, or changes them);
  pi-ai changes its stream error text or adds a retry pattern a code matches; pi-ai stops passing a request's `fetch`.
- **Detection**: `apps/environment/test/modelFailures.test.ts` (each row on doc-shaped answers), `cliRelayFailure.test.ts`
  (t3's ACP adapter for Claude Code and OpenCode, stand-ins for Codex and pi),
  `apps/agents/test/endpointFailures.test.ts` (a real Harness: one request for a limit, four for an overload, every
  stopping code not retryable to pi-ai), `endpointText.test.ts`, `modelRelayRoute.test.ts`, `redactSecrets.test.ts`.
  **Silent**: a vendor-side change (the fixtures are the docs' shapes, not live answers); an unknown 429 then shows as
  `rate_limited` with no reset, retried by pi-durable, then a usage limit without auto-resume. A t3 change to which
  failures reach the adapter's events: `p1172.ts cli` on a stage shows it.
- **Blast radius**: a usage-limited thread fails without pausing or resuming, or a refused key is retried a few times
  before it fails; never a fallback to another endpoint, and no credential reaches t3 (the redaction is by shape).
- **Fix**: the vendor's error docs (sources in the fixture file), then a row in `ROWS`; on a pi-ai bump, diff
  `utils/retry.js` and `openai-responses-shared.js`'s error events.

### U81. The Claude sign-in on pi-ai: Claude Code's OAuth client and request shape (SPI-1165)

Ranked after U80, beside U77 (ChatGPT plan usage), which it parallels: a break fails every turn on a Claude sign-in
endpoint (Anthropic's disguised refusal is a 429 `rate_limit_error`, SPI-1161 Q4), or a sign-in. Nothing here reaches
t3; the leans are on pi-ai 1.5.0 and on Anthropic's undocumented OAuth for Claude Code, whose use outside Claude Code is
the owner's terms-of-service risk (ADR-0018 item 10).

- **Where**: `packages/models/src/claudeOAuth.ts` (Claude Code's client id, the authorize, token and copy-code redirect
  URLs, the scopes, the `sk-ant-oat` token mark), `apps/environment/src/credentials/claude.ts` (the start, the pasted
  `code#state`, the JSON exchange and refresh, what ends a sign-in at refresh, no revocation), `SIGN_IN_KINDS.claude`
  (`anthropic-messages` at `https://api.anthropic.com`, the model list's `anthropic-beta: oauth-2025-04-20`). It leans
  on pi-ai 1.5.0 and Anthropic in these ways:
  - **pi-ai's flow** (`dist/auth/oauth/anthropic.js`): `CLIENT_ID` (:11), `AUTHORIZE_URL` (:12), `TOKEN_URL` (:13),
    `COPY_CODE_REDIRECT_URI` (:20), `SCOPES` (:23), the authorize parameters (:174-183), the exchange's JSON body
    (:88-95) and the refresh's (:209-213). Ours departs on purpose: the attempt is sealed in the Environment DO, and the
    state is its own random value, not the verifier (pi-ai sends the verifier as the state).
  - **pi-ai's request shape for an OAuth token** (`dist/api/anthropic-messages.js`): `isOAuthToken` (:767, a key holding
    `sk-ant-oat`) switches `createClient` (:787-801) to Bearer auth with `user-agent: claude-cli/2.1.280` and `x-app:
    cli`, `getBetaFeatures` (:858) to `claude-code-20250219,oauth-2025-04-20`, `buildParams` (:911-926) to the identity
    "You are Claude Code, Anthropic's official CLI for Claude." as the system's first block, and the tools to Claude
    Code's names (`toClaudeCodeName`, :70). The requests go to `/v1/messages?beta=true`. t3flare adds nothing (no
    `SIGN_IN_REQUESTS` entry): the shape follows from the token, so the store refuses such a token as an API key, and
    the broker refuses a sign-in whose token lacks the mark.
  - **Anthropic** (the spike, SPI-1161): the token answer's fields (`access_token`, `refresh_token`, `expires_in` 28800,
    `scope`, `account.uuid`, `account.email_address`), a refresh token that rotates on every refresh and refuses a
    replaced one with `invalid_grant`, no revocation endpoint, and `GET /v1/models` with the bearer and the OAuth beta
    for the model list. A refresh refused at 400, 401 or 403 with an error object (an OAuth error or Anthropic's API
    error) but a passing code ends the sign-in; any other body is retried (ADR-0018 item 10, with its accepted cost).
- **Breaks when**: pi-ai changes Claude Code's client, URLs or scopes, the exchange or refresh body, the token mark, the
  headers, betas, user agent's version, identity text or tool names; Anthropic changes what it requires of an OAuth
  request (the identity, a beta, a newer Claude Code version), its token form or answer, its error bodies or the code
  page's alphabet, or adds a revocation endpoint.
- **Detection**: `apps/agents/test/claudeSignInShape.test.ts` runs pi-ai's own copy-code `login()` and `refresh()` and
  compares them with `claudeOAuth.ts`, and pins every header, the system blocks and a tool name on the wire (and their
  absence for an API key). `apps/environment/test/claudeSignIn.test.ts` and `claudeBroker.test.ts` run ours against a
  fake of Anthropic. **Silent**: anything on Anthropic's side, which only a real sign-in and turn see (the fake is
  ours).
- **Unverified until a real refresh runs**: whether Anthropic ends the replaced access token at a refresh. A Session
  keeps a token at most 5 minutes and never past 2 minutes before its expiry, and the broker renews with less than 5
  minutes left, so a Session may send the replaced access token for at most 3 minutes after a renewal. If Anthropic
  refuses it there, the request's 401 is SPI-1172's `sign_in_refused` (not retried) and the Session drops the token, so
  the next turn takes the renewed one; that turn fails once. The stage run ended before the 8-hour token's renewal.
- **Blast radius**: turns on the Claude endpoint fail (429 or 401, shown as model errors), or the sign-in fails; a lost
  rotation, or a refused refresh, signs the endpoint out (sign in again). No token leaves the Session or the broker
  either way.
- **Fix**: on a pi-ai bump, diff `auth/oauth/anthropic.js` against `claudeOAuth.ts` and `credentials/claude.ts`, and
  `api/anthropic-messages.js` (`isOAuthToken`, `createClient`, `getBetaFeatures`, `buildParams`) against the pins;
  update the pins only once a turn on a real Claude sign-in passes with the new shape.

### U82. The GitHub Copilot sign-in on pi-ai: the device flow, the Copilot token and its request shape (SPI-1166)

Ranked after U81, beside U77 and U81, which it parallels: a break fails every turn on a Copilot sign-in endpoint, or the
sign-in. Nothing here reaches t3; the leans are on pi-ai 1.5.0 and on GitHub's undocumented Copilot token endpoint and
API, used with the Copilot editor's public client, whose use outside GitHub's editors is the owner's terms-of-service
risk (ADR-0018 item 11).

- **Where**: `packages/models/src/copilotOAuth.ts` (the client id, the device flow's and Copilot token's URLs, the
  scope, the editor headers, the model list's API version, `copilotBaseUrl`),
  `apps/environment/src/credentials/copilot.ts` (the start, the poll and its interval, the Copilot token, what ends a
  sign-in at renewal, no revocation, `use`), `credentials/broker.ts` (`SignInVendor.use`: the base URL and headers given
  with each token), `endpoints/discover.ts` (`copilotModels`, for a Copilot sign-in only), `known.ts` (Copilot's
  catalog, for its own host only), `apps/agents/src/session/copilot.ts` and `session/models.ts`
  (`SIGN_IN_REQUESTS.copilot`; the credential's base URL and headers taken only when its kind's `credentialBaseUrl`,
  `COPILOT_BASE_URL`, matches it), `SIGN_IN_KINDS.copilot`. It leans on pi-ai 1.5.0 and GitHub in these ways:
  - **pi-ai's flow** (`dist/auth/oauth/github-copilot.js`): `CLIENT_ID` (:9), `COPILOT_HEADERS` (:10-15),
    `COPILOT_API_VERSION` (:16), `getUrls` (:29-35), `getBaseUrlFromToken` (:41-49) and `getGitHubCopilotBaseUrl`
    (:50-61), the model list's rules (`parseGitHubCopilotModelCatalog`, :65-100), the device code request (:155-196),
    the poll (:197-236, with `device-code.js`'s interval and `slow_down` rules), the Copilot token (:237-263). Ours
    departs on purpose: the attempt is sealed in the Environment DO and polled once per panel ask, the token's real
    expiry is kept, no model policy is switched on, a token naming a host outside `githubcopilot.com` is not used, and
    github.com only (no Enterprise domain).
  - **pi-ai's request shape for its `github-copilot` provider** (`dist/api/openai-responses.js`): the dynamic headers
    (:210-217, `github-copilot-headers.js`'s `buildCopilotDynamicHeaders`, which the Session imports), and no
    thinking-off `reasoning` (:297). Both key on `model.provider === "github-copilot"`, which a sign-in endpoint's
    provider (its own id) is not, so the Session restates them; the editor headers are on every model of pi-ai's Copilot
    catalog (`model.headers`), which a sign-in endpoint's models lack, so the broker gives them with the token.
  - **GitHub** (docs.github.com, "Device flow"; the rest undocumented, as pi-ai and the spike saw it): the poll answered
    200 with `authorization_pending`, `slow_down` (with `interval`), `expired_token`, `access_denied`; the Copilot token
    (`token` holding `proxy-ep=`, `expires_at` in epoch seconds); its refusals as GitHub API errors (`{ message }`,
    `error_details.notification_id`, e.g. `subscription_ended`, SPI-1161); rate limits as 403 or 429 with `retry-after`
    or `x-ratelimit-remaining: 0`, or a 403 whose message names a rate limit, too many requests or too many login
    attempts (a secondary limit; another wording would read as a refusal and sign out), each waited out (`retry-after`,
    else `x-ratelimit-reset`, else a minute; at most 15) before the next renewal; `/models`' `model_picker_enabled`,
    `policy.state`, `capabilities`, `supported_endpoints`. No revocation for a public client.
- **Breaks when**: pi-ai changes the client, URLs, scope, editor headers or their versions, the API version, the base
  URL's derivation, the dynamic headers, or its Copilot reasoning rule; pi-ai keys the Copilot shape on something a
  sign-in endpoint has (a double header), or moves `buildCopilotDynamicHeaders`; GitHub changes the token endpoint, its
  answer or error bodies, the hosts it names, what it requires of a request (a newer editor version), or the model
  list's fields; Copilot drops a model from its Responses API.
- **Detection**: `apps/agents/test/copilotSignInShape.test.ts` runs pi-ai's own `login()`, `refresh()` and `toAuth()`
  and compares them with `copilotOAuth.ts`, checks the catalog's headers, and compares a request on a Copilot sign-in
  endpoint with pi-ai's own provider's, URL, every header and body (thinking off and on, from the owner and after a tool
  call, a model with an "off" effort). `apps/environment/test/copilotSignIn.test.ts`, `copilotBroker.test.ts` and
  `endpointsSignIn.test.ts` run ours against a fake of GitHub (`fixtures/fakeGitHubCopilot.ts`);
  `endpointDiscover.test.ts` reads Copilot's catalog. **Silent**: anything on GitHub's side, which only a real sign-in
  and turn see (the fake is ours); a model Copilot moves to another API (a turn on it fails with a 400 or 404).
- **Unverified until a sign-in with a Copilot plan runs**: on p1166 the device flow ran from the Worker (the device
  code, a poll, the owner's approval, the GitHub token), but the owner's Copilot subscription had ended and GitHub
  refused the Copilot token (403 `subscription_ended`), so no Copilot token, model list or turn was seen. Whether
  Copilot's API accepts these requests from a Worker's egress, and what GitHub answers for a revoked grant, are not
  known (SPI-1226).
- **Blast radius**: turns on the Copilot endpoint fail (shown as model errors, or `sign_in_refused` for a 401 or 403),
  or the sign-in fails; a refused renewal signs the endpoint out (sign in again). No token leaves the Session or the
  broker either way, and the GitHub token never leaves the broker.
- **Fix**: on a pi-ai bump, diff `auth/oauth/github-copilot.js` against `copilotOAuth.ts` and `credentials/copilot.ts`,
  `api/openai-responses.js` and `api/github-copilot-headers.js` against `session/copilot.ts`; update the pins only once
  a turn on a real Copilot sign-in passes with the new shape.

### U83. Subscription sign-ins through the model relay: each CLI's request on a vendor's subscription shape (SPI-1171)

Ranked after U82, beside U75, U76, U78 and U81, which it joins: a break fails a CLI's turns on a sign-in endpoint (or
gets them refused by the vendor), never an API-key endpoint's. Nothing here reaches t3; the leans are on pi-ai 1.5.0's
subscription shapes, restated at the relay for requests pi-ai did not build, and on what each CLI puts in its request.
**None of it ran against a vendor** (owner decision, 2026-11-16: no live sign-in on p1171).

- **Where**: `apps/agents/src/workspace/relaySignIns.ts` (`signInRequest`, `signInRefusal`), `modelRelay.ts` (a sign-in's
  body read whole, the rules applied, the token's short id logged), agents' `session/signInRequests.ts` (the `relay`
  parts), `session/claudeSignIn.ts`, `session/copilot.ts` (`copilotRelayHeaders`), `packages/models/src/claudeOAuth.ts`
  (`CLAUDE_CODE_IDENTITY`, `CLAUDE_OAUTH_BETAS`, `CLAUDE_OAUTH_HEADERS`), `@t3flare/models/relay` (`RELAYED_SIGN_INS`,
  `credentialHeaderFor`, `relayTargetOf`, `SIGN_IN_RELAY_PATHS`, `signInRelayAllows`). It leans on:
  - **pi-ai's Claude subscription shape** (U81's pins), restated for a CLI's API-key-shaped request: Bearer auth, Claude Code's
    betas before the CLI's, `user-agent: claude-cli/2.1.280`, `x-app: cli`, and the identity as the system's first
    block unless a block already opens with it (Claude Code's own requests carry it, SPI-1161 Q4). **Not restated:**
    pi-ai's Claude Code tool names (`bash` → `Bash`); OpenCode's and pi's tools go under their own names.
  - **pi-ai's Copilot dynamic headers** (U82), from a Responses body's `input` read as pi-ai's messages: the last item
    a `user` message is `X-Initiator: user`, anything else `agent`; an `input_image` in a user message or a
    `function_call_output` is vision.
  - **ChatGPT plan usage's rules** (U77's `planUsagePayload`) on bodies the CLIs build: Codex's (`client_metadata`,
    `include`, `prompt_cache_key`, flat `function` tools), OpenCode's AI SDK Responses package's, pi's. Plan usage's
    preview page wants function tools in namespaces or `additional_tools`; Codex and OpenCode send them flat.
  - **The paths each CLI calls** on a sign-in (`SIGN_IN_RELAY_PATHS`): a POST to `/v1/messages` (and Claude Code's
    `/v1/messages/count_tokens`) on Claude, to `/responses` on ChatGPT and Copilot, as written. Taken from the paths the
    CLIs build on their base URL (SPI-1168–1170's reports and `test:docker`'s stand-in) and Codex 0.167.2's source
    (compaction v2 streams over `/responses`; no model list from our base URL). The allowlist has not run on a stage.
    Anything else is refused (404, logged with its method and path) so the token reaches no other vendor call.
- **Breaks when**: a future CLI version calls another path on a sign-in (a model list, a compaction or token-count
  endpoint of its own): it gets 404 and the relay's log names the method and path; Anthropic refuses a subscription request whose tools are not Claude Code's names, or wants more of a
  non-Claude-Code client; Claude Code stops putting the identity in its system blocks; a CLI's Responses body carries a
  field plan usage refuses that `PLAN_USAGE_REFUSED_FIELDS` does not drop, or flat tools are refused; Copilot reads
  another header, or pi-ai changes `inferCopilotInitiator`; a pi-ai bump changes U81's or U82's shapes.
- **Detection**: `apps/agents/test/modelRelaySignIns.test.ts` "refuses every path but the sign-in's inference calls…" and
  "carries each sign-in's inference calls" pin `signInRelayAllows` (paths, POST only, no case folding, per kind); it also compares the relay's output for pi-ai's own API-key request
  with pi-ai's own request on the subscription's token (URL, headers, betas, system), checks plan usage's rules against the Session's
  `planUsagePayload`, and Copilot's headers; `claudeSignInShape.test.ts` pins the Claude constants to pi-ai's wire.
  **Silent**: everything on the vendor's side (a disguised 429 from Anthropic, a 400 from plan usage, Copilot's
  refusals), which only a live turn on a subscription sees: none has run (SPI-1226 for Copilot).
- **Blast radius**: turns of a CLI on a sign-in endpoint fail, shown as SPI-1172's classified failure; a vendor that acts
  on the account (ADR-0018 items 10 and 11: the owner's risk). No token reaches the Container either way.
- **Fix**: on the first live failure, read the relay's log (its `dropped` names, the failure's class) and the vendor's
  error body; for tool names, map them at the relay in the request and back in the answer's stream; for plan usage,
  move flat tools into `additional_tools`.

### U84. Limit meters for subscription endpoints: vendors' limit headers and t3's limit-source contract (SPI-1174)

Ranked after U83: a break leaves a meter empty, stale or wrong, never a turn failed (the readers never throw into an
answer). It leans on two vendors' undocumented-or-client-only header shapes and on t3's usage-limit source contract and
its web client's meter logic, which nothing of ours restates.

- **Where**:
  - Our side: `packages/models/src/limits.ts` (`@t3flare/models/limits`: `LIMIT_WINDOWS`, `limitWindowsOf`,
    `noteLimitReading`, `acceptedLimitReading`); the readers in agents' `session/models.ts` (`limitWatch`, on each
    endpoint's fetch, beside SPI-1173's `answering`), `workspace/modelRelay.ts` and `endpointText.ts`; the sender
    `limitsSender` (`environment.ts`); the Environment's `usage/limits.ts` (`limitStore`, table
    `t3flare_limit_windows`; `limitWiring`, the Environment DO's `recordLimits` and `forget` on an endpoint's removal,
    `endpoints/api.ts`'s `removed`), `usage/limitMeters.ts`
    (`limitSnapshots`) and `usage/limitSources.ts` (`endpointMeterSources`, `withSources`), wired in
    `t3/composition.ts`.
  - **ChatGPT's Codex headers**: `x-codex-{primary,secondary}-used-percent` (a percentage), `-window-minutes`,
    `-reset-at` (epoch seconds), as openai/codex reads them (`codex-rs/codex-api/src/rate_limits.rs` at `662a634e`:
    `parse_rate_limit_for_limit` :57, the names :68-80, `parse_rate_limit_window` :195). Only the default `codex` family.
    **ChatGPT plan usage (our `chatgpt` sign-in, `api.openai.com/v1`) sends none today**, per a third party's
    observation of 2026-10-14 (openai/codex#54219): the meter appears only if OpenAI adds them there, or on an endpoint
    whose answers carry them (the Codex backend through a gateway).
  - **Claude's unified headers**: `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` (a fraction; epoch
    seconds) and the overall `-status`, `-representative-claim`, `-reset`. Not in Anthropic's docs: read as Claude Code
    2.1.325's binary reads them (its `strings`: the claims table `[["five_hour","5h"],["seven_day","7d"],…]`, the reader
    `Rn`, `Math.round(utilization*100)`); SPI-1161's evidence recorded the names on real answers (values not kept).
  - **No Copilot meter**: no documented header carries Copilot's plan quota.
  - t3: `UsageLimitSources` (`apps/server/src/usage/UsageLimitSources.ts`: `current`, `streamChanges` seeded with the
    current list, `refresh`, `consumeResetCredit`); `UsageLimitSourceSnapshot` (`contracts/src/providerUsageLimits.ts`,
    kind `cliproxy` only); the web client's `collectLimitAccounts`, `collectLimitPools` and
    `collectProviderUsageLimits` (`packages/shared/src/usageLimits.ts`), and `collectLimitNotices`
    (`packages/shared/src/usageLimitsCopy.ts` since `v0.1.11-nightly.20261118.4864`, which translates its text; before
    that in `usageLimits.ts`, and `limitMeters.test.ts` takes it from whichever has it until the pin is past that tag,
    then imports it from `usageLimitsCopy` directly): an account with no email is named by its id, a
    source's `error` becomes a notice beside the meters (our staleness text: "Last read 3 hours ago …"), Codex windows
    pool by kind. The composer's `/usage-limits` report labels every source account "CLI Proxy" (`sourceLabel`, fixed
    for t3's only source kind `cliproxy`), ours included: it reads "<endpoint label> · <endpoint id>" beside that.
  - **A gateway that passes a subscription's headers through** (Commissary in front of a Claude account): the
    endpoint gets our meter, and the account shows once, as that meter (no other source lists it).
- **Breaks when**: a vendor renames a header, changes a unit (a percentage for Claude's fraction, milliseconds for a
  reset) or stops sending a window; OpenAI adds the Codex headers to plan usage under other names; pi-ai stops taking a
  request's `fetch` on Anthropic Messages or OpenAI Responses (the Session's reader sits on it); t3 adds a source kind,
  stops turning a source's `error` into a notice when it has accounts, or starts hiding a source's accounts when it has an
  error (the stale meter would vanish instead of saying when it was read).
- **Detection**: `apps/environment/test/limitMeters.test.ts` pins each vendor's names and units (a rename or a unit
  change in our reader fails it) and runs our sources through t3's own schema and meter logic (pools, notices, the
  composer's report): a t3 change there fails it. `apps/agents/test/limitReadings.test.ts` runs pi-ai's real Anthropic
  and Responses clients through the Session's providers (API key and the Claude sign-in) and the relay. **Silent**: a
  vendor's change, which only a live answer shows (none has run: owner decision, 2026-11-16); cheapest check: one turn on
  each subscription, then the Usage page.
- **Blast radius**: a missing, frozen or wrong meter; the turn itself is unaffected.
- **Fix**: compare the vendor's client again (Codex's `rate_limits.rs`, Claude Code's `strings`), update
  `limits.ts` and its pins; for t3, diff `usageLimits.ts`, `usageLimitsCopy.ts` and `UsageLimitSources.ts` between tags.

### U85. The setup state and the fallback of old selections (SPI-1176)

Ranked last: a break shows the owner no hint, or refuses an old thread's model, and no turn on an endpoint's model
fails for it.

- **Where**:
  - **The setup state** is t3's own provider status: every driver's snapshot is `buildServerProvider`'s with the probe
    `provider/readiness.ts` `readinessOf` gives, `status: "warning"`, `auth: { status: "unknown" }` and a message
    pointing to the Harness panel, while it has no model (Pi Durable with no endpoint that lists one; each CLI with none
    of its API). t3's web client shows such a provider as "Needs attention" with the message
    (`apps/web/src/components/settings/providerStatus.ts` `getProviderSummary`) and a banner on its threads
    (`chat/ProviderStatusBanner.tsx`, keyed by status, auth and message). t3's registry would keep a provider's earlier
    models when its snapshot lists none, so the setup state would still list them: patch 0006 stops that for every
    t3flare driver, by a list of their driver kinds in `shouldRetainMissingProviderModels`
    ([U66](#u66-patch-0006-a-removed-endpoints-models-leave-the-picker-spi-1162-spi-1176), where its lean lives; only
    `scripts/p1176.ts` covers the list, as t3's patched registry is built, not unit-tested). A CLI's spawn with no endpoint is refused by
    its profile (`agents/cliProfiles.ts` `noEndpointFor`). t3 would show its own "Failed to open <driver> provider
    session" text, so the CLI wrapper (`provider/cli/wrapper.ts` `withSpawnRefusal`) puts a `ProviderSetupError` with
    the refusal under t3's open error: t3's turn start reads a cause chain's curated messages first
    (`provider-core/src/server/failure.ts` `knownProviderFailureMessage`, which passes `ProviderSetupError`'s through).
    A Pi Durable turn whose `no_model` settlement names no model reads the setup state from the endpoints
    (`provider/differ.ts` `failureOf`).
  - **The fallback of old selections** leans on where t3 hands a model to each agent: Pi Durable's adapter `modelOf`
    (ours); the ACP flavor's `resolveModelId` (`claudeModelId`, `opencodeModelId`), which t3's ACP adapter calls before
    `validateModelSelection`; t3's Pi adapter sending a slug as `set_model { provider, modelId }`
    (`provider-pi/src/server/rpc.ts` `resolvePiModelSlug`), which `piLineToPi` rewrites for `anthropic`; and Codex's
    `thread/*` and `turn/start` params, which the request guard routes (`codexModelRoute`). Each runs an old selection
    on the default model (`selectionSlug`), even where an endpoint lists a model of its id (ADR-0034 §3). Text generation
    and its setting fall back in ours (`textModelOf`, `seedSettings.ts`).
- **Breaks when**: t3 hides or disables a `warning` provider, needs `auth.status` to be one of its sign-in states to
  offer it, drops `message` from the summary or the banner, or picks a default model for a provider with none; t3's ACP
  adapter stops calling `resolveModelId` (an old Claude or OpenCode thread is refused, "The agent did not accept the
  model"); t3's Pi adapter sends a model by another command or shape (an old pi thread fails "Model not found"); Codex
  takes a model elsewhere than those params; `knownProviderFailureMessage` drops `ProviderSetupError` or stops walking
  `cause` (a refused spawn shows t3's generic open failure).
- **Detection**: `setupStateSnapshots.test.ts` (each driver's own snapshot without and with an endpoint for it),
  `cliSpawnRefusal.test.ts` (the refusal through t3's failure text), `differ.test.ts` (Pi Durable's),
  `endpointsPicker.test.ts` (the probe, Pi Durable's fallback), `piDriver.test.ts` (pi's status through an
  endpoint change), `claudeEndpoints.test.ts`, `opencodeEndpoints.test.ts`, `codexEndpoints.test.ts`,
  `codexGuard.test.ts`, `piEndpoints.test.ts` and `piSpawn.test.ts` (each CLI's fallback), `endpointTextGeneration.test.ts`
  and `textGenerationDefault.test.ts` (text generation's); `acpAdapter.test.ts` runs t3's ACP adapter. **Silent**: how
  t3's web client renders the status (no test reads the page); `scripts/p1176.ts` on a stage reads `server.getConfig`.
- **Blast radius**: a fresh Environment with no hint where to set up; an old thread refused on its model until the owner
  picks another. Turns on an endpoint's model are untouched.
- **Fix**: diff `providerStatus.ts`, `ProviderStatusBanner.tsx`, `snapshotProbe.ts`, the ACP adapter's model selection and
  `provider-pi/src/server/{adapter,rpc}.ts` between tags.

### U86. The ACP registry's refusals, the Storage page's database row, OTLP from settings (parity batch 2: G13)

Moved from U58 when its Commissary readers went (SPI-1176).

- **Where**:
  - ACP registry (G13): `provider/acpRegistry.ts`, a Layer over `AcpRegistrySupport.AcpRegistryCatalog` (`search`, `prepare`, `inspect`, `resolve`, `uninstallManagedBinary`) in place of `layerFromHost`, merged with t3's `AcpRegistryRuntimeCoordinator.layer`; the agent lists `BUILT_IN_EQUIVALENT` and `VENDOR_SIGN_IN` against the registry's ids.
  - Storage page: `t3/databaseStorage.ts`, a Layer over `persistence/DatabaseStorage.ts` (`status`, `requestReclaim`, `reclaim`) reading `SqlStorage.databaseSize`; `DatabaseStorageStatus`'s fields.
  - OTLP: `t3/otlp.ts` builds `ServerConfig`'s `otlp*` fields from `settings.json` with t3's `parsePersistedServerObservabilitySettings` and `OtelEnvironment.resolveSignalEndpoint` (as `cli/config.ts` does); `composition.ts` mounts `ServerHttp.layerOtlpTracesProxyRoute`.
- **Breaks when**: t3 makes `AcpRegistryCatalog` methods or the registry's ids change; changes `DatabaseStorageStatus`, or moves where it reads the OTLP settings or their schema.
- **Detection**: typecheck (every service shape and contract type above); `test/acpRegistry.test.ts`, `databaseStorage.test.ts`, `otlp.test.ts`. **Silent**: a new registry agent defaults to "key from its environment" (refused, which is safe). Cheapest check: `scripts/pbatch2.ts registry|storage|otlp` on a stage deployed with `T3FLARE_PROBE=1`.
- **Blast radius**: a registry list that offers an agent we cannot run (prepare still refused); a Storage page without a size; no OTLP export.
- **Fix**: diff `AcpRegistrySupport.ts`, `DatabaseStorage.ts`, `cli/config.ts` between tags.

## Gaps in detection

Checks worth adding, each closing a silent or late path above. Each has a ticket in Linear (team SPI, project t3flare).

| # | Check | Covers | Ticket |
| --- | --- | --- | --- |
| T1 | ~~The bump runs the whole `bun run check`~~ Done (ADR-0030): it runs `pnpm run check` | U27, U20 | [SPI-1010](https://linear.app/spiritledsoftware/issue/SPI-1010) |
| T2 | ~~Fingerprint the t3 code we restate or emulate (the `server.ts` layer graph and routes, `TerminalManager.make`, `ServerEnvironment.make`'s capabilities, the git argv and `gh` schema literals); the bump fails on any change until the matching file of ours is reviewed~~ Done: `apps/environment/test/upstreamFingerprint.test.ts`; a change holds the bump for a person (ADR-0037's SPI-1011 refinement) | U1, U4, U12, U13, U15, U45 | [SPI-1011](https://linear.app/spiritledsoftware/issue/SPI-1011) |
| T3 | ~~A test of the descriptor's capability keys against a classified list (kept, stripped), failing on a new key~~ Done: `test/capabilities.test.ts` and typecheck | U4 | [SPI-1012](https://linear.app/spiritledsoftware/issue/SPI-1012) |
| T4 | A workerd test that runs t3's migrations, then each private-table query of `idle.ts` (and step 3's) and expects no `UnreadableTables`, and compares the status lists with t3's; the same for computer's VFS tables | U2, U23, U70 | [SPI-1013](https://linear.app/spiritledsoftware/issue/SPI-1013) |
| T5 | Assert `dist/build-report.json` against the pin's: Shadows applied, alias importers, skipped dependency imports, stub names | U9, U11 | [SPI-1014](https://linear.app/spiritledsoftware/issue/SPI-1014) |
| T6 | Acceptance asserts from the router trace that t3's polls started no stopped Container and that patched read shapes were not answered `last-answer` | U6, U13 | [SPI-1015](https://linear.app/spiritledsoftware/issue/SPI-1015) |
| T7 | Acceptance asserts t3's source-control discovery shows GitHub signed in through the `gh` emulation | U15 | [SPI-1016](https://linear.app/spiritledsoftware/issue/SPI-1016) |
| T8 | Acceptance `--faults`: a usage limit through the stage's model fault (a vendor shape since SPI-1176) arms and resumes; an Environment restart mid-turn continues the turn | U3, U14 | [SPI-1017](https://linear.app/spiritledsoftware/issue/SPI-1017) |
| T9 | ~~Fail install when a `patches/deps` patch names a version `bun.lock` does not resolve, and stop filtering "no longer applies"~~ Done (ADR-0030): pnpm fails on an unused or unappliable patch, and verify-lock on a t3-patched version left unpatched | U20, U24 | [SPI-1018](https://linear.app/spiritledsoftware/issue/SPI-1018) |
| T10 | The differ builds turn items with `satisfies`, not `as`, so a new required field fails typecheck | U3, U26 | [SPI-1019](https://linear.app/spiritledsoftware/issue/SPI-1019) |
| T11 | Run the acceptance `/ws` client built from the newest nightly's contracts against the bump stage | U7 | [SPI-1020](https://linear.app/spiritledsoftware/issue/SPI-1020) |
| T12 | A test that walks `EnvironmentHttpApi` for endpoints taking a credential and for path prefixes, against `BOOTSTRAP_EXCHANGE_PATHS` and `SERVER_PREFIXES` | U16 | [SPI-1021](https://linear.app/spiritledsoftware/issue/SPI-1021) |
| T13 | ~~Step 3: `--peer` fails on a tool from t3's `tools/list` that `t3-mcp.ts` neither allows nor denies~~ Moot since the denylist (owner, 2026-11-12, back to stock): a new tool is offered, as in stock t3 | U5 | [SPI-1022](https://linear.app/spiritledsoftware/issue/SPI-1022) |
| T14 | Acceptance fails on any `SQLITE_AUTH` refusal (`pragmaRefusals`), now that t3's storage PRAGMAs are answered | U8 | [SPI-1023](https://linear.app/spiritledsoftware/issue/SPI-1023) |

