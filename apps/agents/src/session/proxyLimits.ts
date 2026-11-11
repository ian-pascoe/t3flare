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
// @effect-diagnostics globalDate:off
import { GenerationTask, defineExtension, type Extension, hook } from "@earendil-works/pi-durable";
import { classifyProxyFailure, proxyFailureDetail } from "@t3flare/models/proxyFailure";
import type { ProxyFailureRecord } from "@t3flare/session-protocol";

/** The last answer the proxy (or a fault) gave: its status, `retry-after` and when it came. */
export interface RecordedAnswer {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly at: number;
}

/** A test's fault: every model request is answered with `fixture` until `resetAt` (epoch ms). */
export interface Fault {
  readonly fixture: FaultFixture;
  readonly resetAt: number;
}

export const FAULT_FIXTURES = ["cooldown", "spendLimit", "invalidKey", "overloaded", "accountUnavailable"] as const;
export type FaultFixture = (typeof FAULT_FIXTURES)[number];

/** A Go duration of whole seconds, as Commissary's hint writes it (`2m0s`, `1h2m3s`). */
const goDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`;
};

const anthropicError = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

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
    last = { status: response.status, retryAfter: response.headers.get("retry-after"), at: options.now() };
    return response;
  }) as typeof globalThis.fetch;
  return { fetch: recording, last: () => last };
};

export interface ProxyLimitsOptions {
  /** The answer of the request that ended in this response. */
  readonly last: () => RecordedAnswer | undefined;
  /** The classified failure, for the running turn. */
  readonly record: (failure: ProxyFailureRecord) => void;
}

/** The `afterResponse` hook: classify a failed response once, record it, and stop retries that cannot succeed. */
export const proxyLimits = (options: ProxyLimitsOptions): Extension =>
  defineExtension({
    name: "proxy-limits",
    hooks: [
      hook(GenerationTask, {
        afterResponse: (message) => {
          if (message.stopReason !== "error" || message.errorMessage === undefined) return;
          const answer = options.last() ?? { status: 200, retryAfter: null, at: Date.now() };
          const failure = classifyProxyFailure({ ...answer, text: message.errorMessage });
          if (failure === undefined) return;
          options.record({ ...failure, at: answer.at });
          if (failure.stop) message.errorMessage = proxyFailureDetail(failure);
        },
      }),
    ],
  });
