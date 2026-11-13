// SPI-1061 (ADR-0029): the Outbound link is t3's own, unchanged. One Layer of ours stays over t3's `PeerLinks`, and it is
// leak hygiene, not a gate: a `PeerLinkError`'s `cause` can hold the transport error of a sign-in or a call, and with it
// the request (an address, the pairing code, the bearer), and it would go back over the WS RPC. Every method is t3's;
// only `cause` is dropped. Layer over t3's service (ADR-0001); U45.
import { PeerLinkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PeerLinks from "t3/src/peer/PeerLinks.ts";

/** A `PeerLinkError` without its `cause`: the reason and t3's own message, nothing else (review M6). */
export const withoutCause = (error: PeerLinkError) => new PeerLinkError({ reason: error.reason, message: error.message });

/** t3's `PeerLinks`, every method as t3 has it, with no error carrying a `cause`. */
export const layerPeerLinksWithoutCause = Layer.effect(
  PeerLinks.PeerLinks,
  Effect.map(PeerLinks.PeerLinks, (real) =>
    PeerLinks.PeerLinks.of({
      ...real,
      link: Effect.fn("t3flare.PeerLinks.link")(function* (input) {
        return yield* real.link(input).pipe(Effect.mapError(withoutCause));
      }),
      list: real.list.pipe(Effect.mapError(withoutCause)),
      get: Effect.fn("t3flare.PeerLinks.get")(function* (environmentId) {
        return yield* real.get(environmentId).pipe(Effect.mapError(withoutCause));
      }),
      unlink: Effect.fn("t3flare.PeerLinks.unlink")(function* (environmentId) {
        return yield* real.unlink(environmentId).pipe(Effect.mapError(withoutCause));
      }),
      resolve: Effect.fn("t3flare.PeerLinks.resolve")(function* (environmentId) {
        return yield* real.resolve(environmentId).pipe(Effect.mapError(withoutCause));
      }),
    }),
  ),
);
