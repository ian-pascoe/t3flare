// OpenCode's Model endpoints (SPI-1169): the endpoints whose API OpenCode speaks (Anthropic Messages, OpenAI Responses,
// OpenAI-compatible Completions) and that list a model. With one, OpenCode runs on them through the model relay, not the
// Model proxy: one OpenCode provider per endpoint, each at the relay's per-endpoint URL (OpenCode takes a base URL per
// provider, so no model-routed URL is needed), and a model switch between two endpoints stays in the thread's process.
// The choice is the Environment's, as Claude Code's (SPI-1168): with such an endpoint every OpenCode process runs on the
// endpoints, and the Model proxy's models are not offered. Its small model is the text-generation model when that is
// one of these endpoints' models. Pure.
import type { ServerProviderModel } from "@t3tools/contracts";
import { type ModelEndpoint, type ModelEndpoints, parseEndpointSlug } from "@t3flare/models/endpoints";

import { OPENCODE_PACKAGES, opencodeEndpointModel, type OpenCodeRelay } from "../../agents/acpProfiles.ts";
import { cliModelId } from "./acpFlavor.ts";
import { relayPickerModels, relayTextModel } from "./relayModels.ts";

/** The endpoints OpenCode reaches through the model relay: an API it has a provider package for, and a model. */
export const opencodeEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> =>
  (endpoints?.endpoints ?? []).filter((endpoint) => OPENCODE_PACKAGES[endpoint.api] !== undefined && endpoint.models.length > 0);

/** OpenCode's relay configuration for the endpoints as stored now, or undefined for the Model proxy (no such endpoint). */
export const opencodeRelayOf = (endpoints: ModelEndpoints | undefined, textModel: string | undefined): OpenCodeRelay | undefined => {
  const own = opencodeEndpoints(endpoints);
  if (own.length === 0) return undefined;
  const picker = relayPickerModels(own);
  return { endpoints: own, model: picker[0]?.slug, smallModel: relayTextModel(own, textModel) };
};

/** OpenCode's model list: with such an endpoint, those endpoints' models by slug, grouped by endpoint; else the proxy's. */
export const opencodeModelsOf = (proxy: ReadonlyArray<ServerProviderModel>, endpoints: ModelEndpoints | undefined): ReadonlyArray<ServerProviderModel> => {
  const own = opencodeEndpoints(endpoints);
  return own.length === 0 ? proxy : relayPickerModels(own);
};

/**
 * The model as OpenCode names it: an endpoint's slug as its provider's model (`t3flare-endpoint-<id>/<model>`), else the
 * proxy's (`t3flare/<id>`). A slug of an endpoint OpenCode does not reach stays the proxy's id, which the session does
 * not offer on the relay: t3's adapter refuses it before any request.
 */
export const opencodeModelId = (slug: string, endpoints: ModelEndpoints | undefined): string => {
  const endpointId = parseEndpointSlug(slug)?.endpointId;
  const own = endpointId !== undefined && opencodeEndpoints(endpoints).some((endpoint) => endpoint.id === endpointId);
  return own ? opencodeEndpointModel(slug)! : cliModelId("opencode", slug);
};
