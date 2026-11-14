# Plan: SPI-1148, Environment skills: install from GitHub on the Harness panel

Branch `spi-1148-environment-skills`, from `main` at 660f922 (SPI-1147 and SPI-1149 merged). Stage `penvsk` (the
ticket names `p1001e`; the landing run names `penvsk`). Parent SPI-1001; its shared decisions are settled and not
reopened here. Report: `docs/steps/spi-1001-env.md`. Evidence: `docs/steps/spi-1001/env-*.json`. Decision record:
ADR-0033 (new).

Revision 2, after the plan review of 1fdd389 (approved with changes). The changes are marked **(r2)**. The review's
escalation decisions are recorded in §10.

Revision 3, folded in during the build after the re-review of d939265 (approved with changes, no further plan review).
The changes are marked **(r3)**, with the review's item (C1 to C3, A1 to A9).

## 0. Goal

The owner installs Skills from GitHub on the Harness panel. Each is pinned to a commit, kept whole in the Environment DO,
offered to Durable agents in every Project, and served read-only in every Workspace at `/workspace/.agents/skills/<name>`
without a Container. An Environment skill beats a Repo skill of the same name. Only the owner changes them, by a click.

## 1. M0: what the probes answered

Two evidence files, both from stage `penvsk`:

- [`spi-1001/env-probe.json`](spi-1001/env-probe.json), deployed commit `f64889a`. This is the probe commit on this
  branch: the computer patch below, the Workspace's mount, and a temporary admin route `POST /_t3flare/probe/env-skills`.
- **(r2)** [`spi-1001/env-sync.json`](spi-1001/env-sync.json), deployed commit `1fdd389`. Its Worker code is the same
  as `f64889a`'s; only docs and the stage script changed between them.

### R1: GitHub from the stage Worker (`env-probe.json`)

| Read | Answer |
| -- | -- |
| Unauthenticated `GET /rate_limit` | `x-ratelimit-limit: 60`, with `used: 13` at the probe's first read. An earlier run of the probe had spent 2, and that run's first read already showed `used: 5`. The egress IP's bucket is shared with other tenants. |
| Unauthenticated `mattpocock/skills` commit | 200 |
| A token minted for `ian-pascoe/t3flare-fixture` only (`contents: read`, `metadata: read`): `GET /rate_limit` | `x-ratelimit-limit: 5300`, the installation's bucket. |
| The same token: `mattpocock/skills` (public, outside the installation): commit, recursive tree, blob | **200, 200, 200**. `x-accepted-github-permissions: contents=read`. The tree is not truncated (282 entries, 39 `SKILL.md`). Each call takes 1 from the installation's 5,300/h. |
| The same token: the fixture repo (in scope) | 200 |
| The same token: `ian-pascoe/cloudpid-scratch` (private, in the installation, outside the token's scope) | 404 |
| A mint for an owner without the App (`octocat`) | refused: "The GitHub App is not installed on octocat: install it there, on all repositories" |
| Unauthenticated: the private fixture repo | 404 |

**Decision (the ticket's rule):** the 200s settle it. A public repo outside the installation is read with a token scoped
to one installed repo. Unauthenticated reads are kept only for an Environment with no installed repo at all (§3.2).

### The read-only mount

**The Workspace DO** (`env-probe.json`):

- computer's read-only mount refuses every change at or above the mount: a write, a new skill folder, `remove`,
  `remove` of `/workspace/.agents`, `rename` and `mkdir`.
- Each refusal reads "read-only mount at /workspace/.agents/skills: cannot modify: …". The fs RPC codes it `EIO`.
- Reads answer the set's bytes, with UTF-8 intact.
- The mount's directory exists, empty, before any set is taken.

**The Container, as computerd serves it** (`env-probe.json`):

- The files arrive in the Container, but the Container's FUSE view is **writable**.
- A write, a new folder and an `rm -rf` all succeed there. The Workspace skips each one when it pulls (computer's
  `skipped: read-only`), so the Container differs from the Workspace until it restarts.

**The Container with a read-only bind mount** (cloudpid's bootstrap step 0, `mount --bind D D && mount -o
remount,bind,ro D`; `env-probe.json` and `env-sync.json`):

- The command runs as root and succeeds. A write then fails with `Read-only file system`.
- The bind lasts for every later command of that Container.
- Files planted before the bind stay until the Container restarts, so the bind must go in before the launch's first
  command.
- **(r2)** A `flock` around the attempt makes it shared. `/usr/bin/flock` is in the image. Two first commands sent at
  once to a fresh Container both answered 0 and left exactly one bind (`env-sync.json` `concurrentFirstCommands`).

### (r2) Does a running Container's copy follow the set? (`env-sync.json`)

**Correction.** Revision 1 said the Container held all 8 MiB after its next sync. `env-probe.json` shows 6,840,835
bytes, not 8,388,700. The gap is exactly `probe-0/data.txt`, the one path in both sets, which still held the previous
set's bytes when the command ran, under a second after the set was taken. The re-probe measured this directly.

**Method.**

- Each step takes a set while the Container runs. Every file is read in the Container first, so any cache is warm.
- Then, every 2 s, the probe computes the sha256 of every file under the mount in the Container. It compares each against
  the set's own file hashes and lists stale, missing and extra paths.
- The step sequence: in-place change (0.02 → 0.03 MiB), growth to 8 MiB (new files, one changed path), shrinking to
  0.01 MiB (removals), and the empty set. Then a fresh Container. It was run once without the bind and once with it.

| Step | Without the bind | With the bind |
| -- | -- | -- |
| Fresh Container, first look | matches (276 ms) | matches (245 ms) |
| In place (0.02 → 0.03 MiB) | **stale** `probe-0/data.txt` at 276 ms; matches at 2,457 ms | **stale** at 316 ms; matches at 2,530 ms |
| Grown to 8 MiB | matches at the first look (746 ms) | matches (786 ms) |
| Shrunk: files removed | matches (325 ms): the removed files are gone | matches (388 ms) |
| Emptied | matches (235 ms) | matches (215 ms) |
| A fresh Container after the changes | matches (245 ms) | matches (200 ms) |

**Reading.**

- A running Container's copy does follow the set: removals, additions and in-place changes, with or without the bind.
- A file changed in place can read stale for a short while, up to about 2.5 s in these runs, and the same with or
  without the bind. That is the window `env-probe.json` fell into.
- So the bind is not the cause. The cause is the Container's view of a file it had read just before.

**Design change:** taking a set waits for a running Container (§4.2). Each changed path must read its new sha256 there
before the take returns, bounded at 5 s, before the turn goes on. Skills' scripts, and SPI-1153's CLI agents, read only
the Container's copy, so this is the copy that must be current.

### One DO call for a set (`env-probe.json`)

The Workspace DO takes the set from the Environment DO with one RPC (`environmentSkillSet()`), then stores and remounts
it. Date.now() does not move during the synchronous remount in a DO, so `mountMs` reads 0.

| Set | Files | Call (admin route → Workspace → Environment → mount) | The read alone |
| -- | -- | -- | -- |
| 8 MiB | 13 | 430 to 620 ms | 131 to 136 ms |
| 16 MiB | 23 | 800 to 1,079 ms | 283 to 285 ms |
| 24 MiB | 35 | 1,263 to 1,297 ms | 522 to 623 ms |

The 8 MiB limit has three times the headroom it needs.

### What M0 changed for the plan

- **computer 0.11.2 has no `remount()`.** A mount is indexed once per object instance, so a new set needs computer to
  check the version again. cloudpid patches computer 0.11.1 for this.
  - M0 ports that patch to 0.11.2 (`patches/deps/@cloudflare__computer@0.11.2.patch`: `MountIndex.reindex()` and
    `Workspace.remount()`, about 20 added lines), added through `pnpm run relock`.
  - A computer bump re-cuts it (U20).
  - Accepted (§10, E1).
- **The Container needs t3flare's own lock (§4.3).** Neither computer nor computerd makes the Container's copy
  read-only.
- **(r2) A running Container's copy needs waiting for (§4.2)**, about 2.5 s for a changed file.

## 2. Model and storage (M2)

**Environment skills belong to the Environment settings entity (ADR-0032)**, as the glossary already says. They are a
collection, not a schema field, so they are not an entry in `ENVIRONMENT_SETTINGS`.

**Tables.** They live in the Environment DO's SQLite, owned by a new module, `apps/environment/src/skills/store.ts`:

- `t3flare_env_skills`: `name` (PK), `description`, `repo` (`owner/name`), `path` (the folder in the repo, `""` at the
  root), `ref` (as named, or null for the default branch), `commit` (40 hex), `digest`, `enabled`, `saved_at`, `bytes`
  and `files`.
- `t3flare_env_skill_files`: `name`, `path` (in the folder), `blob` (GitHub's blob SHA), `size`, `content` (TEXT), with
  PK `(name, path)`. A row is at most 1,536 KiB, under the 2 MB a row may hold.
- `t3flare_env_skill_meta`: the set's hash, `skillSetHash` over every enabled skill's files keyed `<name>/<path>`.

**The entity.** Every change bumps the Environment revision (ADR-0032 §1), shows on Status, and is audited with
`entity: "environment"`.

**(r2) The hash.** `ResolvedEnvironment` gains no field. The reader that needs the set's hash is the Pi Durable
adapter, which runs in the same DO. It reads `t3flare_env_skill_meta` through the store at each turn (§4.2). No reader
of `resolveEnvironment` learns of skills, and a Container start does not take the set.

**(r2) One synchronous commit.**

- The fetch and the hashing (`crypto.subtle`, which is async) happen first, against the revision read at the start.
- The commit is one synchronous block in `transactionSync`. It runs these steps in order:
  1. it checks that the revision has not moved;
  2. it re-checks the limits against the rows as they are now;
  3. it writes the rows;
  4. it writes the set's hash;
  5. it bumps the revision;
  6. it writes the audit entry.
- A moved revision recomputes the hash once and commits again, so two installs cannot interleave.
- The set's hash is computed from per-file SHA-256s kept on the rows (computed at fetch), so the recompute reads no
  content.

**The digest** is cloudpid's folder hash (`folderHashOf`): SHA-256 over the kept files' paths and blob SHAs, from the
same Trees answer. "Unchanged" and update checks compare digests, never content.

**Limits** (`apps/environment/src/skills/limits.ts`, unit-tested). They count every kept skill, enabled or not, so
enabling one never fails (E3).

| Limit | Value |
| -- | -- |
| A file | 1,536 KiB |
| A skill | 500 files and 4 MiB |
| The set | 8 MiB and 100 Environment skills |
| A description | 1,024 characters |
| A name | 64 characters |
| **(r2)** A file's path under the mount (`<name>/<path>`) | 512 UTF-8 bytes, each segment at most 255 **(r3, A6)**, and §3.1's path rule |
| `SKILL.md` candidates in one listing | 200 |

## 3. Fetch (M1)

### 3.1 The port

Ported from cloudpid@47941c7c with its mocked-GitHub tests (`skill-fetch.test.ts`, `skill-paths.test.ts`,
`skill-source.test.ts` and the fixture repo), adapted to plain Promises. The code lives in `apps/environment/src/skills/`,
which only the Environment Worker loads.

| t3flare | cloudpid | What it does |
| -- | -- | -- |
| `source.ts` | `github/skill-source.ts` | The three forms (`owner/repo`, `owner/repo@skill`, `https://github.com/owner/repo/tree/<ref>/<path>`); the ref is optional |
| `paths.ts` | `github/skill-paths.ts` | The `skills` CLI's `SKILL.md` path rules (MIT, credited), a skill's folder, installable paths, the folder hash |
| `fetch.ts` | `github/skill-fetch.ts` | `RepoReader`; the listing (at most 200 candidates; a truncated tree is refused); `fetchSkills` at a commit; `viewSkill`; `readSkillMd`; `metadata.internal` left out unless named |
| `contents.ts` | `github/contents.ts`, `request.ts` | A `RepoReader` over GitHub's REST API through §3.2's token; a 401 mints again once; a rate limit, a 404 and a refusal each told plainly |
| `checks.ts` | `extensions/skill-checks.ts` | `problemsIn` (UTF-8, no NUL, size, `CREDENTIAL_PATTERNS`), `skillNameProblem`, the limits |

**Rules added beyond cloudpid's.** Each is a test:

- A name needs at least one letter.
- A symlink (tree mode `120000`) or a submodule (type `commit`) in a skill's folder rejects that skill. The message
  names the path.
- **(r2) Paths.** Every kept file's path under the mount passes the same rule the Workspace applies
  (`skillSetProblem`'s): no backslash, NUL, empty, `.` or `..` segment, and no path that is both a file and a directory.
  The path is also at most 512 UTF-8 bytes, which keeps the Workspace's KV key, `t3flare:skills:file:` + path, far
  under its limit. A failing file rejects its skill and names the path.
  - The rule moves to one exported function in `@t3flare/skills` that both sides call.
  - A property test: every set the store can emit passes `skillSetProblem`.
- **(r2) `name`.** An Environment skill's `SKILL.md` must have a `name` in its frontmatter (cloudpid's rule, and the
  Agent Skills format's). A missing one rejects the skill with a message. Repo skills keep SPI-1147's folder-name
  fallback (settled there). Both behaviours are tested.

### 3.2 The credential: the Environment DO's alone

- **Who fetches.** The fetch runs in the Environment DO, which mints through the existing `GitHubTokens`
  (`apps/environment/src/agents/github.ts`). The token is used for the fetch's own requests and then dropped. It reaches
  no Session, Container, page or log.
- **The permissions.** A new set, `SKILL_FETCH_GITHUB_PERMISSIONS = { contents: "read", metadata: "read" }`, goes
  beside the three lists in `@t3flare/github-app/permissions`, added on purpose as that module requires. M5 also probes
  `metadata: read` alone against outside repos; the build keeps the narrower set if it reads them (advisory). *(Build: not probed; the token keeps `contents: read`, which R1 showed reading them.)*
- **Which token for `owner/repo`:**
  1. The App is installed on `owner` and covers the repo: a token for that one repo. This is the only path for private
     repos.
  2. Otherwise, for a public repo outside the installation: a token for one installed repo, the first repo of the
     Workspace registry (`t3flare_workspaces.owner/name`) the App mints for. R1 showed it reads public repos and spends
     the installation's bucket.
  3. **(r2)** With no installed repo at all: unauthenticated, from the shared 60/h bucket (E4).
     - It reads `GET /rate_limit` first (free) and refuses early when `remaining` cannot cover the request's reads.
     - The refusal names the reset time and the way out: "install the GitHub App on a repository, and add it as a
       Project, to read with its own limit".
     - The preview, the update check and the section say when this path is in use.
- **Refusals.** cloudpid's wording, in both variants:
  - "GitHub has no repo owner/name, or it is private and the GitHub App is not installed on owner (install it there, on
    all repositories)."
  - **(r2)** "GitHub has no repo owner/name, or the GitHub App's installation on owner does not include it (install it
    on all repositories)."
  - Either variant adds "Or it has no ref "<ref>" (a branch, a tag or a commit)." when a ref was named.

### 3.3 (r2) Each request is bounded

The Environment DO also runs t3, and a restart there ends running turns (ADR-0004). So every fetch is bounded per
request:

- **Preview** reads one commit, one recursive tree, and the candidates' `SKILL.md` blobs (at most 200). It reads no
  other file. A candidate's file count and bytes come from the tree's sizes.
- **Install and update** check each chosen skill's file count, its bytes, the paths and the set's limits from the tree's
  entries **before reading any blob**. Then they read the blobs. *(Build: each folder's `SKILL.md` is read first, for the name the path rule prefixes; the 500-blob cap is checked before any read, and the other files only after the tree's checks pass.)*
- **(r3, C3) The blob cap.** At most 500 blob reads per request, the largest single skill. GitHub's secondary limit is
  900 points a minute per REST endpoint (a GET is 1 point), so 500 reads plus the commit and the tree stay under it in
  any minute; 1,000 would not. The 10,000 subrequests a paid Worker invocation may make are far above either. A
  selection that needs more is refused before any read: "These skills hold N files; install at most 500 files at a
  time."
- **(r3, C3) Secondary limits.** A 403 or 429 from GitHub with `retry-after` (or a secondary-limit message) is a plain
  refusal that names the wait ("GitHub asked t3flare to slow down: try again in N seconds") and stores nothing.
- **Check for updates** groups the kept skills by `(repo, ref)`: one commit and one tree per group, and no blobs. At most
  40 groups per request; past that, it checks the first 40 and says so.
- **Bounds.** Six blob reads at a time. Each GitHub request is bounded at 15 s and the whole request at 60 s. A request
  that runs out answers what it finished and stores nothing.
- **CPU and memory.** Hashing and checking 8 MiB is the most one request does. Content is held only until the commit.

**(r3, A9) The unauthenticated pre-check** reads `/rate_limit` before the commit, and again after the tree is read,
before the blobs. The panel's note that reads are unauthenticated comes from the Workspace registry (no installed
repo), never from minting a token at render.

**(r3, A8) Preview** runs the content checks (UTF-8, credential patterns) only on `SKILL.md`. It says so: "Other files are
checked when the skill is installed."

### 3.4 Updates (r2)

| Case | Outcome |
| -- | -- |
| The folder is gone at the ref's latest commit | "No longer in owner/repo at <ref>"; no update is offered; the skill is kept |
| The frontmatter `name` changed | "Now named <new>"; no update is offered. Install it under the new name; removing the old one is the owner's choice. *(Build: the check reads no file, so this is told at Update, which refuses it and keeps the Skill.)* |
| A changed file breaks a check | The update is refused with that check's message; the skill is kept |

## 4. Delivery (M3)

### 4.1 The Workspace's copy

- **The mount.** `WorkspaceDO` mounts `skillSetMount` (`apps/agents/src/workspace/skillSet.ts`) at `SKILLS_MOUNT`
  (`@t3flare/skills`). It is computer's read-only `WorkerBundle` of the held set, versioned by the set's hash.
- **Storage.** The set is kept in the DO's KV, one value per file, and replaced whole in one transaction.
- **(r2) Memory.** The instance keeps only the set's hash and its parsed listing. `materialize` reads the files from KV
  when computer copies them, so the whole set is never held for the instance's life.
- **`takeEnvironmentSkills(hash)`.** It does nothing when `hash` is the held one. Otherwise:
  1. it takes `environmentSkillSet()` from the Environment DO;
  2. it checks the set's shape and paths (`skillSetProblem`);
  3. it stores the set and `remount()`s inside `blockConcurrencyWhile`.

  Every call sees the whole old set or the whole new one.
- **(r2, E1) When the mount fails.** computer's index sets the mount read-write while it materializes, and leaves it
  that way on failure. So `remount()` runs only inside `blockConcurrencyWhile`:
  - A failure restores the set held before and remounts it.
  - If that fails too, the Workspace stores the empty set and remounts, so the mount is read-only again with nothing in
    it.
  - Each failure is logged and reported (§4.5).
- **What a Workspace had at the mount before.** That is possible only on a Workspace made before this change. Before the
  first index, those files are moved to `/workspace/.agents/skills.pre-mount`, with a warning (cloudpid's
  `keepPriorSkills`). Without this, the first index would clear them.
- **Cleanup.** The M0 timing fields (`readMs`, `mountMs`, `bytes`), the probe route and `probeSkillSet` are removed in
  M2. `environmentSkillSet()` then answers the store's enabled rows.

### 4.2 Timing: the turn carries the hash

- **The input.** The Pi Durable adapter reads the set's hash from the store (§2) and passes it as
  `environmentSkillsHash?: string` (renamed in review round 1) on `submitTurn`'s input (`SubmitTurnInput` in `@t3flare/session-protocol`).
- **The take.** `SessionDO.submitTurn` calls the Workspace's `takeEnvironmentSkills(hash)` after `#takeHarness()`.
  - It is bounded at 10 s, which covers §4.1 plus the Container wait below; an 8 MiB set took 0.6 s.
  - It never fails the turn. A timeout or failure is logged, and the turn runs with the set the Workspace holds.
- **(r2) A running Container.** When the Container is running as the set changes, `takeEnvironmentSkills` waits for
  the Container's copy before it returns:
  - **(r3, C2)** It checks every path the new set adds or changes (by sha256) and every path it removes (absent). The
    list goes to `sha256sum -c` on the command's **stdin** (`ExecInput.stdin`), never in the script text, since Linux
    caps one argv string at 128 KiB. Removed paths go on stdin too.
  - **(r3, C1)** The command shape is probed on the stage before it is built on: one passive command that loops every
    200 ms for up to 5 s, for a size-changing edit and a same-size edit. If one command does not converge (its own
    reads keeping the stale view), the wait is instead up to N separate passive commands, 500 ms apart, within the same
    5 s. The build uses whichever the probe shows converging (`env-update.json` records it). *(Build: one command; on the stage it answered caught-up at its first look for both edits, so its later looks were not exercised there; they are unit-tested against a directory changed part-way.)*
  - It answers whether the Container caught up. A copy still stale at 5 s is logged with its paths.
  - **(r3, C2)** The wait runs **after** `blockConcurrencyWhile` returns: inside it, the exec's own RPCs to this object
    would wait for it, and hang.
  - **(r3, C2)** A stopped Container is not started. `containerRunning()` is checked and the exec is called in the same
    tick, with nothing awaited between them: computer's connect goes through `#budgeted.start`, which starts a stopped
    Container, and after an eviction of this object it renews the lease and resets the idle clock. The next start gets
    the Workspace's files (`env-sync.json`, the fresh rows).
- **(r3, A2) A refused set is not retried every turn.** The Workspace remembers the last hash it refused and answers that
  refusal again, without reading the set, until the Environment's hash differs.
- **(r3, A1) For SPI-1153.** Only the Pi Durable adapter carries the hash. A CLI agent's thread takes no set at its
  turn: SPI-1153's CLI adapter must carry the hash too, or the Container start must take the set.
- **Steers.** A steer carries no hash. It joins a running turn, and the set changes only at a turn's start. **(r3, A4)**
  That is any thread's turn start in that Workspace: threads share a Workspace, so one thread's turn can change the set
  under another's running turn.

### 4.3 The Container's copy: read-only from the first command (r2)

**The snippet.** It is idempotent and shared:

```sh
D=/workspace/.agents/skills
if ! grep -qs " $D " /proc/self/mountinfo; then
  exec 9>/tmp/t3flare-skills.lock; flock 9
  grep -qs " $D " /proc/self/mountinfo || { mkdir -p "$D" && mount --bind "$D" "$D" && mount -o remount,bind,ro "$D"; }
  exec 9>&-
fi
```

It is the probed script, and costs one `grep` once it is in place.

**Where it runs.** It is prefixed to **both** command wrappers that reach the Container:

- `WorkspaceDO.exec()`, beside `submoduleDirsScript`. This covers git and actions, `#startContainerFor`, and the
  terminals' `startContainer`.
- `@t3flare/computer-env`'s `BACKENDS.container.script` (`env.ts`). This covers the Durable agent's `bash`, which runs
  through computer's stub (`exec.ts` via `__getWorkspaceStub()`), not `WorkspaceDO.exec()`.

Terminal and CLI spawns call `container.exec` directly. They run only after one of these has started the Container.
A hook after `api.start` in the lease wrapper does not work: computerd's FUSE mount is not up when `start` returns.

**Failure.** It is best effort, as in cloudpid. A failure (no `mount` permission, as under a local `alchemy dev`)
leaves the command running. The Workspace's own copy stays authoritative either way.

**(r3, A5) Logging a failure once per launch.** The snippet prints nothing. On failure it writes the reason to a marker
file in the Container, `/tmp/t3flare-skills-lock.failed`. The take's passive command (§4.2) reads the marker when it is
there, and the Workspace logs it once per launch (`{"t3flare":"skills-lock-failed"}`, keyed by the launch's start
time). A command's own output and exit status are untouched.

**What the bind is.** It guards against accident; it is **not a security boundary**. The agent runs as root in the
Container and could remount the directory read-write. Even then, its writes never reach the Workspace (computer skips
them), and they vanish at the next Container start. §6 and ADR-0033 say so.

**Tests and evidence.**

- Unit tests cover the snippet's text in both wrappers, and that a command's own output and exit status are unchanged.
- `env-readonly.json` shows the agent's `bash` write refused when it is a **fresh Container's first command**.

### 4.4 Discovery, listing, snapshot and expansion

**The model's listing.**

- `WorkspaceDO.#environmentSkills()`, the slot SPI-1147 left, parses the held set with `@t3flare/skills`' frontmatter
  reader. It parses once per hash and keeps the result in memory. Paths are under `SKILLS_MOUNT`.
- `discoverSkills` puts the Environment skills first and lets them win. A shadowed Repo skill goes to `skipped`.
- The 100 cap counts Repo skills only, so every enabled Environment skill is listed.
- The listing stays frozen per context window.

**(r2) The composer and mentions** come from the Environment DO's rows, so they are current at once:

- `WorkspaceRpc.skills(cwd, { repoOnly: true })` answers Repo-only discovery: no Environment skills, and nothing
  shadowed by one.
  - An older Workspace that ignores the option still answers. The Environment drops anything under `SKILLS_MOUNT` from
    its answer.
- The Environment does the whole merge: a pure `withEnvironmentSkills(rows, repoDiscovery)` in `@t3flare/skills`.
  - It puts the enabled rows first.
  - It moves same-named Repo skills to `skipped` ("is shadowed by the Environment skill <name>").
  - Once an Environment skill is removed or disabled, the Repo skill of that name is back at once.
  - Tests: shadow, un-shadow on remove, un-shadow on disable, the cap untouched.
- The snapshot (`provider/skills.ts`) and expansion (`messageSkillsFor`) both apply it:
  - In the snapshot, an Environment skill has scope `user`, path `/workspace/.agents/skills/<name>/SKILL.md`, and
    `userInvocationOnly` from `disable-model-invocation`.
  - In expansion, `$name` and `/skill:name` embed the row's `SKILL.md` body, with `location` under the mount. The turn
    that carries the expansion also carries the hash, so the referenced files are in the Workspace, and in a running
    Container (§4.2), before the agent reads them.

**(r2) The chip's "View instructions".**

- t3 opens `skill.path` in the right panel (`SkillInlineText.tsx:117`, `rightPanelStore.openFile`). It treats the path
  as a project file, and its read reaches only `/w/<id>/…`.
- For an Environment skill's `/workspace/…` path, the panel shows t3's own read error. The chip and its popover (name,
  description) work.
- No Shadow is planned. The evidence records what the click shows (`env-install-public.json`).
- t3's contract requires a non-empty path, so the link cannot be hidden without changing t3.

**The Harness `skills` switch** governs Environment skills as it does Repo skills. Off means no listing, an empty
snapshot and no expansion. The mount is still delivered as inert files.

### 4.5 (r2) Refusals are visible

- A Workspace that refuses or cannot mount a set reports it to the Environment DO: a new RPC,
  `skillSetRefused({ workspace, hash, message })`, best effort.
- The Environment keeps the last one per Workspace (at most 50) and drops it when that Workspace takes a set.
- **(r3, A3)** The Environment learns of a take from `environmentSkillSet({ workspace })`: the Workspace names itself when
  it asks. A refusal reported after that read replaces it; a read with no later refusal is the take, and the refusal is
  dropped then.
- Status shows the latest refusal and its Workspace.
- **Version skew is tested both ways:**
  - an Environment without `skillSetRefused` or `environmentSkillSet` gives a logged failure, never a failed turn;
  - a Workspace without `takeEnvironmentSkills` gives a logged failure, and the turn runs;
  - a Workspace that ignores `repoOnly` is handled by §4.4's drop.

## 5. API and the panel's Skills section (M2, M4)

### Routes

All are under `/_t3flare/harness/api/skills`, behind the existing guards. Writes go through `unsafeWrite` (JSON
Content-Type, Origin, `Sec-Fetch-Site`) and CSRF, and are added to the panel's write-route list.

| Route | Does |
| -- | -- |
| `GET …/skills` | The list: name, description, source (repo, path, ref), short commit, saved at, enabled, files and bytes. **(r2)** The totals against 8 MiB and 100, with the disabled skills' share shown apart (E3). |
| `GET …/skills/view?name=` | `SKILL.md` as text; other files as path and size, each with its GitHub URL at the commit. |
| `POST …/skills/preview` `{source}` | The candidates at the resolved commit, with checks run from the tree and `SKILL.md` (§3.3). A same-named skill shows "replaces X from Y"; identical files and source show "unchanged". What was left out (`metadata.internal`, over the cap) is listed. **(r2)** It says when reads are unauthenticated. Nothing is stored. |
| `POST …/skills/install` `{source, commit, names}` | Fetches again at the previewed commit (§3.3), checks, then commits (§2). Answers per name. |
| `POST …/skills/check` `{names?}` | Grouped by `(repo, ref)` (§3.3): up to date, or an update with the old and new commit and the changed files. §3.4's cases are answered too. Nothing is stored. |
| `POST …/skills/update` `{name, commit}` | Fetches at that commit, checks, commits. |
| `POST …/skills/remove` `{name}` | Removes the skill; the page asks `confirm()` first, as MCP server removal does. |
| `POST …/skills/enable` `{name, enabled}` | The skill's switch. |

### The section

The section replaces the placeholder. It has:

- an install form: source, then Preview;
- the preview as the confirmation: a checkbox per installable skill, with its notes, then Install;
- the list, with source, ref, short commit, saved time and a switch per skill, and View, Check for updates and Remove;
- **(r2)** the totals, with disabled skills shown apart, and a note when no installed repo exists (unauthenticated
  reads).

View shows `SKILL.md` as text in a `<pre>`; the script never writes it as HTML.

**(r2) Escaping.** Each owner-visible or GitHub-supplied string is tested with HTML in it, in both the server render and
the page script: the description, the file paths, the ref, the echoed source, and refusal text.

Status shows the count, the enabled count, the set's short hash and the latest Workspace refusal (§4.5), in place of
"Environment skills deferred". **(r3, A7)** The Environment section's revision line, which says the Environment revision
is applied at each Container's next start, says too that Environment skills apply at a thread's next turn. The CSP stays hash-only.

### Audit

Each entry has:

- `entity: "environment"`;
- `action`: `skill-install`, `skill-update`, `skill-remove`, `skill-enable` or `skill-disable`;
- `target`: the name;
- `before` and `after`: `{ repo, path, ref, commit, digest, enabled }`.

It never holds file content.

## 6. What does not ship

As the ticket lists:

- skills.sh search or a directory;
- a scheduled update check;
- per-Project scope;
- agent changes: no agent tool installs, updates or removes.

The mount refuses the agent's writes on both sides. **(r2)** In the Container this guards against accident, not against
an agent set on it: as root it could remount, and its writes would still never reach the Workspace and would vanish at
the next start (§4.3).

CLI agents are SPI-1153's, built on `/workspace/.agents/skills`.

## 7. Milestones and tests

| M | Builds | Unit tests (each file run alone as it lands) |
| -- | -- | -- |
| M1 | §3 | cloudpid's ported tests; each check row and limit; the added rules (letter, symlink, submodule, path rule and length, `name` required); token choice 1/2/3 with a mocked minter; the early rate-limit refusal; both refusal variants, whole; §3.3's bounds (no blob read before the size checks, the 500 cap, a secondary-limit refusal, the update check's grouping) |
| M2 | §2, §5's API, the probe code removed | store: rows, hash, revision, audit without content, limits after a change, unchanged, one synchronous commit with an interleaved install; every set the store emits passes `skillSetProblem`; API guards (CSRF, Origin, form body); preview, install, check, update, remove and enable; §3.4's cases |
| M3 | §4 | `skillSetProblem`; the store's replace; the memory rule; the mount-failure fallback to the empty set; `withEnvironmentSkills` (shadow, un-shadow on remove and on disable); `repoOnly`; the slot's parse; `SessionDO` taking the set on a hash change only, bounded; the Container wait; the snippet in both wrappers; §4.5 and version skew; snapshot scope `user` and paths; expansion from rows |
| M4 | §5's section | the render; escaping in both places; the switch; confirm on remove; totals with disabled skills; the placeholder gone |
| M5 | stage `penvsk` | the evidence below, plus `metadata: read` alone (§3.2); destroyed after |
| M6 | docs | ADR-0033, glossary, parity G10, U64 and U20, the report |

- **The agents Worker stays free of t3.** `@t3flare/skills` and `skillSet.ts` import nothing of t3, and the bundle's
  source maps are checked for `t3code/` paths after M3.
- **(r2) The final check.** `pnpm run check` runs at the final commit, and the report names that commit.

## 8. Evidence (`docs/steps/spi-1001/`, stage `penvsk`; each file names its deployed commit)

| File | Shows |
| -- | -- |
| `env-probe.json`, `env-sync.json` | M0 and its re-probe, above |
| `env-install-public.json` | `mattpocock/skills` at a pinned commit: the preview, the install, the listing's location under the mount, a `$name` turn, and **(r2)** what the chip's "View instructions" shows |
| `env-install-private.json` | A skill folder in the fixture repo outside any discovered root, on a branch the script moves; installed at the old commit |
| `env-update.json` | Check, update, the new commit; **(r2)** the changed file read by the agent's `bash` in a Container that was **running** across the update, and its sha256 against the new blob; **(r3, C1)** the wait's command shape for a size-changing and a same-size edit |
| `env-remove.json` | Gone from the snapshot, the mount and a running Container; `$name` left untouched; **(r2)** the Repo skill of that name back at once |
| `env-precedence.json` | The Repo `fruit-code` says `KIWI-7` and the Environment's says `PLUM-9`; the turn answers `PLUM-9`, and `skipped` names the Repo skill |
| `env-no-container.json` | An install, then a turn that reads the skill; the Container never starts |
| `env-readonly.json` | The agent's `write` under the mount fails; **(r2)** so does the agent's `bash` write as a fresh Container's first command, and a write from a running Container |
| `env-refusals.json` | An unreadable private repo, a credential-looking file, a symlink, an oversize skill, **(r2)** a bad path, and a selection over the blob cap |
| `skills-*.png` | Panel screenshots |

The fixture's skills for the refusals and the private install go on branches of `ian-pascoe/t3flare-fixture` that the
script makes and moves. `main` there is untouched.

## 9. Docs (M6)

**ADR-0033**, "Environment skills are pinned copies fetched from GitHub, kept by the Environment and changed only by the
owner". It records:

- GitHub only;
- the credential (§3.2, with R1);
- pinning, and updates only on the owner's click;
- whole files kept in the Environment DO and served read-only in every Workspace with no Container, plus the
  Container's lock and what it is not;
- that an Environment skill beats a Repo skill;
- that no agent tool changes them;
- **(r3, A4)** that "the set changes only at a turn's start" means any thread's turn start in that Workspace.

Its considered options:

- `npx skills` in a Container;
- references only;
- Repo-wins;
- **(r2)** the non-patch alternative to `remount()`: a throwaway second `ComputerWorkspace`, whose public
  `ensureMountsIndexed()` re-indexes. Rejected: it leans on more of computer's internals, with no install-time check
  that it still works. An upstream request for `remount()` is noted.

**(r2) Refining ADR-0032 §1.** It adds a row to the "applies at" table: Environment skills are read by the Pi Durable
adapter at a turn (the set's hash), taken by the thread's Workspace, and apply at the thread's next turn. The composer
and mentions apply at once. The entity keeps one revision and one audit `entity`.

**Other docs:**

- **`GLOSSARY.md`:** add **Skill source**, with SPI-1001's wording. **Environment skill** is unchanged.
- **`docs/parity.md`:** the G10 row and the Skills row.
- **The panel:** the placeholder is gone.
- **`docs/upstream-fragility.md`:**
  - U64 gains the snapshot's `scope: "user"` entries with paths outside `/w/`, their expansion, and the chip's
    `openFile` on such a path;
  - U20's list of dependency patches gains computer's. computer is not t3, so this gets no new entry and no bump-table
    row.

## 10. Escalations, as decided in the review

| | Decision | What the plan does |
| -- | -- | -- |
| E1 | **Accepted**: keep the computer patch adding `remount()` | `remount()` only inside `blockConcurrencyWhile`; falls back to the empty set when the retry fails (§4.1). ADR-0033 records the throwaway-Workspace alternative and the upstream request |
| E2 | **Accepted with change**: inside the Environment entity (revision, audit `environment`, Status) | No `ResolvedEnvironment` field; the adapter reads the store's hash (§2, §4.2). ADR-0033 refines ADR-0032 §1's table |
| E3 | **Accepted**: limits count disabled skills | The panel's totals show the disabled skills' share (§5) |
| E4 | **Accepted with change**: the unauthenticated fallback stays | `/rate_limit` is read first, with an early refusal naming the reset and the way out; the panel says when this path is in use (§3.2) |
