# SPI-1153: Environment skills for the CLI agents (report)

Date: 2026-11-14. Branch `spi-1153-env-skills-cli`, from `main` at 5bc4bb7 (SPI-1147, SPI-1148, SPI-1149, SPI-1151,
SPI-1152). The ticket is the plan; SPI-1001's shared decisions apply. Evidence: [`env-skills-cli/`](env-skills-cli/).
Docker probe: `apps/environment/test/docker/envSkills.docker.test.ts`. Stage harness: `apps/environment/scripts/pclienv.ts`.
Throwaway stage `pclienv`, added to `STAGES`, destroyed after the evidence (2026-11-14). Fragility: U65 (extended). Parity:
[`docs/parity.md`](../parity.md) (Skills row, G10).

t3code is untouched (pinned at d8f3feff). Layer only: no Shadow, no Patch (ADR-0001).

## M0: the probe

`envSkills.docker.test.ts` runs the four pinned CLIs in test:docker's image, each launched as the Workspace DO
launches it (`profileLaunch` → `processCommand`, with this ticket's links and pi's flag), over SPI-1151's repo fixture,
with an Environment skill set mounted read-only at `/workspace/.agents/skills` (as SPI-1148's lock leaves it): an
Environment-only `e-env` and a `dup` beside the fixture's Repo `dup`s. Each CLI reports what it loaded as in SPI-1151's
probe (Codex `skills/list`, pi `get_commands`, Claude Code's `available_commands_update`, OpenCode's server's
`GET /api/skill`); a shell in each launch reads through the link and tries to write through it. No model is called.
Recorded in [`m0-probe.json`](env-skills-cli/m0-probe.json).

| CLI | Reads the set through | Same-named Repo/Environment pair | Write through the link |
| -- | -- | -- | -- |
| Claude Code 2.1.322 | `$CLAUDE_CONFIG_DIR/skills` → mount | **Environment** wins (Claude keeps the user-level Skill: `dup from the Environment (user)`) | refused |
| pi 1.5.2 | `--skill /workspace/.agents/skills`, first | **Environment** wins (pi keeps the first; t3flare's choice by flag order) | refused |
| OpenCode 2.2.7 | `$XDG_CONFIG_HOME/opencode/skills` → mount | **Repo** wins (OpenCode keeps `.opencode/skills`' `dup`; the Environment's is not listed) | refused |
| Codex 0.167.2 | `$CODEX_HOME/skills/t3flare-environment` → mount | **neither**: Codex lists both (repo and user scope), and skips a bare `$dup` that names more than one Skill | refused |

`CLI_ROOTS[cli].environmentPrecedence` (`packages/skills/src/cliRoots.ts`) is this table's third column; the probe holds
it to the live CLIs.

**Where the Repo skill wins (OpenCode), the report says so:** in OpenCode a repository can replace an Environment skill
of the same name. That is OpenCode's rule, which the ticket keeps; it is acceptable since the CLIs already run a
repository's hooks (ADR-0015), the stronger trust. In Codex a repository can make an Environment skill's bare mention
ambiguous, which Codex then does not inject at all; the model picks by the listing.

**Codex's link is a directory inside its root, not the root.** The probe also ran Codex with its whole
`$CODEX_HOME/skills` linked to the mount (`m0-probe.json` "codex (whole root linked)"): the Skills load, but Codex
fails its start-up install of its bundled `.system` Skills ("Read-only file system", twice), and they are lost. Codex
walks its user root following directory links (openai/codex#8801), so `t3flare-environment/<name>/SKILL.md` loads as
`<name>`, at the mount's canonical path, with `.system` kept. Still a link, never a copy.

The launcher's link lines (`mkdir -p` of the read-only target, `ln -sfn`) were run on `ubuntu:26.04` (uutils) against
a read-only bind: the link is made, and a write through it fails with "Read-only file system".

## What was built

- **M1, links and the flag** (`agents/cliProfiles.ts`, `acpProfiles.ts`): Claude Code's and OpenCode's profiles link
  their user-level root to `SKILLS_MOUNT`; Codex's links `codex/skills/t3flare-environment`; pi's
  `piRepoResourceArgs` puts `--skill /workspace/.agents/skills` before SPI-1151's flags. The launcher makes each link in
  the process's fresh home (`processCommand`'s existing `links`); nothing writes to the mount.
- **M2, snapshots** (`provider/skills.ts`): `cliSkills` merges the Environment's rows into a CLI's Repo-only discovery
  by `withEnvironmentSkillsFor(CLI_ROOTS[cli].environmentPrecedence, …)` (`packages/skills/src/skillSet.ts`):
  `environment` is SPI-1148's merge; `repo` keeps the Repo skill and puts the Environment's in `skipped`; `both` lists
  every Skill of both, Repo first as Codex lists them (t3's menu shows the first of a name). Environment skills keep
  scope `user` and their mount path. The same merge feeds Claude Code's mention rewrite (`claudeMentionRewrite`: an
  Environment skill's note names its mount path) and OpenCode's embed (`messageSkillsFor`, the `SKILL.md` from the row,
  the mount as its base directory).
- **The take (hand-off A1).** The Environment has the CLI's Workspace take the set before the CLI's process starts
  (`spawnCli`) and before each of its turns (`wrapCliAdapter`'s `takeEnvironmentSkills`), through
  `provider/cli/environmentSkillsTake.ts`. The bounded take is SPI-1148's `takeSkillsForTurn`, moved to
  `@t3flare/skills` (`take.ts`) so the Session and the Environment share it: 10 s, never failing the spawn or the turn,
  one call that changes nothing when the hash is held already. **Why both, and on the Environment's side:** a CLI agent
  has no Session, so the hash cannot ride a Session's turn; the Environment holds the hash, and the wrapper and the
  spawner are where a CLI's turn and process begin. The take at the spawn matters most: three of the four CLIs list
  their Skills only at start (below), so a process must start on the current set; the take at the turn makes the files
  current in a running Container before the agent reads them.

## When a CLI catches up

Every CLI lists its Skills once, when its process starts: none of the four rescans its linked root (or pi's flag's
directory) while it runs. The Workspace's copy is current whenever a CLI's process starts (the take at the spawn) and
whenever one of its turns runs (the take at the turn). So, from the stage's `catch-up` steps (each on a thread whose
history never held the late code):

| | Claude Code | Codex | pi | OpenCode |
| -- | -- | -- | -- | -- |
| Installed while the process runs: `$late-code` | not found (`NONE`) | not in Codex's listing; the agent searched the mount and read it | not loaded by pi; the agent listed the mount and read it | found: t3flare's embed reads the rows, not OpenCode's cache |
| Removed while a process that started with it runs | **still served**: Claude's "Load skill" answers from its cached copy | listed still, read fails: `NONE` | listed still, "Could not load skill late-code": `NONE` | **still served** by OpenCode's skill tool from its cache |
| Installed, then a new process | found | found | found | found |

**A CLI catches up at its next process start**: a new thread, or the thread's next turn after its Container stopped
(the Container's idle time, ADR-0032, or a stop), when t3 starts the CLI again and the spawn takes the set first. Until
then a running Claude Code or OpenCode keeps serving a removed Environment skill from its cache, and the four CLIs
list no Environment skill installed after their start (OpenCode's `$name` excepted; the composer, read from the rows,
lists it at once). Files of a Skill the process did load are read current (SPI-1148's update case). This is escalated
below.

## Evidence (stage `pclienv`, deployed at f0134ad)

The fixture: SPI-1151's `cli-skills` (fruit-code, KIWI-7, at each CLI's Repo root) written into a clone of the fixture
project; the Environment skills from `ian-pascoe/t3flare-fixture` branch `spi1153-env` (b0e4cef, pushed by
`pclienv.ts fixture`): `env-code` (its code MANGO-5 in `reference/code.md`), `fruit-code` (PLUM-9) and, installed and
removed during the run, `late-code` (LATE-8). Claude Code, pi and OpenCode on `anthropic/claude-sonnet-5-5`, Codex on
`gpt-6-luna`. The harness's later edits (the catch-up's threads, the mount checked after the removal's turn) changed the
script only, not the deployed code.

Each of [`claude.json`](env-skills-cli/claude.json), [`codex.json`](env-skills-cli/codex.json),
[`pi.json`](env-skills-cli/pi.json), [`opencode.json`](env-skills-cli/opencode.json) records, all checks passing:

- **composer**: `env-code` with scope `user` at `/workspace/.agents/skills/env-code/SKILL.md`, and `fruit-code` as the
  CLI keeps it (Claude Code, pi: the Environment's alone; OpenCode: the Repo's alone; Codex: the Repo's, then the
  Environment's), the Container stopped before and after;
- **described**: "What is the environment code?" on a fresh thread answers MANGO-5 reading the Skill: Claude Code by its
  "Load skill: env-code" and a read through its link; OpenCode by its skill tool and a read through its link; pi by
  `read` at the mount; Codex by reading through its link;
- **mention**: `$env-code` on a fresh thread answers MANGO-5, t3 keeping what was typed;
- **the pair's winner**: `$fruit-code` answers PLUM-9 in Claude Code and pi, KIWI-7 in OpenCode. Codex answered KIWI-7
  here and PLUM-9 on the run before (whose file this run replaced; that answer is recorded here only): Codex injects
  neither, and the model picks;
- **write**: from the Container's shell and from the agent's own tool, `touch` and an overwrite through the linked root
  (pi: the mount) fail with "Read-only file system"; the mount holds only the set afterwards;
- **catch-up**: above.

## Seams tested

| Seam | Tests |
| -- | -- |
| Each CLI's link and pi's flag | `apps/environment/test/cliProfiles.test.ts`, `acpProfiles.test.ts` |
| The merge by precedence (`environment`, `repo`, `both`; mount entries dropped) | `packages/skills/src/skillSet.test.ts` |
| A CLI's snapshot: the Environment skills, scope `user`, at the mount, each CLI's winner first | `apps/environment/test/skillsSnapshot.test.ts` |
| Claude Code's note and OpenCode's embed for an Environment skill and a same-named pair, through t3's real ACP adapter; the take before the turn's text is read and sent | `apps/environment/test/cliSkillDispatch.test.ts` |
| The bounded take (moved from `apps/agents`) | `packages/skills/src/take.test.ts` |
| The live CLIs: read through the link, the winner against `environmentPrecedence`, a write refused | `apps/environment/test/docker/envSkills.docker.test.ts` (test:docker, not in `check`) |

`skills.docker.test.ts` (SPI-1151's probe) now shares `test/docker/cliHarness.ts` with the new probe, and launches
without this ticket's links and flag (a link where its user-level marker sits would hide it); it passes as before.

## Decisions made here (for the orchestrator)

1. **Codex's link is `$CODEX_HOME/skills/t3flare-environment`**, not the root (M0: a read-only root loses Codex's
   bundled Skills).
2. **The take runs at the CLI's spawn and at each of its turns, on the Environment's side**, not in the Workspace's
   process start (above).
3. **pi: the Environment's `--skill` first**, so an Environment skill wins in pi (SPI-1001's rule, the one choice the
   ticket leaves us).
4. **Codex's composer order:** both of a pair, the Repo's first, as Codex lists them.
5. **Escalation: a running CLI is not restarted when the set changes.** It catches up at its next process start
   (above), so a removed Environment skill stays usable in a running Claude Code or OpenCode until then. Recommended
   (assumed provisionally): accept and document it; restarting a live agent mid-thread when the hash moves would lose
   its in-process state (Claude's and OpenCode's resume from their synced sessions, but the cost and the risk are a
   ticket of their own). The alternative: have the wrapper end the session's process at a turn whose take changed the
   set, so the CLI restarts on the new set.
6. **Codex's mention of an Environment skill** found its `reference/` file only after a few failed guesses (it first
   tried the reference under the cwd). It answered; the Skill's own instruction said where the file is. Recorded, not
   changed.

## Left for later

- U64's known limit stands: "View instructions" on an Environment skill chip shows t3's read error.
