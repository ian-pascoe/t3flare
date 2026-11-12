# Back to stock: plan

Date: 2026-11-12. Branch `stock` from `origin/main` (0942f79). Spec: `docs/scope-audit.md`, rows 1, 2, 7, 9, 10 and 12,
under the owner's rule of 2026-11-12: t3flare behaves like stock t3, and keeps only what the platform forces or what the
owner kept (K1–K12). Each removal is recorded as "owner, 2026-11-12, back to stock" in the ADRs and refinements it
touches.

## Removals

| # | Row | Removed | Kept |
|---|---|---|---|
| R1 | 1 | The push gateway (`pushGateway.ts`, the `/t3flare/git/` path in `WorkspaceProxy`), Expectations (`expectPush`, `pushPlanOf`, the router's `expectOwnPush`), Taint (`trustAgain`, `taint`, the `workspace-trust` admin route), linked-work tracking that only fed the gateway (`noteLinkedWork`, `noteOwnerCommand`, the process marker's `linked`), push cards (`pushCard.ts`, `linkedPush.ts`, `SessionDO.approveGitPush`, `approvePush`/`cancelPush`, the wrapper's push half), `pushInsteadOf` in the image's system gitconfig, `PUSH_GATEWAY_*` permissions, `probePush`, `scripts/spi992.ts` | The credential helper's https+github.com check. The wrapper's injected cards, now only the MCP relay's tool cards (`linkedPushAsk.ts` becomes `cliAsk.ts`). `workflows` only for an opted-in Workspace (K7). The leak scan (K6) |
| R2 | 1 | Read-only Container token | The credential helper's token is `contents: write` (+ `workflows` when opted in) on the Workspace's one repo, as before SPI-992 |
| R3 | 12 | D5: `textGenerators` locked empty, `cloudVoiceTranscription` stripped, `request_secret` withheld | `cloudVoiceTranscription` stays stripped only if the code proves it host-bound |
| R4 | 2 | Claude's managed-only keys (`allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `allowManagedMcpServersOnly`, `allowedMcpServers`, `strictKnownMarketplaces`, `disableSkillShellExecution`, `strictPluginOnlyCustomization`); OpenCode's `mcp.use`, `skill.use`, `plugin.use` and subagent denies | K5: fixed env, fresh homes, the proxy as the only endpoint, `allowedProviders`, `apiKeyHelper`, the pinned-empty redirect variables, OpenCode's `provider.use` pin |
| R5 | 9 | ACP: cwd containment (`editStaysInCwd`, `PROTECTED_DIRS`), session ending on mode drift (`MODE_DRIFT`, `modeStateProblem`, `configModeProblem`), once-only cards, `disableAutoMode`. Pi CLI: `refusePlan`. Codex: `auto` as approval-required, `features.multi_agent=false` | The pinned asking mode and the plan-turn handling (Claude's `ExitPlanMode` plan, edits denied in plan): how the flavor implements t3's modes |
| R6 | 10 | Codex's method allowlist and thread-config allowlist | The provider pin (thread params and config keys that set a provider, a profile or a policy are dropped), the no-sandbox fallback, `account/*` (K3) and `feedback/*` (vendor upload) refused |
| R7 | 7 | `T3_TOOL_ALLOWLIST`, `NOT_T3_TOOLS` and the fail-closed classification | A denylist `T3_TOOL_DENYLIST`: `t3_attachment_*` and `t3_thread_send_attachments` (the attachment toolkit), `html_*`, `preview_*` and `t3_preview_*` (no server browser: `serverBrowser` is stripped), `device_*` (host-bound), `t3_worktree_*` (its git is not routed), `t3_environment_link`/`unlink` (until SPI-1061 M1). The guidance filter drops what names a denied tool. `peerLinks.ts` is left to SPI-1061 |

Mode table after R5 (stock t3's): Codex `auto` is `on-request` with `approvalsReviewer: "auto_review"` and
`workspaceWrite`; without bubblewrap everything but full access stays `untrusted` (kept fallback). Claude in `auto`
switches to Claude's own `auto` mode (stock t3's Claude adapter does the same); OpenCode in `auto` asks as stock t3's
OpenCode adapter does. If Claude does not offer `auto`, or Codex's reviewer cannot reach the model through the proxy,
the stage says so and the fallback is t3's nearest behaviour (asking), documented.

## Seams (tests)

Each is an existing public function with its own test file; tests change with the behaviour, red first.

| Seam | Proves | Misses |
|---|---|---|
| `workspaceGitHubToken` (`processRouter.ts`) and `CONTAINER_*_PERMISSIONS` | the Container token writes, `workflows` only when opted in | GitHub's answer (stage) |
| `CREDENTIAL_HELPER` / the image's gitconfig (`credentialHelper.test`, `systemGitconfig.test`) | host check kept, no `pushInsteadOf` | real git (stage) |
| `claudeManagedSettings`, `opencodeConfig` (`acpProfiles.test`) | repo config honoured, K5 pins kept | the CLIs' own precedence (stage: the hook case) |
| `cliPermissionDisposition`, `cliApprovalOptions`, `guardedRuntime`, the flavor's mode for a policy (`acpFlavor.test`) | stock disposition, session accept, no drift kill, auto mode | the agent's behaviour (stage) |
| `turnPolicy`, `guardRequest` (`codexGuard.test`) | stock mode table, unknown methods and keys pass, provider pin | Codex's reviewer (stage) |
| `T3_TOOL_DENYLIST`, `guidanceFor` (`t3Guidance.test`, `t3Mcp.test`) | every denied name is a real t3 tool; guidance names no denied tool | t3's runtime listing |
| `CAPABILITIES`, `T3FLARE_POLICY` (`capabilities.test`, managed policy test) | D5 lifted | the client's rendering (stage: policy read) |
| `wrapCliAdapter` (`cliWrapper` tests) | plan turns run on pi; tool cards still injected | |

## Stage `stock`: what each check proves

| Check | Proves |
|---|---|
| `acceptance --real-turn --peer` | the Durable path and the Peer link still work with the gateway gone |
| `acceptance --codex --pi --claude --opencode` | each CLI's turn, approvals, resume and leak check after R4–R6 |
| Durable push, CLI push (Codex) | a push lands from the agent's own shell with no card, under the thread's mode |
| Linked thread push | a linked thread's push follows its link's mode, no card of its own |
| Claude Code with a repo `.claude/settings.json` hook | R4: the repo's hook runs |
| Codex `auto` | the reviewer path runs as t3's (or the documented fallback) |
| Managed policy read | `textGenerators` unlocked |
| Leak scan | clean; the write token is in the Container during work (stock behaviour, recorded) |

## Order

1. R1+R2 (push gateway out, write token in), docs, tickets. Milestone 1.
2. R3, R7. Milestone 2.
3. R4, R5, R6. Milestone 3.
4. Full check, stage `stock`, the checks above, destroy. Report `docs/steps/stock.md`, code review.
