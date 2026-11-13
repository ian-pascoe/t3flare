# t3flare parity matrix (t3code `v0.1.10-nightly.20261112.4606`)

See also [`pi-parity.md`](pi-parity.md) for the owner's pi harness. The checklist for "t3code parity": everything stock t3code does on a laptop works in t3flare, or is refused by a recorded decision. First audit 2026-11-11 (read-only, code and step reports); update rows as steps land. Stale step-3-era rows refreshed against the code and the step 3, 3+, 4a, 4b, tools and SPI-1061 reports on 2026-11-13 (parity batch 2). Anchors (`ws.ts:NNNN`) are from the first audit and drift; grep the symbol. Gaps and decisions are tracked in Linear (project ian-pascoe/t3flare).

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
| Scratch threads | `projects.ensureScratch` `ws.ts:2924`; `srv/project/ManagedProjectFolders.ts:247` | W: the No project folder is the Workspace `/w/t3-scratch` (Patch 0004); each scratch thread writes in its own folder there, Durable and CLI agents alike; "Turn into project" (`threadProjectFromScratch`) works, the new project rooted at the thread's folder. The Durable agent prints its folder as `/workspace/repo/…` | stage `pbatch`: Durable and Codex threads wrote `hello.txt` in `/w/t3-scratch/<date>-…`, the Durable thread became a project (`docs/steps/parity-batch/scratch.json`) | done (G4) |
| File tree, read, edit, `@` and content search | `ws.ts:2960-3019` | W | `layers.ts`; step-2a M2. Ignored-file list is always empty; reads cap at 1 MiB | done |
| Attachments, images | upload route `srv/http.ts:464`; Pi inlines images `t3code/packages/provider-pi/src/server/adapter.ts:2671` | W (images); P (files: as text, unit-tested only); images past 0.9 MB per message are named, not shown (SPI-1027); no SnapShot window context (SPI-1028) | `env/provider/attachments.ts` (SPI-993): images inline within the Session's row budget, readable files as text, the rest named; stage `attach`: a green square named "green" on claude-haiku-5-5, a 1.2 MB image named "not shown" (`docs/steps/parity/spi-993-attachments.json`) | done |
| Open in editor | `shell.openInEditor` `ws.ts:3045` | R (host launcher) | router answers "not found"; ADR-0024 | done (refusal) |

### Threads

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Send, stream, stop, steer, approvals, modes | `dispatchCommand` `ws.ts:2054` | W | step-2a M1, M3 | done |
| Queued messages | `queue.resume` `con/orchestrationV2.ts:3284` | W | stage `pbatch`: a message sent `queue_after_active` runs after the active run; after a stop the next one stays queued until `queue.resume` (`docs/steps/parity-batch/queue.json`) | done |
| Archive, search | `orchestrationV2.ts:2974`; `ws.ts:2150` | W | step-2b `m4-sweep`; step-1 search | done |
| Delete, pin, snooze, tags | `orchestrationV2.ts:2995-3071` | W | stage `pbatch`: pin, tag, snooze, unsnooze, untag, unpin and delete, each read back from t3's shell (`docs/steps/parity-batch/threads.json`) | done |
| Turn and thread diffs | `ws.ts:2122`, `:2132` | W for Durable and CLI agents (Codex, Pi CLI, Claude, OpenCode): a capture first pulls the Container's writes into the Workspace DO (SPI-1100) | step-2a M3 (110/110); stage `p1100`: each agent's turn diffs 0→1 and 1→2 show the line it wrote in `notes.txt` (`docs/steps/spi-1100/after.json`) | done (SPI-1100) |
| Fork | `thread.fork` `orchestrationV2.ts:3342` | W (Pi Durable): t3's native fork. The new thread's Session is seeded with the source's model context through the fork's turn and goes on alone. No documents are copied (SPI-1101). Claude, OpenCode: t3's portable handoff (static `canForkThread: false`; SPI-1037). Codex, Pi CLI: t3's own | `env/provider/adapter.ts` `forkThread`; `apps/agents/src/session/branches.ts`; stage `p997`: a fork from turn 2 of 3 answers `FIG-3, PLUM-9`, resolution `native_fork` (`docs/steps/spi-997/fork.json`) | done (SPI-997) |
| Rollback | `checkpoint.rollback` `orchestrationV2.ts:3334`; `CommandPolicy.ts:314` | W (Pi Durable): the Session forks its conversation before the first dropped turn (code mode's `store` as it was there), and t3 restores the files through the Workspace's Container. The Todo List and Notes keep their latest values (SPI-1101). Codex, Pi CLI: t3's own. Claude, OpenCode: t3's own ACP rollback, on (SPI-1037): the files are restored and the agent starts a fresh session, so it keeps none of the conversation, not even the kept turns (stock t3: ACP has no truncation) | `env/provider/adapter.ts` `rollbackThread`; `env/provider/cli/wrapper.ts` `rollbackThread`; stage `p997`: rolling back two turns puts `notes.txt` back to `one`, and the agent recalls only `FIG-3` (`docs/steps/spi-997/rollback.json`); stage `p1100`: for each of the five agents, a rollback to turn 1 puts `notes.txt` back to `one` and the agent no longer recalls turn 2's code word (`docs/steps/spi-1100/after.json`) | done (SPI-987, SPI-1100) |
| Plan mode | interaction mode; Implement (`message.dispatch` `sourcePlanRef`) | W: the toggle shows; a plan turn is read-only and ends with the agent's `propose_plan`, shown as t3's proposed plan (Claude's `ExitPlanMode` shape: a `plan` node, a `proposed_plan` item, an `active` plan artifact; a revised plan supersedes the last); Implement starts a default-mode turn and t3 completes the plan | `apps/agents/src/extensions/plan.ts`, `env/provider/differ.ts` `emitProposedPlan`; stage `p996`: `docs/steps/spi-996/turns.json` `plan` | done (SPI-996) |
| Structured questions | `user_input` requests | W: the Durable agent's `ask_user` (one question, optional choices) opens t3's `user_input` request; answered in a client, by an MCP client with `t3_pending_request`, or from a linked laptop; re-raised after an Environment restart. CLI agents raise their own (Claude's, Codex's) through t3's adapters; an MCP server's form becomes a `user_input` card (SPI-1079) | `apps/agents/src/extensions/ask-user.ts`, `env/provider/differ.ts` `questionView`; step 3 (`docs/steps/step-3/m3-question-question-mcp-restart.json`, `m4-question-restart.json`, `m5-desktop-5-cloud-question.png`); step 3+ (`docs/steps/step-3plus.md` rows c and i, `step-3plus/m2-publishes.json`: answered after 30 s, and re-asked after a restart); `docs/steps/spi-1079.md` | done (3, SPI-1079) |
| Subagents, `delegate_task` | orchestrator MCP | W through t3's orchestrator: the Durable agent's `delegate_task` starts a child thread here and wakes with its result; to a linked laptop too (SPI-1061). `create_threads` and `t3_thread_*` likewise (not denied). Native subagents inside a Durable Session: *def* (`docs/plan.md`) | `T3_TOOL_DENYLIST` (`packages/harness-registry/src/t3Tools.ts`) leaves them offered; stage `step3`: approval-required asked once, the child returned `CHILD-…` (`docs/steps/step-3/m2-stage.json` `delegate`); stage `link`: delegation to a stand-in laptop (`docs/steps/spi-1061/delegate.json`) | done (3, SPI-1061) |
| Live command output, todos, prompt suggestions | `ws.ts:2345`, `:2351` | W: a running `bash` or Terminal command's output streams as t3's `command_output.delta` (from `pi.live`); todos as t3's todo list (SPI-1055); prompt suggestions under t3's labs flag, predicted by Haiku through the proxy from the turn's request and answer. P: a command the Worker Shell runs shows its output only at exit (SPI-1099); Terminal tools answer with a settled screen, so they rarely run long enough to stream | `streamsToolOutput: true`; stage `p996`: `turns.json` `streaming` (five frames over 3.4 s), `streamingWorker`, `suggestion` | done (SPI-996) |
| Usage-limit resume, restart recovery | — | W (ADR-0004 difference documented) | step-2a part 2; M5 | done |
| Scheduled tasks | `ws.ts:2353-2384` | W | stage `pbatch`: a once-task due in 3 minutes; the forced idle reset set the alarm for it, the alarm booted t3 and the task ran (`docs/steps/parity-batch/schedule.json`) | done |
| Task webhooks | `/api/hooks/:hookId/:token` `con/environmentHttp.ts:1008` | W: a webhook task's URL is `https://<t3 host>/api/hooks/<task>/<token>`, the route t3 serves itself (G12). Each delivery wakes the Environment (by design) | `env/t3/webhookOrigin.ts`; stage `pbatch`: a POST answered 202 and the task ran (`docs/steps/parity-batch/webhook.json`) | done (G12) |
| Move thread between Environments | — | R for now | ADR-0011 | *def* |

### Providers, models, text generation

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Pi Durable | (ours) | W | `env/shadows/builtInDrivers.ts` | done |
| Codex, Pi CLI | `srv/provider/builtInDrivers.ts:33-45` | W, on proxy models, in the Workspace's Container; t3's tools with t3's bearer and MCP servers through the MCP relay (tools step; the pi CLI gets t3's tools only); t3's mode table, Codex `auto` with its reviewer; a plan turn on pi runs as stock (pi has no plan mode) (owner, 2026-11-12, back to stock) | `env/provider/cli/`; `docs/steps/step-4a.md`, `step-4a/m6-acceptance.json` | done (4a) |
| Claude, OpenCode | same | W over ACP, on proxy models, in the Workspace's Container (t3's kinds `claudeAgent`, `opencode`); t3's tools with t3's bearer and MCP servers through the MCP relay (tools step); the repository's own `.claude/` and OpenCode config honoured, t3's modes with Claude's own `auto`, the card's "for the session" (owner, 2026-11-12, back to stock). Against t3's native drivers: fork P† (t3's portable handoff, not run on a stage; both CLIs answer `session/fork`, SPI-1037), live steering P (interrupt and restart), rollback W (t3's: files restored, a fresh agent session; stage `p1100`, SPI-1100), OpenCode's plan P (text and todos, no proposed plan; Claude's proposed plan is W), idle compaction M (not started), provider settings P (binary, home, server URL, launch arguments ignored); usage limit W (the proxy's 429) | `env/provider/cli/acpDriver.ts`, `acpFlavor.ts`; `docs/steps/step-4b.md`, `step-4b/m5-acceptance.json` | done (4b) |
| Cursor, Grok, Fx, Antigravity, Kiro, Muse | same | R (D3): vendor sign-in, no proxy base URL | no driver registered; ADR-0015 (D3 refinement), ADR-0012 | done (refusal) |
| ACP registry agents | `ws.ts:2395-2453` | R, listed stock-like: t3's registry search runs (agents with a binary for Linux; t3 itself hides npx and uvx agents, the host having neither), each agent's description led by its standing here, and every install refused with it: Claude Agent, Codex, OpenCode and pi are the built-in providers (the same agents, in the Workspace's Container on the proxy); vendor sign-in agents R (D3); the rest read their key only from their environment or a file, which ADR-0016's key helper rules out (owner's call). Nothing installed at runtime; the image pin is unchanged | `env/provider/acpRegistry.ts` (a Layer over t3's `AcpRegistryCatalog`); stage `pbatch2`: 23 listed, `claude-acp`, `gemini`, `cursor` prepares refused with their reasons (`docs/steps/parity-batch-2/registry.json`) | done (G13, SPI-1003; refusal) |
| Provider settings | `con/settings.ts:688-904` | P: Pi Durable has one hidden switch; Codex and Pi show t3's forms but binary path, home and launch arguments are ignored (the image and the CLI profile decide), Codex's managed (ChatGPT) setup is refused | `env/provider/settings.ts`, `env/provider/cli/` | done (4a, 4b) |
| Install or update a provider | `ws.ts:2631`, `:2681` | R (image-pinned) | ADR-0024, ADR-0015 | done (refusal) |
| Account sign-in | `provider.auth.*` `ws.ts:2665-2679` | R | ADR-0012 | done (refusal) |
| Limit errors and resume | — | W | `docs/model-proxy.md` | done |
| Usage page, limit meters | `ws.ts:2740`; `t3code/docs/user/usage.md` | W once Commissary's management API is set (optional; unset, both stay empty as before): the Usage page reads Commissary's request log for t3flare's two keys, attributed to Pi (Durable agent, text generation, the pi CLI), Codex, Claude Code and OpenCode by Commissary's session identities; the meters show Commissary's accounts' quota windows as a source named Commissary (a Layer over t3's `UsageLimitSources`). Needs an org-admin management key and, self-hosted, an Access service token (owner provisioning; `docs/model-proxy.md`). A Claude reset is claimed in Commissary's panel | `env/usage/`; stage `pbatch2` against a v9 stand-in: two accounts with their windows, a failed check shown as such, a Kimi account skipped; four sources, each agent's records, the cursor followed, both credentials sent (`docs/steps/parity-batch-2/usage.json`) | done (G8, SPI-999); real Commissary not run |
| Model list, picker, thinking | — | W | `docs/steps/proxy-models/` | done |
| Titles, commit and PR text | `srv/textGeneration/TextGeneration.ts:42` | W | step-2a M1, M4 | done |
| Custom text generators | `con/settings.ts:941` | W: as stock; the owner types the generator's key into t3 (D5 lifted, owner 2026-11-12, back to stock) | ADR-0012 (back-to-stock refinement), ADR-0023; `docs/steps/stock/` | done (stock) |
| Skills, slash commands | `con/server.ts:128-130` | W for all five. Pi Durable: Repo skills and Prompt templates in the composer (`snapshotForCwd`), `$name`, `/skill:name` and `/template` expanded at submit, the listing in the agent's prompt; switch `skills` in the Harness panel. Codex, Pi, Claude Code and OpenCode: each CLI's own Repo skills and repo commands in the composer, read from the Workspace (no Container starts), a picked Skill reaching the CLI as its own (Claude Code's native `/name`, OpenCode's embed, pi's `--skill`); stock's `/compact` for Codex and Pi and Codex's `/goal`. Not listed: `/compact` for Claude Code and OpenCode (t3's ACP adapter refuses it), OpenCode's repo commands (their reply never reaches t3 over ACP), `/feedback` | stages `p1001` (`docs/steps/spi-1001/`) and `pcli` (`docs/steps/spi-1151/`); [`spi-1001.md`](steps/spi-1001.md), [`spi-1151.md`](steps/spi-1151.md) | done (SPI-1147, SPI-1151) |

### Git/VCS

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Status, diff, commit, branch, push, pull, PR create | `ws.ts:3146-3223` | W (stale reads; automatic fetch off) | step-2a M2–M4; ADR-0009 | done |
| Push (t3's and the agents') | same; agents' shells | W: as stock: git in the Container pushes with the Workspace's one-repo token (`workflows` only when opted in); the thread's mode is the gate, linked work included (owner, 2026-11-12, back to stock) | ADR-0013 (back-to-stock refinement); `docs/steps/stock.md` | done (stock) |
| PR list, detail, checks, comment, review | `ws.ts:2787-2874` | W, as the GitHub App, not the owner, by decision (D2) | Environment token (`packages/github-app/src/permissions.ts:39`); ADR-0013 (D2 refinement); stage `pbatch`: list, detail, checks, a comment and a comment-only review on fixture PR #4, read back in its activity (`docs/steps/parity-batch/prs.json`) | done (refusal of owner identity) |
| Starred repos, publish a repo | `ws.ts:2884`, `:2951` | R for now (D2): need an owner token | ADR-0013 (D2 refinement); a token pasted into t3's settings still works | done (refusal) |
| PR watch | `PullRequestWatchReactor` | W: while a live thread watches a pull request, each idle reset sets a PR-watch wake 10 minutes out (`env/host/idle.ts` `watchedPullRequests`, `PR_WATCH_WAKE_MS`); the alarm boots t3, its reactor sweeps, and the Environment resets a minute later unless the sweep woke an agent. Cost: one boot and one host read per watched PR every 10 minutes, while a watch lasts | stage `pbatch`: with no client, an alarm boot set the watch's `checksAwaitedSince` 2 s after the wake; a remark posted while asleep woke the thread's agent 2 s after the next wake (`docs/steps/parity-batch/prwatch-start.json`, `prwatch-check.json`) | done (G12) |
| Review guide | `srv/pullRequest/PullRequestReviewGuideService.ts:314` (`worktree add --detach`) | W on Codex: t3's own detached checkout runs in the project's Container at t3's path (`env/agents/scratch.ts`, the router), and Codex investigates it with `codex exec -s read-only` (`env/provider/cli/codexInvestigation.ts`). P: with `gpt-6-luna` the proxy refuses `codex exec` (SPI-1102); Claude cannot investigate yet (SPI-1103); Pi Durable answers t3's own "cannot investigate" | stage `pbatch`: the guide of fixture PR #4 on Codex with `claude-sonnet-5-5` (`docs/steps/parity-batch/guide.json`) | done (G7, SPI-998) |
| Discovery | `ws.ts:2728`; `srv/sourceControl/SourceControlDiscovery.ts:49`, `:57` | P: git and gh emulated; jj, glab and the rest "not found" (R: ADR-0024, ADR-0013) | `ghRouteOf` | done (refusal) |
| Host sign-in | `ws.ts:2880-2882` | R for GitHub (ADR-0013); other hosts M | `ghAuthStatus` always signed in | — G9 |

### Terminals, setup scripts, worktrees

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Terminal, setup scripts, worktree threads, deletion | `ws.ts:3224-3239`, `:3211` | W; documented differences: ends with the Environment, 8 shells, 3 Containers, full clones, no fast checkout | step-2b; ADR-0021, ADR-0008 | done |

### Previews

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Port discovery | `srv/preview/PortScanner.ts:338` (lsof); `ws.ts:3280` | W: each running Container's `/proc`, through its Workspace DO, never starting one; terminal and agent attribution as stock (owned servers only); stop by process group | `docs/steps/previews/browser.json` (listed as the terminal's, 8080 never listed, stop, not-found); `env/preview/portDiscovery.ts`; ADR-0031 | G11 (SPI-1002) |
| Server browser, dev-server preview | `srv/preview/ServerBrowser.ts:225`; route `srv/server.ts:800` | W, with P limits: pages are `http://<port>.t3flare.internal`, not a secure context; eight ports; downloads only those the page may fetch; an unwatched tab's browser ends at Browser Run's 10-minute keep-alive, and a profile changed by timers alone is saved at close or idle-retire, not while open (SPI-1123); two Workspaces on one port not stage-checked (SPI-1125) | `docs/steps/previews/browser.json` (frames over the stream route, 401 without a session, read-only vs operator input, HMR without reload, hostile page), `transfer.json` (download, upload), `profile.json`, `hold.json`, `idle-stop.json`, `boot-close.json`, `keepalive.json`, `hidden-panel.json`, `route-reach.json`; Shadow `ServerBrowserContexts`, Patch 0005; ADR-0031 | G11 (SPI-1002) |
| Agent browser tools | `preview_*` | W: offered while the owner's agent browser access is on (stock default); screenshots reach the Durable agent as images | `docs/steps/previews/agent.json` (Pi Durable: `preview_open`, `preview_snapshot`, `preview_act`, `preview_evaluate` over its own server; t3's API from the page: TypeError); Codex not exercised on a stage (SPI-1124) | G11 (SPI-1002, SPI-1104) |
| HTML visual replies | `srv/htmlRender/HtmlRender.ts` | W: stock `headlessChrome.ts` over a CDP bridge to Browser Run; pages are opaque-origin on the t3 host as stock; renders are `https://t3-page.t3flare.internal` (an `http:` resource is mixed content) | `m1-html-bridge.json`, `agent.json` (`html_preview` seen as an image, `html_render` published), `asset-headers.json` (L2), `html-hostile.json` (L1) | G11 (SPI-1002) |
| MCP apps | `ws.ts:2579-2582` | W† for Codex: the wrapper keeps `mcpApps`; the relay passes `_meta.ui`, `structuredContent` and `resources/read` of a declared `ui://` App; not exercised on a stage (SPI-1124). **P** for Claude (ACP has no App channel; stock's support is in its native-SDK adapter, O5); ordinary rows for OpenCode, Pi CLI and Pi Durable, as stock pi | `test/mcpHost.test.ts`, `test/mcpRelay.test.ts`; ADR-0028 refinement | G11 (SPI-1002) |
| Device hub | `srv/device/DeviceHubProxy.ts:241`; `ws.ts:3255-3278` | R; its settings (`enableDeviceSupport`, `enableAgentDeviceAccess`, `simlockDeviceHostsEnabled`) locked off (SPI-994) | unmounted; ADR-0024, ADR-0010, ADR-0023 | done (refusal) |
| Relay tunnel | `ws.ts:2762` | R | ADR-0010 | — |

### MCP, secrets

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| `/mcp` and OAuth for outside agents | `con/environmentHttp.ts:633-674` | W. Outside agents also see `preview_*`, `device_*` and `html_*` tools that cannot work here (SPI-1104) | stage `pbatch`: discovery, a 401 without a bearer, registration, a pairing code bound to approval-required, the token, `tools/list` (71) and `t3_project_list`; the session listed and revoked, then 401 (`docs/steps/parity-batch/mcp.json`) | done |
| t3's tools in Sessions | `srv/mcp/toolkits/` | W, direct and from code mode scripts: every tool t3 lists for the thread, less a short denylist of tools that cannot work here (`t3_attachment_*`, `t3_thread_send_attachments`, `html_*`, `preview_*`, `t3_preview_*`, `device_*`, `t3_worktree_*`; owner 2026-11-12, back to stock), with t3's guidance filtered to match (SPI-1060) | `apps/agents/src/extensions/t3-mcp.ts`, `packages/harness-registry/src/t3Tools.ts`; step 3 (`docs/steps/step-3/m2-stage.json`: `t3_thread_list`, `orchestrator_capabilities`, `delegate_task`, and `t3_thread_read` after a restart); `docs/steps/tools/m1-codemode.json` | done (3, tools, SPI-1060) |
| Code mode and tool search (Durable agent) | (Pi provider's codemode) | W: `codemode` in a sandbox Worker, `tool_search`, MCP tools deferred; nested calls as child items | ADR-0027; `docs/steps/tools/m1-codemode.json`, `m2-*.json` | done (tools) |
| t3's tools for CLI agents (Codex, Pi, Claude, OpenCode) | t3 hands its per-thread MCP bearer to the CLI's process | W as stock t3 does: t3's per-thread bearer in the CLI's process, at t3's public `/mcp` (owner, 2026-11-12, back to stock); t3's full tool list; F7 holds. OD-3 lifted | ADR-0022's tools refinement; `env/provider/cli/relayedMcp.ts`; `docs/steps/tools/m5-cli-*.json` | done (tools, SPI-1039) |
| Agent's own MCP servers | each CLI's config | W for remote servers: Commissary toolkits and Direct servers added in the Harness panel (header or OAuth sign-in), for Durable agents and Codex, Claude and OpenCode (the pi CLI: t3's tools only, deferred); local stdio R (ADR-0024) | ADR-0028; `docs/steps/tools/m4-*.json`, `m5-*.json`, `m6-*.json` | done (tools) |
| Secret store | — | W | `env/platform/secretStore.ts`; step 1 | done |
| 1Password provider | `t3code/packages/secret-provider-onepassword` (`op` CLI) | M; possibly later through the broker pattern (D5) | `op` "not found"; ADR-0012 (D5 refinement) | — |
| `request_secret` | `srv/mcp/toolkits/orchestrator/tools.ts:198`; `ws.ts:2376` | W for `secretRef` and pasted values (D5 lifted, owner 2026-11-12, back to stock); P: `delivery: "file"` lands in the Environment's State directory, which a Container cannot read | ADR-0022 and ADR-0012 back-to-stock refinements | done (stock) |

### Settings, notifications, links, auth

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Server settings | `ws.ts:2714` | W | seeds in `env/agents/seedSettings.ts` | done |
| Keybindings | `srv/keybindings.ts:208` | W | stage `pbatch`: a rule upserted, read back in `server.getConfig`, kept across a restart in place, removed (`docs/steps/parity-batch/keys.json`) | done |
| Storage page | `ws.ts:2701-2704` | W: the database row shows the Durable Object's real size (`SqlStorage.databaseSize`), nothing reclaimable, no repair (a reclaim request says why); t3's history compaction runs as stock. Storage cleanup reports as stock (nothing to clean in the State directory) | `env/t3/databaseStorage.ts` (a Layer over t3's `DatabaseStorage`); the SQL adapter still answers the refused PRAGMAs with 0 (U8); stage `pbatch2`: 3.06 MB shown, reclaim refused, a cleanup report (`docs/steps/parity-batch-2/storage.json`) | done (parity batch 2) |
| Browser notifications | `t3code/apps/web/src/threadNotifications.ts` | W for what the Environment provides: the client is served over HTTPS (a secure context), its notification sounds load, and a finished run reaches the shell stream. The browser's own prompt and toast were not driven | stage `pbatch` (`docs/steps/parity-batch/notify.json`) | done (server side) |
| Mobile push | `srv/relay/AgentAwarenessRelay.ts:56` | W: publish-only T3 Connect link; prod linked by the owner (A3, 2026-11-12: `publishAgentActivity` true, account token discarded) | `docs/steps/step-3plus.md` (`step-3plus/m2-publishes.json`: each run state published, `waiting_for_input` for an `ask_user` question; `m3-deliveries.json`: a push notification queued to the phone); SPI-1036; ADR-0025 | done (3+) |
| Laptop-to-cloud link | `srv/peer/PeerLinks.ts:89` | W: t3's own link from the laptop (stock npm `t3` and the desktop app), unchanged; the laptop's agent delegates to the cloud's Durable agent, follows the task, gets the result, and answers its questions; survives a laptop restart, a cloud restart mid-command, cancel and revoke | `docs/steps/step-3.md`; `docs/steps/step-3/m4-e2e-pinned.json`, `m4-e2e-desktop-version.json`, `m4-*-restart.json`, `m4-revoked.json`, `m5-desktop-*.png` (the owner's desktop); the bump job runs `acceptance --peer` | done (3) |
| Cloud-to-laptop link | `srv/peer/PeerLinks.ts:89`; `PeerLinkRequests.ts` | W: t3's own Outbound link, made in the Link dialog or on t3's link card, over a Route (T3 Connect, Tailscale Funnel, an own Cloudflare Tunnel); a Remote task survives the idle reset and the laptop's sleep. Stage-proved against a stand-in; owner proof open | ADR-0029, ADR-0011; `docs/outbound-link.md`; `docs/steps/spi-1061.md` | SPI-1061 |
| First pairing | `/api/auth/browser-session` | W (armed window) | ADR-0010 | done |
| More devices, sessions, revoke | `con/environmentHttp.ts:600-624` | W: later devices pair by pairing link, never the bootstrap token (ADR-0010, README; SPI-1006) | stage `pbatch`: a second device paired with a link the first minted, was listed, used `/ws`, was revoked and signed out; the first stayed signed in (`docs/steps/parity-batch/devices.json`) | done |
| Guest links | `srv/guest/http.ts:140`; `ws.ts:2372` | R; `guestSharingEnabled` locked off by the managed policy, so no client offers a link (SPI-994) | ADR-0010, ADR-0023; stage `truecaps`: the write is refused ("managed by t3flare") | done |

### Updates, telemetry, import, other

| Feature | Stock | t3flare | Evidence | Step |
|---|---|---|---|---|
| Server self-update | `ws.ts:2685`; `srv/cloud/selfUpdate.ts:161` | N/A: nightly bump and deploy | ADR-0017; `npmReleaseLookup` and the self-update flags stripped (SPI-994) | done |
| Product analytics | `srv/telemetry/AnalyticsService.ts:67-74` (on by default, `ingest.t3.codes`) | **Off** (D1): t3flare's managed policy sets `limits.telemetry: false` (SPI-995) | ADR-0023, README; `test/analytics.test.ts` (t3's service sends nothing under the policy); stage: `docs/steps/parity/spi-995-analytics.json` | done |
| OTLP export | `con/settings.ts:1017`; proxy route `srv/http.ts:335` | W as stock: the traces, metrics and logs URLs the owner saves in t3's settings are read at the Environment's boot (a change applies after its next restart, as on a laptop) and t3's own exporters send from the Durable Object every 10 s; t3's browser-trace forwarder is mounted. No `T3CODE_OTLP_*`/`OTEL_*` variables | `env/t3/otlp.ts`, `composition.ts`; stage `pbatch2`: a throwaway receiver Worker got 4 trace exports (828 and 1,000 spans of `t3code-server`) and 3 metric exports within 25 s; with the URLs cleared, none (`docs/steps/parity-batch-2/otlp.json`, `otlp-off.json`) | done (parity batch 2) |
| Import agent sessions | `srv/project/AgentSessionScanner.ts:217`, `:1196`; `ws.ts:3060` | R: no provider homes in the State directory | ADR-0024 | done (refusal) |
| Voice | `con/environmentHttp.ts:795-927` | R: local voice is host-bound (stripped); W: cloud voice, with the key typed into t3 (D5 lifted, owner 2026-11-12, back to stock) | `capabilities.ts`; ADR-0024, ADR-0012 | done (stock) |
| Triage, host diagnostics | `ws.ts:2745`, `:2734-2738` | R (host-bound) | `triage` stripped (SPI-994); ADR-0024 | done (refusal) |

## 2. Gaps no planned step covers, in dependency order

| # | Ticket | Size | Key risk |
|---|---|---|---|
| G1 | ~~**Attachments and images reach Durable agents.**~~ Done (SPI-993): `apps/environment/src/provider/attachments.ts`. The user message's attachments are t3's own, so the differ has nothing to echo. Follow-ups: SPI-1027 (shrink large images), SPI-1028 (SnapShot context). | S | Bound: a DO SQLite row (2 MB) per Session message |
| G2 | ~~**Truthful capabilities.**~~ Done (SPI-994, SPI-1012): every capability classified in `env/t3/capabilities.ts` (a new one fails typecheck and a test); settings of refused features locked by t3flare's managed policy (ADR-0023). | S | Client behaviour varies by nightly |
| G3 | ~~**Telemetry Layer**, per D1.~~ Done (SPI-995): a managed-policy limit, not a Layer of its own (ADR-0023). | S | None |
| G4 | ~~**Scratch threads**: the scratch root becomes a Workspace.~~ Done (parity batch): Patch 0004 roots the No project folder at the Workspace `/w/t3-scratch` ([`docs/steps/parity-batch.md`](steps/parity-batch.md)). | S–M | Root is private to t3's runtime graph: it took a fourth Patch (one line) |
| G5 | ~~**Owner-facing plan mode and live output**~~ Done (SPI-996, SPI-1055): the toggle, `propose_plan` as t3's proposed plan and Implement, todos, streamed command output, prompt suggestions ([`docs/steps/spi-996.md`](steps/spi-996.md)). Follow-up: SPI-1099 (Worker Shell output arrives at exit). | M | pi-durable has no plan primitive: a tool stands in, as Claude's `ExitPlanMode` |
| G6 | ~~**Fork and rollback**~~ Done for Pi Durable (SPI-997, SPI-987): native fork and conversation rollback in the Session, with t3's checkpoint restore ([`docs/steps/spi-997.md`](steps/spi-997.md)). SPI-1100 fixed the CLI agents' checkpoints and turned ACP rollback on ([`docs/steps/spi-1100.md`](steps/spi-1100.md)). Follow-ups: SPI-1101 (Todo List and Notes after a rollback; documents in a fork), SPI-1037 (ACP fork). | M | t3 needs rollback to return a snapshot: the provider thread, as t3's Pi adapter does |
| G7 | ~~**Review guide**: a real detached worktree inside the project's Container.~~ Done (SPI-998, parity batch): t3's checkout runs as written in the project's Container; t3's `FileSystem` only makes and removes the scratch directory, answered by a registry. Follow-ups: SPI-1102 (gpt-6-luna), SPI-1103 (Claude). | M | t3 may read the scratch path through `FileSystem` |
| G8 | ~~**Usage meters.**~~ Done (SPI-999, parity batch 2): from Commissary's management API, optional, owner-provisioned ([`docs/steps/parity-batch-2.md`](steps/parity-batch-2.md)). t3's `cliproxy` source cannot read Commissary (no `/v0/management`). | M | An org-admin management key in the Environment Worker |
| G9 | ~~**GitHub as the owner, and other hosts** (after D2).~~ Not now: D2 keeps GitHub App-only and GitHub-only (ADR-0013 refinement, SPI-1004). | M per host | Loosens ADR-0013's per-repo scope |
| G10 | **Skills and the agent's own MCP servers** (after 3 and 4a). MCP servers: done (tools step, ADR-0028). Skills: Repo skills and Prompt templates done for Pi Durable (SPI-1147, [`docs/steps/spi-1001.md`](steps/spi-1001.md)); Environment skills SPI-1148; the CLI agents' composer entries done (SPI-1151, [`docs/steps/spi-1151.md`](steps/spi-1151.md)); Environment skills for them SPI-1153. A repository's own skills, hooks and MCP servers now load in Claude Code and OpenCode (owner, 2026-11-12, back to stock). | M | ADR-0016 |
| G11 | ~~**Previews**~~ Built (SPI-1002, ADR-0031, [`docs/steps/previews.md`](steps/previews.md)): t3's browser and HTML renders in Browser Run, `localhost` routed to the thread's Container, ports from each Container's `/proc`, MCP apps through the relay. Not a secure context, eight ports. | L | Browser Run hours; a watched tab holds the Environment |
| G12 | ~~**Webhook origin and PR-watch wake.**~~ Done (parity batch): hook URLs on the public t3 host; the idle reset wakes for PR watches every 10 minutes ([`docs/steps/parity-batch.md`](steps/parity-batch.md)). | S | Every hook wakes the DO |
| G13 | ~~**ACP registry agents**~~ Done as a refusal (SPI-1003, parity batch 2): listed with each agent's standing, installs refused; the four that fit ADR-0016 are already built in. Lifting ADR-0016 A′ for env-key agents is the owner's call. | S–M | Each agent needs a proxy base URL and a key helper |

OTLP export: done (parity batch 2).

## 3. Refused by design: where each refusal is written down

Already documented, no action:
- Guest links, relay tunnel, Tailscale (ADR-0010).
- Provider sign-in (ADR-0012).
- Open folder, fast checkout, git worktrees (ADR-0008).
- Stale reads (ADR-0009).
- Terminal lifetime (ADR-0021).
- Thread transfer (ADR-0011). Cloud-to-laptop links are built (SPI-1061, ADR-0029).

Written down (SPI-1004, SPI-1006):
1. **Host-bound features**: [ADR-0024](adr/0024-host-bound-features-are-refused.md) (device hub and simulators, local voice, open in editor, host diagnostics and power, triage, jj, agent-session import, server self-update, provider install and update).
2. **Server browser and agent browser access**: not refused (D4). Built under G11 (SPI-1002, ADR-0031); the device hub stays refused (ADR-0024).
3. **Vendor-login CLIs**: refused (D3), [ADR-0015](adr/0015-cli-agents-run-through-platform-exec-codex-in-managed-mode-claude-and-opencode-over-acp.md) refinement.
4. **`t3_attachment_*` withheld from Durable agents** (`request_secret` offered again since D5 was lifted, owner 2026-11-12, back to stock): [ADR-0022](adr/0022-durable-agents-reach-t3s-mcp-through-the-environment-do-with-t3s-own-credential.md) refinement. Keys typed into t3 (D5): [ADR-0012](adr/0012-all-model-access-goes-through-the-model-proxy.md) refinement.
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
- **D5** Keys typed into t3 (cloud voice, custom text generators, `request_secret`): **refused for now**; 1Password possibly later via the broker pattern. **Lifted** (owner, 2026-11-12, back to stock): they work as in stock t3.
- **ADR-0016** CLI agents get the Commissary key by an on-demand helper, never in env or on disk (option A′).
