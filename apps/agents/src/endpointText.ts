// @effect-diagnostics globalFetch:off asyncFunction:off globalDate:off
// Text generation on a Model endpoint's model (SPI-1163): thread titles, commit messages and PR text, as one pi-ai request
// with no tools. The Environment DO calls it over the `EndpointTextGeneration` entrypoint (`worker.ts`) with ids only,
// so the Environment's bundle never holds pi-ai and no caller-supplied endpoint exists here: the endpoint is read from the
// Environment (`modelEndpoints`) and its provider is a Session's own (`endpointProviders`), whose key is asked of the
// Environment at use time for the endpoint's target and kept nowhere. A failure names the endpoint and says what happened
// by the answer's status alone: a vendor's body (which can echo request details) and the key never reach the message.
import { createModels, type FetchFunction } from "@earendil-works/pi-ai";
import {
  type EndpointCredential,
  type EndpointTarget,
  type EndpointTextAnswer,
  type EndpointTextRequest,
  endpointLabel,
  isRecord,
  jsonOnlyPrompt,
  type ModelEndpoint,
  type ModelEndpoints,
} from "@t3flare/models/endpoints";

import { credentialProblem, endpointProviders } from "./session/models.ts";

/** How long the one request may take, inside the Environment's own bound (120 s). */
const TIMEOUT_MS = 110_000;
/** Enough for a title or a PR body, and for a reasoning model's thinking before it; never above the model's own limit. */
const MAX_TEXT_TOKENS = 8_192;

export interface EndpointTextAccess {
  /** The Environment's endpoints now (`modelEndpoints`), secret-free. */
  readonly endpoints: () => Promise<ModelEndpoints>;
  /** The endpoint's key for its target, from the Environment (`endpointCredential`), as a Session asks for it. */
  readonly credential: (endpointId: string, target: EndpointTarget) => Promise<EndpointCredential>;
  /**
   * The request's fetch (tests); the global one otherwise. Its answer's status names the failure, for the APIs whose pi-ai
   * implementation takes a fetch (Anthropic Messages, OpenAI Responses and Completions); Mistral's reports its status
   * through `onResponse`; Google's reports none, so its failures say only that the endpoint failed.
   */
  readonly fetch?: FetchFunction;
  /** The request's bound, shorter in tests. */
  readonly timeoutMs?: number;
}

/** The request as the binding hands it: three strings, else undefined. */
export const endpointTextRequestOf = (value: unknown): EndpointTextRequest | undefined =>
  isRecord(value) && typeof value.endpointId === "string" && typeof value.modelId === "string" && typeof value.prompt === "string"
    ? { endpointId: value.endpointId, modelId: value.modelId, prompt: value.prompt }
    : undefined;

/** What the request saw: a refused key, the answer's status, or no answer at all. */
interface Observed {
  refused?: EndpointCredential;
  status?: number;
  unreachable: boolean;
}

/** The failure's text by the endpoint's answer status: never its body. */
const statusProblem = (endpoint: ModelEndpoint, modelId: string, status: number): string => {
  const named = endpointLabel(endpoint.id);
  if (status === 401 || status === 403) {
    return endpoint.auth === "none"
      ? `${named} refused the request without a credential (HTTP ${status}): check its auth in the Harness panel.`
      : `${named} refused its API key (HTTP ${status}): check it in the Harness panel.`;
  }
  if (status === 404) return `${named} does not serve the model ${modelId} (HTTP 404).`;
  if (status === 429) return `${named} is rate- or usage-limited (HTTP 429): try again later.`;
  if (status >= 400 && status < 500) return `${named} refused the request (HTTP ${status}).`;
  if (status >= 500) return `${named} failed (HTTP ${status}).`;
  return `${named} failed while answering.`;
};

const failureOf = (endpoint: ModelEndpoint, modelId: string, observed: Observed): EndpointTextAnswer => {
  const named = endpointLabel(endpoint.id);
  if (observed.refused !== undefined) {
    // The endpoint was read from the Environment just now, so a changed target is a save that landed meanwhile.
    return {
      ok: false,
      error: observed.refused.changed === true ? `${named} changed or was removed while the text was being generated: try again.` : credentialProblem(endpoint.id, observed.refused),
    };
  }
  if (observed.status !== undefined) return { ok: false, error: statusProblem(endpoint, modelId, observed.status) };
  if (observed.unreachable) return { ok: false, error: `${named} could not be reached.` };
  // An error with no status this code can read (Google's adapter reports none): the endpoint failed, how is not known.
  return { ok: false, error: `${named} failed (its API reports no status here).` };
};

export const generateEndpointText = async (input: unknown, access: EndpointTextAccess): Promise<EndpointTextAnswer> => {
  const request = endpointTextRequestOf(input);
  if (request === undefined) return { ok: false, error: "The text generation request was malformed: it names no Model endpoint, model and prompt." };
  const { endpointId, modelId } = request;
  const named = endpointLabel(endpointId);
  let endpoints: ModelEndpoints;
  try {
    endpoints = await access.endpoints();
  } catch {
    return { ok: false, error: `${named} could not be read from the Environment: try again.` };
  }
  const endpoint = endpoints.endpoints.find((entry) => entry.id === endpointId);
  if (endpoint === undefined) return { ok: false, error: `${named} was removed: pick another model for text generation.` };
  const observed: Observed = { unreachable: false };
  const base = access.fetch ?? globalThis.fetch;
  const fetch: FetchFunction = async (url, init) => {
    let response: Response;
    try {
      response = await base(url, init);
    } catch (error) {
      observed.unreachable = true;
      throw error;
    }
    observed.status = response.status;
    return response;
  };
  const credential = async (id: string, target: EndpointTarget): Promise<EndpointCredential> => {
    const answer = await access.credential(id, target);
    if (answer.apiKey === null) observed.refused = answer;
    return answer;
  };
  const models = createModels();
  for (const provider of endpointProviders({ revision: endpoints.revision, endpoints: [endpoint] }, { credential, fetch })) models.setProvider(provider);
  const model = models.getModel(endpoint.id, modelId);
  if (model === undefined) return { ok: false, error: `${named} does not list the model ${modelId}.` };
  const signal = AbortSignal.timeout(access.timeoutMs ?? TIMEOUT_MS);
  const timedOut = { ok: false, error: `${named} did not answer in time.` } as const;
  let message;
  try {
    message = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: jsonOnlyPrompt(request.prompt), timestamp: Date.now() }] },
      {
        maxTokens: Math.min(model.maxTokens, MAX_TEXT_TOKENS),
        signal,
        // Mistral's adapter reports its status here (it takes no fetch from a Session); the others through `fetch`.
        onResponse: (response) => {
          observed.status = response.status;
        },
      },
    );
  } catch {
    return signal.aborted ? timedOut : failureOf(endpoint, modelId, observed);
  }
  if (message.stopReason === "aborted" || signal.aborted) return timedOut;
  if (message.stopReason === "error" || (observed.status !== undefined && observed.status >= 400)) return failureOf(endpoint, modelId, observed);
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (text === "") return { ok: false, error: `${named}'s model ${modelId} returned no text.` };
  return { ok: true, text };
};
