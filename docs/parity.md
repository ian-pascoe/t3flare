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
| Clone (other hosts) | same | P: public repos only | token minted only for `github.com` (`processRouter.ts` `clone`) | — G9 |
| New project | `projects.createNew` `ws.ts:2930` | W | Patch 0002 roots it at `/w` | done |
| Open folder | `filesystem.browse` `ws.ts:3047` | R: only `/w` Workspaces exist | `env/workspace/layers.ts` `browse`; ADR-0008 | — |
| Scratch threads | `projects.ensureScratch` `ws.ts:2924`; `srv/project/ManagedProjectFolders.ts:247` | M, yet `threadProjectFromScratch` is still advertised (`srv/environment/ServerEnvironment.ts:259`) | "Scratch threads stay unavailable" (`docs/steps/step-2a-plan.md:74`) | — G4 |
| File tree, read, edit, `@` and content search | `ws.ts:2960-3019` | W | `layers.ts`; step-2a M2. Ignored-file list is always empty; reads cap at 1 MiB | done |
| Attachments, images | upload route `srv/http.ts:464`; Pi inlines images `t3code/packages/provider-pi/src/server/adapter.ts:2671` | P: upload is mounted, but the model never receives them | `images: []` (`env/provider/adapter.ts:357`, `:391`); `attachments: []` (`env/provider/differ.ts:223`); same on `step-3` | — G1 |
| Open in editor | `shell.openInEditor` `ws.ts:3045` | N/A (host launcher) | router answers "not found" | — |

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
| Codex, Pi CLI | `srv/provider/builtInDrivers.ts:33-45` | M | Shadow lists Pi Durable only | 4a |
| Claude, OpenCode | same | M; Claude over ACP loses fork, live steering, structured plan (ADR-0015) | same | 4b |
| Cursor, Grok, Fx, Antigravity, Kiro, Muse | same | M | no plan or ADR names them | — D3 |
| ACP registry agents | `ws.ts:2395-2453` | M | driver absent | — G13 |
| Provider settings | `con/settings.ts:688-904` | P: Pi Durable has one hidden switch | `env/provider/settings.ts` | 4a/4b for CLIs |
| Install or update a provider | `ws.ts:2631`, `:2681` | R (image-pinned) | ADR-0015; not stated outright | — |
| Account sign-in | `provider.auth.*` `ws.ts:2665-2679` | R | ADR-0012 | — |
| Limit errors and resume | — | W | `docs/model-proxy.md` | done |
| Usage page, limit meters | `ws.ts:2740`; `t3code/docs/user/usage.md` | M | `BUILT_IN_USAGE_DRIVERS = []` | *def* G8 |
| Model list, picker, thinking | — | W | `docs/steps/proxy-models/` | done |
| Titles, commit and PR text | `srv/textGeneration/TextGeneration.ts:42` | W | step-2a M1, M4 | done |
| Custom text generators | `con/settings.ts:941` | W†, but they hold a vendor key | not stripped | — D5 |
| Skills, slash commands | `con/server.ts:128-130` | M | snapshot has none; `step-2a-plan.md:116` | — G10 |

### Git/VCS

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Status, diff, commit, branch, push, pull, PR create | `ws.ts:3146-3223` | W (stale reads; automatic fetch off) | step-2a M2–M4; ADR-0009 | done |
| PR list, detail, checks, comment, review | `ws.ts:2787-2874` | W†/P: acts as the GitHub App, not the owner | Environment token (`packages/github-app/src/permissions.ts:39`). I infer "my PRs" and review identity are affected; not traced | — G9 |
| Starred repos, publish a repo | `ws.ts:2884`, `:2951` | M (inferred: an installation token cannot do either) | same | — G9 |
| PR watch | `PullRequestWatchReactor` | P†: the alarm has no PR-watch source, so I infer it polls only while awake | `idle.ts` `nextDue` | *def* (webhook) G12 |
| Review guide | `srv/pullRequest/PullRequestReviewGuideService.ts:314` (`worktree add --detach`) | M: refused | router `worktreeAdd` (2b finding F6) | — G7 |
| Discovery | `ws.ts:2728`; `srv/sourceControl/SourceControlDiscovery.ts:49`, `:57` | P: git and gh emulated; jj, glab and the rest "not found" | `ghRouteOf` | — |
| Host sign-in | `ws.ts:2880-2882` | R for GitHub (ADR-0013); other hosts M | `ghAuthStatus` always signed in | — G9 |

### Terminals, setup scripts, worktrees

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Terminal, setup scripts, worktree threads, deletion | `ws.ts:3224-3239`, `:3211` | W; documented differences: ends with the Environment, 8 shells, 3 Containers, full clones, no fast checkout | step-2b; ADR-0021, ADR-0008 | done |

### Previews

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Port discovery | `srv/preview/PortScanner.ts:338` (lsof); `ws.ts:3280` | M | lsof "not found" | — G11 |
| Server browser, dev-server preview | `srv/preview/ServerBrowser.ts:225`; route `srv/server.ts:800` | M | capability stripped; route unmounted | — G11 |
| Agent browser tools | `preview_*` | R | step-3 plan pins it off (L3) | 3 (as refusal) |
| HTML visual replies | `srv/htmlRender/HtmlRender.ts` | M | step-3 allowlist drops `html_*` | — G11 |
| MCP apps | `ws.ts:2579-2582` | M | differ drops them | — |
| Device hub | `srv/device/DeviceHubProxy.ts:241`; `ws.ts:3255-3278` | R | unmounted; ADR-0010 | — |
| Relay tunnel | `ws.ts:2762` | R | ADR-0010 | — |

### MCP, secrets

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| `/mcp` and OAuth for outside agents | `con/environmentHttp.ts:633-674` | W† | mounted; step-3 M0 probes it | 3 |
| t3's tools in Sessions | `srv/mcp/toolkits/` | M today | `supportsMcpTools: false` on main | 3 |
| Agent's own MCP servers | each CLI's config | M | — | — G10 |
| Secret store | — | W | `env/platform/secretStore.ts`; step 1 | done |
| 1Password provider | `t3code/packages/secret-provider-onepassword` (`op` CLI) | M | `op` "not found" | — |
| `request_secret` | `srv/mcp/toolkits/orchestrator/tools.ts:198`; `ws.ts:2376` | R | step-3 plan §4.3 | 3 (as refusal) D5 |

### Settings, notifications, links, auth

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Server settings | `ws.ts:2714` | W | seeds in `env/agents/seedSettings.ts` | done |
| Keybindings | `srv/keybindings.ts:208` | W† | `Keybindings.layer` | — |
| Storage page | `ws.ts:2701-2704` | P: inspection fails on refused PRAGMAs | `docs/upstream/t3code-asks.md` §4 | — |
| Browser notifications | `t3code/apps/web/src/threadNotifications.ts` | W† (client-side) | client-side | — |
| Mobile push | `srv/relay/AgentAwarenessRelay.ts:56` | M | — | 3+ |
| Laptop-to-cloud link | `srv/peer/PeerLinks.ts:89` | in progress | `.worktrees/step-3/docs/steps/step-3/` (m0–m3 evidence) | 3 |
| Cloud-to-laptop link | — | R for now | ADR-0011 | *def* |
| First pairing | `/api/auth/browser-session` | W (armed window) | ADR-0010 | done |
| More devices, sessions, revoke | `con/environmentHttp.ts:600-624` | W† | used by step 3 | 3 |
| Guest links | `srv/guest/http.ts:140`; `ws.ts:2372` | R; the RPC still answers, the link 404s | ADR-0010 | — G2 |

### Updates, telemetry, import, other

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Server self-update | `ws.ts:2685`; `srv/cloud/selfUpdate.ts:161` | N/A: nightly bump and deploy | ADR-0017; `npmReleaseLookup` still advertised | — G2 |
| Product analytics | `srv/telemetry/AnalyticsService.ts:67-74` (on by default, `ingest.t3.codes`) | Probably **on**, undocumented | `AnalyticsService.layer` in composition; no override; DO `process.env` empty | — D1 |
| OTLP export | `con/settings.ts:1017`; proxy route `srv/http.ts:335` | M | URLs `undefined` in composition; route unmounted | *def* |
| Import agent sessions | `srv/project/AgentSessionScanner.ts:217`, `:1196`; `ws.ts:3060` | N/A: no provider homes in the State directory | — | — |
| Voice | `con/environmentHttp.ts:795-927` | Local R (capability stripped); cloud voice W† and stores a vendor key | `cloudVoiceTranscription` kept | — D5 |
| Triage, host diagnostics | `ws.ts:2745`, `:2734-2738` | N/A | no host | — |

## 2. Gaps no planned step covers, in dependency order

| # | Ticket | Size | Key risk |
|---|---|---|---|
| G1 | **Attachments and images reach Durable agents.** The adapter resolves attachments to the `images` the Session already accepts (`apps/agents/src/session/SessionDO.ts:98`); the differ echoes them. | S | RPC size bounds; non-Claude models are text-only |
| G2 | **Truthful capabilities.** Strip or hide scratch, npm release lookup, guest share and the device/browser/voice settings. | S | Client behaviour varies by nightly |
| G3 | **Telemetry Layer**, per D1. | S | None |
| G4 | **Scratch threads**: the scratch root becomes a Workspace. | S–M | Root is private to t3's runtime graph; likely a third Patch |
| G5 | **Owner-facing plan mode and live output** (after step 3): toggle on, proposed plan, todos, streamed tool output. | M | pi-durable has no plan primitive |
| G6 | **Fork and rollback**: prove the handoff fork; add conversation rollback in the Session plus checkpoint restore. | M | t3 needs rollback to return a snapshot |
| G7 | **Review guide**: a real detached worktree inside the project's Container. | M | t3 may read the scratch path through `FileSystem` |
| G8 | **Usage meters.** Lead: t3's `cliproxy` usage-limit source (`con/settings.ts:913`) is already composed. | M | Commissary's management API shape is unverified |
| G9 | **GitHub as the owner, and other hosts** (after D2). | M per host | Loosens ADR-0013's per-repo scope |
| G10 | **Skills and the agent's own MCP servers** (after 3 and 4a). | M | ADR-0016 |
| G11 | **Previews**: Container port discovery, an authenticated port proxy, HTML renders, later a browser (after D4). | L | Exposing dev servers publicly; Container sleep |
| G12 | **Webhook origin and PR-watch wake.** | S | Every hook wakes the DO |
| G13 | **ACP registry agents** (after 4b). | S–M | Each agent needs a proxy base URL |

OTLP traces (M) stays deferred.

## 3. Refused by design: what still needs writing down

Already documented, no action:
- Guest links, relay tunnel, Tailscale (ADR-0010).
- Provider sign-in (ADR-0012).
- Open folder, fast checkout, git worktrees (ADR-0008).
- Stale reads (ADR-0009).
- Terminal lifetime (ADR-0021).
- Cloud-to-laptop links and thread transfer (ADR-0011).

Needs an ADR or a line in one:
1. **Host-bound features**, one new ADR:
   - Device hub and simulators.
   - Local voice models.
   - Open in editor.
   - Host diagnostics and power policy.
   - Triage.
   - jj.
   - Import of agent sessions.
   - Server self-update and provider install/update. ADR-0015 and ADR-0017 imply these but never say so.
2. **Server browser and agent browser access**: today only step-3's L3 pin. Either refuse here or build under G11.
3. **Vendor-login CLIs** (Cursor, Antigravity, Kiro, Muse, Grok, Fx): add to ADR-0012 or ADR-0015.
4. **`request_secret` and `t3_attachment_*` withheld from agents**: step 3's planned ADR-0022 should state it as a parity refusal.
5. **Automatic git fetch off**: lives only in a step plan; add to ADR-0009.
6. **GitHub identity is the App**: add to ADR-0013 once D2 is settled.

## 4. Owner decisions

- **D1. Telemetry.** By my reading the Cloud Environment sends t3's product analytics to `ingest.t3.codes`. Keep or switch off? I recommend off until decided.
- **D2. GitHub identity and other hosts.** Stay App-only (reviews and commits by the App, no "my PRs", stars or publish), or add an owner token? Are GitLab, Bitbucket, Azure and Forgejo in scope?
- **D3. Vendor-login CLIs.** Refuse permanently under ADR-0012?
- **D4. Previews.** Is dev-server preview (G11, L) part of parity, or refused with the device hub?
- **D5. Keys typed into t3.** Cloud voice, custom text generators, 1Password and `request_secret` each put a credential in t3flare. Exempt them from ADR-0012/0016, or refuse them?
