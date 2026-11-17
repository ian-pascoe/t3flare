# In-app updates: plan

Settled with the owner on 2026-11-17 after a four-round design interview. The facts behind it are in
`docs/research/github-actions-dispatch-and-do-deploy.md`. It ships as one PR.

## Goal

1. Stop the Cloud Environment falsely reporting to stock T3 clients that it is out of date.
2. Make the stock client's server **Update** button move prod to the client's t3 version.
3. Make the stock client's provider update button move the **pi CLI**, **Codex** and **Claude Code** to their latest
   versions. Pi Durable stays out for good: it remains fully under our control. OpenCode is out of this PR.

## Why the false report happens

- `serverVersion` comes from the version in `t3code/apps/server/package.json`, which is `0.1.10`.
- t3's release CI writes the release version into that manifest first (`t3code/scripts/update-release-package-versions.ts`).
  We build from the raw tag source, so ours is never stamped.
- The client compares the two in `t3code/apps/web/src/versionSkew.ts` (`resolveVersionMismatch`).
- The banner says "manual update" because `apps/environment/src/t3/capabilities.ts` strips `serverSelfUpdate`.

## Decisions

### D1 Version stamping

- The build takes the version from `git -C t3code describe --tags --exact-match HEAD`, without the `v`.
- A `build.ts` load hook serves `t3code/apps/server/package.json` with that version. That covers every server reader of
  `packageJson.version` (about 20, for example `ServerEnvironment.ts:234`, `serverRuntimeState.ts:83`).
- `prepare:web` gets the same value as `APP_VERSION`. `stage.ts:173` passes the environment into that spawn, and
  `t3code/apps/web/vite.config.ts:303` reads `APP_VERSION` first.
- **Not on an exact tag:** fall back to the manifest's version. `stage.ts deploy prod` fails instead.
- Rejected: a Layer that overrides only the descriptor's `serverVersion`, because it leaves the other readers wrong.

### D2 Capability

- Advertise `serverSelfUpdate: "respawn"`, and only on prod (see D14).
- Keep these stripped: `serverSelfUpdateProgress`, `serverUpdateStaging`, `serverUpdateThreadContinuation`,
  `serverInstallation`, `npmReleaseLookup`, `desktopAppUpdate`.
- `capabilities.ts` gets a third classification, "advertised by t3flare", because t3 itself sends no `serverSelfUpdate`
  in the DO.
- Why `respawn` over `boot-service`: `respawn` skips the accepting-`ready` baseline (`state/server.ts:1012`), so an idle
  reset during an update does not read as failure.

### D3 Override mechanism: Layers in `apps/environment/src/t3/composition.ts`

- Our `ServerSelfUpdate` replaces `ServerSelfUpdate.layer` at `:808`. `ws.ts:2673-2678` consumes it by tag.
- Our `ServiceLauncherClient` replaces `layerLauncher` at `:833`.
  - Its `prepareTrial` reads storage only and never fails.
  - It returns a committed outcome when the stored target equals the stamped version, and undefined otherwise.
  - `serverRuntimeStartup.ts:648,682` puts that outcome on `ready`.

### D4 What the server Update triggers

- **Dispatch:** the DO dispatches `bump.yml` with `tag`, `land: true`, `update_id` and `gate: update`.
- **Update gate** (`bump.ts --gate update`), about 5 minutes. It keeps:
  - relock and the lock check
  - `pnpm run check`
  - the `bump` stage deploy and its fresh start
  - acceptance with `--real-turn` only: core checks (pairing, `/ws`, the SQL adapter, heavy queries, boot twice in one
    isolate, migrations on the stage's persistent DB) plus one Durable agent turn

  It drops:
  - `test:docker`
  - the codex, pi, claude and opencode turns
  - terminal and worktree
  - peer and the link fence
  - the stock npm nightly link

  The **Full gate** is today's suite.
- **Land:** a separate reusable **land** workflow, used by both kinds of update. It runs on a fresh runner with
  `contents: write`, `actions: write` and `statuses: read`. As built (review cycles 1–3, ADR-0037 §4–7) it takes the
  pin (`t3:<tag>` or `cli:<cli>:<version>`) and the proven commit (`sha`), not a branch: the branch name is made from the
  pin, and it lands only that commit, while the branch points at it and its `t3flare/proven` proof counts. It checks:
  - The branch is one commit on `origin/main`. `git merge-base --is-ancestor origin/main <branch>` plus a commit count.
  - The diff touches only the files this kind of update may change. A t3 bump may touch `t3code` and `PINNED_FILES`
    (`scripts/bump.ts:102`); a CLI bump has its own list (D22).
  - For a t3 bump, the gitlink equals the upstream tag's SHA.

  It then:
  - fast-forwards `main` with `GITHUB_TOKEN`; that push does not start `on: push` workflows
  - dispatches `deploy-prod.yml` with `checked_sha`
  - watches that run; its conclusion is the Update's outcome
  - deletes landed `bump/*` branches at or below the landed version
  - dispatches a **verify** run (D18)
- **Fast path:** if `bump/<tag>` already exists and `origin/main` is its ancestor, the run skips the bump and only lands.
- **Fresh base:** every bump job checks out the tip of `main` when it starts, not the dispatch SHA.
- **Concurrency:** `bump.yml` (and `cli-bump.yml`) share group `bump`, with `cancel-in-progress: false` and `queue: max`.
  The default `queue: single` cancels a pending run whenever another is queued.
- **Pre-proving:** the schedule becomes hourly. A first step runs `git ls-remote` on the tags and exits before setup if the
  newest nightly is already pinned or proposed. A new tag gets the Full gate and a PR. Scheduled runs stay PR-only. A
  newer proposal closes older open bump PRs.
- **Rejected:**
  - Deploying prod from the bump job, which would put prod's secrets in a job that runs upstream code.
  - Running alchemy inside a DO or Container.

### D5 Credential

- The existing GitHub App. `GITHUB_APP_PERMISSIONS` raises `actions` to `write`; the owner accepts the change on the
  installation, which includes `ian-pascoe/t3flare`.
- A new fourth permission list, `{ actions: "write", metadata: "read" }`, is scoped to `ian-pascoe/t3flare`.
- The DO's existing minter mints a token per dispatch and poll, then drops it (like `skills/contents.ts:43`). The
  permission never reaches a Container token.

### D6 Target policy (server Update)

- Accept only an exact nightly version, strictly newer than the running one by t3's semver compare.
- Refuse a request that sets `channel` or `stageOnly`.
- Bump exactly the client's tag. The client waits for `serverVersion === targetVersion` (`state/server.ts:149`).

### D7 State and reporting

- **Record:** one per target (`t3`, and one per CLI) in DO storage: `{id, target, from, dispatchedAt, run, startedAt}`.
  As built (reviews A2, A10, cycle 3) it expires to failed 100 minutes after the DO first sees its run out of the queue
  (not 45 from the dispatch: a run waits its turn in the `bump` group, and the land waits out deploy-prod's 45 minutes);
  3 hours queued, or 15 minutes with no run listed, has failed too.
- **Presses:**
  - The same target pressed again re-attaches to the same `updateId`.
  - A different target while one is in flight is refused with `ServerSelfUpdateError`.
  - Refusals and dispatch errors are returned at press time.
- **Server Update outcome:**
  - **Success:** the new build boots and `prepareTrial` reports it committed.
  - **Failure:** `ready` is re-published through `ServerLifecycleEvents.publish` (`serverLifecycleEvents.ts:40-56`). It
    keeps the original `at` and carries a failed `updateOutcome` with the reason and run URL. `ws.ts:3496-3513` pushes and
    replays it, and the client matches it by id (`state/server.ts:1174-1180,170-193`).
- **Polling:** the DO polls the run only while it is awake, from a scoped fiber in the t3 runtime (`composition.ts:742`).
  It settles lazily at boot and at the next press, and adds no alarm.
- **Update runs:** a 20-minute job timeout.

### D8 Authorization

- Server Update: t3's `environment:maintain` (`RpcAuthorization.ts:86-88`), unchanged.
- CLI updates: t3's `providers:manage` (`:70`).
- No MCP tool and no Settings-server door, so Peer links and Durable agents cannot trigger either.

### D9 Run identification

- `run-name` carries the kind and id: `Update <update_id>`, `CLI update <update_id>`, `Nightly bump`, `Verify <tag>`.
- The DO lists the workflow's `workflow_dispatch` runs created since the dispatch and matches on the name.
- Rejected: `return_run_details`, whose request parameter the REST reference does not document.

### D11 Deploy adoption

- The Environment Worker already deploys with `codeUpdateStrategy: { mode: "immediate" }` (`alchemy.run.ts:287-291`).
- The Agents Worker keeps the deferred 300 s default.
- No change. ADR-0004's text is corrected to match.

### D12–D15

- **D12** Running turns: no warning and no refusal; ADR-0004 already accepts a re-prompt.
- **D13** The scheduled nightly stays PR-only.
- **D14** Advertise both update capabilities only on a stage with an update target configured, which today is prod only.
  A press on another stage would move prod.
- **D15** Recovery from a bad nightly on prod is Safe mode plus a revert by the owner. File a ticket for a pre-migration
  bookmark plus an admin restore route. ADR-0017 claims a bookmark is taken; no code takes one, so correct the text.

### D16 Tests

- Unit tests:
  - the target policy
  - the new capability classification
  - the version stamp
  - `prepareTrial`
  - record expiry and re-press
- A fake dispatch and runs endpoint for the DO's GitHub calls.
- An acceptance assertion that the descriptor's `serverVersion`, the web `APP_VERSION` and the tag all agree. The prod
  smoke check also asserts `serverVersion` equals the tag.
- A test that a client blocked by a protocol mismatch can still call the update RPC (`outdatedHostUpdate.ts:103-181`).
- One trial run of each workflow, `land` + `dry_run` and `cli-bump` + `dry_run`. As built, a dry run lands and deploys
  nothing: `cli-bump.yml` with `dry_run` proves the pin on the `bump` stage (the timings, including the image build)
  and runs the publish job's land check; `land.yml` with `dry_run` (`-f pin=… [-f sha=…]`) runs its binding to the
  proof and its land check only, since deploy-prod refuses a commit that is not main's (review cycle 3).

### D17 Docs

- **New ADR:** "Stock clients' Update buttons land a bump: the DO dispatches CI, which proves and fast-forwards main". It
  covers both kinds of update, the two gates, pre-proving, the verify run, the land job, `queue: max` and the credential.
- **ADR-0017:** add the land mode and the hourly schedule, and correct the bookmark claim.
- **ADR-0023:** add the third classification.
- **ADR-0013:** add the fourth permission list.
- **ADR-0004:** say "Environment: immediate; Agents Worker: deferred 300 s".
- **ADR-0024:** amend the "Provider install and update … never from a client" row.
- **ADR-0015:** note CLI pins and CLI bumps.
- **AGENTS.md:** note that a land push to `main` deploys through an explicit dispatch, because a `GITHUB_TOKEN` push
  starts no workflow.
- **`docs/upstream-fragility.md`:** revise U7, and add entries for:
  - the stamp seams
  - the `respawn` literal
  - the 32-minute `SERVER_UPDATE_RESUME_TIMEOUT`
  - `updateOutcome` matching and `prepareTrial`
  - the provider-update runner contract: command through the spawner, 30-minute timeout, installation gate, "unchanged"
    re-check, `ws.ts:3689`
  - the npm-to-release version mapping per CLI

### D18 Verify run

- After any update lands on the Update gate, the land job dispatches the Full gate for that version (`force`, `dry_run`).
  For a CLI bump that is the full `test:docker` plus all CLI sub-tests.
- If the verify run fails, it opens a GitHub issue naming the version and the failed step. GitHub Issues sync to Linear.
- No automatic revert, because migrations only go forward.

### D19 Flakes

- Fail fast; retry only at the transport level, as the harness already does.
- A failed Update reports its run URL, and pressing again is the retry.

### D20 Glossary (new Upstream section)

- **t3 pin**: the nightly tag the submodule is at.
- **t3 bump**: moving the t3 pin and proving it on the `bump` stage.
- **CLI pin**: a CLI agent's version in the Workspace image.
- **CLI bump**: the job that moves a CLI pin, proves it and lands it.
- **Proposed pin**: a pin that passed a gate but is not on `main`. It records which gate it passed.
- **Land**: fast-forward `main` to a proposed pin, then deploy prod.
- **Update**: a bump and land requested from a stock client's button, of either kind. _Avoid_: self-update.
- **Update gate**, **Full gate**.
- **Server version**: the t3 pin without the `v`.
- **Stage**.
- **Workspace image**: the one name. The code says "sandbox image" too.

### D21 CLI updates from t3's stock provider-update button

- **Capability:** the pi CLI, Codex and Claude drivers (`provider/cli/{piDriver,codexDriver,acpDriver}.ts`) replace
  `makeManualOnlyProviderMaintenanceCapabilities` with a real `update` capability and a `lookupLatestVersion`.
  `ProviderLatestVersions` (`maintenanceResolver.ts:129-163`, provided at `composition.ts:699`) caches the result.
- **Command:** `updateProvider` runs our capability's command through `ChildProcessSpawner`, with a 30-minute timeout
  (`providerMaintenanceRunner.ts:47,110-125,206`). `processRouter.ts` answers that command by dispatching
  `cli-bump.yml` and blocking while it polls the run.
  - **Failure:** exit 1, with the failed step and the run URL as output.
  - **Success:** the prod deploy resets the Environment, and the card shows the new version.
- **Gate:** t3's installation gate waits for that provider's running work, then holds new work until the command ends.
  This is accepted stock behaviour.
- **Scope:** only on prod (D14).

### D22 CLI bump workflow

- **Workflow:** `cli-bump.yml` takes inputs `cli` (`pi` | `codex` | `claude`), `update_id`, `dry_run`, and (as built,
  review F2) `running`, the CLI's pin prod runs, which the DO sends so a run can deploy main when main already holds
  the newest pin. It runs `scripts/cli-bump.ts`.
- **What the script edits:**
  - **Codex:** the Dockerfile `CODEX_VERSION` and `CODEX_SHA256`. CI downloads the musl release tarball and hashes it.
  - **pi CLI:** the `apps/sandbox-image/image/cli/` npm lock (`@earendil-works/pi-coding-agent`).
  - **Claude:** bump `@agentclientprotocol/claude-agent-acp` to latest in `image/claude/package.json` and relock. The SDK
    follows the adapter's range, and the Claude Code version comes from the SDK's npm `claudeCodeVersion` field.
  - **All three:** `apps/sandbox-image/src/clis.ts`. `cliManifest.test.ts` keeps it equal to the Dockerfile and checks it
    against t3's compatibility manifest.
- **Branch:** it pushes `bump/cli-<cli>-<version>` and lands through the shared land workflow, with its own diff allowlist
  (the image files and `clis.ts`).
- **Gate:**
  - `pnpm run check`
  - a `bump` stage deploy with the new image
  - acceptance core plus that CLI's sub-test
  - the full `test:docker` runs in the verify run instead
- **Version discovery:** latest only.
  - The DO's advisory lookup uses npm: `@openai/codex`, whose versions equal the `rust-v*` releases;
    `@earendil-works/pi-coding-agent`; and the Claude SDK's `claudeCodeVersion`.
  - CI resolves the version again. A resolved version equal to the pin exits as unchanged.
  - t3's runner refuses a version its manifest marks broken.
- **Running Containers:** Containers managed by a Durable Object take no part in image rollouts; the image is picked at
  start. A running Container keeps the old CLI until it restarts, which is accepted.
- **Estimate:** 14–18 minutes from press to the new version. The trial run (D16) confirms it.

### D23 Ordering

A t3 bump that raises a CLI's minimum version fails `check` with "bump the CLI in clis.ts". Press that CLI's update
first, then the server Update.

## Owner actions

- Accept the App's new `actions: write` permission on its installation.
- Confirm the installation includes `ian-pascoe/t3flare`.

## Follow-ups (tickets)

- A pre-migration bookmark plus an admin restore route (D15).
- OpenCode CLI updates. Its 2.x line is not on npm, so it needs a GitHub-releases lookup.
- Check whether the Container token's `contents: write` on t3flare lets an agent push `main` (an existing issue, F3).
