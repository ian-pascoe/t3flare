// Codex's Model endpoints (SPI-1167): the endpoints that speak OpenAI Responses, Codex's model list (the Model proxy's
// models as before, then those endpoints' models as `<endpointId>/<modelId>`, grouped by endpoint), and where each of
// t3's models goes in Codex (the guard's route). Pure.
import type { ServerProviderModel } from "@t3tools/contracts";
import { EMPTY_ENDPOINTS, endpointSlug, type ModelEndpoint, type ModelEndpoints } from "@t3flare/models/endpoints";
import { endpointProviderId, endpointsOfApi } from "@t3flare/models/relay";

import { CODEX_PROVIDER_ID } from "../../agents/cliProfiles.ts";
import { codexModelRoute, type CodexModelRoute } from "./codexGuard.ts";

/** The endpoints Codex reaches through the model relay: those that speak OpenAI Responses. */
export const codexEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> => endpointsOfApi(endpoints, "openai-responses");

/** Codex's models: the proxy's (`proxy`, as listed), then each Responses endpoint's by slug, labelled with the endpoint. */
export const codexModelsOf = (proxy: ReadonlyArray<ServerProviderModel>, endpoints: ModelEndpoints = EMPTY_ENDPOINTS): ReadonlyArray<ServerProviderModel> => {
  const vendors = new Set(proxy.map((model) => model.subProvider));
  const own = codexEndpoints(endpoints);
  const labels = new Map<string, number>();
  for (const endpoint of own) labels.set(endpoint.label, (labels.get(endpoint.label) ?? 0) + 1);
  return [
    ...proxy,
    ...own.flatMap((endpoint) => {
      const group = vendors.has(endpoint.label) || (labels.get(endpoint.label) ?? 0) > 1 ? `${endpoint.label} · ${endpoint.id}` : endpoint.label;
      return endpoint.models.map((model) => ({ slug: endpointSlug(endpoint.id, model.id), name: model.name, subProvider: group, isCustom: false, capabilities: { optionDescriptors: [] } }));
    }),
  ];
};

/** Where t3's model goes in Codex, for the endpoints as stored now. */
export const codexRouteFor =
  (endpoints: () => ModelEndpoints | undefined) =>
  (model: string): CodexModelRoute =>
    codexModelRoute(model, new Set(codexEndpoints(endpoints()).map((endpoint) => endpoint.id)), endpointProviderId, CODEX_PROVIDER_ID);

