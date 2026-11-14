# Environment skills are pinned copies fetched from GitHub, kept by the Environment and changed only by the owner

Status: accepted (SPI-1148, 2026-11-14; decided in SPI-1001's triage, refined by the plan's two reviews). Plan:
[`docs/steps/spi-1001-env-plan.md`](../steps/spi-1001-env-plan.md). Report:
[`docs/steps/spi-1001-env.md`](../steps/spi-1001-env.md). Refines
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md).

SPI-1147 gave Durable agents a Workspace's Repo skills. The owner also wants Skills of his own in every Project,
installed from GitHub on the Harness panel: **Environment skills**. They follow cloudpid's ADR-0026 (Skills kept by
cloudpid and fetched from GitHub), cut to t3flare: one Environment, the owner's changes only.

1. **GitHub only.** A Skill source is `owner/repo`, `owner/repo@skill`, or `https://github.com/owner/repo/tree/<ref>/<path>`,
   ported with cloudpid's fetch (the `skills` CLI's path rules, MIT). Other hosts are not installed from.
2. **The credential is the Environment DO's.** It reads GitHub itself, with a token it mints and drops; no Session,
   Container, page or log sees it.
   - A repo the GitHub App is installed on is read with a token for that repo alone (`contents: read`,
     `metadata: read`). This is the only way to read a private repo.
   - A public repo outside the installation is read with a token for one installed repo. GitHub answers it from the
     installation's limit (R1, `docs/steps/spi-1001/env-probe.json`: 200 for a public repo outside the token's scope,
     404 for a private one).
   - With no installed repo at all, reads are unauthenticated, from the 60 an hour GitHub gives the Worker's shared
     address. `/rate_limit` is read first and a request that would run out is refused, naming the reset and the way out;
     the panel says when this path is in use.
   - Each request is bounded: a preview reads one commit, one tree and the candidates' `SKILL.md`; an install checks
     sizes, paths and links from the tree before reading other files, and reads at most 500 blobs (the largest Skill),
     under GitHub's 900-a-minute secondary limit. A secondary-limit answer is a refusal naming the wait.
3. **Pinned; updated only on the owner's click.** An install keeps the commit it resolved to. "Check for updates"
   compares a folder hash of the kept files' blobs at the ref's latest commit, by repo and ref, reading no file; Update
   fetches the commit shown. A Skill whose folder is gone, or whose name changed, is not updated. There is no scheduled
   check: it would wake an idle-reset Environment (ADR-0003).
4. **Whole files, kept by the Environment DO.** One row per Skill (its Skill source, commit, digest, switch), one per
   file (text, blob SHA, size, SHA-256), and the enabled set's hash, in its SQLite. They are part of the **Environment
   settings** entity (ADR-0032): every change bumps its revision, is audited with `entity: "environment"` and never with
   file content, and is one synchronous block (revision checked, limits, rows, hash, revision, audit). Limits, disabled
   Skills counted so a switch never fails: a file 1,536 KiB, a Skill 500 files and 4 MiB, the set 8 MiB and 100 Skills,
   a path under the mount 512 bytes with no part over 255. Text only; files that look like a credential or a local
   path, links and submodules are refused.
5. **Served read-only in every Workspace, no Container needed.**
   - Each Workspace DO keeps a copy of the enabled set and serves it at `/workspace/.agents/skills/<name>`, outside the
     repo, as computer's read-only mount. Discovery and the agent's file tools read it without a Container (ADR-0009).
   - **When it changes:** a Pi Durable turn carries the set's hash; when it differs from the one the Workspace holds,
     the Session has the Workspace take the set before the agent runs (bounded; never failing the turn). "At a turn's
     start" means any thread's turn start in that Workspace: threads share a Workspace, so one thread's turn can change
     the set under another's running turn. The composer and Skill mentions read the Environment's rows, so they are
     current at once.
   - **A running Container** gets the files at its next sync; the take waits, up to 5 s, until each new or changed file
     reads its new SHA-256 there and each removed one is gone. A stopped Container is never started for it.
   - **The Container's copy is read-only too**, from a launch's first command: computerd serves the mount writable, so
     every command that reaches the Container (the Workspace DO's own and the Durable agent's `bash` alike) starts with a
     bind of the directory over itself, remounted read-only. It guards against accident, **not against an agent set on
     it**: the agent is root and could remount. Even then its writes never reach the Workspace (computer skips them), and
     they are gone at the next Container start.
   - A set a Workspace cannot mount is refused and reported (the panel's Status shows the last), and not read again
     until the hash moves; the Workspace keeps the set it held, else the empty set.
   - computer 0.11.2 indexes a mount once per object, so a dependency patch adds `Workspace.remount()` (cloudpid's, about
     20 lines, `patches/deps/@cloudflare__computer@0.11.2.patch`); it runs only inside `blockConcurrencyWhile`, since
     computer leaves a mount writable while it copies.
6. **An Environment skill beats a Repo skill of the same name**, so a fork cannot replace the owner's Skill. The
   shadowed Repo skill is in the discovery's `skipped`. Every enabled Environment skill is listed; the 100 cap counts
   Repo skills only. For Pi Durable; a CLI agent keeps its own rule, which differs in OpenCode and Codex (Consequences;
   SPI-1153).
7. **No agent tool changes them** (ADR-0026 §8). Only the owner, on the panel (or a script with the Access service token and the admin token), and
   every change goes through the panel's guards (Access, CSRF, Origin, JSON).

## Considered options

- **`npx skills` in a Container.** Every install and update would need a running Container, the panel included, and the
  CLI's flags change between releases (its `check` applies updates). Rejected, as in cloudpid.
- **References only** (a lock file each Container installs from). A new Workspace would have no Skills until its
  Container started, every start would need GitHub, and the first prompt is built before that. Rejected.
- **Repo wins** (cloudpid's rule). A fork's `.agents/skills/<name>` would silently replace the owner's Skill. Rejected:
  the Environment's is the owner's choice for every Project.
- **No patch on computer: a throwaway second `ComputerWorkspace`** over the same storage, whose public
  `ensureMountsIndexed()` re-indexes. Rejected: it leans on more of computer's internals (two instances over one
  SQLite) with no install-time check that it still works, where a patch fails the install when it stops applying. An
  upstream request for a public `remount()` would let the patch go.

## Consequences

- A new or changed Environment skill reaches the model's listing at the next context window (the listing is frozen per
  window), its files at the next turn, and the composer at once.
- A Pi Durable turn carries the set's hash to its Session, which has the Workspace take it. A CLI agent's Workspace
  takes it on the Environment's side, before the CLI's process starts and before each of its turns (SPI-1153,
  `docs/steps/env-skills-cli.md`); the CLI reads it through a link in its user-level Skill root (pi: a `--skill` flag)
  and keeps its own rule for a same-named Repo skill, by the root the Repo skill is in: Claude Code and pi keep the
  Environment's; OpenCode keeps a Repo skill in `.opencode/skills` or `.opencode/skill` and the Environment's over one
  in `.agents/skills`; Codex lists both and a bare mention picks neither.
- t3's chip "View instructions" opens an Environment skill's path as a project file and shows t3's read error, since
  the path is outside `/w/<id>` (U64).
- Installs and checks spend the installation's GitHub limit; with no installed repo, the shared unauthenticated one.
