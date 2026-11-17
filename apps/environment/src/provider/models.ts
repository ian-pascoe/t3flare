// The Pi Durable picker's models (ADR-0034): each Model endpoint's models as `<endpointId>/<modelId>`, grouped by endpoint,
// each with its thinking picker (the option t3's Pi provider calls `thinking`). Until the hard cut (SPI-1176) the Model
// proxy's catalog came first, grouped by vendor.
import type { ModelCapabilities, ProviderOptionChoice, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { DEFAULT_THINKING, THINKING_LEVELS } from "@t3flare/models";
import { defaultModelSlug, EMPTY_ENDPOINTS, endpointSlug, type ModelEndpoints } from "@t3flare/models/endpoints";

const LABELS: Record<(typeof THINKING_LEVELS)[number], string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const capabilitiesOf = (model: { readonly reasoning: boolean }): ModelCapabilities =>
  createModelCapabilities({
    optionDescriptors: model.reasoning
      ? [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: THINKING_LEVELS.map(
              (level): ProviderOptionChoice => ({
                id: level,
                label: LABELS[level],
                ...(level === DEFAULT_THINKING ? { isDefault: true } : {}),
              }),
            ),
          },
        ]
      : [],
  });

/**
 * Each Model endpoint's models (SPI-1162) as `<endpointId>/<modelId>`, grouped by endpoint in the owner's order,
 * labelled with the endpoint's label (and its id when another endpoint has that label, so the groups never merge). The
 * picker's default is the default model (`defaultModelSlug`: the first endpoint's first model). Empty without an
 * endpoint: the provider then needs setup (`driver.ts`).
 */
export const snapshotModels = (endpoints: ModelEndpoints = EMPTY_ENDPOINTS): ReadonlyArray<ServerProviderModel> => {
  const labels = new Map<string, number>();
  for (const endpoint of endpoints.endpoints) labels.set(endpoint.label, (labels.get(endpoint.label) ?? 0) + 1);
  const defaultSlug = defaultModelSlug(endpoints);
  return endpoints.endpoints.flatMap((endpoint) => {
    const group = (labels.get(endpoint.label) ?? 0) > 1 ? `${endpoint.label} · ${endpoint.id}` : endpoint.label;
    return endpoint.models.map((model) => {
      const slug = endpointSlug(endpoint.id, model.id);
      return {
        slug,
        name: model.name,
        subProvider: group,
        isCustom: false,
        capabilities: capabilitiesOf(model),
        ...(slug === defaultSlug ? { isDefault: true } : {}),
      };
    });
  });
};
