# Plan: SPI-1061, the Outbound link (cloud agents start and drive threads on the Laptop Environment)

Status: design accepted by the owner on 2026-11-12; every decision in §2 is settled, both escalations included (E1 and E2: yes). Fable reviewed it on 2026-11-12 ([review](spi-1061-plan-review.md)): **go with changes**, all folded in below (Review changelog). Pre-A and Pre-B are merged and live on prod (`efd7243`; [report](spi-1061-pre.md)). Folds in SPI-1060.

Terms are GLOSSARY's: **Outbound link**, **Inbound link**, **Outbound work**, **Outbound send**, **Send permit**, **Registered machine**, **Route**. Decisions are recorded in [ADR-0029](../adr/0029-the-outbound-link-is-the-owners-to-make-capped-at-supervised-and-every-send-over-it-waits-for-the-owner.md) and ADR-0011's SPI-1061 refinement.

## Review changelog (2026-11-12)

Every finding of [the review](spi-1061-plan-review.md), with what was done. "Over" names the strongest alternative rejected. No finding needed the owner.

| Finding | Decision | Why, and over what |
|---|---|---|
| **H1** The Send permit is not defined over what leaves | **Adopted.** S2 judges the forwarded call. A send with no permit is recorded as a pending send (forwarded tool, machine, decoded arguments, calling thread) and refused with a typed "needs approval" answer; the card is drawn from that record; the Environment alone turns it into a permit, on the owner's answer; the caller runs the same call again with the same retry key. `outboundPermit()` is gone (§3, §5). G4 gains the `delegate_task` derivation and the retry key on a re-run. | `delegate_task` leaves as a `t3_thread_launch` the caller never saw (`RemoteDelegation.ts:255-283`: resolved project, inherited model, the parent's title, `delegatedFrom`, a derived key), so a permit over the caller's arguments could never match. Over matching on thread and machine alone, which makes S2 a formality. |
| **H2** Pre-B refuses `link` only | **Done** (`efd7243`, live on prod). Pre-B also fails `resolve` as `expired` (final), answers `list` empty without probing, and strips `cause`. Its acceptance case saw an empty list and a count of 0 on the stage; `GET /_t3flare/peer-links/count` is the count-only check for prod (§11.2). | A link row made before Pre-B would stay usable with no card until M1. Over waiting for M1's S4. |
| **M1** Pre-A misses tool results | **Done** (`efd7243`). A Layer over `PeerForwarding.links` replaces `notListed`, which told the agent to call the withheld tool; `peerLinks.test.ts` covers it (§11.1). S2 keeps the Layer. | Over leaving it to M1: it is SPI-1060's own symptom. |
| **M2** The classification does not match the pin | **Adopted.** Two tables: S1 by the tool the agent called, S2 by the forwarded tool and its action (§4). `t3_queue edit` is a send; `reorder` and `promote_to_steer` are refused; `t3_pending_request read` is a read; the schedule tools are refused. S3 refuses every call without S2's mark. A send to an existing thread leaves only if that thread is Outbound work. | S2 never sees `delegate_task`, `task_cancel` or `create_threads` under their own names, so one table keyed by them classified nothing that leaves. Over refusing `t3_queue edit`: it is the same risk as a message, and the card shows it. |
| **M3** Free text on paths that never ask | **Adopted, with one move.** S2 replaces `reason` on every stop with a fixed sentence. The card shows `title` and `delegatedFrom`, as it shows every forwarded argument. A `runtimeMode` above the cap is lowered **in S2**, before the pending send is recorded, so the card shows the mode that leaves; S3 lowers the header's limits and refuses an argument still above the cap. | The review put the argument clamp in S3; done there it would change the call after the owner approved it. |
| **M4** The Linked-work refusal follows the thread's origin only | **Adopted, both halves.** The card names the link when t3's records show a link's session wrote into the sending thread or made its schedule (G3 asks whether they do); while a full-access Inbound link exists and they do not, every send card says that such a link can write into this Environment's threads. ADR-0029's rule 5 states the limit either way. H34. | A full-access Inbound link is unfenced by t3's design, so the send's thread can be the owner's while the instruction is the link's. Over refusing every send while a full-access Inbound link exists: the owner's own laptop link is probably one. |
| **M5** The answer-source check, and late CLI approvals | **Adopted.** The Environment makes a permit only from an owner client's answer, where t3 hands the answer over (with H1). For a CLI agent the card closes when its call ends, and the agent is told to call again while the owner is there. M3 gains the late-answer case (H41). | The Session and the relay never learn who answered. Over a permit that outlives the call: the owner would approve a send nobody makes. |
| **M6** Credentials in error values | **Adopted.** S5 hands the Access service token to `peerFetch` beside the request, never in it, so no request or error value in the Environment holds it. `cause` is already stripped from every `PeerLinkError` (Pre-B, done; it can hold the sign-in request, pairing code included), and S4 keeps that. The Access header names join the console redaction and the MCP Worker's scrub. H38. | Over redaction alone: `cause` also goes back over the WS RPC, which no log filter sees. |
| **M7** S5's limits, and long waits | **Adopted.** S5: 75 s per request, a 4 MiB body cap, a 3xx returned as a status for both services, and a Route that just failed fails fast for 60 s (t3 probes each Route for up to 10 s before every call). At most **three open Remote tasks**; a fourth is refused with that reason. G8 is extended. | Each open task holds one 50 s request, and Cloudflare allows six outgoing connections at once. Over no cap until it hurts: the failure would be a stalled model call. |
| **M8** The environment-id check is not authentication | **Adopted.** The trust anchor is who owns a Route's hostname, plus TLS; the id check only catches a wrong or stray answerer. G1 asks whether a T3 Connect hostname can ever pass to another account; if it can, that kind is a ticket, not a Route. §6.6 and §16 say so. | Whoever serves the hostname with the right id gets the bearer and every message. Over treating the id as proof. |
| **M9** Final against retried refusals | **Adopted.** S4's `resolve` refuses as `expired` with our own sentence, as Pre-B already does: t3 turns that reason into `capability_denied`, which ends a follower. S2 answers `capability_denied` for policy only; a failed read of its own store is `orchestration_error`, retried, and never lets a send through. S5 fails as an `HttpClientError`, so t3 moves to the next Route. | `disabled` and `unreachable` become `orchestration_error`, which followers retry for ever (`PeerMcpClient.ts:69-78`). Over `disabled` or a new reason of ours, which t3 would map to a retried code. |
| **M10** Funnel has no M0 gate | **Adopted: G9**, fifteen attended minutes on a real Funnel (descriptor and sign-in). If it fails, the kind drops to a ticket. | Funnel would otherwise first meet t3's issuer derivation in the owner proof. Over the unit tests alone. |
| **M11** The owner proof | **Adopted, every fix** (§9): a fresh stage under prod's Route rules that never ran a hostile case and is destroyed at the end; sleep by closing the lid or cutting the network, not by quitting the app; a teardown for part two; three added steps (revoke on the laptop while linked; the laptop's own Inbound link tries the Outbound link; a scratch project for every task). | The stage holds a real bearer for the real laptop. Over proving on the stage the hostile cases ran on. |
| **LOW** Switch-off orphans laptop threads | **Adopted.** The panel lists Outbound work still running and offers "stop these first, then switch off" (§6.3). | D19 stands: off means nothing leaves. The offer runs before it. |
| **LOW** `PeerLinkRequests.request` is reachable | **Done** in Pre-B (`efd7243`): a Layer refuses it, so no link card can be raised. | Only the allowlist withheld t3's link card before. |
| **LOW** Card flood | **Adopted: N = 3.** After three declines in a row in a thread, its sends are declined unasked until the owner next writes in that thread. One send card per thread at a time. | Over a time-based lockout, which also blocks the owner's own next request. |
| **LOW** Backoff state | **Adopted.** The retry state is in DO storage, and the one alarm is the earlier of t3's due time and the next retry (§6.5). | The idle reset clears memory. |
| **LOW** §10 against D22 and §9 | **Fixed.** Prod takes each kind's own hostname form and refuses the stand-in scheme (`t3flare-*-standin`, `t3flare-*-open`), which lives in its zone. | |
| **LOW** `peerFetch` | **Adopted:** a test that the MCP Worker has no public route and refuses a call without exactly one allowed origin. | |
| **LOW** One bearer over several Routes | **Noted in U47:** t3 checks the resource at sign-in only. | |
| **Hostile tests** | **H31–H41 added** (§8), H39 and H40 are the pre-items' and pass in `peerLinks.test.ts`. | |

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
| **D7** | **An open Remote task is work,** and at most three are open at once (review M7). While the laptop answers, the Environment stays up; while it does not, the Environment may reset and an alarm retries, backing off to about 30 minutes. No give-up timer: the task ends by completion, the owner's cancel, or the link expiring or being revoked. | t3 has no waiting state, so giving up early means failing the task and losing its result; staying up costs about $0.0056 an hour. Over stopping after N hours unreachable. |
| **D8** | **SPI-1060:** filter t3's guidance by bullet at prompt build, where the offered catalog is known; classify every tool name in the guidance and in the offered tools' descriptions, as capability flags are classified; add one line of our own. | It is our own code that hands the guidance over, so no Layer, Shadow or Patch. Over a Patch to t3's instructions file. |
| **D9** | **Terms:** Inbound link, Outbound link, Outbound work, Outbound send, Send permit. No "Owner machine": Laptop Environment already names it. | Over naming the directions by machine, which breaks when a second machine is linked. |
| **D10** | **ADRs:** a new ADR-0029 for the credential and its rules; a refinement of ADR-0011 for the direction and reachability. | Over folding everything into ADR-0011, which would bury the credential decision under a reachability title. |
| **D11** | **Five seams, S1–S5** (§3). The send check sits in typed Layers over t3's peer services, not in the `HttpClient` Layer, and S2 judges the call as it leaves, not as the agent made it (review H1). S5's requests leave from the tools step's MCP Worker, which is strictly public (D23). | The `HttpClient` cannot see the calling thread, and its refusals read as transport errors that followers retry for ever. Over a wire-level check of `tools/call` bodies. |
| **D12** | **The card** reuses SPI-1040's mechanism and SPI-992's conventions (§5). The card is drawn from the call that will leave, and the Environment alone makes the Send permit, from the owner's own answer (review H1, M5). An answer to a laptop thread's question is a send; listing pending requests is a read. | One mechanism the owner already knows. Over raising the card inside t3's tool handler, which would hold a Durable Object RPC for the whole wait. |
| **D13** | **Build after `tools` merges**, as a panel section over an admin-route JSON API. Pre-A and Pre-B land on `main` now. | Prod today lets any `access:write` client link it to any https address. Over a minimal admin route first, rebuilt later to the panel's conventions. |
| **D14** | **The pairing code is minted without settings or source-control scopes** (the stock Link dialog does so; `t3 auth pairing create --scope` by hand). Between `approval-required` and `auto`, the laptop's defence is the access recorded at link time; the runbook has the owner confirm "Supervised" in the laptop's Sharing & access. | Over an access-bound "app approval" code, which t3 refuses for a link. |
| **D15** | **No cloud-side notice for laptop approvals.** The laptop's own T3 Connect publishes them; the cloud's publish-only link already reports the send card. Documented. | Over the cloud polling laptop thread state to raise a notice of its own. |
| **D16** | **Stage runs use a throwaway stock `t3` in a Docker container**, never as the owner's user on the MacBook. A stage accepts its stand-in's hostnames from stage configuration; prod accepts each Route kind's own hostname form (D22). One owner proof at the end (§9). | Threads the stage starts would otherwise run against the owner's real home directory, hostile prompts included. |
| **D17** | **Hostile tests H1–H20** (§8), and H31–H41 from the review. | |
| **D18** | **What the owner sees is t3's own** (§6.4): the card and the remote task item in the cloud, a thread marked "From" on the laptop. Stopping never asks. | Over a separate Outbound work list in the panel beyond a count. |
| **D19** | **Two switches.** Per machine, default off; and one global "Outbound links off". While either is off nothing leaves, follower polls included, and open Remote tasks fail with that reason. Switching off does not stop threads already running on the laptop; the panel offers to stop them first. | Over a pause that keeps tasks waiting, which leaves followers holding the Environment up. |
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

All five are our code or Layers over t3's services, provided in `composition.ts`. Pre-B's Layers (`apps/environment/src/t3/peerLinks.ts`) are S4 with nothing registered, and M1 grows them. **S2 is where a call is judged, as it leaves.** A refusal an agent or a follower should understand comes from S2–S4 as an `OrchestratorMcpFailure` or `PeerLinkError`; S5 is a backstop that should never fire when S2–S4 are right.

| Seam | Where | Enforces | Relies on (t3 internals) |
|---|---|---|---|
| **S1** The caller's side | Durable: the Session's tool wrap (`t3-mcp.ts`, `permissions.ts`). CLI agents: the tools step's relay and wrapper card | refuses early, in plain words, for Linked work and for a called tool its table refuses; always sets the retry key; on S2's "needs approval", shows the card from the Environment's record and, once answered, runs the same call again. It makes no permit and decides nothing about what may leave | the tools step's card mechanisms (`decideCall`, `cliAsk`) |
| **S2** Layer over `PeerForwarding` (sees the caller) | `composition.ts`, wrapping t3's layer | both switches; no Linked work at any access; the forwarded tool's class by tool and action, default-deny (§4); a send needs a Send permit for exactly this call, else it is recorded as a pending send and refused as "needs approval"; a send to an existing thread, a read and a stop only for Outbound work; `reason` on a stop replaced; a `runtimeMode` above the cap lowered; at most three open Remote tasks; records the thread ids the cloud started; `links()` lists only the Registered machine and never names a withheld tool | the five-method interface; `McpToolAccess.routed` and `RemoteDelegation` reaching the peer only through it; `McpInvocationScope`, `callerLinkOrigin`; `RemoteDelegation.isFinal`'s codes |
| **S3** Layer over `PeerMcpClient` (typed, caller-blind) | the same | refuses **every** call that does not carry S2's mark; lowers `limits` to the cap; refuses an argument still above the cap | `call({ environmentId, tool, arguments, limits })` |
| **S4** Layer over `PeerLinks` | the same | `link`: only to a Registered machine whose switch is on; the addresses the client offered are replaced by the machine's Routes in the owner's order; `expectedEnvironmentId` forced to the registered id; every origin https; access at or below the cap; for a `cloudflare-tunnel` Route under prod's rules, Access must be in front (the address must not answer as t3 without the token). `resolve`: refused with a final reason when unregistered or off. `list`: only the Registered machine. `cause` stripped from every error it passes on. Beside it, a Layer refuses `PeerLinkRequests.request`, t3's agent-asked link card (Pre-B, done) | `PeerLinkCreateInput` (`url`, `alternateUrls`, `expectedEnvironmentId`); t3 keeping every origin that answered and trying them in order; both the WS RPC and `PeerLinkRequests.answer` going through `link`; `fromLinkError` making `expired` final |
| **S5** An `HttpClient` given only to `PeerLinks` and `PeerMcpClient` | the same, in place of the global `FetchHttpClient` for those two layers; it sends each request through the tools step's MCP Worker (`global_fetch_strictly_public`) | origin allowlist: exactly the Routes of Registered machines that are on; https only; a 3xx returned as a status, never followed, for both services; 75 s per request and a 4 MiB body; a Route that just failed fails fast for 60 s; a Route's Access service token handed to the MCP Worker beside the request and added there, only for that Route's origin; an assertion that `T3-Mode-Limit` is at or below the cap; failures are `HttpClientError`s, so t3 tries the next Route | both services taking `HttpClient` from context (`composition.ts:732, 797`); `MODE_LIMIT_HEADER`; the MCP Worker's guarded fetch |

Notes:

- **Final or not** (review M9). Policy answers `capability_denied`, which ends a follower's task with that reason: either switch off, unregistered, Linked work, a refused class, a thread that is not Outbound work, the cap on open tasks. S4's `resolve` refuses as `expired`, as Pre-B's does, which t3 turns into the same code. "Needs approval" is not final and is only ever met by a foreground call. A failed read of S2's own store is `orchestration_error`: retried, and never a reason to let a send through.
- **The mark between S2 and S3** is an Effect context value provided around t3's own `call`, not an argument: t3's forwarding strips and re-encodes arguments, so nothing of ours could ride in them.
- **The Outbound work ledger** (machine, thread id, started by which cloud thread, when) is the Environment DO's own table, written by S2 from the typed results of the forwarded launches, and by nothing else. A forged record of a remote child naming some other laptop thread is not in it, so the follower's read, wait and stop of that thread are refused.
- **A unit test asserts the choke point:** with t3's real layers, every route from an MCP tool call or a follower to an HTTP request passes S2 and S3.

## 4. Tool classification

Two tables in our code, because the tool an agent calls is often not the tool that leaves (review M2): `delegate_task`, `task_cancel`, `task_status`, `t3_background_wait`, `create_threads` and `t3_workflow_stop` act as their calling thread and reach the laptop, if at all, as `t3_thread_launch`, `t3_thread_read`, `t3_thread_wait`, `t3_thread_interrupt` and `t3_project_list`.

**S2's table, by forwarded tool and action, is the one that decides.** A test enumerates t3's toolkits with t3's own `takesLinkedEnvironment` rule, and each tool's actions, and fails on anything the table lacks, so a tool or an action a bump adds does not leave until someone classifies it (as capability flags are, ADR-0023). The members below were read at the pin for the review; M1 completes them.

| Class | Meaning | Forwarded tool (action) |
|---|---|---|
| **send** | text reaches a laptop agent; needs a Send permit. To an existing thread, only if it is Outbound work | `t3_thread_launch`; `t3_thread_send`; `t3_queue` (`edit`: it replaces a queued message); `t3_pending_request` (`respond`) |
| **read** | answered only for Outbound work, or for the short list that names no thread | `t3_thread_read`, `t3_thread_wait`, `t3_queue` (`list`, `read`), `t3_pending_request` (`list`, `read`); and `t3_project_list`, `t3_project_read`, `t3_environment_read`, `orchestrator_capabilities` |
| **stop** | never asks; only for Outbound work; carries no text of the agent's | `t3_thread_interrupt` (its `reason` replaced), `t3_queue` (`cancel`) |
| **refused** | does not leave | everything else: `t3_queue` (`reorder`, `promote_to_steer`); `schedule_task` and the schedule list, update, delete and run tools; `t3_thread_list` and `t3_thread_search` (they would list the owner's own laptop threads); `t3_thread_configure`, `t3_thread_update`, `t3_thread_organize`; the project-changing, settings, pull-request and worktree tools; any action the table does not know |

**S1's table, by called tool, only saves a round trip and words the refusal.** For a call that names a Registered machine it says: refuse here (a called tool whose every forwarded form is refused, such as `schedule_task`), or pass to t3 and let S2 judge. It never allows what S2 would refuse; a test checks the two tables agree.

## 5. The send card and its Send permit

**The flow** (review H1, M5). What the owner approves is the call as it will leave, built where it leaves.

1. The agent calls a tool that names the laptop. S1 sets the retry key and passes the call to t3.
2. t3 turns it into the forwarded call: for `delegate_task`, paged `t3_project_list` reads to find the project, then a `t3_thread_launch` with the resolved project, the inherited model, a title, the task as its message, `delegatedFrom` and a key derived from the caller's.
3. S2 sees that forwarded call. With no Send permit for it, S2 checks the machine answers, lowers a mode above the cap, records a **pending send** (forwarded tool, machine, decoded arguments, calling thread) and refuses with a typed "needs approval" answer that names the record. Nothing has left but reads.
4. S1 shows the card, drawn from the Environment's record, not from the agent's arguments.
5. The owner answers. The answer reaches t3 in the Environment, which is where its source is known. **The Environment alone turns the record into a Send permit, and only for an answer from an owner client's session**: not from a link's session, not from `t3_pending_request`, not from the asking agent.
6. S1 runs the same call again with the same retry key. t3 builds the same forwarded call, S2 matches it to the permit, and it leaves.

If the second build differs (the parent's title changed meanwhile, say), S2 records a new pending send and the owner sees a second card; after two, the call fails with that reason. G4 measures how stable each derivation is.

**The card** (one function, as `pushCard` is, used by the Durable and CLI paths):

- **Shows** the machine, the forwarded tool, and every argument of it: the project (its id, with the name and path the laptop gave in the project list, labelled as the laptop's), mode, model, title, `delegatedFrom`, and the message in full. For an answer to a question it also shows the laptop's question, labelled as what the laptop says. For `t3_queue edit` it says which queued message is replaced.
- **Says where the instruction may have come from** (review M4): it names a link whose session wrote into this thread or made this schedule, when t3's records show it; otherwise, while a full-access Inbound link exists, it says such a link can write into this Environment's threads.
- **Escapes** control and bidirectional characters, as SPI-992's card escapes non-ASCII names.
- **Cap:** a message over 16 KiB is declined unasked, and the agent is told why. t3 already refuses attachments on a forwarded call.
- **Buttons:** "Send once" and "Decline" only, through t3's `approval_request.options` (as `pushCardOptions`). t3's `acceptAlways` approves once. No session-wide trust in any mode.
- **No card for a send that cannot leave:** S2 checks the machine is registered, on, linked and answering before it records the pending send.
- **Flood** (review, low): one send card per thread at a time. After three declines in a row in a thread, its sends are declined unasked until the owner next writes in that thread.
- **While it waits,** the card counts as open work for the idle reset (as push cards do), and the cloud's publish-only link reports the thread as waiting for approval.
- **CLI agents:** the card closes when the CLI's tool call ends (its timeout is 660 s), and the agent is told to call again while the owner is there. An answer after that makes no permit.

**The Send permit** covers one forwarded call: that thread, that tool, that machine, those arguments, the retry key among them.

- It is **one effect.** The first matching call takes it; an identical call arriving while that one is in flight is refused, so two concurrent sends on one approval put one on the wire. If the first failed in transit, the same call may try again within the permit's 10 minutes, and t3 on the laptop dedupes by the key.
- A forwarded send with no retry key is not sent again once started (ADR-0022's replay rule).
- It expires unused after 10 minutes, and is deleted with its pending sends when the machine is unlinked or either switch goes off.
- Nothing outside the Environment DO can make one: there is no RPC for it.

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

Label, environment id; each Route with its kind, address, whether it answered last and, for a `cloudflare-tunnel` Route, whether Access is in front and when its token was set (never the token); access; linked and expiry dates, with a warning inside the last 5 days; last reached and last error; status (linked, off, unreachable, expired, revoked there); the count of open Remote tasks and of Outbound work; the Outbound work still running on the machine, by thread; both switches; Unlink. Switching off offers "stop these threads first, then switch off": the stops leave (they carry no text), then nothing does. The JSON API returns the same, never the bearer.

### 6.4 What the owner sees elsewhere

- **In the cloud thread:** the send card, then t3's remote task item (or the launched thread's id in the tool result). A question from the laptop thread shows as "Subagent needs input"; t3 does not wake the parent agent for it (ADR-0011's note).
- **On the laptop:** an ordinary thread marked "From" the cloud's name, and the link's session in Sharing & access. Each command or edit asks there; the laptop's own T3 Connect tells the phone.
- **Cancel from the cloud** (`task_cancel`, or Stop on the parent): stops the laptop thread and completes the task as cancelled, without a card. If the laptop does not answer, the task still cancels here and the stop is owed until it does.
- **Stop on the laptop:** the follower completes the task with the thread's last reply, or as failed without one. Deleting the thread, or revoking the session, fails it with that reason.

### 6.5 Idle and long tasks (D7)

- The idle check reads open Remote tasks from t3's tables, as it reads open runs (fail-safe: an unreadable table means "don't know", never "no work").
- **Laptop answering:** an open Remote task holds the Environment up. The follower's waits go out in pieces of at most 50 s, as t3 sends them.
- **Laptop not answering** on any Route (asleep, its tunnel reclaimed, 530): the hold lapses, the Environment may reset, and an alarm brings it back to try again after 5, 15, then 30 minutes, staying at 30. The retry state is in DO storage, since a reset clears memory.
- **An alarm stands whenever a Remote task is open,** not only after an idle reset, so a deploy or an eviction cannot strand one. There is one alarm: the earlier of t3's own next due time and the next retry.
- **At most three Remote tasks are open at once** (review M7). Each holds one 50 s request while the laptop answers; a fourth `delegate_task` to the laptop is refused with that reason. G8 measures whether three is the right number.
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
- **Not our own hosts.** A Route may not be the Environment's host, another host of the account's Workers, or a loopback or private address. A `cloudflare-tunnel` hostname in prod's own zone is allowed: it is the one same-zone address the cloud calls, and it is why peer HTTP leaves from the MCP Worker. Prod refuses the stand-in scheme (`t3flare-*-standin`, `t3flare-*-open`), which lives in its zone.
- **Access in front is checked, not assumed.** Before a link is made over a `cloudflare-tunnel` Route on prod, and on the panel's Test, the cloud reads the descriptor once without the token; if t3 answers, the Route is refused as open. With the token, every request of the link (descriptor, `/oauth/mcp/register`, `/decision`, `/token`, `/mcp`) carries `CF-Access-Client-Id` and `CF-Access-Client-Secret`; no browser is involved (G7). S5 hands the token to the MCP Worker beside the request, and the Worker adds the two headers as the request leaves, so no request or error value in the Environment ever holds them (review M6). "On prod" means under prod's Route rules, which the owner proof's stage also runs.
- **What is trusted is the hostname** (review M8). t3's descriptor is unauthenticated and an environment id is not a secret: whoever serves a Route's hostname with the right id receives the bearer and every message on the next call. So a Route is as trustworthy as the ownership of its hostname, plus TLS: the relay operator's allocation for `t3-connect` (G1 asks whether it can ever pass to another account), the owner's zone and Access for `cloudflare-tunnel`, the owner's tailnet name for `tailscale-funnel`. The id check catches a wrong or stray answerer, nothing more.
- **A dead Route does not slow every call.** t3 probes each Route's descriptor, in order, for up to 10 s before every call. S5 remembers a Route that just failed and fails it fast for 60 s, so t3 moves to the next.
- **Peer HTTP leaves from the tools step's MCP Worker.** It has `global_fetch_strictly_public` and no bindings, and it already makes every outbound MCP and OAuth request behind a guard (tools-plan review, M5; cloudpid's `packages/mcp/src/public-fetch.ts`). S5 calls its guarded fetch with the one origin allowed for that request. So a hostname in `ianpascoe.dev` is reached through Cloudflare's front door, Access judges the token, and the Environment Worker's own flags, and every fetch t3 makes, stay as they are.
- **The laptop's port.** The desktop app's server listens on `T3CODE_PORT` when set, else on 3773, else on the next free port above it. The wizards for the two owner-run kinds read the running server's port, check its descriptor answers with the registered environment id, and say how to pin the port.
- **Setup is the owner's, by wizard** (the `wizard` skill): one script per owner-run kind, on the laptop. Neither reads `~/.cloudflared/*`: the tunnel runs from its token.

## 7. Milestones

Order: **Pre-A and Pre-B first: done, on `main` and live on prod (`efd7243`).** Everything from M0 on waits for the `tools` step to merge, and the plan's Fable review is done (Review changelog).

| Milestone | Scope | Exit evidence |
|---|---|---|
| **Pre-A** (done, `efd7243`) | The SPI-1060 fix (§11.1), with `notListed` rewritten (review M1) | `t3Guidance` 4/4, `t3Mcp` 16/16 (the classification test; no withheld tool named in the prompt, the descriptions or `t3_environment_links`' result). Not run on a stage: a real model turn asking about the laptop |
| **Pre-B** (done, `efd7243`) | Fail-closed Layers over `PeerLinks`, `PeerForwarding.links` and `PeerLinkRequests` (§11.2; review H2, M6, and the link-card LOW) | `peerLinks` 4/4; stage `pre1061`: a web-client link refused in 1.7 s with nothing sent, list `[]`, count 0 (`docs/steps/step-3/pre1061-outbound.json`); H39, H40 |
| **M0** | Probes, with stop gates (below) | one results file per gate under `docs/steps/spi-1061/` |
| **M1** | The registration store and its admin JSON API; S2–S5; both classification tables; S5's limits; the cap on open Remote tasks | unit tests on t3's real layers, the choke-point test included; H5, H6, H9–H13, H21–H24, H26–H30, H32, H33, H35 and H37 on a stage |
| **M2** | The send gate for the Durable agent (S1, the card, Send permits); the Outbound work ledger; one Remote task followed to its end | H1–H4, H7, H8, H16–H20, H31, H34 and H36; an approved `delegate_task` completes and wakes its parent |
| **M3** | CLI agents through the SPI-1039 relay | H15 and H41 (an answer after the CLI's call ended makes no permit); the card raised and answered on a Claude, Codex, Pi and OpenCode thread |
| **M4** | Idle and long tasks (§6.5) | a task survives an idle reset, a deploy and a dropped tunnel; the backoff wakes recorded; H18 |
| **M5** | The panel section, Routes and the Access token's form included; lifecycle; the leak scan; the laptop setup wizards for the `cloudflare-tunnel` and `tailscale-funnel` Routes | status, expiry warning, switches and Unlink by eye and by the JSON API; H14, H25 and H38; each wizard run once by the owner in M6 |
| **M6** | The owner proof (§9): T3 Connect in full, then each other Route; then prod's own link | the proof's checklist, recorded with screenshots |
| **M7** | Documents | ADR-0011's refinement as built, ADR-0029 accepted, GLOSSARY checked, `docs/parity.md` (the cloud-to-laptop row and the "not planned" list), `docs/upstream-fragility.md` U45–U49, `docs/steps/spi-1061.md` |

### M0 stop gates

| Gate | Question | If it fails |
|---|---|---|
| **G1** | Through the stand-in's named tunnel, then once through a real T3 Connect address (ten attended minutes): does a Peer link's pairing-code sign-in work, do forwarded calls answer (JSON or SSE), does a 50 s wait piece survive, does a stopped connector read as unreachable (530)? What is the T3 Connect hostname pattern at the pin, and can a hostname ever pass to another account (review M8)? | Through T3 Connect only: the `t3-connect` Route is dropped to a ticket and the other two kinds carry the link. Through the stand-in too: stop and replan. A hostname that can be reassigned: the `t3-connect` kind is a ticket, not a Route. |
| **G2** | Do the wrappers of `PeerForwarding`, `PeerMcpClient` and `PeerLinks`, with the scoped `HttpClient`, boot in workerd, and does a follower end its task on our `capability_denied`? | Move the final refusals to whatever code t3 treats as final at the pin; if no Layer can wrap a service, a Shadow of `PeerForwarding.ts` (275 lines) is the next step under ADR-0001, and needs the owner's word. |
| **G3** | Who can answer a send card: a full-access Inbound link's session, another agent through `t3_pending_request`, the asking agent? Where t3 hands an answer to our adapter and wrapper in the Environment, is its source (an owner client's session or not) known? Do t3's records show that a link's session wrote into a thread or made a schedule (review M4, M5)? | The Environment makes a permit only where it can see an owner client's session; if the source cannot be seen for a path, that path cannot approve a send. No per-thread record of a link's writes: the card carries the standing notice instead (§5). |
| **G4** | For each forwarded send: its retry key, and whether the forwarded call is the same when the caller runs it twice. In particular `delegate_task`: the resolved project, the inherited model, the title, `delegatedFrom` and the derived key (`RemoteDelegation.ts:255-283`), and whether the caller's retry key survives the re-run (review H1). | A re-run that builds a different call asks again (§5). A called tool whose forwarded call is never the same twice is refused for the laptop in S1's table, and the agent is pointed at the direct tool (`t3_thread_launch` for `delegate_task`). |
| **G5** | Can the idle check read open Remote tasks from t3's tables, and does the follower resume from an alarm after a reset? | Keep our own ledger of open Remote tasks, written by S2 and cleared from the follower's final read. |
| **G6** | Does the stock Link dialog, from the owner's desktop app connected to both, mint the laptop's code with read and operate only, and does the laptop refuse a full-access link from it? Does `t3 auth pairing create --scope` work against the desktop app's running server? | The runbook uses whichever path works; if neither limits scopes, D14's laptop-side defence is the recorded access alone, and ADR-0029 says so. |
| **G7** | Through the stand-in's Access hostname, with service-token headers and no browser: do the descriptor, `/oauth/mcp/register`, `/decision`, `/token` and `/mcp` all pass Access, and does t3 still sign in (it derives its issuer from `Host` and `X-Forwarded-Proto`)? Without the headers, is everything refused before t3? | If Access cannot pass the flow headless: `cloudflare-tunnel` ships without Access only if the owner says so (a new escalation); otherwise it is dropped to a ticket. |
| **G8** | Does all peer HTTP work through the MCP Worker's guarded fetch: streamed answers, a 50 s wait piece, a 3xx reported and not followed, the 75 s and 4 MiB limits? With eight waits open at once, do a T3 Connect publish and a model call still go through (Cloudflare allows six outgoing connections), and how do service-binding calls count? Does a follow of several hours hold with no client attached? Does the CLI relay path stay inside the subrequest depth that failed in step 4a (review M7)? | Keep S5's fetch in the Environment Worker for Routes outside prod's zone, and require a `cloudflare-tunnel` hostname in another zone. Starved fetches: lower the cap on open Remote tasks, or follow by short polls instead of held waits. |
| **G9** | Over a real Tailscale Funnel on the laptop (fifteen attended minutes): do the descriptor and a link's sign-in work, so that Funnel passes `Host` and `X-Forwarded-Proto` as t3 needs (review M10)? | The `tailscale-funnel` kind drops to a ticket. |

## 8. Hostile tests

Each runs on a stage against the stand-in (§10), by `scripts/outbound.ts hostile`, and is recorded as a JSON result. "Nothing leaves" is checked at the stand-in: its request log shows no call.

| # | Attempt | Expected |
|---|---|---|
| **H1** | An injected cloud agent calls `t3_thread_launch` at the laptop | a card; with no answer, nothing leaves; Decline leaves no laptop thread |
| **H2** | The same send by each path: a code-mode nested call, `t3_thread_send`, `delegate_task`, a follow-up to an existing task, `create_threads`, `t3_queue`, `t3_pending_request` respond | each raises its own card; none rides an earlier approval |
| **H3** | Approve message A, then send B with the same retry key | B does not leave on A's permit: it is a different forwarded call, and asks on a card of its own |
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
| **H31** | `delegate_task` to the laptop, approved; then the same call re-run with one argument changed | the card's project, model, title and message equal, byte for byte, the `t3_thread_launch` the stand-in received; the changed re-run is refused and asks again |
| **H32** | Approve a queued send, then `t3_queue` `edit` (asks again), `reorder` or `promote_to_steer` at the laptop | `edit` raises its own card; the other two are refused in the cloud |
| **H33** | `task_cancel` or `t3_thread_interrupt` with a 2,000-character `reason` | the stop arrives; the reason does not (the stand-in sees our fixed sentence) |
| **H34** | A full-access Inbound link writes into an owner thread, or makes a schedule, which then sends to the laptop | the card names the link, or carries the standing notice (G3); nothing leaves without the owner's answer |
| **H35** | A forged record of a remote child naming a laptop thread the cloud did not start | the follower's read, wait and stop of it are refused; the task fails |
| **H36** | Two identical sends at once, one approval | one request reaches the stand-in |
| **H37** | A Route that accepts and never answers, or answers with a 50 MiB body | cut at 75 s or at the cap; a model call and a publish made meanwhile go through |
| **H38** | A forced transport error on each Route, at sign-in and on a call | no service token, bearer or pairing code in the WS error, `last_error`, or either Worker's logs |
| **H39** | A link row that exists under Pre-B (seeded) | cannot be resolved; the list is empty (done, `peerLinks.test.ts`) |
| **H40** | `t3_environment_links` with nothing linked | names no withheld tool (done, `peerLinks.test.ts`) |
| **H41** | A CLI agent's send card answered after its tool call timed out | no permit; nothing leaves without a new call and a new card |

## 9. The owner proof (M6)

On a **fresh stage that runs prod's Route rules** and has never run a hostile case, against the owner's real desktop app; it is destroyed at the end, because it holds a real bearer for the real laptop (review M11). Every task names a **scratch project** on the laptop, since reads never ask there. Part one is over T3 Connect: about 40 minutes attended, 55 with step 6. Part two adds the other two Routes: about 50 to 65 minutes more, most of it one-time setup, and it can be a second sitting. Each step is ticked with a screenshot.

1. **Link.** Register the laptop in the stage's panel and switch it on. In the desktop app, Linked environments on the stage Environment → Link → the laptop, access Supervised. The laptop's Sharing & access shows the session as Supervised.
2. **An approved send.** Ask the stage's Durable agent to delegate a small task to the laptop. The card shows the machine, the project and the whole message; "Send once". The thread appears in the desktop app marked "From" the stage's name.
3. **A laptop approval, from the phone.** The laptop thread asks before a command; the phone gets "Approval needed"; the owner answers in the mobile app.
4. **The result.** The laptop thread ends; the cloud task completes and its parent wakes with the reply.
5. **A declined send.** A second request; "Decline"; no thread appears on the laptop.
6. **Sleep.** Start a longer task, then close the laptop's lid or cut its network for ten minutes (quitting the app would end the running turn). The panel shows the machine as not answering; on reopening, the task completes.
6a. **The loop is closed.** From a laptop thread, ask the laptop's agent to use the cloud to start a thread back on the laptop: the cloud refuses, because that work is Linked work.
6b. **Revoked there.** With a task open, revoke the cloud's session in the laptop's Sharing & access: the panel shows "revoked there" and the task fails with that reason. Link again for step 7.
7. **Ending it.** Global switch off, taking the offer to stop the laptop's threads first (a waiting task fails with that reason); Unlink in the panel; revoke the session on the laptop. After part two: destroy the stage.

**Part two, the other Routes.**

8. **Own tunnel (about 25 minutes, 20 of them setup).** Run the `cloudflare-tunnel` wizard on the laptop: a tunnel, a hostname to `http://localhost:<t3's port>`, an Access application with a Service Auth policy, a service token, `cloudflared` as a launch agent. Enter the Route and the token in the panel; the panel shows Access in front. Link over this Route alone; one approved send completes; a browser opening the hostname meets Access, not t3.
9. **Funnel (about 20 minutes, up to 10 of them waiting for DNS).** Run the `tailscale-funnel` wizard: Funnel on for the node, `https` on 443 to t3's port. Register the Route; link over it alone; one approved send completes.
10. **Order (5 minutes).** Register all three, own tunnel first; link once. Stop the laptop's `cloudflared` launch agent: the next call leaves over T3 Connect, and the panel shows which Route answered.
11. **Teardown.** For each of the two: keep it for prod's own link, or remove it. Funnel: `tailscale funnel` off, or recorded as staying public. Own tunnel: the launch agent, the tunnel, the Access application and the service token deleted, or kept and re-entered on prod. Then unlink, revoke on the laptop and destroy the stage.

Then, on prod: the owner's own link over the Routes he chose (five minutes), and, if a `cloudflare-tunnel` Route's hostname is in `ianpascoe.dev`, one approved send over it. Prod is the only place the same-zone path exists, so this is its proof.

## 10. The stage stand-in (D16, D21, D25)

A stock `t3` from npm at the pin, in a Docker container on the machine that runs the stage scripts, with a throwaway home and state directory (step 3's `scripts/lib/laptop.ts` is the starting point). Its agents run in that container, never as the owner's user, and the hostile prompts read canary files planted there.

**The tunnel is a named Cloudflare Tunnel made by the stage's alchemy stack,** only when the stage asks for a stand-in (`T3FLARE_STANDIN=1`); prod's stack never makes one.

- **Resources:** `Cloudflare.Tunnel.Tunnel` (in `@alchemy.run/cloudflare` 2.0.0-beta.85 as installed) with one ingress rule to the container's t3 port and a 404 catch-all, plus two proxied DNS `CNAME`s to `<tunnel id>.cfargotunnel.com`, and for the first an Access application with a Service Auth policy and a service token (the stack already makes both kinds of resource for the admin routes). alchemy's `Tunnel.HostnameRoute` is the private-network route, not this.
- **Hostnames:** `t3flare-<stage>-standin.ianpascoe.dev` behind Access, the `cloudflare-tunnel` Route; `t3flare-<stage>-open.ianpascoe.dev` with no Access, standing in for a `t3-connect` or `tailscale-funnel` Route. One label under the apex each, so the zone's Universal certificate covers them. The zone is the one prod is served from.
- **No same-zone fetch arises.** A stage without `T3FLARE_DOMAIN` is served at `<name>.<subdomain>.workers.dev` (`alchemy.run.ts:90-93`), so its fetch to `ianpascoe.dev` is ordinary internet traffic. Only one stage may hold a domain in the zone, and that is prod, which never calls a stand-in: prod's Route rules refuse the stand-in scheme. The zone's rate-limit rule names prod's host alone.
- **The open hostname has no Access in front,** matching T3 Connect's and Funnel's exposure: t3's own auth is the gate, on a server that holds nothing of the owner's. The two hostnames on one connector also give the order test: the stack drops one hostname's ingress rule, and calls move to the other.
- **The tunnel token** is a stack output. The stage script passes it to the container's `cloudflared` (`TUNNEL_TOKEN`) and never prints it; it is destroyed with the stage, tunnel and record included.
- **Sleep is simulated** by stopping the container's `cloudflared`: Cloudflare then answers 530, as for a sleeping laptop.
- **To confirm in M0 (G1):** that the stage's deploy credentials may create a tunnel and a DNS record in the zone, and that the zone's bot settings do not challenge a Worker's request. Prod's CI token gains neither permission.

## 11. The two items that land first

### 11.1 Pre-A: SPI-1060

**Landed** in `efd7243` as `apps/agents/src/extensions/t3-guidance.ts`, with the `notListed` rewrite of review M1 in `apps/environment/src/t3/peerLinks.ts` ([report](spi-1061-pre.md)). As planned:

- **Where:** the `t3_orchestration` section is built in the Session (`t3-mcp.ts`), which knows the offered catalog. The filter runs there, on t3's text as the adapter hands it over.
- **Filter:** t3's guidance is a list of bullets and numbered steps. A bullet that names a tool not offered is dropped whole; a heading left with no bullets goes with them. The offered tools' descriptions get the same treatment by sentence.
- **Classification:** every backticked tool-like name in the guidance and in the descriptions is in one table: offered, withheld, or not a tool. The test fails on a name that is in none, so a bump that names a new tool is caught.
- **Our line,** added after the filter: links to other machines are made by the owner, never by an agent; `t3_environment_links` lists what is linked; with nothing linked, say so. Once the Outbound link exists (M2), it adds that every message to another machine asks the owner first.
- **Test (SPI-1060's own):** no tool name outside the offered set appears in the system prompt or in a tool description.

### 11.2 Pre-B: the refusal

**Landed** in `efd7243` as `apps/environment/src/t3/peerLinks.ts`, wider than first planned (review H2, M6 and a LOW): Layers over `PeerLinks`, `PeerForwarding.links` and `PeerLinkRequests`. `link` is refused (`disabled`, "No machine is registered…"); `resolve` fails as `expired`, a final reason, so a stored link cannot be used and a follower ends; `list` is empty and probes nothing; `request` raises no link card; no `PeerLinkError` carries a `cause`. `GET /_t3flare/peer-links/count` reads the link table's size and nothing else. It is S4 with nothing registered, and M1 fills it in. Inbound links do not pass through it.

## 12. Fragility entries

Numbered after the tools step's U40–U44. **U45 and U49 are written** on `main` for the pre-items (`efd7243`); M7 widens U45 to S2–S4 as built and writes U46–U48.

| Entry | Relies on | Breaks when | Detection |
|---|---|---|---|
| **U45** The policy Layers over t3's peer services (S2–S4) | `PeerForwarding`'s five methods and its being the only way to the peer (`McpToolAccess.routed`, `RemoteDelegation`); `PeerMcpClient.call`'s input; `PeerLinks.link`/`resolve` and `PeerLinkCreateInput`; `McpInvocationScope`, `callerLinkOrigin`; `RemoteDelegation.isFinal`'s codes and `fromLinkError` making `expired` final; `RemoteDelegation.delegate`'s derivation of the launch it forwards (the Send permit is over that call); where t3 hands an approval's answer to our adapter, with its source | a bump adds a method or a second path to the peer, renames a field, or changes which codes end a follower | typecheck (each wrapper implements the whole service type); the choke-point unit test on t3's real layers; `acceptance --outbound` |
| **U46** Classified forwardable tools | `takesLinkedEnvironment`'s rule; each forwarded tool's actions (`t3_queue`, `t3_pending_request`); which called tools act as their calling thread and what they forward as; each send's argument names and retry key; `reason` on a stop; the result shapes that carry a started thread's id | a bump adds a forwardable tool, an action to a two-behaviour tool, or changes a result shape | the enumeration test; G4's per-tool cases kept as unit tests |
| **U47** The peer `HttpClient` (S5) and the Routes | `PeerLinks` and `PeerMcpClient` taking `HttpClient` from context; `MODE_LIMIT_HEADER` and its `<runtime>/<interaction>` form; t3 deriving its issuer from `Host` and `X-Forwarded-Proto`, so a Route's proxy must pass both; the T3 Connect hostname pattern; t3 allowing `http` for `.ts.net` (ours refuses); the MCP Worker's guarded fetch | a peer service fetches outside the injected client; the header or the pattern changes; t3 starts binding a session to the address it was made at (today it checks the resource at sign-in only, so one bearer serves every Route) | a unit test that S5 never fires when S2–S4 pass, and fires for a foreign origin; typecheck on the constant; the bump's check of the pattern; `acceptance --outbound` over both stand-in hostnames |
| **U48** The idle check reads open Remote tasks (extends U2) | the tables and JSON paths that hold a task's remote child and status; `peer_environment_links.last_error` | a bump reshapes them | fail-safe as U2 (`idle-check-unreadable`); `scripts/peer-idle.ts` |
| **U49** Classified guidance (SPI-1060) | `T3_CODE_ORCHESTRATION_INSTRUCTIONS` being bullets that name tools in backticks | t3 names a new tool, or rewrites the guidance as prose | the classification test |

Extended, not new: **U5** (MCP, `delegate_task`, `linkOrigin`) for the Outbound direction; **U37** (cards injected by the CLI wrapper) for send cards.

## 13. t3code impact

The tree is not touched. Everything is our code or a Layer: three wrapping Layers and a scoped `HttpClient` in `composition.ts`, the Session's gate, the relay's gate, the idle check, the panel. **Shadows 2, Patches 3, unchanged**; no Build shim. G2 is the gate on that claim.

## 14. Files and seams

| File | Change | Seam |
|---|---|---|
| `apps/environment/src/outbound/policy.ts` (new) | the registration, both switches, the cap; pure decisions with a table test | S2–S5 |
| `apps/environment/src/outbound/toolClasses.ts` (new) | S2's table by forwarded tool and action, S1's by called tool, and the test that they agree | S1, S2, S3 |
| `apps/environment/src/outbound/permits.ts` (new) | pending sends and Send permits: record, approve (from an owner client's answer only), match, use, expire; the decline count per thread | S2 |
| `apps/environment/src/outbound/ledger.ts` (new) | the Outbound work ledger | S2 |
| `apps/environment/src/t3/peerLinks.ts` (Pre-B, exists) | grown from "nothing registered" into the Layers over `PeerForwarding`, `PeerMcpClient` and `PeerLinks`; the scoped `HttpClient`, which sends through the MCP Worker | S2–S5 |
| `apps/environment/src/outbound/routes.ts` (new) | Route kinds, their hostname forms, the registration checks (https, not our own hosts, Access in front) | S4, S5 |
| `apps/mcp-worker/` (tools step) | `peerFetch`: the guarded fetch for peer requests (one allowed origin per call, https, no redirect followed, the 75 s and 4 MiB limits, the Access headers added here from a value passed beside the request, its scrub covering them, nothing stored); a test that the Worker has no public route and refuses a call without exactly one allowed origin | S5 |
| `apps/environment/src/platform/secretStore.ts` | key `outbound/<machine>/<route>/access-token`, write-only helpers (as the tools step's `harness/mcp/…`) | — |
| `apps/environment/scripts/wizards/laptop-cloudflare-tunnel.sh`, `laptop-tailscale-funnel.sh` (new) | the laptop-side setup the owner runs himself | — |
| `apps/environment/src/t3/composition.ts` | provide those in place of t3's bare layers (line 732) | S2–S5 |
| `apps/environment/src/environmentDO.ts` | `outboundPending()` (read-only: the card's content for a pending send); no RPC makes a permit: the adapter and the CLI wrapper approve a pending send where t3 hands them an owner client's answer; `mcp()` and `mcpForThread()` pass the calling thread | S1 |
| `apps/environment/src/host/idle.ts` | open Remote tasks as work; the standing alarm and its backoff | — |
| `apps/environment/src/host/peerLeak.ts` | `peer-link-*` as a canary | — |
| `apps/environment/src/host/redactingConsole.ts` | the Access header names beside `Bearer` and `token=` | — |
| `apps/environment/src/harness/` (tools step) | the Outbound links section and its JSON routes | — |
| `apps/environment/src/provider/cli/cliAsk.ts`, `wrapper.ts` (tools step) | ask kind `send` beside `push` and `tool` | S1 |
| `apps/environment/src/provider/differ.ts` | the send card's detail | S1 |
| `apps/agents/src/extensions/t3-mcp.ts` | the guidance filter and our line (Pre-A, done, in `t3-guidance.ts`); for a call that names another Environment: the early refusals, the retry key, the card on "needs approval" and the re-run | S1 |
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
| 9 | SPI-1075 | Attachments on an Outbound send | Low | t3 itself refuses attachments on a forwarded call (`PeerForwarding.ts:140-145`), and the send card could not show them. To allow them, the card must show each attachment (name, type, size, a preview or a hash) and the permit must bind them. |

Ticket 9 replaces the interview's earlier "the owner's-tunnel path if E1 is answered no", which this step now builds as a Route.

## 16. Risks and residuals

- **The owner approves words, not behaviour.** An approved message can still bring back something sensitive the laptop agent read, or point at instructions that live in a repository. The card and the laptop's approvals narrow this; nothing closes it.
- **A compromise of the Environment DO is a supervised foothold on the laptop** for the life of the link: threads it starts there ask before a command or an edit, but can read.
- **Each Route has its own exposure.** `t3-connect`: public, and the relay operator controls the hostname and can mint laptop sessions (E1, accepted). `tailscale-funnel`: public, with a hostname that certificate logs publish; no third party can mint a session. `cloudflare-tunnel`: nothing anonymous reaches t3, but Cloudflare ends the TLS and the cloud holds one more credential. Every Route registered is one more door to the laptop; the owner registers only those he wants.
- **The service token is sent before the peer is identified.** It goes to the Route's hostname on every request, the descriptor read included, over TLS. It opens only the owner's own Access application.
- **The desktop app's port can move.** It takes 3773 unless that is busy, then the next free port (`apps/desktop/src/app/DesktopApp.ts:43, 96`). An own tunnel or Funnel pointed at 3773 would then serve whatever took it: behind Access for the tunnel, in public for Funnel. The environment-id check keeps the pairing code and the bearer from such a stray service; the wizards pin `T3CODE_PORT` where they can and check the descriptor before they finish.
- **The environment-id check is not authentication** (review M8). Whoever controls a Route's hostname and answers with the right id receives the bearer and every message. The trust is in who owns the hostname, plus TLS (§6.6).
- **A full-access Inbound link can put words in the owner's threads** (review M4). The send still asks, and the card says what it can about where the instruction came from, but a thread that looks like the owner's may carry a link's instruction.
- **The same-zone path is proved on prod only** (§9), because no stage has a domain in prod's zone.
- **Asked twice.** A send asks in the cloud, then each command asks on the laptop. Unattended work on the laptop is not what this step delivers (ticket 2).
- **Link time is the one moment the cloud could ask for more** than Supervised (D14); the owner's check of the laptop's Sharing & access is the control.
- **Switching off does not stop the laptop's threads** unless the owner takes the panel's offer to stop them first.
- **Dependence on the `tools` step.** S1 for CLI agents, the card's generalised form and the panel are that step's; a change there moves M2, M3 and M5.
