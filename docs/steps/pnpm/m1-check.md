# M1: `pnpm run check` against `bun run check`

Same machine (Apple silicon, Node 26.13.1), worktree `.worktrees/pnpm`. Bun side: the P1 tree (`4cf4c72`, `bun run check`,
then each test task under Bun's install). pnpm side: `pnpm run check` = `vp run --log grouped --concurrency-limit 16 check:all`.

## Tasks

check.ts's 27 tasks map one to one; `check:workspace` is new (gen-workspace `--check`, plus the nested-workspace guard).

| check.ts task | vite.config.ts task | Bun | pnpm |
|---|---|---|---|
| patches | `check:patches` | ok | ok |
| lock | `check:lock` | ok | ok |
| (none) | `check:workspace` | n/a | ok |
| lint (root scripts) | `lint:scripts` | ok | ok |
| typecheck / lint / test | `@t3flare/environment#typecheck`, `#lint`, `#test` | ok | ok |
| typecheck / lint / test (infra) | `@t3flare/infra#…` | ok | ok |
| typecheck / lint / test (agents) | `@t3flare/agents#…` | ok | ok |
| typecheck (cloudpid mcp), `--noEmit` | `typecheck:cloudpid-mcp` (root task, `--noEmit`; review M5) | ok | ok |
| test (cloudpid mcp), 3 excludes | `test:cloudpid-mcp` (root task, same excludes) | ok | ok |
| typecheck / test (mcp-worker) | `@t3flare/mcp-worker#…` | ok | ok |
| typecheck (codemode-sandbox) | `@t3flare/codemode-sandbox#typecheck` | ok | ok |
| typecheck / test × effect-durable, computer-env, github-app, workspace-client, harness-registry | `@t3flare/<name>#…` | ok | ok |

`vp run: 29/29 successful` (28 tasks and `check:all`). Wall time: Bun 32.2 s, pnpm 29.6 s.

## Test counts (Vitest "Tests" line)

Identical in every package:

| Package | Bun | pnpm |
|---|---|---|
| apps/agents | 174 passed, 13 skipped (187) | same |
| apps/environment | 303 passed (303) | same |
| apps/mcp-worker | 42 passed (42) | same |
| infra | 2 passed (2) | same |
| packages/computer-env | 25 passed, 11 skipped (36) | same |
| packages/effect-durable | 48 passed (48) | same |
| packages/github-app | 20 passed (20) | same |
| packages/harness-registry | 13 passed (13) | same |
| packages/workspace-client | 6 passed (6) | same |
| vendor/cloudpid/mcp | 639 passed (639) | same |

## Red path (review M5)

| Case | Result |
|---|---|
| A failing task (`check:lock` replaced by `node -e "process.exit(3)"`) | `pnpm run check` exits **1**. vp fails fast: the tasks still running are killed (exit 137) and the rest never start (`vp run: 7/23 successful`). check.ts reported every failure; vp reports the first. |
| A misspelt package in `check:all`'s `dependsOn` (`@t3flare/environmnt#typecheck`) | exits **1** before running anything: `Failed to lookup dependency … Package '@t3flare/environmnt' not found`. |
| A misspelt task (`vp run '@t3flare/environment#typcheck'`) | exits **1**: `Task … not found`. |
| A misspelt package on the command line (`vp run '@t3flare/environmnt#typecheck'`) | exits **0** and runs nothing (vite-plus 1.4.0). Only the `dependsOn` list gates; nothing in the repo calls `vp run <pkg>#<task>` directly. |
| `vp run --filter <no match> <task>` | exits **0** ("No packages matched the filter") unless `--fail-if-no-match`. |

## Other M1 checks

- **vite-plus 1.4.0 honours** the task-level `cwd` (`check:patches`, the cloudpid tasks), a quoted `--exclude 'conformance/**'`,
  and `run.cache: false` (every task logs `⊘ cache disabled`). Root tasks see only the root's bins on `PATH`, so the vendored
  package's own `vitest` is named by path.
- **tsrslint is oxlint's backend**: with `node_modules/.bin/tsgolint` replaced by a wrapper that logs and execs tsrslint,
  `infra`'s `oxlint --type-aware` ran the wrapper. oxlint now also has its optional peer `oxlint-tsgolint` linked beside it
  (strict peers), and still takes the root `.bin` link.
- **The nested-workspace hazard (R1, review M3)**, reproduced: `pnpm run --if-present x` inside `t3code/packages/shared`
  installed t3code as its own workspace (`t3code/node_modules/.pnpm` appeared, 32.8 s). The same command with
  `NPM_CONFIG_WORKSPACE_DIR=<root>`, and `vp run` likewise, left nothing. mise.toml now exports it for local shells;
  `stage.ts`, `bump.ts`, `relock.ts` and CI set it; `check:workspace` and `stage.ts deploy` fail when the directory exists.
- **CI** (temporary checks-only workflow, no secrets): run
  [43335208479](https://github.com/ian-pascoe/t3flare/actions/runs/43335208479), green on Node 26.12.1, pnpm 12.14.0,
  vp 1.4.0; frozen install 12.4 s from a cold store; `Cache saved with key: vite-plus-Linux-x64-pnpm-9b96…` (620 MB);
  the submodule-clean step passed.
