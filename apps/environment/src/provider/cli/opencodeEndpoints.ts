// OpenCode's Model endpoints (SPI-1169): the endpoints whose API OpenCode speaks (Anthropic Messages, OpenAI Responses,
// OpenAI-compatible Completions) and that list a model. OpenCode runs on them through the model relay (without one it is
// refused at its spawn, SPI-1176): one OpenCode provider per endpoint, each at the relay's per-endpoint URL (OpenCode
// takes a base URL per provider, so no model-routed URL is needed), and a model switch between two endpoints stays in
// the thread's process. Its small model is the text-generation model when that is one of these endpoints' models. Pure.
import type { ServerProviderModel } from "@t3tools/contracts";
import { type ModelEndpoint, type ModelEndpoints, selectionSlug } from "@t3flare/models/endpoints";
import { relayedEndpoints } from "@t3flare/models/relay";

import { opencodeEndpointModel, type OpenCodeRelay, opencodeServes } from "../../agents/acpProfiles.ts";
import { relayPickerModels, relayTextModel } from "./relayModels.ts";

/** The endpoints OpenCode reaches through the model relay: relayed, an API it has a provider package for, and a model. */
export const opencodeEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> => relayedEndpoints(endpoints, "opencode").filter(opencodeServes);

/** OpenCode's relay configuration for the endpoints as stored now, or undefined when there is no such endpoint. */
export const opencodeRelayOf = (endpoints: ModelEndpoints | undefined, textModel: string | undefined): OpenCodeRelay | undefined => {
  const own = opencodeEndpoints(endpoints);
  if (own.length === 0) return undefined;
  const picker = relayPickerModels(own);
  return { endpoints: own, model: picker[0]?.slug, smallModel: relayTextModel(own, textModel) };
};

/** OpenCode's model list: those endpoints' models by slug, grouped by endpoint, the first the default; empty without one. */
export const opencodeModelsOf = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ServerProviderModel> => relayPickerModels(opencodeEndpoints(endpoints));

/**
 * The model as OpenCode names it: an endpoint's slug as its provider's model (`t3flare-endpoint-<id>/<model>`). An old
 * model (`isRetiredSlug`) is the default model, the list's first (`selectionSlug`). A slug
 * of an endpoint OpenCode does not reach is its provider's model all the same, which the session does not offer: t3's
 * adapter refuses it before any request.
 */
export const opencodeModelId = (slug: string, endpoints: ModelEndpoints | undefined): string => {
  const chosen = selectionSlug(slug, relayPickerModels(opencodeEndpoints(endpoints))[0]?.slug);
  return opencodeEndpointModel(chosen) ?? chosen;
};
