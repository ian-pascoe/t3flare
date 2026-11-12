# Review: SPI-1061 plan (Outbound link)

**Verdict: go with changes.** The five-seam design is sound and fails closed in most places I probed. Two things need fixing in the plan before M1: how the Send permit binds what actually leaves (H1), and Pre-B's scope (H2). Pre-A needs one addition (M1) before it ships.

**What I checked.** I read the plan, ADR-0029, `peer/PeerForwarding.ts`, `PeerMcpClient.ts`, `PeerLinks.ts`, `RemoteDelegation.ts`, parts of `PeerLinkRequests.ts`, `McpToolAccess.ts`, `linkOrigin.ts`, the contracts' tool inputs, `t3-mcp.ts`, `composition.ts:712-735` and the head of `host/idle.ts`.

**What I did not check.**
- ADRs 0001, 0010, 0013, 0025, GLOSSARY and `spi-992.md` were not read in full, and ADR-0011 and the tools plan and review only by grep.
- `origin/tools` code: I only listed `.worktrees/tools/apps/mcp-worker`.
- Nothing was run, so workerd feasibility (G2) is unverified.
- `cloud/*` was listed but not read.

Paths below are under `t3code/apps/server/src/` unless they start with `apps/`, `docs/` or `packages/` (the last under `t3code/`).

## HIGH

### H1. The Send permit is not defined over what leaves, and `delegate_task` cannot match as written
- **Evidence.** S1 sees `delegate_task`; S2 never does. `RemoteDelegation.delegate` (`peer/RemoteDelegation.ts:189-283`) turns it into:
  - paged `t3_project_list` reads to resolve the project by repository (`:143-187`), when the caller names none;
  - a `t3_thread_launch` whose arguments S1 never saw: inherited model and options (`:226-240`), `title = input.title ?? parent.thread.title` (`:263`), `message = taskPrompt(input)` (`:262`), `delegatedFrom` carrying the parent's title (`:277-281`), and `clientRequestId = delegate:<thread>:<key>` (`:275`), where `key` is a fresh UUID when the caller gave none (`:261`).
- **Why it matters.** The plan's permit names "the tool … and the arguments the card showed" (§5), and G4 only asks whether arguments survive t3's decode. For the step's main use, the tool name, project, model, title and key all differ. The outcomes are a dead feature (M2's exit fails) or a match loosened to thread plus machine, which makes S2 a formality.
- **The card cannot show the project** without a forwarded read first, which §5 does not mention.
- **Fix.** Bind the permit to the forwarded call, built where it leaves:
  - S2, on a send with no permit, records a pending send (forwarded tool, machine, canonical decoded arguments, scope thread) and fails with a typed "needs approval" refusal carrying its id. Nothing has left but reads.
  - S1 renders the card from that record, not from its own arguments.
  - The Environment DO, not the Session or relay, turns the record into a permit when the owner's answer arrives.
  - S1 re-runs the same call with the same `clientRequestId`, which it must always set (already done for keyed tools, `apps/agents/src/extensions/t3-mcp.ts:183`).
  - This also removes `outboundPermit()` as an RPC the agents Worker can call (§14), so a relay or Session bug cannot mint one.
- **Add to G4:** the `delegate_task` derivation, and whether the retry key survives a re-run.

### H2. Pre-B refuses `link` only; a link that already exists stays usable
- **Evidence.**
  - §11.2 wraps `link` alone. `resolve` (`peer/PeerLinks.ts:615-672`) and `list` are untouched.
  - Prod has accepted `peerLinks.link` from any `access:write` client since step 0 (`packages/contracts/src/clientRpcPermissions.ts:76`).
  - The Durable agent is offered `t3_thread_launch`, `t3_thread_send`, `t3_thread_list`, `t3_thread_read` and `schedule_task` (`apps/agents/src/extensions/t3-mcp.ts:32-78`). In full access nothing asks (`:172`), and all of these forward when given an `environmentId` (`mcp/McpToolAccess.ts:397-405`).
- **Why it matters.** If a row exists in `peer_environment_links`, Pre-B leaves it fully usable with no card until M1. `peerLinks.list` also probes every stored address from the Environment Worker, which lacks the strictly-public flag (`PeerLinks.ts:565-590`).
- **Fix.**
  - Pre-B also fails `resolve` (reason `expired` or `incompatible`, so followers end; see M9) and returns an empty `list`.
  - Its acceptance case asserts the table is empty on the stage, and a count-only admin check does so on prod.
- **Otherwise Pre-B is safe to ship first.**
  - Inbound links do not touch `PeerLinks`: they sign in through the laptop-side script and the cloud's own MCP OAuth.
  - No script calls the cloud's `link`: `peer-e2e.ts:93` and `peer-laptop.ts:73` run `t3 environment link` on the stand-in.
  - `acceptance.ts --peer` exists (`apps/environment/scripts/acceptance.ts:290`).
  - The wrap sits at one provide site (`apps/environment/src/t3/composition.ts:732`), which `ws.ts`, `PeerLinkRequests`, `RemoteDelegation`, `PeerForwarding` and `PeerMcpClient` all resolve through.

## MEDIUM

### M1. Pre-A misses tool results: `t3_environment_links` tells the agent to call the withheld tool
- **Evidence.** `peer/PeerForwarding.ts:238-239` returns `notListed: "… Call t3_environment_link with a hint from the user's words."` in every result (`:261`), and the tool is on the allowlist. `PeerLinkRequests.ts:451` has a similar line.
- **Why it matters.** SPI-1060's test covers the prompt and descriptions only, so the agent is still pointed at the withheld tool after Pre-A.
- **Fix.** Pre-A or Pre-B adds a Layer over `PeerForwarding.links` that replaces `notListed` with our line; S2 keeps it. Extend the test to the result of `t3_environment_links` with nothing linked.

### M2. The classification table does not match the pin, and S3 guards sends only
- **Evidence.**
  - `t3_queue` has no "adding" action. Its actions are `list, read, edit, cancel, reorder, promote_to_steer` (`mcp/toolkits/thread/tools.ts:82-103`). `edit` replaces a queued message with up to 100,000 characters, so it is a send. Approve A, then edit to B.
  - `t3_pending_request` has `read` as well as `list` and `respond` (`:132`).
  - `delegate_task`, `task_cancel`, `task_status`, `t3_background_wait`, `create_threads` and `t3_workflow_stop` never reach `PeerForwarding` under their own names (`mcp/toolkits/orchestrator/handlers.ts:29-141`, `actsAsCaller`). S2 sees `t3_thread_launch`, `t3_thread_read`, `t3_thread_wait`, `t3_thread_interrupt` and `t3_project_list`.
  - `schedule_task` and its list, update and delete tools are forwardable (`packages/contracts/src/orchestratorMcp.ts:668-885`).
  - S3 as written requires S2's mark for sends only; the ledger argument for reads ("a path that skips S2 records nothing") depends on S2 running.
- **Fix.**
  - Two tables: S1 keyed by called tool, S2 keyed by forwarded tool and action.
  - `t3_queue`: `edit` is send or refused; `promote_to_steer` and `reorder` are refused; `list` and `read` are reads of Outbound work.
  - S3 refuses every call that lacks S2's mark, not just sends.
  - S2 lets a send to an existing thread through only if the thread is in the ledger. The laptop's `assertSameLink` already does this; do not rely on it alone.

### M3. Free text reaches the laptop on paths that never ask
- **Evidence.**
  - `OrchestratorMcpThreadInterruptInput.reason` allows 2,000 characters (`packages/contracts/src/orchestratorMcp.ts:565`). It is forwarded by `stopThere` from `task_cancel`'s `reason` (`peer/RemoteDelegation.ts:423-436, 706-737`) and by a direct `t3_thread_interrupt`. Both are "stop: never asks".
  - `delegatedFrom.title` is the parent thread's title (`:277-281`).
  - `t3_thread_launch` takes an explicit `runtimeMode` (`mcp/toolkits/project/tools.ts:139`).
- **Fix.**
  - S2 drops or replaces `reason` with a fixed string on stop-class calls.
  - The card shows `title` and `delegatedFrom`.
  - S3 clamps `runtimeMode` in the arguments, not only the header. Otherwise H10's "runs approval-required (the clamp)" may instead be a mode refusal from the laptop.

### M4. The Linked-work refusal follows the thread's origin only
- **Evidence.** A full-access Inbound link is unfenced (`packages/contracts/src/orchestrationV2.ts:128`, `mcp/linkOrigin.ts:55-60`). Its work can send into an owner thread or create a schedule in the cloud. The resulting send then comes from a thread with no `linkOrigin` and passes S2's refusal.
- **Why it matters.** The card still gates the send, but it does not say that a link put the instruction there. H6 does not test this route.
- **Fix.** Either the card says "this thread received input from link X" (the Environment can record link-session writes per thread), or ADR-0029 rule 5 states the limit. Add a hostile test either way.

### M5. The answer-source check belongs in the Environment, and late approvals for CLI agents are undefined
- **Evidence.**
  - §5 and G3 put the "owner client only" check in S1. The answer's source (WS client, `t3_pending_request`, link session) is known where t3 dispatches it, in the Environment.
  - CLI tool timeouts are 660 s (`docs/steps/tools-plan.md:225-228`), and a permit lives 10 minutes. An approval that arrives after the CLI's call ended makes a permit nobody uses, and the next call asks again.
- **Fix.**
  - The Environment mints the permit only for an answer from an owner client session (pairs with H1).
  - For CLI agents, the card closes when its call ends, and the agent is told to call again while the owner is present. M3 adds a case for an answer after the timeout.

### M6. Credential leak paths through error objects
- **Evidence.**
  - `PeerLinkError.cause` is `Schema.Defect()` (`packages/contracts/src/peerLink.ts:73`). `signIn` fills it with the transport error (`peer/PeerLinks.ts:383-390`), which holds the request. It is returned over the WS RPC and logged.
  - The console redaction matches `Bearer …` and `token=` only (`apps/environment/src/host/redactingConsole.ts:14-18`). It would not catch `CF-Access-Client-Secret`.
- **Fix.**
  - Add the Access headers at the last hop (inside `peerFetch`, or after the Effect request is built), so no error value ever holds them.
  - S4 strips `cause` from every `PeerLinkError` it passes on.
  - Add the header to the redaction and to the MCP Worker's scrub.
  - H14 and H25 gain a forced transport error on each Route, with the scan run over the WS reply, `last_error` and both Workers' logs.

### M7. S5 needs its own timeout and size limit; long waits can starve the Environment's other fetches
- **Evidence.**
  - `PeerMcpClient.post` has no timeout and reads the whole body (`peer/PeerMcpClient.ts:104-114, 203-205`). It also does not set `redirect: "manual"`; only `PeerLinks` does, through `FetchHttpClient.RequestInit` (`PeerLinks.ts:208-210`), which a custom client ignores. The plan's "not followed" in S5 covers this; keep it explicit for both services.
  - Each open Remote task holds one 50 s request (`peer/PeerForwarding.ts:33, 182-212`).
  - Every call first probes each Route's descriptor in order, 10 s each (`PeerLinks.ts:52-53, 642-651`). A dead first Route adds 10 s to every wait piece.
  - Cloudflare allows 6 simultaneous outgoing connections per invocation and queues the rest; subrequests are 10,000 per request on paid (https://developers.cloudflare.com/workers/platform/limits/). I did not confirm how service-binding calls count toward the six.
- **Fix.**
  - S5 times out at about 75 s total, caps the body at a few MiB, and returns any 3xx as a status.
  - S2 caps open Remote tasks (three, say).
  - G8 adds: eight tasks waiting at once while a T3 Connect publish and a model call still go through; an N-hour follow with no client attached; the CLI relay path for subrequest depth (4a's failure, `docs/steps/step-4a.md:42`).

### M8. The environment-id check is not authentication
- **Evidence.** The descriptor is unauthenticated and the id is not secret (`PeerLinks.ts:222-247`). Whoever serves a Route's hostname with that id receives the bearer and every message on the next call (`PeerMcpClient.ts:104-110`). H12 and H23 test a different id only.
- **Why it matters.** The trust anchor is hostname ownership plus TLS.
- **Fix.**
  - G1 must answer whether a T3 Connect tunnel hostname can ever be reassigned to another account. If so, the Route needs a ticket, not a link.
  - §16 should say this in place of "the environment-id check keeps the bearer from it", which holds only for a stray local service.

### M9. Final-versus-retry codes need pinning
- **Evidence.** A `PeerLinkError` becomes final only for `expired` and `incompatible`; `disabled` and `unreachable` map to `orchestration_error`, which followers retry for ever (`PeerMcpClient.ts:69-78`, `RemoteDelegation.ts:113-116, 536`).
- **Fix.**
  - S4's `resolve` refusals use a final reason.
  - S2 answers `capability_denied` only for policy, and never for a failed read of its own store.
  - S5 fails as an `HttpClientError`, not a defect. H28's fall-through to the next Route depends on `describe` catching it (`PeerLinks.ts:227-237`).

### M10. Funnel has no M0 gate
- **Evidence.** G1 covers T3 Connect, G7 covers Access. Funnel's headers, ports and macOS behaviour are "still to be looked up" (§1) and first meet t3's issuer derivation in M6.
- **Fix.** Add G9: fifteen attended minutes for descriptor and sign-in over a real Funnel. If it fails, the Route drops to a ticket.

### M11. The owner proof
- **Stage rules are looser than prod's.** A stage "accepts its stand-in's hostnames from stage configuration", and "Access in front" is required "on prod" (§6.1, S4). Step 8 on a stage may never exercise the check. Fix: run the proof stage with prod's Route rules.
- **The stage holds a real 30-day bearer for the real laptop.** Fix: use a fresh stage that never ran hostile cases, and destroy it at the end.
- **Step 6 quits the desktop app.** That probably ends the running laptop turn, so "then the task completes" may not hold. Fix: simulate sleep by closing the lid or cutting the network.
- **No teardown for part two.** Funnel stays public. Fix: add steps to turn Funnel off or record that it stays, and to keep or delete the tunnel, Access application and service token.
- **Missing steps:**
  - revoke on the laptop while linked, and see "revoked there" and the task fail;
  - the laptop's own Inbound link tries the Outbound link and is refused;
  - a scratch project is named for every proof task, since reads never ask there.

## LOW

- **Switch-off orphans laptop threads.** A final refusal marks the task `stoppedThere: "stopped"` (`RemoteDelegation.ts:527-534`), so no stop is ever owed. D19 accepts that threads keep running. Fix: the panel offers "stop laptop threads first" and lists Outbound work still running.
- **`PeerLinkRequests.request` is reachable in principle** (`handlers.ts:196-202`). Only the allowlist withholds it today. Fix: a Layer that refuses it, so a relay or allowlist slip cannot raise t3's link card.
- **Card flood.** An injected agent can raise cards and phone notices without limit. Fix: after N declines in a thread, decline unasked.
- **Backoff state must be in DO storage.** The reset clears memory (`apps/environment/src/host/idle.ts:2-5`), and the single alarm must be the earlier of t3's due time and the Remote-task retry.
- **§10 contradicts D22 and §9.** It says prod "accepts a T3 Connect address only". Also state that prod refuses `t3flare-*-standin` and `-open` hostnames, which live in its own zone.
- **The MCP Worker's `peerFetch`** needs a test that it has no public route and refuses a call without exactly one allowed origin.
- **One bearer over several Routes** matches the code I read: the resource is checked at sign-in (`auth/McpOAuth.ts:397, 539`), and I found no audience check in `McpHttpServer.ts`. U47 is the right watch.

## Hostile tests to add

| # | Attempt | Expected |
|---|---|---|
| H31 | `delegate_task`: the card's project, model, title and message equal the laptop's received `t3_thread_launch` byte for byte; a changed argument on the re-run | refused |
| H32 | Approve a queued send, then `t3_queue edit` or `promote_to_steer` at the laptop | refused |
| H33 | `task_cancel` or `t3_thread_interrupt` with a 2,000-character `reason` | the reason does not arrive |
| H34 | A full-access Inbound link writes into an owner thread or a schedule, which then sends | the card names the link, or the send is refused |
| H35 | A forged `remoteChild` naming a laptop thread the cloud did not start | the follower's read, wait and stop are refused |
| H36 | Two identical concurrent sends, one approval | one leaves |
| H37 | A Route that accepts and never answers, or returns a 50 MiB body | timeout or cap; the Environment's other fetches still run |
| H38 | A forced transport error on each Route | no token in the WS error, `last_error` or logs |
| H39 | Any existing link row under Pre-B | cannot be resolved |
| H40 | `t3_environment_links` with nothing linked | names no withheld tool |
| H41 | A CLI approval arriving after the tool call timed out | no send without a new call and card |

## Checked and found sound

- `PeerForwarding` is the only user of `PeerMcpClient`, and `RemoteDelegation` reaches the peer only through it.
- Followers carry the parent thread in `followScope`, so S2 can judge them.
- `t3_thread_transfer` is local only.
- `t3_pending_request` cannot approve permission requests (`thread/tools.ts:130`).
- Attachments are already refused on forward (`PeerForwarding.ts:140-145`).
- S4 forcing `expectedEnvironmentId` avoids the address-only renew branch (`PeerLinks.ts:477-490`).
