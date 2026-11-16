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
import { endpointLabel, type ModelEndpoints, parseEndpointSlug } from "@t3flare/models/endpoints";
import type { EndpointFailureRecord } from "@t3flare/session-protocol";
import * as DateTime from "effect/DateTime";

import { KEY_NAME } from "./acpFlavor.ts";

/** The least time after now a CLI turn's usage-limit reset is held to: t3 arms no resume for one not after the turn. */
export const CLI_MIN_RESET_MS = 30_000;

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
    const resetAt = relayed.class === "usage_limit" && relayed.resetAt !== undefined ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(relayed.resetAt, now + CLI_MIN_RESET_MS))) : null;
    return makeProviderFailure({ class: relayed.class, message: relayed.message, code: relayed.code, retryable: relayed.retryable, resetAt });
  }
  if (endpointId === undefined || !proxyClassified(failure)) return failure;
  return makeProviderFailure({ class: "provider_error", message: `${endpointLabel(endpointId)} failed while the agent was answering.`, code: null, retryable: null });
};
