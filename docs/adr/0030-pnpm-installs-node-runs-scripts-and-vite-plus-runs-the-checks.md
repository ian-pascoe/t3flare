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
