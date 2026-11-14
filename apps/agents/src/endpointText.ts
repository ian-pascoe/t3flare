// @effect-diagnostics globalFetch:off asyncFunction:off globalDate:off
// Text generation on a Model endpoint's model (SPI-1163): thread titles, commit messages and PR text, as one pi-ai request
// with no tools. The Environment DO calls it over the `EndpointTextGeneration` entrypoint (`worker.ts`), so the
// Environment's bundle never holds pi-ai. The endpoint's provider is a Session's own (`endpointProviders`): its key is
// asked of the Environment at use time for the endpoint's target and kept nowhere, its headers go with the request, and an
// endpoint with no auth sends the placeholder key. A failure names the endpoint and says what happened by the answer's
// status alone: a vendor's body (which can echo request details) and the key never reach the message.
import { createModels, type FetchFunction } from "@earendil-works/pi-ai";
import { type EndpointCredential, type EndpointTarget, type EndpointTextAnswer, type EndpointTextRequest } from "@t3flare/models/endpoints";

import { credentialProblem, endpointProviders } from "./session/models.ts";

/** How long the one request may take, inside the Environment's own bound. */
export const ENDPOINT_TEXT_TIMEOUT_MS = 110_000;
/** Enough for a title or a PR body, and for a reasoning model's thinking before it; never above the model's own limit. */
const MAX_TOKENS = 8_192;

export interface EndpointTextAccess {
  /** The endpoint's key for its target, from the Environment (`endpointCredential`), as a Session asks for it. */
  readonly credential: (endpointId: string, target: EndpointTarget) => Promise<EndpointCredential>;
  /**
   * The request's fetch (tests); the global one otherwise. Its answer's status names the failure, for the APIs whose pi-ai
   * implementation takes a fetch (Anthropic Messages, OpenAI Responses and Completions); the others' failures say less.
   */
  readonly fetch?: FetchFunction;
  readonly timeoutMs?: number;
}

/** The failure's text by the endpoint's answer status: never its body. */
const statusProblem = (endpointId: string, modelId: string, status: number): string => {
  const named = `The Model endpoint "${endpointId}"`;
  if (status === 401 || status === 403) return `${named} refused its API key (HTTP ${status}): check it in the Harness panel.`;
  if (status === 404) return `${named} does not serve the model ${modelId} (HTTP 404).`;
  if (status === 429) return `${named} is rate- or usage-limited (HTTP 429): try again later.`;
  if (status >= 400 && status < 500) return `${named} refused the request (HTTP ${status}).`;
  if (status >= 500) return `${named} failed (HTTP ${status}).`;
  return `${named} failed while answering.`;
};

export const generateEndpointText = async (request: EndpointTextRequest, access: EndpointTextAccess): Promise<EndpointTextAnswer> => {
  const { endpoint, modelId } = request;
  const named = `The Model endpoint "${endpoint.id}"`;
  // What the request saw, for the failure's text: the refusal of a key, the answer's status, or no answer at all.
  let refused: EndpointCredential | undefined;
  let status: number | undefined;
  let unreachable = false;
  const base = access.fetch ?? globalThis.fetch;
  const fetch: FetchFunction = async (input, init) => {
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      unreachable = true;
      throw error;
    }
    status = response.status;
    return response;
  };
  const credential = async (endpointId: string, target: EndpointTarget): Promise<EndpointCredential> => {
    const answer = await access.credential(endpointId, target);
    if (answer.apiKey === null) refused = answer;
    return answer;
  };
  const models = createModels();
  for (const provider of endpointProviders({ revision: 0, endpoints: [endpoint] }, { credential, fetch })) models.setProvider(provider);
  const model = models.getModel(endpoint.id, modelId);
  if (model === undefined) return { ok: false, error: `${named} does not list the model ${modelId}.` };
  const failure = (): EndpointTextAnswer => {
    if (refused !== undefined) {
      // The Environment gave the endpoint as it is now, so a changed target is a save that landed meanwhile.
      return {
        ok: false,
        error: refused.changed === true ? `${named} changed or was removed while the text was being generated: try again.` : credentialProblem(endpoint.id, refused),
      };
    }
    if (status !== undefined) return { ok: false, error: statusProblem(endpoint.id, modelId, status) };
    if (unreachable) return { ok: false, error: `${named} could not be reached.` };
    return { ok: false, error: `${named} did not answer.` };
  };
  const now = Date.now();
  let message;
  try {
    message = await models.completeSimple(
      model,
      { messages: [{ role: "user", content: `${request.prompt}\n\nAnswer with the JSON object only.`, timestamp: now }] },
      {
        maxTokens: Math.min(model.maxTokens, MAX_TOKENS),
        signal: AbortSignal.timeout(access.timeoutMs ?? ENDPOINT_TEXT_TIMEOUT_MS),
      },
    );
  } catch {
    return failure();
  }
  if (message.stopReason === "aborted") return { ok: false, error: `${named} did not answer in time.` };
  if (message.stopReason === "error" || (status !== undefined && status >= 400)) return failure();
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (text === "") return { ok: false, error: `${named}'s model ${modelId} returned no text.` };
  return { ok: true, text };
};
