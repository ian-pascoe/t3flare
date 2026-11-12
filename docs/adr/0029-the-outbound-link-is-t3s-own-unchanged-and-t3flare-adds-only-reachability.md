# The Outbound link is t3's own, unchanged; t3flare adds only reachability

Status: accepted (owner decision, 2026-11-12; built in SPI-1061). Plan: [`docs/steps/spi-1061-plan.md`](../steps/spi-1061-plan.md).

The Cloud Environment links to the owner's laptop with t3's Peer link exactly as a stock t3 server would. The owner makes the link in the stock client's Linked environments dialog, or an agent asks for it through t3's own link card; the access he picks there, and t3's own Link fence below full access, are the only limits on what cloud agents then do on the laptop. t3flare puts no gate, cap, allowlist or approval of its own on the link. It adds only what a Worker and a Durable Object need for the stock behaviour to work:

- **Reachability.** The laptop's address is a plain https **Route**: its T3 Connect tunnel hostname, a Tailscale Funnel address, or a hostname on the owner's own Cloudflare Tunnel, each with t3's own auth in front and nothing else. The cloud needs no T3 Connect account for any of them (ADR-0011's refinement).
- **Long Remote tasks.** The Environment resets when idle (ADR-0003) and the laptop sleeps, so an open Remote task counts as work, and an alarm retries while the laptop does not answer.
- **Leak hygiene.** The link's bearer lives where t3 puts it, in the Environment DO's secret store. It is kept out of Sessions, Workspaces, Containers, logs and errors, as every credential here is (ADR-0016, ADR-0022).

The link tools `t3_environment_link` and `t3_environment_unlink`, withheld since ADR-0022, are offered to agents again.

## Considered options

A gated design was drawn first and reviewed (`docs/steps/spi-1061-plan-review.md`; the plan at `e5cd0a2`). It treated the cloud as the less trusted side, because cloud agents read untrusted text and the laptop holds the owner's files. The owner dropped all of it on 2026-11-12: t3's own settings and link access levels govern, as on stock t3, and prompt injection is not a design driver.

- **A card of ours for every message sent to the laptop,** with a permit matched where the call leaves. Dropped.
- **A hard cap of Supervised** on the link and on every call. Dropped: the access is what the owner picks.
- **Refusing the Outbound link to Linked work** at any access. Dropped: t3's rule applies.
- **A registered machine and an address allowlist,** set behind Access. Dropped: a link goes where the owner points it.
- **Switches of ours,** per machine and for all Outbound links. Dropped: t3's own are Linked environments in Settings → Labs, Unlink, and revoking the session on the laptop.
- **Reads over the link limited to threads the cloud started.** Dropped.
- **Cloudflare Access with a service token in front of the owner's tunnel,** and peer requests sent from a strictly public Worker so that Access would judge them. Dropped for now: the tunnel has t3's own auth like the other Routes. It may return as an option (SPI-1072).

## Consequences

These follow from t3's design and are accepted with it.

- **A linked cloud agent acts on the laptop up to the link's access.** Its tool call asks or not by its own thread's mode, as any t3 tool does; a thread it starts on the laptop runs under the narrower of the link's access and the calling thread's mode.
- **Below full access, t3's Link fence holds there:** the link changes only threads it started and skips project setup scripts. A full-access link is not fenced.
- **t3 does not fence reads over a link:** a cloud agent can list, read and search the laptop's threads.
- **A full-access Inbound link may use the Outbound link,** since t3 bars only links below full access. Laptop to cloud to laptop is possible at that level.
- **The bearer in the Environment DO is worth what the link's access is worth,** for about 30 days or until the owner revokes it on the laptop. t3 has no refresh grant, and Unlink here does not revoke there.
- **Every Route is public, behind t3's own auth, and is trusted by who controls its hostname.** t3's descriptor is unauthenticated; its environment-id check catches a wrong answerer, not an impostor at the right address.
- **One Layer of ours stays on t3's `PeerLinks`:** it strips `cause` from the errors, which can hold a request with the pairing code or the bearer. It is a leak fix, not a gate.
