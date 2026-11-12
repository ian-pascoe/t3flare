# The laptop links to the cloud; the reverse is deferred

Orchestration between the laptop and the cloud uses t3's Peer links: the linking Environment signs in to the other's `/mcp`, and a delegated task runs there as an ordinary thread. Only the cloud is publicly reachable, so in v1 the laptop links to the cloud and laptop agents delegate to cloud agents. Clients attach to both Environments directly. Cloud-to-laptop links need the laptop reachable (T3 Connect or Tailscale) and are additive later. Moving a thread between Environments is out of scope; delegation covers most of the need.

## Refinement (step 3, as built)

- **The link is t3's, unchanged on the laptop**, and needs no route, Shadow or Patch in the cloud: t3's `/mcp`, MCP OAuth, Peer forwarding and remote delegation were mounted since step 0. The cloud seeds **Linked environments** on once (a DO-storage mark, so an owner who turns it off keeps it off), pins agent browser access off, and refuses the bootstrap token at `/oauth/mcp/decision` (ADR-0010's refinement). Proved with a stock `t3` from npm at the pin and at the desktop's nightly as the laptop, and from the owner's desktop app ([report](../steps/step-3.md)).
- **The fence is t3's plus ours.** t3 fences what a link below full access may change through its tools; the Durable agent enforces the modes the link hands down: runtime modes fail closed (`auto` and unknown modes run as approval-required) and `plan` is read-only in the Session (edit and write refused, every `bash` asks, only read-only T3 tools). A full-access link is not fenced (t3's rule).
- **Pushes from linked work ask every time** (owner decision D1): see ADR-0013's refinement.
- **A remote task runs in the cloud project's checkout**, shared with the owner's threads on it (t3 refuses worktree isolation for a remote task); `t3_thread_launch` with a worktree strategy is the way to isolate one.
- **The desktop app shows a remote child's question to the owner** ("Subagent needs input · Open question" on the laptop thread), but t3 does not wake the parent agent for it as it does for a local child (`DelegatedTaskQuestionReactor`); the upstream ask is drafted.

## Refinement (SPI-1061): the reverse direction

Status: accepted (owner decision, 2026-11-12; built in SPI-1061). Plan: [`docs/steps/spi-1061-plan.md`](../steps/spi-1061-plan.md).

- **The cloud links to the Laptop Environment with the same Peer link, t3's own and unchanged:** an **Outbound link**, made and governed as on stock t3 ([ADR-0029](0029-the-outbound-link-is-t3s-own-unchanged-and-t3flare-adds-only-reachability.md)). t3's peer services were mounted since step 0, so no route, Shadow or Patch is added, and the link tools withheld from agents since ADR-0022 are offered again.
- **The laptop is reached at a Route:** a plain https address that ends at the laptop's t3, with t3's own auth in front and nothing else. Three kinds are supported (owner decision, 2026-11-12):
  - **T3 Connect:** the laptop's own t3 runs the tunnel. The relay operator is in the path, which the owner accepted.
  - **Tailscale Funnel:** a public `.ts.net` address. Not a tailnet address: a Worker cannot join a tailnet.
  - **The owner's own Cloudflare Tunnel,** with no Access in front. Access with a service token, or a tunnel binding with no public hostname, is a later option (SPI-1072).
- **A link needs only an address and a pairing code from the laptop, never a T3 Connect account,** whatever the Route. The Publish-only link (ADR-0025) and "nothing relay-initiated is answered" (ADR-0010) stand as they are: the cloud still only calls out. t3 already keeps several addresses for one link and uses the first that answers as the machine.
- **Peer requests leave from the Environment Worker by t3's own client,** like every other fetch. A hostname of the owner's tunnel in prod's own zone is a same-zone fetch, which Cloudflare sends to the zone's origin past its security settings; the origin there is the tunnel, and with no Access in front nothing is bypassed. Only prod has a domain in that zone, so only prod can prove this path. A strictly public Worker for peer requests was drawn while Access was planned, and dropped with it.
- **"Deferred" was a withheld tool, not a refusal.** From step 3, t3's `peerLinks.link` answered any client that manages access. SPI-1061's first change (Pre-B) refused it outright while the gated design was being drawn; the refusal is removed when the link tools return.
- **A Remote task on the laptop is work.** While one is open and the laptop answers, the Environment stays up to follow it. While the laptop does not answer on any Route (asleep, its tunnel reclaimed), the Environment may reset, and an alarm brings it back to try again, less and less often (to every 30 minutes), until the task ends, the owner cancels it, or the link expires or is revoked. t3flare gives up no sooner than t3 does.
