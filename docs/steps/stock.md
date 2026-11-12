# Back to stock: report

Date: 2026-11-12. Branch `stock` from `origin/main` at 0942f79. Plan: `docs/steps/stock-plan.md`. Spec:
`docs/scope-audit.md`, rows 1, 2, 7, 9, 10 and 12. The owner's rule of 2026-11-12: t3flare behaves like stock t3, and
keeps only what the platform forces or what the owner kept (K1–K12). Every removal is recorded as "owner, 2026-11-12,
back to stock" in the ADR, refinement or fragility entry it touches.

## What changed

1. **Pushes (row 1).** The push gateway is gone, and so are its parts:
   - the gateway itself (`pushGateway.ts`) and the `/t3flare/git/` path in `WorkspaceProxy`;
   - Expectations (`pushPlanOf`, the router's `expectOwnPush`, `expectPush`/`unexpectPush`);
   - Taint (`taint`, `trustAgain`, the `workspace-trust` admin route);
   - linked-work tracking, which only fed the gateway (`noteLinkedWork`, `noteOwnerCommand`, the process marker's
     `linked`, the Session's `beforeCommand` hook);
   - push cards on Durable and CLI threads (`pushCard.ts`, `linkedPush.ts`, `SessionDO.approveGitPush`, the Environment
     DO's `approvePush`, and the wrapper's push half);
   - `pushInsteadOf` in the image's system gitconfig, the `PUSH_GATEWAY_*` permissions, `probePush`,
     `scripts/spi992.ts` and its scripts and fixtures.

   The Container token is `contents: write` again (`containerGitHubPermissions`), from the credential helper, scoped
   to the Workspace's one repo. `workflows` comes only with the Workspace's opt-in (K7). The helper still answers only
   https and github.com.

   The wrapper's card injection stays for the MCP relay's tool cards. `linkedPushAsk.ts` became `cliAsk.ts`, with the
   id prefix `t3flare-ask`.
2. **D5 lifted (row 12).**
   - `textGenerators` is no longer locked.
   - `cloudVoiceTranscription` is advertised. It is not host-bound: t3's `CloudSpeech` calls the vendor over fetch.
   - `request_secret` is offered to Durable agents. Its `delivery: "file"` mode cannot reach a Container (SPI-1088).
3. **Repository configuration (row 2).**
   - Claude Code honours the project's `.claude/`: the managed `allowManaged*Only`, `allowedMcpServers`,
     `strictKnownMarketplaces`, `disableSkillShellExecution` and `strictPluginOnlyCustomization` are gone.
   - OpenCode honours the project's plugins, MCP servers, skills and agents: its `mcp.use`, `skill.use`, `plugin.use`
     and subagent denies are gone.
   - K5 is kept: fixed environment, fresh homes, `allowedProviders`, `apiKeyHelper`, the redirect variables pinned
     empty, and OpenCode's `provider.use` pin.
4. **Modes (row 9).**
   - Codex `auto` is t3's: `on-request` with `approvalsReviewer: "auto_review"` and `workspaceWrite`.
   - ACP:
     - `auto-accept-edits` allows every edit, with no cwd containment.
     - t3's own card, "for the session" included.
     - An agent that changes its own mode is no longer ended.
     - t3's `auto` selects Claude's own `auto` mode (stock t3's Claude adapter does the same); it falls back to
       `default` if Claude does not offer it.
     - OpenCode asks at `auto`, as stock t3's OpenCode does.
   - Codex, Claude and OpenCode list `auto` again.
   - A plan turn on the Pi CLI runs.
   - `features.multi_agent=false` is dropped: it was in M0 P10's batch for no reason of its own.
   - Kept: the pinned asking mode, plan turns read-only (Claude's `ExitPlanMode` plan captured), and Codex's
     no-sandbox fallback.
5. **Codex request guard (row 10).**
   - The method and thread-config allowlists are gone.
   - Kept:
     - the provider pin: thread params and config keys naming a provider, profile, base URL or policy are dropped;
     - `feedback/*` and `account/*` refused, as a vendor upload and a vendor sign-in (K3);
     - the per-turn policy.
6. **T3 tools (row 7).** `T3_TOOL_ALLOWLIST` became `T3_TOOL_DENYLIST`:
   - `t3_attachment_*` and `t3_thread_send_attachments`;
   - `html_*`, `preview_*` and `t3_preview_*` (no server browser);
   - `device_*`;
   - `t3_worktree_*`;
   - `t3_environment_link` and `unlink`, until SPI-1061 M1.

   The guidance filter drops only what names a denied tool. The classification test is now "every denied name is still
   a t3 tool" (U49). `peerLinks.ts` and its Layers are left to SPI-1061; only a test's import was renamed.

Diff against `origin/main`: 96 files, +829 −3,574.

## Checks on stage `stock` (deployed once, destroyed)

| Check | Result | Evidence (`docs/steps/stock/`) |
|---|---|---|
| `acceptance --real-turn --peer` | **pass** on the third run. Runs 1 and 2, right after the deploy, failed only the real turn's clone ("Network connection lost", then a 120 s timeout): the first Container starts on a new image. `--peer` passed both times | `acceptance-durable-peer.json` |
| `acceptance --codex --pi` | **pass**, leak scans clean | `acceptance-codex-pi.json` |
| `acceptance --claude --opencode` | **pass**, leak scans clean | `acceptance-claude-opencode.json` |
| Durable push, at approval-required and full access | **pass** (2/2): lands on GitHub; one "Allow bash?" card at approval-required (the mode), none at full access, no push card | `push.json` |
| CLI push (Codex), at full access and approval-required | **pass** (2/2): lands; Codex's own command card at approval-required, none at full access | `push.json` |
| Linked thread's push, at a full-access and an approval-required link | **pass** (2/2): lands; no card at full access, the command's own card at approval-required | `linked-push.json` |
| Claude Code with a repo `.claude/settings.json` hook | **pass**: its `UserPromptSubmit` hook wrote its marker | `claude-hook.json` |
| Codex `auto` | **pass** (2/2): an in-Workspace write ran with no card. An escalation (a write to `/var/tmp`) ran with no owner card: Codex said it ran with elevated access, so its reviewer approved through the proxy. t3's items do not show the reviewer's verdict itself | `codex-auto.json` |
| Claude at t3's `auto` (extra) | **pass**: a command ran with no card, so Claude's auto mode was applied (`default` would have asked) | `claude-auto.json` |
| Managed policy | **pass**: `textGenerators` unlocked, `cloudVoiceTranscription` advertised, guest links still locked | `managed-policy.json` |
| Leak scan | **pass**: clean on every CLI and the Durable path. A one-repo write token is in the Container while git asks for it; that is stock behaviour, not a leak. The scan still looks for it in files | the acceptance files' `leak` |
| `bun run check` | **pass** at each milestone and at the end | — |

The test branches (`stock-*`) were deleted from the fixture after each case.

## Decisions taken without the owner (for the owner)

1. **Plan turns stay read-only** on Codex (approval-required plus declined file changes) and ACP (edits and
   `ExitPlanMode` denied). The audit did not list them; they are how the flavors implement t3's plan mode. Stock t3 at
   full access in plan would let Codex edit.
2. **The Pi CLI keeps `defaultProjectTrust: "never"`.** Row 2 names Claude and OpenCode only. Stock t3's pi is
   untrusted by default too; trusting needs `--approve` in the launch arguments, which t3flare ignores.
3. **OpenCode's asking rules stay in its system configuration.** They are the pinned asking mode, as stock t3's
   per-session rules are. A project's `permission` rules do not loosen them, as they do not under stock t3.
4. **Kept as vendor-account denials (K3):** `websearch.use` and `integration.connect` for OpenCode,
   `disableClaudeAiConnectors` for Claude, and Codex's `feedback/*` and `account/*`.
5. **`t3_thread_send_attachments`, `t3_preview_*` and `device_*` are denied** beside the owner's list. Each depends on
   a host-bound or not-routed feature the code shows (`serverBrowser` stripped, device settings locked, attachment
   uploads).
6. **`request_secret` is offered** although its file delivery fails in a Container; SPI-1088 tracks the fix.
7. **Claude's `auto` falls back to `default`** when the agent does not offer it. On stage it was offered and worked
   through the proxy.
8. **The wrapper's card injection stays** (renamed). The MCP relay's tool cards use it, so U37 is rescoped, not
   retired.
9. **Old Durable Object storage keys** (`t3flare:taint`, `t3flare:linked-work`, `t3flare:push-expectations`,
   `t3flare:owner-commands`) are left unread in existing Workspaces. They are harmless, and deleting them would need a
   migration.

## Tickets

- Canceled with a reason (owner, 2026-11-12, back to stock): SPI-1051, SPI-1052, SPI-1053, SPI-1062, SPI-1063, SPI-1065.
- New: SPI-1088, `request_secret` file delivery lands outside the Container.

## Documents

- ADR-0013: a back-to-stock refinement; the step 3 D1 and SPI-992 refinements are marked superseded.
- ADR-0012: D5 lifted; the MCP-server exception is subsumed.
- ADR-0015: a back-to-stock refinement; the 4a mode table, the 4b fail-closed rules and SPI-1040 are marked superseded.
- ADR-0016: the SPI-992 refinement is marked superseded.
- ADR-0022: a denylist refinement, with `request_secret` offered.
- ADR-0023: D5 lifted.
- GLOSSARY: Push gateway, Expectation and Taint removed; Link fence and Container token rewritten.
- `docs/upstream-fragility.md`: U37 rescoped; U38 and U39 retired; U5, U29, U33, U35, U43 and U49 rewritten; T13
  moot.
- `docs/parity.md` and `docs/pi-parity.md`.

## Counts (ADR-0001)

- t3code is untouched at 24e7747 (`git -C t3code status` is clean).
- Shadows 2 and Patches 3, unchanged.
- No new reliance on t3's internals. `turnPolicy` restates CodexAdapterV2's mode table (U29), as before.

## Code review (vs `origin/main`, two axes)

The implementer did the review, one axis after the other: this agent cannot start sub-agents.

**Spec (the audit rows and the brief).**
- Every removal the brief lists is done, and each keep is kept:
  - the helper's host check, K7 and K5;
  - the provider pin and the no-sandbox fallback;
  - the pinned asking mode;
  - U49's intent;
  - the SPI-1061 link tools and Layers.
- Every check the brief asks for was run on stage and passed.
- Each removal is recorded in its ADR, glossary or fragility entry.
- The six tickets are closed.
- Gap: the Codex reviewer's verdict is inferred (no owner card, and Codex said it ran elevated), not observed as an
  item. U29 notes the mode table is restated.

**Standards (repo docs and the smell baseline).**
- **Fixed in review:**
  - `CliAsk.requestKind` was a union with one remaining value (speculative generality); a tool card is `permission`.
    The stage ran before this behaviour-neutral change.
  - `ProfileContext.t3McpUrl` and `RELAY_URL_PATTERN` became dead once Claude's MCP admission lock went; both were
    removed.
  - `gitHttp.fixture.ts` served only the gateway's tests; its three helpers moved into `systemGitconfig.test.ts`.
- Names:
  - `cliAsk.ts`, `CliAsk`, `registerCliAsker`, `cancelCliAsk` and `cancelAsk` replace push-named ones still used for
    tool cards.
  - `t3flare-ask` replaces the `t3flare-push` card prefix; the tools harness follows.
- Tests:
  - New seams: `containerGitHubPermissions` (`github-app`), `cliSessionModeForPolicy`, and the denylist's
    real-tool check.
  - Rewritten: the gateway-era tests (`cliCard.test.ts`, `acpAdapter.test.ts`, `codexGuard.test.ts`).
  - Removed: tests of removed code only.
- Possible smell, left: `turnPolicy` restates t3's `codexPolicyForRuntimeMode` (duplicated logic across the
  boundary). It stays because the no-sandbox fallback and plan read-only wrap it; U29 names it.
- Environment typecheck does not cover `test/` (vitest does). Two stale test references (a differ case, a code mode
  case) surfaced only in the full check and were fixed.

## Branch

`stock`, pushed to origin; not merged. Head: see the final commit on `stock`.
