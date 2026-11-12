# SPI-1061 pre-items (Pre-A, Pre-B)

Landed ahead of the Outbound link (plan `spi-1061-plan.md` D8, D13; review H2, M1, M6).

- **Pre-A (SPI-1060).** t3's orchestration guidance reaches the Durable agent filtered to the tools it is offered (`apps/agents/src/extensions/t3-guidance.ts`), with a line that this Environment cannot link to other machines; `t3_environment_links` no longer points at `t3_environment_link`. A classification test fails on any unclassified tool name t3 adds. Fragility U49.
- **Pre-B.** Layers over t3's `PeerLinks`, `PeerForwarding` and `PeerLinkRequests` (`apps/environment/src/t3/peerLinks.ts`): no link can be made, no stored link can be used (final reason), the list is empty, no link card can be raised, and no error carries a `cause`. A read-only `GET /_t3flare/peer-links/count`. Inbound links (laptop to cloud) are unaffected: they never use `PeerLinks`. Fragility U45.

**Evidence.** Unit: `peerLinks` 4/4, `t3Guidance` 4/4, `t3Mcp` 16/16. Stage `pre1061` (destroyed): `peer-acceptance --only outbound` ok, a web-client link to an unresolvable address refused as `disabled` "No machine is registered…" in 1.7 s with nothing sent, list `[]`, count 0 (`docs/steps/step-3/pre1061-outbound.json`). Not run on stage: a real model turn asking about the laptop (covered by the prompt classification tests).
