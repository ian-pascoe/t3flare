# Step 4b: report (Claude Code and OpenCode over ACP)

Date: 2026-11-12. Branch `step-4b`, built on `origin/step-4a` at 5f232cc and rebased on `origin/main` at 051a02d (4a
landed); see **Rebase onto `main`**. t3code pinned at `v0.1.9-nightly.20261111.4515` (24e7747), untouched. Throwaway
stage `step4b` (added to `STAGES`), deployed eight times and **destroyed** at the end. Plan: `docs/steps/step-4b-plan.md`, whose changelog (owner OD-1/OD-2, Fable review
F1–F10) overrides its body. Evidence: `docs/steps/step-4b/` (`m0-local.json`, `m1-*.json`, `m2-*.json`, `m3-*.json`,
`m4-*.json`, `m5-*.json`, `m5-desktop-*.png`, `rebase-*.json`); M0's probes in `docs/steps/step-4b/probes/`.

## What was built

- **Two drivers of t3's own kinds** (`claudeAgent` "Claude", `opencode` "OpenCode") on t3's generic ACP adapter
  (`apps/environment/src/provider/cli/acpDriver.ts`, `claudeDriver.ts`, `opencodeDriver.ts`), registered in the
  `builtInDrivers` Shadow beside 4a's Codex and Pi, behind 4a's wrapper (one process per session, the hold, the 2 h cap).
- **The flavors' policy** (`acpFlavor.ts`): the agent pinned to its asking mode (Claude `default`, OpenCode `build`),
  t3flare's own permission disposition with lexical containment for `auto-accept-edits` (F2), a card without "for the
  session", Claude's plan captured at `ExitPlanMode` and the request denied (F1), modes checked at start and on every
  update (F4), the proxy's failures classified (F9), and a runtime guard that ends a drifting session with a named
  failure.
- **Profiles** (`agents/acpProfiles.ts`): `claude-agent-acp` with no arguments, `opencode acp` exactly; Claude Code's
  managed settings (F3, F5) and OpenCode's system configuration with deny-by-default policies (F6), validated against
  OpenCode 2.2.7's schema in a test.
- **The image**: Claude Code from a committed npm lock, OpenCode from its checked release tarball, their launchers
  (managed settings and system configuration installed per process, Claude's nonce kept out of the environment,
  OpenCode's config-warning watcher, snapshot and sanitised copy-in) and OpenCode's key plugin.
- **The key gate**: Claude Code and OpenCode get 2 grants per process; each counts twice against a Workspace's 4 CLI
  processes (`CLI_WEIGHT`, M0 P7's memory).
- **Idle compaction** is not started and its setting is locked (F7).
- **Harness**: `POST /_t3flare/agents/acp-check` (stages only), `scripts/cli4b.ts` (acp, turn, modes, resume, two,
  restart, hostile, leak), `acceptance.ts --claude --opencode`, the bump's acceptance flags.

## Exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| A Claude Code turn on a proxy model in a Workspace's Container, its edit and its command each approved | **pass** (claude-sonnet-5-5: a file-change and a command request, both answered, the diff, `bash test.sh` passed) | `m2-claude-turn.json`, `m5-acceptance.json` |
| An OpenCode turn the same way | **pass** (claude-sonnet-5-5 and gpt-6-luna) | `m3-opencode-turn.json`, `m3-opencode-gpt-turn.json`, `m5-acceptance.json` |
| A plan turn of each edits nothing | **pass** (Claude's shown as t3's proposed plan; OpenCode's `plan` agent) | `m2-modes.json`, `m3-modes.json`, `m5-acceptance.json` |
| No vendor login | **pass** (Claude offers no auth method under the managed helper; OpenCode's login is never invoked; `integration.connect` denied) | `m1-acp-*.json`, `m0-local.json` P1, P2 |
| No vendor host | **pass locally, partial on stage** (with the profiles only the proxy's host, plus the agent's own WebFetch; stage-side egress log is SPI-1041) | `m0-local.json` P3 |
| Every mode fails closed | **pass** (approval-required asks file-change and command; auto-accept-edits asks the command only; full-access nothing; plan edits nothing; drift and `auto`/bypass refused; a hostile repository changed nothing on stage) | `m2-modes.json`, `m3-modes.json`, `m5-hostile-*.json`, `test/acpAdapter.test.ts` |
| Nothing on synced disk (as far as 4a's scan sees) | **pass** (leak scan 0 hits; a canary in the Environment DO's `process.env` reached no process; no key fragment in the synced sessions) | `m5-leak.json`, `m1-image.json`, `m0-local.json` P5 |
| The owner's desktop app (M5): a Claude and an OpenCode turn with an approval each | **pass** (T3 Code Nightly on this Mac, driven by agent-desktop; Claude's edit approved, OpenCode's edit and `bash test.sh` approved, both passed). A third CLI in a full Workspace fails with no reason shown (SPI-1049) | `m5-desktop-*.png` |
| Resume after Container sleep (in scope, not exit) | **pass** (`session/load` succeeded on a new process for both, same native id, no handoff, F8) | `m4-resume.json` |

## Review findings (Fable) and their verdicts

All ten were checked against the code at the pin and the shipped CLIs before building (plan changelog); none was
rebutted.

- **F1** confirmed (`extractProposedPlanMarkdown` runs only in `bufferPostSettleWake`; t3's accept picks
  `exit-plan-default`, P4). Built: capture at the request, deny it. Found on stage: on ACP v2 the denial ends Claude's
  turn with an error-shaped idle; the guard reports it as `end_turn` when it captured a plan, so the plan turn
  completes (SPI-1047 for a recorded v2 fixture).
- **F2** confirmed (`RuntimePolicy` has no `sandboxPolicy`; `case undefined` allowed every edit). Built; P6's realpath
  item dropped.
- **F3** confirmed in the 2.1.322 binary (`allowedProviders`, "honored only when the env block of managed settings pins
  the same value"). Built; every variable planted in the hostile repo, locally and on stage.
- **F4** confirmed (`auto` default without managed `defaultMode`). The drift guard sits in the flavor's runtime wrapper
  rather than `onSessionConfigurationUpdate`, which cannot end a session (it returns `void` and has no session); the
  wrapper sees the same updates first. The downgrade and `exit-plan-default` are pinned by tests.
- **F5** confirmed; built; the agent with `permissionMode` was not loaded and the skill's `!` block did not run.
- **F6** confirmed; built. The config-warning check is a launcher watcher on OpenCode's log (warnings never reach
  stderr under `opencode acp`, P2) plus the schema test; the key hook is `ctx.provider.transform`, no relay.
- **F7** confirmed; `/goal` reaches Claude, which declines it under managed hooks; `/compact` works but the worker is
  not started.
- **F8** followed (resume proof from `acp-request` log lines). **F9**: 429 mapping built and unit-tested (not
  triggered on stage); P8 spent on `session/fork`, recorded on SPI-1037. **F10**: D1 falls back to 4a's refusal
  (SPI-1040); leak check asserts names and no canary; the nonce is bounded by grants; free disk recorded (`m1-image.json`).

## Findings worth keeping

- **Claude Code's env scrub is unusable here**: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (2.1.322) isolates each Bash
  command with bubblewrap and leaves empty decoy files (`package.json`, `.gitmodules`, `.env*`) in the repository. Off;
  the nonce lives in the process's home instead (P1).
- **Claude offers "always" options even with managed-only rules** (`allow-with-updates`, `allow-skill-exact`): the card
  must never offer "for the session".
- **OpenCode's `always` is durable** (saved in `opencode.db`'s `permission` table); the synced snapshot is sanitised on
  copy-in, since it is agent-writable.
- **`opencode acp` runs a private `serve` child**; any other subcommand starts a background service that outlives it.
- **Gemini 3.x is refused by Commissary's upstream** for every client on 2026-11-12 (402, 403, 410); not a CLI issue.
- **Admin routes are not requests in flight** for the idle reset; a long admin call is cut at 60 s (acp-check counts
  itself). A `Stream.run` into a channel handle's stdin ends stdin by default.

## Deviations from the plan

- **P4 in two halves**: the CLI half in local Docker (`p4-claude.sh`, `p4-opencode.sh`), the t3-adapter half as Node
  tests with a scripted agent that answers in M0's recorded shapes (`test/acpAdapter.test.ts`), not recorded replay
  transcripts. The ACP v2 plan path is proved on stage only (SPI-1047).
- **No `test:docker` for these CLIs** (SPI-1044); M0's probes and the stage cover them. **No `m2-latency.json`**
  (SPI-1046). **No stage egress log** (SPI-1041). **No linked push demo**: D1 refuses, as 4a (SPI-1040).
- **M4's restart mid-turn was rerun after the rebase** (`restart-turn`, as 4a's SPI-1043 case) for both CLIs: the old
  process tree was killed mid-turn (Claude 5 markers to 0 in 6.6 s, OpenCode 9 to 0 in 6.2 s), t3's restart
  continuation completed the cut run, and a fourth turn returned the expected answer (`OSPREY-17`) (`m4-restart-claude.json`,
  `m4-restart-opencode.json`). The Workspace DO abort mid-turn was not run for these CLIs.
- **The desktop demo was driven by the agent** (agent-desktop, owner pre-approved, as in step 3), not by the owner.
  The bump workflow dispatch was not done (owner action; the flags ran on `step4b`).
- **Thinking**: the snapshot offers the agents' own `effort` option (both CLIs name it so), not t3's `thinking`.
- `bun run check` passed; on its first run 4a's `killScript.test.ts` timed out once (unchanged by 4b; passes alone and
  on the rerun).

## Counts (ADR-0001)

Shadows 2, Patches 3, unchanged; no new Build shim. New fragility entries U33–U36.

## Tickets

- SPI-1044: `test:docker` runs Claude Code and OpenCode. SPI-1045: OpenCode re-asks the key after a 401.
  SPI-1046: approval round-trip latency. SPI-1047: Claude's ACP v2 plan-turn replay fixture. SPI-1049: a Workspace's
  CLI-process cap refusal reaches the user as a bare "provider session failed to open".
- Comments: SPI-1037 (P8 `session/fork` findings), SPI-1040 (linked pushes from these CLIs are refused too),
  SPI-1041 (egress, local proof).

## Owner actions

- `COMMISSARY_CONTAINER_API_KEY`'s scope must keep allowing the Messages API for every catalog model (4b uses it as pi does).

## Code review (vs `origin/step-4a` 5f232cc, two axes)

Run by the implementer on each axis separately (no sub-agents were available), over the 39 non-doc files of the diff,
weighted to the flavor, the profiles, the launchers and the guard.

### Standards (AGENTS.md, ADR-0001, ADR-0019, smell baseline)

- Fixed: `acpProfiles.ts` restated `CLI_HOMES`; it now imports it from `@t3flare/sandbox-image/process`. `CLI_BIN`
  stays restated (`cliProfiles.ts` imports this module; a value import back would be a cycle), with a comment.
- Fixed: `acp-check` left its canary in the Environment DO's `process.env` if the spawn failed; it is now cleared in a
  `finally` around the whole check.
- Judgement call, kept (Duplicated Code): `acpCheck.ts` repeats `processCheck.ts`'s stdin queue; the test's runtime
  spawn repeats `acpDriver.ts`'s option stripping. Both are stage or test harness.
- Judgement call, kept: `guardSlots` is module state (4a F6 warns about module maps); it is a `WeakMap` keyed by
  runtime objects, so nothing outlives the runtimes it describes.
- t3code untouched; Layer only (no new Shadow or Patch); Vitest on Node; `bun run check` passes.

### Spec (plan + changelog F1–F10)

- Met: the restated exit (table above), F1–F10 (verdicts above).
- Partial, ticketed: stage egress (SPI-1041), `test:docker` (SPI-1044), approval latency (SPI-1046), v2 plan fixture
  (SPI-1047), D1 asks (SPI-1040, refusal fallback in place). Not run: Workspace DO abort mid-turn, bump dispatch.
  (M4's restart evidence and the desktop demo were completed after the rebase.)
- Scope beyond the plan: the CLI weight in 4a's process host (the plan's §6 weight, built in 4a's file), the ACP
  lifecycle log line, the plan-turn end rewrite (forced by v2's idle after the denial).

Standards: 2 fixed, 2 judgement calls kept (worst: duplicated harness code). Spec: 0 wrong implementations found,
5 ticketed gaps and 2 unrun cases (worst: no stage-side egress proof).

## Desktop demo (M5)

The agent drove T3 Code (Nightly) on this Mac through agent-desktop, with the owner's prior approval, against a
`step4b` environment entry added for the demo and removed afterwards. The prod entry was not touched.

- `m5-desktop-1-environment-added.png`: the `step4b` entry beside prod, connected.
- `m5-desktop-2-claude-approval.png`, `m5-desktop-3-claude-done.png`: Claude Code (Haiku 5.5, Supervised) asks before
  its edit to `src/greeting.txt`. After Allow once, `bash test.sh` passes and the diff shows +1.
- `m5-desktop-4-opencode-approval.png`, `m5-desktop-5-opencode-command-approval.png`, `m5-desktop-6-opencode-done.png`:
  OpenCode in the same Workspace asks for the edit, then for `bash test.sh`. Both are allowed once, the test passes and
  the diff shows +1.
- `m5-desktop-7-third-cli-refused.png`: a third CLI thread in that Workspace, opened while the Claude and OpenCode
  processes were alive, fails with only "Provider session failed to open".

The first OpenCode attempt, the previous night, failed the same way. The desktop Claude turn and the M4 restart test's
processes were still alive in that Workspace, so OpenCode's weight 2 would have exceeded the cap of 4. The same send in
the same thread succeeded hours later, once those processes had exited. The third-thread case above reproduced it on
purpose. The cap works as designed, but its named reason ("this Workspace already runs N CLI agent processes…") is lost
before t3's session-open error reaches the user, who sees a bare session id and a Failed thread (SPI-1049). This is
inferred from the cap's code path and the timing. No server log was read.

## Rebase onto `main` (4a landed)

Rebased from `origin/step-4a` 5f232cc onto `origin/main` 051a02d. 4b's changes to lines that main also holds:
- `stage.ts`: `step4a` and `step4b` in `STAGES`.
- `README.md`: the status line.
- `docs/upstream-fragility.md`: 4b's entries are now **U33–U36**, after main's U28 and 4a's U29–U32.

Counts unchanged (Shadows 2, Patches 3).

Checked on a fresh `step4b` deploy of the rebased branch, which was then destroyed:
- `bun run check` passes. At the final commit it failed once, while the stage destroy ran alongside it: two 5 s
  timeouts in `killScript.test.ts` and `worktreeScripts.test.ts`, which 4b does not change. It passed on the rerun.
- `connect refusals` passes: every relay route gets 404 at the door and is refused inside t3
  (`rebase-connect-refusals.json`).
- `acceptance --real-turn --peer --claude --opencode` passes with no failures: the real turn, the reboot check, `--peer`
  with F11 armed and disarmed, and Claude's and OpenCode's turn, plan and leak checks (`rebase-acceptance.json`).
- M4's restart mid-turn for both CLIs (`m4-restart-*.json`, under Deviations).

## Branch

`step-4b`, rebased on `origin/main` 051a02d and force-pushed; the head is this commit. Not merged.
