// The Session's view of its Model endpoints' failures (step 2a part 2's design, SPI-1172 per endpoint API; ADR-0034
// §8).
//
// pi-ai drops an error answer's headers, so `recordingFetch` makes each model request and keeps the last answer's status,
// headers, error body and time. The `proxy-limits` extension's `afterResponse` hook (a kept name: a Session installs it under
// that name) runs on every failed response before pi-durable decides whether to retry
// it (pi-durable 1.5.0 `harness/generation.js`: the hook at :596, the retry classification at :627): a failed answer is
// classified once by its endpoint's API and auth (`@t3flare/models/failures`) and recorded on the turn with the
// endpoint's own text, and when no retry can succeed (a limit with a reset, a refused key) pi-durable is left a text no
// retry pattern of pi-ai's matches. One request, no backoff. Every failed answer's text is redacted
// (`@t3flare/models/redact`) before pi-durable keeps it, so no echoed key reaches the turn's detail, the push or t3.
//
// A test fault (`Fault`, stages only) answers in the endpoint's place, in a vendor's shape (`anthropicUsageLimit`,
// `openaiQuota`, …), until its reset, so the limit path runs end to end without exhausting a real account. It counts as
// a request, as the endpoint's answer would.
// @effect-diagnostics globalDate:off
import { GenerationTask, defineExtension, type Extension, hook } from "@earendil-works/pi-durable";
import type { EndpointApi, EndpointAuth } from "@t3flare/models/endpoints";
import { describeFailure, errorBodyOf, type FailedAnswer, failureHeaders, modelFailureDetail } from "@t3flare/models/failures";
import { redactSecrets } from "@t3flare/models/redact";
import type { EndpointFailureRecord, ProxyRecord } from "@t3flare/session-protocol";
import type { AssistantMessage, MutableModels } from "@earendil-works/pi-ai";

/** The last answer an endpoint (or a fault) gave: its status, `retry-after` and when it came. */
export interface RecordedAnswer {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly at: number;
  /** The request's URL: which endpoint answered (SPI-1172). */
  readonly url: string;
  /** The headers the classifier reads (`retry-after*`, Anthropic's unified limit, OpenAI's `x-ratelimit-*`). */
  readonly headers: Readonly<Record<string, string>>;
  /** An error answer's body (status 400 and up), at most `ERROR_BODY_BYTES`. */
  readonly body?: string;
}

/** A test's fault: every model request is answered with `fixture` until `resetAt` (epoch ms). */
export interface Fault {
  readonly fixture: FaultFixture;
  readonly resetAt: number;
}

/** The vendors' shapes a fault answers in, for a Model endpoint of the API (SPI-1172, packages/models/test/fixtures/vendors.json). */
export const FAULT_FIXTURES = [
  "anthropicUsageLimit",
  "anthropicRateLimit",
  "anthropicKeyRefused",
  "openaiUsageLimit",
  "openaiQuota",
  "openaiKeyRefused",
  "planUsageLimit",
] as const;
export type FaultFixture = (typeof FAULT_FIXTURES)[number];

/** A fault to arm, or why not: only where the deployment has `T3FLARE_FAULTS=1` (every stage but prod), a known fixture and a finite reset. */
export const armFault = (faults: string | undefined, input: { readonly fixture: string; readonly resetAt: number }): Fault | Error => {
  if (faults !== "1") return new Error("t3flare: faults are off in this deployment");
  const fixture = FAULT_FIXTURES.find((name) => name === input.fixture);
  if (fixture === undefined || !Number.isFinite(input.resetAt)) return new Error(`t3flare: no fixture ${input.fixture}`);
  return { fixture, resetAt: input.resetAt };
};

const anthropicError = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
const openaiError = (message: string, type: string, code: string) => JSON.stringify({ error: { message, type, param: null, code } });

/**
 * Made-up credentials a refused-key fault echoes in its body, as a careless vendor or gateway might: an Anthropic key, a
 * bearer JWT and an OpenAI project key. None is real; the evidence and the tests look for each and must find none.
 */
export const FAULT_ECHOED_SECRETS = [
  "sk-ant-api03-t3flareFAULTechoNotARealKey0000000000000000000000000000000000000000-AAAA",
  "eyJhbGciOiJIUzI1NiJ9.eyJ0M2ZsYXJlIjoiZmF1bHQtZWNobyJ9.dDNmbGFyZS1mYXVsdC1zaWduYXR1cmU",
  "sk-proj-t3flareFAULTechoNotARealKey000000000000000000000000",
] as const;

/** The vendor's answer for `fault.fixture` (the shapes of packages/models/test/fixtures/vendors.json), reset at its time. */
export const faultAnswer = (fault: Fault, now: number): Response => {
  const seconds = Math.max(1, Math.ceil((fault.resetAt - now) / 1000));
  const json = (status: number, body: string, retryAfter?: number) =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }) },
    });
  switch (fault.fixture) {
    case "anthropicUsageLimit":
      // Anthropic's unified limit, as Claude Code reads it: status rejected, the claim's reset in epoch seconds.
      return new Response(anthropicError("rate_limit_error", "This request would exceed your account's rate limit. Please try again later."), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(Math.ceil(fault.resetAt / 1000)),
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        },
      });
    case "anthropicRateLimit":
      return json(429, anthropicError("rate_limit_error", "This request would exceed your organization's rate limit."), seconds);
    case "anthropicKeyRefused":
      return json(401, anthropicError("authentication_error", `invalid x-api-key: ${FAULT_ECHOED_SECRETS[0]} (Authorization: Bearer ${FAULT_ECHOED_SECRETS[1]})`));
    case "openaiUsageLimit":
      // ChatGPT's Codex backend: `usage_limit_reached` with `resets_at` in epoch seconds.
      return json(429, JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: Math.ceil(fault.resetAt / 1000) } }));
    case "openaiQuota":
      return json(429, openaiError("You exceeded your current quota, please check your plan and billing details.", "insufficient_quota", "insufficient_quota"));
    case "openaiKeyRefused":
      return json(401, openaiError(`Incorrect API key provided: ${FAULT_ECHOED_SECRETS[2]}.`, "invalid_request_error", "invalid_api_key"));
    case "planUsageLimit":
      return json(429, openaiError("You have reached your ChatGPT usage limit.", "invalid_request_error", "subscription_sharing_usage_limit_exceeded"));
  }
};

export interface RecordingFetchOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly fault: () => Fault | undefined;
  readonly clearFault: () => void;
  readonly now: () => number;
  /** Each model request, the fault's answers included (the Session counts them per turn). */
  readonly onRequest: () => void;
}

/** A `fetch` for pi-ai that keeps the last answer's status and `retry-after`, and answers a fault until its reset. */
export const recordingFetch = (options: RecordingFetchOptions) => {
  let last: RecordedAnswer | undefined;
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    last = undefined;
    options.onRequest();
    const fault = options.fault();
    let response: Response;
    if (fault !== undefined && options.now() < fault.resetAt) response = faultAnswer(fault, options.now());
    else {
      if (fault !== undefined) options.clearFault();
      response = await options.fetch(input, init);
    }
    const at = options.now();
    const url = input instanceof Request ? input.url : String(input);
    // An error answer's body, from a copy, so pi-ai still reads the answer whole.
    const body = response.status >= 400 ? await errorBodyOf(response) : undefined;
    last = { status: response.status, retryAfter: response.headers.get("retry-after"), at, url, headers: failureHeaders(response.headers), ...(body === undefined ? {} : { body }) };
    return response;
  }) as typeof globalThis.fetch;
  return { fetch: recording, last: () => last };
};

/** What the classifier needs of a Model endpoint: its API and auth, and its base URL (which answers are its). */
export interface ClassifiedEndpoint {
  readonly id: string;
  readonly api: EndpointApi;
  readonly auth: EndpointAuth;
  readonly baseUrl: string;
}

export interface ModelLimitsOptions {
  /** The answer of the request that ended in this response. */
  readonly last: () => RecordedAnswer | undefined;
  /** The Model endpoint a message's provider names; undefined for one no longer installed. */
  readonly endpoint: (provider: string) => ClassifiedEndpoint | undefined;
  /**
   * The running turn's last failed answer, classified, or undefined for one the classifier does not know (or no
   * endpoint's): every failed answer replaces the record, so the last answer is always the turn's.
   */
  readonly recordEndpoint: (failure: EndpointFailureRecord | undefined) => void;
  /** The credentials the Session holds for a provider (its key or token), redacted from its error text whatever their shape. */
  readonly secrets: (provider: string) => ReadonlyArray<string>;
}

/** What `sessionLimits` takes of the Session: the recording fetch, its record of the running turn, its endpoints. */
export interface SessionLimitsDeps {
  readonly last: () => RecordedAnswer | undefined;
  /** Changes the running turn's record (`SessionDO.#noteProxy`). */
  readonly note: (update: (record: ProxyRecord) => ProxyRecord) => void;
  readonly endpoints: { endpoint(id: string): ClassifiedEndpoint | undefined; secrets(id: string): ReadonlyArray<string> };
}

/**
 * The Session's `ModelLimitsOptions` (SPI-1172): every failed answer replaces the turn's record (undefined clears it),
 * so the last answer is always the turn's; a provider's credential is what the Session holds for the endpoint.
 */
export const sessionLimits = (deps: SessionLimitsDeps): ModelLimitsOptions => ({
  last: deps.last,
  endpoint: (provider) => deps.endpoints.endpoint(provider),
  recordEndpoint: (endpointFailure) => deps.note(({ endpointFailure: _before, ...record }) => (endpointFailure === undefined ? record : { ...record, endpointFailure })),
  secrets: (provider) => deps.endpoints.secrets(provider),
});

/**
 * An endpoint's failed response (SPI-1172), classified by its API and auth from the recorded answer when the request
 * was the endpoint's: the message's provider is the endpoint and the answer's URL is under its base URL (an API whose
 * pi-ai client takes no fetch leaves none: its text alone is read, as a stream's is). The record is replaced either way;
 * a classified failure's text becomes its code, worded so pi-durable stops or retries it as the table says.
 */
const classifyEndpoint = (message: AssistantMessage, errorMessage: string, endpoint: ClassifiedEndpoint, options: ModelLimitsOptions): void => {
  const recorded = options.last();
  const answer = recorded !== undefined && recorded.url.startsWith(endpoint.baseUrl) ? recorded : undefined;
  const failed: FailedAnswer =
    answer !== undefined && answer.status >= 400
      ? { status: answer.status, headers: answer.headers, body: answer.body ?? errorMessage, at: answer.at }
      : { status: 200, headers: answer?.headers ?? {}, body: errorMessage, at: answer?.at ?? Date.now() };
  const failure = describeFailure(failed, endpoint);
  options.recordEndpoint(failure === undefined ? undefined : { ...failure, endpointId: endpoint.id, at: failed.at });
  if (failure !== undefined) message.errorMessage = modelFailureDetail(failure);
};

/** Classify a failed response once, record it (or clear the record), and leave pi-durable a text it stops or retries on. */
const classifyOnce = (message: AssistantMessage, options: ModelLimitsOptions): void => {
  if (message.stopReason !== "error" || message.errorMessage === undefined) return;
  // No echoed credential reaches pi-durable's record of the answer, the turn's detail, the push or t3 (SPI-1172).
  message.errorMessage = redactSecrets(message.errorMessage, options.secrets(message.provider));
  const endpoint = options.endpoint(message.provider);
  // A provider that is no installed endpoint's (one removed mid-turn) has nothing to classify by: the record clears.
  if (endpoint === undefined) return options.recordEndpoint(undefined);
  classifyEndpoint(message, message.errorMessage, endpoint, options);
};

/**
 * The `afterResponse` hook: `classifyOnce` on each generation's response, before pi-durable decides to retry it. The
 * Session installs it as `proxy-limits`, a kept name.
 */
export const modelLimits = (options: ModelLimitsOptions): Extension =>
  defineExtension({
    name: "proxy-limits",
    hooks: [hook(GenerationTask, { afterResponse: (message) => classifyOnce(message, options) })],
  });

/**
 * `models` with `classifyOnce` on every `completeSimple` answer. pi-durable's compaction summarizes with
 * `completeSimple` and runs no `afterResponse` hook (1.5.0 `harness/compaction.js`: the request at :133, the retry
 * classification right after it), so this is where its answer is classified, before that retry decision. Generation
 * streams with `streamSimple` and keeps the hook, so no answer is classified twice.
 */
export const compactionLimits = (models: MutableModels, options: ModelLimitsOptions): MutableModels => {
  const completeSimple = models.completeSimple.bind(models);
  models.completeSimple = async (...args) => {
    const message = await completeSimple(...args);
    classifyOnce(message, options);
    return message;
  };
  return models;
};
