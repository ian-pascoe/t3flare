// The Session's models (ADR-0012): pi-ai `anthropic` models served through the deployment's model proxy, the list
// static (@t3flare/models, pi's models.json shape). pi-ai's own catalog supplies each known model's price, reasoning and
// thinking levels; the proxy's base URL and key replace its endpoint. Adapted from
// cloudpid@ae5a7b73:apps/server/src/session/models.ts (`proxyModels`).
import { createModels, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { CATALOG, type CatalogModel } from "@t3flare/models";

type AnthropicModel = Model<"anthropic-messages">;

export interface ModelProxy {
  readonly url: string;
  readonly apiKey: string;
}

const modelOf = (entry: CatalogModel, known: ReadonlyArray<AnthropicModel>, baseUrl: string): AnthropicModel => {
  const own = known.find((model) => model.id === entry.id);
  if (own !== undefined) {
    return { ...own, name: entry.name, baseUrl, maxTokens: entry.maxTokens, contextWindow: entry.contextWindow };
  }
  return {
    id: entry.id,
    name: entry.name,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
};

/** pi-ai `Models` whose one provider, `anthropic`, goes through the model proxy and lists the static catalog. */
export const proxyModels = (proxy: ModelProxy): MutableModels => {
  const models = createModels();
  const base = anthropicProvider();
  const known = base.getModels();
  const listed = CATALOG.filter((entry) => entry.provider === "anthropic").map((entry) => modelOf(entry, known, proxy.url));
  models.setProvider({
    ...base,
    baseUrl: proxy.url,
    auth: {
      apiKey: {
        name: "Model proxy API key",
        resolve: () => Promise.resolve({ auth: { apiKey: proxy.apiKey, baseUrl: proxy.url }, source: "MODEL_PROXY_API_KEY" }),
      },
    },
    getModels: () => listed,
    getAllModels: () => listed,
  });
  return models;
};
