// A CLI agent's failed turn on a Model endpoint (SPI-1172): what t3 shows is the model relay's classification of the
// process's last answer, by the endpoint's API and auth (`@t3flare/models/failures`), not what the CLI or its t3 adapter
// made of the error text. The relay reports each answer to the Workspace DO (`modelRelayOutcome`); the CLI wrapper reads
// it (`ChannelProcess.modelFailure`) when the turn's terminal or error item carries a failure, and this decides:
//
// - a relay failure this turn: t3's failure is that one: its class, its text naming the endpoint, its code, its reset
//   (held to 30 s after now, as the differ holds a Durable turn's), so a usage limit pauses the thread until its reset;
// - none: the adapter's own failure stands. (Until the hard cut, SPI-1176, the Model proxy's Commissary-text
//   classification gave way here to a plain error naming the endpoint.)
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { heldReset } from "@t3flare/models/failures";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";

type Event = ProviderAdapter.ProviderAdapterV2Event;

export const cliRelayFailure = (failure: OrchestrationV2ProviderFailure, relayed: EndpointFailureRecord | null, now: number): OrchestrationV2ProviderFailure =>
  relayed === null ? failure : makeProviderFailure({ class: relayed.class, message: relayed.message, code: relayed.code, retryable: relayed.retryable, resetAt: heldReset(relayed, now) });

/** The failure a failed turn's terminal or an error item carries; undefined for any other event. */
export const failureOf = (event: Event): OrchestrationV2ProviderFailure | undefined =>
  event.type === "turn.terminal" && event.status === "failed" ? event.failure : event.type === "turn_item.updated" && event.turnItem.type === "error" ? event.turnItem.failure : undefined;

/** The event with its failure as t3 shows it for the session (`cliRelayFailure`). */
export const withRelayFailure = (event: Event, relayed: EndpointFailureRecord | null, now: number): Event => {
  if (event.type === "turn.terminal" && event.status === "failed") return { ...event, failure: cliRelayFailure(event.failure, relayed, now) };
  if (event.type === "turn_item.updated" && event.turnItem.type === "error") return { ...event, turnItem: { ...event.turnItem, failure: cliRelayFailure(event.turnItem.failure, relayed, now) } };
  return event;
};
