# Plan: Bun → pnpm + Vite+

Move t3flare's package manager, workspace, script runner and `bun run check` from Bun to pnpm and Vite+ (`vite-plus`,
`@voidzero-dev/vite-plus-core`, the `vp` CLI). This supersedes most of
[ADR-0019](../adr/0019-bun-installs-and-runs-scripts-tsrs-typechecks-and-vitest-stays-on-node.md). Two parts of it stay:
`effect-tsgo tsrs` typechecks each package, and Vitest runs on Node. The `t3code` submodule stays pinned and is not
modified ([ADR-0001](../adr/0001-t3code-is-a-pinned-submodule-changed-by-layer-then-shadow-then-patch.md)).

Written 2026-11-12 against `main` at `e5cd0a2`, with t3code at `24e77473ec`. The migration lands **after the `tools` branch
merges** (§7.2). Evidence comes from reading the repo, from read-only runs in the main checkout, and from small pnpm
experiments in `/tmp/pnpm-exp` (Appendix A). Nothing was installed globally. `node_modules` in the main checkout was not
touched. No credential file was read.

## Review changelog (2026-11-12, implementation)

Fable's review (`pnpm-plan-review.md`) overrides this plan. Each finding is folded in below; where a section further
down disagrees with this changelog, the changelog wins. Re-inventoried at `main` `d54af10` (t3code `24e77473ec`):
`tools` has merged (vendored `@cloudpid/*`, `packages/harness-registry`, `apps/mcp-worker`, `apps/codemode-sandbox`)
and the back-to-stock step removed the push gateway.

**Re-inventory (R12).**

- `apps/agents/scripts/p4-push-shapes.ts` is gone with the push gateway: **D6 is moot.**
- New `bun` spawns: `apps/environment/scripts/tools.ts:318` (`bun scripts/stage.ts deploy tools`); `stage.ts`'s two
  are now `:123` and `:157`.
- `scripts/check.ts` has 29 tasks: the plan's list plus `typecheck`/`test` of `@cloudpid/mcp` (`--noEmit`; tests with
  three excludes), `@t3flare/mcp-worker`, `@t3flare/harness-registry`, and `typecheck` of `@t3flare/codemode-sandbox`.
- `vendor/cloudpid/{mcp,protocol}` depend on `@cloudpid/protocol`/`@cloudpid/config` as `"*"` (H2).
- Bun APIs: `scripts/gen-workspace.ts`, `scripts/verify-lock.ts` and (history, left alone)
  `docs/steps/step-2a-part2/gen-proxy-fixtures.ts`. `vendor/cloudpid/mcp/src/server/caller.ts`'s `"bun"` is a
  User-Agent token, not a spawn.

**Findings.**

| # | Change to the plan |
|---|---|
| H1 | gen-workspace emits only those t3 `patchedDependencies` whose `name@version` is in the snapshot closure of our t3 importers in t3's lock. `allowUnusedPatches` stays unset. |
| H2 | `OUR_OVERRIDES` gets `"@cloudpid/protocol": "workspace:*"` and `"@cloudpid/config": "workspace:*"`; M0 asserts both resolve as `link:`. `vendor/` is not edited. |
| H3 | `bump.ts` runs `pnpm install --no-frozen-lockfile`. The bump proof's second run against another tag is mandatory. |
| H4 / D4 | **D4 follows the review:** every t3 `allowBuilds: true` becomes `false`, `@google/genai`, `@mongodb-js/zstd`, `node-liblzma` and `protobufjs` are added as `false`, and the `react-native-enriched-markdown@file:…` key is dropped. An entry is allowed only when proven needed. `deploy-prod.yml`'s and `bump.yml`'s secrets move from job level to the steps that need them. |
| H5 | Rollback: bump PRs made after the swap are held for a soak (two green nightlies and one further prod deploy). If one merged anyway, revert only the swap, keep the pin, and regenerate under Bun. The docs ride in the swap commit, so one `git revert` restores them too. |
| M1 | `seed-lock` drops t3's settings header (`overrides`, `packageExtensionsChecksum`, `pnpmfileChecksum`, `patchedDependencies`, `catalogs`); pnpm rewrites it for our root. t3's `.pnpmfile.cjs` was read: its only hook, `updateConfig`, guards mobile fork tarballs and widens Windows architectures, and it has no `readPackage`, so not running it at our root changes no resolution. `verify-lock` compares the transitive snapshot closure of each t3 importer. The core no-move rule applies to every lock-diff group. §2.6 is corrected: the lock has **two** YAML documents. |
| M2 | `minimumReleaseAge` is not emitted (R10 dropped); pnpm's default applies, like t3's. |
| M3 | `verifyDepsBeforeRun: error` in the generated file; `NPM_CONFIG_WORKSPACE_DIR=<root>` in `stage.ts`, `bump.ts` and CI; `stage.ts deploy` refuses when `t3code/node_modules/.pnpm` exists. |
| M4 | gen-workspace allowlists the t3 keys present today and fails on an unknown key ("classify it"). |
| M5 | M1 proves the red path: a failing task exits non-zero, a misspelt `pkg#task` fails. `@cloudpid/mcp`'s typecheck is a root task with `--noEmit`. |
| M6 | gen-workspace also writes `mise.toml`'s `node` and `pnpm`; `mise.toml` joins `PINNED_FILES`. |
| M7 | Bump proof adds a forced-failure run (clean submodule, passing frozen install afterwards). M0 greps a marker line of every `patches/deps` patch and of t3's alchemy patch in `node_modules`. M2 diffs the bundled `name@version` list and the stub export names against the Bun build. |
| M8 | CI moves to Node 26 in P1, apart from the swap. |
| LOW | Plain `setup-vp` with its own cache first, no `~/.vite-plus` machinery. `gen-proxy-fixtures.ts` is history (above). |

**Not rebutted.** I found nothing to disprove; M1 is confirmed (two `---` documents; the header carries
`pnpmfileChecksum` and `packageExtensionsChecksum`).

**Owner-directed changes to the rollout** (2026-11-12 brief): `deploy-prod.yml` and `bump.yml` are not dispatched from the
branch. CI is proved by a temporary checks-only workflow, deleted afterwards (as SPI-1087 did). The bump proof runs
`bump.ts` on the throwaway stage `pnpm`, not `bump`. Milestones are renumbered: P1, M0 install, M1 check, M2 stage
deploy + acceptance + bundle diff, M3 bump proof (current pin, another tag, forced failure), then the swap.

## 0. Summary

- **Workspace**: a root `pnpm-workspace.yaml`, generated from `t3code/pnpm-workspace.yaml` by a much smaller
  `scripts/gen-workspace.ts`. It lists our packages and the t3 packages we import, which today is the same 33-directory
  closure. t3's `catalog`, `overrides`, `packageExtensions`, `patchedDependencies`, `allowBuilds`, peer rules and
  release-age exemptions are copied **verbatim**, with no translation, so nothing gets flattened or dropped. t3's own
  `pnpm-workspace.yaml` and `pnpm-lock.yaml` are untouched, and a root install ignores them.
- **Lock**: the root `pnpm-lock.yaml` is **seeded from t3's own lock**. Its importers are re-keyed under `t3code/`, and
  pnpm keeps the seeded resolutions. This replaces the 1,660 per-name `overrides` and `scripts/lock-pins.report.md`.
  `verify-lock` then tightens from "20 of 950 differ" to "t3's importers resolve exactly as in t3's lock".
- **Patches**: `patches/deps/*.patch` move unchanged into pnpm `patchedDependencies`. The format is the same, and pnpm
  fails the install on an unused patch, which closes U20's silent case and T9.
- **Scripts**: run with **Node's built-in type stripping**: `node scripts/x.ts`, on Node 26, which is t3's
  `engines.node`. All 334 of our `.ts` files, and the 1,678 non-web t3 files our scripts and build import, are
  erasable-only. Three files use Bun APIs; `yaml` and `node:http` replace them.
- **Check**: `pnpm run check` becomes `vp run check:all`, a root `vite.config.ts` task that `dependsOn` each package's
  `typecheck`/`lint`/`test`, plus root tasks for patches, workspace drift, lock and script lint. `scripts/check.ts` goes
  away.
- **CI**: `voidzero-dev/setup-vp` (Node and pnpm from `package.json`), the pnpm store cached on
  `hash(pnpm-lock.yaml, pnpm-workspace.yaml, package.json)`, and `vp install --frozen-lockfile`. This copies t3's own
  `setup-ci-deps` action.
- **Rollout**: four milestones on a throwaway stage. Rollback is one `git revert` of the cut-over commit, because the Bun
  files are deleted in that same commit.

## 1. Inventory: every Bun touchpoint

Counts are taken on `main` (`e5cd0a2`), excluding `t3code/`, `node_modules/` and `bun.lock`. "→" gives the replacement;
§2 explains each one.

### 1.1 Workspace and dependencies

| Where | What | → |
|---|---|---|
| `package.json` | `packageManager: bun@1.4.4`; `workspaces.packages` (`apps/*`, `packages/*`, `infra`, plus 33 `t3code/…` dirs); `workspaces.catalog` (64 entries, t3's); `overrides` (**1,660**: t3's translated overrides plus every single-version package in t3's lock); `patchedDependencies` (34: 32 `t3code/patches/*`, 2 `patches/deps/*`); `trustedDependencies: ["typescript"]`; 6 scripts (5 call `bun`) | `packageManager: pnpm@<t3's>`, `engines.node`; workspace fields move to `pnpm-workspace.yaml`; `overrides` and `trustedDependencies` deleted |
| `bunfig.toml` | `linker = "isolated"`, `globalStore`, `minimumReleaseAge = 86400`, `minimumReleaseAgeExcludes` (rewritten by gen-workspace) | deleted. pnpm is isolated by default; t3's `minimumReleaseAgeExclude` is copied |
| `bun.lock` | 406 KB, 1,283 package entries | `pnpm-lock.yaml`, seeded from t3's lock (§2.6) |
| `scripts/gen-workspace.ts` (189 lines) | t3 package closure from `T3_ROOTS = ["t3", "@t3tools/web"]`; `Bun.YAML` ×2; flattens `a>b` overrides and drops `"-"` removals (pnpm-only); pins every single-version package in t3's lock (`:76-130`); `@effect/platform-node-shared` hold (`:132-133`); keys `patches/deps`; rewrites `bunfig.toml`; writes `scripts/lock-pins.report.md` | rewritten to about 80 lines that emit `pnpm-workspace.yaml` (§2.1) |
| `scripts/lock-pins.report.md` | the untranslatable remainder | deleted, because nothing is translated any more |
| `scripts/verify-lock.ts` (49 lines) | `Bun.YAML`; parses `bun.lock` as JSONC; counts versions that differ from t3's lock; exits 1 on a second `effect` | reads `pnpm-lock.yaml`; asserts exact equality for t3 importers (§2.6) |
| per-package `package.json` (10, all `"type": "module"`) | `catalog:` specs (1 to 8 per package); `workspace:` deps; `@effect/platform-bun` in `apps/environment` and `infra`, **imported nowhere** (only a comment in gen-workspace mentions it) | `catalog:`/`workspace:` work as is in pnpm; drop `@effect/platform-bun` |
| `mise.toml` | `bun = "1.4.4"` ("keep equal to `packageManager`") | `node = "<t3's engines.node>"`, `pnpm = "<t3's>"` (or `vp env`; §8) |

### 1.2 Dependency patches

- `patches/deps/@alchemy.run__cloudflare@2.0.0-beta.85.patch` (282 lines) and
  `patches/deps/@earendil-works__pi-durable@1.5.0.patch` (162 lines). Both are git diffs with `a/`/`b/` paths relative
  to the package root and full `index` hashes, made by `bun patch`. t3's 32 patches have the same shape (made by
  `pnpm patch`), and Bun applies them today.
- Bun applies them through root `patchedDependencies`, which `gen-workspace.ts:139-148` writes, keying each from its
  filename (`@scope__name@ver`). A key that matches nothing is skipped silently, and `bump.ts:138` also filters "no
  longer applies" lines out of the install step's detail (U20, T9).
- The check's **patch step** is different. `bun build.ts --check` (`apps/environment/build.ts:377-381`) runs
  `git apply --check` on the three **t3 Patches** `patches/000{1,2,3}-*.patch` against the pinned submodule. It doesn't
  involve the package manager. It already runs under Node: `node build.ts --check` → `ok` ×3 (read-only).

### 1.3 Scripts

- **`spawn("bun", …)` sites: 28, in 3 files.**
  - `scripts/check.ts`: 14 (`:25-39`).
  - `scripts/bump.ts`: 12 (`:126`, `:135-181`).
  - `apps/environment/scripts/stage.ts`: 2. `:114` runs `bun run prepare:web`. `:148` runs
    `bun scripts/<script>.ts` for `stage.ts run <stage> <script>`.
- **`package.json` scripts that call `bun`: 14, in 4 files.**
  - root: `gen:workspace`, `build:web` (`bun run --filter @t3tools/web build`), `check`, `bump`, `test:docker`.
  - `apps/environment`: `build`, `prepare:web` (`bun run --cwd ../../t3code/apps/web build`, i.e. t3's `vp build`),
    `deploy`, `destroy`, `dev`, `acceptance`.
  - `apps/agents`: `build`.
  - `infra`: `ci:setup` (`… && bun allow-actions-prs.ts`), `github-app:setup`.
- **Usage comments** (`// bun scripts/x.ts …`, `bun run …`): 112 lines in 57 `.ts` files. Most are the headers of the
  46 scripts in `apps/environment/scripts/`. Others are in `build.ts`, `alchemy.run.ts`, `vitest.docker.config.ts`,
  `test/docker/cli.docker.test.ts`, `apps/agents/test/gitPatch.test.ts:96` and `infra/github*.ts`.
- **Bun-only APIs: 3 files.**
  - `scripts/gen-workspace.ts:46,84` and `scripts/verify-lock.ts:22` use `Bun.YAML.parse`.
  - `apps/agents/scripts/p4-push-shapes.ts:61,68` uses `Bun.serve` and `Bun.gunzipSync`. It's a step-era fixture
    generator that `check` doesn't run.
  - No file imports `bun:*` or `"bun"`.
  - `import.meta.main` appears in `apps/{environment,agents}/build.ts`. Node ≥ 24.2 has it.
- **Type-stripping hazards: none.** I checked with Node 26.13.1's `module.stripTypeScriptTypes(…, {mode: "strip"})`
  (scanner in Appendix A).
  - The 59 runnable entry points have 0 non-erasable constructs, 0 extensionless relative imports and 0 JSON imports
    without attributes. These are `scripts/*.ts`, `apps/*/scripts/*.ts`, `apps/*/build.ts`, `alchemy.run.ts`,
    `stage-files.ts` and `infra/*.ts`.
  - All 330 of our `src`/`test` files have none either.
  - The 1,678 non-web `.ts` files of the 33 t3 member packages have none. t3 runs its server as
    `node src/bin.ts`.
  - Top-level `await` appears in 37 entry points. That's fine, because every package is `"type": "module"`.
  - `apps/web`'s `.tsx` files aren't strippable (797 hits), but Vite builds them, not Node.
- **Live runs under Node** (read-only, no network): `node apps/environment/scripts/stage.ts` prints its usage and
  exits. That covers its imports of `build.ts`, `agents/build.ts` and `rolldown`. `import("@t3tools/contracts")`
  resolves 1,867 exports. `node build.ts --check` passes.

### 1.4 CI (`.github/workflows/`)

- `bump.yml` and `deploy-prod.yml` both run `oven-sh/setup-bun@v2` (`bun-version-file: package.json`), then
  `actions/setup-node@v4` (`node-version: 24`, "Vitest stays on Node"), then `bun install --frozen-lockfile`. **Neither
  caches** anything.
  - `bump.yml` runs `bun run bump …`.
  - `deploy-prod.yml` runs `bun run check`, then `bun scripts/stage.ts deploy "$STAGE" --web`, then
    `bun scripts/stage.ts run "$STAGE" smoke "$GITHUB_SHA"`.
  - Both have header comments naming `bun run --cwd infra ci:setup` and `github-app:setup`.
- `linear-project.yml` doesn't use Bun.

### 1.5 Build and deploy

- `apps/environment/build.ts` and `apps/agents/build.ts` bundle with Rolldown (ADR-0020) and run as plain Node too. One
  caveat: `build.ts:233` `await import()`s stubbed dependencies to read their export names. Under Node, that works on
  any JS or erasable TS, which the scan above covers.
- **alchemy doesn't need Bun.** `stage.ts` spawns `node_modules/.bin/alchemy` (`#!/usr/bin/env node`). alchemy's
  `bin/cli.js` runs under Bun only if `globalThis.Bun` exists, or if `npm_execpath` names bun (as in `bun run deploy`).
  Otherwise it runs under Node through its own Oxc loader (`bin/register-oxc.js`, Node ≥ 22.22.3 or 24.11.1). That
  loader transpiles `alchemy.run.ts` and everything it imports outside `node_modules`.
  - Under pnpm, alchemy always takes the Node path. The stage script's two-pass deploy (`stage.ts:125-135`) doesn't
    change, because it's plain `child_process`.
- `prepare:web` runs t3's `vp build` in `t3code/apps/web` (with Vite+, already today), then
  `git -C ../../t3code checkout -- apps/web/src/routeTree.gen.ts` and `rsync`. It has to move to `--filter` (§2.1).

### 1.6 Tooling

- `prepare` runs `effect-tsgo patch --typescript && ./scripts/link-tsrslint.sh`.
  - The first part patches `node_modules/typescript` **in place**, for editors. Under pnpm, that file is linked from
    the content-addressed store: hard links on Linux, clones on APFS. See risk R4.
  - The second part symlinks `node_modules/.bin/tsgolint` to tsrslint's binary, for `oxlint --type-aware`. Its comments
    say "after every `bun install`".
- oxlint (`1.91.0`, root devDependency) runs from each package's `lint` script. Root bins reach package scripts under
  both `pnpm --filter` and `vp run` (Appendix A, E6).
- vitest `5.0.5`, with `vite` overridden to `npm:@voidzero-dev/vite-plus-core@1.4.0` and `vite-plus` `1.4.0` from t3's
  catalog, so tests already run on Vite+'s core.
- `mise.toml` holds `bun = "1.4.4"`. The machine already has `node` 26.13.1, `pnpm` 12.18.0 and `vp` 1.6.0 through mise.
- **The Container image's Bun stays.** `apps/sandbox-image/image/mise.toml:10` (`bun = "1.4.4"`, beside
  `node`/`pnpm`) is a Toolchain the agents use inside the Container (BASE_MISE_TOML, `src/toolchains.ts`, kept equal by
  a test). `apps/agents/src/extensions/bash-routing.ts:64` lists `bun bunx` as commands agents may type. Neither is
  ours. Only the coincidence that both say `1.4.4` goes away.

### 1.7 Docs and runbooks

- 119 mentions in 30 Markdown files. The ones that tell a reader what to run are:
  - `README.md`: 8, at lines 23, 32, 35-37, 41-42 and 44.
  - `AGENTS.md:5`: "passed `bun run check`".
  - `docs/upstream-fragility.md`: 11. The runbook is at `:23-24` and `:35`. Entries: U9 `:115`, U20 `:199-203`,
    U24 `:233`, U27 `:253-259`, and the T1 and T9 rows at `:364` and `:372`.
  - ADR-0017 `:5`, ADR-0019 (all of it), and ADR-0020 `:5`.
  - `docs/model-proxy.md:120`.
- The rest are dated step reports and plans in `docs/steps/**`, which stay as history.

## 2. Decisions

### 2.1 Workspace shape: a generated root `pnpm-workspace.yaml` over the t3 closure

**Recommendation.**

- `scripts/gen-workspace.ts` writes the root `pnpm-workspace.yaml` (committed) and the root `package.json`'s
  `packageManager`.
- `packages` lists our globs (`apps/*`, `packages/*`, `infra`, and `vendor/cloudpid/*` from `tools`) plus the t3
  directories reachable from `T3_ROOTS` through `workspace:` deps. That's the same closure code as today: 33 directories
  at `24e77473ec`.
- Every other top-level key of `t3code/pnpm-workspace.yaml` is copied **verbatim**, comments aside. Today those keys are
  `catalog`, `overrides` (including `"-"` removals and `a>b` edges), `packageExtensions`, `allowBuilds`,
  `strictPeerDependencies`, `peerDependencyRules`, `permissions`, `publicHoistPattern` and `minimumReleaseAgeExclude`.
  The copy is generic: any key except `packages` passes through, so a new t3 setting arrives on its own.
- Three keys are adjusted on the way:
  - `patchedDependencies`: t3's paths are prefixed `t3code/`, and `patches/deps/*.patch` is appended. Same key rule as
    today, and it fails on a key t3 already patches.
  - `allowBuilds`: our overlay is applied on top (§8, D4).
  - `packages`: ours, as above.
- `--check` regenerates in memory and exits 1 on a diff. It's a `check:all` dependency, so a hand edit or a stale file
  can't land.
- Parsing and emitting use the `yaml` package (`catalog:` → `2.9.x`, already in t3's catalog). That replaces `Bun.YAML`.

**Why not the alternatives.**

| Option | Evidence | Verdict |
|---|---|---|
| **Wholesale globs** `t3code/apps/*`, `t3code/packages/*` | t3's lock has 43 importers and **2,085** packages: desktop (Electron), mobile (Expo, React Native), marketing, relay. `bun.lock` holds 1,283 for our closure. Wholesale would add about 800 packages, Electron/Expo native build gates (`allowBuilds`), and peer conflicts we never run, all against the owner's low-resource ask. It also adds failure modes for the nightly bump in code we don't ship. | rejected |
| **No generated file: a `.pnpmfile.mjs` `updateConfig` hook** that reads `t3code/pnpm-workspace.yaml` at install time and merges `catalogs.default`, `overrides` and `patchedDependencies` | Works (Appendix A, E4, with `yaml` as a `configDependencies` entry so the hook can parse YAML before any install). The lock records `pnpmfileChecksum` plus the merged `catalogs`/`overrides`, so a frozen install still catches drift. | **fallback**. It hides the effective settings from readers, editors and Vite+, relies on pnpm's hook semantics (resolved config only since 12.4.1), and adds a config dependency. A bump PR then shows no settings diff, only a lock diff |
| **Hand-copied `pnpm-workspace.yaml`** | Drifts on every bump | rejected |

**t3's own `pnpm-workspace.yaml` and `pnpm-lock.yaml` inside the parent.**

- A root `pnpm install` ignores both.
- t3 packages get `node_modules` symlinks into the root virtual store, exactly as with Bun today. Those are gitignored
  by t3, so the submodule stays clean (E1: `git status` empty).
- **Hazard (E3).** pnpm and vp find the workspace root by walking up to the nearest `pnpm-workspace.yaml`. A
  `pnpm run`, `pnpm --dir t3code/…`, or `vp -C t3code/…` whose working directory is inside `t3code/` treats t3code as
  its own workspace. pnpm 12's verify-deps-before-run then **installs it**: `t3code/node_modules/.pnpm` appears and the
  t3 packages' links get repointed.
- From the root, `pnpm --filter <name> run <script>` and `vp run <name>#<task>` are safe, and so is `vp exec` (E3).
  Rules that follow:
  - `prepare:web` becomes `pnpm --filter @t3tools/web run build && …`, run from `apps/environment`, whose nearest
    workspace is ours. The root `build:web` becomes `pnpm --filter @t3tools/web run build`.
  - Nothing else cds into `t3code/` except `git -C t3code …`, which is fine.
  - The rule goes into AGENTS.md (§9).
- t3's `packageManager` (`pnpm@12.14.0`) and its lock's env document (`packageManagerDependencies`) are t3's. The
  root's `packageManager` is generated from t3's, so the bump moves pnpm with upstream (§8, D2).

**`gen-workspace.ts` after the change.** It keeps:

- `T3_ROOTS`, `OUR_WORKSPACES` and the closure walk (`:15-43`);
- the `patches/deps` keying (`:135-148`).

It loses:

- the override translation (`:52-77`), the lock pinning (`:79-131`) and the `platform-node-shared` hold (`:132-133`);
- the `bunfig.toml` rewrite (`:160-169`) and the report (`:171-189`).

It gains the YAML emit and `--check`. The script goes from about 190 lines to about 80. **Nothing is translated any
more, so U20's "untranslated pnpm settings" class of fragility goes away.**

### 2.2 Patches: pnpm `patchedDependencies`, same files

- **Format is compatible.** `bun patch` and `pnpm patch` both write a git-style unified diff with paths relative to the
  package root (`diff --git a/lib/… b/lib/…`). Our two files have that shape, as do t3's 32. Bun applies t3's
  pnpm-made patches today, and pnpm applied a Bun-shaped `--full-index` patch in E1.
- **File names stay.** pnpm's own naming, which t3 uses, is `@scope__name@version.patch`, the same as
  `patches/deps/`. They stay in `patches/deps/` (not pnpm's default `patches/`) so ADR-0001's count of t3 Patches
  (`patches/000N-*.patch`) is unaffected.
- **Wiring.** The generated `pnpm-workspace.yaml` gets
  `"@alchemy.run/cloudflare@2.0.0-beta.85": patches/deps/@alchemy.run__cloudflare@2.0.0-beta.85.patch`, and likewise
  for pi-durable. The lock records each patch's hash, so editing a patch changes the lock, and a frozen install fails
  until it's committed.
- **Stricter by default.** pnpm fails the install on a patch whose key matches nothing (`ERR_PNPM_UNUSED_PATCH`, E5)
  and on a patch that doesn't apply. That's exactly the silent case in U20 and the gap T9 / SPI-1018 tracks. Keep
  `allowUnusedPatches` unset (false), and delete the "no longer applies" filter at `bump.ts:138`.
- **Re-cutting.** Run `pnpm patch <pkg>@<ver>`, edit, then
  `pnpm patch-commit <dir> --patches-dir patches/deps`. pnpm writes the key into the workspace file, and the next
  `gen-workspace.ts` run reproduces it. Update U20's "Fix" line from `bun patch`.
- **The check's patch step doesn't change.** `node apps/environment/build.ts --check` (`git apply --check` of the t3
  Patches) becomes the `check:patches` task.

### 2.3 Script runner: Node's type stripping (`node scripts/x.ts`)

| Option | Fit | Verdict |
|---|---|---|
| **`node x.ts`** (Node 26, t3's `engines.node` `26.12.1`; strip-only, on by default since 23.6/22.18) | Every file we run, and every t3 file they import, is erasable-only, with explicit `.ts` relative imports (§1.3 scan). `stage.ts`, `build.ts --check`, `agents/build.ts` and `@t3tools/contracts` ran live under Node 26.13.1. t3 itself runs its server as `node src/bin.ts`. alchemy already runs under Node when not launched by bun (§1.5). | **recommended** |
| `vp` | `vp run` runs `package.json` scripts and `vite.config.ts` tasks: it's the **task runner** (§2.4), not a TS runtime. `vp exec` runs `node_modules/.bin` commands. vp 1.6.0 has no "run this file" command, and `vite-node` was dropped with Vitest 4's module runner. | task runner only |
| `tsx` | Would also handle non-erasable syntax and extensionless imports, but we have none. It's one more dependency and a second loader beside alchemy's Oxc one. | not needed |

**Changes.**

- **Package scripts.** `bun x.ts` → `node x.ts`. `bun run <s>` → `pnpm run <s>` (or `vp run <s>`).
  `bun run --cwd infra ci:setup` → `pnpm --filter @t3flare/infra run ci:setup`.
- **Spawns.** For `.ts` files, `spawnSync("bun", [file])` → `spawnSync(process.execPath, [file])`. That's
  `stage.ts:148` and `bump.ts`'s `gen-workspace`, `verify-lock`, `build.ts --check` and `stage.ts` calls. Package
  scripts are spawned as `pnpm run <s>` (`stage.ts:114`, `bump.ts:149-155`). `bump.ts:126,137` →
  `pnpm install` (§2.6 for the seed).
- **Bun APIs.**
  - `Bun.YAML.parse` → `import { parse } from "yaml"`. This needs a root devDependency, `"yaml": "catalog:"`.
  - `p4-push-shapes.ts`: port to `node:http` plus `zlib.gunzipSync` (about 10 lines), or delete it with its step-era
    fixtures (§8, D6).
- **Guard.** Add `"erasableSyntaxOnly": true` to each of our tsconfigs. `tsrs` then rejects an enum or a parameter
  property at typecheck instead of at `node` time. Our `.ts` import specifiers already satisfy
  `allowImportingTsExtensions`.
- **Usage comments.** The 112 lines in 57 files get a mechanical `bun scripts/` → `node scripts/`, `bun build.ts` →
  `node build.ts` and `bun run` → `pnpm run` rewrite, reviewed as one diff.
- **Node version.**
  - `package.json` `engines.node` is generated from t3's.
  - `mise.toml` sets `node` to the same version.
  - CI uses setup-vp's `node-version-file: package.json`.
  - That moves CI from Node 24 to 26, which is what local runs already use (26.13.1). M1 (§7) proves the workerd
    Vitest project on 26 in CI.

### 2.4 `bun run check` → `pnpm run check` = `vp run check:all`

`scripts/check.ts` is a hand-rolled parallel runner. That's exactly what `vp run` already does: `dependsOn` across
packages (`pkg#task`), concurrency, grouped logs and a failure summary. The root package becomes a Vite+ workspace
root, with `vite-plus: catalog:` as a devDependency and a root `vite.config.ts` like this:

```ts
// The repo's checks (was scripts/check.ts). `pnpm run check` runs `check:all`; every task below must pass to push to main.
import { defineConfig } from "vite-plus";

const each = (pkg: string, ...tasks: Array<string>) => tasks.map((task) => `${pkg}#${task}`);

export default defineConfig({
  run: {
    cache: false, // parity with check.ts first; caching is owner decision D5
    tasks: {
      "check:patches": "node apps/environment/build.ts --check", // t3 Patches apply (git apply --check)
      "check:workspace": "node scripts/gen-workspace.ts --check", // pnpm-workspace.yaml matches the pinned t3code
      "check:lock": "node scripts/verify-lock.ts", // t3's importers resolve as in t3's lock; one effect
      "lint:scripts": "oxlint scripts",
      // tools: the vendored cloudpid tests minus the repo-layout ones, without editing vendor/ (its README)
      "test:cloudpid-mcp": {
        command:
          "vitest run --exclude conformance/** --exclude src/import-rule.test.ts --exclude src/sdk-isolation.test.ts",
        cwd: "vendor/cloudpid/mcp",
      },
      "check:all": {
        command: "node -e \"\"",
        dependsOn: [
          "check:patches", "check:workspace", "check:lock", "lint:scripts",
          ...each("@t3flare/environment", "typecheck", "lint", "test"),
          ...each("@t3flare/infra", "typecheck", "lint", "test"),
          ...each("@t3flare/agents", "typecheck", "lint", "test"),
          ...["effect-durable", "computer-env", "github-app", "workspace-client"].flatMap((name) =>
            each(`@t3flare/${name}`, "typecheck", "test")),
          // after `tools` merges: harness-registry (typecheck, test), mcp-worker (typecheck, test),
          // codemode-sandbox (typecheck), @cloudpid/mcp#typecheck, test:cloudpid-mcp
        ],
      },
    },
  },
});
```

- **Root `package.json` scripts:**
  - `"check": "vp run --log grouped --concurrency-limit 12 check:all"`. check.ts starts all 20 tasks at once; vp's
    default limit is 4.
  - `"bump": "node scripts/bump.ts"` and `"gen:workspace": "node scripts/gen-workspace.ts"`.
  - `"build:web": "pnpm --filter @t3tools/web run build"`.
  - `"test:docker": "pnpm --filter @t3flare/environment run test:docker"`.
  - `"prepare"`: see §8, D7.
- **Order.** check.ts runs everything in parallel, and so does `check:all`. Its dependencies don't depend on each
  other, so it's the same set and the same ordering.
- **The task list stays explicit, like check.ts's.** `vp run -r typecheck` would also run the 33 t3 member packages'
  own `typecheck`/`lint`/`test`. A `--filter '!./t3code/**'` could exclude them, but the explicit list keeps parity: it
  leaves out `sandbox-image`, `models` and `session-protocol`'s `typecheck`, as today (§8, D8).
- **To verify in M1, against the pinned `vite-plus` 1.4.0** (the docs describe 1.6): the task-level `cwd`, and a string
  task with `&&`/quoted args. A fallback for either is a package script in a non-vendored package, or a tiny
  `node -e` wrapper.
- **Bump reuse.** `bump.ts` runs `pnpm run check` instead of the environment-only typecheck, lint and test. That closes U27
  / T1 for free, since the cost is the same as prod's deploy job. If owner decision D9 keeps the bump lean, it runs
  `vp run check:env` instead, a narrower task.
- **Output.** `vp run` prints each task's log grouped and a summary with failing tasks. `--last-details` shows the full
  detail. That replaces check.ts's "last 40 lines of each failure".

### 2.5 CI

One composite action, `.github/actions/setup/action.yml`. It's t3's `.github/actions/setup-ci-deps` without the
maintainer task cache.

1. **Vite+, Node and pnpm.** `voidzero-dev/setup-vp@<sha>` with `node-version-file: package.json`, `cache: false` and
   `run-install: false`. It installs `vp`, the `engines.node` Node and the `packageManager` pnpm.
2. **Cache `~/.vite-plus`.** Key it `vite-plus-home-v1-${os}-${arch}-${vite-plus}-node${node}-${pnpm}`. On a hit, skip
   setup-vp and run `vp env use <node>` (t3's npm-outage guard).
3. **Restore the pnpm store.** Find the path with `vp pm cache dir`. Use `actions/cache/restore@v4`, keyed
   `pnpm-v1-${os}-${arch}-${hashFiles('pnpm-lock.yaml','pnpm-workspace.yaml','package.json')}`, with the
   `pnpm-v1-${os}-${arch}-` restore-key.
4. **Install** with `vp install --frozen-lockfile`. CI defaults to frozen anyway; the flag documents it.
5. **Save the store** with `actions/cache/save@v4`, only when the restore missed the exact key and the ref is `main`.
   The scheduled bump and the prod deploy both run on `main`, so branches only read.

**Workflow edits.**

- `deploy-prod.yml`:
  - Replace setup-bun, setup-node and `bun install` with `uses: ./.github/actions/setup`.
  - `bun run check` → `pnpm run check`.
  - Deploy: `node scripts/stage.ts deploy "$STAGE" --web`.
  - Smoke: `node scripts/stage.ts run "$STAGE" smoke "$GITHUB_SHA"`.
  - Update the header comment's `bun run --cwd infra …` lines.
- `bump.yml`:
  - Same setup.
  - `bun run bump "${args[@]}"` → `pnpm run bump "${args[@]}"`.
  - Add a `dry_run` boolean input. It drops `--commit` and skips "Propose the new pin". M4 uses it.
- **Submodule checkout** stays by hand (`git submodule update --init t3code`), for the same nested-gitlink reason.
- **The image's Bun** isn't involved, because the image builds from its own mise lock.

Expected effect: today neither workflow caches anything. Each run downloads Bun and does a cold `bun install` of 1,283
packages. With the store cached on the lock hash, a run with an unchanged lock links from cache.

### 2.6 Lockfile resolution risk

**Baseline** (`bun scripts/verify-lock.ts --list`, read-only, today): 968 package names are shared with t3's lock. **22**
of them resolve to versions t3's lock doesn't have:

- `@cloudflare/workers-types`, `@rolldown/pluginutils`, `ansi-regex`, `commander`, `cookie`, `diff`, `encodeurl`;
- `ignore`, `magic-string`, `mime`, `negotiator`, `on-finished`, `oxlint`, `readdirp`;
- `semver`, `string-width`, `supports-color`, `typescript`, `unbash`, `yaml`, `yargs`, `zod`.

There's one `effect` (4.1.2). These are what per-name overrides can't express (multi-version names), plus our own
direct dependencies.

**Seed from t3's lock instead of pinning.** Same package manager, same lock format (v9), so t3's resolutions can be
reused directly. A new `scripts/seed-lock.ts` (about 60 lines) runs at migration and in every bump:

1. Take the **main document** of `t3code/pnpm-lock.yaml`, the one with `settings`/`importers`. It's the second of two
   YAML documents. Skip the env document (`packageManagerDependencies`), which pnpm writes for our root.
2. Keep only the importers in the closure. Re-key each `apps/server` → `t3code/apps/server`. Their `link:` specifiers
   are relative between t3 directories, so they stay valid.
3. Merge in our importers and their `packages`/`snapshots` entries from the current root `pnpm-lock.yaml`, if it
   exists. On a key clash, t3's entry wins.
4. Run `pnpm install` (not frozen). pnpm keeps every seeded resolution that still satisfies a spec, resolves only new
   specs, and prunes the rest.

**Evidence** (E2, scaled down):

- A fresh resolve took `ms@2.1.3`, while the sub-workspace's lock had `2.0.0`.
- After seeding, both the sub-workspace's importer *and a new parent importer* with the same `^2.0.0` range got
  `2.0.0`.
- That held when the parent's `overrides` differed from the seed's.
- `--frozen-lockfile` then passed.

**Afterwards.**

- The 1,660 `overrides` go, and so does `lock-pins.report.md`.
- `verify-lock.ts` asserts that **every t3 importer's dependency resolves to exactly the version in t3's lock for that
  importer**, with peer suffixes stripped, and expects 0 differences. It still reports the shared-name diff for
  information and still fails on a second `effect`.
- The 22 multi-version and edge cases converge, because each t3 importer now gets t3's exact graph. Only our own
  importers can pull other versions, which is correct.

**Our own subtree: diff before and after.** The rest of the tree is ours alone: `@earendil-works/*`,
`@cloudflare/computer`, `wrangler`, `@cloudflare/vitest-plugin`, `@alchemy.run/github` and their dependencies. pnpm
resolves it fresh unless something pins it. M0 runs a one-off `docs/steps/pnpm/lock-diff.ts`. It reads `bun.lock`
(JSONC) and `pnpm-lock.yaml` (`yaml`) into name → versions, and prints three groups:

- (a) moved to t3's version (expected);
- (b) ours-only and changed;
- (c) added or removed.

**Exit rule for M0.**

- One `effect@4.1.2`.
- No change in (b) for any of `alchemy`, `@alchemy.run/*`, `wrangler`, `workerd`, `miniflare`, `@cloudflare/*`,
  `@earendil-works/*`, `rolldown`, `vitest`, `vite-plus`, `@voidzero-dev/*`, `typescript`, `@effect/tsgo*`, `oxlint*`,
  `@maschwenk/tsrslint`, `effect`, `@effect/*` or `zod`.
- If any of those moves, pin it to the `bun.lock` version in gen-workspace's small, commented `OUR_OVERRIDES`
  (`"name@range": "x.y.z"`; pnpm also accepts `parent>child`). Expect few or none: our direct dependencies are exact
  except `@cloudflare/workers-types` and `typescript`.
- Every other (b) line goes into the step report with a one-word judgement.

## 3. Changes, file by file

| File | Change |
|---|---|
| `pnpm-workspace.yaml` (new, generated) | §2.1 |
| `vite.config.ts` (new, root) | §2.4 |
| `.github/actions/setup/action.yml` (new) | §2.5 |
| `scripts/seed-lock.ts` (new) | §2.6 |
| `docs/steps/pnpm/lock-diff.ts` (new, one-off evidence) | §2.6 |
| `pnpm-lock.yaml` (new) | seeded, then `pnpm install` |
| `package.json` | Delete `workspaces`, `overrides`, `patchedDependencies` and `trustedDependencies`. Set `packageManager` and `engines.node` (generated from t3). Add devDependencies `vite-plus: catalog:` and `yaml: catalog:`. Rewrite scripts (§2.4); `bump` → `node scripts/bump.ts` |
| `bunfig.toml`, `bun.lock`, `scripts/lock-pins.report.md`, `scripts/check.ts` | delete |
| `scripts/gen-workspace.ts` | §2.1: emit YAML, `--check`, `yaml` instead of `Bun.YAML`, no translation or pinning |
| `scripts/verify-lock.ts` | §2.6: read `pnpm-lock.yaml`, assert t3 importers exact, one `effect` |
| `scripts/bump.ts` | §4 |
| `scripts/link-tsrslint.sh` | comment only ("after every `pnpm install`"; it also cites a wrong ADR, `0028-…` → cloudpid's). Logic unchanged (§8, D7) |
| `mise.toml` | `bun` → `node`/`pnpm` at t3's versions, with a comment that `gen-workspace` keeps `package.json` in step |
| `apps/environment/package.json` | Scripts: `build` → `node build.ts`; `prepare:web` → `pnpm --filter @t3tools/web run build && git -C ../../t3code checkout -- … && rsync …` (§2.1 hazard); `deploy`/`destroy`/`acceptance` → `node scripts/…`; `dev` → `node build.ts && wrangler dev …`. Drop `@effect/platform-bun` |
| `apps/agents/package.json` | `build` → `node build.ts` |
| `infra/package.json` | `ci:setup` → `… && node allow-actions-prs.ts`; `github-app:setup` → `node github-app-setup.ts`. Drop `@effect/platform-bun` |
| `apps/environment/scripts/stage.ts` | `:114` → `spawnSync("pnpm", ["run", "prepare:web"], …)`; `:148` → `spawnSync(process.execPath, [script, …])`; usage strings → `node scripts/stage.ts` |
| `apps/agents/scripts/p4-push-shapes.ts` | port to `node:http`/`node:zlib`, or delete (§8, D6) |
| 57 `.ts` files with usage comments | mechanical rewrite (§2.3) |
| our `tsconfig.json`s | `"erasableSyntaxOnly": true` |
| `.github/workflows/{bump,deploy-prod}.yml` | §2.5 |
| `.gitignore` | Nothing new is needed: `node_modules/` already covers pnpm's `node_modules/.pnpm`. Add `.vite-plus/`/`node_modules/.vite` only if M1 shows Vite+ writing a task cache in the tree |
| docs | §9 |
| `docs/adr/00NN-pnpm-and-vite-plus-…md` (new) | supersedes ADR-0019's install/run half (§6) |

## 4. `scripts/bump.ts` after

```
PINNED_FILES = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]

move t3code to <tag>                      git -C t3code checkout <tag>
regenerate the workspace and install      node scripts/gen-workspace.ts
                                          node scripts/seed-lock.ts
                                          pnpm install            (no "no longer applies" filter: an unused or failing
                                                                   patch now fails this step, U20/T9)
lock matches t3's, one effect             node scripts/verify-lock.ts
check                                     pnpm run check            (whole check; closes U27/T1. Includes patches)
CLI agents in Docker                      pnpm --filter @t3flare/environment run test:docker
deploy the bump stage                     node scripts/stage.ts deploy bump --web           (cwd apps/environment)
acceptance                                node scripts/stage.ts run bump acceptance …       (unchanged args)
stock t3 nightly links (peer-laptop)      node scripts/stage.ts run bump peer-laptop …
rollback                                  git -C t3code checkout <from>; git checkout -- PINNED_FILES;
                                          pnpm install --frozen-lockfile
```

- `sh("bun", …)` becomes `sh(process.execPath, …)` for `.ts` files and `sh("pnpm", …)` for scripts.
- The report's `lockPins` field becomes `lock: <verify-lock's JSON line>`. bump.yml's `jq` summary changes to match.

**Why bumps get less fragile.**

- The three things that go stale on every bump today were hand-translated: the catalog and overrides, the per-name
  lock pins, and the patch keys. They're now copied verbatim (catalog, overrides, patches) or reused as is (the lock).
- What's left to fail is real: a t3 change our code doesn't compile against, a patch that no longer applies (now loud),
  or a resolution our own packages force.

## 5. Command cheat sheet (for README and runbooks)

| Was | Now |
|---|---|
| `bun install` | `pnpm install` (or `vp install`) |
| `bun run check` | `pnpm run check` |
| `bun run bump [...]` | `pnpm run bump [...]` |
| `bun scripts/gen-workspace.ts` | `pnpm run gen:workspace` (`node scripts/gen-workspace.ts`) |
| `bun run --cwd apps/environment deploy <stage>` | `pnpm --filter @t3flare/environment run deploy <stage>` (`run` is required: `pnpm deploy` is a pnpm command) |
| `cd apps/environment && bun scripts/stage.ts run <stage> <script> …` | `cd apps/environment && node scripts/stage.ts run <stage> <script> …` |
| `bun run --cwd infra ci:setup` / `github-app:setup` | `pnpm --filter @t3flare/infra run ci:setup` / `run github-app:setup` |
| `bun build.ts` | `node build.ts` |
| `bun patch <pkg>` | `pnpm patch <pkg>@<ver>` → `pnpm patch-commit <dir> --patches-dir patches/deps` → `pnpm run gen:workspace` |
| `bun run --cwd ../../t3code/apps/web build` | `pnpm --filter @t3tools/web run build` (never with a cwd inside `t3code/`) |

## 6. ADR

Write a new ADR, "pnpm installs, Node runs scripts, Vite+ runs the checks; tsrs typechecks and Vitest stays on
Node". It supersedes ADR-0019's install and run half and keeps its tsrs and Vitest half. ADR-0019 gets a
"Superseded by" line and is otherwise left as written.

- **Context.** ADR-0019 chose Bun for install speed (cloudpid measured a warm `bun install` at about a third of
  pnpm's wall time) and accepted the translation script.
- **Decision drivers.** Alignment with upstream (the same package manager, workspace file format, lock and Vite+
  toolchain as t3), and bump fragility (no translation, the lock is reused, patches fail loudly).
- **Cost.** Installs get slower. M1 measures it: warm and cold `pnpm install` against `bun install` on the same tree.
- Also update ADR-0017's job description and ADR-0020's deploy command line.

## 7. Rollout

### 7.1 Milestones

All work happens in `.worktrees/pnpm` (gitignored), on branch `pnpm` cut from `main` **after `tools` has merged**. The
throwaway stage is `pnpm`, added to `STAGES` in `stage.ts`. Evidence goes in `docs/steps/pnpm/`.

| | What | Exit evidence |
|---|---|---|
| **P1** (optional, landable alone; §8, D10) | **Node runs our scripts, Bun still installs.** Replace `Bun.YAML` with `yaml`, `bun x.ts` with `node x.ts` in package scripts and spawns, port p4-push-shapes, and add `erasableSyntaxOnly`. Node 24 in CI already strips types and has `import.meta.main`. | `bun run check` green. Prod deploys through the normal path on push. This takes runtime risk off the package-manager swap |
| **M0** | **Install.** Run `gen-workspace`, then `seed-lock`, then `pnpm install`. Run `lock-diff.ts` and `verify-lock.ts`. Time a cold install (empty store under `/tmp`) and a warm one, against `bun install` on the same commit. | `m0-lock.json`: lock-diff groups (a)/(b)/(c), verify-lock with **0** t3-importer differences and `effect` = `["4.1.2"]`, and install times. `git -C t3code status --porcelain` is empty, and `t3code/node_modules/.pnpm` doesn't exist |
| **M1** | **`bun run check` equivalence.** On `main` run `bun run check`, and on `pnpm` run `pnpm run check`, on the same machine. Compare `vp run --dry-run --json check:all` with check.ts's task list. Compare Vitest's "Tests N passed" per package and the oxlint/tsrs exit codes. Verify the vite-plus 1.4.0 task `cwd` and the `vendor/cloudpid/mcp` excludes. Check that tsrslint's `tsgolint` link resolves (`oxlint --type-aware` finds a backend). Then push the branch and run **`deploy-prod.yml` by hand with `stage: bump`**, which exercises the new setup action, the cache and CI's Node 26 workerd tests. | `m1-check.md`: a side-by-side task table (name, ok, seconds), test counts equal, the CI run URL, and the cache save/restore lines |
| **M2** | **A full stage deploy.** `cd apps/environment && node scripts/stage.ts deploy pnpm --web`. A brand-new stage exercises the two-pass path. Then `node scripts/stage.ts run pnpm smoke <sha>`. Diff `dist/build-report.json` (the `fsAlias`/probe counts, U9) against a `bun build.ts` of `main`. | Deploy exit 0, the two-pass line seen, smoke ok, and the build-report diff with every difference explained (expected: none in counts) |
| **M3** | **Acceptance.** `node scripts/stage.ts run pnpm acceptance --real-turn --peer --codex --out ../../docs/steps/pnpm/m3-acceptance.json`. Codex is the one CLI, because it's the cheapest real turn and the most exercised path. | `m3-acceptance.json` with `ok: true`. Then `node scripts/stage.ts destroy pnpm` |
| **M4** | **`bump.yml` dry run.** `gh workflow run bump.yml --ref pnpm -f force=true -f dry_run=true -f tag=<current pin>`. The current pin isolates the toolchain from upstream changes. If the newest nightly differs, a second run without `tag` exercises a real seed-from-a-new-lock. | The run URL and its `bump-report.json` artifact (`ok`, every step green, the `lock` line), with no branch pushed and no PR |

### 7.2 Cut-over order

1. **`tools` merges first.** It changes `package.json` (`vendor/cloudpid/*`), `bun.lock` (+485 lines), `scripts/check.ts`
   (+13) and four new packages. Starting after it means the migration regenerates once, rather than merging two
   lockfile rewrites. The plan already lists `tools`' check tasks (§2.4).
2. Land P1, if the owner takes D10, through the normal path: `bun run check`, a fast-forward to `main`, and the prod
   deploy.
3. Branch `pnpm`, then run M0 → M1 → M2 → M3 → M4.
4. **Pause the nightly** for the cut-over day (`gh workflow disable bump.yml`). Close any open `bump/<tag>` PR made
   under Bun, because its `bun.lock` won't rebase.
5. Squash the swap into **one commit**, "pnpm and Vite+ replace Bun (ADR-00NN)", with docs in the same or the next
   commit. Fast-forward it to `main`. `deploy-prod.yml` then deploys prod through the new path. That deploy is the final
   exit evidence: run URL, smoke ok, and the admin health route reporting the commit.
6. Re-enable the nightly (`gh workflow enable bump.yml`). The first scheduled run is the steady-state proof.

### 7.3 Rollback

- **Before step 5**, nothing is on `main` except P1, which works under Bun anyway.
- **After step 5:**
  - Run `git revert <swap commit>` and fast-forward it to `main`. The swap commit deleted `bun.lock`, `bunfig.toml`,
    `check.ts` and the Bun steps in the workflows, so the revert restores them all at once. The revert's push redeploys
    prod through the Bun path, which is already proven.
  - Locally, remove the pnpm-installed tree (`node_modules`, `apps/*/node_modules`, `packages/*/node_modules`, and
    `t3code/{apps,packages}/*/node_modules`), then run `bun install`.
  - A bump merged after the swap (a `pnpm-lock.yaml` change) blocks a clean revert. In that case revert both and let
    the next nightly bump re-pin under Bun.
- **Trigger:** prod's deploy job fails in a way not fixable within the day, or the first two nightly bumps fail on
  something the toolchain introduced (as opposed to upstream).

## 8. Risks and owner decisions

### 8.1 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Nested-workspace hijack.** Any pnpm or vp command with a cwd inside `t3code/` installs t3code as its own workspace and repoints the t3 packages' links (E3). | No script cds into `t3code/` (§2.1). An AGENTS.md rule. `check:workspace` also fails when `t3code/node_modules/.pnpm` exists, so the state is caught rather than debugged |
| R2 | **t3's `strictPeerDependencies: true` now covers our packages.** An unmet peer in `@cloudflare/vitest-plugin`, `wrangler` or `@earendil-works/*` fails resolution. | M0 finds them. gen-workspace merges a commented `OUR_PEER_RULES` into `peerDependencyRules`. Keep strict: it catches the drift it was made for |
| R3 | **Install scripts start running.** Bun ran only `typescript`'s (`trustedDependencies`). t3's `allowBuilds` enables `esbuild`, `node-pty` (prebuild, else `node-gyp rebuild`) and `sharp`. | D4: an overlay that sets `node-pty: false` and `sharp: false` (the Worker never loads either) and keeps t3's other entries |
| R4 | **`effect-tsgo patch --typescript` writes into `node_modules/typescript`.** Under pnpm that's a store-linked file: hard links on Linux CI, so the edit lands in the store that CI then caches. | D7: skip the patch when `CI` is set. `typecheck` runs `effect-tsgo tsrs` directly and never needs it; the patch only serves local editors (where APFS clones keep the store clean) |
| R5 | **Slower installs.** ADR-0019 cites about 3× wall time for pnpm's warm install against Bun's. | The CI store cache (§2.5) and pnpm's global store locally. M0 measures it; the ADR records the number |
| R6 | **Vite+ 1.4.0 lacks a task feature the docs (1.6) show** (task `cwd`, string quoting). | M1 verifies it. Fallbacks are in §2.4. `vite-plus` moves with t3's catalog, so it upgrades itself |
| R7 | **CI's Node moves from 24 to 26** (t3's `engines.node`) for the workerd Vitest project. | Local runs already use 26.13.1. M1 runs CI on 26. If it fails, pin `engines.node` ourselves (D2) |
| R8 | **alchemy always runs under Node + Oxc**, where `bun run deploy` used to hand it to Bun. | CI already calls `bun scripts/stage.ts` directly. M2 deploys a fresh stage, and M4 deploys `bump` |
| R9 | **Our own subtree resolves fresh** (`@earendil-works/*`, `@cloudflare/computer`, `wrangler`). | lock-diff group (b) in M0, and `OUR_OVERRIDES` pins for the named core set (§2.6) |
| R10 | **pnpm's release-age default.** t3's yaml sets only `minimumReleaseAgeExclude`; bunfig sets one day. | gen-workspace emits `minimumReleaseAge: 1440` (minutes) explicitly, so our rule doesn't depend on pnpm's default |
| R11 | **Version skew.** The global `vp` 1.6.0 and mise's `pnpm` 12.18.0 differ from the pinned versions. | `vp` defers to the local `vite-plus`, and pnpm 12 switches itself to `packageManager` |
| R12 | **The `tools` branch grows more Bun touchpoints before it merges.** | Re-run the §1 counts (one `rg` each) at M0 and update this plan's tables |

### 8.2 Owner decisions

Recommendations are in bold.

- **D1. Workspace mechanism.** **A generated, committed `pnpm-workspace.yaml` with a `--check`**, or the
  `.pnpmfile.mjs` `updateConfig` hook (E4). §2.1.
- **D2. Who pins pnpm and Node?** **Follow t3:** gen-workspace copies `packageManager` and `engines.node`, so each bump
  moves them. The alternative is to pin them ourselves and move them by hand.
- **D3. Script runner.** **`node` with type stripping**, or `tsx`. §2.3.
- **D4. `allowBuilds`.** **t3's, with `node-pty` and `sharp` set to `false`**, or t3's verbatim (R3).
- **D5. Vite+ task cache.** **Off at cut-over** (`run.cache: false`, the same as check.ts). A later change can turn it
  on for `typecheck`/`lint` with explicit inputs, as t3 does with `--cache`.
- **D6. `apps/agents/scripts/p4-push-shapes.ts`.** **Port it to `node:http`/`node:zlib`**, about 10 lines, so its
  fixtures stay reproducible. The alternative is to delete it.
- **D7. `prepare`.** **Keep `effect-tsgo patch --typescript` and `link-tsrslint.sh`, but skip the patch under `CI`**
  (R4). Alternatives: drop the patch entirely and use the Effect LSP in editors, or move to `effect-tsgo vp`.
- **D8. Typechecks check.ts never ran** (`sandbox-image`, `models`, `session-protocol`). **Add them to `check:all`
  after M1's parity run.** They're cheap.
- **D9. The bump runs the whole `pnpm run check`.** **Yes**, which closes U27/T1. The alternative keeps the
  environment-only subset.
- **D10. Split the runtime change (P1) from the package-manager swap.** **Yes.** It's landable alone, and halves what
  the swap commit can break.
- **D11. Local toolchain.** **mise pins `node` and `pnpm`; CI uses setup-vp.** The alternative is `vp env` everywhere.

## 9. Doc updates (in the swap commit or the one after)

- **`README.md`**: line 32's tool list becomes Node and pnpm at the `mise.toml` versions, then `pnpm install`. Apply
  §5's cheat sheet to lines 23, 35-37, 41-42 and 44.
- **`AGENTS.md`**:
  - line 5: "passed `pnpm run check`".
  - New rule: "Run t3 package scripts from the repo root with `pnpm --filter`/`vp run <pkg>#<task>`. Never run pnpm or
    vp with a working directory inside `t3code/`: that installs it as its own workspace."
- **`docs/upstream-fragility.md`**:
  - Runbook `:23` → `git -C t3code checkout <tag> && pnpm run gen:workspace && node scripts/seed-lock.ts && pnpm install && pnpm run check`.
  - Runbook `:24` and `:35`: the command names.
  - **U9** `:115`: `node build.ts`.
  - **U20** `:197-203`:
    - Where: generated `pnpm-workspace.yaml`, verbatim copy, lock seeded from t3's.
    - Detection: pnpm fails on an unused or unappliable patch, and verify-lock is exact.
    - Fix: `pnpm patch`/`patch-commit --patches-dir patches/deps`.
    - Drop the "Silent" sentence and `bump.ts:133`.
  - **U24** `:233`: "runs `pnpm run check`".
  - **U27** `:253-259`: closed by D9. Mark it fixed, or delete it with its T1 row `:364`.
  - **T9** `:372`: closed by pnpm's `ERR_PNPM_UNUSED_PATCH`; link SPI-1018 for closure.
  - **New entry**: "the root workspace is generated from t3's `pnpm-workspace.yaml`, and the lock is seeded from t3's
    lock". Where, breaks when (t3 renames or splits a package in the closure, adds a workspace-only setting pnpm
    rejects at the root, or changes the lock document layout that `seed-lock.ts` reads), detection (`check:workspace`,
    `seed-lock` or install errors, verify-lock), fix.
- **ADRs**: a new ADR (§6), plus "Superseded by" on ADR-0019. Update the command lines in ADR-0017 `:5` and
  ADR-0020 `:5`.
- **`docs/model-proxy.md:120`**: `pnpm --filter @t3flare/infra run ci:setup`.
- **Header comments**: in `.github/workflows/*.yml`, `infra/github.ts`, `infra/github-app-setup.ts` and
  `scripts/link-tsrslint.sh`.
- **`GLOSSARY.md`**: only if it defines "Lock pins" or similar. It doesn't mention Bun today.
- **Left as history**: dated step reports and plans in `docs/steps/**`, and `docs/spike/**`.

## Appendix A. Evidence runs

All runs were read-only in the main checkout, or under `/tmp`. Tools: Node 26.13.1, pnpm 12.18.0, vp 1.6.0.

- **Strip scan** (`/tmp/pnpm-plan-scan/strip-scan.mjs`):
  - For each file it runs `module.stripTypeScriptTypes(src, { mode: "strip" })` and records any throw. It also flags
    extensionless relative imports (`from "./x"`), `.json` imports without `with {}`, and top-level `await`.
  - Inputs: 59 entry points, 330 of our files, and 3,226 files from the t3 closure (1,678 after excluding `apps/web`
    and `.tsx`).
  - Results: 0/0/0 for ours and for non-web t3. Web `.tsx`: 797 hits, which is expected, because Vite builds those.
- **Live runs under Node**:
  - `node apps/environment/scripts/stage.ts` (usage).
  - `node -e 'await import("@t3tools/contracts")'` from `apps/environment` (1,867 exports).
  - `node -e 'await import("../agents/build.ts")'`.
  - `node apps/environment/build.ts --check` (3 × `ok`).
  - `git status` was clean afterwards.
- **Baseline**: `bun scripts/verify-lock.ts --list` → `{"shared":968,"differing":22,"effectCopies":["4.1.2"]}`.
- **pnpm experiments** (`/tmp/pnpm-exp`, store `/tmp/pnpm-exp/.store`, 5 tiny registry packages). `sub/` stands in for
  `t3code/`: its own `pnpm-workspace.yaml` (catalog, an `a>b` override, a patch), lock, and git repo.
  - **E1.** A parent `pnpm-workspace.yaml` lists `app` and `sub/packages/*`, generated by copying sub's sections and
    prefixing the patch path. The install resolves `catalog:`, applies the `a>b` override and applies the Bun-shaped
    patch. `git -C sub status` is empty.
  - **E2.**
    - A fresh parent resolve drifted (`ms@2.1.3`, where sub's lock had `2.0.0`).
    - Seeding the parent lock from sub's lock (importers re-keyed `sub/…`) kept `2.0.0` for sub's importer and for the
      parent's new importer.
    - `--frozen-lockfile` then passed.
    - `2.0.0` held with parent `overrides` that differed from the seed's.
  - **E3.**
    - `pnpm run` inside `sub/packages/a` created `sub/node_modules/.pnpm` and repointed `a`'s links. So did
      `vp -C sub/packages/a run …`.
    - `pnpm --config.verify-deps-before-run=false run …` didn't.
    - From the parent, `pnpm --filter @sub/a run …`, `vp run @sub/a#…` and `vp exec` (inside sub) didn't.
  - **E4.** A `.pnpmfile.mjs` `updateConfig` hook, with `yaml` as a `configDependencies` entry, merged sub's
    `catalog`/`overrides`/`patchedDependencies`. The install resolved and patched, and the lock recorded
    `pnpmfileChecksum`, `catalogs` and `overrides`.
  - **E5.** A `patchedDependencies` entry for a version nothing resolves fails with `ERR_PNPM_UNUSED_PATCH`.
  - **E6.** A root devDependency's bin is on `PATH` for a member's script under `pnpm --filter` and `vp run`.
