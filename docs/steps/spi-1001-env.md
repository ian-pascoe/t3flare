# SPI-1148: Environment skills, installed from GitHub on the Harness panel (report)

Date: 2026-11-14. Branch `spi-1148-environment-skills`, from `main` at 660f922 (SPI-1147, SPI-1149). Ticket SPI-1148,
the second half of SPI-1001 (parity G10's skills half). Plan, with both reviews folded in:
[`spi-1001-env-plan.md`](spi-1001-env-plan.md). Decision record:
[ADR-0033](../adr/0033-environment-skills-are-pinned-copies-fetched-from-github-kept-by-the-environment-and-changed-only-by-the-owner.md),
refining ADR-0032. Evidence: [`spi-1001/`](spi-1001/) (`env-*.json`, `skills-*.png`). Stage harness:
`apps/environment/scripts/penvsk.ts`. Throwaway stage `penvsk`, added to `STAGES` and destroyed at the end.

t3code is untouched. This is Layer work: no Shadow and no Patch of t3 (ADR-0001). One dependency patch, on computer.

## What was built

### Fetch (`apps/environment/src/skills/`)

- **The port.** `source.ts`, `paths.ts`, `fetch.ts`, `contents.ts` and `checks.ts`, from cloudpid@47941c7c, cut to
  three operations:
  - a preview: one commit, one tree, the candidates' `SKILL.md`;
  - a fetch of the folders the owner picked, at the previewed commit;
  - an update check that reads no file.
- **The checks.** cloudpid's rules, plus SPI-1148's:
  - a name needs a letter;
  - a link or a submodule in a Skill's folder refuses it;
  - every path passes the rule each Workspace applies (`skillFilePathProblem` in `@t3flare/skills`): no backslash,
    NUL, control character, or empty, `.` or `..` part; at most 512 bytes, each part at most 255.
  - A `SKILL.md` must name itself. Repo skills keep SPI-1147's folder-name fallback.
- **The credential** (`readAccessFor`) is the Environment DO's alone, in this order:
  1. a token for the repo, where the App is installed on it;
  2. else a token for the first installed repo the App mints for (the Workspace registry's);
  3. else no token, with `/rate_limit` read first and again before the files, and an early refusal naming the reset
     and the way out.
- **Refusals.** Both of cloudpid's 404 wordings, and a secondary limit (403 or 429 with `retry-after`) told with its
  wait.
- **Bounds.** At most 500 blob reads per request (GitHub's 900 a minute per endpoint), 6 at a time, 15 s per request and
  60 s per panel call. An install over 500 files answers 422 before any read.

### Store and API (`store.ts`, `api.ts`, `panel.ts`)

- **Three tables** in the Environment DO's SQLite: skills, files (text, blob SHA, size, SHA-256), and the enabled set's
  hash.
- **One synchronous change:** revision checked, limits re-checked against the rows, rows, hash, revision, audit. The
  hash is made from the files' SHA-256s before it, and made again when the revision moved, so two installs cannot
  interleave.
- **Part of the Environment settings entity** (ADR-0032): every change bumps its revision and is audited with
  `entity: "environment"` and the Skill source and switch before and after, never file content.
- **Routes:** `GET /api/skills`, `GET /api/skills/view`, `POST /api/skills/{preview,install,check,update,remove,enable}`,
  behind the panel's guards. A GitHub failure is a 502 whose body is the whole message.

### Delivery (`apps/agents`)

- **The Workspace's copy** (`skillSet.ts`): the set, one KV value per file, with its hash and parsed listing in memory
  only. It is served at `/workspace/.agents/skills` as computer's read-only mount, versioned by the hash.
- **`WorkspaceDO.takeEnvironmentSkills(hash)`.** It takes the set from the Environment when the hash differs, checks it
  (`skillSetProblem`) and remounts it inside `blockConcurrencyWhile`.
  - **A failed copy** falls back to the set held before, else the empty set.
  - **A refused set** is remembered by hash, reported (`skillSetRefused`, shown on Status) and not read again until the
    hash moves.
  - **A running Container's copy** is waited for after `blockConcurrencyWhile`: one passive command, its expectation on
    stdin, looking every 200 ms for up to 5 s. The Container is checked running and the command sent in the same tick,
    and the command refuses to start one (`onlyIfRunning`).
- **The computer patch** (`patches/deps/@cloudflare__computer@0.11.2.patch`) adds `Workspace.remount()`.
- **A Workspace's own files at the mount, from before it existed,** are moved to `skills.pre-mount` before the first
  index (`keepPriorSkills`).
- **The Container lock** (`@t3flare/workspace-client` `SKILLS_LOCK_SCRIPT`) starts every Container command:
  - the Workspace DO's `exec()`, and computer-env's `BACKENDS.container` (the Durable agent's `bash`);
  - `flock` makes two first commands share one attempt;
  - a failure leaves a marker that the take's command reads, and the Workspace logs it once per launch.
- **The Session** (`environmentSkills.ts`) has the Workspace take the hash a turn carries, bounded at 10 s and never
  failing the turn.
- **The Pi Durable adapter** carries `environmentSkills` (the store's hash) on `submitTurn`.

### Discovery, composer and expansion

- **The model's listing:** `WorkspaceDO.skills(cwd)` puts the held set first (`listingOfSet`), beating Repo skills.
- **The composer and expansion** ask the Workspace for Repo skills only (`repoOnly`) and merge the Environment's rows
  (`withEnvironmentSkills`).
  - A removed or disabled Environment skill un-shadows its Repo namesake at once.
  - An older Workspace's mount entries are dropped.
  - Environment skills have scope `user`, their mount path, and the row's `SKILL.md` embedded on `$name` or
    `/skill:name`.

### The Harness panel

The Skills section replaces the placeholder. It has:

- an install form whose preview is the confirmation: a pick per skill, with "replaces X from Y", "unchanged", and each
  problem;
- the list, with source, ref, short commit and saved time, a switch, View (`SKILL.md` as text, the files linked to
  GitHub at the commit), Check for updates and Update, and Remove after `confirm()`;
- totals with disabled skills apart;
- a note when reads would be unauthenticated.

Status shows the count, the enabled count, the set's hash and the last Workspace refusal. The script writes every
answer with `textContent`.

## M0 probes

- **[`env-probe.json`](spi-1001/env-probe.json)** (`f64889a`):
  - R1: a token scoped to one installed repo reads a public repo outside the installation, from the installation's
    5,300/h;
  - the read-only mount on both sides;
  - an 8 MiB set over one DO call.
- **[`env-sync.json`](spi-1001/env-sync.json)** (`1fdd389`): a running Container's copy after each set change, with and
  without the bind. A file changed in place read stale for up to about 2.5 s, so the take waits for it.

The probe route was removed in M2. Details are in the plan's §1.

## Evidence (stage `penvsk`, model `anthropic/claude-sonnet-5-5`)

Each file names its deployed commit. The commits after a file's run changed only what this table says.

| File | Shows | Commit deployed |
| -- | -- | -- |
| [`env-install-public.json`](spi-1001/env-install-public.json) | `mattpocock/skills`' `grill-me` previewed and installed at its commit; the snapshot and the model's listing at `/workspace/.agents/skills/grill-me/SKILL.md`, scope `user`; a `$grill-me` turn answering the block's location; the chip's "View instructions" read (t3's `ProjectReadFileError`) | `752cb4b` |
| [`env-install-private.json`](spi-1001/env-install-private.json) | `tools/plum/fruit-code` of the private fixture repo (outside any discovered root), read with a token for that repo; the branch moved on and the install stayed at its commit; View's `SKILL.md` and GitHub URLs | `752cb4b` |
| [`env-precedence.json`](spi-1001/env-precedence.json) | The Repo `fruit-code` says `KIWI-7` and the Environment's says `PLUM-9`; `$fruit-code` answers `PLUM-9`, and `skipped` names both Repo copies as shadowed | `752cb4b` |
| [`env-update.json`](spi-1001/env-update.json) | Check and Update for a size-changing and a same-size edit while the Container runs; each take caught up at its first look; the agent's `bash` reads the new `notes.md`, its SHA-256 the new blob's | `752cb4b` |
| [`env-no-container.json`](spi-1001/env-no-container.json) | An install, then a turn whose `read` tool reads the skill's file; the Container stopped before and after | `752cb4b` |
| [`env-readonly.json`](spi-1001/env-readonly.json) | The agent's `write` refused ("read-only mount …"); the agent's `bash` write as a fresh Container's first command refused ("Read-only file system", the bind in `mountinfo`); a write from the running Container refused; nothing planted | `752cb4b` |
| [`env-remove.json`](spi-1001/env-remove.json) | Removed: gone from the mount and the running Container; the snapshot's `fruit-code` is the Repo's again, and `$fruit-code` answers `KIWI-7`; an unknown `$plum-gone` untouched | `b4a3475` |
| [`env-refusals.json`](spi-1001/env-refusals.json) | An owner without the App, a repo outside the installation (both wordings, whole); a credential-looking file, a link, a skill over 4 MiB, a backslash path, and two skills over the 500-file cap (422); nothing kept | `b4a3475` |
| `skills-{desktop,phone}-{light,dark}.png` | The section with two skills (one disabled), a skill's view open, and a preview of the refusals branch | `7e8ff88` |

- **Between the commits:** `b4a3475` made an over-the-cap install answer 422 instead of 502 and fixed the stage
  script's remove prompt. `aac13de` and `7e8ff88` changed only the section's layout and a wrap.
- **The fixture branches:** `spi1148-env` and `spi1148-refusals` of `ian-pascoe/t3flare-fixture`, pushed by
  `penvsk.ts fixture`. Its `main` is untouched.

## Seams tested

| Seam | Tests |
| -- | -- |
| The set's hash, the path rule, `withEnvironmentSkills` (shadow, un-shadow on remove and disable, an older Workspace's entries), `listingOfSet` | `packages/skills/src/skillSet.test.ts` |
| Source forms; the CLI's path rules; links and submodules | `apps/environment/test/skillSource.test.ts`, `skillPaths.test.ts` (ported) |
| Each check and limit, the added rules | `apps/environment/test/skillChecks.test.ts` |
| Preview, fetch and check over a fake GitHub: request counts, no blob before the tree's checks, the 500 cap, internal skills, the `name` rule | `apps/environment/test/skillFetch.test.ts` |
| Token choice 1/2/3, both 404 wordings, secondary and primary limits, the unauthenticated pre-checks, the deadline | `apps/environment/test/skillContents.test.ts` |
| The store: rows, hash, revision, audit without content, unchanged, limits with disabled skills, interleaved installs, emitted sets mountable, refusals | `apps/environment/test/skillStore.test.ts` |
| The API through `handleHarness`: guards, preview, install, view, check, update (gone, renamed), remove, enable, a GitHub failure, the 422 cap | `apps/environment/test/skillsApi.test.ts` |
| Snapshot scope `user` and paths, Repo-only asks; expansion from rows; the adapter carrying the hash | `apps/environment/test/skillsSnapshot.test.ts`, `skillExpansion.test.ts` |
| The section's render, escaping, totals, the script writing text only, confirm on remove | `apps/environment/test/harnessPage.test.ts` |
| The set served read-only over a real computer Workspace in workerd, replaced whole, a failed copy falling back | `apps/agents/test/skillSet.workerd.test.ts` |
| The wait's expectation and script (run against a directory changed part-way), the lock marker, `keepPriorSkills`, the mount path pinned across packages, the lock in `exec()` | `apps/agents/test/skillSetWait.test.ts` |
| A turn's take: no hash, refusal, an older Workspace, the bound | `apps/agents/test/environmentSkillsTake.test.ts` |
| The lock leaves a command's output and status alone, and is tried once per launch | `packages/workspace-client/src/skillsLock.test.ts` |
| The Durable agent's Container commands start with the lock | `packages/computer-env/src/containerScript.test.ts` |

The agents Worker still loads no t3 code: no `t3code/` or `@t3tools/` source in its bundle's source maps after M3.

## Readings and limits

- **The wait's loop.** On the stage both edits read current at the take's first look, so the loop's later looks ran
  only in the unit test. M0's stale window (`env-sync.json`) was not reproduced; the wait is there for it.
- **`metadata: read` alone was not probed** (an advisory). The token keeps `contents: read`, which R1 showed works.
- **A renamed skill is told at Update, not at Check**, since the check reads no file. Update refuses it and keeps the
  Skill.
- **The chip's "View instructions"** shows t3's read error for an Environment skill: t3 reads the path as a project
  file (U64). Changing that needs t3 (a Shadow or a Patch); not done.
- **CLI agents** take no set at their turns (SPI-1153; ADR-0033 Consequences).
- **The Container lock is not a boundary:** the agent is root (ADR-0033 §5).

## Docs

- ADR-0033, and the ADR-0032 refinement (its table's row for Environment skills).
- `GLOSSARY.md`: **Skill source**. Environment skill is unchanged.
- `docs/parity.md`: the Skills row and G10.
- `docs/upstream-fragility.md`:
  - U64 gains the snapshot's `scope: "user"` entries outside `/w/<id>` and the chip's read of them;
  - U20 names the computer patch.

## Checks

`pnpm run check`: see the last line.
