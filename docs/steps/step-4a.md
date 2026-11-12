# Step 4a: report (CLI agents over stdio: Codex and the pi CLI)

Plan: [`step-4a-plan.md`](step-4a-plan.md) (its changelog carries the owner's confirmation and Fable's review, F1–F10).
Evidence: [`step-4a/`](step-4a/) (one JSON file per proof, named below). Stage: `step4a`, destroyed after the report (`stage.ts destroy step4a`: 6 resources deleted).
Branch `step-4a`; nothing reached `main`.

## Result

Codex (t3's Codex driver, `codex app-server` 0.167.2) and the pi CLI (t3's Pi driver, `pi --mode rpc` 1.5.2) run in a
Workspace's Container over a new **process channel**, on proxy models only, with the model key handed out per request
by a nonce-gated **key helper** (ADR-0016 A′). The exit criterion passes on `step4a`, with one claim narrowed (below).

## Exit criterion

> A Codex turn and a Pi turn, each on a model the proxy serves, run at the same time in two Workspaces' Containers,
> and each resumes its own conversation after its Container slept. Neither CLI holds a vendor credential or calls a
> vendor host, and no credential is ever on synced disk.

| Clause | Verdict | Evidence |
| --- | --- | --- |
| Codex turn on a proxy model | PASS | `m3-codex-turn.json` (gpt-6-luna, tool turn, approval-required: 3 asks), `m6-acceptance.json` `codex` |
| Pi turn on a proxy model | PASS | `m4-pi-turn.json` (claude-haiku-5-5, 2 asks), `m4-pi-nonclaude.json` (gemini, full access), `m6-acceptance.json` `pi` |
| At the same time, two Containers | PASS | `m5-two-at-once.json`: both turns overlap, `ContainerBudget` shows 2 leases (`cli-codex`, `cli-pi`) at once |
| Each resumes after its Container slept | PASS | `m5-resume-codex.json`, `m5-resume-pi.json`: Container `running:false, leased:false` between turns; the second turn is `thread/resume` of the same Codex thread id / `switch_session` to the same pi session file (protocol log), no handoff |
| No vendor credential | PASS | No vendor login exists in either profile; the only key is the proxy's (`cliProfiles.ts`, `m2-image.json` `keyRoute`) |
| Calls no vendor host | PASS, locally | `m6-egress.json`: on an `--internal` Docker network with a CONNECT-logging proxy and logging resolver, the t3flare profiles reach only the proxy host (defaults would reach github.com, chatgpt.com, pi.dev). Not re-proved on the stage (no egress logger in the image; SPI-1041) |
| No credential on synced disk | PASS, narrowed | `m6-leak.json`: baseline clean in both Workspaces (DO files and Container); a deliberate leak was caught by the scan before the pull, quarantined, never synced. Claim reads "as far as the in-Container scan before each pull can see" (F3); computerd's own `state.db` on Container disk keeps the bytes (SPI-1042) |

The fourth-start clause ("a fourth start is refused with the budget's reason") changed with F7: when the budget is
full, idle CLI holders are asked to release first (`m5-reclaim.json`, `m5-holds.json`); refusal happens only when no
holder is idle.

## Review findings (Fable, F1–F10)

| # | Verdict | What was done, and the evidence |
| --- | --- | --- |
| F1 | Confirmed, fixed | The wrapper reports `supportsMultipleProviderThreadsPerSession: false` in `getCapabilities()` and on the session entity (`provider/cli/wrapper.ts`); a fork into another Workspace is refused. `m5-f1-two-codex.json`: two Codex threads in two Workspaces open two processes, one per Container |
| F2 | Confirmed, fixed | CLI homes are built fresh on Container-local disk at each spawn; only `sessions/` is synced (`agents/cliProfiles.ts`). pi: local `PI_CODING_AGENT_DIR`, synced `PI_CODING_AGENT_SESSION_DIR`, `--no-approve`, `defaultProjectTrust: never`, sessions pruned after `PI_SESSION_RETENTION_DAYS` |
| F3 | Confirmed, fixed, with a new finding | The in-Container scan runs on changed files before every pull (turn end, exec end, `workspace.pull`); a hit quarantines, kills the Workspace's CLIs and flags the key (`sandbox-image/src/leakscan.ts`, `m6-leak.json`). `ulimit -c 0` in the launcher (`sandbox-image/src/process.ts`). P8 confirmed the rescan cost (+1 MB on a 50 MB rollout: 95 ms DO CPU; `m0-p8.json`). New: computerd's `state.db` keeps the bytes of a leaked file (Container disk, never synced; SPI-1042) |
| F4 | Nonce: confirmed, fixed. "Once": rebutted | Codex gets `shell_environment_policy.exclude=["T3FLARE_MODEL_KEY_NONCE"]`. M0 measured Codex asking twice as it starts (then caching across turns), so a grant cap of 1 breaks it: `CODEX_KEY_GRANTS = 3` (2 + one 401 re-ask; `workspace/modelKey.ts`, `m0-local.json`). pi asks per request; its nonce is uncounted (the A′ residual, plan §4.9) |
| F5 | Confirmed, amended | The guard is an allowlist of methods and thread config keys; `feedback/*` and `account/*` are refused with reasons (`provider/cli/codexGuard.ts`). Codex 0.167.2 refuses a process-level `approval_policy="untrusted"` (M0), so the process starts `on-request` + `read-only` and the guard sets `untrusted` per turn from the mode table. bwrap is probed at each Container start; it works on Cloudflare (`m0-p2.json`) |
| F6 | Confirmed; design changed | Byte frames end to end, one `processInput` in flight with contiguous `seq`, bounded queues, durable boot-counter epoch, registries on the DO instance (reboot check: `m6-acceptance.json` `rebootCheck`). The push model (Workspace → `processOutput`) hit "Subrequest depth limit exceeded" by round trip 8 on the stage (M1): output is now **pulled** (the Environment long-polls `processRead` with an ack, which is also the heartbeat). Recorded in ADR-0015's refinement |
| F7 | Confirmed, decided in M1 | A CLI session holds its Container while in a turn and for 11 min after (t3's idle reset, Patch 0003, is 10 min); a full budget asks idle holders to release (`m5-holds.json`, `m5-reclaim.json`). P9: Codex app-server RSS ~160 MB idle → `MAX_CLI_PROCESSES = 4` per Workspace (`m3-memory.json`) |
| F8 | Confirmed; narrowed | Linked work is held under `cli:<thread>` while the process lives. While it is held, a linked CLI's `git push` is **refused** rather than asked on its thread (ask-on-thread for CLIs is SPI-1040). Deviation from M6's demo |
| F9 | Accepted | P12 and P8's gate ran (`m0-p8.json`; F1 case in M5). Resume is proved by the protocol log, not a code word. P11: t3 restarts pi on a mode change (verified). Docker egress proof on an internal network with a logging resolver (`m6-egress.json`) |
| F10 | Done | `docs/parity.md` records the withheld MCP tools (SPI-1039 brings them back); the Pi wrapper drops the "t3-code MCP unavailable" notice |

## Milestones

| Milestone | Result | Evidence |
| --- | --- | --- |
| M0 probes | PASS. Codex and pi on proxy models with tool turns (P3); bwrap works in the Container (P2); SQLite on the FUSE mount and pull CPU under the gate (P8); a 35-min non-PTY exec and the DO abort (P1); resume from a fresh home and a torn last line (both CLIs) | `m0-local.json`, `m0-p1.json`, `m0-p1-abort.json`, `m0-p2.json`, `m0-p8.json` |
| M1 process channel | PASS. 200 round trips p50 46 / p95 64 ms, 4 MiB each way, TERM-ignoring child killed; Environment restart ends the old epoch's processes | `m1-channel.json`, `m1-restart.json` |
| M2 image, profiles, key | PASS. Image +~490 MB (Codex 320 MB, pi 170 MB); key route 403 without a CLI, p95 26 ms from the Container | `m2-image.json` |
| M3 Codex in t3 | PASS. Full access, approval-required (3 asks), plan (`proposed_plan`, no edit) | `m3-codex-turn.json`, `m3-codex-first.json`, `m3-codex-plan.json`, `m3-memory.json` |
| M4 Pi in t3 | PASS, plan refused. Claude (2 asks) and Gemini turns; pi has no plan mode, so a plan turn is refused | `m4-pi-turn.json`, `m4-pi-nonclaude.json`, `m4-pi-plan.json` |
| M5 lifetime, resume, two Containers | PASS | `m5-two-at-once.json`, `m5-resume-codex.json`, `m5-resume-pi.json`, `m5-f1-two-codex.json`, `m5-holds.json`, `m5-reclaim.json` |
| M6 proofs, acceptance, docs | PASS with gaps (below) | `m6-acceptance.json` (`--codex --pi`), `m6-leak.json`, `m6-leak-turn.json`, `m6-egress.json` |

## Deviations from the plan

- **Output is pulled, not pushed** (plan §2.4): the push model exceeded Workers' subrequest depth (F6 row).
- **Linked CLI pushes are refused**, not asked on the thread (F8 row; SPI-1040). No `m6-linked-push.json`.
- **pi's plan mode is refused** with t3's generic turn-start error, not a t3flare-worded message in the UI.
- **Egress is proved locally only** (`m6-egress.json`); the stage-side egress log and an allowlist are SPI-1041.
- **Not done**: the owner's desktop demo (`m6-desktop-*.png`), the bump job's run with the new flags, `acceptance.ts
  --real-turn --peer` together with `--codex --pi`, and M5's Environment-restart-mid-turn cases (SPI-1043).
- **Observed, unchanged**: the Environment's 60 s idle reset ends CLI sessions through the heartbeat lapse; a deploy
  restarts the Containers. Both end the process; the next turn resumes natively.

## Counts (ADR-0001)

Shadows: 2 (`shadows/processGroup.ts`, `shadows/builtInDrivers.ts` registering Codex and Pi through the wrapper).
Patches: 3 (0003 is new: `provider-session-idle-10-minutes`). Upstream fragility entries U28–U31 added.

## Tickets

- SPI-1039: t3's MCP tools for CLI agents (OD-3, after 4b).
- SPI-1040: linked CLI pushes ask on their thread (D1 for CLIs).
- SPI-1041: egress allowlist and the stage-side egress proof.
- SPI-1042: computerd's `state.db` keeps the bytes of a quarantined file.
- SPI-1043: the desktop demo, the bump job's new flags, M5's restart cases.

## Owner action: rotate the key

M6's deliberate leak ran the key helper inside a stage Container and wrote `COMMISSARY_CONTAINER_API_KEY` to that
Container's disk (quarantined, never synced; gone with the stage). It is the same key as in `dev.env` and the `prod` and
`bump` GitHub environments. Rotate it (`docs/model-proxy.md`).

## Code review (vs `origin/main`, two axes)

Run by the implementer on both axes separately (no sub-agents were available to this run), over the 54 non-doc files
of the diff, weighted to the process channel, the key route, the Codex guard and the wrapper.

### Standards (AGENTS.md, ADR-0001, ADR-0019, smell baseline)

- Fixed, hard: the image's Node path (`/usr/local/share/mise/installs/node/26.13.0`) was named in four places
  (`mise.toml`, the Dockerfile's `npm ci`, `t3flare-pi`, `leakscan.ts` `IMAGE_NODE`) with nothing keeping them equal; a
  Node bump in `mise.toml` would have broken pi and the leak scan silently. `cliManifest.test.ts` now checks all four.
- Fixed: the Dockerfile and `clis.ts` cited a test that does not exist (`test/clis.test.ts`); they now cite
  `apps/environment/test/cliManifest.test.ts`.
- Judgement call, kept: `probeProcess` (a DO abort) stays as a stage-only fault route behind `T3FLARE_FAULTS`, which
  prod never sets; `scripts/cli4a.ts` and `scripts/probe4a.ts` stay as the scripts that reproduce the evidence.
- Judgement call, kept: `WorkspaceDO.ts` grows again (Divergent Change); the process logic itself lives in
  `processHost.ts`, `modelKey.ts` and `leakscan.ts`, and the DO only routes.
- t3code untouched; the change goes Layer → Shadow (2) → Patch (1 new, one line); `bun run check` passes.

### Spec (plan + changelog F1–F10)

- Fixed: a `startTurn` that failed left the session's turn marked active, so the Container hold and the 2 h cap fiber
  stayed until the process died (no `turn.terminal` follows a turn that never started). The wrapper now ends the turn
  on failure (`Effect.onError`).
- Partial, ticketed: D1 for CLIs refuses rather than asks (SPI-1040); stage egress log (SPI-1041); desktop demo, bump
  flags and M5 restart cases (SPI-1043); the "no Container-only path holds the key" claim fails after a leak
  (SPI-1042).
- Scope beyond the plan: the pull-model channel (forced by the platform, F6) and the budget's reclaim of idle CLI
  holders (F7's design).

Standards: 2 fixed, 2 judgement calls kept (worst: the unchecked Node path). Spec: 1 fixed, 4 ticketed gaps (worst:
linked CLI pushes refused instead of asked).
