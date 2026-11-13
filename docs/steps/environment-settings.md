# SPI-1149: Environment settings (the entity, Container size, idle time and budget)

Report for SPI-1149, a sub-ticket of SPI-1001's triage. The ticket is the plan. Decision record:
[ADR-0032](../adr/0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md),
with a refinement note in ADR-0026. Evidence: [`environment-settings/`](environment-settings/), from stage `penv`
(destroyed).

## What changed

- **One schema** for the Environment settings: `@t3flare/harness-registry`'s `environment.ts`.
  - `ENVIRONMENT_SETTINGS` holds the Container size (`cpu-1` default, `standard-1` to `standard-4`), the idle time
    (1 to 60 minutes, default 2) and the Container budget (1 to 10, default 3).
  - `resolveEnvironment` reads a stored value that no longer fits as its default.
  - `applyEnvironmentChange` validates a change and stores only the settings it moves. A save that moves none is not
    stored, bumped or audited.
  - `ResolvedEnvironment` is derived from the schema, so `containerSize` is typed `ContainerSize`.
  - `containerInstance` maps a `ContainerSize` to the `instance` a start takes (`cpu-1`'s resources, a named type's
    name), never undefined. A stored name t3flare does not offer never reaches it: `resolveEnvironment` reads it as the
    default first, for the stored settings, the Environment's answer and the Workspace DO's kept copy alike.
  - The field schema and its validation moved to `fields.ts`, shared with the Harness settings' registry.
  - A later setting (SPI-1150's mise config, SPI-1152's Variables) is one entry in `ENVIRONMENT_SETTINGS`. The panel's
    section and the API pick it up without page work; `resolveEnvironment` and `ResolvedEnvironment` gain a field.
- **Storage.** The settings live in the Environment DO at `t3flare:environment:settings`, with their own revision
  (`apps/environment/src/harness/store.ts`).
  - The one audit log's entries carry `entity` (`AuditEntity`, an open union that SPI-1162 can extend with `"models"`).
  - An entry without `entity` reads as `harness`.
  - The page labels an entity it does not know by its stored name.
- **The panel** (`panel.ts`, `page.ts`, `pageScript.ts`).
  - Routes: `GET`/`POST /_t3flare/harness/api/environment`, behind the existing JSON, Origin, `Sec-Fetch-Site` and CSRF
    checks.
  - An Environment section: one form rendered from the schema, "Running now" (the budget's live leases and their
    Workspaces), and the cost table. The table's budget column, current row and summary follow the size and budget
    inputs before a save.
  - Status shows the Environment revision and when a Workspace last took it.
  - The audit table gains a Settings column.
- **The cost table** (`containerCost.ts`) uses the vendored `@cloudpid/config` prices: each size's resources, one
  Container's worst-case hour, and that hour times the budget set.
  - `@cloudpid/config` is a new dependency of `apps/environment`, added through `pnpm run relock` (3 lock lines).
- **The Workspace DO** (`apps/agents/src/workspace/containerLaunch.ts`, `WorkspaceDO.ts`).
  - Before a fresh start it reads `environmentSettings()` from the Environment DO, waiting at most 5 s. Without an
    answer it uses its kept copy (`t3flare:environment`), else the defaults.
  - It records the launch (`t3flare:container-launch`: size, instance, idle ms, budget, revision). It passes `instance`
    on every `start`/`restart`.
  - A running Container is adopted with the instance it started with: computer relaunches a running Container whose
    launch record differs, so a fresh read here would restart it.
  - The idle stop uses the launch's idle time. The `CONTAINER_INSTANCE` and `CONTAINER_IDLE_MS` constants, and the
    unused `T3FLARE_CONTAINER_IDLE_MS` override, are gone.
  - `containerState()` now also reports `startedAt` and `launch`.
- **The Container budget** (`apps/agents/src/budget.ts`).
  - A fresh start carries the budget with `acquire`. `ContainerBudget` judges the request by it, keeps it for
    renewals and status, and ignores a value out of bounds. `T3FLARE_MAX_CONTAINERS` still wins.
  - A holder is always renewed. Before this change, a renewal was refused once the other holders reached the max,
    which a lower budget would have triggered.
  - The refusal is `Container budget (N) reached: raise it at /_t3flare/harness#environment`. computer wraps it in its
    connect errors and keeps only the first 240 characters of each message, its own ~120-character prefix included,
    and fewer after a `priorExit=` (a Container that exited before). The reason is kept short, and the Workspace DO
    reads it whole from the deepest error in the cause chain (`startRefusal.ts`) for terminals and CLI processes.
- **Docs.** ADR-0032; the ADR-0026 note; `GLOSSARY.md`: Harness panel (revised), Harness settings, Environment
  settings, Container size, and Container budget (new with the scope change). No t3 lean, so no
  `upstream-fragility.md` entry.

## Seams tested

| Seam | Tests |
| -- | -- |
| Schema and defaults, an unknown stored size, idle and budget bounds | `packages/harness-registry/src/environment.test.ts` |
| Size name → `instance` (unknown → default, never omitted) | same |
| The Workspace DO's read, kept-copy fallback, launch (size, idle; a budget only from a fresh read) | `apps/agents/test/containerLaunch.test.ts` |
| The budget carried on `acquire`, env override winning, lowering below the running count | `apps/agents/test/budget.workerd.test.ts` |
| Reclaiming enough idle holders or none (two running at a budget of 1) | `apps/agents/test/reclaim.test.ts` |
| A refused start's whole reason from the cause chain | `apps/agents/test/startRefusal.test.ts` |
| Separate revisions, audit `entity`, validation, CSRF/Origin/form guards, the section | `apps/environment/test/environmentSettings.test.ts` |
| The cost table | `apps/environment/test/containerCost.test.ts` (figures from the research's worked example) |

## Evidence (stage `penv`)

Each file came from a deploy of the commit named. The files from `f165c87` carry it in their `commit` field (the
deployed build's, from `/_t3flare/health`); the older ones predate that field, and their commit is matched from the
deploy logs and their `at`.

| File | Shows | Commit deployed |
| -- | -- | -- |
| `sizes.json` | Each size set through the API, then a fresh start, then its limits read in the Container. | `fb98003` |
| `running.json` | A size and idle-time change made while the Container runs, and the next start after its idle stop. | `fb98003` |
| `idle.json` | The idle stop at 1 and 3 minutes. | `fb98003` |
| `safety.json` | The new routes refused from outside. | `fb98003` |
| `revisions.json` | Each entity's revision moving alone. | `8163dcd` |
| `budget.json` | The budget at 1, raised to 2, and lowered to 1 with two Containers running. | `f165c87` |
| `audit.json` | Environment entries and an entry written by main's code (`penv` deployed from `main` first). | `f165c87` |
| `cost-live.json` | The section's script on the stage's page: size and budget changed in the form, not saved; the cost follows. | `f165c87` |
| `environment-*.png` | The section, desktop and phone, light and dark, with one Container running. | `f165c87` |
| `environment-live-*.png` | The same after the inputs changed: 5 Containers of `standard-4`, the row marked, at most $2.01 an hour. | `f165c87` |

The `fb98003` files predate the review rounds. Those rounds changed how a launch is built (`launchOf`,
`containerInstance`, the kept copy read through the schema), not what a start passes or what a running Container keeps;
the unit tests cover the new paths. `budget.json`, `audit.json` and the screenshots were taken again at `f165c87`
because the rewritten reclaim, the new `reclaimable()` RPC and the live cost script run only there.

**`sizes.json`.** The limits read in each Container:

| Size | `memory.max` | CPUs (`nproc`) | Root disk |
| -- | -- | -- | -- |
| `cpu-1` | 3 GiB | 1 | 12 GB |
| `standard-1` | 4 GiB | 1 | 8 GB |
| `standard-2` | 6 GiB | 1 | 12 GB |
| `standard-3` | 8 GiB | 2 | 16 GB |
| `standard-4` | 12 GiB | 4 | 20 GB |

- `memory.max` is exact for each size.
- `cpu.max` is `max 100000` in every size: the platform sizes the VM, not a CPU quota. The CPU count is therefore
  `nproc`, and `standard-1`'s half vCPU shows as 1 CPU.

**`running.json`.**

- The Container started on `standard-1` with a 2-minute idle time.
- The settings were then changed to `standard-3` and 1 minute while it ran. Its start time, launch and limits were
  unchanged.
- It stopped 124 s after its last use, on the idle time it started with.
- The next start had `standard-3` (8 GiB, 2 CPUs) and a 1-minute idle time.

**`idle.json`.** Stops were first seen 62 s and 184 s after the last command. The poll runs every 5 s.

**`budget.json`.**

- At a budget of 1, a second Workspace's start is refused: `Container budget (1) reached: raise it at
  /_t3flare/harness#environment`.
- Raised to 2, it starts.
- Lowered to 1 with both busy: a third start is refused, both keep running, and both leases stay.
- With one stopped, the third is still refused, since one still runs at a budget of 1. With both stopped, it starts.

**`audit.json`.** `penv` was first deployed from `main`, and one Harness change was made there. After the branch's
deploy, that entry reads as `harness`. Environment entries carry `entity: "environment"` and the changed settings
before and after.

**`safety.json`.**

- With no Access credentials, or a forged assertion only: 302 at the edge.
- With the service token but no admin token: 404.
- With a wrong Origin, a cross-site fetch, or a form-encoded body: 403.
- A size not offered: 400.
- Nothing refused was stored.
- CSRF is the unit tests' only. It binds the owner's Access subject, which a script cannot present, as in
  `m3-panel-safety.json`.

## Readings and limits

- **The rule for a new start** is: it is refused while as many Containers run as the budget allows. "Refused until one
  stops" holds when the count is one over the budget. At a budget of 1 with two running, stopping one leaves one
  running, which is still at the budget. The evidence records the third start refused after one stop and started after
  both.
- **Reclaiming idle holders (review F7)** still applies at a lower budget, but only when enough holders are idle to
  bring the count under the budget (`reclaim.ts`); otherwise none is asked. In `budget.json` both holders run a command
  while the third start is tried, so neither is idle.
- **The reclaim race.** The idle check and the stop are two RPCs to each holder. A holder found idle can get a command
  between them; its `releaseIfIdle` then refuses, while the other idle holders, asked at the same time, stop. The start
  is still refused, so up to `needed - 1` Containers can stop without letting it through. Asking them together keeps
  that window to one RPC.
- **A fallback budget is not sent.** A start whose read of the Environment settings timed out carries no budget, and the
  budget DO keeps the owner's last one.
- **The 240-character cap.** On the `5334eb9` deploy, `budget.json`'s first case met it: that Workspace's Container had
  exited before, computer added `priorExit=…`, and the top message ended at `Container budget (1`. `f165c87` reads the
  reason from the cause chain (`startRefusal.ts`), and the harness reads the longest reason in the answer; the case
  passes there.
