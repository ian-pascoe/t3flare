// The Session's models (ADR-0012): pi-ai `anthropic` models served through the deployment's model proxy, one for each
// model in the catalog (`@t3flare/models/catalog`: the proxy's own list, or the static one before it is read). pi-ai's
// own catalog supplies the price, reasoning and thinking levels of a Claude model it knows; the proxy's base URL and key
// replace its endpoint. A model pi-ai does not know (a newer Claude, or any other model the proxy translates) is
// a generic Anthropic Messages model with the limits the catalog gives it. Adapted from
// cloudpid@ae5a7b73:apps/server/src/session/models.ts (`proxyModels`).
import { type Api, createModels, createProvider, type FetchFunction, type Model, type MutableModels, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { CatalogModel } from "@t3flare/models";
import type { Catalog, ModelProxy } from "@t3flare/models/catalog";
import type { EndpointApi, EndpointModel, ModelEndpoint, ModelEndpoints } from "@t3flare/models/endpoints";

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

// ---------------------------------------------------------------------------------------------------------------------
// Model endpoints (SPI-1162): the owner's own endpoints, beside the proxy's provider until the hard cut (SPI-1176).

/** Each endpoint API's pi-ai implementation, loaded at its first request. */
const ENDPOINT_STREAMS: Readonly<Record<EndpointApi, () => ProviderStreams>> = {
  "anthropic-messages": anthropicMessagesApi,
  "openai-responses": openAIResponsesApi,
  "openai-completions": openAICompletionsApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
};

/** The APIs whose pi-ai implementation takes a request's `fetch` (the Session's recording one). */
const TAKES_FETCH: ReadonlySet<EndpointApi> = new Set(["anthropic-messages", "openai-responses", "openai-completions"]);

export interface EndpointAccess {
  /** The endpoint's API key at use time (the Environment's, ADR-0018): never stored by the Session. */
  readonly credential: (endpointId: string) => Promise<string | undefined>;
  /** Every model request's fetch, where the API takes one. */
  readonly fetch?: FetchFunction;
}

const endpointModel = (endpoint: ModelEndpoint, model: EndpointModel): Model<Api> => ({
  id: model.id,
  name: model.name,
  api: endpoint.api,
  provider: endpoint.id,
  baseUrl: endpoint.baseUrl,
  reasoning: model.reasoning,
  input: [...model.input],
  cost: { ...model.cost },
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap as NonNullable<Model<Api>["thinkingLevelMap"]> }),
  ...(model.compat === undefined ? {} : { compat: model.compat as never }),
});

/**
 * One pi-ai provider per endpoint, under the endpoint's id: a model's ref is `{ provider: <endpointId>, modelId }`, its t3
 * slug `<endpointId>/<modelId>`. Each resolves its key from `access.credential` at each request; an API-key endpoint
 * whose key is gone fails the request with a message that says so.
 */
export const endpointProviders = (endpoints: ModelEndpoints, access: EndpointAccess): ReadonlyArray<Provider> =>
  endpoints.endpoints.map((endpoint) => {
    const base = createProvider({
      id: endpoint.id,
      name: endpoint.label,
      baseUrl: endpoint.baseUrl,
      ...(Object.keys(endpoint.headers).length === 0 ? {} : { headers: { ...endpoint.headers } }),
      auth: {
        apiKey: {
          name: `${endpoint.label} API key`,
          resolve: async () => {
            if (endpoint.auth === "none") return { auth: { baseUrl: endpoint.baseUrl }, source: "Model endpoint (no key)" };
            const apiKey = await access.credential(endpoint.id);
            if (apiKey === undefined) throw new Error(`The Model endpoint "${endpoint.id}" has no API key: set one in the Harness panel.`);
            return { auth: { apiKey, baseUrl: endpoint.baseUrl }, source: "Model endpoint" };
          },
        },
      },
      models: endpoint.models.map((model) => endpointModel(endpoint, model)),
      api: ENDPOINT_STREAMS[endpoint.api](),
    });
    const fetch = access.fetch;
    if (fetch === undefined || !TAKES_FETCH.has(endpoint.api)) return base;
    return {
      ...base,
      stream: (model, context, options) => base.stream(model, context, { ...options, fetch } as typeof options),
      streamSimple: (model, context, options) => base.streamSimple(model, context, { ...options, fetch }),
    } satisfies Provider;
  });
