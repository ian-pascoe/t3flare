# A Workspace is addressed by its path, and worktrees are Workspaces

A cloud Project is one repo. Its files live in a Workspace: a Workspace DO holding a `@cloudflare/computer` file system, with a Container started only when a real binary is needed. The Workspace is the source of truth for files in both agent modes; the Container is a synced copy. A thread in t3's `local` mode uses the Project's Workspace; a `worktree` thread gets its own Workspace. The t3 path `/w/<workspaceId>` is the repo root, so every seam routes by path prefix and t3's schemas are unchanged. Cloning a project, t3's worktree add and remove, and its setup scripts become Workspace provisioning and deletion.

## Consequences

- A Workspace's branch lives only in its clone, so removal refuses unpushed or uncommitted work unless forced. A sweep with 7 days' grace deletes unreferenced Workspaces and Sessions; GitHub branches are never deleted automatically.
- Provisioning is on demand (a clone is about 33 s per 9,000 files); a spare Workspace per Project is deferred.

## Considered Options

- **A Workspace per thread always** (cloudpid's default): a clone per thread, where t3 already lets the owner choose.
- **One Workspace with git worktrees inside**: cloudpid tried and superseded it.
