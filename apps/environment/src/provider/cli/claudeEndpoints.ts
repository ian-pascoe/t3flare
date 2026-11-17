// Claude Code's Model endpoints (SPI-1168): the endpoints that speak Anthropic Messages. Claude Code runs on them through
// the model relay (without one it is refused, SPI-1176): its one base URL is the relay's model-routed URL, so it reaches
// every such endpoint in one process (a model switch between two endpoints stays in the thread's process), and its
// models are the endpoints' slugs, which the relay reads from each request to pick its endpoint. The choice is the
// Environment's, not the session's: Claude Code's managed settings are the Container's, shared by every Claude process
// in it. Its background model (`ANTHROPIC_DEFAULT_HAIKU_MODEL`) is the text-generation model when that is one of these
// endpoints' models. Pure.
import type { ServerProviderModel } from "@t3tools/contracts";
import { endpointSlug, isRetiredSlug, type ModelEndpoint, type ModelEndpoints } from "@t3flare/models/endpoints";
import { endpointsOfApi } from "@t3flare/models/relay";

import type { ClaudeRelay } from "../../agents/acpProfiles.ts";
import { relayPickerModels, relayTextModel } from "./relayModels.ts";

/**
 * The endpoints Claude Code reaches through the model relay: those that speak Anthropic Messages and list a model (its
 * `availableModels` come from them; an endpoint with none adds nothing, and none with a model leaves Claude Code with no
 * endpoint, refused at its spawn).
 */
export const claudeEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> =>
  endpointsOfApi(endpoints, "anthropic-messages", "claude").filter((endpoint) => endpoint.models.length > 0);

/** A model family's word (`opus`, `sonnet`) in a model id. */
const familyOf = (family: string) => new RegExp(`(?:^|[-_./:])${family}(?:$|[-_.:])`, "i");

/**
 * The slug Claude Code's `opus` or `sonnet` alias resolves to: the first model of that family in the owner's order, else
 * the first model listed (so the alias still names a slug the relay routes, never Claude Code's own id).
 */
const familyModelOf = (own: ReadonlyArray<ModelEndpoint>, family: "opus" | "sonnet"): string | undefined => {
  const slugs = own.flatMap((endpoint) => endpoint.models.map((model) => ({ slug: endpointSlug(endpoint.id, model.id), id: model.id })));
  return (slugs.find((entry) => familyOf(family).test(entry.id)) ?? slugs[0])?.slug;
};

/** Claude Code's relay configuration for the endpoints as stored now, or undefined when there is no such endpoint. */
export const claudeRelayOf = (endpoints: ModelEndpoints | undefined, textModel: string | undefined): ClaudeRelay | undefined => {
  const own = claudeEndpoints(endpoints);
  if (own.length === 0) return undefined;
  return {
    endpoints: own.map((endpoint) => endpoint.id),
    models: own.flatMap((endpoint) => endpoint.models.map((model) => endpointSlug(endpoint.id, model.id))),
    backgroundModel: relayTextModel(own, textModel),
    opusModel: familyModelOf(own, "opus"),
    sonnetModel: familyModelOf(own, "sonnet"),
  };
};

/**
 * Claude Code's model list: the Anthropic Messages endpoints' models by slug, grouped by endpoint (the endpoint's id
 * beside a label two endpoints share), with the effort picker on reasoning models, the first the default. Empty without
 * one: the provider then needs setup.
 */
export const claudeModelsOf = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ServerProviderModel> => relayPickerModels(claudeEndpoints(endpoints));

/**
 * The model as Claude Code names it: an Anthropic Messages endpoint's by its slug (the relay routes by it). A model from
 * before the hard cut (SPI-1176, `isRetiredSlug`: the Model proxy's ids, t3's stock Claude default) is the default model,
 * the list's first. Any other slug (an endpoint that is gone) stays as it is: Claude Code's session does not offer it,
 * and t3's adapter refuses it before any request.
 */
export const claudeModelId = (slug: string, endpoints: ModelEndpoints | undefined): string =>
  isRetiredSlug(slug) ? (relayPickerModels(claudeEndpoints(endpoints))[0]?.slug ?? slug) : slug;
