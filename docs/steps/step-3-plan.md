# Step 3: plan (Peer links: the laptop delegates to the cloud; t3's MCP tools in Sessions)

Date: 2026-11-11. Branch `step-3`, from `main` at 7a4e4f1. t3code pinned at `v0.1.9-nightly.20261111.4515` (24e7747).
The owner's desktop app on this machine is T3 Code (Nightly) **0.1.10-nightly.20261111.4529**, a day ahead of the pin.
cloudpid read at `~/src/cloudpid` (read only).

This is a plan to review, not a report; nothing in it is built yet. Owner decisions and actions are in §12: one
decision, which does not block the start, and one session at the owner's desktop near the end.

## Changelog: owner decision and independent review (Fable), 2026-11-11

These override the plan below where they conflict. Each is verified against the code as its milestone reaches it;
the verdicts and any rebuttals, with evidence, are in the report (`docs/steps/step-3.md`, § Review findings).

- **D1 = option 2 (owner).** Linked work may `git push` the project's repo, but **every push from a thread with a
  `linkOrigin` needs its own approval**; "accept for session" never covers it. Enforced where pushes happen (C3), and
  tested with a project whose `main` push would deploy.
- **C1 (HIGH). Mode fixes before links.** `auto-accept-edits` and `auto` carry the same link scopes
  (`contracts/src/auth.ts:268-278`), and our adapter maps `auto` to full access. F-modes and F-plan move into **M1**;
  nothing turns links on (L1) before they are in. The fail-closed mapping (G3) lands on `main` from a separate branch
  (`modefix`); step 3 rebases onto it and builds F-plan on it, without duplicating it.
- **C2 (HIGH). `ask_user` across an Environment restart.** A request waiting at a restart blocks the continuation
  (`RestartContinuation.ts:63-74`), so the cloud run ends and the laptop follower completes the task from the
  cancelled run's last reply (`RemoteDelegation.ts:634-647`). Prod restarts on every push to main. New M4 case:
  "Environment restart while `ask_user` waits on a delegated task". The question is re-raised from the Session's
  stored ask (preferred); otherwise the result names the restart.
- **C3 (HIGH). D1 enforced where pushes happen.** The Container token is per Workspace (`WorkspaceDO.ts:1073-1077`)
  and a remote task runs in the project's shared checkout (`RemoteDelegation.ts:217`). The credential helper's token
  route asks a fresh approval whenever the requesting thread has a `linkOrigin`, every time.
- **C4 (MEDIUM). Per-tool approvals.** Approval kinds are only `command` and `file-change`
  (`session-protocol/src/index.ts:186`, `permissions.ts:146`), and "accept for session" is per kind. Add an
  `mcp-tool` kind, accepted per tool name: "always allow" on `delegate_task` never unlocks `bash`, nor the reverse.
- **C5 (MEDIUM). G2 is not a hole.** t3 refuses a grant that is not one-time at `/oauth/mcp/decision`
  (`EnvironmentAuth.ts:1362-1379`; our bootstrap is a `desktop-bootstrap` grant). L2 stays as defence in depth; R11
  is dropped. F11 asserts the DO's refusal body, and a test shows t3 alone answers `not_a_pairing_code`. The harness
  mints codes with `access` (`EnvironmentAuth.ts:1147-1149`); a plain code carries the standard scopes
  (`auth.ts:150-162`), so the linking side could pick full access (`:1379`): the cap is tested.
- **C6 (MEDIUM). Version skew.** The bump job also runs a forwarded launch from a stock `npx t3@<latest nightly>`;
  R3 is rerun just before M5 (the owner's desktop: `0.1.10-nightly.20261111.4529`).
- **C7 (LOW).** `EnvironmentDO.mcp` boots without a synthetic request (`#publicHost` stores the request's host,
  `environmentDO.ts:231-240`): as `sessionPush`, boot and await `commandReady`.
- **C8 (LOW).** The Session's MCP credential works on the public `/mcp` for 24 h idle: it stays out of `snapshot()`,
  pushes and `/_t3flare/agents/session`, and those join the leak check.
- **C9 (LOW).** `clientRequestId` holds across Session restarts but not across a credential re-issue
  (`ProviderSessionManager.ts:476-535`): tested. Waits are chunked at 50 s from the start.
- **C10 (LOW).** F3 belongs to M2 and F7 to M3, each with an exit.

**Exit criterion (from `docs/plan.md`).** A laptop agent delegates to the cloud, follows the task and gets the result;
the cloud child can report and ask; the link fence holds.

**In one paragraph.** t3 already ships the whole laptop-to-cloud contract, and our composition already mounts it: a
**Peer link** is the laptop's t3 server signing in to the cloud's `/mcp` with MCP OAuth and a pairing code from the
cloud; `delegate_task` with `target.environmentId` launches an ordinary thread there through the link, and a follower on
the laptop waits on it and hands its last reply back as the task's result; work a link starts below full access is
fenced by `linkOrigin`. So the link needs **no new routes, Shadows or Patches**: the laptop stays stock, and the cloud
gains a seeded setting, one more path in the bootstrap refusal, and tests. The real work is on our side of the cloud:
the Durable agent (Pi Durable) must **use t3's MCP tools** (t3 already issues every Pi Durable thread a provider-session
credential that nothing reads), it must **ask** (it has no structured questions today), and it must **honour the modes
the link narrows it to** (today an unknown runtime mode fails open to full access, and plan mode is ignored). Sessions
reach `/mcp` through the Environment DO, never over the public host and never from a Container. Proof comes from a
two-server end-to-end test on this machine (a stock `t3` server from npm at the pinned version as the laptop), runnable
without the owner, and one demo from the owner's desktop app.

## 1. What t3 does today (read in the pinned submodule)

Paths are under `t3code/`. Prose docs: `docs/internals/remote.md` (§ Peer links), `docs/user/remote-access.md` (§ Link
another environment), `docs/orchestration-v2/orchestrator-mcp-server.md`.

### 1.1 Making a link

- The link is **from** the environment the user works on **to** a peer; the peer "needs nothing new: it sees one more OAuth
  client" (`docs/internals/remote.md:72-77`). `PeerLink` (`packages/contracts/src/peerLink.ts:12-22`) keeps the peer's id,
  label, URLs, the chosen `access`, and `expiresAt`.
- `PeerLinks.link` (`apps/server/src/peer/PeerLinks.ts:460`):
  1. refuses unless **Linked environments** (`settings.linkedEnvironmentsEnabled`, a Labs beta) is on here (`:461`);
  2. `GET /.well-known/t3/environment` on each address (`describe`; 3 s loopback, 10 s otherwise), keeping only
     addresses that answer as the expected environment id;
  3. refuses plain `http` except loopback or Tailscale (`peerOrigin`, `:151`), and follows no redirect;
  4. refuses a peer whose descriptor lacks `capabilities.mcpModeLimitHeader` and `linkFence` (`linkLimitsHold`, `:183`);
  5. signs in (`signIn`, `:278`): `POST /oauth/mcp/register` with `software_id: "t3code-peer-link"` and the redirect
     `http://127.0.0.1/t3code-peer-link` (`:47`), `POST /oauth/mcp/decision` with `{_tag: "pairing-code", access, code}`
     and PKCE, `POST /oauth/mcp/token`;
  6. keeps the token in its own secret store and the row in `peer_environment_links`.
- On the peer (the cloud): registration of a peer-link client is refused while Linked environments is off there
  (`apps/server/src/auth/McpOAuth.ts:343`). The pairing code is a **bootstrap grant**, a one-time pairing credential
  (`EnvironmentAuth.consumeMcpApprovalCode`, `apps/server/src/auth/EnvironmentAuth.ts:1362`), minted by an already-paired
  client at `POST /api/auth/pairing-token` (`packages/contracts/src/environmentHttp.ts:600`). Authorization codes live
  in memory for 60 s (`McpOAuth.ts:55`, `:269`). The token is an **MCP client session**, a 30-day bearer token
  (`EnvironmentAuth.ts:79`) signed with the `peerLink` marker (`McpOAuth.ts:615`); there is no refresh grant, so a
  link is renewed with a new pairing code. It is revoked on the cloud in Settings → Sharing & access.
- **No DPoP on this leg.** DPoP binds the browser and desktop clients' sessions (`McpOAuth.ts:420`, `dpop:` holders);
  the link is a bearer token, protected by HTTPS-only addresses and the identity check above.
- **The UI.** On the laptop: Settings → Labs → Linked environments, then Settings → Environments → Linked environments
  → Link, pick the machine and the access. If the app is connected to that machine with a session that manages access
  there, it mints the pairing code itself (`docs/user/remote-access.md:333-340`). CLI: `t3 environment link <address>
  --pairing-code <code> --access <mode>` (`apps/server/src/cli/environment.ts:85`). An agent can also ask for a link
  with `t3_environment_link`, which shows a card (`PeerLinkRequests.ts`).

### 1.2 Calling over a link

- `PeerMcpClient.call` (`apps/server/src/peer/PeerMcpClient.ts`): `POST {url}/mcp` with `Authorization: Bearer`, MCP
  protocol `2025-06-18` (`:22`), one MCP session per peer kept in memory; a **404 re-initialises** (the peer restarted,
  `:184`), a 401 is final ("revoked"), a 403 means Linked environments is off there and is retried (`:137`, `:196`).
- Every call carries the calling agent's modes in `T3-Mode-Limit: <runtimeMode>/<interactionMode>` (`:162`), which the
  peer only ever narrows with (`McpInvocationContext.clientModeCeiling`, `apps/server/src/mcp/McpInvocationContext.ts:79`).
- `PeerForwarding` (`apps/server/src/peer/PeerForwarding.ts`): a tool whose parameters take `environmentId` runs there;
  retry keys are hashed with the caller's namespace (`:119`); attachments are refused (`:140`); a wait goes out in
  **50 s pieces** (`FORWARDED_WAIT_CHUNK_MS`, `:33`) because the peer sends nothing while it waits; **linked work
  never uses its environment's own links** (`callerLimits`, `:106`), so links do not chain.

### 1.3 Delegating to a linked environment

`RemoteDelegation` (`apps/server/src/peer/RemoteDelegation.ts`), all on the laptop:

1. `delegate_task` with `target.environmentId` needs an active parent run (`delegate`, `:189`). `isolation: "worktree"`
   is refused (`:217`): a remote task runs in the matching project's checkout there. Another provider needs
   `target.model` (from `orchestrator_capabilities` with that `environmentId`).
2. The project there is the one whose repository identity (`canonicalKey`) matches the parent's, found with
   `t3_project_list` over the link, or `target.projectId` (`resolveRemoteProject`, `:143`).
3. `t3_thread_launch` there with the task as `message`, a scoped `clientRequestId`, and `delegatedFrom` (the laptop
   thread, so the cloud thread shows where it came from).
4. The parent records `delegated_task.remote.request` (`:300`) with `remoteChild` and driver `remote`.
5. A follower per open task (`followOnce`, `:545`) calls `t3_thread_wait` with `untilDelegatedWorkSettled: true`
   (`:615`), up to 10 min per look (`:47`), then reads the result run's **last assistant reply** whole with
   `t3_thread_read` (`lastReply`, `:444`) and completes the task with `delegated_task.remote.complete`; the parent wakes
   as for a local child.
6. `task_cancel` and a parent Stop send `t3_thread_interrupt` with `stop: true` there; open tasks are followed again at
   startup (`start`, `:770`), so a laptop restart or sleep only delays the result. A 401 (revoked), a forgotten link or
   a vanished thread fails the task with that reason; anything else retries with back-off up to 5 minutes.

The alternative, also stock, is `t3_thread_launch` (or `t3_thread_send`, `t3_thread_wait`, …) with `environmentId`: an
ordinary thread there, followed by the agent itself. It is the way to get a Worktree Workspace for remote work.

### 1.4 Reporting and asking

- **Report.** The child's final reply is the task's result (above). Progress is readable on demand with `task_status`
  and `t3_thread_read` with `environmentId`, and is live in any client attached to the cloud.
- **Ask.** A child's `user_input` request (a structured question) is answerable by an agent with `t3_pending_request`
  (`apps/server/src/mcp/toolkits/thread/tools.ts:127`), which forwards with `environmentId`. It **cannot answer an
  approval**; approvals belong to a person in a client attached to the environment that holds them. For a local child,
  `DelegatedTaskQuestionReactor` wakes the parent on a question; **for a remote child it does not**
  (`apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts:36`: no `childThreadId`). So on the laptop a
  remote child's question reaches the owner, not the parent agent, unless the parent looks. This is upstream's gap; we
  draft the ask (§12).

### 1.5 The link fence

- A link paired **below full access** stamps everything it starts with an immutable `linkOrigin` (the link's session
  and access); subagents, forks and `create_threads` inherit it (`docs/internals/remote.md:113-131`).
- `apps/server/src/mcp/linkOrigin.ts`: a fenced caller (a link client, or a thread carrying `linkOrigin`,
  `callerLinkOrigin`, `:19`) may change only threads with the same origin (`assertSameLink`, `:44`) and may not change
  projects, settings, scheduled tasks or use this environment's links (`assertNotLinked`, `:55`). Reads are not fenced.
  The rules run in the shared access declarations of `apps/server/src/mcp/McpToolAccess.ts` (`writes` `:145`,
  `writesThreads` `:176`, `startsThreads` `:231`, `writesEnvironment` `:288`), not tool by tool.
- Fenced threads skip project setup scripts (`apps/server/src/project/ProjectSetupScriptRunner.ts:371`,
  `skipped-for-link`).
- Modes: a launched thread may not be broader than the link's access, narrowed by `T3-Mode-Limit`.
- "The link is routing, not isolation": an agent the link starts runs as the receiving environment's user, and a
  **full-access link is not fenced** (`docs/internals/remote.md:142-146`).

### 1.6 t3's MCP tools for its own agents

- Before a provider session opens (and on attach), `ProviderSessionManager.prepareMcpSession`
  (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:476-545`, called at `:1446` and `:2456`) issues a
  **provider-session credential** from `McpSessionRegistry` (`apps/server/src/mcp/McpSessionRegistry.ts:97`): a bare
  random bearer, scoped to the thread, provider instance and session, with capabilities `orchestration`, `worktree`,
  `pull-requests` (plus `preview`/`device` per the agent-access settings) and a `subagent` flag. It is kept **in
  memory** (24 h idle window, `:65`) and stored for the adapter in `McpProviderSessions` (`packages/provider-core/src/
  server/McpProviderSessions.ts`). `configureMcp` defaults on, so **our Pi Durable threads are issued one today**.
- `/mcp` accepts a registry token or an OAuth client token (`apps/server/src/mcp/McpHttpServer.ts:197-249`); a linked
  client while Linked environments is off gets 403 (`:189`).
- Adapters read the credential per turn (`mcpSessions.read(threadId)`; Codex:
  `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:1416-1423`). t3's
  **Pi** provider puts it in the pi process's environment (`T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`:
  `packages/provider-pi/src/server/mcpInjection.ts`, `buildPiRpcLaunch`) and loads a bridge extension
  (`mcpExtensionSource.ts`) that lists `tools/list`, registers each tool as `mcp__t3-code__<name>` (`:394-440`; only
  `orchestrator_capabilities`, `delegate_task` and `task_status` direct when tool search exists), asks approval for
  every tool not annotated read-only unless full access (`:353-373`), and adds t3's orchestration instructions to the
  system prompt (`T3_CODE_ORCHESTRATION_INSTRUCTIONS`, `packages/provider-core/src/server/orchestrationInstructions.ts:27`).
- t3's Pi adapter turns pi's `select`/`input`/`editor` dialogs into `user_input` runtime requests
  (`packages/provider-pi/src/server/adapter.ts:1536-1586`, `piQuestion` `:3626`).

### 1.7 What our cloud already has, and what it lacks

- **Mounted already** (`apps/environment/src/t3/composition.ts:685-720`): t3's whole `EnvironmentHttpApi` (auth,
  MCP OAuth, `/.well-known/*`), `McpHttpServer.layer` with `McpOAuth.layerMcpClientAuthenticator`, `PeerLinks`,
  `PeerMcpClient`, `PeerForwarding`, `PeerLinkRequests`, `RemoteDelegation` (started), `McpSessionRegistry` (`:767`),
  `McpProviderSessions` (`:631`). The front door forwards `/api`, `/oauth`, `/.well-known`, `/ws` and `/mcp` to the
  Environment DO (`apps/environment/src/worker.ts:25`). The descriptor keeps `mcpModeLimitHeader` and `linkFence`
  (`ServerEnvironment.ts:289-290`; our composition strips only four other capabilities). Step 0 mounted `/mcp`; nothing
  has called it since.
- **Gaps found while reading:**
  - G1. `linkedEnvironmentsEnabled` is off by default, so the cloud refuses a link's registration and answers its calls
    with 403.
  - G2. The bootstrap refusal (`apps/environment/src/environmentDO.ts:64`) covers `/api/auth/browser-session` and
    `/oauth/token`, but `/oauth/mcp/decision` also spends a bootstrap grant (§1.1). Outside the armed window, the
    bootstrap token presented there as a "pairing code" is not refused by us.
  - G3. `runtimeModeOf` (`apps/environment/src/provider/adapter.ts:65`) maps any mode other than `approval-required` and
    `auto-accept-edits` to **full-access**: `auto`, or anything new, fails open. (t3's Pi maps `auto` to
    approval-required: `mcpInjection.ts`, `buildPiRpcLaunch`.)
  - G4. The adapter ignores `interactionMode`, so a child narrowed to `plan` by its link or its parent edits anyway.
  - G5. The Session neither reads its credential nor has tools for `/mcp` (`supportsMcpTools: false`,
    `apps/environment/src/provider/capabilities.ts:49`), and has no way to ask a question
    (`supportsStructuredQuestions: false`).
  - G6. `enableAgentBrowserAccess` adds `preview` to the credential, but the cloud has no browser.

## 2. The link

### 2.1 What runs on the laptop

The owner's stock T3 Code desktop app and the server it bundles; nothing of ours. The owner turns on Labs → Linked
environments on the laptop, adds the cloud as an environment (already done for prod; done again for `step3`), and
links it from Settings → Environments → Linked environments with an access below full access (§12, A1). The desktop
mints the pairing code through its own session with the cloud, so nothing is pasted. For tests, the laptop is a stock
`t3` server from npm at the exact version under test (`npx t3@0.1.9-nightly.20261111.4515 serve`, and the desktop's
`0.1.10-nightly.20261111.4529`), in a temporary base directory on this machine (§6, M0).

### 2.2 What the cloud exposes, and how auth works

Exactly what is public today (ADR-0010); no route is added:

| Request (from the laptop) | Route | Auth | WAF limit (prod) |
|---|---|---|---|
| Identity check before linking and before every call | `GET /.well-known/t3/environment` | none (public descriptor) | no |
| Register the link's OAuth client | `POST /oauth/mcp/register` | none; refused while Linked environments is off | yes |
| Spend the pairing code | `POST /oauth/mcp/decision` | the pairing code (one-time, minted by a paired client) | yes |
| Exchange the code | `POST /oauth/mcp/token` | PKCE | yes |
| Every tool call | `POST /mcp` | the link's bearer (30 days), `T3-Mode-Limit` | no |
| The owner mints the code (desktop, or our scripts) | `POST /api/auth/pairing-token` | the owner's session (access-write scope) | no |
| The owner revokes the link | `POST /api/auth/clients/revoke` | the owner's session | no |

A link costs three rate-limited `POST`s, well inside 10 per 10 s; a link lasts 30 days. Throwaway stages have no
domain and so no WAF rule (ADR-0010); only prod's limit is real, and nothing in the link flow comes near it.

Changes on the cloud side:

- **L1. Seed Linked environments on** (G1): a Layer beside `layerPinFastWorktreeCheckoutOff`
  (`apps/environment/src/agents/seedSettings.ts`) that sets `linkedEnvironmentsEnabled: true` once, recording that it
  did in DO KV, so an owner who turns it off in the cloud's Labs keeps it off. Linking is what the cloud is for (ADR-0011).
- **L2. Refuse the bootstrap token at `/oauth/mcp/decision` and `/oauth/mcp/approval`** outside the armed window (G2):
  add both paths to `BOOTSTRAP_EXCHANGE_PATHS`; the body check already looks for the raw and URL-encoded token. Plain
  pairing codes minted by a client are unaffected.
- **L3. Pin agent browser access off** (G6), as the fast worktree checkout is pinned off: the cloud has no browser, so
  `preview_*` should not be offered.

**In-memory state and resets** (ADR-0003: the Environment DO resets itself when idle). The laptop's follower calls at
least every 50 s while a remote task is open (a run is open then anyway, so nothing new keeps the DO up), and the
cloud resets after the task ends and the laptop stops calling. What a reset loses, and why it is harmless:

- the MCP transport's sessions: the laptop gets a 404 and re-initialises (`PeerMcpClient.ts:184`);
- pending OAuth codes (60 s): a reset in the middle of a sign-in fails it; the owner links again;
- registry tokens: a Session's credential dies with its provider session; ADR-0004 already ends the turn, and the
  next turn carries a fresh one (§4.1).

The link's own session (SQL, `SessionStore`) and the signing secrets (DO KV) survive resets and deploys, as pairing
already does.

### 2.3 Shadow and Patch cost

None expected: **Patches 2, Shadows 1, unchanged.** New Layers: L1, L3. Everything else is our own code (the front
door, the Environment DO, the adapter and differ, the Session).

## 3. Delegation end to end

### 3.1 The sequence

1. **Link** (once a month): §2.
2. The owner, on the laptop, asks an agent (Codex, Claude, Pi, …) to hand a task to the cloud. Following t3's own
   instructions, the agent calls `t3_environment_links`, then `orchestrator_capabilities` with the cloud's
   `environmentId` (it lists Pi Durable and its proxy models), then `delegate_task` with
   `target: { environmentId, providerInstanceId: "piDurable", model }`.
3. Laptop → cloud: `t3_project_list` (repository match; the cloud project must exist, and with a fenced link the laptop
   cannot create one, §5), `t3_thread_launch` (stamped `linkOrigin`, `delegatedFrom`, modes capped by the link and
   `T3-Mode-Limit`).
4. Cloud: an ordinary thread in that project's Workspace; t3 opens a Pi Durable provider session (issuing its MCP
   credential), the adapter submits the turn to the Session DO, and the Durable agent works as in steps 2a and 2b.
5. Laptop: the parent's task card shows the remote task (`remoteChild`, the link's label); the follower waits in 50 s
   pieces.
6. **Report:** the owner watches the cloud thread live in the same desktop app (it is attached to both Environments,
   ADR-0011); the parent can call `task_status` or `t3_thread_read` with `environmentId`.
7. **Ask:** the child calls `ask_user` (§3.2) → a `user_input` request on the cloud thread, shown in the owner's
   client and answerable there or by the parent with `t3_pending_request` and `environmentId`. A tool approval in the
   child is an approval request on the cloud thread, answered only by the owner in a client.
8. **Result:** the run settles (with its delegated work); the follower reads the last reply and completes the task on
   the laptop; the parent wakes with it.
9. **Cancel:** `task_cancel` or Stop on the laptop → `t3_thread_interrupt stop: true` on the cloud → the adapter aborts
   the Session's turn and part 2's kill runs.

Nothing here is a protocol of ours: steps 2, 3, 5, 8 and 9 are t3's on both ends; 4, 6 and 7 are our provider doing
what a t3 provider does.

### 3.2 What the Durable agent needs for this (cloud side)

- **Modes it is given, honoured** (G3, G4): §5.2.
- **A way to ask**: a Session tool `ask_user` (one question, optional options, optional free text). It waits durably,
  as approvals do (`apps/agents/src/extensions/permissions.ts`'s `ApprovalStore`: kept in storage, survives a Session
  restart, `api.progressed` on each wait). The Session pushes it as a pending request of kind `question`; the differ
  opens a t3 `user_input` runtime request with its questions (the shape of `piQuestion`); the adapter's answer for it
  carries `answers` to the Session (`answer` gains `answers`). Capabilities: `planning.supportsStructuredQuestions:
  true`. A Stop withdraws it; an Environment restart withdraws it as an approval is today (ADR-0004 refinement).
- **t3's MCP tools** (§4), so a cloud child can itself delegate inside the cloud, read threads, list projects, and so on.

### 3.3 Restarts and outages

| Event | What happens | Proved in |
|---|---|---|
| The laptop sleeps or its server restarts mid-task | The cloud run continues; the follower resumes at startup (`RemoteDelegation.start`) and completes the task | M4 |
| The cloud Environment resets (idle) or a deploy restarts it mid-wait | The laptop's call fails or 404s; it retries and re-initialises; ADR-0004 continues the cloud run | M4 |
| The cloud's Session restarts | Unchanged from step 2a (the turn resumes; a waiting `ask_user` or approval waits again) | M3 |
| The link is revoked in the cloud | 401 → the laptop fails the task with "revoked", stops following | M1, M4 |
| Linked environments turned off in the cloud | 403 → retried; the task finishes when it is back on | M1 |

### 3.4 Other kinds of cloud agent later

The cloud side of delegation does not depend on the provider: a remote task names `providerInstanceId`, and step 4's
CLI agents become more entries in `orchestrator_capabilities`. Their MCP injection is t3's own (Codex's
`mcp_servers`, ACP's `mcpServers`), pointed at an endpoint reachable from the Container; that is step 4's question, and
§4.6's rule (no credential in a Container) is the constraint it inherits.

## 4. t3's MCP tools in Sessions

### 4.1 The credential

- t3 issues it (§1.6); we do not mint anything. The adapter reads `McpProviderSessions.read(threadId)` at `openSession`
  and at every `submitTurn` and sends `{ authorization, providerSessionId }` with the command (`OpenInput` and
  `SubmitTurnInput` in `packages/session-protocol` gain an optional `t3Mcp`). The Session keeps the latest one in its
  DO storage (KV), never in the Workspace and never in a Container.
- A 401 from `/mcp` (the Environment restarted, the session was released) is a tool error the model sees ("T3's tools
  are unavailable until the next turn"), never retried in a loop.

### 4.2 The transport

The Session calls the Environment DO directly: a new `EnvironmentDO.mcp(request)` RPC (body, `authorization`,
`mcp-session-id`, `mcp-protocol-version`) that builds a `Request` for `/mcp` and hands it to t3's HTTP app as `fetch`
does, so t3's own auth middleware and tool access run unchanged. Never the public host (no WAF, no DNS, no TLS hop),
never a held socket (ADR-0005's rule), and it counts as an in-flight request for the idle reset, so a long
`t3_thread_wait` keeps the Environment up only while it is held. MCP session ids are kept in Session memory; a 404
re-initialises, as `PeerMcpClient` does.

### 4.3 The catalog and the extension

- **Per thread.** `tools/list` depends on the caller (capabilities, `hiddenFromSubagents`, `hiddenWhileLinksOff`), so
  each Session lists with its own credential at open and when its credential changes, and keeps the catalog and its
  hash in storage.
- **One `t3-mcp` pi-durable extension**, built from the catalog and installed again when the hash changes, as cloudpid
  does (`~/src/cloudpid/docs/adr/0030-mcp-tools-reach-a-session-as-an-extension-rebuilt-from-the-mcp-inventory.md`).
  Names are t3's own, `mcp__t3-code__<tool>`, so t3's tool presentation (`packages/shared/src/t3McpToolPresentation.ts`)
  and pending-work detection recognise them. Parameters come from the catalog's JSON schemas.
- **Allowlist** (fail closed: a tool t3 adds later is not offered until a bump adds it, and the bump's acceptance run
  lists what was left out):

  | Offered | Not offered in step 3, and why |
  |---|---|
  | orchestration: `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`, `t3_workflow_stop`, `t3_background_wait`, `create_threads`, `t3_thread_list/read/update/send/wait/interrupt`, `t3_pending_request`, `t3_queue`, `t3_thread_search/organize/configure/transfer`, `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now` | `request_secret`: its value or file is for a shell, which is a Container (§4.6) |
  | projects: `t3_project_list/read/create/update/delete/clone`, `t3_thread_launch` | `t3_attachment_*`: an upload URL used from a shell is a credential in a Container |
  | pull requests: `link_pull_request(s)`, `unlink_pull_request(s)`, `list_thread_pull_requests`, `watch_pull_request`, `unwatch_pull_request`, `read_pull_request_guide`, `write_pull_request_guides` | `preview_*`, `html_*`, `device_*`: no browser or device in the cloud |
  | environment: `t3_environment_read`, `t3_environment_links` | `t3_environment_link`, `t3_environment_unlink`: cloud-to-elsewhere links are deferred (ADR-0011) |
  | | `t3_worktree_handoff/status/list`: t3's worktree handoff runs git the router has not been audited for; revisit with a test |

- **Instructions:** a `t3_orchestration` section with t3's `T3_CODE_ORCHESTRATION_INSTRUCTIONS`, sent by the adapter
  with `t3Mcp` (so the agents Worker imports nothing of t3), present only while the extension is installed.
- **Approvals**, as t3's Pi bridge decides (`mcpExtensionSource.ts:353-373`): a tool annotated `readOnlyHint` never
  asks; in `full-access` nothing asks; otherwise the call asks through `permissions`, with the tool name and its
  arguments as the summary. In `plan`, only read-only tools run (§5.2). t3 then applies its own mode ceiling server side.
- **Replay safety.** pi-durable reruns a call cut off by a Session restart. When the model omits `clientRequestId` on a
  tool that takes one, the extension sets it to the call's task id, so a rerun returns the same durable work; such
  tools and read-only ones are marked replay-safe, and the others error on rerun as pi-durable does for unsafe tools.
- **The differ** shows the calls as t3's MCP tool items (server `t3-code`); `tools.supportsMcpTools: true`.

### 4.4 Settings this relies on

L3 (browser access off). Device access is already off by default; the allowlist drops both anyway.

### 4.5 Local delegation in the cloud

With §4.3 a cloud Durable agent can `delegate_task` to another Pi Durable child in the cloud (an app-owned subagent,
lineage `subagent`, `isolation: "worktree"` giving it a Worktree Workspace). `ContainerBudget` still caps Containers at
3; a refusal reaches the child's `bash` as today.

### 4.6 Secrets never reach a Container

- The credential lives in the Session's DO storage and memory; tool calls run in the Session (a Worker), never in
  `bash`. No `T3_MCP_*` variable is ever put in a Container's environment (unlike t3's Pi provider, whose process is
  local), and the Container env stays the allowlist of `computer-env` and part 2b's terminal base env.
- Excluded tools (§4.3) are the ones whose purpose is to hand a secret to a shell.
- The link's token lives on the laptop only; the cloud holds a hash of the MCP client session (t3's `SessionStore`).
- Proof (M2, M4): after turns that called t3 tools and answered a delegated task, a leak check reads the Container's
  `env`, every `/proc/*/environ`, and the Workspace's files for the Session's credential, the link's token, the proxy
  key, the GitHub tokens and the admin and bootstrap tokens, as step 2b's terminal check did: 0 found.

## 5. The fence

### 5.1 What the cloud child may and may not do

For work a link starts **below full access** (the owner's choice at linking; §12 recommends auto-accept-edits):

| Target | May | May not | Enforced by |
|---|---|---|---|
| The laptop | nothing | reach it at all | there is no route: the cloud has no link to the laptop (ADR-0011), linked work cannot use links (`PeerForwarding.ts:106`), the Session offers no link tools (§4.3), and the laptop is not publicly addressable |
| Its own thread and threads its link started | everything t3 allows, within its modes | | t3 (`assertSameLink`) |
| The owner's cloud threads, and other links' threads | read them | send, steer, interrupt, configure, rename, archive, transfer | t3 (`assertSameLink`), both through the link client and through the child's own Session credential (the calling thread carries `linkOrigin`) |
| Projects, environment settings, scheduled tasks | read | create, change, delete; clone a project | t3 (`assertNotLinked`) |
| Setup scripts | | run them | t3 (`skipped-for-link`) |
| Modes | the link's access, narrowed by the parent's modes | exceed them; `plan` means read-only | t3 at launch (ceiling); **ours** in the Session (§5.2) |
| Approvals | ask for them | approve them: `t3_pending_request` cannot, and the laptop parent has no other way | t3 and our Session (approvals are answered only through a client's `respondToRequest`) |
| Its Workspace's files and its `bash` | work in the project's checkout | other Workspaces' files | ours: a Session's tools are bound to its thread's Workspace (ADR-0008) |
| GitHub | push and fetch the project's one repo with a Container token, after approval in approval-required | other repos; workflows unless opted in | ours (ADR-0013); see §12, D1 |
| Credentials | | read any (§4.6) | ours |

A **full-access link is not fenced** (t3's rule): the owner chooses it knowingly, and it behaves like the cloud's own
agents. That is tested as the documented exception, not as a hole.

### 5.2 Where t3's fence ends and ours starts

t3 enforces the fence in its MCP tools and setup-script runner, all of which run stock in the Environment DO. It cannot
enforce what a provider does with the modes it is handed, so the Durable agent provider must:

- **F-modes.** Map runtime modes **closed**: `approval-required` and `auto-accept-edits` as now, `full-access` only by
  name, and anything else (t3's `auto`, a future mode) to approval-required (G3). Unit-tested on the adapter.
- **F-plan.** Pass `interactionMode` with every turn (G4). In `plan`, the Session adds t3's plan-mode instruction text,
  refuses `edit` and `write` and every non-read-only MCP tool with a fixed message, and asks approval for every `bash`,
  even in full access (bash cannot be classified as read-only). Unit-tested in `permissions`, and deployed in M3.
- **F-tools.** The Session's allowlist (§4.3) is fail-closed.
- **F-bootstrap.** L2.
- **F-scope.** The Session's credential is t3's per-thread one, so the child acts as its own thread (fenced by its
  `linkOrigin`), never as the link client and never as the owner.

### 5.3 Tests that prove it holds

All run against the `step3` stage by `acceptance.ts --peer` (deterministic: the harness plays the laptop, §6 M1), and
the starred ones also through the real two-server path (M4):

| # | Check | Expected |
|---|---|---|
| F1* | A link at auto-accept-edits launches a thread; through the link, and from inside that thread's own agent, send to / interrupt / rename an owner's cloud thread | `capability_denied` ("…started from <label> through a linked environment…") |
| F2 | Through the link: `t3_project_create`, `t3_project_clone`, `t3_environment_preferences_update`, `schedule_task` | `capability_denied` |
| F3 | From the linked thread's agent: `t3_environment_links` / a forwarded call | `capability_denied` (linked work uses no links); the Session catalog has no `t3_environment_link` |
| F4 | `t3_thread_launch` through the link with a worktree strategy on a project with a setup script | the Worktree Workspace is provisioned and the setup stage is `skipped-for-link` |
| F5* | Link at auto-accept-edits, laptop agent in full access, task with `bash` | the cloud thread runs at auto-accept-edits and its `bash` waits for approval |
| F6 | `T3-Mode-Limit: approval-required/plan` on the launch | the thread runs in plan: an `edit` is refused, `bash` asks |
| F7* | `t3_pending_request respond` through the link on the child's pending approval | refused (cannot approve); the owner's approval through the cloud client works |
| F8* | Leak check (§4.6) after a delegated task | 0 secrets in the Container's env, `/proc`, Workspace files |
| F9* | Revoke the link in the cloud | the next call is 401; the laptop's task fails with the revocation |
| F10 | Linked environments off in the cloud | 403; the task completes after it is turned back on |
| F11 | `/oauth/mcp/decision` with the bootstrap token, unarmed | 401 from the Environment DO (L2) |
| F12 | The same F1 calls through a **full-access** link | allowed (t3's documented exception) |
| F13 | An owner's own cloud thread (no `linkOrigin`) does the F1/F2 calls through its Session tools | allowed (no regression) |

## 6. Sub-milestones (riskiest first)

All deploys go to a throwaway stage `step3`, added to `STAGES` in `apps/environment/scripts/stage.ts` in M0's first
commit and destroyed at the end. `prod` is never deployed, run against or destroyed. Evidence goes in
`docs/steps/step-3/`.

### M0. Settle the unknowns (about one day)

Nothing user-facing; each item is a probe script and a JSON file, and each outcome may change a later milestone.

- **R1, MCP in workerd.** A harness signs in to `step3` as an outside MCP client (approval code from
  `/api/auth/pairing-token`) and as a peer-link client (`software_id: t3code-peer-link`), then `initialize`,
  `tools/list`, `t3_project_list`, `t3_thread_read`, a 50 s `t3_thread_wait`; the response shapes (JSON or one SSE
  event), `mcp-session-id`, a 404 after an admin restart, a 403 with Linked environments off. (`m0-mcp.json`)
- **R2, the laptop server.** `npx t3@0.1.9-nightly.20261111.4515 serve` headless in a temporary base directory and
  port on this machine; turn Linked environments on through `server.updateSettings`; `t3 environment link
  https://<step3> --pairing-code <minted> --access auto-accept-edits`; `t3 environment list` shows it reachable.
  (`m0-laptop-link.json`)
- **R3, version skew.** The same with `t3@0.1.10-nightly.20261111.4529`, the owner's desktop version, plus forwarded
  `t3_project_list`, `t3_thread_launch` and `t3_thread_wait` decoding on that version. (`m0-skew.json`)
- **R4, repository match.** A cloud project cloned from `ian-pascoe/t3flare-fixture`, a laptop project on a local clone
  of it: the cloud's `t3_project_list` over the link reports the same `repositoryIdentity.canonicalKey` as the laptop.
  (`m0-repo-identity.json`)
- **R5, re-installing an extension.** A Node test on the faux-provider Harness (as step 2a's approval test): install
  `t3-mcp`, run a call, install it again with a changed catalog, resume a task that used the old one.
- **R6, the laptop agent.** t3's Pi provider on the npm laptop server, pointed at the model proxy (pi's `models.json` in
  an isolated agent directory; the key from the environment, never printed), runs one turn that calls
  `orchestrator_capabilities`. (`m0-laptop-agent.json`)

Exit: the six JSON files; a one-paragraph decision for each fallback taken (§8).

### M1. The link, hardened, with the fence proved at the MCP level

- L1 (seed), L2 (bootstrap paths), L3 (browser access off).
- `scripts/lib/peer.ts`: a linking-environment harness in TypeScript (the three OAuth steps of `PeerLinks.signIn`, an
  MCP session with `T3-Mode-Limit`, 404 re-initialisation, 50 s wait pieces), used by the acceptance test and M4.
- `acceptance.ts --peer`: link; `t3_thread_launch` with `delegatedFrom` on Pi Durable (a short real turn, as
  `--real-turn`); wait in pieces; read the last reply; F1 (link side), F2, F4, F9, F10, F11, F12.
- The npm laptop server links to `step3` and runs forwarded calls by hand (`t3_thread_launch` with `environmentId`
  through its own MCP as an outside client), confirming the harness matches the real client.

Exit: `m1-acceptance-peer.json` (all rows pass), `m1-laptop-forwarded.json`. Tests: unit for L2's path set and L1's
once-only seed.

### M2. t3's MCP tools in Sessions

- Adapter: `t3Mcp` on open and submit; the instructions text.
- `EnvironmentDO.mcp` RPC.
- Session: credential in storage, catalog per thread, the `t3-mcp` extension (allowlist, names, approvals, replay
  safety, rebuild on change), the instructions section.
- Differ: MCP tool items; `supportsMcpTools: true`.

Exit, from the stock web client on `step3`: a Pi Durable thread calls `orchestrator_capabilities`, `delegate_task`s a
task to a Pi Durable child in the cloud with `mode: "wait"` and uses its result; `t3_thread_list` and `t3_thread_read`
work; an approval-required thread asks before `delegate_task` and not before `t3_thread_read` (`m2-local-delegate.json`,
`m2-*.png`). An Environment restart, then a new turn: the Session gets a fresh credential and its tools work
(`m2-restart.json`). Leak check: 0 (`m2-leak.json`). F1 and F13 from inside a Session (`m2-fence-session.json`).

Tests: unit (catalog → tools, allowlist, `mcp__t3-code__` names, approval policy per mode and annotation,
`clientRequestId` injection, rebuild on a changed hash); Node on the faux Harness (an MCP call through a fake
`EnvironmentDO.mcp`, a Session restart mid-call rerunning with the same `clientRequestId`, a 401 as a tool error);
workerd: the agents Worker's Session with the extension installed and a stub Environment, so the bundle and the
extension load in workerd.

### M3. Asking, and the modes the link hands down

- `ask_user` in the Session; `question` requests in the push; the differ's `user_input` requests; answers through the
  adapter; `supportsStructuredQuestions: true`.
- F-modes (fail closed) and F-plan.

Exit: a cloud thread's question answered in the web client (`m3-question.json`, `m3-question.png`) and through
`t3_pending_request respond` by an MCP client (`m3-question-mcp.json`); a Session restart while the question waits,
then the answer arrives (`m3-question-restart.json`); F5 and F6 (`m3-modes.json`). Tests: unit for `runtimeModeOf`
(every t3 mode, an unknown string → approval-required), `permissions` in plan, the differ's question mapping (open,
answer, withdraw on Stop), the Session's durable wait (Node, faux Harness).

### M4. Delegation end to end, two servers, without the owner

`scripts/peer-e2e.ts`, on this machine, against `step3`:

1. Start the npm laptop server (pinned version, then the desktop's version), pair to it, turn Linked environments on,
   configure its Pi provider on the proxy (R6), add a project on a local clone of the fixture repo.
2. Link it to `step3` at auto-accept-edits with a code the harness mints.
3. Start a laptop thread whose prompt makes its agent `delegate_task` (async) to the cloud's Pi Durable with a task
   that (a) calls `ask_user`, (b) runs a `bash` command, (c) replies with a nonce and the command's output.
4. The harness answers the question **from the laptop side** (an outside MCP client of the laptop server calling
   `t3_pending_request respond` with the cloud's `environmentId`, so it is forwarded over the link) and approves the
   `bash` **as the owner** on the cloud (the cloud's WebSocket, as a client).
5. Checks: the laptop task has `remoteChild` and completes with the nonce; the parent wakes with the result; the cloud
   thread carries `linkOrigin` and `delegatedFrom`.

Variants (each its own run): `task_cancel` on the laptop stops the cloud thread and kills its `bash`
(`m4-cancel.json`); the laptop server killed and restarted mid-task, the task still completes (`m4-laptop-restart.json`);
an admin restart of the cloud Environment mid-wait, the task completes (`m4-cloud-restart.json`); a revoked link fails
the task with the reason (`m4-revoked.json`); after the task ends and the laptop stops, the cloud Environment resets
when idle (`m4-idle.json`). F8 leak check (`m4-leak.json`).

Exit: `m4-e2e-pinned.json`, `m4-e2e-desktop-version.json` and the variants. If R6 failed in M0, steps 3–5 use
`t3_thread_launch` with `environmentId` driven through the laptop's MCP instead (following, the question and the result
the same way), and `delegate_task` is proved only in M5.

### M5. The owner's desktop, acceptance in the bump job, documents, close

- **The demo (owner, about 20 minutes, §12 A1):** the owner's desktop app links to `step3`; a laptop agent of the
  owner's choice delegates a fixture task to the cloud; the owner watches the cloud thread, answers its question,
  approves its `bash`, and sees the result arrive in the laptop thread. Screenshots `m5-desktop-*.png`. This also
  settles whether the desktop surfaces a pending request from another environment (R7).
- `acceptance.ts --peer` joins the nightly bump (`scripts/bump.ts`), so every bump re-proves the link contract and
  F1–F12 against the `bump` stage.
- Report `docs/steps/step-3.md`, ADRs and glossary (§10), README status, the plan row. Destroy `step3`; remove the
  `step3` environment and its link from the desktop (or the owner does, A1).

## 7. Tests, summarised

| Kind | What |
|---|---|
| Unit | L1 once-only seed, L2 paths, `runtimeModeOf` fail-closed, plan mode in `permissions`, the catalog → extension (allowlist, names, approvals, `clientRequestId`), the differ's MCP items and `user_input` requests |
| Node (faux Harness) | extension re-install (R5), MCP calls replayed after a Session restart, `ask_user`'s durable wait |
| workerd | the Session with `t3-mcp` installed against a stub Environment; L2 in the Environment DO's request path |
| Acceptance (`--peer`, deployed, also nightly) | the link's OAuth steps, forwarded launch, wait and read, F1–F4, F6, F9–F12 |
| Two-server e2e (deployed, this machine, no owner) | `delegate_task` laptop → cloud with question, approval, result, cancel, restarts, revocation, leak check; on the pinned and the desktop versions |
| Owner demo | the stock desktop app end to end |

`bun run check` passes at every commit; the e2e and acceptance runs are scripts, not part of `check` (they need a stage).

## 8. Risks and unknowns

| # | Risk | Settled by | Fallback |
|---|---|---|---|
| R1 | Effect's MCP HTTP transport has never answered in workerd (mounted since step 0, never called) | M0 probe | a Layer or Build shim for what fails; a Shadow of the transport only if it must |
| R2 | The laptop server cannot run headless here | M0 | run it from a clean worktree of the submodule (never the submodule's own tree) |
| R3 | **Version skew**: the owner's desktop is a nightly ahead of the pin, and decoding is strict ("Update both environments") | M0 with both versions | bump the pin (ADR-0017's job) before the demo; the bump job's `--peer` run catches later breaks |
| R4 | The cloud project's repository identity does not match the laptop's through the router | M0 | the laptop agent passes `target.projectId` (stock); fix the router's answer if cheap |
| R5 | pi-durable 1.5.0 cannot re-install an extension at runtime | M0 test | the catalog is fixed for a Session's lifetime and rebuilt only when the Session opens (the catalog changes only with a pin) |
| R6 | t3's Pi provider cannot be pointed at the proxy headless, so the e2e has no laptop agent | M0 | M4 drives `t3_thread_launch` through the laptop's MCP; `delegate_task` proved in the demo |
| R7 | A remote child's question does not wake the laptop parent (t3, `DelegatedTaskQuestionReactor.ts:36`), and whether the desktop notifies for another environment's pending request is unknown | M5 demo | the parent can poll `t3_pending_request` with `environmentId`; upstream ask (§12) |
| R8 | Long tool calls held Session → Environment (`delegate_task` wait up to an hour) and their reruns | M2 tests | `clientRequestId` injection; a cap on wait timeouts in the extension if reruns misbehave |
| R9 | A remote task runs in the cloud project's root checkout, shared with the owner's cloud threads on it | by design (t3 refuses worktree isolation for remote tasks) | documented; `t3_thread_launch` with a worktree strategy for isolation |
| R10 | Delegated work competes with the owner's for the 3 Containers | budget refusal reaches the child's `bash` | documented; no change |
| R11 | The bootstrap grant could be spent at `/oauth/mcp/decision` outside the window (G2) | L2, F11 | |
| R12 | Modes fail open (G3) or plan is ignored (G4) | M3, F5, F6 | |

## 9. Budget: Patches, Shadows, Layers

Patches 2 and Shadows 1, unchanged; Build shims unchanged unless R1 needs one. New Layers: the Linked environments seed
(L1) and the browser-access pin (L3). New code of ours: L2 in the Environment DO, `EnvironmentDO.mcp`, the adapter's
`t3Mcp`, `interactionMode` and fail-closed modes, the differ's MCP items and questions, the Session's `t3-mcp`
extension and `ask_user`, `scripts/lib/peer.ts`, `acceptance.ts --peer`, `scripts/peer-e2e.ts`.

## 10. ADR and glossary changes (written with the report)

- **New ADR-0022**, "Durable agents reach t3's MCP through the Environment DO with t3's own provider-session
  credential, and no part of it enters a Container": the transport, the per-thread catalog as an extension, the
  fail-closed allowlist, approvals as t3's Pi bridge, `clientRequestId` for replay; options considered: the public
  `/mcp` from the Session, a static catalog bundled from t3's toolkits, the credential in the Container like t3's Pi.
- **ADR-0011 refinement**, as built: the link is t3's, unchanged on the laptop; Linked environments seeded on in the
  cloud; no new routes; the fence additions of §5.2; remote tasks share the project's checkout.
- **ADR-0010 refinement**: `/oauth/mcp/decision` and `/oauth/mcp/approval` join the bootstrap refusal; a link is a
  30-day MCP client session, revocable in Sharing & access.
- **ADR-0004 refinement**: a question waiting in a Session behaves as an approval does across restarts.
- **GLOSSARY**: **Link fence** (what work a link starts below full access may change, t3's and ours); **Remote task**
  (a delegated task whose child thread is in another Environment); **Linked work** (threads carrying a link's
  `linkOrigin`). The **Peer link** entry stays.

## 11. Leaving room for 3+ (T3 Connect, publish only)

- Nothing here uses or removes the relay pieces our composition keeps (`RelayClient`, `CloudLink`); the link goes over
  the public host, and a Connect address could later join a `PeerLink`'s `urls` without changing anything here.
- 3+'s notification ("a cloud run ends or waits on the owner") reads t3's run status and runtime requests; M3 makes a
  Durable agent's question a real t3 request, so 3+ needs no provider work for "waits on the owner".
- No owner-visible setting introduced here would need to change for Connect.

## 12. Owner decisions and actions

### Decision (does not block the start; needed before M4)

- **D1. May work a link starts below full access push to GitHub?** t3's fence covers T3's tools, not the agent's shell
  ("the link is routing, not isolation"), so a fenced cloud child can `git push` the project's repo with the
  Workspace's Container token, after an approval when its mode asks. **Default: yes, as t3** (approvals gate it in
  approval-required, and the token is one repo without workflows). The alternative withholds the Container token from
  linked work below full access, so its changes come back only as the task's reply and the cloud diff, and the owner
  pushes. Say which; the default is built if nothing is said.

Decided here, not asked: Linked environments seeded on in the cloud (L1); the step 3 allowlist (§4.3); `ask_user`
added to Durable agents; plan mode enforced in the Session.

### Actions

- **A1 (M5, at the owner's desktop, about 20 minutes).** In T3 Code (Nightly): add the `step3` environment from the
  pairing link I give you; turn on Settings → Labs → Linked environments; Settings → Environments → Linked environments
  → Link → pick `step3` → access **auto-accept-edits** (the desktop makes the pairing code); in a laptop thread on the
  fixture repo, ask your agent to delegate the task I give you to the cloud; answer the cloud thread's question,
  approve its `bash`, and check the result lands in the laptop thread. Afterwards remove the `step3` environment and
  forget its link (Settings → Environments). If you prefer, I can drive the desktop app on this machine instead, with
  your go-ahead (it spends a turn or two of your laptop agent's subscription).
- **A2 (after merge, optional).** Link the desktop to prod (`t3.ianpascoe.dev`) the same way. Links last 30 days;
  renew from the same screen.
- **A3 (with the report).** Send the upstream ask I draft in `docs/upstream/`: a remote task's child question should
  wake its parent, as a local child's does (`DelegatedTaskQuestionReactor.ts:36`).
- Nothing else needs your machine: M0–M4 run on this machine with the npm `t3` server as the laptop, and read the
  proxy key from the environment at run time without printing it.
