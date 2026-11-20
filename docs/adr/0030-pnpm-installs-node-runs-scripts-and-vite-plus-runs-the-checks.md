# pnpm installs, Node runs scripts, and Vite+ runs the checks

Supersedes the install-and-run half of [ADR-0019](0019-bun-installs-and-runs-scripts-tsrs-typechecks-and-vitest-stays-on-node.md); its other half stays: each package typechecks with `effect-tsgo tsrs`, and Vitest runs on Node.

Under Bun, every nightly bump re-translated t3code's pnpm settings into Bun's. Catalogs, overrides and patch keys were translated, and 1,572 per-name lock pins were written. Bun had no way to express pnpm's `"-"` removals and `parent>child` overrides, so those were dropped, and it skipped a patch that matched nothing without a word (U20). Per-name pins also forced one version of a name on every package, so some of our packages ran outside their declared ranges: pi-ai, which pins `@anthropic-ai/sdk` 0.129.0, ran on 0.93.0. So the repo now uses t3's own toolchain:

- **pnpm** installs, at t3's `packageManager` version. `scripts/gen-workspace.ts` writes the root `pnpm-workspace.yaml` from t3's.
  - Members are our packages plus the t3 packages we import.
  - t3's settings are copied unchanged through an allowlist, and an unknown key fails the bump.
  - t3's patches are kept only for packages we install.
  - Every dependency build script is denied.
  - `verifyDepsBeforeRun` is `error`.
  - It also writes `engines.node`, `packageManager` and `mise.toml`.
- **The lock is seeded from t3's lock.** `scripts/seed-lock.ts` copies t3's importers, packages and snapshots, then pnpm resolves only ours (`scripts/relock.ts` runs both until the workspace settles).
  - `scripts/verify-lock.ts` asserts that each t3 importer's transitive closure equals its closure in t3's lock. Three peer choices that a shared workspace moves are listed in the script with their reasons.
  - pnpm fails on a patch that matches nothing or does not apply.
- **Node runs our scripts** (`node x.ts`, type stripping), at t3's `engines.node`. alchemy then runs under Node with its Oxc loader. `erasableSyntaxOnly` keeps every file strippable.
- **Vite+ runs the check.** `pnpm run check` is `vp run check:all` (root `vite.config.ts`): the same tasks `scripts/check.ts` ran, plus `check:workspace`, run at once and uncached. The bump job runs the whole check (closes U27).
- **tsrs's `tsrs-lint` is oxlint's type-aware backend** (2026-11-13; it replaced the interim `@maschwenk/tsrslint`).
  - Every lint script sets `OXLINT_TSGOLINT_PATH` to the root `node_modules/.bin/tsrs-lint` itself. An inherited value, such as a stale path from another repo's mise `[env]`, otherwise overrides any link, and oxlint fails or lints on another backend.
  - `vp run` passes its tasks the caller's environment; a `process.env` assignment in `vite.config.ts` does not reach them. So the variable is set in the scripts, not the config.
  - `prepare` runs `scripts/link-tsrs-lint.sh`, which links `node_modules/.bin/tsgolint` to `tsrs-lint`. A bare `oxlint --type-aware` and editors then use tsrs-lint when the variable is unset.
- **CI** uses `voidzero-dev/setup-vp` (`.github/actions/setup`). The pnpm store is cached on the lock. Secrets reach only the steps that deploy.

**Nested workspace.** A pnpm or `vp` command whose working directory is inside `t3code/` finds t3's `pnpm-workspace.yaml` and installs t3code as its own workspace. Guards:

- mise, `stage.ts`, `bump.ts`, `relock.ts` and CI export `NPM_CONFIG_WORKSPACE_DIR=<root>`.
- `check:workspace` and `stage.ts deploy` fail when `t3code/node_modules/.pnpm` exists.

**Costs.**

- Installs are slower: a warm install without `node_modules` takes 6.6 s against Bun's 3.3 s, and a cold store 19.5 s.
- vp's runner fails fast, so a red check shows its first failure rather than all of them.
- On the command line, a misspelt package in `vp run <pkg>#<task>` exits 0. `check:all`'s `dependsOn` rejects one.

**Rollback.** The swap is one commit (code, generated files and docs), so `git revert` of it restores Bun, `bun.lock` and the docs at once. Bump PRs made after the swap are held unmerged until two nightlies have passed and prod has deployed once more on pnpm. If one merged anyway, revert only the swap and keep the pin: reverting the pin would run t3 backwards over Durable Object SQLite it has already migrated (review H5). Then regenerate under Bun (`bun scripts/gen-workspace.ts && bun install`).

## Considered Options

- **Stay on Bun**: fastest installs, but the translation and its silent gaps stay.
- **A `.pnpmfile` hook that merges t3's settings at install time**: no generated file, but it hides the effective settings from readers and from Vite+.
- **Wholesale `t3code/apps/*` and `t3code/packages/*` globs**: about 800 more packages (Electron, Expo) and native build gates we never run.
- **`tsx` to run scripts**: we have no syntax that Node's stripping rejects.

Evidence: `docs/steps/pnpm-plan.md` (with its review changelog), `docs/steps/pnpm.md` and `docs/steps/pnpm/`.

## Refinement (in-app updates, ADR-0037, 2026-11-17): a bump keeps t3flare's own resolutions

`seed-lock.ts` now carries t3flare's own importers over from the current lock, with what they install that t3's graph
does not name, and `relock.ts` installs with `--fix-lockfile`, so pnpm keeps those resolutions and mends their references
into t3's graph. Before, every bump re-resolved t3flare's own packages against the registry, so a bump's lock drifted
wherever a registry release had landed since the last one (the first trial: `@smithy/core` 3.40.0 to 3.41.0, through
alchemy's dependencies), and nothing tied that drift to t3. Now a bump's lock moves only where t3 moved (its own graph,
its catalog, overrides and patches), which is what the land check holds it to (ADR-0037 §5). t3flare's own packages move
when their manifests do, or when the owner refreshes them: `pnpm run relock -- --refresh` carries none of their
resolutions over, so pnpm resolves them again, as every relock did before. That is the one way to refresh them, still
through relock; it lands as an ordinary reviewed change, never as an Update. Names t3 installs are still resolved against t3's graph, never
carried over (step 4 above, measured in M0), and `verify-lock.ts` still fails on any move of t3's graph. Measured on
`v0.1.11-nightly.20261117.4851`: verify-lock passed, and the lock's diff was t3's (`@legendapp/list` 3.7.3, its patch
dropped, the peer variants that follow).

## Refinement (official tsrs support, 2026-11-17): oxlint finds tsrs-lint by itself

Since oxlint 1.94.0 and tsrs 0.25.0 ([official support](https://oxc.rs/blog/2026-11-17-faster-type-aware-linting-with-tsrs)),
oxlint `--type-aware` finds tsrs's `tsrs-lint` by itself and prefers it to the `oxlint-tsgolint` that vite-plus brings
(checked: with the variable unset and no link, oxlint 1.94.0 spawned `tsrs-lint headless`). So the two workarounds above
are gone: the lint scripts no longer set `OXLINT_TSGOLINT_PATH`, and `prepare` no longer runs `scripts/link-tsrs-lint.sh`,
which is deleted. An inherited `OXLINT_TSGOLINT_PATH` still overrides oxlint's choice, and the scripts no longer guard
against it: unset a stale one (AGENTS.md). An editor bundling an oxlint older than 1.94.0 no longer gets tsrs-lint
through the link.

## Refinement (SPI-1272, 2026-11-20): relock runs as `node scripts/relock.ts`

`verifyDepsBeforeRun: error` makes pnpm check, before any `pnpm run <script>`, that the install matches the manifests
and the lock, and refuse with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` when it doesn't. Relock is for exactly those states: a
moved pin, an edited manifest, a fresh worktree. So `pnpm run relock` failed every time it was needed, while
`node scripts/relock.ts` always works. The command is now `node scripts/relock.ts`, and `node scripts/relock.ts --refresh`
where the text above says `pnpm run relock -- --refresh`; the root `package.json` has no `relock` script, since it could
run only when nothing needed relocking. `verifyDepsBeforeRun` stays `error`: it protects every other script.
