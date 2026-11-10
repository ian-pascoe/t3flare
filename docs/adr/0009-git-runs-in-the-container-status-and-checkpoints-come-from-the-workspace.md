# Git runs in the Container; status and checkpoints come from the Workspace

t3 parses real git's exact output, and cloudpid found isomorphic-git in a Worker handles only small repos (2,000 tracked files, 16 MB of packs) and doesn't always match git's output. So t3's VCS seam is split three ways:

1. File reads, writes and search go to the Workspace DO and never start the Container.
2. Checkpoints and small-repo status use isomorphic-git in the Workspace DO.
3. Every other git command runs real git in the Container through t3's `VcsProcess` argv seam.

Passive status never wakes the Container. For a large repo while the Container sleeps, the Workspace serves the last real `git status` snapshot plus a journal of paths written since: branch is exact, line counts and ahead/behind may be stale. Opening a diff is a user action and starts the Container. t3's automatic background fetch is turned off.
