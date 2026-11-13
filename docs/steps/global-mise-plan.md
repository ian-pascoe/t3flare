# SPI-1150: Global mise config in Environment settings — plan

Status: plan for review, M0 done (2026-11-13). Ticket: SPI-1150, a sibling under SPI-1001's triage; its decisions are
settled and not reopened here. Base: `main` at `660f922` (SPI-1149). Branch `spi-1150-global-mise`. Stage `pmise`.
Report (after Build): `docs/steps/global-mise.md`. Background: [`spi-1001-research-mise.md`](spi-1001-research-mise.md).

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

## The design

### 1. The setting (`@t3flare/harness-registry`)

One entry in `ENVIRONMENT_SETTINGS`, as ADR-0032 §2 provides:

```ts
globalMiseConfig: {
  title: "Global mise config",
  description: "A mise.toml every Container's commands get, under a repository's own and over the image's base tools. "
    + "Laid down and installed at each Workspace's next Container start; a running Container keeps what it started "
    + "with. Kept only if git and gh still run under it.",
  schema: { type: "file", maxBytes: 16 * 1024, default: "" },
}
```

- **A new field type, `file`:** the text of a file a Container gets. `fieldProblem` refuses a non-string, a NUL
  ("text without a NUL character") and more than `maxBytes` of UTF-8 ("text of at most 16 KiB of UTF-8"): cloudpid's
  `toolchainsProblem`, ported (10 lines; `harness-registry` takes no dependency on `@cloudpid/config`). The `text`
  type's character limit stays as it is, so the Harness settings' text fields do not change.
- `ResolvedEnvironment.globalMiseConfig` is `string` (the type follows the schema); a stored value that no longer fits
  reads as `""`.
- **The panel** renders a `file` field as a monospace text area (no spell check, more rows). The section, the API and
  validation pick the entry up from the schema; the page needs only the `file` case in its field renderer.
- **The audit** records a `file` setting's before and after as `{ bytes, sha256 }`, not its text: the audit log is
  one stored value of up to 1 000 entries, and two 16 KiB texts per entry would take it past a Durable Object value's
  2 MB. The current text is always on the panel. (Decision D2.)

SPI-1152 adds Variables as another entry beside it; nothing here is shared with it but the schema.

### 2. Every command's environment (`COMMAND_ENV`, `apps/sandbox-image/src/env.ts`)

One change reaches all of them: the Durable agent's commands (`SessionDO`), CLI agents' processes and Terminals
(`terminalEnv`), and the Workspace DO's own (`WorkspaceDO.exec`).

```ts
MISE_SYSTEM_CONFIG_FILE: BASE_MISE_CONFIG,          // was MISE_GLOBAL_CONFIG_FILE
MISE_GLOBAL_CONFIG_FILE: GLOBAL_MISE_CONFIG,         // /var/lib/t3flare/mise/config.toml
MISE_TRUSTED_CONFIG_PATHS: "/usr/local/share/cloudpid:/workspace",
MISE_YES: "1",
MISE_GITHUB_GH_CLI_TOKENS: "false",
MISE_GITHUB_USE_GIT_CREDENTIALS: "false",
MISE_GITHUB_CREDENTIAL_COMMAND: "",
MISE_DISABLE_TOOLS: "",
MISE_DISABLE_BACKENDS: "",
GIT_TERMINAL_PROMPT: "0",
BASH_ENV: …,
```

- `/var/lib/t3flare/mise` is on the Container's own disk, outside `/workspace`, so the file never syncs, and a new
  Container starts without it (a Container's disk does not outlive it).
- With no owner text nothing is written there, and mise resolves exactly as today (`m0-layering.json`).
- The image needs no change: its build installs the base file's tools into the system directory as before, and the
  base `mise.lock` sits beside the base file.

### 3. Laying it down at each Container start

- **What a start uses.** `#launch()` already records each fresh start's settings (`ContainerLaunch`). It gains
  `globalMiseConfig`, the start's text. A running Container keeps its launch, so a change never reaches it; the next
  start takes the new text. An agent's edit of the laid-down file lasts until its Container stops.
- **The script** (`globalMiseScript(text)` in `@t3flare/sandbox-image/globalMise`, no Node imports, so the agents
  Worker can import it), run on the Container through the platform's exec (as the leak scan runs), under
  `COMMAND_ENV`:
  1. If this Container's disk already has the lay-down's answer (`/var/lib/t3flare/mise/answer.json`), print it and
     stop: the script runs again harmlessly after a Workspace DO restart or a reconnect.
  2. Write the text (base64 in the script; 16 KiB fits an argument) to a staging file beside the global path.
  3. `cd / && timeout 600 mise install` with the staging file as the global config: the base's tools are already
     installed; the owner's are installed now. Output to `/var/lib/t3flare/mise/install.log`.
  4. If `git --version` and `gh --version` run under it, move it to the global path; else delete it (D1).
  5. Write and print the answer: `{ laid, install (exit code), ms, bytes }`.
- **Before the first command.** A Workspace DO helper (`GlobalMise`, `apps/agents/src/workspace/globalMise.ts`)
  runs the script once per Container start, single-flight, and every path to the Container waits for it:
  - computer's commands (the Durable agent's `bash` and file tools, the Workspace DO's git and checkpoints): the
    Container backend (`ContainerOnlyBackend`) awaits it after `connect` and before handing computer the connection,
    so it runs once the Container is up and before computer sends any command;
  - t3's Terminals and the agent's Terminals: in their `beforeSpawn`;
  - CLI agents' processes: in their `beforeStart`.
  
  With no owner text it runs nothing, so a start without a Global mise config costs what it costs today. A script that
  fails (the Container stopped under it) is logged and does not hold the command back; the next call runs it again.
- **What is reported:** a `global-mise` log line per start (Workspace, revision, laid, install exit, ms, bytes; never
  the text), the answer in `containerState()` (`globalMise`), and mise's output in `install.log` on the Container's
  disk, which an agent can read. Nothing on the panel (D3).

### 4. Install: no cache

As the ticket holds: every start installs the owner's tools again, and `MISE_DATA_DIR` stays mise's default on the
Container's disk (never under the synced `/workspace/.t3flare/`). The follow-up for an install cache
(`directorySnapshots` in the start options, unresearched) is drafted in the report for the orchestrator to file: this
run reads Linear only.

### 5. Docs

- **ADR-0032 refinement**, a §8: the setting, the layering (system < global < project), the lay-down at each start
  and its git/gh check, the variables (and that they beat every file), no install cache. No new ADR: without the cache
  there is no new trade-off.
- **`GLOSSARY.md`:** **Global mise config**, worded as on SPI-1001: "The owner's mise configuration that every
  Container's commands get, under a repository's own." _Avoid_: Toolchains (cloudpid's word), global tools.
- **No `upstream-fragility.md` entry:** nothing here leans on t3code internals. The mise behaviour it leans on (the
  variable names, the layering, the token order) is checked by the M0 test, which stays in `test:docker`, so the
  nightly job re-checks it when the image's mise moves. After Build it imports the real `COMMAND_ENV` and
  `globalMiseScript` instead of its own copies.

## Tests (seams)

| Seam | What it catches | What it misses |
| -- | -- | -- |
| `packages/harness-registry/src/environment.test.ts`: the `globalMiseConfig` entry through `applyEnvironmentChange` / `resolveEnvironment` | 16 KiB of UTF-8 accepted, one byte more refused (a multi-byte character counts by bytes), NUL refused, default `""`, a stored value that no longer fits reads as `""`, the revision moves only when the text does | the panel's rendering |
| `apps/environment/test/environmentSettings.test.ts`: the panel's API | a save stores, bumps and audits the setting as `{ bytes, sha256 }`; a refused one stores nothing and answers the whole reason | what a Container does with it |
| `apps/agents/test/globalMise.test.ts`: `GlobalMise` with a fake exec | one run per start with concurrent callers, none without text, the launch's text (not a newer one), a failed run logged and retried, a new start runs again | the real script |
| `apps/agents/test/containerLaunch.test.ts` | the launch carries the start's text; a running Container keeps it | |
| `apps/sandbox-image` script, through the M0 docker test | the lay-down, the git/gh check, idempotence, the variables, on the image's mise | the platform's exec |

The stage covers what no unit test can: the platform's exec, the three command paths, and the cost.

## Stage `pmise` (added to `STAGES`)

`apps/environment/scripts/pmise.ts`, modelled on `penv.ts`, through `node scripts/stage.ts run pmise pmise <case>`.
Each file carries the deployed commit (from `/_t3flare/health`). Evidence in `docs/steps/global-mise/`:

- `install.json`: a global `node` pin the image lacks; `node --version` in a new Container from a Durable agent's
  `bash`, a CLI agent's command, and a t3 Terminal.
- `override.json`: a repo's `mise.toml` naming `node` wins; the other global tools stay.
- `git-gh.json`: t3's git status and a commit, and `gh --version`, under the pin.
- `restart.json`: a change while a Container runs leaves it alone, and the next start has it; an agent's edit of the
  laid-down file is gone at the next start.
- `cost.json`: seconds from start to first command, with and without the pin, two starts in a row each.
- `empty.json`: with no global config, start time as today (and no lay-down exec).
- Also checked there: the variables reach a command whole (the empty ones included: `mise settings get` and
  `mise token github` in the Container), and an invalid owner file is not laid down while git still works.

Then the stage is destroyed.

## Decisions for review (provisional; each passes the escalation tests only if the reviewer disagrees)

- **D1. A file under which git or gh fails is not laid down,** and the start goes on as with none (logged, and in
  `containerState`). The alternative, laying it down anyway, breaks t3's git status and commit for every Workspace on
  a typo (invalid TOML fails every shim). The owner may still pin git or gh to a version that installs.
- **D2. The audit records the text's size and SHA-256, not the text** (the log's 2 MB value limit). The alternative
  is a separate audit store for large values.
- **D3. A file not laid down, or a failed install, is not shown on the panel** in this cut: logs, `containerState`
  and the Container's `install.log`. Showing the last start's answer under the setting would need the Workspace DO
  to report back to the Environment DO; proposed as part of the follow-up.
- **D4. `MISE_DISABLE_TOOLS` and `MISE_DISABLE_BACKENDS` are held empty,** so neither the owner's file nor a repo's
  can disable a tool or backend. Disabling is not needed to add tools, and both settings could remove git or gh.
- **D5. A new `file` field type** rather than widening `text` (whose limit is in characters and which allows NUL), so
  the Harness settings' fields keep their rules.
- **D6. `mise install` runs from `/`,** so it installs the base and global tools only. A repo's own tools install as
  today (mise installs a missing version on first use, `MISE_YES=1`). An install that exits non-zero for another tool
  still lays the file down when git and gh run: the failed tool fails where it is used, as it would on a laptop.
