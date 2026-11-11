# Step 2a, part 1: Durable agents on the proxy key

Date: 2026-11-10 to 2026-11-11. Branch `step-2a`. t3code is still pinned at **`v0.1.9-nightly.20261110.4478`**,
and the submodule is untouched. Plan: `docs/steps/step-2a-plan.md` (rev 3).

The cloud Environment now runs Durable agents. A pi-durable Harness runs per thread in a Session DO in a second
Worker (`agents`). It works on a Workspace DO: a `@cloudflare/computer` file system, with a Container started
only for real binaries. The agent has the coding tools, and approvals follow t3's runtime modes. Checkpoints and
diffs are made in the Workspace DO with isomorphic-git, and git in the Container covers clone, push and PR
through a GitHub App. The stock desktop client did the whole exit path against the stage: clone, an edit and
`bash`, an approval, the diff, push and PR, and a restart mid-turn that continued.

## Exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| From the stock desktop client: clone a repo | **PASS** | `m5-desktop-paired.png`, `m5-desktop-clone.png` |
| … run a turn that edits files and runs `bash` | **PASS** | `m5-desktop-turn.png`, `m5-desktop-thread.json` |
| … approve a tool call | **PASS** | `m5-desktop-approval.png` (the edit and `bash test.sh` each waited for Approve) |
| … see the diff | **PASS** | `m5-desktop-diff.png` |
| … push and open a PR | **PASS** | `m5-desktop-pr.png` (fixture PR #3, then closed and its branch deleted) |
| An Environment restart mid-turn recovers by continuation | **PASS** | `m5-desktop-restart-before.png`, `m5-desktop-restart-after.png` ("T3 Code restarted and resumed this turn"); `m5-restart.json` (five tool turns in a row, plus the approval and continuation-off variants) |
| `bun run check` passes | **PASS** | about 11 s |

All evidence is in `docs/steps/step-2a/` and consists of the scripts' own JSON output and screenshots.

## Milestones

- **M0, foundations** (`m0-foundations.json`, `m0-r1-*.png`, `pi-durable-version.json`).
  - Both Workers deploy. The agents Worker has no public URL, and the cross-Worker DO bindings work in both
    directions.
  - The Container image is cloudpid's, trimmed: Ubuntu 26.04, mise toolchains and computerd. The first build
    took 389 s under amd64 emulation, and a redeploy with the same context is a no-op.
  - The Container uses the `cpu-1` custom size. Its cold start for a first command is about 17–18 s.
  - `ContainerBudget` caps Containers at 3, with renewed leases.
  - Paths: `/w/<id>` is bind-mounted over `/workspace/repo` in the Container.
  - R1 is settled: the stock client accepts the unknown driver kind `piDurable`.
  - pi-durable is pinned at cloudpid's 1.5.0 plus its patch. Upstream 1.5.2 lacks `ToolExecutionApi.progressed`,
    which durable approvals need.
- **M1, chat without tools** (`m1-chat.json`, `m1-liveness.json`, `m1-restart*.json`, `m1-lost.json`).
  - The driver, adapter and differ work: streaming text and reasoning, Stop, steer, a generated title, and
    usage.
  - The Session pushes over DO RPC, with a liveness push and the orphan answer.
  - The inverse guard ends a lost turn in about 150 s.
  - Restart with continuation works on text turns.
- **M2, Workspaces** (`m2-clone.json`, `m2-*.png`).
  - Clone works into `/w/<repo>`, as do the file tree, file view, client edits, `@` search and New project.
  - The process router is at `ChildProcessSpawner`: git goes to the Container, `gh auth token` gets the
    Environment token, and everything else is "not found".
  - An unlisted `/w` id fails without touching a DO.
- **M3, tools, approvals and diffs** (`m3-acceptance.json`, `m3-fidelity.json`, `m3-memory.json`, `m3-*.png`).
  - The coding tools are `read`, `write`, `edit`, `bash` with Worker Shell/Container routing, `ls`, `find`,
    `grep`, and the AGENTS.md section.
  - The `permissions` wraps cover the three runtime modes. An approval survived a forced Session restart and 7
    heartbeat reruns (more than `restartLimit` 5).
  - Checkpoints are made in the Workspace DO. Its diffs matched the Container's git byte for byte, 110 of 110.
  - Question-only and edit-only turns left the Container stopped.
  - Passive git reads with the Container stopped are served as stale reads (see the ADR-0009 refinement).
- **M4, push and PR** (`m4-pr.json`, `m4-*.png`).
  - From the web client, "Commit, push & PR" opened fixture PR #1, with the commit message and PR text written
    by our text generation.
  - A push that changes `.github/workflows/` is refused without the Workspace's opt-in and accepted with it.
- **M5, recovery, guardrails and acceptance** (`m5-restart.json`, `m5-guardrails.json`, `m5-acceptance.json`,
  `m5-agent-push.json`, `m5-desktop-*`).
  - Restart mid-`bash` passed five times in a row. Each recovered in 42–51 s, and the continuation run reran
    the command and completed.
  - With an approval pending: no continuation. t3 expires the request (`not_resumable`), and the Session aborts
    the turn and withdraws the request within about 62 s.
  - With continuation off: the run is cancelled and the Session's turn is aborted.
  - The 2 h cap, shortened to 2 min on the stage, ends the turn as **failed** with "The turn ran longer than 2
    hours".
  - A fourth concurrent Container start is refused by the budget.
  - `acceptance.ts --real-turn --push` passed on the stage: a fresh clone, an approval-required turn, the
    checkpoint, and PR #2, which was then closed.
  - The agent's own `git push` from `bash` succeeded through the on-demand credential helper. Its push to
    another installed repo failed.
  - The desktop client run is in the table above.

## Deviations from the plan (agreed with root during the step)

1. **The router sits at `ChildProcessSpawner`, not `VcsProcess`** (M2). t3's `GitVcsDriverCore` spawns git
   directly, so `VcsProcess` would miss it. Accepted.
2. **Passive git reads never start the Container** (M2's cache-miss start was rejected). With the Container
   stopped, a read gets its last real answer, patched with the Write journal. The patched shapes are status,
   `diff-index` numstat, `ls-files --others`, and the review diffs against HEAD or a merge base. The git-dir
   reads, and review diffs staged in a temporary index, get the last answer alone. The plan's emulated
   isomorphic-git read table (router step 3) is replaced by this. Tests: `apps/agents/test/staleReads.test.ts`
   compares the patched answers with real git, 4 cases × 6 argv shapes. Recorded as an ADR-0009 refinement.
3. **New project is a Patch, not a Shadow** (`0002-new-project-root-is-w.patch`, one line against a 472-line
   module). Recorded as an ADR-0001 refinement: a Patch beats a large Shadow when the change is tiny.
4. **R5 (memory) moved to M3**, where isomorphic-git arrived.
5. **Our `VcsDriverRegistry` takes only `checkpoints.*` to the DO.** `detectRepository`, `listRemotes` and the
   other reads stay stock, through the router, which now never starts a Container for them.
6. **The approval-restart test runs in Node** on a restarting faux-provider Harness, plus one deployed run, not
   in workerd. The Node test fails if `api.progressed` is removed; I checked this by hand.
7. **No separate `image` tool**: pi-durable's `read` returns images. cloudpid's `call-diff`, `images`,
   `result-bounds`, `instructions` and `outputs` were not copied (see the slice measurement below).
8. **The agent's own `git push` was moved into M5** at root's request. It is not deferred to part 2.

## Counts: Patches, Shadows, Build shims

| Kind | Count | Items |
|---|---|---|
| Patch | **2** | `0001-lazy-server-browser-ref-namespace.patch` (step 1), `0002-new-project-root-is-w.patch` |
| Shadow | **1** | `apps/server/src/provider/builtInDrivers.ts` → `[PiDurableDriver]` |
| Build shim | **6** (unchanged) | the `node:fs` alias (45 imports in 39 modules), `node:module`, the `node:sea` stub, the claude-agent-sdk stub, the `import.meta` defines |
| Layers (ours) | many | routing `FileSystem`, `WorkspaceEntries`, `WorkspaceFileSystem`, the `VcsDriverRegistry` checkpoints wrapper, the process router, HomeDirectory `/w`, the automatic fetch turned off |

Bundle: environment Worker 8.9 MB, agents Worker 3.6 MB. The t3code submodule is unchanged.

## How entangled cloudpid's extension slices were

| cloudpid file | Here | How |
|---|---|---|
| `bash-routing.ts` (1,511 lines) | copied whole | no imports beyond a type |
| `coding-tools.ts` (462) | 202 | the Images binding, call-diff and codemode diffs cut; `bash` exit code added to `details` |
| `files.ts` (681) | 117, rewritten | its Effect tool wrapper, `outputs.ts` and the conversation target were too entangled to bring along |
| `agents-md*.ts` (574) | 42, the section only | the per-file read wraps depend on cloudpid's Harness service and frozen sections |
| `approvals.ts` (425) | `permissions.ts`, 250 | the durable wait (store keyed by task, `progressed`, settle) re-implemented without Effect, and the protocol's approval cards removed |
| `change-log.ts` (apps/server) | copied whole | |
| `changes.ts` (1,294) | not copied | `gitRepo.ts`/`gitPatch.ts` (522) do checkpoints and git-format patches directly |
| `computer-env` package | copied whole | `.cloudpid` became `.t3flare`, and `containerEnv` was added for the image's mise environment |

## ADR updates (in this branch)

- **0001**: a Patch beats a large Shadow when the change is tiny, because `git apply --check` flags drift. With
  the step's counts.
- **0004**: restart recovery proven with tools, and with an approval pending. An aborted tool's Container
  process may survive (see notes).
- **0009**: a passive git read never starts the Container: last answer plus the Write journal, with the shapes
  listed. Checkpoints and the turn diff come from the Workspace DO, with an alias above the guard.
- **0013**: the three permission lists; the Environment token through `gh auth token`; the Container token per
  command or from the on-demand credential helper; workflows opt-in per Workspace.
- **0014**: R5 measured; the 2,000-file guard holds and no third Worker is needed.
- `GLOSSARY.md`: **Approval**, **Write journal**, **Stale read**, **Container token**, **Environment token**.

## Fixes the deployed runs found

- The router treated `git branch -- <name>` (t3's branch creation) as passive; it is now an action.
- t3's temporary indexes (`GIT_INDEX_FILE` in t3's own temp directory) do not exist in the Container. The router
  copies each one into `/workspace/.t3flare/tmp` on first use.
- Remote git had no credentials. t3's push, fetch and pull now get the Container token in that command's
  environment. The agent's git asks the Workspace DO through computer's egress host, via our `WorkspaceProxy`
  subclass. A Workspace DO woken by id rather than name keeps its Workspace id in storage.
- The agent's Container commands lacked the image's mise environment, so git's shim failed. `computer-env`
  gained `containerEnv`.
- The 2 h cap was shown as "interrupted". The differ now maps the deadline's abort to failed.
- The bump job had never run in CI. Fixed: the checkout of t3code's nested gitlinks, a missing `dist/web`, and
  a first deploy to a new stage (the cross-Worker DO bindings now deploy in two passes).

## Owner actions

1. **Commit identity**: commits are authored `t3flare <t3flare@users.noreply.github.com>` (`T3FLARE_GIT_NAME` and
   `T3FLARE_GIT_EMAIL` on the agents Worker override it). Root is asking you.
2. **The desktop app**: I added the `step2a` stage as the environment "t3flare" in your T3 Code (Nightly) settings,
   under Environments. The stage is destroyed now, so remove that entry (Settings → Environments → ⋯ → Remove)
   if I did not.
3. **Fixture repo** `ian-pascoe/t3flare-fixture`: PRs #1–#3 are closed and their branches deleted; `main` is
   unchanged. Keep it for the bump job's real turn.
4. Nothing else: the GitHub App, `ci:setup` and the bump environment's secrets were done in M0.

## What part 2 and 2b should know

- **Aborted tool processes.** Aborting a `bash` call cancels it in pi-durable, but the process in the Container
  can keep running: a continuation saw the previous `sleep 60` still alive. Kill the call's process group on
  abort.
- **The Session wakes on demand.** Each heartbeat restarts an evicted Session, and a waiting tool call reruns
  then. This is harmless with `progressed`, but the cost grows with waiting approvals.
- **Deploys reach a Workspace DO only when its Container stops**: a running Container keeps the old object.
  Stop Containers (admin `workspace-stop`) before testing new Workspace code.
- **The stale reads** depend on computer 0.9.0's private VFS tables (`vfs_nodes.rev`, `vfs_dirents`,
  `vfs_changes`, `vfs_meta`). Re-check them when upgrading computer.
- **DO checkpoint diffs** pair exact renames only, and apply no `--ignore-all-space`; the Container's git makes
  the diff whenever it is running. Above the guard (2,000 files or 16 MB of packs), captures run in the
  Container unless nothing was written.
- **Credentials**: the Environment DO is the only GitHub minter. Part 2's Credential broker can follow the same
  pattern: the Workspace DO asks the Environment DO at use time through the egress host, and nothing is stored
  in the Container. (2026-11-11: there is no broker; all model access goes through the model proxy, ADR-0012.)
- **Subscription logins** (part 2) only change `models.ts` (pi-ai `Models`) in the Session. The differ, approvals
  and Workspaces do not depend on the provider. (2026-11-11: dropped; subscriptions are connected in the model
  proxy, ADR-0012, and part 2 is [replanned](step-2a-part2-plan.md).)
- **Worktrees (2b)**: one Workspace per `/w/<id>` today. The router refuses nested destinations, and the
  `node:fs` audit lists `removeEmptyDirectory`/`worktreeCheckoutCache` as the worktree code paths to Shadow or
  Layer.
- **Admin routes added**: `agents/session`, `agents/session-diagnostics`, `agents/session-restart`,
  `agents/drop-turns`, `agents/router-trace`, `agents/checkpoint-trace`, `agents/workspaces`,
  `agents/workspace-stop|remove|probe|call|workflows`, `check/agents`, `check/workspaces`.
- **Scripts**: `scripts/chat.ts`, `scripts/turns.ts` (liveness, restart `--tools --approval --no-continue`, lost,
  deadline), `scripts/m3.ts` (approve, decline, question, edit-only, wait, agent-push), and
  `scripts/acceptance.ts --real-turn [--push]`.

## Stages

- `step2a`: about 25 deploys, destroyed on 2026-11-11 with `bun scripts/stage.ts destroy step2a` (6 resources,
  both Workers and the Container application).
- `bump`: deployed by the CI bump job, and left in place as step 1 left it. The job's first CI runs failed on
  the fixes listed above; `workflow_dispatch` run 43012293366 on `step-2a` passed, real turn included.
