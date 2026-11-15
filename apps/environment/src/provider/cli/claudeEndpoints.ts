// Claude Code's Model endpoints (SPI-1168): the endpoints that speak Anthropic Messages. With one, Claude Code runs on
// them through the model relay, not the Model proxy: its one base URL is the relay's model-routed URL, so it reaches
// every such endpoint in one process (a model switch between two endpoints stays in the thread's process), and its
// models are the endpoints' slugs, which the relay reads from each request to pick its endpoint. The choice is the
// Environment's, not the session's: Claude Code's managed settings are the Container's, shared by every Claude process
// in it. Its background model (`ANTHROPIC_DEFAULT_HAIKU_MODEL`) is the text-generation model when that is one of these
// endpoints' models. Pure.
import type { ServerProviderModel } from "@t3tools/contracts";
import { defaultTextModel, endpointSlug, findEndpointModel, type ModelEndpoint, type ModelEndpoints, parseEndpointSlug } from "@t3flare/models/endpoints";
import { endpointsOfApi } from "@t3flare/models/relay";

import type { ClaudeRelay } from "../../agents/acpProfiles.ts";
import { acpModelCapabilities, cliModelId } from "./acpFlavor.ts";

/**
 * The endpoints Claude Code reaches through the model relay: those that speak Anthropic Messages and list a model (its
 * `availableModels` come from them; an endpoint with none adds nothing, and none with a model leaves the proxy).
 */
export const claudeEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> =>
  endpointsOfApi(endpoints, "anthropic-messages").filter((endpoint) => endpoint.models.length > 0);

/**
 * The background model: the text-generation model when it is one of these endpoints' models, else their own small
 * model (text generation's default rule over them), else the first one's first model.
 */
const backgroundModelOf = (own: ReadonlyArray<ModelEndpoint>, textModel: string | undefined): string | undefined => {
  const scoped: ModelEndpoints = { revision: 0, endpoints: own };
  if (textModel !== undefined && findEndpointModel(scoped, textModel) !== undefined) return textModel;
  const first = own[0];
  return defaultTextModel(scoped) ?? (first === undefined ? undefined : endpointSlug(first.id, first.models[0]!.id));
};

/** Claude Code's relay configuration for the endpoints as stored now, or undefined for the Model proxy (no such endpoint). */
export const claudeRelayOf = (endpoints: ModelEndpoints | undefined, textModel: string | undefined): ClaudeRelay | undefined => {
  const own = claudeEndpoints(endpoints);
  if (own.length === 0) return undefined;
  return {
    endpoints: own.map((endpoint) => endpoint.id),
    models: own.flatMap((endpoint) => endpoint.models.map((model) => endpointSlug(endpoint.id, model.id))),
    backgroundModel: backgroundModelOf(own, textModel),
  };
};

/**
 * Claude Code's model list: with an Anthropic Messages endpoint, those endpoints' models by slug, grouped by endpoint
 * (the endpoint's id beside a label two endpoints share), with the effort picker on reasoning models; else the proxy's
 * (`proxy`, as listed).
 */
export const claudeModelsOf = (proxy: ReadonlyArray<ServerProviderModel>, endpoints: ModelEndpoints | undefined): ReadonlyArray<ServerProviderModel> => {
  const own = claudeEndpoints(endpoints);
  if (own.length === 0) return proxy;
  const labels = new Map<string, number>();
  for (const endpoint of own) labels.set(endpoint.label, (labels.get(endpoint.label) ?? 0) + 1);
  return own.flatMap((endpoint) => {
    const group = (labels.get(endpoint.label) ?? 0) > 1 ? `${endpoint.label} · ${endpoint.id}` : endpoint.label;
    return endpoint.models.map((model) => ({ slug: endpointSlug(endpoint.id, model.id), name: model.name, subProvider: group, isCustom: false, capabilities: acpModelCapabilities(model.reasoning) }));
  });
};

/** The model as Claude Code names it: an Anthropic Messages endpoint's by its slug (the relay routes by it), the proxy's by its id. */
export const claudeModelId = (slug: string, endpoints: ModelEndpoints | undefined): string => {
  const endpointId = parseEndpointSlug(slug)?.endpointId;
  return endpointId !== undefined && claudeEndpoints(endpoints).some((endpoint) => endpoint.id === endpointId) ? slug : cliModelId("claude", slug);
};
