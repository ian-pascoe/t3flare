# SPI-1153: Environment skills for the CLI agents (report)

Date: 2026-11-14. Branch `spi-1153-env-skills-cli`, from `main` at 5bc4bb7 (SPI-1147, SPI-1148, SPI-1149, SPI-1151,
SPI-1152). The ticket is the plan; SPI-1001's shared decisions apply. Evidence: [`env-skills-cli/`](env-skills-cli/).
Docker probe: `apps/environment/test/docker/envSkills.docker.test.ts`. Stage harness: `apps/environment/scripts/pclienv.ts`.
Throwaway stage `pclienv`, added to `STAGES`, destroyed after the evidence (2026-11-14). Fragility: U65 (extended). Parity:
[`docs/parity.md`](../parity.md) (Skills row, G10).

t3code is untouched (pinned at d8f3feff). Layer only: no Shadow, no Patch (ADR-0001).

## M0: the probe

`envSkills.docker.test.ts` runs the four pinned CLIs in test:docker's image, each launched as the Workspace DO
launches it (`profileLaunch` → `processCommand`, with this ticket's links and pi's flag), with an Environment skill set
mounted read-only at `/workspace/.agents/skills` (as SPI-1148's lock leaves it): an Environment-only `e-env` and a
`dup`. **For each of the CLI's Repo Skill roots, on its own**, a repo holds a `dup` in that root alone (review round 1:
the first probe put a `dup` in every root at once, which hid OpenCode's per-root answer). Each CLI reports what it
loaded as in SPI-1151's probe (Codex `skills/list`, pi `get_commands`, Claude Code's `available_commands_update`,
OpenCode's server's `GET /api/skill`); a shell in each launch reads through the link and tries to write through it. No
model is called. Recorded in [`m0-probe.json`](env-skills-cli/m0-probe.json).

| CLI | Reads the set through | Winner of a Repo skill in that root and an Environment skill of its name | Write through the link |
| -- | -- | -- | -- |
| Claude Code 2.1.322 | `$CLAUDE_CONFIG_DIR/skills` → mount | `.claude/skills`: **Environment** (Claude keeps the user-level Skill: `dup from the Environment (user)`) | refused |
| pi 1.5.2 | `--skill /workspace/.agents/skills`, first | `.pi/skills`, `.agents/skills`: **Environment** (pi keeps the first; t3flare's choice by flag order) | refused |
| OpenCode 2.2.7 | `$XDG_CONFIG_HOME/opencode/skills` → mount | `.opencode/skills`, `.opencode/skill`: **Repo**; `.agents/skills`: **Environment** | refused |
| Codex 0.167.2 | `$CODEX_HOME/skills/t3flare-environment` → mount | `.agents/skills`, `.codex/skills`: **neither**: Codex lists both (repo and user scope), and skips a bare `$dup` that names more than one Skill | refused |

Each `CLI_ROOTS` Skill root's `environment` (`packages/skills/src/cliRoots.ts`) is this table's third column, root by
root; `environmentPrecedenceOf(cli, path)` reads it for a Repo skill by the root its path is in. The probe holds the
table to the live CLIs, root by root.

**Where the Repo skill wins (OpenCode's `.opencode/` roots), the report says so:** in OpenCode a repository's
`.opencode/skills` or `.opencode/skill` can replace an Environment skill of the same name; its `.agents/skills` cannot.
That is OpenCode's rule, which the ticket keeps; it is acceptable since the CLIs already run a repository's hooks
(ADR-0015), the stronger trust. In Codex a repository can make an Environment skill's bare mention ambiguous, which
Codex then does not inject at all; the model picks by the listing.

**Codex's link is a directory inside its root, not the root.** The probe also ran Codex with its whole
`$CODEX_HOME/skills` linked to the mount (`m0-probe.json` "codex (whole root linked)"): the Skills load, but Codex
fails its start-up install of its bundled `.system` Skills ("Read-only file system", twice), and they are lost. Codex
walks its user root following directory links (openai/codex#8801), so `t3flare-environment/<name>/SKILL.md` loads as
`<name>`, at the mount's canonical path, with `.system` kept. Still a link, never a copy.

The launcher's link lines (`mkdir -p` of the read-only target, `ln -sfn`) were run on `ubuntu:26.04` (uutils) against
a read-only bind: the link is made, and a write through it fails with "Read-only file system".

## What was built

- **M1, links and the flag** (`agents/cliProfiles.ts`, `acpProfiles.ts`): Claude Code's and OpenCode's profiles link
  their user-level root to `SKILLS_MOUNT` (`environmentSkillsLink`, defined once in `acpProfiles.ts`); Codex's links
  `codex/skills/t3flare-environment`; pi's `piRepoResourceArgs` puts `--skill /workspace/.agents/skills` before
  SPI-1151's flags. The launcher makes each link in the process's fresh home (`processCommand`'s existing `links`);
  nothing writes to the mount.
- **M2, snapshots** (`provider/skills.ts`): `cliSkills` merges the Environment's rows into a CLI's Repo-only discovery
  by `withEnvironmentSkillsFor((skill) => environmentPrecedenceOf(cli, skill.filePath), …)`
  (`packages/skills/src/skillSet.ts`), each same-named pair settled by the root its Repo skill is in: `environment`
  lists the Environment's, first, and puts the Repo's in `skipped`; `repo` keeps the Repo's and puts the Environment's
  in `skipped`; `both` lists both, the Repo's first, as Codex lists them (t3's menu shows the first of a name). An
  Environment skill without a Repo namesake is listed first. Pi Durable's `withEnvironmentSkills` is the same merge
  with `environment` for every pair. Environment skills keep scope `user` and their mount path. The same merge feeds
  Claude Code's mention rewrite (`claudeMentionRewrite`: an Environment skill's note names its mount path) and
  OpenCode's embed (`messageSkillsFor`, the `SKILL.md` from the row, the mount as its base directory), so OpenCode's
  embed gives the Skill OpenCode itself would load, root by root.
- **The take (hand-off A1).** The Environment has the CLI's Workspace take the set before the CLI's process starts
  (`spawnCli`) and before each of its turns (`wrapCliAdapter`, by default: every CLI driver gets it without asking;
  tests replace it), through `provider/cli/environmentSkillsTake.ts`. The turn's take comes before the turn's hold and
  2 h cap, so an interrupt during its wait leaves neither behind. The bounded take is SPI-1148's `takeSkillsForTurn`,
  moved to `@t3flare/skills` (`take.ts`) so the Session and the Environment share it (the Session imports it from
  there): 10 s, never failing the spawn or the turn, one call that changes nothing when the hash is held already. **Why
  both, and on the Environment's side:** a CLI agent has no Session, so the hash cannot ride a Session's turn; the
  Environment holds the hash, and the wrapper and the spawner are where a CLI's turn and process begin. The take at the
  spawn matters most: every CLI lists its Skills only when its process starts (below), so a process must start on the
  current set; the take at the turn makes the mount's files current in a running Container before the agent reads them.

## When a CLI catches up

All four CLIs list their Skills only when their process starts: none rescans its linked root (or pi's flag's
directory) while it runs. The Workspace's copy is current whenever a CLI's process starts (the take at the spawn) and
whenever one of its turns runs (the take at the turn). From the stage's catch-up steps, each turn on a thread whose
history never held the late code (review round 1: the described turn now runs on its own thread, started before the
install, not on the thread that had just answered):

| | Claude Code | Codex | pi | OpenCode |
| -- | -- | -- | -- | -- |
| Installed while the process runs: `$late-code` | not found (`NONE`) | not found (`NONE`) | not loaded by pi; the agent searched the mount and read it | found: t3flare's embed reads the rows, not OpenCode's cache |
| Installed while the process runs: "What is the late code?" | not found | not found | not loaded by pi; the agent searched the mount and read it | not found (OpenCode's skill tool lists what it loaded) |
| Removed while a process that started with it runs | **still served**: Claude's "Load skill" answers from its cached copy | still listed, its read fails: `NONE` | still listed, "Could not load skill late-code": `NONE` | **still served** by OpenCode's skill tool from its cache |
| Installed, then a new process | found | found | found | found |

In the first stage run (before review round 1), Codex's agent also found the installed Skill by searching the mount;
in this run it did not. Either way Codex's own listing did not hold it.

**A CLI catches up at its next process start**: a new thread, or the thread's next turn after its Container stopped
(the Container's idle time, ADR-0032, or a stop), when t3 starts the CLI again and the spawn takes the set first. Until
then a running Claude Code or OpenCode keeps serving a removed Environment skill from its cache, and none of the four
lists an Environment skill installed after its start (OpenCode's `$name` excepted, through t3flare's embed; the
composer, read from the rows, lists it at once). Accepted as is (the orchestrator, review round 1, E1).

## Evidence (stage `pclienv`)

Review round 1 redeployed the stage at `35b29d5` (the deployed code is `b03ad58`'s; `35b29d5` changed only
`pclienv.ts`) and took all four files again; the stage is destroyed. The fixture: SPI-1151's `cli-skills` written into
a clone of the fixture project, and a `pair-<word>` Skill in each CLI Repo root (`.agents/skills` amber,
`.codex/skills` birch, `.pi/skills` cedar, `.claude/skills` dune, `.opencode/skills` ember, `.opencode/skill` fjord;
the Repo's says `REPO-<WORD>`); the Environment skills from `ian-pascoe/t3flare-fixture` branch `spi1153-env`
(c20f378, pushed by `pclienv.ts fixture`): `env-code` (its code MANGO-5 in `reference/code.md`), each `pair-<word>`
(`ENV-<WORD>`, the same name and description) and, installed and removed during the run, `late-code` (LATE-8). Claude
Code, pi and OpenCode on `anthropic/claude-sonnet-5-5`, Codex on `gpt-6-luna`.

Each of [`claude.json`](env-skills-cli/claude.json), [`codex.json`](env-skills-cli/codex.json),
[`pi.json`](env-skills-cli/pi.json), [`opencode.json`](env-skills-cli/opencode.json) records, all checks passing:

- **composer**: `env-code` with scope `user` at `/workspace/.agents/skills/env-code/SKILL.md`, and each pair in the
  CLI's Repo roots as the CLI keeps it by that root (OpenCode: the Repo's `pair-ember` and `pair-fjord`, the
  Environment's `pair-amber`; Claude Code and pi: the Environment's; Codex: the Repo's, then the Environment's), the
  Container stopped before and after;
- **described**: "What is the environment code?" on a fresh thread answers MANGO-5 reading the Skill: Claude Code by its
  "Load skill: env-code" and a read through its link; OpenCode by its skill tool and a read through its link; pi by
  `read` at the mount; Codex by reading through its link;
- **mention**: `$env-code` on a fresh thread answers MANGO-5, t3 keeping what was typed;
- **the pairs**, per Repo root, each turn on a fresh thread. **The CLI's own choice** is a description-matched turn
  ("What is the amber pair code?"), which the CLI answers from the Skill it loaded: OpenCode's skill tool gave
  REPO-EMBER and REPO-FJORD for its `.opencode/` roots and ENV-AMBER for `.agents/skills`; Claude Code's "Load skill"
  ENV-DUNE; pi read the mount's `pair-cedar` and `pair-amber` (ENV-). **The mention** (`$pair-<word>`, t3's composer
  and, for OpenCode, t3flare's embed) gave the same side in each. Codex lists both of each pair and picked the Repo's
  `pair-amber` and `pair-birch` here; its winner is checked only as an answer from one side;
- **write**: from the Container's shell and from the agent's own tool, `touch` and an overwrite through the linked root
  (pi: the mount) fail with "Read-only file system"; the mount holds only the set afterwards;
- **catch-up**: above.

## Seams tested

| Seam | Tests |
| -- | -- |
| Each CLI's link and pi's flag | `apps/environment/test/cliProfiles.test.ts`, `acpProfiles.test.ts` |
| The merge by each pair's rule (`environment`, `repo`, `both`; two pairs from different roots apart; mount entries dropped); each root's winner (`environmentPrecedenceOf`, the deepest root) | `packages/skills/src/skillSet.test.ts` |
| A CLI's snapshot: the Environment skills, scope `user`, at the mount, each pair as the CLI keeps it by root (OpenCode's `.agents/skills` and `.opencode/skills`) | `apps/environment/test/skillsSnapshot.test.ts` |
| Claude Code's note and OpenCode's embed for an Environment skill and a same-named pair by root, through t3's real ACP adapter | `apps/environment/test/cliSkillDispatch.test.ts` |
| The take: `takeEnvironmentSkillsAt` (asks, asks nothing, never fails, bounded, the Environment's own by default); `spawnCli` takes before the process channel starts, and starts when the take cannot be made; `wrapCliAdapter`'s default take before the inner turn for each of the four drivers; an interrupt during the take leaves no hold or cap | `apps/environment/test/cliSkillsTake.test.ts` |
| The bounded take (moved from `apps/agents`) | `packages/skills/src/take.test.ts` |
| The live CLIs: read through the link, each Repo root's winner on its own, a write refused | `apps/environment/test/docker/envSkills.docker.test.ts` (test:docker, not in `check`) |

`skills.docker.test.ts` (SPI-1151's probe) now shares `test/docker/cliHarness.ts` with the new probe, and launches
without this ticket's links and flag (a link where its user-level marker sits would hide it); it passes as before.

## Decisions (settled by the orchestrator, review round 1)

1. **Codex's link is `$CODEX_HOME/skills/t3flare-environment`**, not the root (M0: a read-only root loses Codex's
   bundled Skills). Accepted (E2).
2. **The take runs at the CLI's spawn and at each of its turns, on the Environment's side**, not in the Workspace's
   process start (above). Accepted (E3).
3. **pi: the Environment's `--skill` first**, so an Environment skill wins in pi (SPI-1001's rule, the one choice the
   ticket leaves us).
4. **Codex's composer order:** both of a pair, the Repo's first, as Codex lists them. Accepted (E4).
5. **A running CLI is not restarted when the set changes**; it catches up at its next process start (above). Accepted
   and documented (E1).
6. **Codex's mention of an Environment skill** found its `reference/` file only after a few failed guesses (it first
   tried the reference under the cwd) in the first run. It answered; the Skill's own instruction said where the file
   is. Recorded, not changed.

## Left for later

- U64's known limit stands: "View instructions" on an Environment skill chip shows t3's read error.
