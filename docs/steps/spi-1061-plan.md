# Plan: SPI-1061, the Outbound link (cloud agents start and drive threads on the Laptop Environment)

Status: design accepted by the owner on 2026-11-12; every decision in §2 is settled, both escalations included (E1 and E2: yes). **The plan must still pass a Fable review before M1**, as SPI-1061 asks. Folds in SPI-1060.

Terms are GLOSSARY's: **Outbound link**, **Inbound link**, **Outbound work**, **Outbound send**, **Send permit**, **Registered machine**, **Route**. Decisions are recorded in [ADR-0029](../adr/0029-the-outbound-link-is-the-owners-to-make-capped-at-supervised-and-every-send-over-it-waits-for-the-owner.md) and ADR-0011's SPI-1061 refinement.

## 0. Summary

- The Cloud Environment links to the Laptop Environment with t3's own Peer link, unchanged. t3's peer services have been mounted since step 0; nothing in the t3code tree changes (Shadows 2, Patches 3, as today).
- The laptop is reached over one or more **Routes** the owner registers: its T3 Connect address, his own Cloudflare Tunnel behind Access, or Tailscale Funnel. Each is an https address and a pairing code, so t3's link is the same over all three. The cloud holds no T3 Connect account for any of them; ADR-0010 (outbound only) and ADR-0025 (publish-only link) stand.
- The new thing in prod is a credential: a 30-day bearer for the laptop's `/mcp`, in the Environment DO's secret store. Everything t3flare adds exists to bound what that bearer can be used for:
  - only the owner makes the link, and only to a machine registered behind Access;
  - the link is capped at `approval-required`;
  - every Outbound send waits for a card of its own;
  - reads over the link reach only threads the cloud started;
  - only the owner's threads use it, never Linked work.
- Two items land on `main` before anything else: the SPI-1060 fix (Pre-A) and a fail-closed refusal of outbound links (Pre-B). The rest builds after the `tools` step merges, because it uses that step's cards, relay and panel.

## 1. What the code has today

Verified at the pin (`t3code/`) and on `main`.

| Fact | Where |
|---|---|
| t3's peer stack is mounted in the cloud: `PeerLinks`, `PeerLinkRequests`, `PeerForwarding`, `PeerMcpClient`, `RemoteDelegation` (followers start at boot) | `apps/environment/src/t3/composition.ts:77-81, 722-732` |
| `peerLinks` is a kept capability; Linked environments is seeded on | `t3/capabilities.ts:76`; step 3, L1 |
| **"Deferred" is not enforced.** t3's `peerLinks.link` WS RPC answers any client with `access:write`, for any https address. Only the agent tools `t3_environment_link`/`unlink` are withheld | `t3code/packages/contracts/src/clientRpcPermissions.ts:76`; `apps/agents/src/extensions/t3-mcp.ts:32` |
| A link needs an http(s) address and a pairing code; it checks the descriptor's environment id, signs in by MCP OAuth without a browser, and keeps a bearer (about 30 days, no refresh) in `ServerSecretStore` | `t3code/apps/server/src/peer/PeerLinks.ts` |
| `unlink` deletes the row and the bearer here; it does not revoke the session on the peer | `PeerLinks.ts:100, 605-609` |
| Every tool with an `environmentId` target forwards through `PeerForwarding.call`; `PeerForwarding` is the only user of `PeerMcpClient`; `RemoteDelegation` uses `PeerForwarding` | `t3code/apps/server/src/mcp/McpToolAccess.ts:378-405`; `peer/PeerForwarding.ts:95, 149`; `peer/RemoteDelegation.ts` |
| Followers retry every failure except `capability_denied`, `thread_not_found` and `run_not_found` | `RemoteDelegation.ts` `isFinal` |
| **A full-access Inbound link is not barred from this Environment's links**: `assertNotLinked` only stops links paired below full access | `t3code/packages/contracts/src/orchestrationV2.ts:128` (`linkOriginIsFenced`); `mcp/linkOrigin.ts` |
| **t3's read tools are not fenced over a link** | `mcp/linkOrigin.ts` ("Reads are not fenced") |
| **Reads never ask on the laptop in `approval-required`**: ACP providers allow every read at any path; Codex gets `approvalPolicy: "untrusted"` with a `readOnly` sandbox; Claude gets permission mode `default`. A thread is not confined to its project directory | `t3code/packages/provider-acp/src/server/clientPolicy.ts:86`; `orchestration-v2/Adapters/CodexAdapterV2.ts:728`; `ClaudeAdapterV2.ts:2845` |
| `approval-required`, `auto-accept-edits` and `auto` carry the same scopes (read, operate); only `full-access` adds settings and source-control write | `t3code/packages/contracts/src/auth.ts:258-277` |
| The stock client's Link dialog mints the pairing code on the target with `scopes: mcpClientScopes(access)`, default `approval-required`; the CLI takes `--scope` | `t3code/packages/client-runtime/src/state/peerPairingCode.ts:103`; `apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx:210-217`; `apps/server/src/cli/auth.ts:92` |
| The idle reset does not count an open Remote task | `apps/environment/src/host/idle.ts` |
| t3's orchestration guidance is the constant `T3_CODE_ORCHESTRATION_INSTRUCTIONS`, handed to the Session by our adapter and rendered as the `t3_orchestration` prompt section. It names `t3_environment_link`, `request_secret`, `html_*`, `preview_*` and `device_*`, none of them offered | `t3code/packages/provider-core/src/server/orchestrationInstructions.ts`; `apps/environment/src/provider/adapter.ts:122`; `apps/agents/src/session/SessionDO.ts:321`; `apps/agents/src/extensions/t3-mcp.ts:222` |
| The laptop publishes a link-started thread's phases to the phone like any top-level thread, `waiting_for_approval` included (no filter on `linkOrigin`) | `t3code/apps/server/src/relay/AgentAwarenessRelay.ts`; `packages/contracts/src/relay.ts:22` |

Assumed for the Routes and still to be looked up (round 4): how a strictly-public fetch to a same-zone, Access-protected, tunnel-backed hostname is judged; that `cloudflared` passes `Host` and sets `X-Forwarded-Proto`; that Tailscale Funnel does the same, works with the macOS app in use, and publishes its hostname in certificate logs.

Researched, public (coordinator): T3 Connect's tunnel hostname is stable, in the relay operator's zone, and carries plain HTTP, so pairing, bearer and MCP OAuth work on it; Cloudflare answers 530 while no origin is connected; a Worker's fetch to another account's zone is ordinary internet traffic; Quick Tunnels do not support Server-Sent Events.

## 2. Decisions

All settled: the owner approved the ledger on 2026-11-12. Each is the interview's answer of the same number (D1 is Q1, and so on). "Over" names the strongest alternative rejected.

| Id | Decision | Why, and over what |
|---|---|---|
| **D1** | **Reach the laptop over Routes the owner registers:** its T3 Connect tunnel hostname (E1: yes), his own Cloudflare Tunnel, or Tailscale Funnel (D22–D24). The cloud links out only to a Registered machine (its Routes and its environment id, set behind Access); with none registered, no link can be made or used. | Each Route is an https address plus a pairing code, so the cloud needs no T3 Connect account and t3's link is unchanged over all three. Over one fixed transport with the others as fallbacks: the owner asked for all three as supported. |
| **D2** | **Only the owner makes the link.** `t3_environment_link`/`unlink` stay off every agent's allowlist. The policy (machine, highest access) is set behind Access; the link itself may be made from the panel or from the stock client's Linked environments dialog, since S4 holds the policy on both. | The pairing code must come from the laptop, so making a link is already gated there. Over t3's agent-asked card: the code never enters the transcript, but the agent picks the moment, the reason, the address and the access, and one tired click makes a 30-day credential. |
| **D3** | **Hard cap at `approval-required`**, `read-only` the owner's only other choice. `auto-accept-edits` is not offered. Held at link time (S4), on every call (S3) and by the pairing code's scopes. | Scopes cannot tell `approval-required` from `auto`, so the cloud must hold the cap; an unasked edit in a checkout is a later command. Over a panel switch up to `auto`: raising the cap should follow use (ticket). |
| **D4** | **Every Outbound send waits for a card of its own**, in every runtime mode, with nothing remembered. **Forwarded reads reach only Outbound work**, plus the laptop's project list and environment description. The rules are enforced where calls leave the Environment, not only where agents ask. | The laptop's approvals never see reads, and the reply returns to the cloud. Over gating sends only at the Session's tool wrap: any path without a gate would send freely. |
| **D5** | **Only the owner's threads use the link**: Durable agents, and CLI agents once the SPI-1039 relay lands. t3flare refuses Linked work itself, whatever the link's access. | t3's `assertNotLinked` leaves laptop → cloud → laptop open for a full-access Inbound link. Over relying on t3's rule and telling the owner never to pair a full-access laptop link. |
| **D6** | **Lifecycle:** the bearer stays in the Environment DO's secret store; never renewed automatically; Unlink deletes it here and the panel tells the owner to revoke the session on the laptop. Expiry shows in the panel, in the stock client's link list and as the tool error the agent reports. No phone push for expiry. A Route's Access service token is kept the same way and joins the leak scan (D23). | t3 has no refresh grant and no peer-side revoke. Over a synthetic thread whose phase change would push the expiry to the phone. |
| **D7** | **An open Remote task is work.** While the laptop answers, the Environment stays up; while it does not, the Environment may reset and an alarm retries, backing off to about 30 minutes. No give-up timer: the task ends by completion, the owner's cancel, or the link expiring or being revoked. | t3 has no waiting state, so giving up early means failing the task and losing its result; staying up costs about $0.0056 an hour. Over stopping after N hours unreachable. |
| **D8** | **SPI-1060:** filter t3's guidance by bullet at prompt build, where the offered catalog is known; classify every tool name in the guidance and in the offered tools' descriptions, as capability flags are classified; add one line of our own. | It is our own code that hands the guidance over, so no Layer, Shadow or Patch. Over a Patch to t3's instructions file. |
| **D9** | **Terms:** Inbound link, Outbound link, Outbound work, Outbound send, Send permit. No "Owner machine": Laptop Environment already names it. | Over naming the directions by machine, which breaks when a second machine is linked. |
| **D10** | **ADRs:** a new ADR-0029 for the credential and its rules; a refinement of ADR-0011 for the direction and reachability. | Over folding everything into ADR-0011, which would bury the credential decision under a reachability title. |
| **D11** | **Five seams, S1–S5** (§3). The send check sits in typed Layers over t3's peer services, not in the `HttpClient` Layer. S5's requests leave from the tools step's MCP Worker, which is strictly public (D23). | The `HttpClient` cannot see the calling thread, and its refusals read as transport errors that followers retry for ever. Over a wire-level check of `tools/call` bodies. |
| **D12** | **The card** reuses SPI-1040's mechanism and SPI-992's conventions (§5). An answer to a laptop thread's question is a send; listing pending requests is a read. | One mechanism the owner already knows. Over raising the card inside t3's tool handler, which would hold a Durable Object RPC for the whole wait. |
| **D13** | **Build after `tools` merges**, as a panel section over an admin-route JSON API. Pre-A and Pre-B land on `main` now. | Prod today lets any `access:write` client link it to any https address. Over a minimal admin route first, rebuilt later to the panel's conventions. |
| **D14** | **The pairing code is minted without settings or source-control scopes** (the stock Link dialog does so; `t3 auth pairing create --scope` by hand). Between `approval-required` and `auto`, the laptop's defence is the access recorded at link time; the runbook has the owner confirm "Supervised" in the laptop's Sharing & access. | Over an access-bound "app approval" code, which t3 refuses for a link. |
| **D15** | **No cloud-side notice for laptop approvals.** The laptop's own T3 Connect publishes them; the cloud's publish-only link already reports the send card. Documented. | Over the cloud polling laptop thread state to raise a notice of its own. |
| **D16** | **Stage runs use a throwaway stock `t3` in a Docker container**, never as the owner's user on the MacBook. A stage accepts its stand-in's hostnames from stage configuration; prod accepts each Route kind's own hostname form (D22). One owner proof at the end (§9). | Threads the stage starts would otherwise run against the owner's real home directory, hostile prompts included. |
| **D17** | **Hostile tests H1–H20** (§8). | |
| **D18** | **What the owner sees is t3's own** (§6.4): the card and the remote task item in the cloud, a thread marked "From" on the laptop. Stopping never asks. | Over a separate Outbound work list in the panel beyond a count. |
| **D19** | **Two switches.** Per machine, default off; and one global "Outbound links off". While either is off nothing leaves, follower polls included, and open Remote tasks fail with that reason. Switching off does not stop threads already running on the laptop. | Over a pause that keeps tasks waiting, which leaves followers holding the Environment up. |
| **D20** | **Milestones Pre-A, Pre-B, M0–M7** (§7). | Over building alongside `tools`: M2, M3 and M5 sit on its cards, relay and panel. |
| **D21** | **The stage stand-in is exposed by a named Cloudflare Tunnel** the stage's alchemy stack creates (§10), with two hostnames on it: one behind Access with a service token, one open (D25). | Quick Tunnels do not support SSE, cap in-flight requests and change address per run. Over proving that t3 answers peer calls with JSON only, which a bump could change. |
| **D22** | **A Registered machine has an ordered list of Routes,** at most one of each kind: `t3-connect`, `cloudflare-tunnel`, `tailscale-funnel`. Each is one https origin; a `cloudflare-tunnel` Route also has an Access service token. S4 hands t3 the registered origins in the owner's order, whatever addresses the client offered, and S5 allows exactly those origins. t3 keeps the ones that answered as the machine when the link was made and uses the first that answers on each call. | t3 already stores several addresses per link and tries them in order (`PeerLinks.link`, `resolve`), so several Routes cost no new mechanism and survive one transport being down. Over one Route per machine: simpler, but a reclaimed T3 Connect tunnel or a relay outage then stops Outbound work. |
| **D23** | **`cloudflare-tunnel`: Access is required in front on prod,** with a Service Auth policy and a service token the cloud sends as `CF-Access-Client-Id`/`-Secret`, only to that Route's origin. Before a link is made over it, the cloud checks that the address does not answer as t3 without the token. **All peer HTTP leaves from the tools step's MCP Worker** (`global_fetch_strictly_public`), so a hostname in prod's own zone goes through Cloudflare's front door and Access, and a stage proves what prod does. The token is typed into the panel, write-only (E2: yes). | Behind Access the laptop answers nothing anonymous, which is the reason to run one's own tunnel; an open one is T3 Connect's exposure without its convenience. The strictly-public Worker is cloudpid's answer to the same-zone rule and the tools step's own (review M5). Over the flag on the Environment Worker: it would change every fetch t3 makes, Commissary included, and no stage can test it (only prod has a domain in the zone). Over requiring another zone: the owner would need a second domain. |
| **D24** | **`tailscale-funnel`: a public `https://<node>.<tailnet>.ts.net` origin** (port 443, 8443 or 10000), with t3's own auth as the only gate, as for T3 Connect. The cloud refuses `http` for every Route kind, though t3 alone allows it for `.ts.net`. | The Worker is not on the tailnet, so only Funnel reaches the laptop, and only over https. Over refusing Funnel as the most discoverable of the three (its hostname is in certificate logs): the owner asked for it, and t3's auth is the same gate T3 Connect relies on. |
| **D25** | **Stage stand-ins:** the D21 tunnel serves two hostnames, one behind Access with a service token (the `cloudflare-tunnel` Route) and one open (standing in for `t3-connect` and `tailscale-funnel`, which no stack can make). Funnel's own differences are covered by unit tests on S4 and by the owner proof. **The owner proof covers all three Routes** (§9). | The open hostname exercises everything a public Route does with t3's own auth; a real Funnel stand-in would need a tailnet auth key in the stage. Over proving T3 Connect alone and trusting the rest. |
| **D26** | **Hostile tests H21–H30** for Routes (§8). | |

### E1 (answered: yes)

T3 Connect is on for the laptop, and the owner accepts its relay operator, which can mint laptop sessions, as part of the path. He also wants the Outbound link to work over his own Cloudflare Tunnel and over Tailscale Funnel as supported Routes (D22–D25).

### E2 (answered: yes)

**The Access service token is typed into the panel** (owner decision, 2026-11-12). The owner makes the tunnel, the Access application and the service token in his own Cloudflare account, and enters the token's id and secret once in the harness panel; it is stored write-only in the Environment's secret store, as owner-added MCP servers' credentials are. It is a second exception to "keys typed into t3flare are refused" (owner decision D5), recorded in ADR-0012's SPI-1061 refinement and ADR-0029's rule 8. Rejected: prod's alchemy stack making the tunnel, the DNS record, the Access application and the token, with the token as a deploy secret; prod's CI token would gain tunnel and DNS permissions, and every deploy would touch the laptop's front door.

## 3. Seams

All five are our code or Layers over t3's services, provided in `composition.ts`. A refusal an agent or a follower should understand comes from S2–S4 as an `OrchestratorMcpFailure` or `PeerLinkError`; S5 is a backstop that should never fire when S2–S4 are right.

| Seam | Where | Enforces | Relies on (t3 internals) |
|---|---|---|---|
| **S1** The caller's gate | Durable: the Session's tool wrap (`t3-mcp.ts`, `permissions.ts`). CLI agents: the tools step's relay and wrapper card | The send card; registers a one-shot Send permit with the Environment; refuses early for Linked work with a plain message | the tools step's card mechanisms (`decideCall`, `cliAsk`) |
| **S2** Layer over `PeerForwarding` (sees the caller) | `composition.ts`, wrapping t3's layer | both switches; no Linked work at any access; the tool's class, default-deny (§4); a send needs a matching Send permit; reads only of Outbound work; records the thread ids the cloud started; `links()` lists only the registered machine | the five-method interface; `McpToolAccess.routed` and `RemoteDelegation` reaching the peer only through it; `McpInvocationScope`, `callerLinkOrigin`; `capability_denied` being final in `RemoteDelegation.isFinal` |
| **S3** Layer over `PeerMcpClient` (typed, caller-blind) | the same | clamps `limits` to the cap, whatever the calling thread's mode; a send-class tool needs the "approved" mark S2 sets around the inner call, so a path that skips S2 cannot send | `call({ environmentId, tool, arguments, limits })` |
| **S4** Layer over `PeerLinks` | the same | `link`: only to a Registered machine whose switch is on; the addresses the client offered are replaced by the machine's Routes in the owner's order; `expectedEnvironmentId` forced to the registered id; every origin https; access at or below the cap; for a `cloudflare-tunnel` Route on prod, Access must be in front (the address must not answer as t3 without the token). `resolve`: refused when unregistered or off | `PeerLinkCreateInput` (`url`, `alternateUrls`, `expectedEnvironmentId`); t3 keeping every origin that answered and trying them in order; both the WS RPC and `PeerLinkRequests.answer` going through `link` |
| **S5** An `HttpClient` given only to `PeerLinks` and `PeerMcpClient` | the same, in place of the global `FetchHttpClient` for those two layers; it sends each request through the tools step's MCP Worker (`global_fetch_strictly_public`) | origin allowlist: exactly the Routes of Registered machines that are on; https only; redirects not followed; a Route's Access service token added only for that Route's origin; an assertion that `T3-Mode-Limit` is at or below the cap | both services taking `HttpClient` from context (`composition.ts:732, 797`); `MODE_LIMIT_HEADER`; the MCP Worker's guarded fetch |

Notes:

- **Final or not.** The global switch, a machine's switch and "unregistered" answer `capability_denied`, so a follower ends its task with that reason. "This send matches no approval" and "that thread was not started from here" are also `capability_denied`; a follower never meets them, since it only reads Outbound work.
- **The mark between S2 and S3** is an Effect context value provided around t3's own `call`, not an argument: t3's forwarding strips and re-encodes arguments, so nothing of ours could ride in them.
- **The Outbound work ledger** (machine, thread id, started by which cloud thread, when) is the Environment DO's own table, written by S2 from the typed results of the tools that start a thread there, and by nothing else. A path that skips S2 records nothing, so its later reads are refused.
- **A unit test asserts the choke point:** with t3's real layers, every route from an MCP tool call or a follower to an HTTP request passes S2 and S3.

## 4. Tool classification

Every tool t3 can forward (one whose parameters carry `environmentId: OrchestratorMcpEnvironmentTarget`, plus `delegate_task`'s `target`) is in one table in our code, in one of four classes. A test enumerates t3's toolkits with t3's own `takesLinkedEnvironment` rule and fails on a tool that is not in the table, so a tool a bump adds does not leave until someone classifies it (as capability flags are, ADR-0023).

| Class | Meaning | Members (to be completed against the toolkits at the pin in M1) |
|---|---|---|
| **send** | text reaches a laptop agent; needs a card and a Send permit | `t3_thread_launch`, `delegate_task` to the laptop, `t3_thread_send`, `create_threads`, `t3_queue` (adding), `t3_pending_request` (respond) |
| **read** | answered only for Outbound work, or for the short list that names no thread | `t3_thread_read`, `t3_thread_wait`, `t3_background_wait`, `task_status`, `t3_pending_request` (list); and `t3_project_list`, `t3_project_read`, `t3_environment_read`, `orchestrator_capabilities` |
| **stop** | never asks; only for Outbound work | `t3_thread_interrupt`, `task_cancel`, `t3_workflow_stop` |
| **refused** | does not leave | everything else: `t3_thread_list` and `t3_thread_search` (they would list the owner's own laptop threads), the project, settings, schedule, queue-management, organise, transfer, pull-request and worktree tools |

A tool with two behaviours (`t3_pending_request`, `t3_queue`) is classified by its action argument; an action the table does not know is refused.

## 5. The send card and its Send permit

**The card** (one function, as `pushCard` is, used by the Durable and CLI paths):

- **Shows** the machine, the tool, and every argument of the call: project, mode, model, worktree strategy, title, and the message in full. For an answer to a question it also shows the laptop's question, labelled as what the laptop says.
- **Escapes** control and bidirectional characters, as SPI-992's card escapes non-ASCII names.
- **Cap:** a message over 16 KiB is declined unasked, and the agent is told why. A send with attachments is refused: they cannot be shown.
- **Buttons:** "Send once" and "Decline" only, through t3's `approval_request.options` (as `pushCardOptions`). t3's `acceptAlways` approves once. No session-wide trust in any mode.
- **Before asking,** the Environment checks the machine is registered, on, linked and answering, so the owner is not asked about a send that cannot leave.
- **While it waits,** the card counts as open work for the idle reset (as push cards do), and the cloud's publish-only link reports the thread as waiting for approval.
- **Who may answer:** the owner, from any client. Not the asking agent, not another agent, and not a link's session (M0 gate G3 settles whether t3 lets a full-access Inbound link answer; if it does, S1 refuses that answer for a send card).

**The Send permit** is what "Send once" produces: a record in the Environment DO naming the calling thread, the tool, the machine and the arguments the card showed. S2 lets a send through only when it matches one.

- It is **one effect, not one HTTP attempt.** A retry with the same retry key and the same arguments within the permit's 10 minutes is the same send (t3 dedupes it on the laptop by `clientRequestId`); anything else needs a new card. A send tool with no retry key is not sent again once started (ADR-0022's replay rule).
- **How S1's arguments are matched in S2** is settled by M0 gate G4, per send tool: by the retry key the Session already sets where the tool takes one (the permit stores the arguments and S2 compares them field by field), by a canonical hash of the decoded arguments otherwise.
- A permit is used once, expires unused after 10 minutes, and is deleted when the machine is unlinked or either switch goes off.

**Code mode:** a nested call from a script is judged as a direct one (the tools step's rule): each nested send raises its own card.

## 6. Registration, lifecycle and what the owner sees

### 6.1 The registered machine

Kept by the Environment DO, written only through the harness panel's owner-only routes (the tools step's Access app, CSRF and Origin checks) and their JSON API.

- Fields: label, environment id, highest access (`read-only` or `approval-required`), switch (default off), and an ordered list of **Routes** (§6.6).
- **Each Route's origin must have its kind's hostname form on prod** (§6.6). A stage accepts its stand-in's hostnames from stage configuration.
- One machine in v1. The store is a list, so a second machine is a ticket, not a redesign.
- The global switch "Outbound links off" sits beside it, default on once a machine exists; off wins.

### 6.2 Making, renewing and ending the link

1. The owner registers the laptop in the panel and turns its switch on.
2. He makes the link: in the desktop app, Settings → Environments → Linked environments on the Cloud Environment, **Link**, pick the laptop, leave access at Supervised (the app mints the laptop's code itself, scoped to that access); or pastes a code from the laptop into the panel's form. Both reach `PeerLinks.link` through S4, which links over the machine's registered Routes whatever addresses the app offered. A Route added later joins the link the next time it is made.
3. He checks the laptop's Settings → Sharing & access shows the cloud's session as Supervised.
4. **Renewal** is step 2 again, about every 30 days. Nothing renews by itself.
5. **Ending it:** Unlink in the panel (or the stock client) deletes the bearer and the permits here. The panel then says: revoke the session on the laptop too.

### 6.3 What the panel shows

Label, environment id; each Route with its kind, address, whether it answered last and, for a `cloudflare-tunnel` Route, whether Access is in front and when its token was set (never the token); access; linked and expiry dates, with a warning inside the last 5 days; last reached and last error; status (linked, off, unreachable, expired, revoked there); the count of open Remote tasks and of Outbound work; both switches; Unlink. The JSON API returns the same, never the bearer.

### 6.4 What the owner sees elsewhere

- **In the cloud thread:** the send card, then t3's remote task item (or the launched thread's id in the tool result). A question from the laptop thread shows as "Subagent needs input"; t3 does not wake the parent agent for it (ADR-0011's note).
- **On the laptop:** an ordinary thread marked "From" the cloud's name, and the link's session in Sharing & access. Each command or edit asks there; the laptop's own T3 Connect tells the phone.
- **Cancel from the cloud** (`task_cancel`, or Stop on the parent): stops the laptop thread and completes the task as cancelled, without a card. If the laptop does not answer, the task still cancels here and the stop is owed until it does.
- **Stop on the laptop:** the follower completes the task with the thread's last reply, or as failed without one. Deleting the thread, or revoking the session, fails it with that reason.

### 6.5 Idle and long tasks (D7)

- The idle check reads open Remote tasks from t3's tables, as it reads open runs (fail-safe: an unreadable table means "don't know", never "no work").
- **Laptop answering:** an open Remote task holds the Environment up. The follower's waits go out in pieces of at most 50 s, as t3 sends them.
- **Laptop not answering** (asleep, its tunnel reclaimed, 530): the hold lapses, the Environment may reset, and an alarm brings it back to try again after 5, 15, then 30 minutes, staying at 30.
- **An alarm stands whenever a Remote task is open,** not only after an idle reset, so a deploy or an eviction cannot strand one.
- The task ends when t3 ends it: completion, cancel, or a final refusal (expired, revoked, unlinked, switched off).

### 6.6 Routes (D22–D24)

A **Route** is one way the cloud reaches a Registered machine: an https origin and the kind of tunnel behind it. t3 calls these routes too. All three kinds end at the same t3 server on the laptop, which answers its descriptor, MCP OAuth and `/mcp` on any hostname: it derives its issuer from the request's `Host` and `X-Forwarded-Proto` (`t3code/docs/internals/environment-auth.md`), so a Route's proxy must pass both through unchanged.

| Kind | Origin on prod | In front of t3 | The laptop runs | The cloud holds |
|---|---|---|---|---|
| `t3-connect` | the relay's tunnel hostname (pattern read at the pin, G1) | nothing; t3's own auth | nothing new: T3 Connect is on | nothing |
| `cloudflare-tunnel` | a hostname of the owner's, any zone | **Access, required:** a Service Auth policy for one service token | `cloudflared` as a launch agent, the hostname to `http://localhost:<t3's port>`, `Host` left as it is | the service token (id and secret), write-only (E2: yes) |
| `tailscale-funnel` | `https://<node>.<tailnet>.ts.net`, port 443, 8443 or 10000 | nothing; t3's own auth | `tailscale funnel` to t3's port | nothing |

- **Several Routes, in the owner's order.** At most one of each kind per machine. S4 gives t3 the origins in that order; t3 keeps those that answered as the machine when the link was made, and on each call uses the first that still does (`PeerLinks.resolve`). One bearer serves every Route: it is the laptop's session, not an address's. A Route that was down when the link was made is not in the link until the link is made again.
- **The registration is the allowlist.** S5 lets a request go only to a registered Route's origin, so removing a Route stops traffic to it at once, whatever t3 still stores.
- **https only, for every kind.** t3 alone allows `http` to a `.ts.net` host (`isTailnetHost` in `PeerLinks.peerOrigin`), because it expects to be on the tailnet. The Worker is not, so S4 refuses it.
- **Not our own hosts.** A Route may not be the Environment's host, another host of the account's Workers, or a loopback or private address. A `cloudflare-tunnel` hostname in prod's own zone is allowed: it is the one same-zone address the cloud calls, and it is why peer HTTP leaves from the MCP Worker.
- **Access in front is checked, not assumed.** Before a link is made over a `cloudflare-tunnel` Route on prod, and on the panel's Test, the cloud reads the descriptor once without the token; if t3 answers, the Route is refused as open. With the token, every request of the link (descriptor, `/oauth/mcp/register`, `/decision`, `/token`, `/mcp`) carries `CF-Access-Client-Id` and `CF-Access-Client-Secret`; no browser is involved (G7).
- **Peer HTTP leaves from the tools step's MCP Worker.** It has `global_fetch_strictly_public` and no bindings, and it already makes every outbound MCP and OAuth request behind a guard (tools-plan review, M5; cloudpid's `packages/mcp/src/public-fetch.ts`). S5 calls its guarded fetch with the one origin allowed for that request. So a hostname in `ianpascoe.dev` is reached through Cloudflare's front door, Access judges the token, and the Environment Worker's own flags, and every fetch t3 makes, stay as they are.
- **The laptop's port.** The desktop app's server listens on `T3CODE_PORT` when set, else on 3773, else on the next free port above it. The wizards for the two owner-run kinds read the running server's port, check its descriptor answers with the registered environment id, and say how to pin the port.
- **Setup is the owner's, by wizard** (the `wizard` skill): one script per owner-run kind, on the laptop. Neither reads `~/.cloudflared/*`: the tunnel runs from its token.

## 7. Milestones

Order: **Pre-A and Pre-B now, on `main`.** Everything from M0 on waits for the `tools` step to merge, and the plan goes through Fable review before M1.

| Milestone | Scope | Exit evidence |
|---|---|---|
| **Pre-A** | The SPI-1060 fix (§11.1) | the classification test; a prompt snapshot naming no withheld tool; the Durable agent on a stage, asked whether it can start threads on the owner's MacBook, says it cannot and names no link tool |
| **Pre-B** | A fail-closed Layer over `PeerLinks.link`: "no machine is registered" (§11.2) | unit test; an acceptance case in `acceptance.ts --peer`: a stock-client link attempt is refused before any request leaves |
| **M0** | Probes, with stop gates (below) | one results file per gate under `docs/steps/spi-1061/` |
| **M1** | The registration store and its admin JSON API; S2–S5; the classification table | unit tests on t3's real layers, the choke-point test included; H5, H6, H9–H13, H21–H24 and H26–H30 on a stage |
| **M2** | The send gate for the Durable agent (S1, the card, Send permits); the Outbound work ledger; one Remote task followed to its end | H1–H4, H7, H8, H16–H20; an approved `delegate_task` completes and wakes its parent |
| **M3** | CLI agents through the SPI-1039 relay | H15; the card raised and answered on a Claude, Codex, Pi and OpenCode thread |
| **M4** | Idle and long tasks (§6.5) | a task survives an idle reset, a deploy and a dropped tunnel; the backoff wakes recorded; H18 |
| **M5** | The panel section, Routes and the Access token's form included; lifecycle; the leak scan; the laptop setup wizards for the `cloudflare-tunnel` and `tailscale-funnel` Routes | status, expiry warning, switches and Unlink by eye and by the JSON API; H14, H25; each wizard run once by the owner in M6 |
| **M6** | The owner proof (§9): T3 Connect in full, then each other Route; then prod's own link | the proof's checklist, recorded with screenshots |
| **M7** | Documents | ADR-0011's refinement as built, ADR-0029 accepted, GLOSSARY checked, `docs/parity.md` (the cloud-to-laptop row and the "not planned" list), `docs/upstream-fragility.md` U45–U49, `docs/steps/spi-1061.md` |

### M0 stop gates

| Gate | Question | If it fails |
|---|---|---|
| **G1** | Through the stand-in's named tunnel, then once through a real T3 Connect address (ten attended minutes): does a Peer link's pairing-code sign-in work, do forwarded calls answer (JSON or SSE), does a 50 s wait piece survive, does a stopped connector read as unreachable (530)? What is the T3 Connect hostname pattern at the pin? | Through T3 Connect only: the `t3-connect` Route is dropped to a ticket and the other two kinds carry the link. Through the stand-in too: stop and replan. |
| **G2** | Do the wrappers of `PeerForwarding`, `PeerMcpClient` and `PeerLinks`, with the scoped `HttpClient`, boot in workerd, and does a follower end its task on our `capability_denied`? | Move the final refusals to whatever code t3 treats as final at the pin; if no Layer can wrap a service, a Shadow of `PeerForwarding.ts` (275 lines) is the next step under ADR-0001, and needs the owner's word. |
| **G3** | Who can answer a send card: a full-access Inbound link's session, another agent through `t3_pending_request`, the asking agent? | Add an answer-source check in S1: a send card takes only an owner client's answer. |
| **G4** | For each send tool: does it take a retry key, and are the arguments S1 saw the arguments S2 sees after t3's decode (defaults, trimming)? | Per tool, fall back from key-plus-compare to the canonical hash; a tool that cannot be matched either way is classified refused. |
| **G5** | Can the idle check read open Remote tasks from t3's tables, and does the follower resume from an alarm after a reset? | Keep our own ledger of open Remote tasks, written by S2 and cleared from the follower's final read. |
| **G6** | Does the stock Link dialog, from the owner's desktop app connected to both, mint the laptop's code with read and operate only, and does the laptop refuse a full-access link from it? Does `t3 auth pairing create --scope` work against the desktop app's running server? | The runbook uses whichever path works; if neither limits scopes, D14's laptop-side defence is the recorded access alone, and ADR-0029 says so. |
| **G7** | Through the stand-in's Access hostname, with service-token headers and no browser: do the descriptor, `/oauth/mcp/register`, `/decision`, `/token` and `/mcp` all pass Access, and does t3 still sign in (it derives its issuer from `Host` and `X-Forwarded-Proto`)? Without the headers, is everything refused before t3? | If Access cannot pass the flow headless: `cloudflare-tunnel` ships without Access only if the owner says so (a new escalation); otherwise it is dropped to a ticket. |
| **G8** | Does all peer HTTP work through the MCP Worker's guarded fetch: streamed answers, a 50 s wait piece, redirects reported and not followed? | Keep S5's fetch in the Environment Worker for Routes outside prod's zone, and require a `cloudflare-tunnel` hostname in another zone. |

## 8. Hostile tests

Each runs on a stage against the stand-in (§10), by `scripts/outbound.ts hostile`, and is recorded as a JSON result. "Nothing leaves" is checked at the stand-in: its request log shows no call.

| # | Attempt | Expected |
|---|---|---|
| **H1** | An injected cloud agent calls `t3_thread_launch` at the laptop | a card; with no answer, nothing leaves; Decline leaves no laptop thread |
| **H2** | The same send by each path: a code-mode nested call, `t3_thread_send`, `delegate_task`, a follow-up to an existing task, `create_threads`, `t3_queue`, `t3_pending_request` respond | each raises its own card; none rides an earlier approval |
| **H3** | Approve message A, then send B with the same retry key | refused: the arguments do not match the permit |
| **H4** | Replay a used permit with identical arguments after its lifetime | refused; a new card |
| **H5** | Linked work from a supervised Inbound link uses the Outbound link | refused by t3 and by S2 |
| **H6** | Linked work from a full-access Inbound link uses it | refused by S2 |
| **H7** | A link's session, or another cloud agent through `t3_pending_request`, answers a send card | refused; the card still waits |
| **H8** | A cloud agent reads, lists or searches a laptop thread the cloud did not start | refused in the cloud; nothing leaves |
| **H9** | A forwardable tool outside the send, read and stop classes (`t3_project_delete`, `t3_environment_preferences_update` at the laptop) | refused in the cloud; nothing leaves |
| **H10** | A cloud thread in full access launches at the laptop | it still asks; the laptop thread runs `approval-required` (the clamp), and a command there asks |
| **H11** | A link to an unregistered origin from the stock client's Linked environments dialog | refused by S4 before any request; the pairing code is never sent |
| **H12** | The registered origin answers as another environment id, or redirects elsewhere | refused; no pairing code or bearer is sent |
| **H13** | A link asked at `auto` or `full-access` | refused by S4; with a correctly scoped code the laptop also refuses full access |
| **H14** | A Container process looks for `peer-link-*`: its environment, its files, `computer.internal` routes, the MCP relay | absent; the leak scan is clean across Session, Workspace, Container, logs, pushes and `/_t3flare/agents/session` |
| **H15** | A CLI agent in a Container calls the relay with `environmentId` set to the laptop, with no card | refused |
| **H16** | An expired bearer | a tool error naming the expiry; open tasks fail with that reason; nothing tries to renew |
| **H17** | The session revoked on the laptop | the same, with the revoked reason |
| **H18** | The global switch turned off while a Remote task is open | nothing leaves from that moment; the task fails with "Outbound links are off" |
| **H19** | A cloud agent tries to approve a laptop thread's permission request | refused in the cloud (not a classified action) and by the laptop |
| **H20** | An agent calls `t3_environment_link` | the tool is absent, and no guidance names it |
| **H21** | A call that leaves over the `t3-connect` or the open Route | carries no `CF-Access-*` header (read from the stand-in's request log) |
| **H22** | The Access Route's origin answers 302 to another origin | not followed; the other origin receives nothing: no service token, no bearer, no pairing code |
| **H23** | A registered origin answers as another environment id (the stand-in is swapped behind the hostname) | only descriptor reads leave; no pairing code and no bearer is sent; the Route shows as not answering |
| **H24** | A Route registered or linked as `http`, a `.ts.net` one included | refused by S4 before any request (t3 alone would allow `http` for `.ts.net`) |
| **H25** | A Container or a Session looks for the Access service token | absent; the leak scan is clean for it, and the panel's JSON never returns it |
| **H26** | A Route whose origin does not fit its kind on prod (a `tailscale-funnel` Route outside `.ts.net`, a `t3-connect` Route outside the relay's hostnames, a `cloudflare-tunnel` Route with no token or with no Access in front) | registration or link refused |
| **H27** | The stock client's dialog offers its own addresses for the laptop (LAN, a tailnet address) | S4 replaces them with the registered Routes; nothing is sent to an unregistered address |
| **H28** | A Route removed from the registration after the link was made | no request goes to it, though t3 still stores the address |
| **H29** | The Access service token revoked, or the first Route's connector stopped | that Route reads as not answering, the next Route carries the call, and the panel names the refusal |
| **H30** | The Environment's own host, another host of the account's Workers, a loopback or private address registered as a Route | refused at registration |

## 9. The owner proof (M6)

On a stage, against the owner's real desktop app. Part one is over T3 Connect: about 30 minutes attended, 45 with step 6. Part two adds the other two Routes: about 45 to 60 minutes more, most of it one-time setup, and it can be a second sitting. Each step is ticked with a screenshot.

1. **Link.** Register the laptop in the stage's panel and switch it on. In the desktop app, Linked environments on the stage Environment → Link → the laptop, access Supervised. The laptop's Sharing & access shows the session as Supervised.
2. **An approved send.** Ask the stage's Durable agent to delegate a small task to the laptop. The card shows the machine, the project and the whole message; "Send once". The thread appears in the desktop app marked "From" the stage's name.
3. **A laptop approval, from the phone.** The laptop thread asks before a command; the phone gets "Approval needed"; the owner answers in the mobile app.
4. **The result.** The laptop thread ends; the cloud task completes and its parent wakes with the reply.
5. **A declined send.** A second request; "Decline"; no thread appears on the laptop.
6. **Sleep.** Start a longer task, quit the desktop app for ten minutes, reopen it. The panel shows unreachable, then the task completes.
7. **Ending it.** Global switch off (a waiting task fails with that reason); Unlink in the panel; revoke the session on the laptop.

**Part two, the other Routes.**

8. **Own tunnel (about 25 minutes, 20 of them setup).** Run the `cloudflare-tunnel` wizard on the laptop: a tunnel, a hostname to `http://localhost:<t3's port>`, an Access application with a Service Auth policy, a service token, `cloudflared` as a launch agent. Enter the Route and the token in the panel; the panel shows Access in front. Link over this Route alone; one approved send completes; a browser opening the hostname meets Access, not t3.
9. **Funnel (about 20 minutes, up to 10 of them waiting for DNS).** Run the `tailscale-funnel` wizard: Funnel on for the node, `https` on 443 to t3's port. Register the Route; link over it alone; one approved send completes.
10. **Order (5 minutes).** Register all three, own tunnel first; link once. Stop the laptop's `cloudflared` launch agent: the next call leaves over T3 Connect, and the panel shows which Route answered.

Then, on prod: the owner's own link over the Routes he chose (five minutes), and, if a `cloudflare-tunnel` Route's hostname is in `ianpascoe.dev`, one approved send over it. Prod is the only place the same-zone path exists, so this is its proof.

## 10. The stage stand-in (D16, D21, D25)

A stock `t3` from npm at the pin, in a Docker container on the machine that runs the stage scripts, with a throwaway home and state directory (step 3's `scripts/lib/laptop.ts` is the starting point). Its agents run in that container, never as the owner's user, and the hostile prompts read canary files planted there.

**The tunnel is a named Cloudflare Tunnel made by the stage's alchemy stack,** only when the stage asks for a stand-in (`T3FLARE_STANDIN=1`); prod's stack never makes one.

- **Resources:** `Cloudflare.Tunnel.Tunnel` (in `@alchemy.run/cloudflare` 2.0.0-beta.85 as installed) with one ingress rule to the container's t3 port and a 404 catch-all, plus two proxied DNS `CNAME`s to `<tunnel id>.cfargotunnel.com`, and for the first an Access application with a Service Auth policy and a service token (the stack already makes both kinds of resource for the admin routes). alchemy's `Tunnel.HostnameRoute` is the private-network route, not this.
- **Hostnames:** `t3flare-<stage>-standin.ianpascoe.dev` behind Access, the `cloudflare-tunnel` Route; `t3flare-<stage>-open.ianpascoe.dev` with no Access, standing in for a `t3-connect` or `tailscale-funnel` Route. One label under the apex each, so the zone's Universal certificate covers them. The zone is the one prod is served from.
- **No same-zone fetch arises.** A stage without `T3FLARE_DOMAIN` is served at `<name>.<subdomain>.workers.dev` (`alchemy.run.ts:90-93`), so its fetch to `ianpascoe.dev` is ordinary internet traffic. Only one stage may hold a domain in the zone, and that is prod, which never calls a stand-in (its registration accepts a T3 Connect address only). The zone's rate-limit rule names prod's host alone.
- **The open hostname has no Access in front,** matching T3 Connect's and Funnel's exposure: t3's own auth is the gate, on a server that holds nothing of the owner's. The two hostnames on one connector also give the order test: the stack drops one hostname's ingress rule, and calls move to the other.
- **The tunnel token** is a stack output. The stage script passes it to the container's `cloudflared` (`TUNNEL_TOKEN`) and never prints it; it is destroyed with the stage, tunnel and record included.
- **Sleep is simulated** by stopping the container's `cloudflared`: Cloudflare then answers 530, as for a sleeping laptop.
- **To confirm in M0 (G1):** that the stage's deploy credentials may create a tunnel and a DNS record in the zone, and that the zone's bot settings do not challenge a Worker's request. Prod's CI token gains neither permission.

## 11. The two items that land first

### 11.1 Pre-A: SPI-1060

- **Where:** the `t3_orchestration` section is built in the Session (`t3-mcp.ts`), which knows the offered catalog. The filter runs there, on t3's text as the adapter hands it over.
- **Filter:** t3's guidance is a list of bullets and numbered steps. A bullet that names a tool not offered is dropped whole; a heading left with no bullets goes with them. The offered tools' descriptions get the same treatment by sentence.
- **Classification:** every backticked tool-like name in the guidance and in the descriptions is in one table: offered, withheld, or not a tool. The test fails on a name that is in none, so a bump that names a new tool is caught.
- **Our line,** added after the filter: links to other machines are made by the owner, never by an agent; `t3_environment_links` lists what is linked; with nothing linked, say so. Once the Outbound link exists (M2), it adds that every message to another machine asks the owner first.
- **Test (SPI-1060's own):** no tool name outside the offered set appears in the system prompt or in a tool description.

### 11.2 Pre-B: the refusal

A Layer over `PeerLinks` whose `link` fails with `PeerLinkError` (`disabled`, "This Environment links out only to a machine its owner registered; none is registered.") It is S4 with an empty registration, and M1 fills it in. Inbound links do not pass through it.

## 12. Fragility entries

Numbered after the tools step's U40–U44. To be written into `docs/upstream-fragility.md` in M7, as built.

| Entry | Relies on | Breaks when | Detection |
|---|---|---|---|
| **U45** The policy Layers over t3's peer services (S2–S4) | `PeerForwarding`'s five methods and its being the only way to the peer (`McpToolAccess.routed`, `RemoteDelegation`); `PeerMcpClient.call`'s input; `PeerLinks.link`/`resolve` and `PeerLinkCreateInput`; `McpInvocationScope`, `callerLinkOrigin`; `RemoteDelegation.isFinal`'s codes | a bump adds a method or a second path to the peer, renames a field, or changes which codes end a follower | typecheck (each wrapper implements the whole service type); the choke-point unit test on t3's real layers; `acceptance --outbound` |
| **U46** Classified forwardable tools | `takesLinkedEnvironment`'s rule; each send tool's argument names and retry key; the result shapes that carry a started thread's id | a bump adds a forwardable tool, an action to a two-behaviour tool, or changes a result shape | the enumeration test; G4's per-tool cases kept as unit tests |
| **U47** The peer `HttpClient` (S5) and the Routes | `PeerLinks` and `PeerMcpClient` taking `HttpClient` from context; `MODE_LIMIT_HEADER` and its `<runtime>/<interaction>` form; t3 deriving its issuer from `Host` and `X-Forwarded-Proto`, so a Route's proxy must pass both; the T3 Connect hostname pattern; t3 allowing `http` for `.ts.net` (ours refuses); the MCP Worker's guarded fetch | a peer service fetches outside the injected client; the header or the pattern changes; t3 starts binding a session to the address it was made at | a unit test that S5 never fires when S2–S4 pass, and fires for a foreign origin; typecheck on the constant; the bump's check of the pattern; `acceptance --outbound` over both stand-in hostnames |
| **U48** The idle check reads open Remote tasks (extends U2) | the tables and JSON paths that hold a task's remote child and status; `peer_environment_links.last_error` | a bump reshapes them | fail-safe as U2 (`idle-check-unreadable`); `scripts/peer-idle.ts` |
| **U49** Classified guidance (SPI-1060) | `T3_CODE_ORCHESTRATION_INSTRUCTIONS` being bullets that name tools in backticks | t3 names a new tool, or rewrites the guidance as prose | the classification test |

Extended, not new: **U5** (MCP, `delegate_task`, `linkOrigin`) for the Outbound direction; **U37** (cards injected by the CLI wrapper) for send cards.

## 13. t3code impact

The tree is not touched. Everything is our code or a Layer: three wrapping Layers and a scoped `HttpClient` in `composition.ts`, the Session's gate, the relay's gate, the idle check, the panel. **Shadows 2, Patches 3, unchanged**; no Build shim. G2 is the gate on that claim.

## 14. Files and seams

| File | Change | Seam |
|---|---|---|
| `apps/environment/src/outbound/policy.ts` (new) | the registration, both switches, the cap; pure decisions with a table test | S2–S5 |
| `apps/environment/src/outbound/toolClasses.ts` (new) | the classification table and its lookup by tool and action | S2, S3 |
| `apps/environment/src/outbound/permits.ts` (new) | Send permits: make, match, use, expire | S1, S2 |
| `apps/environment/src/outbound/ledger.ts` (new) | the Outbound work ledger | S2 |
| `apps/environment/src/outbound/layers.ts` (new) | the Layers over `PeerForwarding`, `PeerMcpClient` and `PeerLinks`; the scoped `HttpClient`, which sends through the MCP Worker | S2–S5 |
| `apps/environment/src/outbound/routes.ts` (new) | Route kinds, their hostname forms, the registration checks (https, not our own hosts, Access in front) | S4, S5 |
| `apps/mcp-worker/` (tools step) | `peerFetch`: the guarded fetch for peer requests (one allowed origin per call, https, no redirect followed, headers passed through, nothing stored) | S5 |
| `apps/environment/src/platform/secretStore.ts` | key `outbound/<machine>/<route>/access-token`, write-only helpers (as the tools step's `harness/mcp/…`) | — |
| `apps/environment/scripts/wizards/laptop-cloudflare-tunnel.sh`, `laptop-tailscale-funnel.sh` (new) | the laptop-side setup the owner runs himself | — |
| `apps/environment/src/t3/composition.ts` | provide those in place of t3's bare layers (line 732) | S2–S5 |
| `apps/environment/src/environmentDO.ts` | `outboundAsk()` (reachability check, card detail), `outboundPermit()`; `mcp()` and `mcpForThread()` pass the calling thread | S1 |
| `apps/environment/src/host/idle.ts` | open Remote tasks as work; the standing alarm and its backoff | — |
| `apps/environment/src/host/peerLeak.ts` | `peer-link-*` as a canary | — |
| `apps/environment/src/harness/` (tools step) | the Outbound links section and its JSON routes | — |
| `apps/environment/src/provider/cli/cliAsk.ts`, `wrapper.ts` (tools step) | ask kind `send` beside `push` and `tool` | S1 |
| `apps/environment/src/provider/differ.ts` | the send card's detail | S1 |
| `apps/agents/src/extensions/t3-mcp.ts` | the guidance filter and our line (Pre-A); the send gate for calls that name another Environment | S1 |
| `apps/agents/src/extensions/permissions.ts` | the `send` ask: no acceptance key, "Send once" and "Decline" | S1 |
| `apps/agents/src/workspace/mcpRelay.ts` (tools step) | a relayed t3 call that names another Environment goes through the same ask | S1 |
| `packages/session-protocol/src/*` | `PendingApproval` gains the send fields | S1 |
| `apps/environment/alchemy.run.ts` | the stand-in's tunnel, its two DNS records, the Access application and service token, stage-only | — |
| `apps/environment/scripts/outbound.ts` (new), `lib/standin.ts` (from `lib/laptop.ts`), `acceptance.ts` (`--outbound`), `peer-idle.ts` | probes, the hostile cases, acceptance | — |
| Tests | `apps/environment/test/{outboundPolicy,outboundLayers,outboundChokePoint,toolClasses,permits,sendCard,idleRemoteTasks}.test.ts`; `apps/agents/test/{t3Guidance,sendGate}.test.ts` | — |
| Docs | ADR-0011 refinement, ADR-0029, GLOSSARY, `docs/parity.md`, `docs/upstream-fragility.md`, `docs/steps/spi-1061.md` and `spi-1061/` | — |

## 15. Tickets to file

Nine, from the interview's deferrals. The coordinator files them in Linear (team SPI, project ian-pascoe/t3flare); filed 2026-11-12 as SPI-1067 to SPI-1075. Priorities are Linear's.

| # | Ticket | Title | Priority | Description |
|---|---|---|---|---|
| 1 | SPI-1067 | An agent may ask the owner to renew an expired Outbound link | Low | v1 withholds `t3_environment_link` from every agent, so a link that expired is renewed only when the owner notices. Once the registration pins the target and the cap, t3's own link card could be offered for renewal alone: the worst an injected agent could do is ask again for a link the owner already allowed. Needs a decision on the card fatigue it adds (ADR-0029, considered options). |
| 2 | SPI-1068 | Revisit the Outbound link's cap above `approval-required` | Medium | v1 caps every Outbound link at `approval-required`, so the owner is asked in the cloud for each send and on the laptop for each command; unattended laptop work is not possible. After the link has seen real use, decide whether `auto` (never `auto-accept-edits` or `full-access` without a new ADR) may be switched on per machine, and what the send card must then show. |
| 3 | SPI-1069 | Tell the owner's phone when an Outbound link is about to expire | Low | Expiry shows in the panel, in the stock client's link list and as a tool error. The publish-only T3 Connect link carries thread phases only, so there is no push. Options: an upstream ask for a general notice, or a t3flare-side reminder through another channel. |
| 4 | SPI-1070 | A second Registered machine | Low | v1 registers one machine (the laptop). The store is a list and the Layers key every rule by machine, so this is the panel, the acceptance cases for two machines, and a decision on whether Outbound work on one machine may be read while sending to another. |
| 5 | SPI-1071 | Upstream asks to t3 from the Outbound link's design | Medium | Four gaps t3flare closes on its own side and t3 could close for everyone: read tools are not fenced over a link (`mcp/linkOrigin.ts`); a full-access link may use the peer's own links (`linkOriginIsFenced`); `unlink` does not revoke the session on the peer; a link cannot use an access-bound pairing code, so scopes cannot hold it to one mode. Draft the asks; each one that lands removes a rule or a fragility entry (U45, U46). |
| 6 | SPI-1072 | A `cloudflare-tunnel` Route with no public hostname (Workers VPC binding) | Medium | v1 reaches the owner's tunnel at a public hostname behind Access, with a service token typed into the panel (E2). A Workers VPC binding to the tunnel would need no hostname, no Access application and no token. Unverified: the product's state and limits, and whether t3's sign-in, which derives its issuer from `Host` and `X-Forwarded-Proto`, works through a binding. Research first, then a probe. |
| 7 | SPI-1073 | A faithful Tailscale Funnel stand-in for stages | Low | Stages stand in for Funnel with an open Cloudflare Tunnel hostname; Funnel's own behaviour (its proxy's headers, its ports, `.ts.net`) is proved only in the owner proof. A stand-in needs a tailnet auth key in the stage and Funnel allowed for the node, which is a new credential class for stages. Do it only if a Funnel-specific regression ever gets past the unit tests. |
| 8 | SPI-1074 | Pin the desktop app's port for a laptop that serves an own-tunnel or Funnel Route | Medium | The desktop app listens on `T3CODE_PORT`, else 3773, else the next free port (`apps/desktop/src/app/DesktopApp.ts:43, 96`). A tunnel or Funnel pointed at 3773 then serves whatever took it, in public for Funnel. v1's wizards check the descriptor and say how to pin the port. Wanted: a documented, durable way to pin it for the desktop app (or an upstream ask), and a check that warns when the Route's target is not t3. |
| 9 | SPI-1075 | Attachments on an Outbound send | Low | v1 refuses an Outbound send that carries attachments, because the send card cannot show them and the Send permit covers only what the owner saw. To allow them, the card must show each attachment (name, type, size, a preview or a hash) and the permit must bind them. |

Ticket 9 replaces the interview's earlier "the owner's-tunnel path if E1 is answered no", which this step now builds as a Route.

## 16. Risks and residuals

- **The owner approves words, not behaviour.** An approved message can still bring back something sensitive the laptop agent read, or point at instructions that live in a repository. The card and the laptop's approvals narrow this; nothing closes it.
- **A compromise of the Environment DO is a supervised foothold on the laptop** for the life of the link: threads it starts there ask before a command or an edit, but can read.
- **Each Route has its own exposure.** `t3-connect`: public, and the relay operator controls the hostname and can mint laptop sessions (E1, accepted). `tailscale-funnel`: public, with a hostname that certificate logs publish; no third party can mint a session. `cloudflare-tunnel`: nothing anonymous reaches t3, but Cloudflare ends the TLS and the cloud holds one more credential. Every Route registered is one more door to the laptop; the owner registers only those he wants.
- **The service token is sent before the peer is identified.** It goes to the Route's hostname on every request, the descriptor read included, over TLS. It opens only the owner's own Access application.
- **The desktop app's port can move.** It takes 3773 unless that is busy, then the next free port (`apps/desktop/src/app/DesktopApp.ts:43, 96`). An own tunnel or Funnel pointed at 3773 would then serve whatever took it: behind Access for the tunnel, in public for Funnel. The environment-id check keeps the pairing code and the bearer from it; the wizards pin `T3CODE_PORT` where they can and check the descriptor before they finish.
- **The same-zone path is proved on prod only** (§9), because no stage has a domain in prod's zone.
- **Asked twice.** A send asks in the cloud, then each command asks on the laptop. Unattended work on the laptop is not what this step delivers (ticket 2).
- **Link time is the one moment the cloud could ask for more** than Supervised (D14); the owner's check of the laptop's Sharing & access is the control.
- **Switching off does not stop the laptop's threads.** The panel says so.
- **Dependence on the `tools` step.** S1 for CLI agents, the card's generalised form and the panel are that step's; a change there moves M2, M3 and M5.
