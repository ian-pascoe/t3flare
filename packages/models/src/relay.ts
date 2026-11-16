// The model relay (SPI-1167; ADR-0016's model relay refinement): CLI agents reach Model endpoints at
// `http://computer.internal/t3flare/model/<endpointId>/…` in their Container, with a per-process **model handle** as
// their key. The Workers check the handle, swap in the endpoint's own credential and stream the request to the
// endpoint's base URL unchanged. These are the pieces both Workers share: the route, the handle's variable, and what the
// Environment answers for an endpoint (its target with the credential in its header). A CLI adds only its own config.
import { ENDPOINT_APIS, type EndpointApi, isSignIn, type ModelEndpoint, type ModelEndpoints } from "./endpoints.ts";

/** The relay's path prefix in the Container's egress host. */
export const MODEL_RELAY_PREFIX = "/t3flare/model/";

/** The variable a CLI process reads its model handle from (Codex's provider `env_key`). */
export const MODEL_HANDLE_ENV = "T3FLARE_MODEL_HANDLE";

/** An endpoint's base URL as a CLI in the Container reaches it through the relay. */
export const modelRelayUrl = (endpointId: string): string => `http://computer.internal${MODEL_RELAY_PREFIX}${endpointId}`;

/**
 * The relay's id for a request routed by its body's model (SPI-1168): a CLI that takes one base URL per process (Claude
 * Code's `ANTHROPIC_BASE_URL`) names its model as `<endpointId>/<modelId>`, and the relay sends the request to that
 * endpoint with the model's own id in the body. Never an endpoint's id (`ENDPOINT_ID` has no `_`).
 */
export const MODEL_ROUTED_ID = "_";

/** The model-routed base URL: every endpoint the process's handle is for, chosen per request by the body's model slug. */
export const modelRoutedRelayUrl = modelRelayUrl(MODEL_ROUTED_ID);

/**
 * A CLI's provider id for a Model endpoint (Codex's, SPI-1167; OpenCode's, SPI-1169): derived from the endpoint's id,
 * which never changes, so a session that names it resumes. Prefixed, so no endpoint id can take one of the CLI's
 * built-in provider ids (`openai`, `ollama`, `openrouter`, …) and inherit its catalog entry.
 */
export const endpointProviderId = (endpointId: string): string => `t3flare-endpoint-${endpointId}`;

/** The endpoint id a CLI's provider id names (`endpointProviderId`'s inverse), or undefined for any other provider id. */
export const endpointIdOfProvider = (providerId: string): string | undefined => {
  const prefix = endpointProviderId("");
  return providerId.startsWith(prefix) && providerId.length > prefix.length ? providerId.slice(prefix.length) : undefined;
};

/**
 * What a CLI profile reads of an endpoint it configures for the relay: its id (the route's and the CLI's provider's) and
 * label. A `ModelEndpoint` is one; the narrow type keeps the profiles from reading anything else.
 */
export interface RelayedEndpoint {
  readonly id: string;
  readonly label: string;
}

/**
 * The endpoints the model relay carries: every one but a sign-in's (SPI-1164), whose token the relay does not carry yet
 * (SPI-1171). Every CLI's list of endpoints starts here (Codex, Claude Code, OpenCode), so none lists one it cannot reach.
 */
export const relayedEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> => (endpoints?.endpoints ?? []).filter((endpoint) => !isSignIn(endpoint.auth));

/** The relayed endpoints that speak `api`, in the owner's order: those a CLI that speaks it reaches through the relay. */
export const endpointsOfApi = (endpoints: ModelEndpoints | undefined, api: EndpointApi): ReadonlyArray<ModelEndpoint> =>
  relayedEndpoints(endpoints).filter((endpoint) => endpoint.api === api);

// What each API knows of keys and headers, in one place: the header its key goes in, and the request headers a CLI's
// client sends that the endpoint needs. The relay takes a handle from the key headers and forwards only the allowed
// headers (ADR-0034 §4: the key goes only to its target, headers included; a header-routed gateway must never get a
// host or a route from the Container).

/** The header an API takes its key in, and the value it sends. */
export const credentialHeaderOf = (api: EndpointApi, apiKey: string): { readonly name: string; readonly value: string } => {
  switch (api) {
    case "anthropic-messages":
      return { name: "x-api-key", value: apiKey };
    case "google-generative-ai":
      return { name: "x-goog-api-key", value: apiKey };
    case "openai-responses":
    case "openai-completions":
    case "mistral-conversations":
      return { name: "authorization", value: `Bearer ${apiKey}` };
  }
};

/** Every header a key goes in, for any API (lowercase), plus Azure's `api-key`: where a CLI's handle may come. */
export const KEY_HEADERS: ReadonlyArray<string> = [...new Set([...ENDPOINT_APIS.map((api) => credentialHeaderOf(api, "").name), "api-key"])];

/** Request headers every API's requests may carry: the body's type and length, and what the client accepts. */
const FORWARDED_HEADERS: ReadonlyArray<string> = ["content-type", "content-length", "accept"];

/** The request headers of each API its clients send and the endpoint reads (versions and betas), beside the shared ones. */
const API_HEADERS: Readonly<Record<EndpointApi, ReadonlyArray<string>>> = {
  "anthropic-messages": ["anthropic-version", "anthropic-beta"],
  "openai-responses": ["openai-beta"],
  "openai-completions": ["openai-beta"],
  "google-generative-ai": [],
  "mistral-conversations": [],
};

/** The request headers the relay forwards for `api` (lowercase); every other header of the Container's is dropped. */
export const forwardedHeadersOf = (api: EndpointApi): ReadonlySet<string> => new Set([...FORWARDED_HEADERS, ...API_HEADERS[api]]);

/**
 * What the Environment answers the relay for an endpoint: where to send the request (its base URL) and the headers to
 * add (the endpoint's own, then its credential's), or why not, as an HTTP status. `key` is the credential the headers
 * carry, for the Workspace DO's sync guard and leak check to look for (by hash), never to send anywhere else.
 */
export type ModelRelayTarget =
  | { readonly ok: true; readonly api: EndpointApi; readonly baseUrl: string; readonly headers: Readonly<Record<string, string>>; readonly key: string | null }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** The relay's target for a resolved endpoint and its key (pure; the store's `resolve` gives both). */
export const relayTargetOf = (resolved: { readonly endpoint: ModelEndpoint; readonly apiKey: string | undefined; readonly unreadable: boolean } | undefined, endpointId: string): ModelRelayTarget => {
  if (resolved === undefined) return { ok: false, status: 404, message: `no Model endpoint ${endpointId}: it was removed, or never saved` };
  const { endpoint, apiKey } = resolved;
  if (isSignIn(endpoint.auth)) return { ok: false, status: 501, message: `the Model endpoint ${endpointId} is a sign-in, which the model relay does not carry yet` };
  if (endpoint.auth === "none") return { ok: true, api: endpoint.api, baseUrl: endpoint.baseUrl, headers: { ...endpoint.headers }, key: null };
  if (apiKey === undefined) {
    return {
      ok: false,
      status: 503,
      message: resolved.unreadable
        ? `the Model endpoint ${endpointId}'s API key can no longer be read: enter it again in the Harness panel`
        : `the Model endpoint ${endpointId} has no API key`,
    };
  }
  const credential = credentialHeaderOf(endpoint.api, apiKey);
  // The endpoint's own headers never carry a credential (validateEndpoint), so the key's header is the only one.
  const headers = Object.fromEntries(Object.entries(endpoint.headers).filter(([name]) => name.toLowerCase() !== credential.name));
  return { ok: true, api: endpoint.api, baseUrl: endpoint.baseUrl, headers: { ...headers, [credential.name]: credential.value }, key: apiKey };
};
