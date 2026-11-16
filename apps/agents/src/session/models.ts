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
import {
  type EndpointApi,
  type EndpointCredential,
  type EndpointModel,
  endpointLabel,
  type EndpointTarget,
  isSignIn,
  type ModelEndpoint,
  type ModelEndpoints,
  SIGN_IN_TARGETS,
  targetOf,
} from "@t3flare/models/endpoints";

import { planUsagePayload } from "./planUsage.ts";

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

/** What an endpoint with no auth sends as its key: pi-ai sends no request without one. */
export const NO_KEY = "none";

export interface EndpointAccess {
  /** The endpoint's API key at use time (the Environment's, ADR-0018): never stored by the Session. */
  readonly credential: (endpointId: string, target: EndpointTarget) => Promise<EndpointCredential>;
  /** Every model request's fetch, where the API takes one. */
  readonly fetch?: FetchFunction;
  /** A sign-in endpoint's request was refused (401): its token is dropped from memory, and asked for again (SPI-1164). */
  readonly refused?: (endpointId: string) => void;
}

/** Why the Environment gave no key for an endpoint, as the turn (or the text generation) says it. */
export const credentialProblem = (endpointId: string, { unreadable, changed, signedOut, problem }: EndpointCredential): string =>
  changed === true
    ? `${endpointLabel(endpointId)} changed or was removed since this Session took it: retry the turn.`
    : signedOut === true
      ? `${endpointLabel(endpointId)} is not signed in to ChatGPT${problem === undefined ? "" : ` (${problem})`}: sign in with ChatGPT again in the Harness panel.`
      : problem !== undefined
        ? `${endpointLabel(endpointId)} could not get a ChatGPT token (${problem}).`
        : unreadable === true
      ? `${endpointLabel(endpointId)}'s API key can no longer be read (this Environment's credentials key changed): enter it again in the Harness panel.`
      : `${endpointLabel(endpointId)} has no API key: set one in the Harness panel.`;

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
  // SAFETY: both were copied from pi-ai's own catalog entry of this model (known.ts): `thinkingLevelMap` as pi-ai typed
  // it, `compat` only from an entry of the same API, so each is the type `Model<api>` declares; the stored copy widened them.
  ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap as NonNullable<Model<Api>["thinkingLevelMap"]> }),
  ...(model.compat === undefined ? {} : { compat: model.compat as never }),
});

/** A sign-in endpoint's fetch: a 401 tells the Session to drop the token it holds (it may have been revoked). */
const refusalWatch = (fetch: FetchFunction, onRefused: () => void): FetchFunction =>
  (async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
    const response = await fetch(input, init);
    if (response.status === 401) onRefused();
    return response;
  }) as FetchFunction;

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
      auth: {
        apiKey: {
          name: isSignIn(endpoint.auth) ? `${endpoint.label} sign-in` : `${endpoint.label} API key`,
          resolve: async () => {
            // The endpoint's headers go with every request as the resolved auth's headers: pi-ai sends those (it reads no
            // provider-level headers).
            const headers = { ...endpoint.headers };
            // pi-ai's APIs refuse a request without a key, so an endpoint with no auth sends a placeholder, never a secret.
            if (endpoint.auth === "none") return { auth: { apiKey: NO_KEY, baseUrl: endpoint.baseUrl, headers }, source: "Model endpoint (no key)" };
            // The key is asked for the target this provider sends it to; the Environment gives none for an old one.
            // A sign-in's access token comes the same way (the Credential broker's, SPI-1164), for the same target rule.
            const credential = await access.credential(endpoint.id, targetOf(endpoint));
            if (credential.apiKey === null) throw new Error(credentialProblem(endpoint.id, credential));
            return { auth: { apiKey: credential.apiKey, baseUrl: endpoint.baseUrl, headers }, source: isSignIn(endpoint.auth) ? "Model endpoint (sign-in)" : "Model endpoint" };
          },
        },
      },
      models: endpoint.models.map((model) => endpointModel(endpoint, model)),
      api: ENDPOINT_STREAMS[endpoint.api](),
    });
    if (isSignIn(endpoint.auth)) return signInProvider(base, endpoint, access);
    const fetch = access.fetch;
    if (fetch === undefined || !TAKES_FETCH.has(endpoint.api)) return base;
    return {
      ...base,
      // SAFETY: only `fetch` is added, a field every API's stream options declare (`ProviderRequestOptions.fetch`); the
      // cast restores the generic `ApiStreamOptions<T>` the spread widens.
      stream: (model, context, options) => base.stream(model, context, { ...options, fetch } as typeof options),
      streamSimple: (model, context, options) => base.streamSimple(model, context, { ...options, fetch }),
    } satisfies Provider;
  });

/**
 * A sign-in endpoint's provider (SPI-1164): every request's body follows ChatGPT plan usage's rules (`planUsagePayload`,
 * after any `onPayload` of the caller's), and a 401 drops the Session's token. Its API is the sign-in's own
 * (`SIGN_IN_TARGETS`), which takes a request's `fetch`.
 */
const signInProvider = (base: Provider, endpoint: ModelEndpoint, access: EndpointAccess): Provider => {
  const target = SIGN_IN_TARGETS[endpoint.auth as keyof typeof SIGN_IN_TARGETS];
  if (target === undefined || !TAKES_FETCH.has(target.api)) return base;
  const outer = access.fetch ?? (globalThis.fetch as FetchFunction);
  const fetch = access.refused === undefined ? outer : refusalWatch(outer, () => access.refused?.(endpoint.id));
  type Options = NonNullable<Parameters<Provider["streamSimple"]>[2]>;
  const withRules = (options: Options | undefined): Options => {
    const earlier = options?.onPayload;
    return {
      ...options,
      fetch,
      onPayload: async (params, model) => planUsagePayload((earlier === undefined ? undefined : await earlier(params, model)) ?? params),
    };
  };
  return {
    ...base,
    // SAFETY: as above, only `fetch` and `onPayload` are added, both fields of every API's stream options; the cast
    // restores the generic `ApiStreamOptions<T>` the spread widens.
    stream: (model, context, options) => base.stream(model, context, withRules(options as Options | undefined) as typeof options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, withRules(options)),
  } satisfies Provider;
};
