# Step 3: report (Peer links: the laptop delegates to the cloud; t3's MCP tools in Sessions)

Date: 2026-11-11. Branch `step-3`, rebased on `main` at b75fa52 (which includes `modefix`, 65a90ac). t3code pinned at
`v0.1.9-nightly.20261111.4515`. Plan: [`step-3-plan.md`](step-3-plan.md), with the owner's D1 and the independent
review (Fable, C1–C10) folded in as its changelog. Evidence: `docs/steps/step-3/`. Throwaway stage `step3`, destroyed
at the end; prod was never deployed, run against or linked.

## Exit criteria (`docs/plan.md`, row 3)

| Criterion | Result | Evidence |
|---|---|---|
| A laptop agent delegates to the cloud | **Pass** | Stock `t3` from npm (pin and the desktop's nightly) with t3's Pi agent on the proxy calls `delegate_task` to the cloud's Durable agent (`m4-e2e-pinned.json`, `m4-e2e-desktop-version.json`); the owner's desktop app with a Claude Haiku agent did the same (`m5-desktop-4…8`) |
| …follows the task and gets the result | **Pass** | The laptop task carries `remoteChild`, completes with the child's nonce, and the parent wakes with it; also after a laptop restart, a cloud restart mid-`bash`, and a cloud restart while the child's question waits (`m4-*.json`); cancel and revocation end the task with their reason |
| The cloud child can report | **Pass** | Its final reply is the task's result; progress is readable over the link (`t3_thread_read`, `t3_thread_wait` in 50 s pieces) and live in the desktop (`m5-desktop-7`) |
| …and ask | **Pass** | `ask_user` → a t3 `user_input` request, answered from the laptop side over the link (`t3_pending_request`, `m4-e2e-*`), by the owner in the desktop (`m5-desktop-5`), by an MCP client (`m3-…mcp…`), across Session restarts and Environment restarts (`m3-*`, `m4-question-restart.json`) |
| The link fence holds | **Pass** | F1–F13 at the MCP level and from inside Sessions (`m1-acceptance-peer.json`, `m2-stage.json`); modes fail closed and plan is read-only (F5, F6); pushes from linked work ask every time (`m3-push.json`); 0 secrets found in the Container or Session state (`m2-stage.json`, `m4-e2e-pinned.json`) |

After the final rebase on `main`, the stage was deployed again and re-proved: `final-rebased-peer.json` (launch, F5, F1,
F11) and `final-rebased-e2e.json` (the two-server delegation): all pass.

## What was built

### The link (M0, M1; ADR-0011, ADR-0010)

t3's own link, unchanged on the laptop. The cloud needed no route, Shadow or Patch:

- **L1** seeds Linked environments on once per Environment (a DO-storage mark; the owner can turn it off and it stays off).
- **L2** adds `/oauth/mcp/decision` to the bootstrap refusal (parses `decision.code`).
- **L3** pins agent browser access off (no `preview_*`).
- **F-modes** (landed on `main` as `modefix`, reused here): `auto` and unknown runtime modes run as approval-required.
- **F-plan**: `interactionMode` reaches the Session with every turn; in `plan` the Session adds t3's plan-mode
  instruction, refuses `edit`/`write` and non-read-only T3 tools, and asks for every `bash` (even in full access or
  after "accept for the session"); an unknown interaction mode runs as plan.

### t3's MCP tools in Sessions (M2; ADR-0022)

- The adapter reads t3's per-thread credential (`McpProviderSessions`) at open and every turn and sends it with the
  command; the Session keeps it in DO storage only.
- `EnvironmentDO.mcp` hands the Session's request to t3's HTTP app (no public host); it boots t3 from the stored host
  and waits for `commandReady` (C7).
- The `t3-mcp` extension: a fail-closed allowlist (41 tools), t3's names, approvals as t3's Pi bridge decides with a new
  `mcp-tool` approval kind accepted per tool name (C4), `clientRequestId` from the task id, refusal of a rerun under a
  re-issued credential (C9), waits in 50 s pieces (C9), t3's orchestration instructions as a section, reinstalled when
  the catalog's hash changes. The differ shows T3 tool calls as t3 shows its Pi provider's, and their approvals as
  `permission` requests. `supportsMcpTools: true`.

### Asking (M3)

`ask_user` (one question, optional choices, free text unless only choices): a durable wait shared with approvals
(`WaitingRequests`), pushed as `questions`, opened by the differ as t3's `user_input` request in `piQuestion`'s shape,
answered through the adapter (`answers`). `supportsStructuredQuestions: true`. A Stop withdraws it.

**Review C2 fix**: after a boot, the Environment DO raises a delegated thread's question that an Environment restart
cut again, in a continuation of the cut run, and dismisses the stale request; `/mcp` waits for it
(`agents/questionRestart.ts`; ADR-0004's refinement).

### Pushes from linked work (owner decision D1; review C3; ADR-0013's refinement)

A linked Session notes linked work in its Workspace before each command; while it is active the credential helper
reports git's operation; a fetch gets a read-only token, anything else asks the owner on the linked thread for that push
alone (`git-push` approval kind, never accepted for the session). Residual risk accepted by root: an approved push's
write token could be captured and reused for up to an hour; tracked by the high-priority Linear ticket "Link-started
pushes: keep the write token out of the Container".

### Test harness and acceptance (M1, M4, M5)

- `scripts/lib/peer.ts` (the laptop's OAuth and MCP client in TypeScript), `lib/laptop.ts` (a stock npm `t3` server
  headless), `lib/laptopAgent.ts` (its Pi agent on the proxy, key never written).
- `acceptance.ts --peer` (`lib/peerAcceptance.ts`): the link, the cap, a forwarded launch, F1, F2, F4–F7, F9–F12, F11.
- `scripts/peer-e2e.ts` (two servers, six variants), `peer-m2.ts`, `peer-m3.ts`, `peer-idle.ts`, `peer-laptop.ts`.
- The bump job runs `--peer` and a stock `npx t3@<npm nightly>` link plus forwarded launch (C6).
- Admin routes: `POST /_t3flare/check/peer-leak` (secret names found, never values) and
  `GET /_t3flare/agents/session-tools`.

## M0, the facts

| Probe | Outcome | Evidence |
|---|---|---|
| R1 MCP in workerd | t3's `/mcp` answers JSON with `mcp-session-id`; 71 tools; 404 after an admin restart, then re-initialisation works; 403 with Linked environments off; a 50 s `t3_thread_wait` is held (49.96 s, `m1-acceptance-peer.json`) | `m0-mcp.json` |
| R2 the laptop server | `npx t3@0.1.9-nightly.20261111.4515 serve` headless; `t3 environment link … --access auto-accept-edits` reachable | `m0-laptop-link.json` |
| R3 version skew | the same with `0.1.10-nightly.20261111.4529` (the desktop's), forwarded launch, wait and read decode; rerun before M5 against the npm nightly (same version) | `m0-skew.json`, `m5-skew.json` |
| R4 repository identity | `github.com/ian-pascoe/t3flare-fixture` on both sides | `m0-laptop-link.json` |
| R5 re-installing an extension | pi-durable's `Registry.install` replaces an extension in place (its API); the Session reinstalls `t3-mcp` on a changed hash and before resuming work | see Deviations |
| R6 the laptop agent | t3's Pi provider on the proxy calls `mcp__t3-code__orchestrator_capabilities` | `m0-laptop-agent.json` |

No stop gate failed.

## Review findings (Fable), adopted or rebutted

| # | Verdict | Evidence |
|---|---|---|
| C1 modes before links | **Adopted.** Verified: `mcpClientScopes` gives `auto` and `auto-accept-edits` the same scopes, and the old adapter mapped `auto` to full access. Mitigated already at MCP launch (our driver's `supportedRuntimeModes` lacks `auto`, so t3 refuses an explicit `auto` launch), but the mapping is fixed: `modefix` landed it on `main`, F-plan followed, both before L1 (commit order) | `runtimeMode.test.ts`, F5, F6 |
| C2 `ask_user` across an Environment restart | **Adopted, refined.** Verified: t3 turns the pending question into a message-answerable one, cancels the run, starts no continuation. Owner threads are fine (answering starts a new run); delegated threads get the question raised again in a continuation of the cut run | `m3-env-restart*.json`, `m4-question-restart.json` |
| C3 D1 where pushes happen | **Adopted** at the credential helper's token route, with a read-only token for fetches; residual risk accepted (above) | `m3-push.json`, `linkedPush.test.ts` |
| C4 per-tool approvals | **Adopted** (`mcp-tool`, keyed by tool name; `git-push`, never accepted) | `permissions.test.ts`, `t3Mcp.test.ts`, `m2-stage.json` |
| C5 G2 is not an issue | **Adopted in part, rebutted in part.** Verified: t3 refuses a non-one-time grant (our bootstrap is `desktop-bootstrap`) without spending it; L2 kept as defence in depth, R11 dropped, F11 checks both answers. **Rebutted:** "the harness must mint codes with `access`": t3 refuses an access-bound code for a link ("Linking needs a plain pairing code, not an app approval code", `McpOAuth.approve`). The cap is a plain code's `scopes`: read+operate alone cannot sign a full-access link and is not spent | `m0-mcp.json`, `m1-acceptance-peer.json` (`cap`, `F11`) |
| C6 version skew | **Adopted** (bump job; R3 rerun) | `scripts/bump.ts`, `m5-skew.json` |
| C7 `EnvironmentDO.mcp` without a synthetic request | **Adopted** | `environmentDO.ts` |
| C8 credential out of state | **Adopted**; the leak check reads snapshots, diagnostics and the tool list too: 0 found | `m2-stage.json` |
| C9 `clientRequestId` vs re-issue; 50 s waits | **Adopted**; a rerun under a re-issued credential is refused rather than repeated | `t3Mcp.test.ts` |
| C10 F3 in M2, F7 in M3 | **Adopted** (F7 also already in M1's acceptance) | `m2-stage.json`, `m1-acceptance-peer.json` |

## Deviations from the plan

- **"An approval-required thread asks before `delegate_task` and not before `t3_thread_read`"**: t3 annotates
  `t3_thread_read` (and `task_status`, `t3_background_wait`) as not read-only, so following t3's Pi bridge they ask. The
  M2 exit used `t3_thread_list` and `orchestrator_capabilities` (read-only) for "no ask".
- **No workerd test of the Session with `t3-mcp`, and no faux-Harness reinstall test (R5).** Both were covered on the
  deployed stage instead (every Session bundles, loads and reinstalls the extension), and the API contract settles R5.
- **`t3_environment_preferences_update` is not offered** in the allowlist (the plan's list did not include it); F13 used
  `t3_project_create` for the owner's environment-changing call.
- **F6's `write`**: the model obeyed the plan instruction and never tried it; the refusal itself is proven in unit tests.
- **The plan's "harness mints codes with `access`"** (C5) does not hold for links; see the review table.
- **D1's "repo whose main push would deploy"**: per root's choice (b), proved on the fixture's `main` (no new repo):
  the gate stands before any push reaches GitHub, whatever a push to `main` triggers.
- **Desktop (A1)**: root allowed driving the owner's desktop directly (agent-desktop). Two traps found: both
  environments are named "t3flare" in the link picker, so the link used "Another address…" with the step3 URL; and the
  Linked environments section belongs to each environment that offers links, so Labs → Linked environments was turned
  on for "Ian's MacBook" alone (scope picker), never "All environments". A first link attempt ran from step3's own
  section and was refused by t3 as "That address is this environment"; nothing was created.

## Tests

| Kind | What |
|---|---|
| Unit / Node (faux Harness) | `permissions.test.ts` (plan mode, per-tool acceptance, pushes never accepted), `t3Mcp.test.ts` (catalog, names, approvals, replay, re-issue refusal, 401, 50 s pieces, instructions), `t3McpClient.test.ts`, `askUser.test.ts` (durable through restarts), `linkedPush.test.ts`, `differ.test.ts` (MCP items, permission and question requests), `seedSettings.test.ts`, `host.test.ts` (L2), `runtimeMode.test.ts` (interaction modes) |
| Deployed acceptance | `acceptance.ts --peer` (also nightly in the bump job) |
| Deployed, scripted | `peer-m2.ts`, `peer-m3.ts`, `peer-e2e.ts` (six variants), `peer-idle.ts`, `peer-laptop.ts` |
| Owner's desktop | the demo, `m5-desktop-*.png` |

`bun run check` passes at the branch head.

## Counts

Patches **2**, Shadows **1** (its driver env now also names `McpProviderSessions`), Build shims unchanged. New Layers:
**2** (L1 Linked environments seed, L3 browser access pin). Everything else is our own code.

## ADRs, glossary, upstream

- New **ADR-0022** (Durable agents reach t3's MCP through the Environment DO with t3's own credential).
- Refinements: **ADR-0004** (questions across restarts, C2), **ADR-0010** (`/oauth/mcp/decision`, links and the cap),
  **ADR-0011** (as built, the fence, the desktop surfaces a remote question), **ADR-0013** (D1, residual risk, ticket).
- Glossary: **Linked work**, **Link fence**, **Remote task**.
- Upstream ask **A3** drafted as item 11 of [`docs/upstream/t3code-asks.md`](../upstream/t3code-asks.md): wake the
  parent when a remote task's child asks (and, for information, follow a cut run's question).
- R7 settled: the desktop shows the owner a remote child's question on the parent thread ("Subagent needs input · Open
  question"); the parent agent is not woken (the ask).

## Code review (since `origin/main`)

Two axes, reviewed one after the other in separate passes (this agent cannot start sub-agents). Standards sources:
`AGENTS.md`, ADR-0001 (Layer, then Shadow, then Patch), ADR-0016 (no credential in a Container), ADR-0019 (tsrs,
oxlint), `docs/agents/domain.md` (glossary vocabulary), and the smell baseline.

### Standards

- No documented standard is broken: the t3code tree is untouched (Layers only, the one Shadow's type widened), no
  credential reaches a Container (the leak check is part of the evidence), `bun run check` passes, glossary terms are
  used and added.
- Fixed during review: the "live turn" lookup was duplicated four times in `SessionDO` (now `#liveTurn()`); a stray
  blank line and a broken doc comment in `environmentDO.ts`.
- Judgement calls, left: *Divergent Change* — `SessionDO` now also owns the MCP credential, the catalog and push
  approvals (a candidate to split into a `t3Tools` collaborator when step 4 adds more); *Primitive Obsession* — the
  helper's `op` is a bare string (`push`/`fetch`/`unknown`); *Duplicated Code* — the stage scripts each carry their own
  `arg()`/`check()` helpers, as earlier steps' scripts do; `LinkedWork.access` is carried but only `label` is read.

### Spec

- All exit criteria, D1 and C1–C10 are implemented as listed above.
- Partial: the plan's workerd test of the Session with `t3-mcp` and the faux-Harness reinstall test (R5) were replaced
  by stage evidence; the bump job's run does not list the tools the allowlist left out (the stage's
  `session-tools` route and `m2-stage.json` do).
- Beyond the plan (asked by the review or needed for evidence): the C2 re-raise in the Environment DO, the read-only
  token for linked fetches, the `peer-leak` and `session-tools` admin routes, the debug scripts (`sq.ts`,
  `session-tools.ts`, `peer-schemas.ts`, `peer-smoke.ts`, `mint-code.ts`, `ensure-helper.ts`).

Summary: Standards 0 hard findings, 4 judgement calls (worst: `SessionDO` growing); Spec 2 partials (worst: no workerd
test of the extension).

## Risks and notes

- The approved-push token residual (ADR-0013's refinement; ticket filed by root).
- A remote task shares the cloud project's checkout; the D1 test left the stage's fixture checkout on a branch, which
  later tasks ran on (harmless here; the stage is destroyed).
- The `revoked` variant leaves the cloud child waiting on its question until someone stops it (t3's behaviour: the cloud
  does not know the laptop stopped following).
- After the demo, the desktop's sidebar showed "No threads yet" for all projects; the only thread removed was the demo's
  own (the confirmation named one thread on Ian's MacBook). Worth a glance from the owner.

## Evidence index (`docs/steps/step-3/`)

`m0-*.json` (probes), `m1-acceptance-peer.json`, `m1-laptop-forwarded.json`, `m2-stage.json`, `m3-*.json`,
`m4-*.json` (e2e on two versions, cancel, laptop-restart, cloud-restart, question-restart, revoked, idle),
`m5-skew.json`, `m5-desktop-1…8-*.png`, `final-rebased-*.json`.
