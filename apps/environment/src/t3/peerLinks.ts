// SPI-1061 pre-items: this Environment links to no other machine until the owner registers one (ADR-0029). Pre-B:
// t3's `PeerLinks` refuses to make a link, and treats any stored one as gone. Pre-A: `t3_environment_links` does not
// point an agent at `t3_environment_link`, a tool it is never offered. Layers over t3's services (ADR-0001); U45, U49.
import { OrchestratorMcpFailure, PeerLinkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PeerForwarding from "t3/src/peer/PeerForwarding.ts";
import * as PeerLinkRequests from "t3/src/peer/PeerLinkRequests.ts";
import * as PeerLinks from "t3/src/peer/PeerLinks.ts";

/** Why `link` is refused, until a machine is registered (SPI-1061). */
export const NO_MACHINE_REGISTERED = "No machine is registered; Outbound links are made from the harness panel (SPI-1061).";

/** Why a stored link cannot be used: it is final, so a follower stops rather than retries. */
export const STORED_LINKS_OFF =
  "This Environment does not use links to other machines; Outbound links are made from the harness panel (SPI-1061).";

/** What `t3_environment_links` says beside an empty list, in place of t3's pointer at `t3_environment_link`. */
export const NOT_LISTED =
  "Not listed: links to other machines are made by the owner, never by an agent, and this Environment cannot link to another machine yet.";

/** A `PeerLinkError` without its `cause`, which can carry a stored address or a storage detail (review M6). */
const withoutCause = (error: PeerLinkError) => new PeerLinkError({ reason: error.reason, message: error.message });

/**
 * t3's `PeerLinks`, fail-closed (review H2): `link` is refused; `resolve` fails with a final reason (`expired`, which
 * `PeerMcpClient` turns into `capability_denied` and `RemoteDelegation` stops on), so no stored row is ever called;
 * `list` is empty and probes nothing. `get`, `unlink`, `enabled` and `recordOutcome` stay t3's, so a stored row can
 * still be removed. No error carries a `cause`.
 */
export const layerOwnerPeerLinks = Layer.effect(
  PeerLinks.PeerLinks,
  Effect.map(PeerLinks.PeerLinks, (real) =>
    PeerLinks.PeerLinks.of({
      ...real,
      link: Effect.fn("t3flare.PeerLinks.link")(function* () {
        return yield* new PeerLinkError({ reason: "disabled", message: NO_MACHINE_REGISTERED });
      }),
      list: Effect.succeed([]),
      resolve: Effect.fn("t3flare.PeerLinks.resolve")(function* () {
        return yield* new PeerLinkError({ reason: "expired", message: STORED_LINKS_OFF });
      }),
      get: Effect.fn("t3flare.PeerLinks.get")(function* (environmentId) {
        return yield* real.get(environmentId).pipe(Effect.mapError(withoutCause));
      }),
      unlink: Effect.fn("t3flare.PeerLinks.unlink")(function* (environmentId) {
        return yield* real.unlink(environmentId).pipe(Effect.mapError(withoutCause));
      }),
    }),
  ),
);

/** t3's `PeerForwarding`, with our line in place of t3's `notListed` (review M1). */
export const layerOwnerPeerForwarding = Layer.effect(
  PeerForwarding.PeerForwarding,
  Effect.map(PeerForwarding.PeerForwarding, (real) =>
    PeerForwarding.PeerForwarding.of({
      ...real,
      links: Effect.fn("t3flare.PeerForwarding.links")(function* (scope) {
        return { ...(yield* real.links(scope)), notListed: NOT_LISTED };
      }),
    }),
  ),
);

/** t3's `PeerLinkRequests`, refusing to raise a link card, so a relay or allowlist slip cannot ask the owner to link. */
export const layerOwnerPeerLinkRequests = Layer.effect(
  PeerLinkRequests.PeerLinkRequests,
  Effect.map(PeerLinkRequests.PeerLinkRequests, (real) =>
    PeerLinkRequests.PeerLinkRequests.of({
      ...real,
      request: Effect.fn("t3flare.PeerLinkRequests.request")(function* () {
        return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: NO_MACHINE_REGISTERED });
      }),
    }),
  ),
);
