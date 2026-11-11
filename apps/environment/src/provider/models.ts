// The provider snapshot's models: the catalog's (the proxy's list, or the static one before it is read), grouped by vendor, each with its thinking picker (the option t3's
// Pi provider calls `thinking`).
import type { ModelCapabilities, ProviderOptionChoice, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { Catalog } from "@t3flare/models/catalog";
import { DEFAULT_MODEL_SLUG, DEFAULT_THINKING, OTHER_VENDOR, THINKING_LEVELS, type CatalogModel } from "@t3flare/models";

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

/** Vendors by name, the unknown ones (`OTHER_VENDOR`) last. */
const byVendor = (a: CatalogModel, b: CatalogModel): number =>
  Number(a.vendor === OTHER_VENDOR) - Number(b.vendor === OTHER_VENDOR) || a.vendor.localeCompare(b.vendor, "en", { sensitivity: "base" });

/**
 * Each model labelled with its vendor and grouped by it (t3's picker keeps the order it is given), the catalog's order
 * within a vendor. The picker's default is the default model when the catalog lists it, else the catalog's first model.
 */
export const snapshotModels = (catalog: Catalog): ReadonlyArray<ServerProviderModel> => {
  const defaultSlug = catalog.models.some((model) => model.slug === DEFAULT_MODEL_SLUG) ? DEFAULT_MODEL_SLUG : catalog.models[0]?.slug;
  return catalog.models.toSorted(byVendor).map((model) => ({
    slug: model.slug,
    name: model.name,
    subProvider: model.vendor,
    isCustom: false,
    ...(model.slug === defaultSlug ? { isDefault: true } : {}),
    capabilities: capabilitiesOf(model),
  }));
};
