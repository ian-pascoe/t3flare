# T3 Connect probe: a full link without a Container or tunnel?

**Verdict: no.** t3flare cannot have full T3 Connect without an always-on tunnel connector. The hosted relay hands a
client an endpoint and a minted credential only for a `cloudflare_tunnel` endpoint. That endpoint must be a hostname
the relay provisioned under its own domain, and its tunnel must have a connector that is up. A `manual` endpoint at
the Environment's own public URL can be linked, but `/connect` and `/status` refuse it with
`endpoint_provider_not_managed`. Neither a Layer, a Shadow nor a Patch on our side changes that: the refusal is in
the relay (t3's hosted service, `infra/relay`), not in the t3 server we run. **Recommendation: stay publish-only.**

Pinned t3code: `d8f3feff0c` (v0.1.10-nightly.20261112.4606). Probe date: 2026-11-13.

## How far this went

- **Code reading**: the relay (`t3code/infra/relay/src`), the contracts (`packages/contracts/src/relay.ts`), t3's
  cloud link (`apps/server/src/cloud/CloudLink.ts`, `linkChecks.ts`) and the client's discovery
  (`packages/client-runtime/src/relay/discovery.ts`).
- **One unauthenticated read of the live relay**, to check that the deployed relay matches the pinned source:
  `GET https://relay.t3.codes/openapi.json` and `/health`
  ([`t3connect-probe/relay-openapi.json`](t3connect-probe/relay-openapi.json)). No credential was used or read.
- **No live link probe.** The brief says to stop when the relay contract rules the link out, and it does. Stage
  `step3plus` was not deployed, nobody signed in, and prod's link was never touched. There was nothing to unlink or
  destroy.

## 1. Does the relay accept a link with a direct public endpoint and no tunnel?

**It accepts the link but serves no clients over it.** A link is two capabilities, and only one of them works without
a tunnel.

**Link scopes are not client scopes.** `RelayEnvironmentLinkScope` has exactly two values,
`agent_activity_notifications` and `managed_tunnels` (`contracts/src/relay.ts:280`). `environment:connect` (and
`environment:status`) are scopes of the **client's DPoP access token** (`relay.ts:747–753`), not of a link. The relay
puts `environment:connect` into the proof it sends the Environment's `mint-credential`, and t3 requires that exact
scope (`CloudLink.ts:1576`). Whether clients can connect is therefore decided by the endpoint kind, not by a link scope.

**Endpoint kinds:** `manual`, `cloudflare_tunnel` and `t3_relay` (`relay.ts:155`). The relay never produces or
accepts `t3_relay`: in the whole t3code tree it appears only in the contract and a mobile showcase fixture, and the
live relay's OpenAPI lists it as a value only.

**What t3 signs** (`cloud/linkChecks.ts`):
- `linkProofScopes`: a `cloudflare_tunnel` endpoint gets `agent_activity_notifications` and `managed_tunnels`; a
  `manual` endpoint gets `agent_activity_notifications` only (`:122`).
- `isAllowedEndpointOrigin`: the origin's host must be loopback, whatever the request host (`:98`).
- `CloudLink`'s own link step signs `cloudflare_tunnel` when tunnels are wanted and `manual` when they are not
  (`CloudLink.ts:859–878`).

**What the relay checks** (`environments/EnvironmentLinker.ts`):
- `proofAuthorizesRequestedCapabilities` (`:96`): `managedTunnelsEnabled` requires the `managed_tunnels` scope.
- A link with `managedTunnelsEnabled` must have a loopback origin (`:283`, `origin_not_allowed`). The relay then
  provisions a Cloudflare tunnel and DNS name and **replaces the signed endpoint with its own**
  (`const endpoint = provisioned?.endpoint ?? verified.endpoint`, `:315`).
- A link without tunnels stores the signed endpoint unchecked: any `manual` URL, with no https check (`:316`:
  "publish-only links route out of band"). It also deprovisions any tunnel the environment had.

So a `manual` link at `https://<env host>` registers. A link of our own making could get it past t3's loopback check;
the relay itself does not care what we sign.

## 2. Can the cloud answer what the relay asks?

**The relay never asks a `manual` endpoint anything.** Client `/connect` and `/status`
(`environments/EnvironmentConnector.ts`) both go through `resolveManagedEndpoint` → `validateManagedEndpoint`
(`:298`, called at `:429` and `:592`). That check requires all of the following:

1. `link.endpoint.providerKind === "cloudflare_tunnel"`, else `endpoint_provider_not_managed` (`:304`);
2. a managed-endpoint **allocation** with `readyAt`, `tunnelId` and `dnsRecordId` set, else
   `managed_endpoint_allocation_not_found` or `…_not_ready`;
3. the allocation's hostname under the relay's `managedEndpointBaseDomain`, else `managed_endpoint_hostname_invalid`;
4. the link's endpoint URLs equal to that allocation's, else `managed_endpoint_mismatch`.

Only after these checks does the relay call `/api/t3-connect/health` or `mint-credential` at `endpoint.httpBaseUrl`.
That URL is always the relay's own tunnel hostname, and Cloudflare forwards a request there only through a running
tunnel connector. These reasons are not just in the source: the deployed relay's OpenAPI carries the same eight-value
`RelayEnvironmentConnectNotAuthorizedReason` enum, `endpoint_provider_not_managed` included
([evidence](t3connect-probe/relay-openapi.json)).

The client side agrees. The T3 apps' discovery calls `/status` for every listed environment
(`client-runtime/src/relay/discovery.ts`, `refreshStatus`). A `manual` link is listed (step 3+ saw `t3flare` listed as
`manual`) but would show as an error, never as connectable.

**Could the Worker answer health and mint?** Yes, in principle. t3's `CloudLink` runs in the Environment DO, and the
routes are mounted (ADR-0010, SPI-1005 refinement); today we refuse them by choice (`host/relayRoutes.ts`, the refusing
`CloudLink`, the mint key deleted after each link). If the relay sent a `manual` endpoint those requests, the DO would
wake and answer them without a Container. It never sends them.

**The tunnel route without `cloudflared` does not work either:**
- **A managed link with no connector.** The relay provisions the tunnel; `/status` and `/connect` then reach a
  hostname with no connector and report `tunnel_down`. The link also takes one of the account's 3 tunnel slots for
  nothing.
- **A connector inside a Durable Object.** cloudflared dials Cloudflare's tunnel edge over QUIC (UDP) or HTTP/2 over
  TLS on 7844. Workers have no UDP, and `connect()` **blocks Cloudflare IP ranges**
  ([TCP sockets, Considerations](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)). Even if it
  worked, a connector has to stay connected all day, so it would be the 24/7 process the owner ruled out.

## 3. What would the owner gain over today?

Little, if the link were possible:

| | Today (pairing link, publish-only Connect) | Full T3 Connect |
|---|---|---|
| A new device | One one-time pairing link from a paired client (ADR-0010, SPI-1006) | Sign in to the T3 Connect account; the environment appears in the list |
| Session | 30-day session straight to the public host | The relay mints a 2-minute pairing credential per connect (`CloudLink.ts:1592`, `subject: "cloud-connect"`), exchanged for a session |
| Transport | Direct to `t3.ianpascoe.dev` | Through the relay's tunnel hostname (a tunnel hop, and the connector) |
| Online/offline in the apps | No | Yes (`/status`) |
| Phone notifications | Yes (ADR-0025) | Yes |
| Who can mint a session on the cloud | No one but paired clients | Also `t3.codes`, for anyone holding the owner's account |
| Cost | Nothing standing | A 24/7 connector and one of 3 tunnel slots |

He would gain discovery and a one-step setup for new devices. The price is an account-level path into the Environment
and an always-on process.

## What building it would take

There is no build within the owner's condition. For the record:

- **Within the condition (no Container, no tunnel):** impossible today. It needs **upstream relay changes**: `/connect`
  and `/status` would have to accept a `manual` (or `t3_relay`) https endpoint and call it directly. The Environment's
  signed health and mint responses already authenticate the answer, so the relay would only have to trust a
  self-declared URL. t3's link proof would also need a non-loopback origin and a scope that allows client connects
  (today `linkProofScopes` and `isAllowedEndpointOrigin` rule both out). On our side the change would then be **Layer
  only**: link with a `manual` endpoint at the public host, stop refusing health and mint, keep the mint key. ADR-0025
  would be superseded in part (publish-only and the deleted mint key go), and ADR-0010's step 3+ refinement would be
  narrowed again (the four relay routes mounted, as in SPI-1005). This would sit next to upstream ask 3 in the step 3+
  plan (§11: "a hosted server's publish-only link").
- **Outside the condition (for completeness):** a managed link plus `cloudflared` in an always-on Container pointed at
  the Worker's loopback-equivalent origin. That breaks ADR-0010's "no tunnel" and the owner's rule. Not pursued.

## Recommendation

**Stay publish-only.** ADR-0010, ADR-0025 and scope-audit row 11 stand as they are. The audit row's "whether a
tunnel-less link supports this is unverified" now has its answer: it does not, because the relay refuses every
non-tunnel endpoint at `/connect`. If the owner wants it later, the path is an upstream ask (relay `/connect` for
`manual` https endpoints), not a t3flare build. **No Linear ticket filed** (the verdict is no).
