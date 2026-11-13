# Plan: SPI-1148, Environment skills: install from GitHub on the Harness panel

Branch `spi-1148-environment-skills`, from `main` at 660f922 (SPI-1147 and SPI-1149 merged). Stage `penvsk` (the
ticket names `p1001e`; the landing run names `penvsk`). Parent SPI-1001; its shared decisions are settled and not
reopened here. Report: `docs/steps/spi-1001-env.md`. Evidence: `docs/steps/spi-1001/env-*.json`. Decision record:
ADR-0033 (new).

## 0. Goal

The owner installs Skills from GitHub on the Harness panel. Each is pinned to a commit, kept whole in the Environment DO,
offered to Durable agents in every Project, and served read-only in every Workspace at `/workspace/.agents/skills/<name>`
without a Container. An Environment skill beats a Repo skill of the same name. Only the owner changes them, by a click.

## 1. M0: what the probes answered

Evidence: [`spi-1001/env-probe.json`](spi-1001/env-probe.json), stage `penvsk`, deployed commit `f64889a` (the probe
commit on this branch: the computer patch below, the Workspace's mount, and a temporary admin route
`POST /_t3flare/probe/env-skills`).

### R1: GitHub from the stage Worker

| Read | Answer |
| -- | -- |
| Unauthenticated `GET /rate_limit` | `x-ratelimit-limit: 60`, `used: 13` at the probe's first read. An earlier run of the probe had spent 2, and that run's first read already showed `used: 5`. The egress IP's bucket is shared with other tenants. |
| Unauthenticated `mattpocock/skills` commit | 200 |
| Token minted for `ian-pascoe/t3flare-fixture` only (`contents: read`, `metadata: read`): `GET /rate_limit` | `x-ratelimit-limit: 5300`: the installation's bucket. |
| Same token: `mattpocock/skills` (public, outside the installation) commit, recursive tree, blob | **200, 200, 200**. `x-accepted-github-permissions: contents=read`; the tree is not truncated (282 entries, 39 `SKILL.md`). Each call takes 1 from the installation's 5,300/h. |
| Same token: the fixture repo (in scope) | 200 |
| Same token: `ian-pascoe/cloudpid-scratch` (private, in the installation, outside the token's scope) | 404 |
| Mint for an owner without the App (`octocat`) | refused: "The GitHub App is not installed on octocat: install it there, on all repositories" |
| Unauthenticated: the private fixture repo | 404 |

**Decision (the ticket's rule):** the 200 settles it. A public repo outside the installation is read with a token scoped
to one installed repo. Unauthenticated reads remain only for an Environment with no installed repo at all (§3.2).

### The read-only mount

| Side | Answer |
| -- | -- |
| Workspace DO | computer's read-only mount refuses every change at or above the mount: a write, a new skill folder, `remove`, `remove` of `/workspace/.agents`, `rename`, `mkdir`. Each answers "read-only mount at /workspace/.agents/skills: cannot modify: …" (the fs RPC codes it `EIO`). Reads answer the set's bytes, UTF-8 intact. The mount's directory exists, empty, before any set is taken. |
| Container, as computerd serves it | The files arrive at the Container's next sync, but the Container's own FUSE view is **writable**. A write, a new folder and an `rm -rf` succeed there; the Workspace skips each one when it pulls (computer's `skipped: read-only`), so the Container differs from the Workspace until it restarts. A fresh Container gets the Workspace's files again. |
| Container, with a read-only bind mount (cloudpid's bootstrap step 0: `mount --bind D D && mount -o remount,bind,ro D`) | The command runs as root and succeeds. A write then fails with `Read-only file system`, and the bind stays for every later command of that Container. A new set taken while it runs still reaches the Container: computerd writes beneath the bind. Files planted before the bind stay until the Container restarts, so the bind goes in before the launch's first command. |

### One DO call for a set

The Workspace DO takes the set from the Environment DO with one RPC (`environmentSkillSet()`), then stores and remounts
it. The fs RPC answers bytes, and Date.now() does not move during the synchronous remount in a DO, so `mountMs` reads 0.

| Set | Files | Call (admin route → Workspace → Environment → mount) | The read alone |
| -- | -- | -- | -- |
| 8 MiB | 13 | 430 to 620 ms | 131 to 136 ms |
| 16 MiB | 23 | 800 to 1,079 ms | 283 to 285 ms |
| 24 MiB | 35 | 1,263 to 1,297 ms | 522 to 623 ms |

8 MiB has three times the headroom it needs. The Container held all 8,388,700 bytes after its next sync.

### What M0 changed for the plan

- **computer 0.11.2 has no `remount()`**: a mount is indexed once per object instance. A new set needs computer to
  check the version again. cloudpid patches computer 0.11.1 for this. M0 ports that patch to 0.11.2
  (`patches/deps/@cloudflare__computer@0.11.2.patch`: `MountIndex.reindex()` and `Workspace.remount()`, about 20 added lines),
  added through `pnpm run relock`. A computer bump re-cuts it, as the alchemy and pi-durable patches are re-cut
  (`docs/upstream-fragility.md` U20 names it). See escalation E1.
- **The Container side needs t3flare's own lock** (§4.3). Neither computer nor computerd makes the Container's copy
  read-only.

## 2. Model and storage (M2)

**Environment skills belong to the Environment settings entity (ADR-0032)**, as the glossary already says. They are a
collection, not a schema field, so they are not an entry in `ENVIRONMENT_SETTINGS`. They are added this way:

- They are stored in the Environment DO's SQLite, in tables owned by a new module, `apps/environment/src/skills/store.ts`:
  - `t3flare_env_skills`: `name` (PK), `description`, `repo` (`owner/name`), `path` (the folder in the repo, `""` at
    the root), `ref` (as named, or null for the default branch), `commit` (40 hex), `digest`, `enabled`, `saved_at`,
    `bytes`, `files`;
  - `t3flare_env_skill_files`: `name`, `path` (in the folder), `blob` (GitHub's blob SHA), `size`, `content` (TEXT),
    PK `(name, path)`. A row is at most 1,536 KiB, under the 2 MB a row may hold.
  - `t3flare_env_skill_meta`: the set's hash (`skillSetHash` over every enabled skill's files, keyed
    `<name>/<path>`), recomputed in the same transaction as each change.
- Every change bumps the Environment revision. That is one revision for the entity, as ADR-0032 §1 keeps it, and the
  Status line shows it. Each change is audited with `entity: "environment"`.
- `ResolvedEnvironment` gains one derived field, `skillSetHash`, which `resolveEnvironment` takes from the store. It is
  not a form field, so the panel's form does not render it. Readers then learn of a new set from what they already read
  (escalation E2).
- **The digest** is cloudpid's folder hash (`folderHashOf`): SHA-256 over the kept files' paths and blob SHAs, from the
  same Trees answer. "Unchanged" and update checks compare digests, never content.
- **Limits** (`apps/environment/src/skills/limits.ts`, unit-tested), applied to every kept skill, enabled or not, so
  enabling one never fails:

  | Limit | Value |
  | -- | -- |
  | A file | 1,536 KiB |
  | A skill | 500 files and 4 MiB |
  | The set | 8 MiB and 100 Environment skills |
  | A description | 1,024 characters |
  | A name | 64 characters |
  | `SKILL.md` candidates in one listing | 200 |

## 3. Fetch (M1)

### 3.1 The port

These are ported from cloudpid@47941c7c with its mocked-GitHub tests (`skill-fetch.test.ts`, `skill-paths.test.ts`,
`skill-source.test.ts` and the fixture repo), adapted to plain Promises. They live in `apps/environment/src/skills/`;
only the Environment Worker loads them.

| t3flare | cloudpid | What it does |
| -- | -- | -- |
| `source.ts` | `github/skill-source.ts` | Parses the three forms: `owner/repo`, `owner/repo@skill`, and `https://github.com/owner/repo/tree/<ref>/<path>`. The ref is optional. |
| `paths.ts` | `github/skill-paths.ts` | The `skills` CLI's `SKILL.md` path rules (MIT, credited), the folder of a `SKILL.md`, the installable paths, and the folder hash. |
| `fetch.ts` | `github/skill-fetch.ts` | `RepoReader`, the listing (`listRepoSkills`, at most 200 candidates, a truncated tree refused), `fetchSkills` at a commit, `viewSkill`, `readSkillMd`, and `metadata.internal` left out unless named. |
| `contents.ts` | `github/contents.ts`, `request.ts` | A `RepoReader` over GitHub's REST API (commit, recursive tree, blobs) through §3.2's token. A 401 mints again once. A rate limit, a 404 and a refusal are each told plainly. |
| `checks.ts` | `extensions/skill-checks.ts` | `problemsIn` (UTF-8, no NUL, file size, `CREDENTIAL_PATTERNS`), `skillNameProblem`, and the limits. |

The rules the ticket adds (marked **(added)**) are each a test:

- a name must hold at least one letter;
- a symlink (tree mode `120000`) or submodule (type `commit`) inside the skill's folder rejects that skill, naming the
  path.

### 3.2 The credential: the Environment DO's alone

- **Who fetches.** The fetch runs in the Environment DO, which mints through the existing `GitHubTokens`
  (`apps/environment/src/agents/github.ts`). The token is used for the fetch's own requests and dropped; it reaches no
  Session, Container, page or log. A new permission set, `SKILL_FETCH_GITHUB_PERMISSIONS = { contents: "read",
  metadata: "read" }`, goes beside the three in `@t3flare/github-app/permissions` (a new token list, added on purpose,
  as that module requires).
- **Which token** for `owner/repo`:
  1. The App is installed on `owner` and covers the repo: a token for that one repo. This is the only path for private
     repos.
  2. Otherwise (a public repo outside the installation): a token for one installed repo. That is the first repo of the
     Environment's Workspace registry (`t3flare_workspaces.owner/name`) the App mints for. R1 showed such a token reads
     public repos and spends the installation's bucket.
  3. No installed repo at all: unauthenticated, the shared 60/h. A rate limit answer says so and names when it resets.
- **Refused:** a private repo the App cannot read answers 404 under every token. The message reads: "GitHub has no repo
  owner/name, or it is private and the GitHub App is not installed on owner (install it there, on all repositories)."
  The ref variant adds "Or it has no ref "<ref>" (a branch, a tag or a commit)."

## 4. Delivery (M3)

### 4.1 The Workspace's copy (built in M0, kept)

- `WorkspaceDO` mounts `skillSetMount` (`apps/agents/src/workspace/skillSet.ts`) at `SKILLS_MOUNT`
  (`@t3flare/skills`). It is computer's read-only `WorkerBundle` of the held set, versioned by the set's hash.
- The set is kept in the DO's KV, one value per file, and replaced whole in one transaction.
- `takeEnvironmentSkills(hash)` does nothing when `hash` is the held one. Otherwise it takes `environmentSkillSet()`
  from the Environment DO, checks its shape and paths (`skillSetProblem`), then stores and `remount()`s it inside
  `blockConcurrencyWhile`. A failure keeps and mounts the old set again. Every call sees the whole old set or the whole
  new one.
- **What a Workspace had at the mount before** (only possible on a Workspace made before this change) is moved to
  `/workspace/.agents/skills.pre-mount` before the first index, with a warning. This is cloudpid's `keepPriorSkills`.
  Today, the first index clears it.
- The M0 timing fields (`readMs`, `mountMs`, `bytes`) and the probe route go in M2. `environmentSkillSet()` then answers
  the store's enabled rows.

### 4.2 Timing: the turn carries the hash

- The Pi Durable adapter's `submitTurn` input gains `environmentSkills?: string`, the set's hash
  (`SubmitTurnInput` in `@t3flare/session-protocol`).
- `SessionDO.submitTurn` calls the Workspace's `takeEnvironmentSkills(hash)` after `#takeHarness()`. The wait is bounded
  (10 s; an 8 MiB set took 0.6 s) and never fails the turn. A timeout or failure is logged, and the turn runs with the
  set the Workspace holds.
- A steer carries no hash: a steer joins a running turn, and the set changes only at a turn's start.
- No Container start is needed. A running Container gets the files at its next sync; a stopped one, at its next start.

### 4.3 The Container's copy: read-only from the first command

- Once per Container launch, before its first command, the Workspace DO runs the M0 lock script as root: for
  `SKILLS_MOUNT`, `mkdir -p` if absent, skip if already a mount point, else bind it over itself and remount it
  read-only. The launch's start time is recorded, and the lock is recorded against it.
- The hook goes where every command path meets: `exec()`, which `#startContainerFor` and the terminals' `startContainer`
  use. Terminal and CLI spawns call one of those first.
- It is best effort, as in cloudpid: a failure is logged once per launch and commands go on. The Workspace's own copy
  stays authoritative either way.
- Unit-tested on the script text and the once-per-launch rule; the stage shows the refusal (`env-readonly.json`).

### 4.4 Discovery, listing, snapshot and expansion

- **The model's listing.** `WorkspaceDO.#environmentSkills()` (the slot SPI-1147 left) parses the held set with
  `@t3flare/skills`' frontmatter reader. It is parsed once per hash and kept in memory. Its paths are under
  `SKILLS_MOUNT`.
- `discoverSkills` already puts it first and lets it win: a shadowed Repo skill goes to `skipped` ("is shadowed by
  /workspace/.agents/skills/<name>/SKILL.md"). The 100 cap counts Repo skills only. Every enabled Environment skill is
  listed, and the listing stays frozen per context window.
- **The composer and mentions** come from the Environment DO's rows, so they are current at once.
  - A pure `withEnvironmentSkills(rows, discovery)` in `@t3flare/skills` drops the Workspace's held-set entries, puts
    the enabled rows first, and moves same-named Repo skills to `skipped`.
  - `provider/skills.ts` applies it to the snapshot. Environment skills get scope `user`, the path
    `/workspace/.agents/skills/<name>/SKILL.md`, and `userInvocationOnly` from `disable-model-invocation`.
  - `messageSkillsFor` applies it for expansion: `$name` and `/skill:name` embed the row's `SKILL.md` body, with
    `location` under the mount. The turn that carries the expansion also carries the hash, so the referenced files are
    in the Workspace before the agent reads them.
- **The Harness `skills` switch** governs Environment skills as it does Repo skills. Off means no listing, an empty
  snapshot and no expansion. The mount is still delivered; it is inert files.

## 5. API and the panel's Skills section (M2, M4)

### Routes

All are under `/_t3flare/harness/api/skills`, behind the existing guards. Writes go through `unsafeWrite` (JSON
Content-Type, Origin, `Sec-Fetch-Site`) and CSRF, and are added to the panel's write-route list.

| Route | Does |
| -- | -- |
| `GET …/skills` | The list: name, description, source (repo, path, ref), short commit, saved at, enabled, files, bytes. Also the set's totals against 8 MiB and 100. |
| `GET …/skills/view?name=` | `SKILL.md` as text; other files as path and size, each with its GitHub URL at the commit (`https://github.com/<repo>/blob/<commit>/<path>/<file>`). |
| `POST …/skills/preview` `{source}` | Resolves the ref to a commit and lists the candidates, each with its checks' problems or OK. A same-named skill shows as "replaces X from Y"; identical files and source show as "unchanged". Also lists what was left out (`metadata.internal`, over the candidate cap). Nothing is stored. |
| `POST …/skills/install` `{source, commit, names}` | Fetches again at the previewed commit, so what was previewed is what is kept. Checks each skill and the set's limits after the change, stores, bumps the revision, audits. Answers per name. |
| `POST …/skills/check` `{names?}` | For each skill, resolves its ref's latest commit. If the commit moved, compares the digest from one Trees request. Answers up to date, or an update with the old and new commit and the changed files (added, changed, removed, by blob SHA). Nothing is stored. |
| `POST …/skills/update` `{name, commit}` | Fetches at that commit, checks, stores, audits. |
| `POST …/skills/remove` `{name}` | Removes the skill. The page asks `confirm()` first, as MCP server removal does. |
| `POST …/skills/enable` `{name, enabled}` | The skill's switch. |

### The section

- The section replaces the placeholder. It has:
  - an install form: source, then Preview;
  - the preview as the confirmation: a checkbox per installable skill, with its notes, then Install;
  - the list: source, ref, short commit, saved time and a switch per skill, with View, Check for updates and Remove.
- View shows `SKILL.md` escaped, set as text in a `<pre>`. The page script never writes it as HTML.
- Status shows the count, the enabled count and the set's short hash, in place of "Environment skills deferred".
- The CSP stays hash-only. The script grows within `pageScript.ts`.
- Screenshots: desktop and phone, light and dark, as `scripts/panel.ts shoot` makes them.

### Audit

| What an entry holds | Value |
| -- | -- |
| `entity` | `environment` |
| `action` | `skill-install`, `skill-update`, `skill-remove`, `skill-enable` or `skill-disable` |
| `target` | the name |
| `before` / `after` | `{ repo, path, ref, commit, digest, enabled }` |

An entry never holds file content.

## 6. What does not ship

As the ticket lists:

- skills.sh search or directory;
- a scheduled update check;
- per-Project scope;
- agent changes. No agent tool installs, updates or removes; the mount refuses the agent's writes on both sides.
- CLI agents: SPI-1153 builds on `/workspace/.agents/skills`.

## 7. Milestones and tests

| M | Builds | Unit tests (each file tested alone as it lands) |
| -- | -- | -- |
| M1 | §3 | cloudpid's ported tests; each check row and limit; the (added) rules; token choice 1/2/3 with a mocked minter; the refusal text whole |
| M2 | §2, §5's API, the probe route removed | store: rows, set hash, revision bump, audit without content, limits after a change, unchanged; API: guards (CSRF, Origin, form body), preview/install/check/update/remove/enable |
| M3 | §4 | `skillSetProblem`; the store's replace; `withEnvironmentSkills` precedence and `skipped`; the slot's parse; `SessionDO` taking the set on a hash change and not otherwise, bounded; the lock script and its once-per-launch rule; snapshot scope `user` and paths; expansion from rows |
| M4 | §5's section | the section's render (escaped `SKILL.md`, the switch, confirm on remove), the placeholder gone |
| M5 | stage `penvsk` | evidence below; destroyed after |
| M6 | docs | ADR-0033, glossary, parity G10, U64 and U20, report |

The agents Worker stays free of t3: `@t3flare/skills` and `skillSet.ts` import nothing of t3. The bundle's source maps
are checked for `t3code/` paths after M3.

## 8. Evidence (`docs/steps/spi-1001/`, stage `penvsk`; each file names its deployed commit)

| File | Shows |
| -- | -- |
| `env-probe.json` | M0, above. |
| `env-install-public.json` | `mattpocock/skills` at a pinned commit: the preview, the install, the listing's location under the mount, and a `$name` turn. |
| `env-install-private.json` | A skill folder in the fixture repo outside any discovered root, on a branch the script moves; installed at the old commit. |
| `env-update.json` | Check, update, the new commit, and the changed file read by the agent. |
| `env-remove.json` | Gone from the snapshot and the mount; `$name` left untouched. |
| `env-precedence.json` | The Repo `fruit-code` says `KIWI-7`, the Environment's says `PLUM-9`; the turn answers `PLUM-9`, and `skipped` names the Repo skill. |
| `env-no-container.json` | An install, then a turn that reads the skill; the Container never starts. |
| `env-readonly.json` | The agent's `write` under the mount fails, and so does one from a running Container. |
| `env-refusals.json` | An unreadable private repo, a credential-looking file, a symlink, an oversize skill. |
| `skills-*.png` | Panel screenshots. |

The fixture's skills for the refusals and the private install go on branches of `ian-pascoe/t3flare-fixture` that the
script makes and moves; `main` there is untouched.

## 9. Docs (M6)

- **ADR-0033**, "Environment skills are pinned copies fetched from GitHub, kept by the Environment and changed only by
  the owner". It records:
  - GitHub only;
  - the credential (§3.2, with R1);
  - pinning, with updates only on the owner's click;
  - whole files kept in the Environment DO and served read-only in every Workspace, with no Container, plus the
    Container's lock;
  - Environment beats Repo;
  - no agent tool changes them.
  It also records the considered options (`npx skills` in a Container, references only, Repo-wins) and refines
  ADR-0032 (the entity's revision, the derived `skillSetHash`).
- **`GLOSSARY.md`:** add **Skill source** with SPI-1001's wording. **Environment skill** already exists and is
  unchanged.
- **`docs/parity.md`:** the G10 row and the Skills row.
- **The panel:** the placeholder is gone.
- **`docs/upstream-fragility.md`:**
  - U64 gains the t3 leans: the snapshot's `scope: "user"` entries with paths outside `/w/`, and their expansion;
  - U20's list of dependency patches gains computer's. computer is not t3, so this gets no new entry and no bump-table
    row.

## 10. Escalations (assumed provisionally; the build follows the recommendation)

- **E1. A dependency patch on computer for `remount()`.** Recommendation: keep it. It is cloudpid's, about 20 added lines, in
  `patches/deps`, and pnpm fails an install when it stops applying. Without it, a new set reaches a Workspace only when
  its object restarts. That would mean aborting the DO, which ends terminals and CLI processes, or never, for a busy
  Workspace.
- **E2. Environment skills inside the Environment settings entity.** They share its revision, audit `entity` and
  Status, and `ResolvedEnvironment.skillSetHash` is derived, not a schema entry. The alternative is a third entity with
  its own revision. Recommendation: inside, as the glossary's definition of Environment settings already says.
- **E3. The set's limits count disabled skills.** Recommendation: count them, so a switch never fails.
- **E4. With no installed repo at all, public repos are read unauthenticated** (60/h, shared). Recommendation: keep it,
  so a fresh Environment can install before its first Project; the rate-limit answer is plain.
