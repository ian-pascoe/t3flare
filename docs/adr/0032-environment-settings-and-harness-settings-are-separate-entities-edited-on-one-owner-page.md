# Environment settings and Harness settings are separate entities, edited on one owner page

Status: accepted (SPI-1149, 2026-11-13; decided in SPI-1001's triage, the budget added at the owner's request the same
day). Report: [`docs/steps/environment-settings.md`](../steps/environment-settings.md). Refines
[ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md). Refined by
[ADR-0033](0033-environment-skills-are-pinned-copies-fetched-from-github-kept-by-the-environment-and-changed-only-by-the-owner.md)
(Environment skills: the same entity, revision and audit `entity`, applied at a turn, not a Container start).

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
   | Environment skills (part of the Environment settings; [ADR-0033](0033-environment-skills-are-pinned-copies-fetched-from-github-kept-by-the-environment-and-changed-only-by-the-owner.md)) | tables `t3flare_env_skills`, `t3flare_env_skill_files`, `t3flare_env_skill_meta` | the Pi Durable adapter (the set's hash) and a Workspace DO (`environmentSkillSet`) | the thread's next turn; the composer at once |

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
   concurrent limits). It replaces `MAX_CONTAINERS` as a constant. The budget DO is a singleton in the agents Worker,
   so a Workspace DO carries the budget with a fresh start's lease request, and only when it read it from the
   Environment then: a kept copy or the defaults carry none, so they never overwrite the owner's newer budget. The
   budget DO judges the request by it and keeps the last one for renewals and status reads. `T3FLARE_MAX_CONTAINERS`
   still wins (tests). Raising it applies at the next lease request. **Lowering it stops nothing**: a holder is always
   renewed, and a new start is refused until fewer run than the budget. A refused start asks idle holders to stop only
   when enough of them are idle to bring the count under the budget, and otherwise asks none. A refusal names the
   budget and the panel section that changes it, whole on every t3flare surface (read from the error's cause chain,
   since computer cuts its own messages); t3's own git error text keeps only stderr's length, so its worktree setup
   error does not show it. The panel shows the budget beside the Containers running now and their Workspaces, and
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

## Refinement (SPI-1152): Variables

Report: [`docs/steps/spi-1152.md`](../steps/spi-1152.md). The Environment settings gain **Variables**: plain
`NAME=value` pairs every command in a Workspace starts with. mise's `[env]` (the Global mise config, SPI-1150) does not
do this: it reaches a tool run through a shim or `mise exec`, not a plain shell line, an apt-installed tool, or a CLI
agent's own process, which are fixed-path binaries outside mise.

1. **Shape.** One setting, `variables`, of the schema's own `variables` type: at most 50, each name one a shell can
   export (up to 128 characters), each value up to 4,096 characters without a NUL (cloudpid's limits). The panel shows
   them as a list in the Environment section, behind the same guards.
2. **Refused names**, checked by the API and again when read:
   - the names t3flare already sets or pins: every name `COMMAND_ENV`, a CLI profile's environment, Codex's shell
     policy, the managed settings' `env`, a Terminal's base environment or its rc file sets, listed in
     `SET_BY_T3FLARE` where no rule below covers it. A unit test derives the names from the code, with a launch of
     every CLI profile, and fails when the list misses one or keeps one nothing sets;
   - `PATH`, `HOME`, `PWD`, `SHELL`, `USER`;
   - the prefixes `T3`, `MISE_`, `GIT_`, `GH_`, `GITHUB_`, `SSH_`, `LD_`;
   - the loader hooks `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`;
   - a name with a `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` segment, in any case, singular or plural.
3. **Refused values**: cloudpid's credential patterns, without its two local-path patterns. A Variable is
   agent-readable, so it is never a credential (ADR-0016 A′). These refusals are guard rails for the owner, not a
   boundary against him.
4. **A stored Variable a later rule refuses is dropped alone**, not the whole set: §2's "a value that no longer fits
   reads as its default" applies per Variable.
5. **Where they apply.** One function, `commandEnv`, puts the Variables under a command's own environment, at every
   point a command starts in a Workspace:
   - every command computer runs on the Container or the Worker Shell: a Durable agent's, and the Workspace DO's own.
     Each of the two backends is wrapped (`VariablesBackend`), which reads the Variables as the command is sent, after
     the Container has started for it;
   - Terminals, the agent's Terminals and CLI agent processes, at spawn, so a CLI agent's commands inherit them.

   A Session does not add them: it cannot know which Variables a command's Container will start with before the
   command starts it.
6. **When.** A Container start takes them with the rest of its launch and keeps them while it runs; a change applies
   at the Workspace's next start. The Worker Shell has the last start's, so before the Workspace's first Container
   start its commands have none.
7. **Precedence.** Variables are the lowest layer: `COMMAND_ENV`, a CLI profile's environment, t3's own variables,
   mise's `[env]` and whatever a command exports all win over them.
8. **Audit.** The audit log records the Variables' names and values before and after, as the page shows them to the
   owner anyway; the Workers Logs line of a change carries neither.

Considered and rejected:

- **Evaluating `mise env` in `BASH_ENV`.** It would switch on every repository's `[env]`, and Terminals and CLI
  processes do not read `BASH_ENV`.
- **Keeping Variables out of CLI agent processes.** A CLI agent's commands would get none.
- **Adding them in the Session**, beside `COMMAND_ENV`. The Session's command can be the one that starts the Container,
  with Variables the Session has not seen.

## Refinement (SPI-1150): the Global mise config

Report: [`docs/steps/global-mise.md`](../steps/global-mise.md); plan and M0:
[`global-mise-plan.md`](../steps/global-mise-plan.md). The Environment settings gain the **Global mise config**: the
owner's `mise.toml` text, which every Container's commands get as mise's global config.

1. **Shape.** One setting, `globalMiseConfig`, of the schema's `file` type: at most 16 KiB of UTF-8, no NUL (cloudpid's
   `toolchainsProblem`), line ends stored as LF so a browser's round trip is not a change. The panel shows it as a text
   area of its own, without `maxlength` (which counts UTF-16 units; the API's refusal is the limit).
2. **Layers.** Every command's environment (`COMMAND_ENV`) makes the image's base file mise's *system* config and the
   Container-local `/var/lib/t3flare/mise/config.toml` its *global* config. mise layers system < global < project and
   merges `[tools]` per tool, so the image's `git` and `gh` stay under the owner's file, and a repository's own
   `mise.toml` wins per tool over both. With no text nothing is written there and mise resolves as before.
   `COMMAND_ENV` also pins mise's data, cache, state and config directories to the image's defaults under `/root`, so
   a CLI profile that moves `XDG_*` (OpenCode's own home) still finds the lay-down's installs instead of installing
   the pins again.
3. **Laid down per Container.** The Workspace DO runs the lay-down (`@t3flare/sandbox-image/globalMise`) on each new
   Container, keyed by computer's runtime id, after the connect and before computer sends the first command; Terminals,
   CLI processes and the Workspace DO's own commands wait for it too. It installs the owner's tools with the text as a
   staging global config (`mise install` from `/`), and keeps the file only when `git --version` and `gh --version`
   still run under it, with mise's auto-install off: invalid TOML fails every shim, git's included, so laying it down
   unchecked would break t3's git. The launch records the text, so a running Container keeps what it started with, a
   change applies at the next start, and an agent's edit of the file is gone then.
4. **Held and bounded.** The lay-down counts as a command: no idle stop and no reclaim under it, and the idle time
   counts from its end. The script bounds its lock (60 s), install (600 s, KILL 10 s later) and checks (20 s each); the
   Workspace DO waits their sum and a minute, then kills it and takes the file as not laid down, final for that
   Container. An exec that failed is tried again at once, then by the next command, Terminal, CLI process or alarm, at
   most three times per Container. A connect only passive reads made never runs it; the alarm then runs it for a
   Container that had none. The outcome is kept in the Workspace DO's storage,
   so a new instance does not run a finished lay-down again; its answer is kept on the Container's disk by revision and
   SHA-256, on the assumption that a Container's disk never outlives it (one that did would at worst skip laying down
   the same text again). A Durable agent's command cut off while it waited (a timeout or an abort during the install)
   is never sent afterwards: the Session hands its id to the Workspace DO when it stops it, and the Workspace DO refuses
   to dispatch it once the connect returns; one already sent is killed as soon as it is.
5. **No GitHub token.** `COMMAND_ENV` sets `MISE_GITHUB_GH_CLI_TOKENS=false`, `MISE_GITHUB_USE_GIT_CREDENTIALS=false`
   and an empty `MISE_GITHUB_CREDENTIAL_COMMAND`, and an environment variable beats the owner's and a repository's
   files: mise sends no token from gh's `hosts.yml`, git's credential helper (the Workspace's one-repo token) or a
   credential command, any of which could fail an install that works without one. `MISE_DISABLE_TOOLS` and
   `MISE_DISABLE_BACKENDS` are held empty, so no file disables git or gh by name. The stage showed each of the five
   arriving whole, empty values included, in a Durable agent's command, a Terminal, the Workspace DO's command and a
   command of each of Codex, Claude Code, OpenCode and pi. A Variable cannot set any of them (the `MISE_` prefix is
   refused).
6. **Reported.** Each lay-down is logged (the text's size and SHA-256, never the text) and sent to the Environment DO;
   the panel's Status shows the last one across all Workspaces: laid down or not, and why. A start with no Global mise
   config reports too ("no Global mise config"), so a cleared config replaces an older "not laid down".
7. **Audit.** A `file` setting is audited as its size and SHA-256, not its text, a departure from §3's "as resolved
   before and after": the audit log is one stored value of up to 1,000 entries, and a Durable Object value is at most
   2 MB. The current text is on the panel.
8. **No install cache.** Every Container start installs the owner's tools again; mise's data stays in its default
   place on the Container's disk, never under the synced `/workspace/.t3flare/`. A cache is follow-up work.

Considered and rejected:

- **Laying a file down whatever git and gh do under it.** One typo would break t3's git status and commit in every
  Workspace.
- **Putting the file under the Workspace.** It would sync, and an agent's edit would outlive the Container.
- **An empty `MISE_GITHUB_TOKEN` alone.** mise falls through to the next source.
