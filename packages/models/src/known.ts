// What pi-ai's own catalog knows of a model (SPI-1162): its name, limits, reasoning, thinking levels and price, for a model
// a Model endpoint serves. Only the catalogs of the vendors an endpoint is likely to be are read: pi-ai's catalog modules
// (their JSON plus the small `model-catalog.js`), no provider code, bundled where this is imported. The catalog of the
// endpoint's own host is tried first, then the others in order.
import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";

import type { EndpointApi, KnownModel } from "./endpoints.ts";

type Catalog = Readonly<Record<string, Model<Api>>>;

/** Each catalog with the host its vendor serves it at. */
const CATALOGS: ReadonlyArray<{ readonly host: string; readonly models: Catalog }> = [
  { host: "api.anthropic.com", models: ANTHROPIC_MODELS as unknown as Catalog },
  { host: "api.openai.com", models: OPENAI_MODELS as unknown as Catalog },
  { host: "generativelanguage.googleapis.com", models: GOOGLE_MODELS as unknown as Catalog },
  { host: "api.mistral.ai", models: MISTRAL_MODELS as unknown as Catalog },
  { host: "api.x.ai", models: XAI_MODELS as unknown as Catalog },
  { host: "api.deepseek.com", models: DEEPSEEK_MODELS as unknown as Catalog },
  { host: "api.groq.com", models: GROQ_MODELS as unknown as Catalog },
  { host: "openrouter.ai", models: OPENROUTER_MODELS as unknown as Catalog },
];

const hostOf = (baseUrl: string): string | undefined => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
};

/**
 * pi-ai's metadata for `id` at an endpoint of `api` at `baseUrl`, or undefined when no catalog read here has it. The
 * model's compatibility overrides come along only from a catalog entry of the same API.
 */
export const knownModel = (id: string, endpoint: { readonly api: EndpointApi; readonly baseUrl: string }): KnownModel | undefined => {
  const host = hostOf(endpoint.baseUrl);
  const ordered = [...CATALOGS.filter((catalog) => catalog.host === host), ...CATALOGS.filter((catalog) => catalog.host !== host)];
  for (const catalog of ordered) {
    const model = catalog.models[id];
    if (model === undefined || (model.type !== undefined && model.type !== "chat")) continue;
    const input = model.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
    return {
      name: model.name,
      reasoning: model.reasoning,
      input: input.length === 0 ? ["text"] : input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
      ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap as Readonly<Record<string, string | null>> }),
      ...(model.compat === undefined || model.api !== endpoint.api ? {} : { compat: model.compat as Readonly<Record<string, unknown>> }),
    };
  }
  return undefined;
};
