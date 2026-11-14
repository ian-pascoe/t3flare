// The model relay (SPI-1167; ADR-0016's model relay refinement): CLI agents reach Model endpoints at
// `http://computer.internal/t3flare/model/<endpointId>/…` in their Container, with a per-process **model handle** as
// their key. The Workers check the handle, swap in the endpoint's own credential and stream the request to the
// endpoint's base URL unchanged. These are the pieces both Workers share: the route, the handle's variable, and what the
// Environment answers for an endpoint (its target with the credential in its header). A CLI adds only its own config.
import type { EndpointApi, ModelEndpoint } from "./endpoints.ts";

/** The relay's path prefix in the Container's egress host. */
export const MODEL_RELAY_PREFIX = "/t3flare/model/";

/** The variable a CLI process reads its model handle from (Codex's provider `env_key`). */
export const MODEL_HANDLE_ENV = "T3FLARE_MODEL_HANDLE";

/** An endpoint's base URL as a CLI in the Container reaches it through the relay. */
export const modelRelayUrl = (endpointId: string): string => `http://computer.internal${MODEL_RELAY_PREFIX}${endpointId}`;

/** A model handle: 32 random bytes, hex (as a tool handle). */
export const MODEL_HANDLE = /^[0-9a-f]{64}$/;

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

/**
 * What the Environment answers the relay for an endpoint: where to send the request (its base URL) and the headers to
 * add (the endpoint's own, then its credential's), or why not, as an HTTP status. `key` is the credential the headers
 * carry, for the Workspace DO's sync guard and leak check to look for (by hash), never to send anywhere else.
 */
export type ModelRelayTarget =
  | { readonly ok: true; readonly baseUrl: string; readonly headers: Readonly<Record<string, string>>; readonly key: string | null }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** The relay's target for a resolved endpoint and its key (pure; the store's `resolve` gives both). */
export const relayTargetOf = (resolved: { readonly endpoint: ModelEndpoint; readonly apiKey: string | undefined; readonly unreadable: boolean } | undefined, endpointId: string): ModelRelayTarget => {
  if (resolved === undefined) return { ok: false, status: 404, message: `no Model endpoint ${endpointId}: it was removed, or never saved` };
  const { endpoint, apiKey } = resolved;
  if (endpoint.auth === "none") return { ok: true, baseUrl: endpoint.baseUrl, headers: { ...endpoint.headers }, key: null };
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
  return { ok: true, baseUrl: endpoint.baseUrl, headers: { ...headers, [credential.name]: credential.value }, key: apiKey };
};
