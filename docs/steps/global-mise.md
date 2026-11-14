# SPI-1150: Global mise config in Environment settings

Report for SPI-1150, a sibling under SPI-1001's triage. Plan, M0 and both reviews' changes:
[`global-mise-plan.md`](global-mise-plan.md). Decision record: the Global mise config refinement of
[ADR-0032](../adr/0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md).
Evidence: [`global-mise/`](global-mise/), from stage `pmise` (destroyed) and `test:docker`.

## What changed

- **The setting** (`@t3flare/harness-registry`).
  - `globalMiseConfig` in `ENVIRONMENT_SETTINGS`, of a new `file` field type: at most 16 KiB of UTF-8, no NUL (cloudpid's
    `toolchainsProblem`, ported), CRLF stored as LF (`normalizeField`), default empty.
  - `globalMise.ts`: a text's digest (`digestOf`), the lay-down's report (`GlobalMiseReport`, validated by
    `globalMiseReport`) and its Status line (`describeGlobalMise`).
- **The panel** (`page.ts`, `panel.ts`, `store.ts`, `environmentDO.ts`).
  - A monospace text area in a row of its own, without `maxlength`, a newline after `<textarea>` so the text
    round-trips. Its description says the file is agent-readable and not for secrets, and that `disable_tools` and
    `disable_backends` are ignored.
  - The audit records a `file` setting as `{ bytes, sha256 }`, not its text.
  - Status shows "last Global mise lay-down" (the last across all Workspaces), sent by the Workspace DO through
    `noteGlobalMise` (validated, then kept under `t3flare:environment:global-mise`).
- **Every command's environment** (`COMMAND_ENV`, `apps/sandbox-image/src/env.ts`): the image's base file as mise's
  system config, `/var/lib/t3flare/mise/config.toml` as its global config, `MISE_GITHUB_GH_CLI_TOKENS=false`,
  `MISE_GITHUB_USE_GIT_CREDENTIALS=false`, and `MISE_GITHUB_CREDENTIAL_COMMAND`, `MISE_DISABLE_TOOLS`,
  `MISE_DISABLE_BACKENDS` empty. `variables.json` kept all five (D4 and the `credential_command` guard stay).
  `MISE_DATA_DIR`, `MISE_CACHE_DIR`, `MISE_STATE_DIR` and `MISE_CONFIG_DIR` are pinned to the image's defaults under
  `/root` (review round 1): OpenCode's profile moves `XDG_*` to its own home, which would have sent mise to another
  data directory, where each command reinstalled the pins and an owner-pinned git had no credential helper. Only
  OpenCode moves `XDG_*`; every CLI keeps `HOME=/root`. A Variable cannot set them (the `MISE_` prefix is refused).
- **The lay-down script** (`apps/sandbox-image/src/globalMise.ts`): `flock`, an answer per revision and SHA-256,
  the text from stdin into a unique staging file, `mise install` from `/` under `timeout -k 10 600`, `git --version`
  and `gh --version` under `timeout -k 5 20` with mise's three auto-installs off, a checked `mv`, the image's system
  gitconfig copied into an owner-pinned git, one JSON answer on the last line. 124 and 137 from the install or
  either check (each read alone) are `timedOut`. The Workspace DO validates every field of the answer.
  `GLOBAL_MISE_DEADLINE_MS` is the script's bounds plus a minute (780 s). The Dockerfile notes beside
  `ARG MISE_VERSION` that a bump re-runs `mise.docker.test.ts`.
- **The Workspace DO** (`globalMise.ts`, `containerOnly.ts`, `containerLaunch.ts`, `stoppedExecs.ts`,
  `WorkspaceDO.ts`).
  - `GlobalMise` runs the script once per Container, keyed by computer's runtime id, after every
    `ContainerOnlyBackend.connect` and before computer gets the handle. It holds the Container (`#running`), notes
    use when it ends, kills the exec at the deadline, retries a failed exec once at once and then from the next
    command, Terminal, CLI process or the alarm, at most three times, and keeps the outcome in storage. A connect only
    passive reads made never runs it; the alarm runs it for a running Container that had none. A start with no text
    runs nothing and reports `none`, so Status stops showing an older start's file. Without a runtime id, or with a
    launch from before this change, it runs the idempotent script.
  - The launch records the text with its digest, revision and source (`withGlobalMise`); `containerState()` shows the
    digest only (`shownLaunch`) and the outcome (`globalMise`).
  - The owner's Variables (SPI-1152) reach the lay-down's environment under `COMMAND_ENV`.
  - `StoppedExecsBackend`: a command the Session stopped before it was sent is never sent (the Session hands its id
    to `killExecs`, which now remembers it).
  - `reclaimReason()` answers a stage check (through the admin route's `workspace-call`).
- **computer-env** (`exec.ts`): a command cut off before it started is killed as soon as computer dispatches it, and
  handed to the ledger again; on the Container (never the Worker Shell) its message and its kept output say "the
  Container was installing the Global mise config" when the Workspace DO says one runs (`startingNote`).
- **Tests and harnesses.** `mise.docker.test.ts` (M0, now through the real script and `COMMAND_ENV`, mitmproxy pinned
  by digest, a row where a repo's file turns `use_git_credentials` on); stage harness `scripts/pmise.ts`; `pmise` in
  `STAGES`.
- **Docs.** ADR-0032's Global mise config refinement; `GLOSSARY.md`: Global mise config. No t3 lean, so no
  `upstream-fragility.md` entry.

## Seams tested

| Seam | Tests |
| -- | -- |
| The setting: 16 KiB by bytes, NUL, CRLF, default, revision | `packages/harness-registry/src/environment.test.ts` |
| mise's data, cache, state and config dirs are the lay-down's for every CLI profile | `apps/environment/test/miseDirs.test.ts` |
| The panel: audit as digest, text area, Status, a malformed report refused | `apps/environment/test/environmentSettings.test.ts`, `harnessPage.test.ts` |
| `GlobalMise`: key, joined runs, kept outcome across instances, hold, deadline, retries, a passive-only connect never runs it and the alarm catches up, no text reported as `none`, no runtime id | `apps/agents/test/globalMise.test.ts` |
| `connect` runs the lay-down with the runtime id before the handle is given | `apps/agents/test/containerOnly.test.ts` |
| The launch carries the text; `containerState` shows only its digest | `apps/agents/test/containerLaunch.test.ts` |
| The script in bash with stub mise, git and gh: laid or not, 124/137, each check's exit alone, idempotence, no text, lock, gitconfig; the answer validated field by field | `apps/agents/test/globalMiseScript.test.ts` |
| A stopped command is never sent | `apps/agents/test/stoppedExecs.test.ts` |
| A command cut off before it started is killed once dispatched; the install named on the Container only | `packages/computer-env/src/exec.test.ts` |
| `COMMAND_ENV` under the Variables | `apps/agents/test/variables.test.ts` |
| The image's own mise: layering, removers, requests, tokens | `apps/environment/test/docker/mise.docker.test.ts` (`test:docker`) |

**Where the bash test runs.** `globalMiseScript.test.ts` runs the real script in `ubuntu:26.04` (the image's base,
whose coreutils are uutils) and pulls the image when it is missing; it skips only without a Docker daemon. It is part
of `pnpm run check`, so it runs on every machine with Docker and in deploy-prod's check on `ubuntu-latest`. It ran
locally against `ubuntu:26.04` for this round. The script's coreutils were checked against uutils 0.10.0 there:
`timeout` exits 124 on TERM and 137 after `-k`'s KILL, as GNU's does; `date +%s%N`, `wc -c <`, `mv -f`, `cp`,
`dirname` and `tail -n 1` behave as GNU's; `flock` is util-linux's. The script uses no `sha256sum -c` (the digest is
computed on the Workspace DO's side) and no `install`.

## Evidence

Every stage file names the deployed commit (`/_t3flare/health`): **`8ef01cb`**, after review round 1's fixes and the
rebase onto SPI-1148 (`5bc4bb7`). Commits after it change only the stage harness, the docs and the evidence.
`variables.json` ran first. The `m0-*.json` files were taken again from `test:docker` at `df41598` (the test, the
script and `COMMAND_ENV` as at `8ef01cb`).

| File | Shows |
| -- | -- |
| `variables.json` | With `node = "24.11.1"` set and a gh `hosts.yml` in each command's own home, on a fresh Container per path: all five guards arrive whole (empty ones too), `mise token github` is `(none)`, mise's effective data, cache, state and config dirs are `/root`'s, and `node --version` with mise's three auto-installs off answers `v24.11.1` from `/root/.local/share/mise/installs`, with nothing installed under the path's own `XDG_DATA_HOME`. Paths: the Workspace DO's command, a Durable agent's `bash`, a t3 Terminal, and a command of each of Codex, Claude Code, OpenCode (whose `XDG_DATA_HOME` is its own home's) and pi. |
| `install.json` | `node = "24.11.1"` (the image has 26.13.0): `v24.11.1` in a new Container from a Durable agent's `bash`, pi's command and a t3 Terminal, each laid down (4.2–4.4 s). |
| `override.json` | A repo's `node = "22.12.0"` wins in the repo; the global `github:junegunn/fzf` stays; outside the repo node is the global 24.11.1. |
| `git-gh.json` | Under the pin: t3's status, a commit through the Workspace's git, `gh --version`. An owner-pinned `conda:git` 2.49.0 has the credential helper, `git credential fill` gives a password, and `git fetch` works. t3's own commit action fails as its control without a Global mise config does (SPI-1186). |
| `hold.json` | Idle time 1 minute, budget 1, an install of 152 s started from a Durable agent's `bash`: after 35 s the reclaim's reason is "in use", a second Workspace's start is refused with the budget's reason, the Container never stops, and the command answers `v24.11.1`. |
| `restart.json` | A change while the Container runs leaves its file and launch alone; an agent's edit is gone at the next start, which has the new text. |
| `invalid.json` | Invalid TOML is not laid down; git and gh run; Status reads "not laid down (mise install exit 1)". |
| `size.json` | A text of exactly 16,384 bytes is saved, laid down and read back with the same SHA-256; one byte more is refused whole. |
| `cost.json` | Start to first command: 1.7 s and 2.2 s without a pin; 5.9 s and 5.9 s with the node pin (lay-down 4.1 s each; no cache, so the second start installs again). |
| `empty.json` | No Global mise config: 3.3 s and 2.5 s, no lay-down exec (outcome `none`, no answer), nothing in `/var/lib/t3flare/mise`, the image's node, and Status reads "no Global mise config" after `invalid.json`'s "not laid down". **There is no baseline from `main` for the start time:** what carries the claim that an empty config costs what it did is that no lay-down exec runs. |
| `late.json` | A Durable agent's `bash` with a 10 s timeout during a 49 s install: the command never runs afterwards, and its output reads "the Container was installing the Global mise config". |
| `m0-*.json` | M0 through the real script and `COMMAND_ENV`, on the image's mise. |

## Readings and limits

- **t3's own commit action fails on this base, with or without a Global mise config** (`git-gh.json`'s control;
  SPI-1186). Re-run `git-gh.json` when SPI-1186 lands:
  t3's git driver builds its commit context with a temporary `GIT_OBJECT_DIRECTORY` and alternates on its own
  side, which the Container cannot see (`prepareCommitContext.expandSplitIndex`, `not_a_repository`). t3flare's
  router bridges `GIT_INDEX_FILE` only. Not this change. The ticket's "t3's git status and commit"
  is covered by t3's status and a commit through the Workspace's git.
- **Status keeps one lay-down across all Workspaces**: the last to report. Another Workspace's later start replaces
  a "not laid down".
- **An install that fails for one tool still lays the file down** when git and gh run (D6): `hold.json`'s long pin
  installs with exit 1, laid down; the failed tool fails where it is used. mise's output is in
  `/var/lib/t3flare/mise/install.log` on the Container.
- **A git mise installs lazily after the lay-down** (a repo's own pin, installed on first use) gets no system
  gitconfig: the copy runs only in the lay-down.
- **`disable_backends` reads `[""]`** with the variable empty (`variables.json`); M0 shows it disables no backend.
- **No install cache**: a pinned start costs its install every time (`cost.json`).
- **A Durable agent's command that reuses computer's cached handle does not retry a failed lay-down**, nor run one
  that only passive reads skipped (a Container already running across a deploy); the alarm does, within a renewal
  period, at most three times per Container.
- **`hold.json`'s samples** list the kept outcome of the earlier Container until the new one's lay-down ends.
- **Checks.** `pnpm run check` passes at CHECK_SHA (34/34); the commit after it changes only this line.

## Follow-ups

- **SPI-1185:** an install cache for the Global mise config, and each Workspace's last lay-down on the panel (Status
  keeps only the last one overall).
- **SPI-1186:** t3's commit action and its temporary `GIT_OBJECT_DIRECTORY`; `git-gh.json` is re-run when it lands.
