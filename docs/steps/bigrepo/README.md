# Large repos and submodules: the prod bug of 2026-11-11

The owner cloned `ian-pascoe/t3flare` as a project on prod and started a worktree thread. It was slow, then broke; the
removal tombstoned the worktree ("the removal could not check the worktree: Error: Durable Object exceeded its CPU time
limit and was reset", revision 37,474), and the project later showed "Git status failed". The fix and its reasons are
ADR-0009's 2026-11-11 refinement.

## What prod showed (read-only)

- Workers Observability, `t3flare-agents-prod`, worktree DO `302798b2…`: `worktree-ready` in 10.2 s (clone 5.0, bundle
  0.6, checkout 4.5); then t3's `GitVcsDriver.createWorktree.updateSubmodules` failed (exit 1); the agent's own
  `git submodule update --init --depth 1 t3code` ended with "ReadableStream received over RPC disconnected prematurely".
  The Container stopped at 22:17:18; two `git` RPCs then ran 32.5 s of CPU each (`exceededCpu`) and seven "Durable
  Object exceeded its CPU time limit and was reset" followed; the removal (`worktree remove`, 39 s) tombstoned at 22:18:35.
- Router trace: the reset was a stale review diff (`diff --find-renames … --minimal`) at 22:17:49. On the project,
  `status --porcelain=2 --branch -z` (no `--no-ahead-behind`: t3's `statusDetails`) answered `container-stopped … has no
  earlier answer`, which t3 reports as "Git status failed"; the `--no-ahead-behind` shape was cached.
- The worktree's files held `t3code/` checked out: the submodule's 31,946 files (24,120 under `t3code/.repos`). t3flare
  itself has 503 tracked files, so it is inside the 2,000-file guard and the DO's isomorphic-git ran over the journal.
- The project (`t3flare`, revision 772) is complete: 503 files, its directories and `.git`; `t3code/` is empty, as a
  plain clone leaves it.

## The stage (`bigrepo`, `scripts/bigrepo.ts`)

The same repo as a project, a worktree thread whose turn runs `git submodule update --init --depth 1 t3code`, commits an
edit and answers; status and the review diff with the Container running, then stopped; the removal; the project's two
status shapes with its Container stopped.

| | Before (`main` at 915d068) | After |
| --- | --- | --- |
| Worktree add (router) | 11.6 s (clone 5.3, bundle 0.8, checkout 5.4) | 9.5 s (clone 4.4, bundle 1.0, checkout 4.0) |
| t3's `submodule update --init --recursive` | fails in 38.3 s: `write error: File too large` (the submodule's pack in the synced mount) | clones `t3code` (Container-only), 63.8 s, then stops at t3code's own nested submodules ("No url found …") |
| Launch to the agent's start | 55 s | 85 s |
| The agent's turn (submodule, commit) | 5 min 8 s (the bash alone 296 s: 37,000 files pulled into the DO) | 9.6 s |
| Launch to the turn's end | 6 min 3 s | 98 s |
| Worktree revision | 37,484 | 784 |
| Status and review diff, Container stopped | not reached: the restart to answer a read reset the DO ("storage operation exceeded timeout") | 84–92 ms, the Container left stopped |
| Removal | not reached | 8.4 s, purged, the turn's branch carried home |
| Project status, Container stopped | `--no-ahead-behind` answered; `statusDetails`' shape: container_stopped | both answered (stale, patched) |

`after.json` is the passing run on the PR's code. Earlier passing runs during the work gave 94 s to the agent's start and 72.7 s for t3's submodule clone; the clone's
length is tracked in SPI-1030. The before numbers are from the router trace and Workers Observability of the runs on
the unfixed build (the script's own before run timed out on the DO reset and wrote no report).
