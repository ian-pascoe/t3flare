# Step 2b: report (terminal, setup scripts, worktree Workspaces, deletion and sweep)

Date: 2026-11-11. Branch `step-2b`, from `main` at 2fc8676. Plan: [`step-2b-plan.md`](step-2b-plan.md), as amended by
the independent review (Fable, F0–F11) and the owner's D1 (terminals do not outlive clients). t3code pinned at
`v0.1.9-nightly.20261111.4515` (24e7747), unchanged. Everything ran on the throwaway stage `step2b`, destroyed at the
end; `prod` was never deployed, run against or destroyed.

## Exit criteria (`docs/plan.md`, row 2b)

| Criterion | Result | Evidence |
|---|---|---|
| A worktree thread provisions… | **PASS** | From the stock web client: `/w/.wt/<project dir>/<dir>` is a Workspace of its own in 7.8 s (clone 6.4 s, bundle 0.8 s, checkout 0.6 s), and the agent's turn runs there (`m2-worktree-thread.png`, `m2-work.json`). Two at once, each in its own Container (`m2-two.json`) |
| … and runs its setup script | **PASS** | `cp "$T3CODE_PROJECT_ROOT/.env" . && mise install && …` shows `setup-script` running with its tail, then done; the `.env` is in the worktree (`m3-setup.json`, `m3-setup-running.png`, `m3-setup-done.png`). Exit 3 fails the stage, async and blocking (`m3-fail-*.json/png`) |
| The terminal works | **PASS** | From a stopped Container: status line 0.6 s, prompt 4.1 s; `pwd`, `git status`, resize 30×100 → 40×120, Ctrl-C, echo p50 81 / p95 138 ms, 2.9 MiB/s (`m1-basic.json`, `m1-terminal.png`); sync both ways under 1 s (`m1-sync.png`); `git push` from the PTY (`m1-push.json`); 0 of 11 secret binding values in the terminal (`m1-basic.json` `leak`) |
| Deleting the thread frees the Workspace | **PASS** | Deleted in the web client with "Delete the worktree too?" confirmed: by the first poll (3 s) the registry row was gone, the Container stopped and out of the budget, the DO refused every call (storage purged, marker set), the terminal gone, and the unpushed branch carried into the project's repo (`m4-delete.json`, `m4-delete-*.png`, `m4-deleted.png`) |
| The acceptance test, on the branch head | **PASS** | `acceptance --real-turn --terminal --worktree` against 4c0c25f: terminal echo 0.9 s; worktree with `checkout:done, setup-script:done, agent:done` in 14.4 s; removal out of the budget; the sweep's dry run reads t3's tables (`m5-acceptance-final.json`). An earlier run on the M4 build: `m5-acceptance.json` |

Further M1 checks: closing a terminal leaves no marked process within 2.5 s; after an Environment restart the client
re-attaches with the old scrollback and the old shell is gone in 93 s (`m1-restart.json`); with every client gone the
shells end and the Container stops at 154 s (`m1-clients-gone.json`); the idle hold (2 minutes on the stage) stops the
Container at 123 s while output still flows, after a pull (the file written just before survives, `m1-idle-hold.json`);
with 3 Containers held a fourth terminal shows the budget's refusal (`m1-budget.json`). The fixture's test branches
are deleted (only `main` remains).

## What was built

### The terminal (M0, M1; ADR-0021)

- **F0 first:** both Workers run with `nodejs_compat_do_not_populate_process_env` (`apps/environment/build.ts`,
  `apps/agents/build.ts`). The stage booted and passed `acceptance --real-turn` with it (`m0-flag-acceptance.json`);
  `process.env` in the DO is empty.
- **t3's `TerminalManager` stays stock** (`apps/environment/src/terminal/layer.ts`: `makeWithOptions` with our options,
  a Layer, no Shadow). Under it `ptyAdapter.ts` is t3's `PtyAdapter`: a fixed base env plus an allowlist (never
  `process.env`), writes queued and sent in order one RPC at a time, pushed frames, one close for t3's SIGTERM and
  SIGKILL (F2), an epoch on every answer so a restarted Workspace DO ends the terminal (F11), a heartbeat every 30 s
  (D1). `registerTerminalProcesses` and `resolveProviderInstanceEnvironment` are omitted (F10).
- **`TerminalHost` in the Workspace DO** (`apps/agents/src/workspace/terminalHost.ts`): shells under the platform's
  `ctx.container.exec(…, { pty })`, at most 8; output batched and pushed to `EnvironmentDO.terminalOutput` (not activity,
  never boots t3), never dropped (a failed push goes back to the queue's front: a lost frame lost a setup sentinel in
  M3); the rc file's `PS0`/`PROMPT_COMMAND` markers stripped and turned into the foreground's state (F1: `closeIdle` on
  settle keeps a busy terminal, `m1-settle.json`); input held until the first prompt; markers kept in storage and an
  earlier instance's orphans killed by marker at the next open; a 30-minute hold from the last *input* (F10).
- **`TerminalSync`** (`terminalSync.ts`, F9): pulls through `CONTAINER_BACKEND` after a prompt or quiet output (at most
  every 2 s, backing off on empty pulls), pushes the DO's writes every 2 s, one sync at a time, never with the Container
  stopped.
- **The wrapper and rc** (`apps/sandbox-image/src/terminal.ts`): bind mount at `/w/<id>` (symlink fallback), marker,
  mise, the project-root view's link for worktrees.

### Worktree Workspaces (M2; ADR-0008, ADR-0009)

- The id `.wt/<project dir>/<dir>` in `workspace-client`; the registry migrated in place (kinds, parent, states); New
  project folders are now `ready` (2a left them `provisioning`), old rows readied by the migration.
- `ServerConfig.worktreesDir = /w/.wt`; `fastWorktreeCheckout` seeded off.
- The router's worktree verbs (`gitRoutes.ts`, `processRouter.ts`): `worktree add` clones the remote in the new
  Workspace's Container, the project bundles what that clone lacks (excluding the clone's actual tips, F7), copied DO to
  DO; `worktree list` emulated from the registry; `worktree remove` is the deletion below; destinations outside
  `/w/.wt/<project dir>` and the PR review guide's detached scratch checkout (F6) refused with the reason.
- **Root's ruling on M2** (ADR-0009 refinement): an allow-list of five `.git`-only reads (each named with its t3 caller,
  `gitDirReads.ts`) may start a stopped Container when they have never been answered; they are primed whenever the
  Container is up. A primed worktree watched with its Container stopped stays stopped, also after an Environment
  restart (`m2-watch.json`: 147 then 174 reads, all cached).

### Setup scripts (M3)

- t3's `ProjectSetupScriptRunner` is unchanged; setup scripts are terminals, so they came with the PTY.
- **The project-root view** (`WorkspaceDO.projectRootView`): the project's untracked files (capped) copied at
  provisioning into the worktree's Workspace, linked by the wrapper at the project's path, so `$T3CODE_PROJECT_ROOT`
  works. The terminal says what it holds on its first line.

### Deletion and the sweep (M4; ADR-0008)

- **States** `provisioning → ready → deleting → (gone)`, and `tombstoned`. Only `provisioning`/`ready` resolve for t3.
- **Removal** (`deletion.ts`, `WorkspaceDO.carryOut/carryIn`): every unreachable `refs/heads/*` and `refs/stash` carried
  home (F8): created, fast-forwarded (never the checked-out branch) or kept at `refs/t3flare/worktrees/<dir>/…`. Dirty
  forced removals are tombstoned (`m4-dirty-forced.json`); a step that cannot run tombstones with no purge date.
- **Purge** (ordered, idempotent, registry last): deleted threads' Sessions destroyed first, then the Workspace DO
  (storage, alarm, Container, lease, and a marker that refuses every RPC but provisioning: F4), then the row. A
  `destroy()` whose own restart beat its answer counts as done (`m4-deleting-retried.json`).
- **Path reuse** (F5): `worktree add` on a tombstone restores it; on `deleting` it finishes the purge, then provisions;
  `deleting` rows are retried after 5 minutes.
- **The sweep**, daily in the Environment's alarm (ADR-0003 refinement): references from t3's own tables matched by
  Workspace id (archived included, projects in subdirectories, open runs, open terminals), failing closed on any read
  error (F3); 7-day grace (3 min on the stage); Sessions of threads deleted past the grace destroyed; a cost guard
  stopping any Container whose lease no Workspace holds, compared by DO id (F4). Prod reports only unless
  `T3FLARE_SWEEP_PURGE=1`. Evidence: `m4-sweep.json` (archived kept, open terminal skipped, tombstone restored then
  purged, unreferenced and deleted-project Workspaces marked then purged, a re-added project kept, failed rows purged
  after 1 h, the cost guard).
- **Admin routes:** `workspaces`, `workspace-restore`, `workspace-purge` (refused while referenced unless `force=1`),
  `workspace-remove` (step 2a's, now a forced purge), `sweep[?dry=1]`, `budget`.

### Acceptance (M5)

`acceptance.ts --terminal --worktree` (`scripts/lib/terminalWorktree.ts`), added to the nightly bump
(`scripts/bump.ts`): a terminal's echo through `terminal.attach`, a worktree thread whose project has a setup script
(through `orchestration.launchThread`), `vcs.removeWorktree` checked against the registry and the budget, and
`sweep?dry=1`.

## M0, the facts

- **The platform PTY works in production** (`m0-pty.json`): prompt 20 ms, `stty size` 24×80 → 40×120 after `resize`,
  session and group leader, Ctrl-C to the foreground job, `less` draws (the image has no vim), `exit 7` gives 7. R1's
  fallback was not needed.
- **Resize and kill after exit** raised nothing; F2 adopted anyway.
- **Lifetime** (`m0-lifetime.json`): a shell outlives `ctx.abort()` as an orphan the new instance cannot reach (hence
  markers in storage, orphans killed at the next open); an idle DO with a shell was not evicted in 6 minutes; the
  Container's stop ends the shell.
- **Sync** (`m0-sync.json`): a no-op pull 50–110 ms, after one commit in a 2,000-file repo 270 ms; a pull beside a
  computer exec stays correct.

## Review findings (Fable)

All twelve were checked against the code; all adopted, none rebutted. Notes:

- **F0**: the leak check compares the 11 bindings' *values* inside the DO; 0 leaked.
- **F1**: built in M1 (also §2.8's "optional" foreground reporting); `m1-settle.json` and `terminalStack.test.ts` with t3's
  real `closeIdle`.
- **F2**: the probe raised nothing after exit; adopted for one signal path.
- **F3–F5, F8**: as above; F3's fail-closed read is tested on real SQLite with a dropped table.
- **F6**: refused (not supported), with the message; the argv is in `gitRoutes.test.ts`. t3 never shows git's stderr, so
  the message is visible in the router trace only.
- **F7**: a real-git test with stale remote-tracking refs (`worktreeScripts.test.ts`).
- **F9, F10, F11**: as built; F11's note (every push to `main` restarts the Environment and kills running setup scripts)
  is in ADR-0021.

## Deviations from the plan

- **Passive reads** (root's ruling, above): step 2a's "a passive read never starts the Container" is narrowed for five
  never-answered `.git` reads.
- **The domain-event reactor is not built.** Archiving or deleting does not stop Containers at once; the idle stop does
  within about 2 minutes, and the sweep re-derives references from t3's tables. The thread-deletion flow purges through
  `vcs.removeWorktree`, which t3 calls.
- **A budget refusal in a setup terminal** cannot happen: provisioning the worktree needs the Container first, so the
  refusal comes there. The terminal's refusal is `m1-budget.json`.
- **Setup scripts** are configured through `projectSettingsOverrides` (where t3 now keeps them), not the project row.
- **M0 evidence files:** transport was measured on the real path in M1 (`m1-basic.json`) instead of `m0-transport.json`;
  the streamed-RPC comparison was not built because push met the targets. t3-in-workerd facts are in
  `m0-flag-acceptance.json` and the tests.
- **Tests:** the plan's *workerd* tests of `TerminalHost`, `destroy()` and the registry-last ordering were written as
  unit tests over fakes at the same seams (`terminalHost.test.ts`, `terminalSync.test.ts`, `deletion.test.ts`), with
  `destroy()` and the injected-failure retry checked on the stage (`m4-delete.json`, `m4-deleting-retried.json`).
- **R13 (heap with 8 busy terminals)** was not measured; t3's scrollback defaults are kept. ADR-0014 is unchanged.

## Tests

- `apps/environment/test/ptyAdapter.test.ts`: env allowlist (F0), write order, frames, one close (F2), the epoch (F11).
- `apps/environment/test/terminalStack.test.ts`: t3's real `makeWithOptions` and `ProjectSetupScriptRunner` over our
  adapter and host on a real bash under a real PTY: setup sentinel with exit 0 and 3, `closeIdle` (F1).
- `apps/agents/test/terminalHost.test.ts`, `terminalSync.test.ts`: the host and the sync at their seams.
- `apps/agents/test/terminalWrapper.test.ts` (Docker, `ubuntu:26.04`): bind mount and fallback, project-root view
  link, markers, the kill script on a PTY session's background job.
- `apps/agents/test/worktreeScripts.test.ts` (real git): remote only, local-only commits, no remote, stale
  remote-tracking refs (F7), carry-home (F8).
- `apps/agents/test/gitDirReads.test.ts`: the allow-list and priming.
- `apps/environment/test/gitRoutes.test.ts`, `workspaces.test.ts`, `deletion.test.ts`,
  `packages/workspace-client/src/index.test.ts`: worktree argv shapes, `worktree list` against real git's output, the
  registry migration, references and the sweep's plan.
- `bun run check` passes at 4c0c25f, also with Docker up (the Docker tests ran: 12 and 7 passed).

## Counts

Patches **2**, Shadows **1**, Build shims **6**: unchanged. New Layers: `PtyAdapter`, `TerminalManager` (with
options), `ServerConfig.worktreesDir`, the routing file system's `/w/.wt` directories, the router's worktree verbs, the
seeded `fastWorktreeCheckout: false`. The t3code submodule is unchanged.

## ADRs and glossary

- **New ADR-0021**, "Terminals run through the platform's PTY exec beside computer, and end with their Environment".
- **ADR-0003** refinement: terminal output is not activity; the sweep's due time is in the one alarm.
- **ADR-0008** refinement: the worktree address, full clones seeded by a bundle, `worktree list` emulated, carry-home
  and the tombstone, the states, the purge order and the sweep as built.
- **ADR-0009** refinement: root's ruling on `.git` reads, and per-Workspace `.git` for worktrees.
- **GLOSSARY:** Terminal, Worktree Workspace, Project-root view, Tombstone, Sweep. README status and `docs/plan.md`'s
  row updated.

## Code review (since `origin/main`)

Run by this agent on both axes (sub-agents could not be spawned here).

**Standards** (ADRs 0001, 0019, the effect-diagnostics and oxlint rules, GLOSSARY):
- Fixed (4c0c25f): the DO-to-DO chunked copy was written three times (worktree bundle, project-root view, carry-in)
  with differing error handling, one ignoring write errors: now one `#copyFrom`; the scripts' duplicated DO-file reader
  is shared (`readDoText` in `scripts/lib/client.ts`), and a broken headless launch path in `scripts/setup.ts` was
  dropped (the web client path is the evidence).
- Judgement calls left: `WorkspaceDO.ts` grows by about 460 lines across terminals, worktrees and deletion (Large
  Class, possible); the terminal and sync logic are in their own modules, the rest is thin RPC wiring that a later step
  could split by concern.

**Spec** (the plan, the review's findings, ADR-0008):
- Fixed (4c0c25f): ADR-0008 says the Sessions of deleted threads go after the grace, but they were destroyed only when
  their Workspace was purged; the sweep now destroys Sessions of threads deleted past the grace whatever their
  Workspace (bounded at 50 a run, remembered by the Environment DO).
- Deviations above (no reactor; workerd tests as unit tests; R13 not measured). No scope creep beyond the admin and
  evidence routes the scripts use.

The review fixes were deployed to the stage and the acceptance test re-run on 4c0c25f (`m5-acceptance-final.json`).

## Risks and notes

- Worktree provisioning is a full clone (about 8 s on the fixture); R7's spare Workspaces stay deferred.
- The project's copy of a worktree's branch does not advance while the worktree lives (carried home only at removal).
- The setup script's `.env` makes a worktree dirty, so a forced removal tombstones it; the sweep purges it after the
  grace.
- Every push to `main` restarts the Environment and kills running terminals and setup scripts; scrollback stays.
- Suggestion: the web client's model picker labels Claude models "· Pi Durable opencode" (the proxy's `owned_by`), which
  this agent misread once as a different provider during M3. Worth a clearer label.

## Evidence index (`docs/steps/step-2b/`)

M0: `m0-flag-acceptance.json`, `m0-pty.json`, `m0-sync.json`, `m0-lifetime.json`.
M1: `m1-basic.json`, `m1-push.json`, `m1-settle.json`, `m1-restart.json`, `m1-clients-gone.json`, `m1-idle-hold.json`,
`m1-budget.json`, `m1-terminal.png`, `m1-sync.png`.
M2: `m2-work.json`, `m2-two.json`, `m2-local-commit.json`, `m2-no-remote.json`, `m2-stale.json`, `m2-wrong-location.json`,
`m2-trace.json`, `m2-watch.json`, `m2-worktree-thread.png`.
M3: `m3-setup.json`, `m3-fail-async.json`, `m3-fail-blocking.json`, `m3-settle.json`, `m3-setup-running.png`,
`m3-setup-done.png`, `m3-fail-async.png`, `m3-fail-blocking.png`.
M4: `m4-delete.json`, `m4-dirty-forced.json`, `m4-deleting-retried.json`, `m4-sweep.json`, `m4-delete-dialog.png`,
`m4-delete-worktree-dialog.png`, `m4-deleted.png`.
M5: `m5-acceptance.json`, `m5-acceptance-final.json`.
