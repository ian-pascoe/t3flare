# A Workspace is addressed by its path, and worktrees are Workspaces

A cloud Project is one repo. Its files live in a Workspace: a Workspace DO holding a `@cloudflare/computer` file system, with a Container started only when a real binary is needed. The Workspace is the source of truth for files in both agent modes; the Container is a synced copy. A thread in t3's `local` mode uses the Project's Workspace; a `worktree` thread gets its own Workspace. The t3 path `/w/<workspaceId>` is the repo root, so every seam routes by path prefix and t3's schemas are unchanged. Cloning a project, t3's worktree add and remove, and its setup scripts become Workspace provisioning and deletion.

## Consequences

- A Workspace's branch lives only in its clone, so removal refuses unpushed or uncommitted work unless forced. A sweep with 7 days' grace deletes unreferenced Workspaces and Sessions; GitHub branches are never deleted automatically.
- Provisioning is on demand (a clone is about 33 s per 9,000 files); a spare Workspace per Project is deferred.

## Considered Options

- **A Workspace per thread always** (cloudpid's default): a clone per thread, where t3 already lets the owner choose.
- **One Workspace with git worktrees inside**: cloudpid tried and superseded it.

## Refinement (step 2b, as built)

- **The address.** A worktree Workspace is `/w/.wt/<project dir>/<dir>` (t3's `worktreesDir` is `/w/.wt`), and its id is
  its path below `/w`: `.wt/<project dir>/<dir>`. `/w` lists projects; `/w/.wt` and `/w/.wt/<project dir>` are directories
  listed from the registry.
- **A full clone, seeded by a bundle.** The router answers t3's `git worktree add -- <path> <ref>` by cloning the
  project's remote into the new Workspace's Container (`--no-checkout`, or `git init` with no remote), then fetching a
  bundle the project makes of what that clone lacks: `<ref>` without the clone's actual tips (not `--not --remotes`,
  which trusts stale remote-tracking refs), copied Workspace DO to Workspace DO. About 8 s on the fixture.
- **`git worktree list` is emulated** in the project from the registry, each worktree's HEAD and branch read from its
  own files without its Container, so t3's branch list shows them. Detached scratch checkouts (t3's PR review guide)
  are refused with a message.
- **Removal carries the work home.** Every `refs/heads/*` and `refs/stash` the project cannot reach is bundled back: a
  branch the project lacks is created, one it has fast-forwards (never its checked-out branch), anything else is kept
  at `refs/t3flare/worktrees/<dir>/…`. A forced removal with uncommitted work is a **tombstone** (gone for t3, files kept
  for the grace, restorable); a removal step that cannot run tombstones without a purge date.
- **States and the sweep.** `provisioning → ready → deleting → (gone)`, with `tombstoned`. Only `provisioning` and
  `ready` resolve for t3's paths. The purge destroys deleted threads' Sessions, then the Workspace DO (its storage, its
  Container, its budget lease; a marker refuses every later RPC but provisioning, so a Session reaching it by name
  cannot recreate it), then the registry row. A daily sweep in the Environment's alarm reads references from t3's own
  tables (live projects and threads, archived included, matched by Workspace id; open runs; open terminals), fails
  closed on any read error, purges what is unreferenced past the 7-day grace, tombstones past theirs, and rows left in
  `deleting` (retried within 5 minutes), and stops any Container whose budget lease no Workspace holds. On prod it
  reports only, until `T3FLARE_SWEEP_PURGE=1`. t3 re-creating a worktree at a tombstone's path restores it.
- **What does not carry over.** The project's copy of a worktree's branch does not advance while the worktree lives.
