// The Session's view of the model proxy's failures (step 2a part 2; ADR-0012; docs/model-proxy.md → Usage limits).
//
// pi-ai drops an error answer's headers, so `recordingFetch` makes each model request and keeps the last answer's status,
// `retry-after` and time. The `proxy-limits` extension's `afterResponse` hook runs on every failed response before
// pi-durable decides whether to retry it (pi-durable 1.5.0 `harness/generation.js`: the hook at :596, the retry
// classification at :627): it classifies the failure once, with that answer, records it, and when no retry can succeed
// (a limit with a reset, a refused key) leaves pi-durable a text no retry pattern of pi-ai's matches. One request, no
// backoff; the record carries the class, the code and the reset to the differ.
//
// A test fault (`Fault`, stages only) answers in the proxy's place until its reset, so the limit path runs end to end
// without exhausting real accounts. It counts as a request, as the proxy's answer would.
//
// SPI-1172: a Model endpoint's failed answer is classified by the endpoint's API and auth (`@t3flare/models/failures`),
// from the status, the headers and the error body the recording fetch keeps (pi-ai keeps none of the headers, and only
// some of the body), and recorded with the endpoint's own text; the proxy's `anthropic` keeps its own classifier until
// the hard cut (SPI-1176). Every failed answer's text is redacted (`@t3flare/models/redact`) before pi-durable keeps it,
// so no echoed key reaches the turn's detail, the push or t3. The fault route also answers in each API's vendor shapes
// (`anthropicUsageLimit`, `openaiQuota`, …), the endpoint's own fetch never called.
// @effect-diagnostics globalDate:off
import { GenerationTask, defineExtension, type Extension, hook } from "@earendil-works/pi-durable";
import type { EndpointApi, EndpointAuth } from "@t3flare/models/endpoints";
import { describeFailure, errorBodyOf, type FailedAnswer, failureHeaders, modelFailureDetail } from "@t3flare/models/failures";
import { classifyProxyFailure, proxyFailureDetail } from "@t3flare/models/proxyFailure";
import { redactSecrets } from "@t3flare/models/redact";
import type { EndpointFailureRecord, ProxyFailureRecord } from "@t3flare/session-protocol";
import type { AssistantMessage, MutableModels } from "@earendil-works/pi-ai";

/** The last answer the proxy, an endpoint (or a fault) gave: its status, `retry-after` and when it came. */
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

export const FAULT_FIXTURES = [
  // Commissary's shapes (step 2a part 2), for the proxy.
  "cooldown",
  "spendLimit",
  "invalidKey",
  "overloaded",
  "accountUnavailable",
  // SPI-1172: vendors' shapes, for a Model endpoint of the API (packages/models/test/fixtures/vendors.json).
  "anthropicUsageLimit",
  "anthropicRateLimit",
  "anthropicKeyRefused",
  "openaiUsageLimit",
  "openaiQuota",
  "openaiKeyRefused",
  "planUsageLimit",
] as const;
export type FaultFixture = (typeof FAULT_FIXTURES)[number];

/** A Go duration of whole seconds, as Commissary's hint writes it (`2m0s`, `1h2m3s`). */
const goDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`;
};

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

/** The answer Commissary gives for `fault.fixture` (the shapes of packages/models/test/fixtures/proxy.json), reset at its time. */
export const faultAnswer = (fault: Fault, now: number, model: string): Response => {
  const seconds = Math.max(1, Math.ceil((fault.resetAt - now) / 1000));
  const json = (status: number, body: string, retryAfter?: number) =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }) },
    });
  switch (fault.fixture) {
    case "cooldown":
      return json(429, anthropicError("rate_limit_error", `All credentials for model ${model} are cooling down via provider claude (reset after ${goDuration(seconds)})`), seconds);
    case "spendLimit":
      return json(
        429,
        anthropicError("rate_limit_error", `The daily Spend limit of this API key is reached; it resets at ${new Date(fault.resetAt).toISOString()}`),
        seconds,
      );
    case "invalidKey":
      return json(401, JSON.stringify({ error: "Invalid API key" }));
    case "overloaded":
      return json(529, anthropicError("overloaded_error", "Overloaded"));
    case "accountUnavailable":
      return json(503, anthropicError("api_error", "no auth available"), seconds);
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

/** The model a request body names, for a fault's message. */
const modelOf = (init: RequestInit | undefined): string => {
  if (typeof init?.body !== "string") return "requested model";
  try {
    const model = (JSON.parse(init.body) as { model?: unknown }).model;
    return typeof model === "string" ? model : "requested model";
  } catch {
    return "requested model";
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
    if (fault !== undefined && options.now() < fault.resetAt) response = faultAnswer(fault, options.now(), modelOf(init));
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

export interface ProxyLimitsOptions {
  /** The answer of the request that ended in this response. */
  readonly last: () => RecordedAnswer | undefined;
  /**
   * The running turn's last failed answer from the proxy, classified, or undefined for one the classifier does not
   * know: every failed answer replaces the record (and clears an endpoint's), so the last answer is always the turn's.
   */
  readonly record: (failure: ProxyFailureRecord | undefined) => void;
  /** SPI-1172: the Model endpoint a message's provider names; undefined for the proxy's `anthropic`. */
  readonly endpoint?: (provider: string) => ClassifiedEndpoint | undefined;
  /** SPI-1172: the same for an endpoint's failed answer (and it clears the proxy's). */
  readonly recordEndpoint?: (failure: EndpointFailureRecord | undefined) => void;
  /** SPI-1172: the credentials the Session holds for a provider (its key or token), redacted from its error text whatever their shape. */
  readonly secrets?: (provider: string) => ReadonlyArray<string>;
}

/**
 * An endpoint's failed response (SPI-1172), classified by its API and auth from the recorded answer when the request
 * was the endpoint's: the message's provider is the endpoint and the answer's URL is under its base URL (an API whose
 * pi-ai client takes no fetch leaves none: its text alone is read, as a stream's is). The record is replaced either way;
 * a classified failure's text becomes its code, worded so pi-durable stops or retries it as the table says.
 */
const classifyEndpoint = (message: AssistantMessage, errorMessage: string, endpoint: ClassifiedEndpoint, options: ProxyLimitsOptions): void => {
  const recorded = options.last();
  const answer = recorded !== undefined && recorded.url.startsWith(endpoint.baseUrl) ? recorded : undefined;
  const failed: FailedAnswer =
    answer !== undefined && answer.status >= 400
      ? { status: answer.status, headers: answer.headers, body: answer.body ?? errorMessage, at: answer.at }
      : { status: 200, headers: answer?.headers ?? {}, body: errorMessage, at: answer?.at ?? Date.now() };
  const failure = describeFailure(failed, endpoint);
  options.recordEndpoint?.(failure === undefined ? undefined : { ...failure, endpointId: endpoint.id, at: failed.at });
  if (failure !== undefined) message.errorMessage = modelFailureDetail(failure);
};

/** Classify a failed response once, record it (or clear the record), and leave pi-durable a text it stops or retries on. */
const classifyOnce = (message: AssistantMessage, options: ProxyLimitsOptions): void => {
  if (message.stopReason !== "error" || message.errorMessage === undefined) return;
  // No echoed credential reaches pi-durable's record of the answer, the turn's detail, the push or t3 (SPI-1172).
  message.errorMessage = redactSecrets(message.errorMessage, options.secrets?.(message.provider) ?? []);
  const endpoint = options.endpoint?.(message.provider);
  if (endpoint !== undefined) return classifyEndpoint(message, message.errorMessage, endpoint, options);
  const answer = options.last() ?? { status: 200, retryAfter: null, at: Date.now() };
  const failure = classifyProxyFailure({ ...answer, text: message.errorMessage });
  options.record(failure === undefined ? undefined : { ...failure, at: answer.at });
  if (failure?.stop === true) message.errorMessage = proxyFailureDetail(failure);
};

/** The `afterResponse` hook: `classifyOnce` on each generation's response, before pi-durable decides to retry it. */
export const proxyLimits = (options: ProxyLimitsOptions): Extension =>
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
export const compactionLimits = (models: MutableModels, options: ProxyLimitsOptions): MutableModels => {
  const completeSimple = models.completeSimple.bind(models);
  models.completeSimple = async (...args) => {
    const message = await completeSimple(...args);
    classifyOnce(message, options);
    return message;
  };
  return models;
};
