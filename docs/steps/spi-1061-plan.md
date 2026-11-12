# Plan: SPI-1061, the Outbound link (stock t3, made reachable from the cloud)

Status: **rescoped by the owner on 2026-11-12.** No custom gates or logic: t3's own settings and link access levels govern the Outbound link, as on stock t3. Prompt injection is not a design driver. The gated design this replaces (send cards, a cap, a registered machine, five seams) and its Fable review are in git history (`e5cd0a2`) and in [`spi-1061-plan-review.md`](spi-1061-plan-review.md); §3 lists what was dropped. Pre-A and Pre-B are live on prod (`efd7243`, [report](spi-1061-pre.md)); Pre-B is removed by this plan's M1. Folds in SPI-1060.

Terms are GLOSSARY's: **Outbound link**, **Inbound link**, **Route**. Decisions are recorded in [ADR-0029](../adr/0029-the-outbound-link-is-t3s-own-unchanged-and-t3flare-adds-only-reachability.md) and ADR-0011's SPI-1061 refinement.

## 0. Summary

- The Cloud Environment links to the Laptop Environment with t3's own Peer link, unchanged, and nothing of ours stands between an agent and the link. The owner makes it in the stock client's Linked environments dialog, or an agent asks for it with t3's own link card. The access he picks there, and t3's own fence below full access, are the only limits.
- `t3_environment_link` and `t3_environment_unlink` go back on `T3_TOOL_ALLOWLIST`. Pre-B's refusal Layers come out.
- t3flare adds only what a Worker and a Durable Object need for stock behaviour to work:
  1. **Reachability:** the laptop's address is a plain https address, over T3 Connect, Tailscale Funnel or the owner's own Cloudflare Tunnel, each behind t3's own auth and nothing else.
  2. **Long Remote tasks** survive the Environment's idle reset and the laptop's sleep.
  3. **Leak hygiene:** the link's bearer stays out of Containers, Sessions, logs and errors.
- This no longer waits for the `tools` step: it uses no card, relay or panel of that step.

## 1. What the code has today

Verified at the pin (`t3code/`) and on `main`.

| Fact | Where |
|---|---|
| t3's peer stack is mounted in the cloud: `PeerLinks`, `PeerLinkRequests`, `PeerForwarding`, `PeerMcpClient`, `RemoteDelegation` (followers start at boot). `peerLinks` is a kept capability; Linked environments is seeded on | `apps/environment/src/t3/composition.ts`; `t3/capabilities.ts`; step 3, L1 |
| **Pre-B is live:** Layers over t3's `PeerLinks`, `PeerForwarding.links` and `PeerLinkRequests` refuse to make a link, fail a stored one as `expired`, answer the list empty, raise no link card, and strip `cause` from every `PeerLinkError`. `GET /_t3flare/peer-links/count` reads the link table's size | `apps/environment/src/t3/peerLinks.ts`; `host/admin.ts` |
| **Pre-A is live:** t3's guidance reaches the Durable agent filtered to the tools it is offered, with every tool name classified; a line of ours says this Environment cannot link out yet | `apps/agents/src/extensions/t3-guidance.ts` |
| The link tools are off the allowlist | `apps/agents/src/extensions/t3-mcp.ts` (`T3_TOOL_ALLOWLIST`) |
| A link needs an http(s) address and a pairing code; it checks the descriptor's environment id, signs in by MCP OAuth without a browser, and keeps a bearer (about 30 days, no refresh) in `ServerSecretStore`, which here is the Environment DO's secret store. It keeps every address that answered as the machine, and each call uses the first that still does | `t3code/apps/server/src/peer/PeerLinks.ts` |
| An agent's `t3_environment_link` raises a card in its thread; the owner's client answers with addresses and a pairing code that go straight to `PeerLinks.link`, never into the transcript; the agent hears the outcome as a notification | `peer/PeerLinkRequests.ts` |
| The stock client's Link dialog mints the pairing code on the target itself when it can, scoped to the access picked there (default Supervised) | `t3code/packages/client-runtime/src/state/peerPairingCode.ts:103`; `apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx:210-217` |
| Every tool with an `environmentId` target forwards through `PeerForwarding`; a forwarded wait goes out in pieces of at most 50 s; followers retry every failure except `capability_denied`, `thread_not_found` and `run_not_found` | `mcp/McpToolAccess.ts:378-405`; `peer/PeerForwarding.ts`; `peer/RemoteDelegation.ts` (`isFinal`) |
| t3 derives its sign-in issuer from the request's `Host` and `X-Forwarded-Proto`, so one server answers on any hostname whose proxy passes both | `t3code/docs/internals/environment-auth.md` |
| The idle reset does not count an open Remote task | `apps/environment/src/host/idle.ts` |
| The desktop app's server listens on `T3CODE_PORT`, else 3773, else the next free port | `t3code/apps/desktop/src/app/DesktopApp.ts:43, 96` |
| The console redaction covers `Bearer …` and `token=` only | `apps/environment/src/host/redactingConsole.ts` |
| A stage without `T3FLARE_DOMAIN` is served at workers.dev; only prod has a domain in `ianpascoe.dev` | `apps/environment/alchemy.run.ts:90-93` |

Researched, public (coordinator): T3 Connect's tunnel hostname is stable, in the relay operator's zone, and carries plain HTTP; Cloudflare answers 530 while no origin is connected; a Worker's fetch to another account's zone is ordinary internet traffic, while a fetch to its own zone goes to the zone's origin past Workers and security settings unless `global_fetch_strictly_public` is set; Quick Tunnels do not support Server-Sent Events.

## 2. Decisions

The ids are the design interview's (D1 is its Q1, and so on); only those that survive the rescope are here. "Over" names the strongest alternative rejected.

| Id | Decision | Why, and over what |
|---|---|---|
| **D1** | **A Route is a plain https address,** entered in t3's own link dialog or answered on its link card. Three kinds are supported: the laptop's T3 Connect tunnel hostname, a Tailscale Funnel address, and a hostname on the owner's own Cloudflare Tunnel. Each has t3's own auth in front and nothing else. | t3's link needs only an address and a pairing code, so the cloud holds no T3 Connect account and ADR-0010 and ADR-0025 stand. Over one fixed kind: the owner asked for all three. |
| **D2** | **A link is made as on stock t3:** by the owner in the Linked environments dialog, or by an agent asking with `t3_environment_link`, which raises t3's link card for the owner to answer. `t3_environment_link` and `t3_environment_unlink` go back on `T3_TOOL_ALLOWLIST`. | Owner decision: t3's own settings govern. Over keeping the tools withheld, which was this plan's earlier answer. |
| **D6** | **The bearer is where t3 puts it:** the Environment DO's secret store, for about 30 days, with no refresh. It ends by t3's own means: Unlink in a client (which forgets it here), and revoking the session on the laptop. | Stock behaviour. Over a panel section of ours for status and expiry. |
| **D7** | **An open Remote task is work.** While the laptop answers, the Environment stays up to follow it; while it does not, the Environment may reset and one alarm retries, backing off to 30 minutes, with its state in DO storage. No give-up timer: the task ends as t3 ends it. | Transport, not policy: on a laptop t3 never sleeps under its own followers, and here it does. Over stopping after N hours, which loses the result. |
| **D8** | **Pre-A's guidance filter stays.** It describes the tools actually offered, so with the link tools offered again their guidance returns by itself. Our line "this Environment cannot link to another machine yet" and Pre-B's rewrite of `t3_environment_links`' `notListed` go out with Pre-B. | The filter is what SPI-1060 asked for; the two link lines were true only while the tools were withheld. |
| **D9** | **Terms:** Inbound link, Outbound link, Route. Registered machine, Outbound work, Outbound send and Send permit leave the glossary with the mechanisms they named. | A glossary names what exists. |
| **D10** | **ADRs:** ADR-0029 is rewritten and renamed ("the Outbound link is t3's own, unchanged; t3flare adds only reachability"); ADR-0011's refinement is rewritten to match; ADR-0012's refinement for a typed Access service token is removed, since no such token exists. | |
| **D13** | **Order:** this step no longer waits for the `tools` step. Pre-B is removed in M1, in the same change that puts the link tools back. CLI agents get the link tools when the `tools` step's relay gives them t3's tools (SPI-1039), through the same allowlist. | Nothing here uses that step's cards, relay or panel. |
| **D15** | **Approvals on the laptop reach the owner's phone through the laptop's own T3 Connect,** as for any thread there: t3's publisher has no filter for link-started threads. Documented, nothing built. | |
| **D16** | **Stage runs use a throwaway stock `t3` in a Docker container,** never as the owner's user on the MacBook (§8). | A stage's agents start real threads there; that is test hygiene, not policy. |
| **D18** | **What the owner sees is t3's own:** the link card and the remote task item in the cloud thread, a thread marked "From" on the laptop, the link's session in the laptop's Sharing & access. | |
| **D20** | **Milestones M0–M3** (§5). | |
| **D21** | **The stage stand-in is exposed by a named Cloudflare Tunnel** the stage's alchemy stack creates, at one open hostname (§8). | Quick Tunnels do not support SSE, cap in-flight requests and change address per run. |
| **D23** | **The owner's own tunnel has no Access in front,** and peer HTTP leaves from the Environment Worker by t3's own client, as every other fetch does. No strictly-public Worker is used. A tunnel hostname in prod's own zone is reached directly: a same-zone fetch goes to the zone's origin, which for that hostname is the tunnel, and with no Access there is nothing it bypasses. | The earlier egress through the `tools` step's MCP Worker existed so that Access would judge the request. Over keeping it for uniformity: it is a mechanism of ours with nothing left to do. Proved on prod only (§7), since no stage has a domain in that zone. |
| **D24** | **Tailscale Funnel is a public `https://<node>.<tailnet>.ts.net` address** (port 443, 8443 or 10000). A tailnet-only address cannot work: a Worker is not on the tailnet. | |
| **D25** | **The owner proof covers all three kinds** (§7); stages prove the mechanics against the stand-in. | T3 Connect and Funnel cannot be made by a stage's stack. |

Both earlier escalations are closed: **E1** (T3 Connect in the path) was answered yes and stands; **E2** (an Access service token typed into the panel) is void, because no Access is in front of the owner's tunnel.

## 3. Considered, dropped by the owner

Each was in the gated design (`e5cd0a2`). The owner dropped them on 2026-11-12: t3's own settings and link access levels govern, and prompt injection is not a design driver.

- **The send card and the Send permit** (D4, D12; seams S1–S3): a card of ours for every message a cloud agent sends to the laptop, and a permit matched where the call leaves.
- **The Supervised cap** (D3, D14): a hard ceiling of `approval-required` on the link and on every call. The access is now whatever the owner picks in t3's dialog or card.
- **The Linked-work refusal** (D5): refusing the Outbound link to work an Inbound link started, at any access. t3's own rule applies: a link below full access cannot use this Environment's links, a full-access one can.
- **The Registered machine and its allowlist** (D1, D22): a machine and its addresses set behind Access, with requests refused to any other address.
- **The S4 policy** (D11): a Layer over `PeerLinks` replacing the client's addresses, forcing the environment id, and checking Access in front.
- **The per-machine and global switches** (D19). t3's own controls remain: Linked environments in Settings → Labs, Unlink, and revoking the session on the laptop.
- **The read limits** (D4): forwarded reads only of threads the cloud started. t3 does not fence reads over a link.
- **With them:** the S5 `HttpClient` and its limits, the cap on open Remote tasks, the tool classification tables, the harness panel section, the Access service token (D23, E2), the Route hostname rules, and hostile tests H1–H41 except the leak scan.

## 4. What stock behaviour means here

Stated once, so nobody reads a guarantee into this step that it does not make.

- **A linked cloud agent acts on the laptop up to the link's access.** Its tool call asks or not by its own thread's mode, as any t3 tool does (ADR-0022); a thread it starts on the laptop then runs under the narrower of the link's access and the calling thread's mode, and asks there as that mode says.
- **Below full access, t3's Link fence holds on the laptop:** the link changes only threads it started, and skips project setup scripts. A full-access link is not fenced.
- **Reads over a link are not fenced by t3.** A cloud agent can list, read and search the laptop's threads.
- **A full-access Inbound link may use this Environment's Outbound link** (t3 bars only links below full access), so laptop → cloud → laptop is possible at that level.
- **The bearer in the Environment DO is worth what the link's access is worth,** for about 30 days or until the owner revokes it on the laptop.
- **Every Route is public, behind t3's own auth.** A Route is trusted by who controls its hostname, plus TLS: t3's descriptor is unauthenticated, and the environment-id check only catches a wrong or stray answerer.
- **The desktop app's port can move** off 3773 when it is busy. An own tunnel or a Funnel pointed at 3773 would then serve whatever took the port, in public (SPI-1074).

## 5. What is built, and the milestones

### 5.1 The link tools return, and Pre-B goes (M1)

One change, since each half is wrong without the other:

- **`T3_TOOL_ALLOWLIST`** gains `t3_environment_link` and `t3_environment_unlink` (`apps/agents/src/extensions/t3-mcp.ts`). They ask or not as every t3 tool does (ADR-0022): read-only tools never, nothing in full access, otherwise a permission request. An approved `t3_environment_link` raises t3's link card, which the owner answers in his client.
- **The guidance classification** (`t3-guidance.ts`) moves the two tools to "offered", so t3's own bullets about linking pass the filter again. Our line "this Environment cannot link to another machine yet" is deleted.
- **Pre-B's Layers** (`apps/environment/src/t3/peerLinks.ts`) are removed: `link` is t3's again, a stored link resolves, the list is t3's, `PeerLinkRequests.request` raises its card, and `t3_environment_links`' `notListed` is t3's own sentence, which now points at a tool the agent has.
- **What stays of that file is the `cause` stripping, because it is a leak fix and not a gate** (§5.4). `GET /_t3flare/peer-links/count` stays too: it reads a count.
- **`acceptance --peer`'s `outbound` check** flips from "a link is refused" to "a link to the stand-in is made and used".

### 5.2 Routes

Nothing is built in the cloud for a Route: it is an address t3 stores. What each kind needs on the laptop goes into a short runbook (`docs/outbound-link.md`), which the owner follows himself.

| Kind | Address | The laptop runs | Notes |
|---|---|---|---|
| T3 Connect | the tunnel hostname T3 Connect gave the laptop | nothing new: T3 Connect is on | The stock Link dialog offers it when the app knows the laptop. The relay operator is in the path (E1, accepted). |
| Tailscale Funnel | `https://<node>.<tailnet>.ts.net`, port 443, 8443 or 10000 | `tailscale funnel` to t3's port | Its hostname is published in certificate logs. t3 accepts plain `http` for a `.ts.net` address, but from a Worker only the public https one answers. |
| The owner's own Cloudflare Tunnel | a hostname of his | `cloudflared` as a launch agent, the hostname to `http://localhost:<t3's port>`, `Host` left as it is | No Access in front (D23). In prod's own zone it is reached as a same-zone fetch, straight to the tunnel. |

- **All three end at the same t3 server,** which answers on any hostname whose proxy passes `Host` and `X-Forwarded-Proto`.
- **Several Routes for one machine are t3's own feature:** the dialog links over every address the app has for the laptop, t3 keeps those that answered, and each call uses the first that still does.
- **The runbook says how to find and pin the port** (`T3CODE_PORT`), and to check the descriptor at the public address before linking.
- **Later, optional** (SPI-1072): Access with a service token in front of the owner's tunnel, or a tunnel binding with no public hostname. Either needs a header Layer or a binding of ours, which this step does not add.

### 5.3 Long Remote tasks (M2)

- The idle check reads open Remote tasks from t3's tables, as it reads open runs, and fails safe the same way: an unreadable table means "don't know", never "no work" (fragility U2).
- **Laptop answering:** an open Remote task holds the Environment up. Staying up costs about $0.0056 an hour.
- **Laptop not answering** on any Route (asleep, its tunnel reclaimed, 530): the hold lapses, the Environment may reset, and the alarm brings it back to try again after 5, 15, then 30 minutes, staying at 30. The retry state is in DO storage, since a reset clears memory.
- **One alarm,** the earlier of t3's own next due time and the next retry, standing whenever a Remote task is open, so a deploy or an eviction cannot strand one.
- The task ends when t3 ends it: completion, the owner's cancel, or a final refusal (the link expired, revoked or forgotten).

### 5.4 Leak hygiene (M3)

Not policy: where a credential may be found, not who may use the link.

- **The bearer** (`peer-link-*` in the Environment DO's secret store) never enters a Session, a Workspace or a Container. That holds by construction, since only t3's peer services in the Environment read it; step 3's leak scan (`host/peerLeak.ts`) gains it as a canary so that it keeps holding.
- **Errors:** a `PeerLinkError`'s `cause` can hold the transport error of a sign-in or a call, and with it the request: an address, the pairing code, the bearer. It goes back over the WS RPC and into `last_error`. The Layer that strips `cause` stays (`peerLinks.ts`, from Pre-B), wrapping t3's `PeerLinks` and changing nothing else.
- **Logs:** the console redaction covers `Bearer …` and `token=`. M3 forces a transport error at sign-in and on a call, on each Route kind the stand-in gives, and scans the WS reply, `last_error` and Workers Logs for the bearer and the pairing code; whatever shows is added to the redaction.
- The pairing code is one-time and lives five minutes, and it is sent only to the address the owner picked or typed. That is t3's.

### 5.5 Milestones

| Milestone | Scope | Exit evidence |
|---|---|---|
| **Pre-A, Pre-B** (done, `efd7243`) | The SPI-1060 guidance filter; the refusal Layers | [report](spi-1061-pre.md) |
| **M0** | Probes, with stop gates (below), against the stand-in (§8) on a stage built with Pre-B removed | one results file per gate under `docs/steps/spi-1061/` |
| **M1** | §5.1; a stock link and a `delegate_task` round trip on a stage | `acceptance --peer` `outbound`; C1–C3 and C7 (§6) |
| **M2** | §5.3 | a task survives an idle reset, a deploy and a stopped connector; the backoff wakes recorded; C4 |
| **M3** | §5.4; the runbook; documents; the owner proof (§7); prod's own link | C5, C6; the proof's checklist; ADR-0011's refinement and ADR-0029 as built, ADR-0022's allowlist note, `docs/parity.md` (the cloud-to-laptop row), `docs/upstream-fragility.md`, `docs/steps/spi-1061.md` |

### 5.6 M0 stop gates

| Gate | Question | If it fails |
|---|---|---|
| **G1** | From a stage Worker to the stand-in's hostname: does a Peer link's pairing-code sign-in work, do forwarded calls answer (JSON or SSE), does a 50 s wait piece survive, does a stopped connector read as unreachable (530)? | Stop and replan: nothing else in this step works without it. |
| **G2** | On a Durable agent's thread, does `t3_environment_link` raise t3's link card in the stock clients, does the owner's answer make the link, and is the agent woken with the outcome? | The owner links from the dialog only, and the tool stays withheld until the card works (ticket). |
| **G3** | Can the idle check read open Remote tasks from t3's tables, and does a follower resume from the alarm after a reset? | Hold the Environment up for the whole of an open Remote task, laptop answering or not, and ticket the backoff. |
| **G4** | With several Remote tasks waiting at once (eight, say), do a model call and a T3 Connect publish still go through? Cloudflare allows six outgoing connections at once, and each wait holds one for up to 50 s. | Record the number that works in the runbook and ticket a limit; nothing is refused by us in this step. |
| **G5** | Over the real thing, attended: a link's sign-in through the laptop's T3 Connect address (ten minutes) and through a Tailscale Funnel (fifteen), so that both pass `Host` and `X-Forwarded-Proto` as t3 needs. | That kind is a ticket, not a supported Route. |

The same-zone path of D23 has no stage gate: it exists only on prod and is proved there (§7).

## 6. Checks

What replaces the gated design's hostile tests. Each runs on a stage against the stand-in, by `scripts/outbound.ts`, and is recorded as JSON.

| # | Check | Expected |
|---|---|---|
| **C1** | The owner links the stage to the stand-in from the stock client's dialog; the Durable agent runs `delegate_task` there | the thread runs on the stand-in marked "From" the stage; its last reply completes the task and wakes the parent |
| **C2** | The agent calls `t3_environment_link` with nothing linked | t3's link card; the owner's answer links; the agent hears the outcome; the pairing code is in no transcript |
| **C3** | The guidance and `t3_environment_links`' result, with the link tools offered | they name only tools the agent has (SPI-1060's test, still passing) |
| **C4** | A long task while the Environment idles out, while a deploy lands, and while the stand-in's connector is stopped for ten minutes | the task completes each time; the wakes follow the backoff |
| **C5** | The leak scan with the bearer as a canary, after C1–C4 | absent from every Session, Workspace, Container, push, snapshot and `/_t3flare/agents/session` |
| **C6** | A forced transport error at sign-in and on a call | no bearer and no pairing code in the WS reply, `last_error` or Workers Logs |
| **C7** | An expired bearer; the session revoked on the stand-in | t3's own answers: the tool error names it, and an open task fails with that reason |

## 7. The owner proof (M3)

On a fresh stage, against the owner's real desktop app; the stage is destroyed at the end, because it holds a real bearer for the real laptop. Every task names a scratch project on the laptop. Part one is about 25 minutes attended; part two about 35 more, most of it one-time setup, and it can be a second sitting. Each step is ticked with a screenshot.

**Part one, over T3 Connect.**

1. **Link.** In the desktop app, Linked environments on the stage Environment → Link → the laptop, at the access the owner wants. The laptop's Sharing & access shows the session at that access.
2. **A round trip.** Ask the stage's Durable agent to delegate a small task to the laptop. The thread appears in the desktop app marked "From" the stage's name; when it ends, the cloud task completes and its parent wakes with the reply.
3. **The agent asks.** Unlink. Ask the agent to link the laptop: t3's link card appears in the thread, the owner picks the machine and the access, and the agent goes on.
4. **Sleep.** Start a longer task, then close the laptop's lid or cut its network for ten minutes (quitting the app would end the running turn). On reopening, the task completes.
5. **Ending it.** Unlink in the client; revoke the stage's session on the laptop; an open task fails with that reason.

**Part two, the other Routes.**

6. **Funnel (about 20 minutes, up to 10 of them waiting for DNS).** `tailscale funnel` to t3's port, per the runbook. Link by typing the address and pasting a code from the laptop; one round trip.
7. **Own tunnel (about 15 minutes).** A tunnel and a hostname to `http://localhost:<t3's port>`, `cloudflared` as a launch agent, per the runbook. Link by address; one round trip.
8. **Teardown.** For each of the two: keep it for prod's own link, or turn it off (`tailscale funnel` off; the launch agent, the tunnel and its DNS record deleted). Unlink, revoke on the laptop, destroy the stage.

**Then, on prod** (about ten minutes): the owner's own link over the Routes he chose and a round trip. If his tunnel's hostname is in `ianpascoe.dev`, one round trip over that Route alone: prod is the only place the same-zone path exists (D23). If it fails there, the hostname moves to another zone or that Route waits for SPI-1072.

## 8. The stage stand-in (D16, D21)

A stock `t3` from npm at the pin, in a Docker container on the machine that runs the stage scripts, with a throwaway home and state directory (step 3's `scripts/lib/laptop.ts` is the starting point). Its agents run in that container, never as the owner's user.

- **The tunnel** is a named Cloudflare Tunnel made by the stage's alchemy stack, only when the stage asks for a stand-in (`T3FLARE_STANDIN=1`); prod's stack never makes one. Resources: `Cloudflare.Tunnel.Tunnel` (in `@alchemy.run/cloudflare` as installed) with one ingress rule to the container's t3 port and a 404 catch-all, plus a proxied DNS `CNAME` to `<tunnel id>.cfargotunnel.com`.
- **Hostname:** `t3flare-<stage>-standin.ianpascoe.dev`, with no Access in front, as every real Route is. One label under the apex, so the zone's Universal certificate covers it.
- **No same-zone fetch arises on a stage:** it is served at workers.dev, so its fetch to `ianpascoe.dev` is ordinary internet traffic.
- **The tunnel token** is a stack output. The stage script passes it to the container's `cloudflared` (`TUNNEL_TOKEN`) and never prints it; it is destroyed with the stage, tunnel and record included.
- **Sleep is simulated** by stopping the container's `cloudflared`: Cloudflare then answers 530, as for a sleeping laptop.
- **To confirm in G1:** that the stage's deploy credentials may create a tunnel and a DNS record in the zone, and that the zone's bot settings do not challenge a Worker's request. Prod's CI token gains neither permission.

## 9. Fragility entries

To be brought up to date in `docs/upstream-fragility.md` in M3, as built.

| Entry | Now | After this plan |
|---|---|---|
| **U45** (on `main`) | Pre-B's Layers over `PeerLinks`, `PeerForwarding` and `PeerLinkRequests` | Shrinks to the one Layer that strips `cause` from `PeerLinkError`: it relies on `PeerLinks`' service shape and on `cause` staying a diagnostic nobody reads. Detection: typecheck, `peerLinks.test.ts` |
| **U49** (on `main`) | The guidance filter and Pre-B's `notListed` rewrite | The filter alone; the link tools classified as offered |
| **U46** (new) | — | **t3's link card on a Durable agent's thread:** `PeerLinkRequests`' `link_request` item and the notification that wakes the agent, passing through our provider adapter and differ. Breaks when t3 changes the item's shape or how the outcome is delivered. Detection: C2 in `acceptance --peer` |
| **U47** (new) | — | **Routes from a Worker:** t3 deriving its issuer from `Host` and `X-Forwarded-Proto`; one bearer serving every address of a link (t3 checks the resource at sign-in only); a same-zone fetch reaching a tunnel hostname's origin. Breaks when t3 binds a session to an address, or Cloudflare changes same-zone routing. Detection: C1; the prod round trip of §7 |
| **U48** (new, extends U2) | — | **The idle check reads open Remote tasks** and `peer_environment_links.last_error` from t3's tables. Breaks when a bump reshapes them. Detection: fail-safe as U2; `scripts/peer-idle.ts` |

Extended, not new: **U5** (MCP, `delegate_task`, `linkOrigin`) for the Outbound direction.

## 10. t3code impact

The tree is not touched. The step adds two names to an allowlist, removes three Layers, keeps one, and adds a read to the idle check. **Shadows 2, Patches 3, unchanged**; no Build shim.

## 11. Files

| File | Change |
|---|---|
| `apps/agents/src/extensions/t3-mcp.ts` | `T3_TOOL_ALLOWLIST` gains `t3_environment_link`, `t3_environment_unlink`; the header comment |
| `apps/agents/src/extensions/t3-guidance.ts` | the two tools classified as offered; our "cannot link" line removed |
| `apps/environment/src/t3/peerLinks.ts` | the refusals and the `notListed` rewrite removed; the `cause` stripping kept |
| `apps/environment/src/t3/composition.ts` | t3's own `PeerForwarding` and `PeerLinkRequests` layers provided again |
| `apps/environment/src/host/idle.ts` | open Remote tasks as work; the alarm's retry and its state |
| `apps/environment/src/host/peerLeak.ts` | `peer-link-*` as a canary |
| `apps/environment/src/host/redactingConsole.ts` | whatever C6 finds |
| `apps/environment/alchemy.run.ts` | the stand-in's tunnel and DNS record, stage-only |
| `apps/environment/scripts/outbound.ts` (new), `lib/standin.ts` (from `lib/laptop.ts`), `acceptance.ts`, `peer-idle.ts` | probes, checks C1–C7, acceptance |
| Tests | `apps/environment/test/{peerLinks,idleRemoteTasks}.test.ts`; `apps/agents/test/{t3Mcp,t3Guidance}.test.ts` |
| Docs | `docs/outbound-link.md` (the runbook, new); ADR-0011 refinement, ADR-0029, ADR-0022 (the allowlist's link tools), GLOSSARY, `docs/parity.md`, `docs/upstream-fragility.md`, `docs/steps/spi-1061.md` and `spi-1061/` |

## 12. Tickets

Filed on 2026-11-12 as SPI-1067 to SPI-1075 for the gated design. After the rescope:

| Ticket | Title | Now |
|---|---|---|
| SPI-1067 | An agent may ask the owner to renew an expired Outbound link | **Close.** Agents have t3's link card again (D2), so they can ask. |
| SPI-1068 | Revisit the Outbound link's cap above `approval-required` | **Close.** There is no cap; the owner picks the access in t3's dialog. |
| SPI-1069 | Tell the owner's phone when an Outbound link is about to expire | Keep. Expiry is still seen only in a client's link list or as a tool error. |
| SPI-1070 | A second Registered machine | **Close.** There is no registration; t3 links to as many machines as the owner likes. |
| SPI-1071 | Upstream asks to t3 from the Outbound link's design | Keep, narrowed to a peer-side revoke on `unlink`. The fence asks (reads over a link, a full-access link using the peer's links, an access-bound pairing code) were for gates the owner dropped; file them only if he wants them raised. |
| SPI-1072 | A `cloudflare-tunnel` Route with no public hostname (Workers VPC binding) | Keep, widened: a private Route to the owner's own tunnel, by Access with a service token or by a tunnel binding. Optional. |
| SPI-1073 | A faithful Tailscale Funnel stand-in for stages | Keep. Funnel is still proved only attended (G5, §7). |
| SPI-1074 | Pin the desktop app's port for a laptop that serves an own-tunnel or Funnel Route | Keep; it matters more now that the owner's tunnel is public too. |
| SPI-1075 | Attachments on an Outbound send | **Close.** There is no send card; t3 itself refuses attachments on a forwarded call. |

## 13. What remains of the Fable review

The [review](spi-1061-plan-review.md) examined the gated design. Its findings about our gates (H1, M2–M5, M9, most hostile tests) fell with them. What still applies:

- **H2, M1** (done as Pre-B and Pre-A) are undone on purpose by M1 here: the link is usable again, and `notListed` is t3's.
- **M6** survives as §5.4: `cause` stays stripped, and C6 forces transport errors.
- **M7** survives as gate G4, measured and recorded rather than enforced.
- **M8** survives as a statement in §4: a Route is trusted by its hostname.
- **M10** survives as gate G5 for Funnel.
- **M11** survives in §7: a fresh stage destroyed at the end, sleep by lid or network, a teardown, a scratch project.

The rescoped plan has not been reviewed again; it removes mechanisms and reverses one earlier answer (D2).
