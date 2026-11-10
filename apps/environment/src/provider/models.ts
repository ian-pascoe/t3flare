// The provider snapshot's models: the static list from @t3flare/models, each with its thinking picker (the option t3's
// Pi provider calls `thinking`).
import type { ModelCapabilities, ProviderOptionChoice, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { CATALOG, DEFAULT_MODEL_SLUG, DEFAULT_THINKING, THINKING_LEVELS, type CatalogModel } from "@t3flare/models";

const LABELS: Record<(typeof THINKING_LEVELS)[number], string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const capabilitiesOf = (model: CatalogModel): ModelCapabilities =>
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

export const snapshotModels = (): ReadonlyArray<ServerProviderModel> =>
  CATALOG.map((model) => ({
    slug: model.slug,
    name: model.name,
    subProvider: model.provider,
    isCustom: false,
    ...(model.slug === DEFAULT_MODEL_SLUG ? { isDefault: true } : {}),
    capabilities: capabilitiesOf(model),
  }));
