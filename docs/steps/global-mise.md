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
- **The lay-down script** (`apps/sandbox-image/src/globalMise.ts`): `flock`, an answer per revision and SHA-256,
  the text from stdin into a unique staging file, `mise install` from `/` under `timeout -k 10 600`, `git --version`
  and `gh --version` under `timeout -k 5 20` with mise's three auto-installs off, a checked `mv`, the image's system
  gitconfig copied into an owner-pinned git, one JSON answer on the last line. 124 and 137 are both `timedOut`.
  `GLOBAL_MISE_DEADLINE_MS` is the script's bounds plus a minute (780 s). The Dockerfile notes beside
  `ARG MISE_VERSION` that a bump re-runs `mise.docker.test.ts`.
- **The Workspace DO** (`globalMise.ts`, `containerOnly.ts`, `containerLaunch.ts`, `stoppedExecs.ts`,
  `WorkspaceDO.ts`).
  - `GlobalMise` runs the script once per Container, keyed by computer's runtime id, after every
    `ContainerOnlyBackend.connect` and before computer gets the handle. It holds the Container (`#running`), notes
    use when it ends, kills the exec at the deadline, retries a failed exec once at once and then from the next
    command, Terminal, CLI process or the alarm, at most three times, and keeps the outcome in storage. A passive
    read's connect never retries. Without a runtime id, or with a launch from before this change, it runs the
    idempotent script.
  - The launch records the text with its digest, revision and source (`withGlobalMise`); `containerState()` shows the
    digest only (`shownLaunch`) and the outcome (`globalMise`).
  - The owner's Variables (SPI-1152) reach the lay-down's environment under `COMMAND_ENV`.
  - `StoppedExecsBackend`: a command the Session stopped before it was sent is never sent (the Session hands its id
    to `killExecs`, which now remembers it).
  - `reclaimReason()` answers a stage check (through the admin route's `workspace-call`).
- **computer-env** (`exec.ts`): a command cut off before it started is killed as soon as computer dispatches it, and
  handed to the ledger again; its message and its kept output say "the Container was installing the Global mise
  config" when the Workspace DO says one runs (`startingNote`).
- **Tests and harnesses.** `mise.docker.test.ts` (M0, now through the real script and `COMMAND_ENV`, mitmproxy pinned
  by digest, a row where a repo's file turns `use_git_credentials` on); stage harness `scripts/pmise.ts`; `pmise` in
  `STAGES`.
- **Docs.** ADR-0032's Global mise config refinement; `GLOSSARY.md`: Global mise config. No t3 lean, so no
  `upstream-fragility.md` entry.

## Seams tested

| Seam | Tests |
| -- | -- |
| The setting: 16 KiB by bytes, NUL, CRLF, default, revision | `packages/harness-registry/src/environment.test.ts` |
| The panel: audit as digest, text area, Status, a malformed report refused | `apps/environment/test/environmentSettings.test.ts`, `harnessPage.test.ts` |
| `GlobalMise`: key, joined runs, kept outcome across instances, hold, deadline, retries, passive, no text, no runtime id | `apps/agents/test/globalMise.test.ts` |
| `connect` runs the lay-down with the runtime id before the handle is given | `apps/agents/test/containerOnly.test.ts` |
| The launch carries the text; `containerState` shows only its digest | `apps/agents/test/containerLaunch.test.ts` |
| The script in bash with stub mise, git and gh: laid or not, 124/137, idempotence, no text, lock, gitconfig | `apps/agents/test/globalMiseScript.test.ts` |
| A stopped command is never sent | `apps/agents/test/stoppedExecs.test.ts` |
| A command cut off before it started is killed once dispatched; the install named | `packages/computer-env/src/exec.test.ts` |
| `COMMAND_ENV` under the Variables | `apps/agents/test/variables.test.ts` |
| The image's own mise: layering, removers, requests, tokens | `apps/environment/test/docker/mise.docker.test.ts` (`test:docker`) |

## Evidence

Every stage file names the deployed commit (`/_t3flare/health`): **`1d55bd1`**, the head after the rebase onto
SPI-1152 with every code change but one lint fix in a test (`56d9fc1`). `variables.json` ran first; an earlier run at
`8b7fda3` (`COMMAND_ENV` alone, before the lay-down) had decided D4 and the `credential_command` guard the same way.

| File | Shows |
| -- | -- |
| `variables.json` | With a gh `hosts.yml` in each command's own home, all five variables arrive whole (empty ones too) and `mise token github` is `(none)` from the Workspace DO's command, a Durable agent's `bash`, a t3 Terminal, and a command of each of Codex, Claude Code, OpenCode and pi. |
| `install.json` | `node = "24.11.1"` (the image has 26.13.0): `v24.11.1` in a new Container from a Durable agent's `bash`, pi's command and a t3 Terminal, each laid down (4.4–5.3 s). |
| `override.json` | A repo's `node = "22.12.0"` wins in the repo; the global `github:junegunn/fzf` stays; outside the repo node is the global 24.11.1. |
| `git-gh.json` | Under the pin: t3's status, a commit through the Workspace's git, `gh --version`. An owner-pinned `conda:git` 2.49.0 has the credential helper, `git credential fill` gives a password, and `git fetch` works. |
| `hold.json` | Idle time 1 minute, budget 1, an install of 61 s started from a Durable agent's `bash`: at 35 s the reclaim's reason is "in use", a second Workspace's start is refused with the budget's reason, the Container never stops, and the command answers `v24.11.1`. |
| `restart.json` | A change while the Container runs leaves its file and launch alone; an agent's edit is gone at the next start, which has the new text. |
| `invalid.json` | Invalid TOML is not laid down; git and gh run; Status reads "not laid down (mise install exit 1)". |
| `size.json` | A text of exactly 16,384 bytes is saved, laid down and read back with the same SHA-256; one byte more is refused whole. |
| `cost.json` | Start to first command: 2.3 s and 2.2 s without a pin; 6.8 s and 10.0 s with the node pin (lay-down 4.6 s and 6.6 s; no cache, so the second start installs again). |
| `empty.json` | No Global mise config: 2.4 s and 3.2 s, no lay-down exec, nothing in `/var/lib/t3flare/mise`, the image's node. |
| `late.json` | A Durable agent's `bash` with a 10 s timeout during a 51 s install: the command never runs afterwards, and its output reads "the Container was installing the Global mise config". |
| `m0-*.json` | M0 again through the real script and `COMMAND_ENV`; the test and image are those of `96139d2` (the files name `b04b74e`, which changed neither). |

## Readings and limits

- **t3's own commit action fails on this base, with or without a Global mise config** (`git-gh.json`'s control):
  t3's git driver builds its commit context with a temporary `GIT_OBJECT_DIRECTORY` and alternates on its own
  side, which the Container cannot see (`prepareCommitContext.expandSplitIndex`, `not_a_repository`). t3flare's
  router bridges `GIT_INDEX_FILE` only. Not this change; raised with the orchestrator. The ticket's "t3's git status and commit"
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
- **A Durable agent's command that reuses computer's cached handle does not retry a failed lay-down**; the alarm
  does, at most three times per Container.
- **`hold.json`'s samples** list the kept outcome of the earlier Container until the new one's lay-down ends.
- **Checks.** `pnpm run check` passes at `9124fdd` (34/34); the commit after it changes only this report.

## Follow-up to file (pending with the orchestrator)

**Title:** Install cache for the Global mise config.
**Body:** Every Container start installs the owner's Global mise config again (SPI-1150 `cost.json`: 4.6–6.6 s for
one node pin; minutes for a heavier one). Research `directorySnapshots` in the Container start options (and
cloudpid's snapshot of `MISE_DATA_DIR` with `downloads-cas`) for a cache keyed by the text's SHA-256, never under the
synced `/workspace/.t3flare/`. Also: show each Workspace's last lay-down on the panel, not only the last one overall.
