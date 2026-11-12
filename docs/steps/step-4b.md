# Step 4b: report (Claude Code and OpenCode over ACP)

Date: 2026-11-12. Branch `step-4b`, rebased on `origin/step-4a` at 5f232cc (4a's report). t3code pinned at
`v0.1.9-nightly.20261111.4515` (24e7747), untouched. Throwaway stage `step4b` (added to `STAGES`), deployed seven times
and **destroyed** at the end. Plan: `docs/steps/step-4b-plan.md`, whose changelog (owner OD-1/OD-2, Fable review
F1–F10) overrides its body. Evidence: `docs/steps/step-4b/` (`m0-local.json`, `m1-*.json`, `m2-*.json`, `m3-*.json`,
`m4-*.json`, `m5-*.json`); M0's probes in `docs/steps/step-4b/probes/`.

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
- **M4's restart case is weak**: the turn finished across an Environment restart, but the run did not show the epoch
  kill (the process was out of its turn by then); 4a's restart cases cover the machinery. The Workspace DO abort
  mid-turn was not run for these CLIs.
- **The owner's desktop demo** and the bump workflow dispatch were not done (owner action; the flags ran on `step4b`).
- **Thinking**: the snapshot offers the agents' own `effort` option (both CLIs name it so), not t3's `thinking`.
- `bun run check` passed; on its first run 4a's `killScript.test.ts` timed out once (unchanged by 4b; passes alone and
  on the rerun).

## Counts (ADR-0001)

Shadows 2, Patches 3, unchanged; no new Build shim. New fragility entries U32–U35.

## Tickets

- SPI-1044: `test:docker` runs Claude Code and OpenCode. SPI-1045: OpenCode re-asks the key after a 401.
  SPI-1046: approval round-trip latency. SPI-1047: Claude's ACP v2 plan-turn replay fixture.
- Comments: SPI-1037 (P8 `session/fork` findings), SPI-1040 (linked pushes from these CLIs are refused too),
  SPI-1041 (egress, local proof).

## Owner actions

- The desktop demo (a Claude and an OpenCode turn with an approval each) when convenient.
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
  (SPI-1047), D1 asks (SPI-1040, refusal fallback in place). Weak: M4's restart evidence; not run: Workspace DO abort
  mid-turn, desktop demo, bump dispatch.
- Scope beyond the plan: the CLI weight in 4a's process host (the plan's §6 weight, built in 4a's file), the ACP
  lifecycle log line, the plan-turn end rewrite (forced by v2's idle after the denial).

Standards: 2 fixed, 2 judgement calls kept (worst: duplicated harness code). Spec: 0 wrong implementations found,
5 ticketed gaps and 3 unrun cases (worst: no stage-side egress proof).

## Branch

`step-4b` at 7b06082 (this commit's parent; pushed, rebased on `origin/step-4a` 5f232cc). Nothing of 4b reaches `main` before 4a has.
