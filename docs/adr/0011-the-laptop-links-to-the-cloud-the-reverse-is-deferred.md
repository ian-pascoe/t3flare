# The laptop links to the cloud; the reverse is deferred

Orchestration between the laptop and the cloud uses t3's Peer links: the linking Environment signs in to the other's `/mcp`, and a delegated task runs there as an ordinary thread. Only the cloud is publicly reachable, so in v1 the laptop links to the cloud and laptop agents delegate to cloud agents. Clients attach to both Environments directly. Cloud-to-laptop links need the laptop reachable (T3 Connect or Tailscale) and are additive later. Moving a thread between Environments is out of scope; delegation covers most of the need.

## Refinement (step 3, as built)

- **The link is t3's, unchanged on the laptop**, and needs no route, Shadow or Patch in the cloud: t3's `/mcp`, MCP OAuth, Peer forwarding and remote delegation were mounted since step 0. The cloud seeds **Linked environments** on once (a DO-storage mark, so an owner who turns it off keeps it off), pins agent browser access off, and refuses the bootstrap token at `/oauth/mcp/decision` (ADR-0010's refinement). Proved with a stock `t3` from npm at the pin and at the desktop's nightly as the laptop, and from the owner's desktop app ([report](../steps/step-3.md)).
- **The fence is t3's plus ours.** t3 fences what a link below full access may change through its tools; the Durable agent enforces the modes the link hands down: runtime modes fail closed (`auto` and unknown modes run as approval-required) and `plan` is read-only in the Session (edit and write refused, every `bash` asks, only read-only T3 tools). A full-access link is not fenced (t3's rule).
- **Pushes from linked work ask every time** (owner decision D1): see ADR-0013's refinement.
- **A remote task runs in the cloud project's checkout**, shared with the owner's threads on it (t3 refuses worktree isolation for a remote task); `t3_thread_launch` with a worktree strategy is the way to isolate one.
- **The desktop app shows a remote child's question to the owner** ("Subagent needs input · Open question" on the laptop thread), but t3 does not wake the parent agent for it as it does for a local child (`DelegatedTaskQuestionReactor`); the upstream ask is drafted.
