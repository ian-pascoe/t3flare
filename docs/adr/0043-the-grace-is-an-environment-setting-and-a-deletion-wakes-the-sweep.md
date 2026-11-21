# The Grace is an Environment setting, and a deletion wakes the Sweep

Status: accepted (Owner decisions, 2026-11-21). Refines
[ADR-0008](0008-a-workspace-is-addressed-by-its-path-and-worktrees-are-workspaces.md) (the fixed 7-day grace, the daily
sweep, `T3FLARE_SWEEP_PURGE`), [ADR-0003](0003-the-environment-resets-itself-when-idle-and-is-woken-by-one-alarm.md)
(the one alarm) and
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md) (an
Environment setting no Container reads).

ADR-0008 fixed the grace at 7 days in the source, counted it from the daily sweep's first pass after a deletion, and
left purging off on `prod` unless a Deployment set `T3FLARE_SWEEP_PURGE=1`, which `docs/deploy.md` never mentioned. So a
deleted project's files went 7 to 9 days later on the Maintainer's Deployment and never on anyone else's, and no Owner
could change either. The Owner decided:

1. **The Grace is two Environment settings**: whether the Sweep purges at all (on by default), and a whole number of
   days, at least 1 (7 by default). There is no zero: at once is the Owner's own **Purge**
   ([ADR-0044](0044-a-workspace-is-purged-by-the-owner-or-at-an-agents-asking-through-the-settings-server.md)), never a
   setting. One Grace covers a Workspace nothing references, a Tombstone with a purge date, and a deleted thread's
   Session.
2. **A change applies to what is already waiting.** Every purge date is computed when it is read, from when the thing
   became unreferenced or was removed plus the Grace as it is now; a Tombstone no longer carries a date of its own, only
   whether it has one. A mark no Sweep cleared while a thread held the Workspace is stale, so a Workspace's Grace runs
   from the later of its unreferenced mark and the latest t3 deletion (of a project or a thread) that released it, and
   a dated Tombstone's from the later of its removal and that release. The Sweep reads the Grace from the stored
   settings at each run, so a change needs no reset.
3. **`T3FLARE_SWEEP_PURGE` is retired**; the setting rules every Stage, `prod` included. `T3FLARE_SWEEP_GRACE_MS` stays,
   as a Stage's override of the days for tests.
4. **Turning purging on starts a full Grace for everything.** Nothing is purged sooner than one Grace after purging was
   last turned on, and a Stage's first Sweep under this ADR counts as turning it on. Two kinds of row are exempt, since
   neither waits out a Grace: a row left in `deleting` (a Purge already under way) and a `provisioning` or `failed` row
   more than an hour old, which nothing references. A Deployment whose `prod` only reported until now therefore gets a
   Grace of warning, on the Settings page, before anything goes. With purging off the Sweep still marks and clears what
   nothing references, and finishes a Purge already under way; it starts none. Turning purging off forgets when it was
   turned on at once, so off and on again starts a new Grace.
5. **A deletion wakes the Sweep; nothing else purges on a schedule.** A Layer over t3's events asks the Environment DO
   to run the Sweep when a project or a thread is deleted, so what the deletion left unreferenced is marked then, not up
   to a day later. The Sweep's next run is the earlier of a day ahead and the earliest purge date, on the one alarm, or
   five minutes ahead when the Sweep leaves a row in `deleting`; never sooner than a minute ahead. A purge on its date
   is therefore the Sweep's, behind its reference read, which fails closed. The Environment DO runs
   a woken Sweep after 5 s of quiet, since one project deletion emits an event per thread, and a wake during a Sweep
   runs one more after it. A change to the Grace wakes the Sweep too, since it moves every date.
6. **Through the Settings server, shortening the Grace or turning purging on is an asked change**; lengthening it or
   turning purging off is free ([ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md) §3: a
   change that destroys something is asked).

## Considered options

- **A purge scheduled per project at its deletion plus the Grace**, beside the Sweep. Rejected: a second purger with its
  own reference check and its own alarm time to keep, where the Sweep already has both.
- **Fixed choices with "Immediately"** (0, 1, 7, 30 days). The Owner chose any whole number of days from 1. With zero,
  deleting a worktree thread would destroy its unpushed commits at once, since only t3's own worktree removal carries
  refs home.
- **Keeping `T3FLARE_SWEEP_PURGE` as a master switch** shown on the page. Rejected: a hidden variable that contradicts a
  visible setting.
- **Counting the Grace from t3's `deleted_at`** rather than from the Sweep's own mark. Rejected: a Workspace can be left
  unreferenced without any one deletion to date it from; the mark stays, and the wake makes it prompt.

## Consequences

- An Owner whose `prod` never purged starts purging one Grace after the deploy that carries this. The Maintainer's
  `prod`, which purged already, pauses for one Grace once.
- A deletion the Layer misses (the Environment reset between the event and the wake) is marked by the daily Sweep, up to
  a day late.
- The Grace is the first Environment setting no Workspace reads: changing it bumps the Environment revision, so Status
  shows Workspaces behind a revision that changed nothing for them.
- The Sweep never purges a Workspace younger than the Grace, so never one younger than a day: its mark cannot precede
  its creation. Only a Stage's `T3FLARE_SWEEP_GRACE_MS` can make that shorter.
- The Layer names two of t3's event types, which a t3 bump can rename: an entry in `docs/upstream-fragility.md`.
