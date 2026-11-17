// The Session's models (ADR-0034): one pi-ai provider per Model endpoint, under the endpoint's id, its models those the
// endpoint lists; a model's ref is `{ provider: <endpointId>, modelId }`, its t3 slug `<endpointId>/<modelId>`. Each
// resolves its key (or a sign-in's token) from the Environment at use time (ADR-0018) and never stores it. There is no
// other provider.
import { type Api, type AssistantMessage, type Context, createModels, createProvider, type FetchFunction, type Model, type MutableModels, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  type EndpointApi,
  type EndpointCredential,
  type EndpointModel,
  type EndpointTarget,
  isSignIn,
  type ModelEndpoint,
  type ModelEndpoints,
  type SignIn,
  signInRequestTarget,
  targetOf,
} from "@t3flare/models/endpoints";
import { type LimitReading, noteLimitReading } from "@t3flare/models/limits";
import type { EndpointCredentialFailure } from "@t3flare/session-protocol";

import { credentialFailure } from "./credentialFailure.ts";
import { SIGN_IN_REQUESTS } from "./signInRequests.ts";

/** The Session's models before any endpoint's provider is installed (`SessionEndpoints` installs and removes them). */
export const sessionModels = (): MutableModels => createModels();

// ---------------------------------------------------------------------------------------------------------------------
// Model endpoints (SPI-1162): the owner's own endpoints.

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
  /**
   * Each credential request's outcome (SPI-1164): the typed failure when there is none, undefined when there is one, so
   * the Session can record on the turn why it failed (the differ shows it) without anything reading the error's text.
   */
  readonly outcome?: (failure: EndpointCredentialFailure | undefined, endpointId: string) => void;
  /**
   * Every answer a model of the endpoint gives (its final message: a failed one too, with what usage it got), for the
   * usage records (SPI-1173). Called after the answer, never in its way.
   */
  readonly answered?: (message: AssistantMessage, endpointId: string) => void;
  /**
   * The limit windows each answer's headers report (SPI-1174), read as the answer arrives (a failed one too: a refused
   * limit is the reading that matters most), for t3's limit meters. Never in the answer's way. Only on the APIs whose
   * pi-ai client takes a request's `fetch` (Anthropic Messages, OpenAI Responses and Completions): Google's and
   * Mistral's send no window headers.
   */
  readonly limits?: (reading: LimitReading) => void;
}

/** A provider whose every answer is also handed to `answered` once it is final; the answer's stream is untouched. */
const answering = (provider: Provider, endpointId: string, answered: EndpointAccess["answered"]): Provider => {
  if (answered === undefined) return provider;
  const watch = <S extends { result(): Promise<AssistantMessage> }>(stream: S): S => {
    stream.result().then(
      (message) => {
        try {
          answered(message, endpointId);
        } catch {
          // A record that fails is lost; the answer is not.
        }
      },
      () => undefined,
    );
    return stream;
  };
  return {
    ...provider,
    stream: (model, context, options) => watch(provider.stream(model, context, options)),
    streamSimple: (model, context, options) => watch(provider.streamSimple(model, context, options)),
  } satisfies Provider;
};

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
  ...compatOf(endpoint, model),
});

/**
 * The model's compat: its catalog entry's, with its sign-in's overrides (`SIGN_IN_REQUESTS`, typed as its API's compat).
 * The one cast: `Model<Api>["compat"]` is a conditional type over the generic API, which no runtime API value narrows,
 * so TypeScript resolves it to `never`; the value is that API's compat (the catalog's same-API entry, the override's type).
 */
const compatOf = (endpoint: ModelEndpoint, model: EndpointModel): { readonly compat?: never } => {
  const overrides = isSignIn(endpoint.auth) ? SIGN_IN_REQUESTS[endpoint.auth]?.compat : undefined;
  if (model.compat === undefined && overrides === undefined) return {};
  return { compat: { ...model.compat, ...overrides } as never };
};

/** A sign-in endpoint's fetch: a 401 tells the Session to drop the token it holds (it may have been revoked). */
const refusalWatch = (fetch: FetchFunction, onRefused: () => void): FetchFunction =>
  (async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
    const response = await fetch(input, init);
    if (response.status === 401) onRefused();
    return response;
  }) as FetchFunction;

/** An endpoint's fetch whose every answer's limit windows go to `limits`; the answer itself is untouched. */
export const limitWatch = (fetch: FetchFunction, endpointId: string, limits: (reading: LimitReading) => void, now: () => number = Date.now): FetchFunction =>
  (async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
    const response = await fetch(input, init);
    noteLimitReading(endpointId, response.headers, now(), limits);
    return response;
  }) as FetchFunction;

/** The fetch an endpoint's requests go through: the Session's, watched for limit headers when it reads them. */
const endpointFetch = (endpointId: string, access: EndpointAccess): FetchFunction | undefined => {
  if (access.limits === undefined) return access.fetch;
  return limitWatch(access.fetch ?? (globalThis.fetch as FetchFunction), endpointId, access.limits);
};

/**
 * One pi-ai provider per endpoint, under the endpoint's id: a model's ref is `{ provider: <endpointId>, modelId }`, its t3
 * slug `<endpointId>/<modelId>`. Each resolves its key from `access.credential` at each request; an API-key endpoint
 * whose key is gone fails the request with a message that says so.
 */
export const endpointProviders = (endpoints: ModelEndpoints, access: EndpointAccess): ReadonlyArray<Provider> =>
  endpoints.endpoints.map((endpoint) => answering(endpointProvider(endpoint, access), endpoint.id, access.answered));

const endpointProvider = (endpoint: ModelEndpoint, access: EndpointAccess): Provider => {
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
          if (credential.apiKey === null) {
            const failure = credentialFailure(endpoint, credential);
            access.outcome?.(failure, endpoint.id);
            throw new Error(failure.message);
          }
          access.outcome?.(undefined, endpoint.id);
          // A sign-in whose token names where it goes (Copilot's, SPI-1166) goes there, with the headers the broker gives
          // beside it, when its kind allows that base URL (`signInRequestTarget`, the model relay's rule too); the
          // endpoint's own base URL is then only a stand-in. No other endpoint takes either.
          const sent = isSignIn(endpoint.auth) ? signInRequestTarget(endpoint, credential) : { baseUrl: endpoint.baseUrl, headers };
          return {
            auth: { apiKey: credential.apiKey, baseUrl: sent.baseUrl, headers: { ...sent.headers } },
            source: isSignIn(endpoint.auth) ? "Model endpoint (sign-in)" : "Model endpoint",
          };
        },
      },
    },
    models: endpoint.models.map((model) => endpointModel(endpoint, model)),
    api: ENDPOINT_STREAMS[endpoint.api](),
  });
  if (isSignIn(endpoint.auth)) return signInProvider(base, endpoint.auth, endpoint, access);
  const fetch = endpointFetch(endpoint.id, access);
  if (fetch === undefined || !TAKES_FETCH.has(endpoint.api)) return base;
  return {
    ...base,
    // SAFETY: only `fetch` is added, a field every API's stream options declare (`ProviderRequestOptions.fetch`); the
    // cast restores the generic `ApiStreamOptions<T>` the spread widens.
    stream: (model, context, options) => base.stream(model, context, { ...options, fetch } as typeof options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, { ...options, fetch }),
  } satisfies Provider;
};

/**
 * A sign-in endpoint's provider (SPI-1164): every request's body follows its sign-in's rules (`SIGN_IN_REQUESTS`, after
 * any `onPayload` of the caller's), and a 401 drops the Session's token. Its API is the sign-in's own, which takes a
 * request's `fetch`.
 */
const signInProvider = (base: Provider, kind: SignIn, endpoint: ModelEndpoint, access: EndpointAccess): Provider => {
  if (!TAKES_FETCH.has(endpoint.api)) return base;
  const rules = SIGN_IN_REQUESTS[kind];
  const payload = rules?.payload;
  const outer = endpointFetch(endpoint.id, access) ?? (globalThis.fetch as FetchFunction);
  const fetch = access.refused === undefined ? outer : refusalWatch(outer, () => access.refused?.(endpoint.id));
  type Options = NonNullable<Parameters<Provider["streamSimple"]>[2]>;
  const withRules = (context: Context, options: Options | undefined): Options => {
    const headers = rules?.headers === undefined ? {} : { headers: { ...options?.headers, ...rules.headers(context) } };
    if (payload === undefined) return { ...options, ...headers, fetch };
    const earlier = options?.onPayload;
    return {
      ...options,
      ...headers,
      fetch,
      onPayload: async (params, model) => payload((earlier === undefined ? undefined : await earlier(params, model)) ?? params),
    };
  };
  return {
    ...base,
    // SAFETY: as above, only `fetch`, `headers` and `onPayload` are added, fields of every API's stream options; the cast
    // restores the generic `ApiStreamOptions<T>` the spread widens.
    stream: (model, context, options) => base.stream(model, context, withRules(context, options as Options | undefined) as typeof options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, withRules(context, options)),
  } satisfies Provider;
};
