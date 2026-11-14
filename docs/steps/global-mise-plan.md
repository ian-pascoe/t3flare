# SPI-1150: Global mise config in Environment settings — plan

Status: building (2026-11-14). The review of `eb82395` approved it with changes (folded in, **Review changelog**);
the re-review of `8a9f1d4` approved it with changes C1–C6 (folded in during Build, **Re-review changelog**, which wins
over any section below it). M0 done 2026-11-13. Ticket: SPI-1150, a sibling under SPI-1001's triage; its decisions are
settled and not reopened here. Base: `main` at `660f922` (SPI-1149). Branch `spi-1150-global-mise`. Stage `pmise`.
Report (after Build): `docs/steps/global-mise.md`. Background: [`spi-1001-research-mise.md`](spi-1001-research-mise.md).

## Review changelog (review of `eb82395`)

Where a section below disagrees with this table, the section is the revised one; the table says what moved.

| Item | Change |
| -- | -- |
| B1: nothing holds the Container during the lay-down | `GlobalMise` holds the Container for its run (`#running` raised through a hold, use noted when it ends), so neither the idle alarm nor a reclaim stops it mid-install (§3.4). Unit test, and stage case `hold.json` with the idle time at 1 minute and an install longer than that. |
| B2: unbounded waits | `timeout -k 10 600` on the install; `timeout -k 5 20` on each of `git --version` and `gh --version`, with mise's auto-install off for them; a DO-side deadline of 11 minutes on the whole exec, past which the run is logged and treated as not laid. Exit 124 is reported as a timeout (§3.2, §3.3). |
| B3: "once per Container start" had no key | The run is keyed by the Container's runtime id: it runs on every `ContainerOnlyBackend.connect`, keyed by the handle's `runtimeId`, with `LAUNCH_KEY` read after `connect` returns. A Container that died on its own comes back with a new runtime id, so it gets its own run. The retry rule on computer's path is stated (§3.3). Both are unit-tested. |
| B4: the guard variables' arrival unproven | `variables.json` runs **first** on the stage: `mise settings get` and `mise token github`, with a `hosts.yml` present, from a Durable agent's `bash`, a t3 Terminal, and a command run by each of Codex, Claude Code, OpenCode and pi. A transport that drops an empty value drops D4 and the `credential_command` guard; a CLI that filters a name gets it set back through its own mechanism (§2, §6). |
| D1 | Accepted, with D3's change. |
| D2 | Accepted. ADR-0032's refinement records the departure from §3's "as resolved before and after"; the `global-mise` log line carries the same SHA-256. |
| D3 | Changed: the panel's Status shows the last lay-down (Workspace, revision, laid or not, exit, when) beside "last taken by a Workspace", through one RPC from the Workspace DO (§4). |
| D4 | Accepted unless `variables.json` forces dropping it. The setting's description says `disable_tools` and `disable_backends` are ignored. |
| D5 | Accepted. The text area has no `maxlength` (it counts UTF-16 units); the server's byte check is the limit. |
| D6 | Accepted. |
| Advisories folded in | `flock` around the script, a unique staging name, `mv` checked; the answer keyed by revision and SHA-256 (and the disk-outlives-a-start assumption noted in the ADR); `containerState()` returns the text's size and hash, not the text; the panel says the file is readable by agents and not for secrets; `source` in the log line and the answer; a first `bash` that times out during the install names it; a bash test of the real script with stub mise, git and gh, the text on stdin; a full 16 KiB text on the stage; CRLF normalised to LF and a newline after `<textarea>`; an owner-pinned `conda:git` gets the system gitconfig's credential helper, with a credentialed fetch under such a pin in `git-gh.json`; a note beside `ARG MISE_VERSION`; an unguarded row with a repo's file turning `use_git_credentials` on; `mitmproxy/mitmproxy` pinned by digest; SPI-1152's overlap (§8); the install-cache follow-up carried in the report, filing pending with the orchestrator. |

## Re-review changelog (re-review of `8a9f1d4`, folded in during Build)

| Item | Change |
| -- | -- |
| C1: a first command cut short during the install still runs afterwards | computer-env's `exec` covers only the wait in `connect`; once `stopped` is set before the command has started, it now kills the command as soon as `runtime.exec` returns and calls `ledger.stopped(id)` again, so the Session's kill loop finds it. The "while the Container installed the Global mise config" message is built with it. `exec.test.ts` case and a stage case (`late.json`). |
| C2: the retry depended on who calls next | `alarm()` starts the retry of a runtime recorded as failed (not awaited, at most 3 attempts per runtime). Exec-failed and deadline-killed runs are sent to `noteGlobalMise` too. |
| C3: passive execs | A `passive: true` exec (`#usage`, from the reclaim and the idle stop) never calls `ensure`. |
| C4: bounds | The script's constants are exported (`GLOBAL_MISE_BOUNDS`: lock 60 s, install 600 + 10 s, each check 20 + 5 s) and the DO's deadline is derived from them plus a 60 s margin (780 s). `timeout -k` exits 124 on TERM and 137 on KILL; both are `timedOut`. |
| C5: build order | Stage `pmise` is deployed and `variables.json` run right after step 4's `COMMAND_ENV` change, before the tests and docker rows that assert `COMMAND_ENV`. |
| C6: `hold.json` | The install is started from a Durable agent's `bash` (not `WorkspaceDO.exec`, which holds by itself); the reclaim is tried more than 30 s after the start and its reason, "in use", recorded. |
| Advisories | The per-runtime outcome is kept in kv (`t3flare:global-mise`), so a new DO instance does not rerun a deadline-killed run. A handle without a `runtimeId`, or a launch from before this change without `globalMise`, runs the idempotent script with no text (nothing laid; the answer says so). `noteGlobalMise` goes through `ctx.waitUntil`, and the Environment DO validates its shape and size; Status keeps only the last lay-down across all Workspaces. If a CLI drops one of the two `false` guards and has no way to set it back, Build stops and escalates. Limit: a git that mise installs lazily after the lay-down gets no system gitconfig. SPI-1152's launch Variables reach the lay-down (they are refused under `MISE_`, `GIT_`, `GH_`, `GITHUB_` and the proxy's names, so none re-enables a token source). The answer is parsed from the last line of stdout (`BASH_ENV`'s EXIT trap prints on stderr). |

## M0: what the image's own mise does

Run in `test:docker` (`apps/environment/test/docker/mise.docker.test.ts`) against the Workspace image built from
`apps/sandbox-image/image/Dockerfile` for linux/amd64, at commit `bc949c0` (the test's own commit; every file names it
and the image id). Evidence: [`global-mise/m0-*.json`](global-mise/). The research ran on mise 2026.11.7/8; the image
pins **2026.11.2**, and every finding below is from that binary.

```
pnpm --filter @t3flare/environment exec vitest run --config vitest.docker.config.ts test/docker/mise.docker.test.ts
# T3FLARE_MISE_M0_OUT=<dir> writes the four files
```

### `m0-version.json`

- The image runs `2026.11.2 linux-x64 (2026-11-05)`, the Dockerfile's `MISE_VERSION`.
- With the design's variables, `mise config ls` in a repo lists the base file, the owner's global file, then the repo's
  `mise.toml`: system < global < project, as the research found on the newer version.

### `m0-layering.json`

- **The base file as system config** (`MISE_SYSTEM_CONFIG_FILE`) and the owner's as global (`MISE_GLOBAL_CONFIG_FILE`)
  layer per tool on 2026.11.2: under a typical owner file (`node`, `python`, `go`, a `github:` tool, `[settings]` and
  `[env]`), `conda:git`, `gh`, `bun`, `pnpm` and `uv` still come from the base file, the owner's `node` and `python`
  win over the base's, and the owner's `[env]` variable reaches `mise env`.
- **A repo's `mise.toml` wins per tool:** the repo's `node` replaces the owner's; the owner's `python`, `go` and
  `github:` tool stay.
- **Absent or empty global file resolves as today** (today: the base file as the global config): the same versions of
  every base tool, the same `git --version` and `gh --version`. An empty file is listed by `mise config ls` with no
  tools; an absent one is not listed.
- **What in an owner's file can still remove git or gh,** run offline with each file alone:

  | Owner's file | No guard | Guard variables | The design's lay-down |
  | -- | -- | -- | -- |
  | `disable_tools = ["gh", "conda:git"]` | git and gh fail | both run | laid down, both run |
  | `disable_backends = ["conda", "aqua"]` | gh fails | both run | laid down, both run |
  | `enable_tools = ["node"]` | git and gh fail | both fail (`MISE_ENABLE_TOOLS=` does not override) | **not laid down**, both run |
  | invalid TOML | git and gh fail (mise refuses to load any config) | both fail | **not laid down**, both run |
  | `gh = "0.0.1"` (cannot install) | gh fails | gh fails | **not laid down**, both run |
  | `git = "2.40.0"` (no such registry tool) | both run (a warning) | both run | laid down (install exits 1), both run |
  | `[env] PATH = "/nowhere"` | both run (shims) | both run | laid down, both run |

  So the guard is two parts. `MISE_DISABLE_TOOLS=` and `MISE_DISABLE_BACKENDS=` (empty) beat any file's setting. For
  the rest, which no variable stops (`enable_tools`, a file mise cannot parse, a git or gh the owner names that does not
  install), the lay-down keeps the owner's file only if `git --version` and `gh --version` still run under it.
  **Invalid TOML is the sharp case:** mise then fails every shim, git included, so laying it down unchecked would break
  t3's git in every Workspace.

### `m0-requests.json`

Installing `node = "24.11.1"` and `"github:junegunn/fzf" = "0.56.3"` through the lay-down, through a logging TLS proxy:

- Hosts: `mise-versions.jdx.dev` (4), `nodejs.org` (3), `github.com` (3: a HEAD probe and two downloads),
  `release-assets.githubusercontent.com` (3). **No `api.github.com` request, and no request carries a token.** Laid
  down and installed in 6.0 s (emulated amd64 on an arm64 host; the stage measures the real cost).
- For comparison, with `MISE_USE_VERSIONS_HOST=false`: 2 `api.github.com` requests (the release, its attestation).

### `m0-token.json`

`MISE_USE_VERSIONS_HOST=false` in every case, so mise goes to `api.github.com`, where a token would be sent. The
proxy records each request's `Authorization` header.

- **The variables:** `MISE_GITHUB_GH_CLI_TOKENS=false` (gh's `hosts.yml`), `MISE_GITHUB_USE_GIT_CREDENTIALS=false`
  (`git credential fill`), and `MISE_GITHUB_CREDENTIAL_COMMAND=` (empty; the owner's `github.credential_command`).
- **Controls, no guard:** a `hosts.yml` (as `gh auth login` leaves it) is sent as `Bearer ghp_…`; the image's own git
  credential helper, answering through a stand-in `computer.internal`, is sent as `Bearer ghs_…` once the owner's file
  turns `github.use_git_credentials` on; an owner's `credential_command` is sent too. Each fake token was refused by
  GitHub (401) and **the install failed**, where the same install with no token succeeds: the ticket's reliability
  reason, reproduced.
- **With the variables:** every source present (`hosts.yml`, the helper answering, a git on PATH), and the owner's
  global file or a repo's `mise.toml` turning each source on: `mise token github` answers `(none)`, and no request
  carries a token. **An environment variable beats both files.**
- **Found on the way:** mise runs `git credential fill` with its shims taken off PATH, and the image has no git outside
  the shims, so that source finds no git in the image as built (the control needed a git linked into
  `/usr/local/bin`). It is turned off anyway, so it stays off if the image gains a git. A repo's
  `credential_command` is ignored by mise itself ("ignored for security reasons").
- **Not guarded (not in the ticket's list):** the three token variables (no command environment sets one; an agent
  that exports one is its own act), mise's OAuth device-flow token and `github_tokens.toml` (each made only by an
  agent's own login).

- **What M0 does not show:** M0 passes the variables with `docker run -e`, which is not how a command gets them in a
  Container. The stage's `variables.json` checks each real path (§6).

## The design

### 1. The setting (`@t3flare/harness-registry`)

One entry in `ENVIRONMENT_SETTINGS`, as ADR-0032 §2 provides:

```ts
globalMiseConfig: {
  title: "Global mise config",
  description:
    "A mise.toml every Container's commands get, under a repository's own and over the image's base tools. Laid down "
    + "and installed at each Workspace's next Container start; a running Container keeps what it started with. Kept "
    + "only if git and gh still run under it. disable_tools and disable_backends are ignored. Agents can read this "
    + "file: put no secret in it, [env] included.",
  schema: { type: "file", maxBytes: 16 * 1024, default: "" },
}
```

- **A new field type, `file`** (D5): the text of a file a Container gets. `fieldProblem` refuses a non-string, a NUL
  ("contains a NUL character") and more than `maxBytes` of UTF-8 ("is longer than 16 KiB of UTF-8"): cloudpid's
  `toolchainsProblem`, ported (about 10 lines; `harness-registry` takes no dependency on `@cloudpid/config`). The
  `text` type keeps its rules, so the Harness settings' fields do not change.
- **CRLF is normalised to LF** when a change is applied (`applyEnvironmentChange`, for `file` fields), before the
  comparison with the stored value, so a browser's CRLF round trip never reads as a change.
- `ResolvedEnvironment.globalMiseConfig` is `string`; a stored value that no longer fits reads as `""`.
- **The panel** renders a `file` field as a monospace text area: no spell check, more rows, **no `maxlength`** (it
  counts UTF-16 units; the server's byte check is the limit and its refusal is shown whole), and a newline right after
  `<textarea …>`, since an HTML parser drops the first newline of a text area's content. The section, the API and the
  validation take the entry from the schema; the page needs only the `file` case in its field renderer.
- **The audit** records a `file` setting's before and after as `{ bytes, sha256 }`, not its text (D2): the audit log
  is one stored value of up to 1 000 entries, and a Durable Object value is at most 2 MB. This departs from ADR-0032
  §3's "as resolved before and after", and the refinement says so. The current text is on the panel.

### 2. Every command's environment (`COMMAND_ENV`, `apps/sandbox-image/src/env.ts`)

One change reaches every path: the Durable agent's commands (`SessionDO`, through computerd's env), CLI agents'
processes and Terminals (`terminalEnv`, through the platform's exec), the Workspace DO's own commands
(`WorkspaceDO.exec`), and the lay-down itself (§3).

```ts
MISE_SYSTEM_CONFIG_FILE: BASE_MISE_CONFIG,          // was MISE_GLOBAL_CONFIG_FILE
MISE_GLOBAL_CONFIG_FILE: GLOBAL_MISE_CONFIG,         // /var/lib/t3flare/mise/config.toml
MISE_TRUSTED_CONFIG_PATHS: "/usr/local/share/cloudpid:/workspace",
MISE_YES: "1",
MISE_GITHUB_GH_CLI_TOKENS: "false",                  // the ticket's guard
MISE_GITHUB_USE_GIT_CREDENTIALS: "false",            // the ticket's guard
MISE_GITHUB_CREDENTIAL_COMMAND: "",                  // kept only if variables.json shows empties arrive
MISE_DISABLE_TOOLS: "",                              // D4, the same condition
MISE_DISABLE_BACKENDS: "",                           // D4, the same condition
GIT_TERMINAL_PROMPT: "0",
BASH_ENV: …,
```

- `/var/lib/t3flare/mise` is on the Container's own disk, outside `/workspace`, so the file never syncs.
- With no owner text nothing is written there, and mise resolves exactly as today (`m0-layering.json`).
- **Each CLI's own filtering.** Codex builds its shells' environment from `shell_environment_policy`, whose default
  excludes names matching `*TOKEN*`, `*KEY*` and `*SECRET*`: `MISE_GITHUB_GH_CLI_TOKENS` is likely dropped. Where
  `variables.json` shows a CLI dropping a name, the CLI's profile sets it back (Codex: `shell_environment_policy.set.
  <NAME>`, beside `T3FLARE_EXEC` in `cliProfiles.ts`; the others by their own mechanism if one drops it), and the case
  is run again. If a path drops an **empty** value and has no way to set one, the empty guards go (D4 and
  `credential_command`); the two `false` guards stay.
- **The image** needs one note beside `ARG MISE_VERSION`: a bump re-runs `mise.docker.test.ts` (the nightly job runs
  `test:docker`), since empty-value and layering behaviour is version-fragile.

### 3. Laying it down at each Container start

#### 3.1 What a start uses

`#launch()` records each fresh start's settings (`ContainerLaunch`). It gains `globalMise: { text, bytes, sha256,
revision, source }` (`source` is `environment`, `kept` or `default`, as `takeEnvironment` answers). A running Container
keeps its launch, so a change never reaches it, and the next start takes the new text. An agent's edit of the laid-down
file lasts until its Container stops. `containerState()` returns the launch with the text replaced by its `bytes` and
`sha256`.

#### 3.2 The script (`globalMiseScript`, `@t3flare/sandbox-image/globalMise`)

No Node imports, so the agents Worker imports it. Run through the platform's exec (`ctx.container.exec`, as the leak
scan runs) as `bash -c <script> -- <revision> <sha256>`, under `COMMAND_ENV`, **the text on stdin**:

1. `exec 9>/var/lib/t3flare/mise/.lock; flock -w 60 9`: one lay-down at a time per Container, so two Workspace DO
   instances across a deploy never overlap.
2. If `answer.json` exists and names this revision and SHA-256, print it and stop (the same text was already laid
   down on this disk).
3. Read stdin into a unique staging file, `config.<sha256>.<pid>.toml`, beside the global path.
4. `cd / && timeout -k 10 600 mise install` with the staging file as the global config, output to `install.log`.
5. `MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_NOT_FOUND_AUTO_INSTALL=false timeout -k 5 20 git --version`,
   and the same for `gh --version`, under the staging file (each checked by name against the image's mise in the
   docker test).
6. Both run: `mv -f` the staging file to the global path, and `laid` only if the `mv` succeeded. Else delete it and
   leave the global path as it was at this start (absent: a new Container's disk has none).
7. An owner-pinned git is not the image's: for each `git` under mise's installs on the Container's disk
   (`/root/.local/share/mise/installs/*/*/bin/git`) whose system config lacks the credential helper, copy
   `/usr/local/share/t3flare/gitconfig` into its prefix's `etc/gitconfig`, as the Dockerfile does for the image's
   (Dockerfile:105-114). Checked in the docker test and by `git-gh.json`'s credentialed fetch.
8. Write and print the answer: `{ revision, sha256, source, laid, install (exit), timedOut (exit 124), ms, bytes }`.

#### 3.3 When it runs, and its key (`GlobalMise`, `apps/agents/src/workspace/globalMise.ts`)

- **Keyed by the Container's runtime id.** computer's `ContainerBackend.connect` returns a handle with the
  `runtimeId` of the Container it connected to; a restart inside `connect` (`#readyWithRestarts`) gives a new one, and
  so does any new Container, including one that replaced a Container that died on its own (memory guard, platform
  restart), which never passes `stopContainer()`. `GlobalMise` keeps one run per runtime id: `ensure(runtimeId)` starts
  it or joins it.
- **computer's path** (the Durable agent's `bash` and file tools, the Workspace DO's git, checkpoints and `exec`):
  `ContainerOnlyBackend.connect` calls `ensure(handle.runtimeId)` after the inner `connect` returns, reads
  `LAUNCH_KEY` then (the launch `#budgeted` just recorded for this start), and returns the handle only when the run
  has ended. It runs on **every** connect: a connect to the same Container after a dropped transport finds the run done
  (in memory, else the answer on disk), and costs one exec.
- **Retry rule on computer's path.** computer caches the handle, so no later connect follows a failed run while the
  transport holds. A run whose exec itself failed (the platform's exec refused or broke; not an answer of "not laid" or
  a timeout, which are final for that runtime) is retried once at once inside `connect`; failing again, it is recorded
  as failed for that runtime, and the next `ensure` of it runs again: the next connect (the handle drops when the
  Container stops or the transport breaks), `WorkspaceDO.exec` (which calls `ensure` for the current runtime before its
  command, a no-op once done), a Terminal's `beforeSpawn` or a CLI process's `beforeStart`. A Durable agent's command
  that reuses the cached handle does not retry it.
- **Terminals and CLI processes** (the platform's exec): their `beforeSpawn` and `beforeStart` call `ensure` for the
  runtime id of the last connect (each starts the Container through `exec("true")`, so a connect precedes them).
- **No text, nothing run:** a start without a Global mise config costs what it costs today.

#### 3.4 Holding the Container, and bounds

- **Hold.** A run raises `#running` (through a `hold()` callback that returns its release) for its whole length, so
  `alarm()` does not idle-stop the Container and `#notReclaimable` answers "in use" to another Workspace's reclaim.
  When it ends, it notes use and reschedules the alarm, so the idle time counts from the end of the install.
- **Deadline.** The DO waits at most the script's own bounds plus a 60 s margin: 60 s for the lock, 600 + 10 s for the
  install, 2 × 25 s for the checks, 780 s in all (C4). Past it the DO kills the exec, logs, and treats the run as
  not laid; it is final for that runtime.
- **A first command that times out during the install** (a Durable agent's `bash` with a short timeout, which waits in
  `connect`) names it: computer-env's timeout message (`exec.ts`, "Command timed out") gains "while the Container
  installed the Global mise config" when the Workspace DO reports a lay-down in flight. Built if the error path carries
  that state cheaply (a `GlobalMise.inFlight()` read through the existing failure helper); otherwise reported as a
  limit.

### 4. What is reported

- A `global-mise` log line per run: Workspace, revision, `source`, laid, install exit, timed out, ms, bytes and the
  text's SHA-256 (the audit's), never the text.
- **The panel's Status** (D3): "last Global mise lay-down": Workspace, revision, laid or not, exit, when, beside "last
  taken by a Workspace". The Workspace DO sends each run's answer to the Environment DO (`noteGlobalMise`, one RPC,
  bounded and not awaited by the command); the store keeps the last one (`t3flare:environment:global-mise`).
- `containerState()` gains `globalMise` (the answer); mise's output stays in `install.log` on the Container's disk,
  which an agent can read.

### 5. Install: no cache

As the ticket holds: every start installs the owner's tools again, and `MISE_DATA_DIR` stays mise's default on the
Container's disk, never under the synced `/workspace/.t3flare/`. The install-cache follow-up (`directorySnapshots` in
the start options, unresearched; and the lay-down's answer on the panel per Workspace) is drafted in the report; filing
it is pending with the orchestrator.

### 6. Docs

- **ADR-0032 refinement**, the next free section after SPI-1152's: the setting; the layering (system < global <
  project); the lay-down per runtime id with its hold, bounds and git/gh check; the variables, which beat every file,
  and which of them `variables.json` showed arrive; the audit's `{ bytes, sha256 }` as a departure from §3; the answer
  keyed by revision and SHA-256 on the assumption that a Container's disk never outlives it (a disk that did would at
  worst skip a lay-down of the same text); no install cache. No new ADR: without the cache there is no new trade-off.
- **`GLOSSARY.md`:** **Global mise config**: "The owner's mise configuration that every Container's commands get,
  under a repository's own." _Avoid_: Toolchains (cloudpid's word), global tools.
- **No `upstream-fragility.md` entry:** nothing leans on t3code internals. The mise behaviour it leans on is re-checked
  by `mise.docker.test.ts` in the nightly `test:docker`, which after Build imports the real `COMMAND_ENV` and
  `globalMiseScript`, pins `mitmproxy/mitmproxy` by digest, and adds an unguarded row where a repo's file turns
  `use_git_credentials` on.

### 7. Tests (seams)

| Seam | What it catches | What it misses |
| -- | -- | -- |
| `packages/harness-registry/src/environment.test.ts`: the entry through `applyEnvironmentChange` / `resolveEnvironment` | 16 KiB of UTF-8 accepted, one byte more refused (a multi-byte character counts by bytes), NUL refused, CRLF stored as LF and not a change, default `""`, a stored value that no longer fits reads as `""`, the revision moves only when the text does | the panel |
| `apps/environment/test/environmentSettings.test.ts`: the panel's API and page | a save stores, bumps and audits as `{ bytes, sha256 }`; a refusal stores nothing and answers whole; the text area has no `maxlength` and round-trips its first newline; Status shows the last lay-down | a Container |
| `apps/agents/test/globalMise.test.ts`: `GlobalMise` with a fake exec and clock | one run per runtime id with concurrent callers; a new runtime id runs again (a Container that died on its own); none without text; the launch's text; the hold held for the run and released with use noted; the 11-minute deadline ends it as not laid; an exec failure retried once, then by the next `ensure` | the real script |
| `apps/agents/test/containerOnly.test.ts` (existing seam) | `connect` runs `ensure` with the handle's `runtimeId` on every connect and reads the launch after the inner connect | computer itself |
| `apps/agents/test/containerLaunch.test.ts` | the launch carries the start's text, hash and source; a running Container keeps it | |
| `apps/sandbox-image/src/globalMise.test.ts`: the real script in bash with stub `mise`, `git`, `gh`, `flock` and `timeout` (as `killScript.test.ts` does) | the text from stdin, laid only when both checks run, `mv` checked, an answer of the same revision and hash short-circuits, a different one does not, exit 124 as a timeout, the gitconfig copy | the real mise |
| `mise.docker.test.ts` | the script on the image's mise: the M0 cases through the real script and variables | the platform's transports |

### 8. SPI-1152 (Variables) lands first

SPI-1152 edits the same places. If it is on `main` when the re-review passes, this branch rebases onto it before Build
starts; otherwise Build goes on and rebases when it lands. Where the two meet:

- `fields.ts`: both add a field type; the `file` case sits beside SPI-1152's.
- `ContainerLaunch`: `globalMise` beside its Variables.
- The audit's pick: `file` fields as `{ bytes, sha256 }`, beside its own rule.
- The page's field renderer: one more case.
- `COMMAND_ENV`: SPI-1152's `commandEnv` builder merges the owner's Variables under `COMMAND_ENV`, which wins; the
  guards join `COMMAND_ENV` and so beat a Variable, and its `MISE_` prefix refusal already covers every name here. The
  lay-down is the builder's fourth user, so the owner's Variables reach `mise install` (a Variable a tool's install
  reads, such as a mirror) as they reach every command.
- ADR-0032: this refinement takes the section after SPI-1152's.

## Stage `pmise` (added to `STAGES`)

`apps/environment/scripts/pmise.ts`, modelled on `penv.ts`, through `node scripts/stage.ts run pmise pmise <case>`.
Each file carries the deployed commit (from `/_t3flare/health`). Evidence in `docs/steps/global-mise/`, in this order:

1. `variables.json` (**first**): with a `hosts.yml` present, `mise settings get github.gh_cli_tokens`,
   `github.use_git_credentials`, `github.credential_command`, `disable_tools`, `disable_backends`, and `mise token
   github`, from a Durable agent's `bash`, a t3 Terminal, and a command run by each of Codex, Claude Code, OpenCode and
   pi. Decides §2's conditions before the rest is run.
2. `install.json`: a global `node` pin the image lacks; `node --version` in a new Container from a Durable agent's
   `bash`, a CLI agent's command, and a t3 Terminal.
3. `override.json`: a repo's `mise.toml` naming `node` wins; the other global tools stay.
4. `git-gh.json`: t3's git status and a commit, and `gh --version`, under the pin; and a credentialed `git fetch` of
   the Workspace's repo under an owner-pinned `conda:git`.
5. `hold.json`: the idle time at 1 minute and a pin whose install takes longer (measured in the file); the Container is
   not stopped mid-install, and a second Workspace's start at a budget of 1 does not reclaim it.
6. `restart.json`: a change while a Container runs leaves it alone, and the next start has it; an agent's edit of the
   laid-down file is gone at the next start.
7. `invalid.json`: invalid TOML is not laid down, git still works, and Status shows it not laid with its exit.
8. `size.json`: a full 16 KiB text saved, laid down and read back whole in the Container.
9. `cost.json`: seconds from start to first command, with and without the pin, two starts in a row each.
10. `empty.json`: with no global config, start time as today, and no lay-down exec.

Then the stage is destroyed.

## Build order

1. Rebase onto SPI-1152 if it has landed (§8).
2. The setting: the `file` field type, CRLF, the entry, its tests (`environment.test.ts`).
3. The panel: the renderer, the audit's `{ bytes, sha256 }`, the Status line and `noteGlobalMise`, their tests.
4. The script and its bash test; `COMMAND_ENV`; the Dockerfile note. Then deploy `pmise` and run `variables.json`
   (C5); settle D4 and the `credential_command` guard before anything asserts `COMMAND_ENV`.
5. `GlobalMise` (key, hold, deadline, retry) and its tests; the launch's `globalMise`; `containerState()`.
6. Wiring: `ContainerOnlyBackend.connect`, `WorkspaceDO.exec`, `beforeSpawn`, `beforeStart`; the timeout's naming.
7. `mise.docker.test.ts` on the real script and variables, mitmproxy by digest, the extra row; re-run, its files
   replaced at the new commit.
8. Stage `pmise`: `variables.json` first, then fix any dropped name (§2) and re-deploy; then the rest in order.
9. Docs: ADR-0032 refinement, glossary, report with the install-cache follow-up draft. `pnpm run check`.
10. Destroy `pmise`.

## Decisions (as reviewed)

- **D1. A file under which git or gh fails is not laid down** (accepted), shown in Status (D3).
- **D2. The audit records the text's size and SHA-256** (accepted), recorded in the ADR as a departure from §3.
- **D3. The last lay-down is shown in the panel's Status** (changed by the review).
- **D4. `MISE_DISABLE_TOOLS` and `MISE_DISABLE_BACKENDS` held empty** (accepted, conditional on `variables.json`).
- **D5. A new `file` field type**, no `maxlength` on its text area (accepted).
- **D6. `mise install` runs from `/`** (accepted).
