# t3flare parity matrix (t3code `v0.1.9-nightly.20261111.4515`)

The checklist for "t3code parity": everything stock t3code does on a laptop works in t3flare, or is refused by a recorded decision. First audit 2026-11-11 (read-only, code and step reports); update rows as steps land. Gaps and decisions are tracked in Linear (project ian-pascoe/t3flare).

**Paths:** `srv/` = `t3code/apps/server/src/`, `con/` = `t3code/packages/contracts/src/`, `env/` = `apps/environment/src/`.

**Status:** **W** works with stage evidence · **W†** stock code mounted in `env/t3/composition.ts`, never exercised on a stage · **P** partial · **M** missing · **R** refused by design · **N/A**.

**Step:** 3, 3+, 4a, 4b · *def* = listed under "Deferred" in `docs/plan.md` · — = uncovered (see §2).

## 1. Matrix

### Projects

| Feature | Stock (anchor) | t3flare | Evidence | Step |
|---|---|---|---|---|
| Clone (GitHub) | `projectClone.start` `srv/ws.ts:2886` | W | router `clone` makes a Workspace (`env/agents/processRouter.ts`); step-2a M2 | done |
| Clone (other hosts) | same | R for now (D2): public repos only; GitHub is the only host | token minted only for `github.com` (`processRouter.ts` `clone`); ADR-0013 (D2 refinement) | done (refusal) |
| New project | `projects.createNew` `ws.ts:2930` | W | Patch 0002 roots it at `/w` | done |
| Open folder | `filesystem.browse` `ws.ts:3047` | R: only `/w` Workspaces exist | `env/workspace/layers.ts` `browse`; ADR-0008 | — |
| Scratch threads | `projects.ensureScratch` `ws.ts:2924`; `srv/project/ManagedProjectFolders.ts:247` | M; `threadProjectFromScratch` stripped (SPI-994) | "Scratch threads stay unavailable" (`docs/steps/step-2a-plan.md:74`) | — G4 |
| File tree, read, edit, `@` and content search | `ws.ts:2960-3019` | W | `layers.ts`; step-2a M2. Ignored-file list is always empty; reads cap at 1 MiB | done |
| Attachments, images | upload route `srv/http.ts:464`; Pi inlines images `t3code/packages/provider-pi/src/server/adapter.ts:2671` | W (images); P (files: as text, unit-tested only); images past 0.9 MB per message are named, not shown (SPI-1027); no SnapShot window context (SPI-1028) | `env/provider/attachments.ts` (SPI-993): images inline within the Session's row budget, readable files as text, the rest named; stage `attach`: a green square named "green" on claude-haiku-5-5, a 1.2 MB image named "not shown" (`docs/steps/parity/spi-993-attachments.json`) | done |
| Open in editor | `shell.openInEditor` `ws.ts:3045` | R (host launcher) | router answers "not found"; ADR-0024 | done (refusal) |

### Threads

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Send, stream, stop, steer, approvals, modes | `dispatchCommand` `ws.ts:2054` | W | step-2a M1, M3 | done |
| Queued messages | `queue.resume` `con/orchestrationV2.ts:3284` | W† | `supportsQueuedMessages` (`env/provider/capabilities.ts`); Session `whenBusy: "followUp"` | — |
| Archive, search | `orchestrationV2.ts:2974`; `ws.ts:2150` | W | step-2b `m4-sweep`; step-1 search | done |
| Delete, pin, snooze, tags | `orchestrationV2.ts:2995-3071` | W† | t3 core, unchanged | — |
| Turn and thread diffs | `ws.ts:2122`, `:2132` | W | step-2a M3 (110/110) | done |
| Fork | `thread.fork` `orchestrationV2.ts:3342` | P†: no native fork; t3 falls back to a context handoff, untested | `forkThread` fails (`adapter.ts:452`); `srv/orchestration-v2/CommandPolicy.ts:377` | — G6 |
| Rollback | `checkpoint.rollback` `orchestrationV2.ts:3334`; `CommandPolicy.ts:314` | M | `canRollbackThread: false`; `adapter.ts:451` | *def* G6 |
| Plan mode | interaction mode | P after step 3: a handed-down `plan` is enforced, but the toggle stays hidden and no proposed plan is emitted | `showInteractionModeToggle: false` (`driver.ts:31` on `step-3`); `emitsProposedPlan: false` | 3 in part; G5 |
| Structured questions | `user_input` requests | M today | `ask_user` in step-3 plan §3.2 | 3 |
| Subagents, `delegate_task` | orchestrator MCP | M today | step-3 plan §4.5; native subagents *def* | 3 |
| Live command output, todos, prompt suggestions | `ws.ts:2345`, `:2351` | P: final output only; the rest dropped | `streamsToolOutput: false`; `step-2a-plan.md:315` | — G5 |
| Usage-limit resume, restart recovery | — | W (ADR-0004 difference documented) | step-2a part 2; M5 | done |
| Scheduled tasks | `ws.ts:2353-2384` | W† | alarm reads `scheduled_tasks.next_run_at` (`env/host/idle.ts`) | — |
| Task webhooks | `/api/hooks/:hookId/:token` `con/environmentHttp.ts:1008` | P: route mounted, no hook URL | `relayHookBaseUrl: null` in composition | — G12 |
| Move thread between Environments | — | R for now | ADR-0011 | *def* |

### Providers, models, text generation

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Pi Durable | (ours) | W | `env/shadows/builtInDrivers.ts` | done |
| Codex, Pi CLI | `srv/provider/builtInDrivers.ts:33-45` | W, on proxy models, in the Workspace's Container; no t3 tools (OD-3, below); Pi has no plan mode (a plan turn is refused) | `env/provider/cli/`; `docs/steps/step-4a.md`, `step-4a/m6-acceptance.json` | done (4a) |
| Claude, OpenCode | same | W over ACP, on proxy models, in the Workspace's Container (t3's kinds `claudeAgent`, `opencode`); no t3 tools (OD-3). Against t3's native drivers: fork M (both CLIs answer `session/fork`; SPI-1037), live steering P (interrupt and restart), rollback M (off), OpenCode's plan P (text and todos, no proposed plan; Claude's proposed plan is W), idle compaction M (not started), provider settings P (binary, home, server URL, launch arguments ignored); usage limit W (the proxy's 429) | `env/provider/cli/acpDriver.ts`, `acpFlavor.ts`; `docs/steps/step-4b.md`, `step-4b/m5-acceptance.json` | done (4b) |
| Cursor, Grok, Fx, Antigravity, Kiro, Muse | same | R (D3): vendor sign-in, no proxy base URL | no driver registered; ADR-0015 (D3 refinement), ADR-0012 | done (refusal) |
| ACP registry agents | `ws.ts:2395-2453` | M | driver absent | — G13 |
| Provider settings | `con/settings.ts:688-904` | P: Pi Durable has one hidden switch; Codex and Pi show t3's forms but binary path, home and launch arguments are ignored (the image and the CLI profile decide), Codex's managed (ChatGPT) setup is refused | `env/provider/settings.ts`, `env/provider/cli/` | 4a (CLIs), 4b |
| Install or update a provider | `ws.ts:2631`, `:2681` | R (image-pinned) | ADR-0024, ADR-0015 | done (refusal) |
| Account sign-in | `provider.auth.*` `ws.ts:2665-2679` | R | ADR-0012 | — |
| Limit errors and resume | — | W | `docs/model-proxy.md` | done |
| Usage page, limit meters | `ws.ts:2740`; `t3code/docs/user/usage.md` | M | `BUILT_IN_USAGE_DRIVERS = []` | *def* G8 |
| Model list, picker, thinking | — | W | `docs/steps/proxy-models/` | done |
| Titles, commit and PR text | `srv/textGeneration/TextGeneration.ts:42` | W | step-2a M1, M4 | done |
| Custom text generators | `con/settings.ts:941` | R for now (D5): the setting is locked empty by t3flare's managed policy (SPI-994) | ADR-0012 (D5 refinement), ADR-0023; `docs/steps/parity/spi-994-capabilities.json` | done (refusal) |
| Skills, slash commands | `con/server.ts:128-130` | M | snapshot has none; `step-2a-plan.md:116` | — G10 |

### Git/VCS

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Status, diff, commit, branch, push, pull, PR create | `ws.ts:3146-3223` | W (stale reads; automatic fetch off) | step-2a M2–M4; ADR-0009 | done |
| PR list, detail, checks, comment, review | `ws.ts:2787-2874` | W†/P: acts as the GitHub App, not the owner, by decision (D2) | Environment token (`packages/github-app/src/permissions.ts:39`); ADR-0013 (D2 refinement) | done (refusal of owner identity) |
| Starred repos, publish a repo | `ws.ts:2884`, `:2951` | R for now (D2): need an owner token | ADR-0013 (D2 refinement); a token pasted into t3's settings still works | done (refusal) |
| PR watch | `PullRequestWatchReactor` | P†: the alarm has no PR-watch source, so I infer it polls only while awake | `idle.ts` `nextDue` | *def* (webhook) G12 |
| Review guide | `srv/pullRequest/PullRequestReviewGuideService.ts:314` (`worktree add --detach`) | M: refused | router `worktreeAdd` (2b finding F6) | — G7 |
| Discovery | `ws.ts:2728`; `srv/sourceControl/SourceControlDiscovery.ts:49`, `:57` | P: git and gh emulated; jj, glab and the rest "not found" (R: ADR-0024, ADR-0013) | `ghRouteOf` | done (refusal) |
| Host sign-in | `ws.ts:2880-2882` | R for GitHub (ADR-0013); other hosts M | `ghAuthStatus` always signed in | — G9 |

### Terminals, setup scripts, worktrees

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Terminal, setup scripts, worktree threads, deletion | `ws.ts:3224-3239`, `:3211` | W; documented differences: ends with the Environment, 8 shells, 3 Containers, full clones, no fast checkout | step-2b; ADR-0021, ADR-0008 | done |

### Previews

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Port discovery | `srv/preview/PortScanner.ts:338` (lsof); `ws.ts:3280` | M | lsof "not found" | — G11 |
| Server browser, dev-server preview | `srv/preview/ServerBrowser.ts:225`; route `srv/server.ts:800` | M, part of parity, built last (D4) | capability stripped; route unmounted; ADR-0024 | SPI-1002 (G11) |
| Agent browser tools | `preview_*` | M until previews exist (D4); pinned off (L3) | ADR-0024, ADR-0022 | SPI-1002 |
| HTML visual replies | `srv/htmlRender/HtmlRender.ts` | M | step-3 allowlist drops `html_*` | — G11 |
| MCP apps | `ws.ts:2579-2582` | M | differ drops them | — |
| Device hub | `srv/device/DeviceHubProxy.ts:241`; `ws.ts:3255-3278` | R; its settings (`enableDeviceSupport`, `enableAgentDeviceAccess`, `simlockDeviceHostsEnabled`) locked off (SPI-994) | unmounted; ADR-0024, ADR-0010, ADR-0023 | done (refusal) |
| Relay tunnel | `ws.ts:2762` | R | ADR-0010 | — |

### MCP, secrets

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| `/mcp` and OAuth for outside agents | `con/environmentHttp.ts:633-674` | W† | mounted; step-3 M0 probes it | 3 |
| t3's tools in Sessions | `srv/mcp/toolkits/` | M today | `supportsMcpTools: false` on main | 3 |
| t3's tools for CLI agents (Codex, Pi) | t3 hands its per-thread MCP bearer to the CLI's process | M by decision (OD-3): no `delegate_task`, thread tools, `t3_thread_wait`, browser or device tools from a CLI agent; Pi's extension warns of no MCP, filtered | `env/provider/cli/wrapper.ts` (`supportsMcpTools: false`), the `McpProviderSessions` stub | after 4b, SPI-1039 |
| Agent's own MCP servers | each CLI's config | M | — | — G10 |
| Secret store | — | W | `env/platform/secretStore.ts`; step 1 | done |
| 1Password provider | `t3code/packages/secret-provider-onepassword` (`op` CLI) | M; possibly later through the broker pattern (D5) | `op` "not found"; ADR-0012 (D5 refinement) | — |
| `request_secret` | `srv/mcp/toolkits/orchestrator/tools.ts:198`; `ws.ts:2376` | R for now (D5) | ADR-0022 and ADR-0012 refinements | done (refusal) |

### Settings, notifications, links, auth

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Server settings | `ws.ts:2714` | W | seeds in `env/agents/seedSettings.ts` | done |
| Keybindings | `srv/keybindings.ts:208` | W† | `Keybindings.layer` | — |
| Storage page | `ws.ts:2701-2704` | P: inspection fails on refused PRAGMAs | `docs/upstream/t3code-asks.md` §4 | — |
| Browser notifications | `t3code/apps/web/src/threadNotifications.ts` | W† (client-side) | client-side | — |
| Mobile push | `srv/relay/AgentAwarenessRelay.ts:56` | W (publish-only T3 Connect link; prod after its sign-in, A3) | `docs/steps/step-3plus.md`; ADR-0025 | 3+ |
| Laptop-to-cloud link | `srv/peer/PeerLinks.ts:89` | in progress | `.worktrees/step-3/docs/steps/step-3/` (m0–m3 evidence) | 3 |
| Cloud-to-laptop link | — | R for now | ADR-0011 | *def* |
| First pairing | `/api/auth/browser-session` | W (armed window) | ADR-0010 | done |
| More devices, sessions, revoke | `con/environmentHttp.ts:600-624` | W† | used by step 3; later devices pair by pairing link, never the bootstrap token (ADR-0010, README; SPI-1006) | 3 |
| Guest links | `srv/guest/http.ts:140`; `ws.ts:2372` | R; `guestSharingEnabled` locked off by the managed policy, so no client offers a link (SPI-994) | ADR-0010, ADR-0023; stage `truecaps`: the write is refused ("managed by t3flare") | done |

### Updates, telemetry, import, other

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Server self-update | `ws.ts:2685`; `srv/cloud/selfUpdate.ts:161` | N/A: nightly bump and deploy | ADR-0017; `npmReleaseLookup` and the self-update flags stripped (SPI-994) | done |
| Product analytics | `srv/telemetry/AnalyticsService.ts:67-74` (on by default, `ingest.t3.codes`) | **Off** (D1): t3flare's managed policy sets `limits.telemetry: false` (SPI-995) | ADR-0023, README; `test/analytics.test.ts` (t3's service sends nothing under the policy); stage: `docs/steps/parity/spi-995-analytics.json` | done |
| OTLP export | `con/settings.ts:1017`; proxy route `srv/http.ts:335` | M | URLs `undefined` in composition; route unmounted | *def* |
| Import agent sessions | `srv/project/AgentSessionScanner.ts:217`, `:1196`; `ws.ts:3060` | R: no provider homes in the State directory | ADR-0024 | done (refusal) |
| Voice | `con/environmentHttp.ts:795-927` | R: local voice is host-bound; cloud voice refused for now (D5) | both capabilities stripped (SPI-994); ADR-0024, ADR-0012 | done (refusal) |
| Triage, host diagnostics | `ws.ts:2745`, `:2734-2738` | R (host-bound) | `triage` stripped (SPI-994); ADR-0024 | done (refusal) |

## 2. Gaps no planned step covers, in dependency order

| # | Ticket | Size | Key risk |
|---|---|---|---|
| G1 | ~~**Attachments and images reach Durable agents.**~~ Done (SPI-993): `apps/environment/src/provider/attachments.ts`. The user message's attachments are t3's own, so the differ has nothing to echo. Follow-ups: SPI-1027 (shrink large images), SPI-1028 (SnapShot context). | S | Bound: a DO SQLite row (2 MB) per Session message |
| G2 | ~~**Truthful capabilities.**~~ Done (SPI-994, SPI-1012): every capability classified in `env/t3/capabilities.ts` (a new one fails typecheck and a test); settings of refused features locked by t3flare's managed policy (ADR-0023). | S | Client behaviour varies by nightly |
| G3 | ~~**Telemetry Layer**, per D1.~~ Done (SPI-995): a managed-policy limit, not a Layer of its own (ADR-0023). | S | None |
| G4 | **Scratch threads**: the scratch root becomes a Workspace. | S–M | Root is private to t3's runtime graph; likely a third Patch |
| G5 | **Owner-facing plan mode and live output** (after step 3): toggle on, proposed plan, todos, streamed tool output. | M | pi-durable has no plan primitive |
| G6 | **Fork and rollback**: prove the handoff fork; add conversation rollback in the Session plus checkpoint restore. | M | t3 needs rollback to return a snapshot |
| G7 | **Review guide**: a real detached worktree inside the project's Container. | M | t3 may read the scratch path through `FileSystem` |
| G8 | **Usage meters.** Lead: t3's `cliproxy` usage-limit source (`con/settings.ts:913`) is already composed. | M | Commissary's management API shape is unverified |
| G9 | ~~**GitHub as the owner, and other hosts** (after D2).~~ Not now: D2 keeps GitHub App-only and GitHub-only (ADR-0013 refinement, SPI-1004). | M per host | Loosens ADR-0013's per-repo scope |
| G10 | **Skills and the agent's own MCP servers** (after 3 and 4a). | M | ADR-0016 |
| G11 | **Previews**: Container port discovery, an authenticated port proxy, HTML renders, later a browser (after D4). | L | Exposing dev servers publicly; Container sleep |
| G12 | **Webhook origin and PR-watch wake.** | S | Every hook wakes the DO |
| G13 | **ACP registry agents** (after 4b). | S–M | Each agent needs a proxy base URL |

OTLP traces (M) stays deferred.

## 3. Refused by design: where each refusal is written down

Already documented, no action:
- Guest links, relay tunnel, Tailscale (ADR-0010).
- Provider sign-in (ADR-0012).
- Open folder, fast checkout, git worktrees (ADR-0008).
- Stale reads (ADR-0009).
- Terminal lifetime (ADR-0021).
- Cloud-to-laptop links and thread transfer (ADR-0011).

Written down (SPI-1004, SPI-1006):
1. **Host-bound features**: [ADR-0024](adr/0024-host-bound-features-are-refused.md) (device hub and simulators, local voice, open in editor, host diagnostics and power, triage, jj, agent-session import, server self-update, provider install and update).
2. **Server browser and agent browser access**: not refused (D4). Built last under G11 (SPI-1002); until then stripped and pinned off (ADR-0024).
3. **Vendor-login CLIs**: refused (D3), [ADR-0015](adr/0015-cli-agents-run-through-platform-exec-codex-in-managed-mode-claude-and-opencode-over-acp.md) refinement.
4. **`request_secret` and `t3_attachment_*` withheld from agents**: [ADR-0022](adr/0022-durable-agents-reach-t3s-mcp-through-the-environment-do-with-t3s-own-credential.md) refinement. Keys typed into t3 (D5): [ADR-0012](adr/0012-all-model-access-goes-through-the-model-proxy.md) refinement.
5. **Automatic git fetch off**: [ADR-0009](adr/0009-git-runs-in-the-container-status-and-checkpoints-come-from-the-workspace.md) refinement.
6. **GitHub identity is the App, GitHub only** (D2): [ADR-0013](adr/0013-github-access-through-a-github-app-with-per-repo-tokens.md) refinement.
7. **Later devices pair by pairing link** (SPI-1006): [ADR-0010](adr/0010-the-endpoint-is-public-behind-t3s-own-auth.md) refinement and README.

## 4. Owner decisions

- **D1. Telemetry.** By my reading the Cloud Environment sends t3's product analytics to `ingest.t3.codes`. Keep or switch off? I recommend off until decided.
- **D2. GitHub identity and other hosts.** Stay App-only (reviews and commits by the App, no "my PRs", stars or publish), or add an owner token? Are GitLab, Bitbucket, Azure and Forgejo in scope?
- **D3. Vendor-login CLIs.** Refuse permanently under ADR-0012?
- **D4. Previews.** Is dev-server preview (G11, L) part of parity, or refused with the device hub?
- **D5. Keys typed into t3.** Cloud voice, custom text generators, 1Password and `request_secret` each put a credential in t3flare. Exempt them from ADR-0012/0016, or refuse them?

## 5. Owner decisions taken (2026-11-11)

- **D1** Product analytics: **off** in the Cloud Environment (SPI-995).
- **D2** GitHub stays **App-only and GitHub-only** for now: no owner token, no other hosts (SPI-1000 canceled; ADR-0013 note in SPI-1004).
- **D3** Vendor-login CLIs (Cursor, Antigravity, Kiro, Muse, Grok, Fx): **refused** (ADR-0012/0015 via SPI-1004).
- **D4** Dev-server previews: **part of parity, built last** (SPI-1002).
- **D5** Keys typed into t3 (cloud voice, custom text generators, `request_secret`): **refused for now**; 1Password possibly later via the broker pattern.
- **ADR-0016** CLI agents get the Commissary key by an on-demand helper, never in env or on disk (option A′).
