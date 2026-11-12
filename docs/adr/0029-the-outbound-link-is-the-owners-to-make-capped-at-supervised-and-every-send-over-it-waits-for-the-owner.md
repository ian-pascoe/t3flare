# The Outbound link is the owner's to make, capped at supervised, and every send over it waits for the owner

Status: accepted (design; built in SPI-1061). Plan: [`docs/steps/spi-1061-plan.md`](../steps/spi-1061-plan.md).

The Cloud Environment runs agents that read untrusted text (Linked work, web pages, MCP tool results); the Laptop Environment holds the owner's files and credentials. An Outbound link puts a 30-day bearer for the laptop's `/mcp` in the Environment DO, and with it a cloud agent can start agent threads on the owner's Mac. t3's own Link fence protects the laptop's threads, projects and settings, but leaves four gaps that matter in this direction:

- **Reads never ask on the laptop.** In `approval-required`, t3's ACP policy allows every read at any path (`provider-acp/src/server/clientPolicy.ts`, "Reads never ask"), Codex runs under a read-only sandbox with `untrusted` approvals, and a thread is not confined to its project's directory: its agent runs as the owner.
- **t3's read tools are not fenced** (`mcp/linkOrigin.ts`: "Reads are not fenced"): a linking agent can list, read and search every thread on the peer.
- **A full-access Inbound link may use this Environment's links.** t3's `assertNotLinked` only stops links paired below full access (`linkOriginIsFenced`), so laptop → cloud → laptop is open for a full-access link.
- **t3 lets an agent ask for a link** (`t3_environment_link`: a card the owner answers), and lets any client that manages access link this Environment to any https address (`peerLinks.link`).

So t3flare adds its own rules, all enforced in the cloud, outside any agent's reach:

1. **Only the owner makes an Outbound link, and only to a Registered machine.** The registration (the machine's environment id, its Routes, the highest access) is set behind Access. A link is made over the registered Routes whatever addresses a client offers, and a request goes to no other address. With none registered, no Outbound link can be made or used: the cloud fails closed. A registered machine has a switch that starts off, and one switch turns every Outbound link off at once; while either is off nothing leaves, and an open Remote task fails with that reason. `t3_environment_link` and `unlink` stay withheld from every agent.
2. **The cap is `approval-required`.** A link asked for above it is refused, every call over the link carries a mode limit no higher than it whatever the calling thread's mode, and the laptop's pairing code carries no settings or source-control scope, so the laptop itself refuses full access (the stock client's Link dialog mints it that way; `t3 auth pairing create --scope` does by hand). Scopes cannot tell `approval-required` from `auto`, so between those the laptop's defence is the access recorded when the link was made: it holds the link to that level afterwards, whatever the cloud then asks. `auto-accept-edits` is not offered: an unasked edit in a checkout is a later command (a script, a hook, an `.envrc`).
3. **Every Outbound send waits for an Approval** that shows the machine and every argument of the call, the message in full; a message too long to show is declined unasked. The card offers "Send once" and "Decline" only, and no approval is remembered. It asks in every runtime mode, full access included. An answer to a laptop thread's question is a send like any other; stopping a thread never asks.
4. **Reads over the link reach only Outbound work,** plus the laptop's project list and environment description. A read of any other laptop thread is refused in the cloud.
5. **Only the owner's threads use the link.** Linked work is refused whatever its link's access.
6. **The rules hold where calls leave the Environment,** not only where agents ask. The card is raised where the agent calls the tool; t3flare's Layers over t3's peer services then refuse a send that matches no **Send permit** (the owner's approval of that thread, that tool and those arguments, once), as the Push gateway refuses a push without an Expectation. A tool t3 can forward is refused until it is classified as a send, a read or a stop, so a tool a bump adds does not leave. A caller with no gate of its own cannot send.
7. **The bearer lives in the Environment DO's secret store** and never enters a Session, a Workspace, a Container, a log or a push. It is never renewed automatically: t3 has no refresh grant, and a new link needs a new pairing code from the laptop. Unlinking deletes it here; the owner revokes the session on the laptop.
8. **A Route's address is https, is not one of our own hosts, and has its kind's form;** a Route over the owner's own Cloudflare Tunnel must have Access in front, which the cloud checks before it links. That Route's Access service token is the second credential this decision puts in the Environment DO's secret store. It is write-only, set by the owner alone, sent only to that Route's address and never after a redirect, and kept from Sessions, Workspaces, Containers and logs as the bearer is. It is typed into the harness panel: a second exception to "keys typed into t3flare are refused" (owner decision D5), after owner-added MCP servers' credentials (owner decision E2, 2026-11-12; ADR-0012's SPI-1061 refinement).

## Considered options

- **Let the agent ask for the link (t3's card).** The code never enters the transcript and the owner picks the machine and access, but the agent chooses the moment, the reason and the address, and one tired click makes a 30-day credential. Rejected; a link is made about once a month.
- **Trust the laptop's approvals alone.** They cover commands and edits, not reads, and the reply comes back to the cloud. Rejected.
- **Remember an approval for the session.** One approved harmless send would cover a later injected one. Rejected, as for pushes from Linked work (ADR-0013, D1).
- **A higher cap the owner can switch on.** Deferred: the cap is one setting, and raising it should follow use, not precede it.
- **Access optional on the owner's own tunnel.** Rejected: without it the Route is as exposed as T3 Connect's, and a stray local service on t3's port would be public.
- **The stack makes the tunnel, the Access application and the token** (no typed credential). Rejected (owner decision E2): prod's CI token would gain tunnel and DNS permissions, and every deploy would touch the laptop's front door.

## Consequences

- **The owner is asked twice:** once in the cloud for the message, then on the laptop for each command or edit it leads to. That is the price of the cap; the cloud agent cannot approve anything on the laptop.
- **What an approved send brings back is not checked.** A harmless-looking message can still return something sensitive the laptop agent read. The owner approves words, not behaviour.
- **A compromise of the Environment DO is a supervised foothold on the laptop** for as long as the link lasts: threads it starts there still ask the owner before a command or an edit, but can read.
- **Every Route is one more door to the laptop,** each with its own exposure (ADR-0011's refinement). The owner registers only those he wants; removing one stops traffic to it at once.
- **The service token is sent before the peer is identified:** to the Route's hostname on every request, over TLS. It opens only the owner's own Access application.
