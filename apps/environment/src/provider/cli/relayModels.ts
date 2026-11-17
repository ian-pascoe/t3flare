// What the ACP CLIs on the model relay share (Claude Code, SPI-1168; OpenCode, SPI-1169): the picker's list of their
// endpoints' models, and the small model they run for their own background work. Pure.
import type { ServerProviderModel } from "@t3tools/contracts";
import { defaultTextModel, endpointSlug, findEndpointModel, type ModelEndpoint, type ModelEndpoints } from "@t3flare/models/endpoints";

import { acpModelCapabilities } from "./acpFlavor.ts";

/**
 * The picker's models of a CLI's endpoints: by slug, grouped by endpoint (the endpoint's id beside a label two endpoints
 * share), with the effort picker on reasoning models. The first is the default for a new thread.
 */
export const relayPickerModels = (own: ReadonlyArray<ModelEndpoint>): ReadonlyArray<ServerProviderModel> => {
  const labels = new Map<string, number>();
  for (const endpoint of own) labels.set(endpoint.label, (labels.get(endpoint.label) ?? 0) + 1);
  const listed = own.flatMap((endpoint) => {
    const group = (labels.get(endpoint.label) ?? 0) > 1 ? `${endpoint.label} · ${endpoint.id}` : endpoint.label;
    return endpoint.models.map((model) => ({ slug: endpointSlug(endpoint.id, model.id), name: model.name, subProvider: group, isCustom: false, capabilities: acpModelCapabilities(model.reasoning) }));
  });
  return listed.map((model, at) => (at === 0 ? { ...model, isDefault: true } : model));
};

/**
 * A CLI's background (small) model among its endpoints: the text-generation model when it is one of their models, else
 * their own small model (text generation's default rule over them), else the first one's first model.
 */
export const relayTextModel = (own: ReadonlyArray<ModelEndpoint>, textModel: string | undefined): string | undefined => {
  const scoped: ModelEndpoints = { revision: 0, endpoints: own };
  if (textModel !== undefined && findEndpointModel(scoped, textModel) !== undefined) return textModel;
  const first = own.find((endpoint) => endpoint.models.length > 0);
  return defaultTextModel(scoped) ?? (first === undefined ? undefined : endpointSlug(first.id, first.models[0]!.id));
};
