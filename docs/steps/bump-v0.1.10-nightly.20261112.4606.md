# Bump: t3code `v0.1.9-nightly.20261111.4515` → `v0.1.10-nightly.20261112.4606`

This fixes SPI-1089. The nightly workflow (`bump.yml`) is disabled for the pnpm cut-over (SPI-1090), so I ran the bump by hand in a worktree, step by step as `scripts/bump.ts` runs it, on branch `bump`.

## The tag

`v0.1.10-nightly.20261112.4606` (`d8f3fef`) is the newest nightly on t3code's origin as of 2026-11-13, sorted by date and run as `bump.ts` sorts. It is the same tag the pnpm dry run failed on.

## Steps

| Step (`bump.ts`) | Result |
| --- | --- |
| Move t3code to the tag | ok (commit `chore: bump t3code to …`, with `pnpm-workspace.yaml` and `pnpm-lock.yaml`) |
| Regenerate the workspace and install (`node scripts/relock.ts`) | ok. 33 t3 packages, pnpm 12.14.0, Node 26.12.1. 15 patches kept, 21 of t3's are for packages outside our install. alchemy did not move (U20) |
| Lock matches t3's, one effect (`verify-lock`) | ok. `effect` 4.1.2 alone, 0 failures |
| `pnpm run check` | First run failed: the two SPI-1089 errors. Second run failed one test (below). Third run passed, 32/32 tasks |
| `test:docker` | not run (not asked for; the CLIs did not move) |
| Deploy stage `bump1` (`stage.ts deploy bump1 --web`) | ok |
| `acceptance --threads 12 --runs 4 --real-turn --terminal --worktree --peer --codex --claude` | Every section passed except `peer` F6, "bash asks in plan". A rerun of `--peer` alone passed |
| Destroy `bump1` | ok |

The acceptance output is in [`bump-v0.1.10-nightly.20261112.4606/acceptance.json`](bump-v0.1.10-nightly.20261112.4606/acceptance.json), and the `--peer` rerun in [`acceptance-peer-rerun.json`](bump-v0.1.10-nightly.20261112.4606/acceptance-peer-rerun.json).

## Fixes

All three are Layer changes in our own code. The Shadow and Patch sets did not change.

1. **U1, `composition.ts`.** I restated t3's `server.ts` changes in its own form:
   - `ProviderInstallationGate.layer` is provided below provider hydration. This is the new service: t3's session manager, text generation and maintenance runner gate provider work on it. It is stock: an in-memory semaphore per instance.
   - `ProviderInstanceRegistryHydration.layer` gets `layerPersistence`. Hydration now needs `SqlClient`; t3 provides `SqlitePersistence.layerConfig`.
   - `AntigravityInstallation.layer` gets `layerServerSettings`.
   - `DirectEndpoints.layer` gets `layerServerEnvironment`. It now reads the environment id, so `runtime.ts:35`'s missing `ServerEnvironment` came from here.

   t3's other `server.ts` changes do not apply here: `keepIdleConnections` is for its Node HTTP server, and the Tailscale Serve holder and repair loop only run with `tailscaleServeEnabled: false` flipped on, which we never do.
2. **U4, `capabilities.ts`.** `shellThreadFamilies` and `shellOlderSettled` are classified **keep**. Both are thread-shell reads that t3's `/ws` serves from its own SQL, so the platform supports them.
3. **U5/U49, `test/t3Guidance.test.ts`.** t3 added a `tool_search` tool. It lists it only to an MCP client that sends `t3-tool-exposure: deferred`, and its description names `html_preview`/`html_render` without backticks. The Session sends no such header, so in production it never sees `tool_search`. The test loaded every toolkit and so counted it. It now drops `tool_search`, as t3's `layerDeferredListing` does for a client that does not defer. No production change was needed.

Also on the branch:
- `bump1` is added to `STAGES` in `apps/environment/scripts/stage.ts`.
- `docs/upstream-fragility.md` U5 notes the deferred listing, and U18 notes the new worktree argv and the commit's stdin pathspecs.

## Upstream changes checked by hand (silent paths)

- **Shadows (U11).** `provider/builtInDrivers.ts` and `provider-core/server/processGroup.ts` did not change between the tags. The build report applies both.
- **Patches (U10).** All three still apply (`check:patches`), so none needed rebasing. `ServerBrowserPage.ts` and `ManagedProjectFolders.ts` did change, and acceptance's deploy, reboot check and `--real-turn` passed on them.
- **Worktrees (U18).**
  - t3 now makes the branch first, in the project: `git branch --no-track -- <new> <start>`.
  - It then runs `git -c checkout.workers=<n> worktree add -- <path> <new>`, without `-b`, and refreshes the new worktree's index.
  - The router handles this shape: `--worktree` passed, with stages `fetch:skipped`, `checkout:done`, `setup-script:done` and `agent:done`, and the removal and sweep passed too.
- **Commit (U6).**
  - t3 now stages over stdin: `add -A --pathspec-from-file=- --pathspec-file-nul`.
  - It also adds new reads: `count-objects -v` and `diff --diff-filter=U -z`.
  - The router forwards stdin, but no bump step commits through t3's git panel. Filed as **SPI-1091**.
- **Migrations 082–085** are new indexes and a turn-item count. None of them touches the tables `idle.ts` reads (U2).

## Acceptance F6

`peer` F6 failed once:
- In plan mode, the model said Plan "rules out edits and command execution" and never tried `bash`, so no approval was raised.
- This is the known model-dependent check, **SPI-1048**. The plan instructions it follows are ours (`permissions.ts`) and did not change.
- The rerun of `--peer` passed every check.

## Counts

- **Shadows:** 2, unchanged (`builtInDrivers.ts`, `processGroup.ts`).
- **Patches:** 3, unchanged (`0001-lazy-server-browser-ref-namespace`, `0002-new-project-root-is-w`, `0003-provider-session-idle-10-minutes`).
- The `t3code` submodule moved only by its pin.

## Landing

- Push only the `bump` branch.
- Per ADR-0030's rollback rule, hold this bump unmerged until two nightlies have passed on pnpm and prod has deployed once more.
- Re-enable `bump.yml` once the pnpm cut-over (SPI-1090) lands.
- The fixes need the new pin, so they land together with it, as runbook step 4 says.
