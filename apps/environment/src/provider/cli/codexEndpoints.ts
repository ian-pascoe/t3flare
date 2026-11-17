// Codex's Model endpoints (SPI-1167): the endpoints that speak OpenAI Responses, Codex's model list (those endpoints'
// models as `<endpointId>/<modelId>`, grouped by endpoint), and where each of t3's models goes in Codex (the guard's
// route). Pure. (Until the hard cut, SPI-1176, the Model proxy's models came first.)
import type { ServerProviderModel } from "@t3tools/contracts";
import { EMPTY_ENDPOINTS, endpointSlug, type ModelEndpoint, type ModelEndpoints } from "@t3flare/models/endpoints";
import { endpointProviderId, endpointsOfApi } from "@t3flare/models/relay";

import { codexModelRoute, type CodexModelRoute } from "./codexGuard.ts";

/** The endpoints Codex reaches through the model relay: those that speak OpenAI Responses. */
export const codexEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> => endpointsOfApi(endpoints, "openai-responses", "codex");

/** Codex's models: each Responses endpoint's by slug, labelled with the endpoint, the first the default. */
export const codexModelsOf = (endpoints: ModelEndpoints = EMPTY_ENDPOINTS): ReadonlyArray<ServerProviderModel> => {
  const own = codexEndpoints(endpoints);
  const labels = new Map<string, number>();
  for (const endpoint of own) labels.set(endpoint.label, (labels.get(endpoint.label) ?? 0) + 1);
  const listed = own.flatMap((endpoint) => {
    const group = (labels.get(endpoint.label) ?? 0) > 1 ? `${endpoint.label} · ${endpoint.id}` : endpoint.label;
    return endpoint.models.map((model) => ({ slug: endpointSlug(endpoint.id, model.id), name: model.name, subProvider: group, isCustom: false, capabilities: { optionDescriptors: [] } }));
  });
  return listed.map((model, at) => (at === 0 ? { ...model, isDefault: true } : model));
};

/** Where t3's model goes in Codex, for the endpoints as stored now. */
export const codexRouteFor =
  (endpoints: () => ModelEndpoints | undefined) =>
  (model: string): CodexModelRoute =>
    codexModelRoute(model, codexEndpoints(endpoints()), endpointProviderId);
