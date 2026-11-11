# Git runs in the Container; status and checkpoints come from the Workspace

t3 parses real git's exact output, and cloudpid found isomorphic-git in a Worker handles only small repos (2,000 tracked files, 16 MB of packs) and doesn't always match git's output. So t3's VCS seam is split three ways:

1. File reads, writes and search go to the Workspace DO and never start the Container.
2. Checkpoints and small-repo status use isomorphic-git in the Workspace DO.
3. Every other git command runs real git in the Container through t3's `VcsProcess` argv seam.

Passive status never wakes the Container. For a large repo while the Container sleeps, the Workspace serves the last real `git status` snapshot plus a journal of paths written since: branch is exact, line counts and ahead/behind may be stale. Opening a diff is a user action and starts the Container. t3's automatic background fetch is turned off.

## Refinement (step 2a, M3)

**A passive git read never starts the Container**, for any repo size. M2 answered t3's passive reads (status polls, branch and config reads) from a cache keyed by argv and the repo's revision, and ran a miss in the Container, starting it; that is reversed. Now a passive read the cache cannot answer runs in the Container only if it is already running. While it is stopped, the read gets **the last real answer for its key (made at any revision) plus the write journal**: the paths written under the repo since that answer's revision, read from computer's change log (`vfs_nodes.rev`, `vfs_changes`; cloudpid's `change-log.ts`). It is marked stale internally (`stale: "patched" | "last-answer"`, the router trace's route). The Container starts only for the router's allow-list (clone, fetch, pull, commit, push, checkout, …) or for the agent's own `bash`.

The journal is applied to the repo-scoped reads t3 polls, each entry recomputed from HEAD (or the read's merge base), the index and the working tree with isomorphic-git: `status --porcelain=2 --branch -z [--no-ahead-behind]` (untracked files collapsed to their topmost untracked directory, as git does), `diff-index -M --numstat -z HEAD --`, `ls-files --others --exclude-standard -z --`, and the review diffs `diff --find-renames … --src-prefix=a/ --dst-prefix=b/ [--minimal] [--numstat -z] <HEAD|merge-base> --`. Every other argv gets the last answer alone: the git-dir-scoped reads (`rev-parse`, `symbolic-ref`, `config --get`, `remote`, `for-each-ref`, `merge-base`, `show-ref`), which working-tree writes do not move, and the review diffs t3 runs with untracked files staged in a temporary index (`GIT_INDEX_FILE`), which the journal cannot reconstruct. A rename in the last answer that touches a journal path is shown as its two sides. A read with no earlier answer fails fast ("the Workspace's Container is stopped").

**Checkpoints and the turn diff come from the Workspace DO**, not a Container per turn and not a user action that starts it: t3's `VcsDriverRegistry` is wrapped so `checkpoints.*` for a `/w` cwd go to the Workspace DO, which captures with isomorphic-git (a commit of the working tree, HEAD its parent, as t3's `captureCheckpoint`) and makes the diff text itself, in git's format, unless the Container is running (then its git makes it). Above the guard a capture with nothing written since the previous one is an alias of it, else runs in the Container. Restores and the authored paths of a range where HEAD moved run in the Container.

Evidence (`docs/steps/step-2a/m3-acceptance.json`): an edit-only turn and a question-only turn, each followed by a client watching status, left the Container stopped, with every checkpoint made by the DO and the status reads served `stale-patched`; the DO's checkpoint diffs were byte-identical to the Container's git for 55 ref pairs in patch and numstat (110 of 110); the Node tests compare both the patch writer and the journal patches with real git byte for byte (`apps/agents/test/gitPatch.test.ts`, `staleReads.test.ts`).

## Refinement (step 2b; root's ruling on M2)

**A worktree launch may start the project's Container for a `.git` read it has never answered.** t3's worktree launch
asks the project a few `.git`-only reads (its remotes, the base branch's upstream, `--git-common-dir`, `checkout.workers`,
the base commit) before anything else starts its Container, and a read never answered has no last answer to serve. So:

- only an allow-list of five argv shapes may start a stopped Container, and only when they have no answer at all; each
  is named in the code with its t3 caller (`apps/agents/src/workspace/gitDirReads.ts`), and each such start is logged in
  the router trace;
- whenever the Container is up (a clone, a worktree's provisioning, a routed action), those reads are answered
  ("primed") for every branch and remote-tracking ref, keyed without the command's env, so a later launch starts
  nothing; `git remote` is also answered from the Workspace's own files;
- working-tree reads (status, diffs, t3's temporary indexes) are unchanged: stale only.

Evidence: `docs/steps/step-2b/m2-watch.json` (a primed worktree with its Container stopped, watched by a client: 147 then
174 reads, all from the cache, the Container still stopped, before and after an Environment restart);
`apps/agents/test/gitDirReads.test.ts`.

**A worktree Workspace has its own `.git`** (a full clone, not `gitdir:`/`commondir`), so checkpoints, stale reads, the
read cache and the 2,000-file guard work per Workspace unchanged. `rev-parse --git-common-dir` in a worktree answers its
own `.git`; t3 uses it only for its config lock and the worktree directory's hash (the router trace audit in
`docs/steps/step-2b/m2-trace.json`).
