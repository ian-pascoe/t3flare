// A CLI agent's failed turn on a Model endpoint (SPI-1172): what t3 shows is the model relay's classification of the
// process's last answer, by the endpoint's API and auth (`@t3flare/models/failures`), not what the CLI or its t3 adapter
// made of the error text. The relay reports each answer to the Workspace DO (`modelRelayOutcome`); the CLI wrapper reads
// it (`ChannelProcess.modelFailure`) when the turn's terminal or error item carries a failure, and this decides:
//
// - a relay failure this turn: t3's failure is that one: its class, its text naming the endpoint, its code, its reset
//   (held to 30 s after now, as the differ holds a Durable turn's), so a usage limit pauses the thread until its reset;
// - none, on an endpoint's model: the adapter's own failure stands, except the Model proxy's classification
//   (`cliPromptFailure`, ACP's Commissary-text classifier, kept for proxy-mode processes), which is never right on an
//   endpoint: a plain provider error naming the endpoint takes its place;
// - on the Model proxy's model: the adapter's failure stands.
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { endpointLabel, type ModelEndpoints, parseEndpointSlug } from "@t3flare/models/endpoints";
import { heldReset } from "@t3flare/models/failures";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";

import { KEY_NAME } from "./acpFlavor.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

/** The Model endpoint a session's model slug names, or undefined for the Model proxy's (`anthropic/<id>`) or a gone one. */
export const endpointOfModel = (model: string | undefined, endpoints: ModelEndpoints | undefined): string | undefined => {
  const parsed = model === undefined ? undefined : parseEndpointSlug(model);
  if (parsed === undefined || parsed.endpointId === "anthropic") return undefined;
  return endpoints?.endpoints.some((endpoint) => endpoint.id === parsed.endpointId) === true ? parsed.endpointId : undefined;
};

/** Whether the adapter's failure came from the Model proxy's classifier (its codes, or its key's name). */
const proxyClassified = (failure: OrchestrationV2ProviderFailure): boolean => failure.code?.startsWith("proxy_") === true || failure.message.includes(KEY_NAME);

export const cliRelayFailure = (failure: OrchestrationV2ProviderFailure, relayed: EndpointFailureRecord | null, endpointId: string | undefined, now: number): OrchestrationV2ProviderFailure => {
  if (relayed !== null) {
    return makeProviderFailure({ class: relayed.class, message: relayed.message, code: relayed.code, retryable: relayed.retryable, resetAt: heldReset(relayed, now) });
  }
  if (endpointId === undefined || !proxyClassified(failure)) return failure;
  return makeProviderFailure({ class: "provider_error", message: `${endpointLabel(endpointId)} failed while the agent was answering.`, code: null, retryable: null });
};

/** The failure a failed turn's terminal or an error item carries; undefined for any other event. */
export const failureOf = (event: Event): OrchestrationV2ProviderFailure | undefined =>
  event.type === "turn.terminal" && event.status === "failed" ? event.failure : event.type === "turn_item.updated" && event.turnItem.type === "error" ? event.turnItem.failure : undefined;

/** The event with its failure as t3 shows it for the session (`cliRelayFailure`). */
export const withRelayFailure = (event: Event, relayed: EndpointFailureRecord | null, endpointId: string | undefined, now: number): Event => {
  if (event.type === "turn.terminal" && event.status === "failed") return { ...event, failure: cliRelayFailure(event.failure, relayed, endpointId, now) };
  if (event.type === "turn_item.updated" && event.turnItem.type === "error") return { ...event, turnItem: { ...event.turnItem, failure: cliRelayFailure(event.turnItem.failure, relayed, endpointId, now) } };
  return event;
};
