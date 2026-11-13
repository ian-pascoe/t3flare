# Environment settings and Harness settings are separate entities, edited on one owner page

Status: accepted (SPI-1149, 2026-11-13; decided in SPI-1001's triage, the budget added at the owner's request the same
day). Report: [`docs/steps/environment-settings.md`](../steps/environment-settings.md). Refines
[ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md).

ADR-0026 gave t3flare one owner page and one settings entity, the **Harness settings**: Pi Durable's extensions and the
MCP server set, read by a Session at a turn's start. What every Workspace's Container gets (its size, how long it may
sit idle, how many run at once, and later the Global mise config and the Environment skills) is a different thing with
different readers, so it is a second entity, the **Environment settings**, modelled on cloudpid's Environment
configuration. Both are edited on the one page at `/_t3flare/harness`, the Environment ones in its Environment section.

1. **Keys, revisions and readers.**

   | Entity | Key in the Environment DO | Read by | Applies at |
   | -- | -- | -- | -- |
   | Harness settings | `t3flare:harness:settings` | a Session (`harnessSettings`) | the thread's next turn |
   | Environment settings | `t3flare:environment:settings` | a Workspace DO (`environmentSettings`) | the Workspace's next Container start |

   Each has its own revision, bumped only by its own changes, so a size change never makes every Session take the
   Harness settings again. A Workspace DO reads them before each Container start with a 5 s bound and keeps the copy it
   took (`t3flare:environment`); with no answer in time it starts with that copy, else the defaults, as a Session does
   for the Harness settings. Neither read boots t3.
2. **One schema.** `@t3flare/harness-registry`'s `ENVIRONMENT_SETTINGS` is the Environment settings' only schema: the
   panel renders its section from it, the API validates against it, and `resolveEnvironment` gives every reader the
   resolved view, reading a stored value that no longer fits as its default. A later setting (SPI-1150, SPI-1152) is an
   entry there. Secrets are not offered (ADR-0016 A′).
3. **One audit log.** Every entry carries `entity`, an open field naming the entity changed: `"harness"` and
   `"environment"` today, and a later entity on the page adds its own name. An entry written before this has none and
   reads as harness. An Environment change records only the settings it moved, as resolved before and after; a save
   that moves none is not stored, bumped or logged.
4. **The Container size is chosen per start**, from five names: `cpu-1` (the default, the custom size t3flare ran
   before: 1 vCPU, 3 GiB, 12 GB) and Cloudflare's `standard-1` to `standard-4`. The class runs under
   `schedulingPolicy: "durable_object"`, which takes an `instance` per `start()`. Every start passes one: an omitted
   `instance` starts `lite`, and a stored name t3flare does not offer starts the default. `lite` and `basic` (which the
   runtime refuses) are not offered, nor cloudpid's other custom sizes. A stored name never changes meaning: adding a
   size is free, removing one needs a rename map.
5. **A running Container keeps what it started with.** The Workspace DO records each start's size, idle time and
   budget, and adopts a running Container with the `instance` it started with (computer relaunches one whose launch
   differs). A change never resizes or restarts it; its idle stop follows the idle time it started with.
6. **The idle time** (1 to 60 minutes, default 2) replaces the `CONTAINER_IDLE_MS` constant.
7. **The Container budget is a setting** (1 to 10, default 3, today's value; a cost guard, far below the account's
   concurrent limits). It replaces `MAX_CONTAINERS` as a constant. The budget DO is a singleton in the agents Worker, so
   a Workspace DO carries the budget with a fresh start's lease request, and only when it read it from the Environment
   then: a kept copy or the defaults carry none, so they never overwrite the owner's newer budget. The budget DO judges
   the request by it and keeps the last one for renewals and status reads. `T3FLARE_MAX_CONTAINERS` still wins (tests).
   Raising it applies at the next lease request. **Lowering it stops nothing**: a holder is always renewed, and a new
   start is refused until fewer run than the budget. A refused start asks idle holders to stop only when enough of them
   are idle to bring the count under the budget, and otherwise asks none. A refusal names the budget and the panel
   section that changes it, whole on every t3flare surface (read from the error's cause chain, since computer cuts its
   own messages); t3's own git error text keeps only stderr's length, so its worktree setup error does not show it. The panel shows the budget beside the Containers running now and their Workspaces, and
   prices each size at the budget's Containers.

## Considered options

- **One entity, the Harness settings grown.** Rejected: every size change would move the revision every Session
  watches, and the two have different readers and application points.
- **A separate page for the Environment settings.** Rejected: the same guards (Access, CSRF, Origin, the hash-only CSP)
  and the same audit log; one page is less to secure.
- **The budget as a deploy constant shown read-only** (the triage's first answer). Reversed by the owner the same day.
- **The budget DO reading the Environment DO itself.** Rejected: a cross-Worker call on every lease from a singleton
  every start waits on; the Workspace DO already holds the settings when it asks.
- **Restarting a running Container on a size change.** Rejected: it would end terminals and CLI agents' processes
  mid-work.

## Consequences

- A size, idle-time or budget change shows in the next Container start, not at once; the panel says so.
- Old audit entries have no `entity`; every reader of the log goes through the store, which supplies it.
- The cost shown is a worst case (every vCPU busy); memory and disk are billed while a Container runs, CPU only while it
  works.
- A Workspace DO whose read gets no answer starts with its kept copy, which may be one revision behind.
