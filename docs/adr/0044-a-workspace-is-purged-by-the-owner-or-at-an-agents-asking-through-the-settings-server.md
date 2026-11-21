# A Workspace is purged by the Owner on the Settings page, or at an agent's asking through the Settings server

Status: accepted (Owner decisions, 2026-11-21). Refines
[ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md) (the Settings server now carries an
action that is no Settings change) and
[ADR-0008](0008-a-workspace-is-addressed-by-its-path-and-worktrees-are-workspaces.md) (purge and restore were admin
routes only). The Grace itself is
[ADR-0043](0043-the-grace-is-an-environment-setting-and-a-deletion-wakes-the-sweep.md).

Purging a Workspace before its Grace ends, restoring a Tombstone and running the Sweep existed only as admin routes
behind the admin token. The Owner wanted them on the Settings page, and wanted an agent to be able to ask.

1. **The Settings page has a Workspaces section**: every Workspace with what references it and its purge date, a
   project's Worktree Workspaces under it, and four actions: Purge now, Restore (a Tombstone), Stop Container, and Run
   the Sweep, with a preview of what it would do. The Grace is set there too, as one control: purge after a number of
   days, or never. Each Workspace's size and Container state load after the table, and never start a Container.
2. **Nothing but the admin route purges a referenced Workspace.** A live or archived project or thread, an open run or
   an open Terminal refuses the Purge, on the page and through the Settings server alike, and the refusal names them.
   There is no force outside the admin route. Deleting the project or thread stays t3's: a Purge removes files, never a
   t3 project.
3. **Purging a project's Workspace purges its Worktree Workspaces too**, Tombstones included, and is refused whole if
   any of them is referenced. When nothing references a project's Workspace no live thread references its worktrees
   either, so they would only wait out the same Grace. A Worktree Workspace can be purged alone, without its project's.
4. **The page's actions are the Owner's own acts, not Settings changes**: behind the page's write guard, the Purge
   besides behind the Workspace's name typed, each written to the audit log under a `workspaces` entity. They are never
   Open changes. The Sweep's own purges are written there too, one entry per Workspace, each with the count of Sessions
   it destroyed, and so are the admin routes' purges, restores and stops, with the caller `admin`. The typed name is the
   Workspace's own (a project's folder name, a worktree's last path segment), not the t3 project's title, which a
   deleted project may share with a live one. It is the page's guard only: a Purge asked through the Settings server
   asks no typed name, since the Owner answers it as an Open change (5).
5. **The Settings server gets `list_workspaces` and `purge_workspace`.** A Purge asked through it is always asked,
   whatever the thread's mode, and waits as an **Open change**: the Owner-only card or the Change page for t3flare's own
   agents, the client's Elicitation mode for an Owner client. It names no revision; what it is bound to is checked when
   it is applied, by reading the references again. Plan mode refuses it and Linked work cannot ask, as for every write.
6. **A Purge is not answered on the Change page alone.** It reaches only what nothing references, so it shortens a Grace
   that would end anyway.

## Considered options

- **A separate MCP server for Workspaces.** Rejected: a second server, door and approval path for two tools, where the
  Settings server already has the card, the Change page, the caps and the audit log.
- **A force on the page**, as the admin route has. Rejected: the references are the one thing between a mistyped name
  and a live project's files.
- **Per-Workspace purges only**, with no cascade. Rejected: a deleted project with ten worktree threads would take
  eleven typed names.
- **Page-only approval**, as for a secret. Rejected by the Owner: see 6.
- **The tool deleting the t3 project too.** Rejected: t3 owns its projects and threads, and its own tools delete them.

## Consequences

- An Owner client in the `model` Elicitation mode can purge any unreferenced Workspace with no person involved, as it
  can already make every Settings change but the page-only ones (ADR-0035's Consequences). The audit log's mode and
  answerer are the only trace.
- A restored Tombstone is referenced by nothing until a thread in t3 takes its worktree again, so its Grace starts over
  at the restore.
- "Open change" and "Settings server" each cover one thing that is not a setting; the glossary says so.
