# Review of `docs/steps/pnpm-plan.md`: go with changes

Fable review, 2026-11-12, read-only at `e5cd0a2` (t3code `24e77473ec`) and the `tools` branch; pnpm, Node and Vite+ facts from their current docs. The direction is sound, but M0 as written cannot produce a successful install, and the rollback story has a hole.

## HIGH

**H1. Copying t3's `patchedDependencies` verbatim while keeping `allowUnusedPatches` unset fails the install.** 20 of the 34 patch keys in the root `package.json` resolve to nothing in `bun.lock` (the expo, react-native, `dbus-next`, `app-builder-lib` and `@alchemy.run/test` patches). `allowUnusedPatches` defaults to false and an unapplied patch fails the install; E5 proves it. Fix: gen-workspace emits only t3 patches whose `name@version` is reachable from the closure importers in t3's lock, keeping the setting false so our two patches stay loud. (Weaker alternative: set it true and have `verify-lock` assert each `patches/deps` key carries a patch hash in the root lock.)

**H2. `tools` merges first, and its vendored packages will not link under pnpm.** On `tools`, `vendor/cloudpid/mcp` and `protocol` depend on `@cloudpid/protocol` and `@cloudpid/config` as `"*"`, not `workspace:`. `linkWorkspacePackages` defaults to false, so `"*"` goes to the registry (404, or a foreign package). Fix: overrides `"@cloudpid/protocol": "workspace:*"` and `"@cloudpid/config": "workspace:*"` in `OUR_OVERRIDES` (or `linkWorkspacePackages: true`); assert in M0 that both resolve as `link:`.

**H3. The bump's `pnpm install` is frozen in CI, and M4 cannot detect it.** `--frozen-lockfile` is true by default in CI when a lockfile is present. §4's plain `pnpm install` after `seed-lock` fails the first nightly whose seeded lock needs an update; M4's first run (`tag=<current pin>`) passes trivially and its second run is optional. Fix: `pnpm install --no-frozen-lockfile` in `bump.ts`; M4's second run against an older or newer tag is mandatory.

**H4. `strictDepBuilds` fails the install on our own dependencies, and D4 points the wrong way.** It defaults to true. Our tree has four packages with install scripts absent from t3's lock and `allowBuilds`: `@google/genai`, `@mongodb-js/zstd`, `node-liblzma`, `protobufjs`. Under Bun no dependency script runs today (`typescript@7.0.2`, the only trusted one, has none). `deploy-prod.yml` sets the Cloudflare, proxy and GitHub App secrets at job level, so any allowed build script sees them. Fix: deny by default; the overlay sets every t3 `true` to `false`, adds the four as `false`, drops the `react-native-enriched-markdown@file:…` key; allow an entry only when proven needed. Move the secrets to the Deploy and Smoke steps.

**H5. Rollback after a merged bump means downgrading t3 on prod.** §7.3's "revert both" moves the pin backwards over Durable Object SQLite the newer pin already migrated. Fix: hold bump PRs unmerged for a stated soak (two green nightlies and one further prod deploy). If a bump merged anyway, revert only the swap and keep the pin (regenerate with `bun scripts/gen-workspace.ts && bun install`). Put the docs in the swap commit, or one `git revert` leaves AGENTS.md and the runbook describing pnpm.

## MEDIUM

**M1. The seeded lock's exactness is unproven.** t3's lock header records `pnpmfileChecksum`, `packageExtensionsChecksum`, `overrides` and `catalogs`; the plan never mentions t3's `.pnpmfile.cjs`. Our root has no pnpmfile and different overrides, so pnpm will probably treat the lock settings as outdated and re-resolve (inferred, untested). E2 used five tiny packages and no multi-version names (ADR-0019 counts 167 in t3's lock). The new `verify-lock` compares only each importer's direct dependencies, so transitive drift passes; M0's exit rule guards the core set only in group (b). Fix: `seed-lock` strips the settings header; `verify-lock` compares the transitive snapshot closure per t3 importer; the core no-move rule applies to all groups. Correct §2.6: the lock has two YAML documents, not three.

**M2. R10's mitigation makes the release-age rule stricter than t3's.** `minimumReleaseAge` defaults to 1440; setting it explicitly flips `minimumReleaseAgeStrict` to true and re-applies the rule to every lock entry unless `trustLockfile` is set. t3 leaves it unset. Fix: don't emit it, or emit it with `minimumReleaseAgeStrict: false`.

**M3. R1 (nested-workspace hijack) is guarded only by convention.** `verifyDepsBeforeRun` defaults to `install`. The planned path is safe today (`@t3tools/web`'s `build` is plain `vp build`), but breaks if t3 changes the script; the same default lets our own `pnpm run` install silently in CI. Fix: `NPM_CONFIG_WORKSPACE_DIR=<root>` in `stage.ts`, `bump.ts` and CI (verify it also stops vp); `verifyDepsBeforeRun: error` in the generated file; `stage.ts deploy` refuses when `t3code/node_modules/.pnpm` exists.

**M4. Generic pass-through of unknown t3 keys is fail-open.** A future `nodeLinker`, `pnpmfile`, `configDependencies`, `injectWorkspacePackages` or path-bearing key would land silently in a nightly (Node refuses TypeScript under `node_modules`, so injection matters most). Fix: allowlist the eleven keys present today; fail the bump on an unknown key ("classify it"), as `capabilities.ts` does.

**M5. The check gate has no red-path evidence.** An unmatched Vite+ `--filter` "prints a warning and exits successfully". Fix: M1 adds a failing dependency task (non-zero exit), a misspelt `pkg#task` (fails), and records whether other tasks still run (`check.ts` reports every failure). `@cloudpid/mcp#typecheck` drops the `--noEmit` that `tools`' `check.ts` passes; the vendored script is bare `effect-tsgo tsrs` and may emit into `vendor/`; use a root task with `--noEmit`.

**M6. `mise.toml` can drift from the generated versions.** gen-workspace writes `packageManager` and `engines.node`, but `mise.toml` is neither generated nor in `PINNED_FILES`; t3's `engines.node` is exact `26.12.1` and pnpm only warns (`engineStrict` false). Fix: generate `mise.toml`, add it to `PINNED_FILES` and the bump's `git add`.

**M7. Milestone gaps.** Nothing exercises the bump's rollback path: add a forced-failure dry run ending with a clean submodule and a passing frozen install. Nothing proves the patches landed: grep a marker line from each `patches/deps` patch and from t3's `alchemy@2.0.0-beta.85` patch in `node_modules`. M2 diffs build-report counts only, while `"-"` removals and `a>b` overrides take effect for the first time (eight on `@anthropic-ai/claude-agent-sdk`, whose stub "silently exports none" on import failure, U9): diff stub export names and the bundled `name@version` list. M1 deploys the `bump` stage from a branch before M2: confirm the `bump` environment admits the `pnpm` branch.

**M8. The swap commit also moves CI from Node 24 to 26 for the workerd tests.** Move `setup-node` to 26 in P1 or its own commit, so R7 fails separately.

## LOW

- §2.5 drops t3's lockfile-verification cache silently; measure the cost or set `trustLockfile`.
- The `~/.vite-plus` cache with a skip-setup-vp branch is a lot of machinery for two workflows; consider plain setup-vp first.
- A fourth Bun API user: `docs/steps/step-2a-part2/gen-proxy-fixtures.ts` (`Bun.spawnSync`); history, say so in §1.3.
- Not checked: the strip-scan counts, the 22-name baseline, E1–E6 (not rerun).

## What checked out

alchemy takes the Node path unless `globalThis.Bun` exists or `npm_execpath` names bun; `stage.ts`'s two-pass deploy is plain `child_process`; the Container image builds from its own `package-lock.json` files with `npm ci`; t3's tsconfig sets `erasableSyntaxOnly`; no tsconfig `paths`, Bun export conditions or `import.meta.dir` in our code; all 33 closure directories are importers in t3's lock; t3's CI action matches §2.5 (including `node-version-file: package.json`); Bun's linker is already isolated, so no hoisting is relied on.

## D1–D11

| | Verdict | Reason |
|---|---|---|
| D1 | Agree, with changes | A committed, diffable file beats the hook; needs H1's patch filter and M4's allowlist. |
| D2 | Agree for pnpm, change for Node | The seeded lock ties us to t3's pnpm; Node should follow too, with `mise.toml` generated (M6). |
| D3 | Agree | `node`; `tsx` adds nothing. |
| D4 | Disagree | Deny all builds by default (H4). |
| D5 | Agree | `run.cache: false` (config tasks cache by default); confirm 1.4.0 honours it. |
| D6 | Agree | Port `p4-push-shapes.ts`, inside P1. |
| D7 | Agree | Skip the `effect-tsgo` patch under `CI`; confirm `virtualStoreType` stays local. |
| D8 | Agree | Separate commit after parity. |
| D9 | Agree | Closes U27 at the cost prod already pays. |
| D10 | Agree strongly | Add the Node 26 CI move to it (M8). |
| D11 | Agree | Conditional on M6. |

## Verdict

Go with changes: H1–H4 fixed in the plan before M0; H5 before cut-over; the MEDIUM items fit inside the existing milestones.
