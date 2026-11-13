# pnpm + Vite+: report

Date: 2026-11-13. Branch `pnpm` from `origin/main` at `d54af10`; t3code pinned at `v0.1.9-nightly.20261111.4515`
(`24e7747`).

- **Plan:** `docs/steps/pnpm-plan.md`. Fable's review (`pnpm-plan-review.md`) overrides it; the plan's "Review changelog"
  section folds in every finding. D1–D11 were taken as recommended, except D4, which follows the review.
- **Decision record:** [ADR-0030](../adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md).
- **Evidence:** `docs/steps/pnpm/`.
- **Tickets:** [SPI-1090](https://linear.app/spiritledsoftware/issue/SPI-1090) (cut-over) and
  [SPI-1089](https://linear.app/spiritledsoftware/issue/SPI-1089) (next nightly's upstream break).

The branch is not merged, and prod is untouched.

## Commits

1. **Review changelog**: re-inventoried at `d54af10`.
2. **P1**: Node runs our scripts while Bun still installs. CI moves to Node 26 (review M8).
3. **The swap** (one commit): pnpm installs and Vite+ runs the check. It deletes `bun.lock`, `bunfig.toml`,
   `scripts/check.ts` and `scripts/lock-pins.report.md`, and updates every doc in the same commit, so one `git revert`
   undoes all of it (H5).
4. **D8**: typecheck `sandbox-image`, `models` and `session-protocol` too.

The milestone commits and the temporary checks-only workflow (`.github/workflows/pnpm-check.yml`) were squashed into
the swap. The CI runs below ran on their pre-squash heads.

## What changed

- **Workspace.** `scripts/gen-workspace.ts` writes `pnpm-workspace.yaml`, `package.json`'s `packageManager`/
  `engines.node`, and `mise.toml` from t3's files.
  - Members: our packages, `vendor/cloudpid/*`, and the 33 t3 packages in the closure of `t3` and `@t3tools/web`.
  - t3's settings pass through an allowlist; an unknown key fails with "classify it" (M4).
  - t3's patches are kept only for packages we install (H1); `allowUnusedPatches` stays unset.
  - `@cloudpid/protocol` and `@cloudpid/config` are overridden to `workspace:*` (H2).
  - Every build script is denied (H4/D4): t3's `true`s become `false`, our four are added, and the mobile tarball key
    is dropped.
  - `verifyDepsBeforeRun: error` (M3). No `minimumReleaseAge` (M2).
  - `mise.toml` follows t3's Node and pnpm, and exports `NPM_CONFIG_WORKSPACE_DIR` (M6, M3).
- **Lock.** `scripts/seed-lock.ts` seeds `pnpm-lock.yaml` from t3's lock: both YAML documents, and a settings header
  rewritten to ours (M1).
  - `scripts/relock.ts` runs gen, seed and `pnpm install --no-frozen-lockfile` until the workspace settles. That takes
    two rounds, because our own packages bring t3 patches into play (alchemy, micromark-extension-llm-math).
  - `scripts/verify-lock.ts` compares each t3 importer's transitive closure with t3's (M1).
- **Check.** `pnpm run check` is `vp run check:all` (root `vite.config.ts`): check.ts's 27 tasks plus `check:workspace`,
  run at once and uncached. `@cloudpid/mcp`'s typecheck is a root task with `--noEmit` (M5).
- **Scripts.** Every `bun x.ts` became `node x.ts`, and `Bun.YAML` became `yaml`. `erasableSyntaxOnly` is set in every
  tsconfig of ours. `prepare:web` uses `pnpm --filter`. `@effect/platform-bun` is dropped (imported nowhere).
- **bump.ts.** It runs relock, verify-lock and the whole `pnpm run check` (D9; closes U27/T1).
  - Its install is `--no-frozen-lockfile` (H3).
  - `PINNED_FILES` now includes `mise.toml`.
  - New flags: `--stage`, `--no-deploy` and `--fail-at`.
  - Rollback ends with a frozen install and reports `rollback` (M7).
- **CI.** `.github/actions/setup` uses `voidzero-dev/setup-vp`: Node and pnpm come from `package.json`, and the pnpm
  store is cached on the lock.
  - Secrets are now set on the Deploy and Smoke steps (`deploy-prod.yml`) and on the Bump step (`bump.yml`), not the
    whole job (H4).
  - `bump.yml` gains a `dry_run` input.
- **Docs.** README, AGENTS.md, ADR-0030, ADR-0017/0019/0020, `docs/model-proxy.md`, and header comments.
  - AGENTS.md gains two rules: never run pnpm or `vp` inside `t3code/`, and change the workspace or lock only through
    `pnpm run relock`.
  - The fragility register's runbook, U9, U20 and U24 are updated. U27, T1 and T9 are marked done. U50 is new, and
    there is a soak rule for bump PRs (H5).

## Exit criteria

| Milestone | Criterion | Result | Evidence |
|---|---|---|---|
| P1 | Scripts on `node` while Bun installs | **pass** | `bun run check` green locally (32.2 s); CI on Node 26 green, run [43331851835](https://github.com/ian-pascoe/t3flare/actions/runs/43331851835) |
| P1 | CI on Node 26 | **pass** | same run (`node-version-file: t3code/package.json`) |
| M0 | A test install that succeeds | **pass** | `node scripts/relock.ts`: deterministic (a second run gives a byte-identical lock); frozen install passes |
| M0 | H1 patch filter in place | **pass** | 14 patches kept, 20 of t3's outside our install; no `ERR_PNPM_UNUSED_PATCH` |
| M0 | H2 workspace links | **pass** | verify-lock `vendoredLinks: 4`, all `link:` |
| M0 | Every dependency patch proven applied | **pass** | a marker line of each of the 14 patches found in `node_modules`, t3's alchemy patch included (`m0.json` `patchMarkers`) |
| M0 | t3's importers exact; one effect; t3code clean | **pass, with 3 explained peer drifts** | `{"t3Importers":33,"t3ClosureEntries":9543,"effectCopies":["4.1.2"],"failures":0}`; `PEER_DRIFT` in verify-lock |
| M0 | Core packages unmoved (lock-diff) | **pass** | `m0-lock-diff.json`: none moved, apart from the intended removal of `@effect/platform-bun` |
| M1 | `pnpm run check` matches the old check | **pass** | `m1-check.md`: 29/29 tasks; test counts identical in all 10 packages |
| M1 | A failing task exits non-zero | **pass** | exit 1 (fail-fast; see below) |
| M1 | A misspelt `pkg#task` fails | **pass** | in `dependsOn`: exit 1; a misspelt task name: exit 1. On the command line, a misspelt **package** exits 0 (noted) |
| M1 | CI | **pass** | run [43335208479](https://github.com/ian-pascoe/t3flare/actions/runs/43335208479) (Node 26.12.1, pnpm 12.14.0, vp 1.4.0; store cache saved) |
| M2 | Fresh stage deploy | **pass** | `stage.ts deploy pnpm --web` exit 0 (57 s, `vp build` from the root workspace); smoke ok, reporting the commit |
| M2 | `acceptance --real-turn --peer --codex` | **pass** | `m2-acceptance.json`: `ok: true`, no failures in realTurn, peer or codex |
| M2 | `name@version` list and stub exports against Bun | **pass, differences explained** | `m2-bundle-bun.json` vs `m2-bundle-pnpm.json`; build-report counts identical; see below |
| M3 | bump dry run, current pin | **pass** | run [43336825359](https://github.com/ian-pascoe/t3flare/actions/runs/43336825359): relock, verify-lock, check 29/29 |
| M3 | Second run against another tag (H3) | **pass for the toolchain; the check fails upstream** | run [43336822219](https://github.com/ian-pascoe/t3flare/actions/runs/43336822219) on `v0.1.10-nightly.20261112.4606`: the lock re-seeded and installed unfrozen in CI, verify-lock passed, then typecheck failed on t3's changes (SPI-1089); rollback clean |
| M3 | Forced-failure rollback (M7) | **pass** | runs [43336828487](https://github.com/ian-pascoe/t3flare/actions/runs/43336828487) (newest tag) and [43337449819](https://github.com/ian-pascoe/t3flare/actions/runs/43337449819) (current pin, `--fail-at check`): `rollback ok`, t3code clean at the old pin, pinned files unchanged, frozen install passed |
| Swap | One commit: Bun files gone, every doc updated, AGENTS.md rule | **pass** | swap commit |
| — | Throwaway stage destroyed | **pass** | `stage.ts destroy pnpm`: 9 resources deleted |

## Findings along the way

- **A seeded lock is not enough on its own** (review M1, now measured). pnpm keys a snapshot by its peers only. When
  one of our packages also installs a t3 package at the same version, pnpm resolves that package's dependencies again
  and takes the highest version already in the lock, which moves t3's importers too. The first real dry run caught
  this (jose under the MCP SDK). gen-workspace now pins each of t3's edges into a name its lock holds at several
  versions (`parent@v>child`). That is 338 overrides, generated and committed. Peers can't be pinned this way, so
  three explained peer drifts stay in `PEER_DRIFT`:
  - `@anthropic-ai/sdk`, the peer of the stubbed claude-agent-sdk;
  - `supports-color`, debug's optional peer;
  - `typescript` 7, from the root.
- **Seeding drops our own importers.** Keeping them let their newer versions win deduplication (tldts); verify-lock
  caught it. Our subtree resolves fresh on each relock; lock-diff and our exact pins guard the core set.
- **Bun ran some of our packages outside their declared ranges.** Its per-name pins forced one version per name. The
  agents bundle now carries:
  - `@anthropic-ai/sdk` 0.129.0, which pi-ai pins exactly (Bun gave it 0.93.0);
  - `capnweb` 0.10.0, which `@cloudflare/computer` asks for as `^0.10.0` (Bun gave it 0.12.0).

  The real turn passed on both. The Environment bundle changed only `yaml` (2.9.1 → 2.9.0, t3's version). The stub's
  34 export names are identical.
- **The nested-workspace hijack, reproduced:** `pnpm run` inside `t3code/packages/shared` installed t3code as a
  workspace (32.8 s). `NPM_CONFIG_WORKSPACE_DIR` stops both pnpm and vp.
- **oxlint's backend** is still tsrslint, proven with a logging wrapper. The strict-peers fix gives oxlint its
  optional `oxlint-tsgolint` peer, but the root `.bin` link wins.
- **Install times** (`m0.json`):
  - pnpm cold store: 19.5 s;
  - pnpm warm, no `node_modules`: 6.6 s;
  - Bun warm: 3.3 s;
  - no-op: pnpm 0.1 s, Bun 0.3 s;
  - CI frozen install: 12.4 s from a cold store.
- **D5:** vite-plus 1.4.0 honours `run.cache: false`. **D7:** `prepare` skips `effect-tsgo patch` when `CI` is set;
  CI's typecheck passed without it.

## Code review

Two passes over `origin/main...pnpm`, done in sequence in this session (no sub-agents were available).

**Standards** (AGENTS.md, ADR-0001, the GLOSSARY, and the smell baseline):

- *Duplicated Code* (fixed): the `name@version` parser and the `patches/deps` key appeared in three scripts. Both now
  live in `scripts/lock.ts`.
- *Possible Speculative Generality*: bump.ts's `--stage` and `--fail-at` exist for the migration's proofs. Kept,
  because the fragility runbook's step 3 wants a throwaway stage, and the rollback proof is worth repeating.
- *Data Clump* (judgement): verify-lock's `VENDORED` list restates gen-workspace's `OUR_OVERRIDES` link entries. They
  are two short lists that change together. Left as they are.
- t3code untouched (ADR-0001): the submodule is clean, and no Patch was added.

**Spec** (plan, review and brief):

- *Done differently*: the plan's store cache saves only on `main`. The pinned setup-vp has no `cache-save` input, so
  every ref saves. That's harmless, because branch caches are scoped.
- *Done differently*: the plan's `bump` stage proof became a temporary checks-only workflow, plus the throwaway stage
  `pnpm` (owner's brief).
- *Not done*: the review's LOW item to measure t3's lockfile-verification cache (`trustLockfile`). CI installs take
  12 s, so it wasn't pursued.
- *Not done*: D7's "confirm `virtualStoreType` stays local". Untested; the store is per-machine on CI.
- *Scope added*: the 338 generated edge pins and `PEER_DRIFT` are beyond the plan. Without them, the H3 run fails on
  the very next nightly.

## For the owner

1. **Merge is yours** (SPI-1090). Pause the nightly, then fast-forward. The first pnpm prod deploy is the final proof.
   Hold bump PRs for the soak (two green nightlies and one more prod deploy).
2. **Run `mise install`**: Node becomes 26.12.1 and pnpm 12.14.0 (t3's). pnpm only warns on a different Node.
3. **vp fails fast.** A red `pnpm run check` shows its first failure, not all of them as check.ts did. Run
   `vp run --last-details`, or rerun after a fix.
4. **The agents Worker's dependencies moved** to their declared versions (`@anthropic-ai/sdk` 0.129.0, `capnweb`
   0.10.0). The acceptance real turn passed, but watch the first prod turns.
5. **The next nightly is broken upstream** (SPI-1089), independent of this work.
6. **`pnpm-workspace.yaml` is long** because of the generated edge pins (U50). Change it only with
   `pnpm run relock`.
