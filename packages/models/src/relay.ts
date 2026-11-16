// The model relay (SPI-1167; ADR-0016's model relay refinement): CLI agents reach Model endpoints at
// `http://computer.internal/t3flare/model/<endpointId>/…` in their Container, with a per-process **model handle** as
// their key. The Workers check the handle, swap in the endpoint's own credential and stream the request to the
// endpoint's base URL unchanged. These are the pieces both Workers share: the route, the handle's variable, and what the
// Environment answers for an endpoint (its target with the credential in its header). A CLI adds only its own config.
// SPI-1171: a sign-in's credential is the Credential broker's access token, asked for at each request, as a bearer; which
// CLI takes which sign-in is `RELAYED_SIGN_INS`.
import { ENDPOINT_APIS, type EndpointApi, type EndpointAuth, isSignIn, type ModelEndpoint, type ModelEndpoints, type SignIn, SIGN_INS, signInRequestTarget } from "./endpoints.ts";

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

/** The CLI agents on the model relay. */
export type RelayCli = "codex" | "claude" | "opencode" | "pi";

/**
 * The sign-ins each CLI takes through the relay (SPI-1171), as the ticket's matrix gives them: Codex the ChatGPT sign-in
 * (a Responses provider), Claude Code the Claude sign-in, OpenCode and pi every one. An endpoint with a key or none is
 * every CLI's whose API it speaks.
 */
export const RELAYED_SIGN_INS: Readonly<Record<RelayCli, ReadonlyArray<SignIn>>> = {
  codex: ["chatgpt"],
  claude: ["claude"],
  opencode: SIGN_INS,
  pi: SIGN_INS,
};

/**
 * The endpoints the model relay carries for `cli`: every one with a key or none, and the sign-ins `cli` takes
 * (`RELAYED_SIGN_INS`). Every CLI's list of endpoints starts here, so none lists one it cannot reach.
 */
export const relayedEndpoints = (endpoints: ModelEndpoints | undefined, cli: RelayCli): ReadonlyArray<ModelEndpoint> =>
  (endpoints?.endpoints ?? []).filter((endpoint) => !isSignIn(endpoint.auth) || RELAYED_SIGN_INS[cli].includes(endpoint.auth));

/** The endpoints relayed for `cli` that speak `api`, in the owner's order: those it reaches through the relay. */
export const endpointsOfApi = (endpoints: ModelEndpoints | undefined, api: EndpointApi, cli: RelayCli): ReadonlyArray<ModelEndpoint> =>
  relayedEndpoints(endpoints, cli).filter((endpoint) => endpoint.api === api);

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
 * The header a credential goes in at the relay: an API key in its API's (`credentialHeaderOf`); a sign-in's access token
 * always as a bearer (`authorization`), on every sign-in's API (an Anthropic subscription token is refused as
 * `x-api-key`: SPI-1161 Q4).
 */
export const credentialHeaderFor = (api: EndpointApi, auth: EndpointAuth, credential: string): { readonly name: string; readonly value: string } =>
  isSignIn(auth) ? { name: "authorization", value: `Bearer ${credential}` } : credentialHeaderOf(api, credential);

/** Where the relay sends an endpoint's request: its API, auth, base URL and the headers to add (its credential's among them). */
export interface RelayTarget {
  readonly api: EndpointApi;
  /** The endpoint's auth: a key, none, or a sign-in (SPI-1171), by which its failures are classified (SPI-1172). */
  readonly auth: EndpointAuth;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Why a sign-in gives no token now, as the Credential broker says it (SPI-1164, SPI-1171): signed out (sign in again), or
 * a passing failure, with when its vendor allows the next renewal (`retryAt`) while a back-off holds. Never a token.
 */
export interface SignInRefusal {
  readonly signedOut: boolean;
  readonly problem: string;
  readonly retryAt?: number;
}

/** A sign-in's answer in an Environment with no Credential broker. */
export const NO_CREDENTIAL_BROKER: SignInRefusal = { signedOut: true, problem: "this Environment has no Credential broker" };

/** The relay's status for a sign-in's refusal: 401 signed out (sign in again), 503 a passing failure (retry). */
export const signInRefusalStatus = (refusal: SignInRefusal): 401 | 503 => (refusal.signedOut ? 401 : 503);

/** A sign-in's refusal at the relay, with the endpoint's API (the error's shape) and kind (the text's name). */
export interface RelaySignInRefusal extends SignInRefusal {
  readonly api: EndpointApi;
  readonly kind: SignIn;
}

/**
 * What the Environment answers the relay for an endpoint: where to send the request (its base URL) and the headers to
 * add (the endpoint's own, then its credential's), or why not, as an HTTP status. `key` is the credential the headers
 * carry, for the Workspace DO's sync guard to look for (by hash), never to send anywhere else. A sign-in's refusal says
 * why (`signIn`), and the relay words it for the CLI (the Session's text, naming the sign-in).
 */
export type ModelRelayTarget =
  | (RelayTarget & { readonly ok: true; readonly key: string | null })
  | { readonly ok: false; readonly status: number; readonly message: string; readonly signIn?: RelaySignInRefusal };

/** The Credential broker's answer for a sign-in, as the relay reads it (the Environment's `BrokerAccess`). */
export type RelaySignInAccess =
  | { readonly ok: true; readonly accessToken: string; readonly baseUrl?: string; readonly headers?: Readonly<Record<string, string>> }
  | ({ readonly ok: false } & SignInRefusal);

/** What the store's `resolve` gives the relay: the endpoint with its key, or its sign-in's answer at this request. */
export interface RelayResolved {
  readonly endpoint: ModelEndpoint;
  readonly apiKey: string | undefined;
  readonly unreadable: boolean;
  readonly signIn?: RelaySignInAccess;
}

/**
 * The paths below a sign-in's base URL the relay carries, by kind: its inference calls only, as the CLIs make them
 * (Anthropic Messages, with Claude Code's token count; OpenAI Responses), each a POST. Any other path (an account's
 * `/api/oauth/…`, a key-minting call) is refused before the vendor is asked, so a subscription's token never goes there.
 */
export const SIGN_IN_RELAY_PATHS: Readonly<Record<SignIn, ReadonlyArray<string>>> = {
  chatgpt: ["/responses"],
  claude: ["/v1/messages", "/v1/messages/count_tokens"],
  copilot: ["/responses"],
};

/** Whether the relay carries a `method` request to `path` (below the base URL, no query) on a `kind` sign-in. */
export const signInRelayAllows = (kind: SignIn, method: string, path: string): boolean => method === "POST" && SIGN_IN_RELAY_PATHS[kind].includes(path);

/** A sign-in endpoint's target with the broker's token (`signInRequestTarget`, the Session's rule), or why not. */
const signInRelayTarget = (endpoint: ModelEndpoint, kind: SignIn, access: RelaySignInAccess): ModelRelayTarget => {
  if (!access.ok) {
    const signIn: RelaySignInRefusal = { api: endpoint.api, kind, signedOut: access.signedOut, problem: access.problem, ...(access.retryAt === undefined ? {} : { retryAt: access.retryAt }) };
    return { ok: false, status: signInRefusalStatus(signIn), message: `the Model endpoint ${endpoint.id}'s sign-in gave no token (${access.problem})`, signIn };
  }
  const sent = signInRequestTarget(endpoint, access);
  const credential = credentialHeaderFor(endpoint.api, kind, access.accessToken);
  const headers = Object.fromEntries(Object.entries(sent.headers).filter(([name]) => name.toLowerCase() !== credential.name));
  return { ok: true, api: endpoint.api, auth: kind, baseUrl: sent.baseUrl, headers: { ...headers, [credential.name]: credential.value }, key: access.accessToken };
};

/** The relay's target for a resolved endpoint and its key or sign-in (pure; the store's `resolve` gives them). */
export const relayTargetOf = (resolved: RelayResolved | undefined, endpointId: string): ModelRelayTarget => {
  if (resolved === undefined) return { ok: false, status: 404, message: `no Model endpoint ${endpointId}: it was removed, or never saved` };
  const { endpoint, apiKey } = resolved;
  if (isSignIn(endpoint.auth)) return signInRelayTarget(endpoint, endpoint.auth, resolved.signIn ?? { ok: false, ...NO_CREDENTIAL_BROKER });
  if (endpoint.auth === "none") return { ok: true, api: endpoint.api, auth: "none", baseUrl: endpoint.baseUrl, headers: { ...endpoint.headers }, key: null };
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
  return { ok: true, api: endpoint.api, auth: "api-key", baseUrl: endpoint.baseUrl, headers: { ...headers, [credential.name]: credential.value }, key: apiKey };
};
