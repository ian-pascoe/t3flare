// The Session's models (ADR-0012): pi-ai `anthropic` models served through the deployment's model proxy, one for each
// model in the catalog (`@t3flare/models/catalog`: the proxy's own list, or the static one before it is read). pi-ai's
// own catalog supplies the price, reasoning and thinking levels of a Claude model it knows; the proxy's base URL and key
// replace its endpoint. A model pi-ai does not know (a newer Claude, or any other model the proxy translates) is
// a generic Anthropic Messages model with the limits the catalog gives it. Adapted from
// cloudpid@ae5a7b73:apps/server/src/session/models.ts (`proxyModels`).
import { createModels, type FetchFunction, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { CatalogModel } from "@t3flare/models";
import type { Catalog, ModelProxy } from "@t3flare/models/catalog";

export type { ModelProxy };

type AnthropicModel = Model<"anthropic-messages">;

const FAMILY = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?$/;

/** A Claude model's family and version by its id: nothing after the version, so an alias never matches. */
const familyOf = (id: string) => {
  const match = FAMILY.exec(id);
  return match === null ? undefined : { family: match[1]!, version: [Number(match[2]), Number(match[3] ?? 0)] as const };
};

/** The newest model of `id`'s family that `known` has: the metadata of a Claude model pi-ai's own catalog lacks. */
const templateOf = (id: string, known: ReadonlyArray<AnthropicModel>): AnthropicModel | undefined => {
  const own = familyOf(id);
  if (own === undefined) return undefined;
  let newest: { readonly model: AnthropicModel; readonly version: readonly [number, number] } | undefined;
  for (const model of known) {
    const found = familyOf(model.id);
    if (found === undefined || found.family !== own.family) continue;
    if (newest === undefined || found.version[0] > newest.version[0] || (found.version[0] === newest.version[0] && found.version[1] > newest.version[1])) {
      newest = { model, version: found.version };
    }
  }
  return newest?.model;
};

export const modelOf = (entry: CatalogModel, known: ReadonlyArray<AnthropicModel>, baseUrl: string): AnthropicModel => {
  const base = known.find((model) => model.id === entry.id) ?? templateOf(entry.id, known);
  if (base !== undefined) {
    return { ...base, id: entry.id, name: entry.name, baseUrl, maxTokens: entry.maxTokens, contextWindow: entry.contextWindow };
  }
  // Nothing is known of it but what the catalog says: no price (a spend limit cannot count it).
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

/**
 * pi-ai `Models` whose one provider, `anthropic`, goes through the model proxy and lists the catalog `catalog` gives at
 * each lookup: a catalog the Session has read again is in force from its next request. `fetch`, when given, makes every
 * model request (the Session's recording fetch: it sees each answer's status and `retry-after`, which pi-ai drops).
 */
export const proxyModels = (proxy: ModelProxy, catalog: () => Catalog, fetch?: FetchFunction): MutableModels => {
  const models = createModels();
  const base = anthropicProvider();
  const known = base.getModels();
  // The list is made again only when the catalog is another one.
  let listedFor: Catalog | undefined;
  let listed: ReadonlyArray<AnthropicModel> = [];
  const current = (): ReadonlyArray<AnthropicModel> => {
    const now = catalog();
    if (now !== listedFor) {
      listedFor = now;
      listed = now.models.filter((entry) => entry.provider === "anthropic").map((entry) => modelOf(entry, known, proxy.url));
    }
    return listed;
  };
  models.setProvider({
    ...base,
    baseUrl: proxy.url,
    auth: {
      apiKey: {
        name: "Model proxy API key",
        resolve: () => Promise.resolve({ auth: { apiKey: proxy.apiKey, baseUrl: proxy.url }, source: "MODEL_PROXY_API_KEY" }),
      },
    },
    getModels: current,
    getAllModels: current,
    ...(fetch === undefined
      ? {}
      : {
          stream: (model: AnthropicModel, context: Parameters<typeof base.stream>[1], options?: Parameters<typeof base.stream>[2]) =>
            base.stream(model, context, { ...options, fetch }),
          streamSimple: (model: AnthropicModel, context: Parameters<typeof base.streamSimple>[1], options?: Parameters<typeof base.streamSimple>[2]) =>
            base.streamSimple(model, context, { ...options, fetch }),
        }),
  });
  return models;
};
