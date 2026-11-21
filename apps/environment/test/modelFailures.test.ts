// @effect-diagnostics globalDate:off
// SPI-1172: a Model endpoint's failed answer, classified by its endpoint's API and auth (the step-2a2 plan's §3 table
// as the starting point). The answers are doc-shaped, not recorded: each is written in the shape its source documents,
// cited with its read date in packages/models/test/fixtures/vendors.json (made by packages/models/test/fixtures/gen-vendor-fixtures.mjs),
// because no vendor was called with real credentials.
import type { EndpointApi, EndpointAuth } from "@t3flare/models/endpoints";
import { classifyModelFailure, type FailedAnswer, modelFailureMessage, SHORT_RESET_MS } from "@t3flare/models/failures";
import { describe, expect, it } from "vitest";

import fixtures from "../../../packages/models/test/fixtures/vendors.json" with { type: "json" };

const AT = Date.parse(fixtures.now);

type Name = keyof typeof fixtures.answers;

/** A recorded answer as the Session's recording fetch keeps it: the status, the headers and the body, at `AT`. */
const answered = (name: Name): FailedAnswer => {
  const answer = fixtures.answers[name];
  return { status: answer.status, headers: answer.headers as Record<string, string>, body: answer.body, at: AT };
};

const endpointFor = (name: Name, auth?: EndpointAuth) => {
  const answer = fixtures.answers[name] as { readonly api: string; readonly auth?: string };
  return { id: "vendor", api: answer.api as EndpointApi, auth: auth ?? ((answer.auth ?? "api-key") as EndpointAuth) };
};

const classify = (name: Name, auth?: EndpointAuth) => classifyModelFailure(answered(name), endpointFor(name, auth));

describe("classifyModelFailure: Anthropic Messages", () => {
  it("a subscription's unified limit (status rejected): a usage limit at the unified reset, one request", () => {
    expect(classify("anthropicSubscriptionLimit")).toEqual({
      class: "usage_limit",
      code: "usage_limit",
      resetAt: AT + 2 * 3_600_000,
      retryable: true,
      stop: true,
    });
  });

  it("a rate limit resetting within pi-durable's retries (≤ 14 s) is retried in the run; a later one (17 s) pauses until it", () => {
    expect(classify("anthropicRateLimit")).toEqual({ class: "usage_limit", code: "rate_limited", resetAt: AT + 17_000, retryable: true, stop: true });
    expect(classify("anthropicRateLimitLong")).toEqual({ class: "usage_limit", code: "rate_limited", resetAt: AT + 600_000, retryable: true, stop: true });
  });

  it("the short-reset boundary is SHORT_RESET_MS (14 s, pi-durable's retries' span): at 14 s retried, at 15 s paused", () => {
    const at = (seconds: number) => classifyModelFailure({ status: 429, headers: { "retry-after": String(seconds) }, body: "", at: AT }, { id: "x", api: "anthropic-messages", auth: "api-key" })?.stop;
    expect(SHORT_RESET_MS).toBe(14_000);
    expect(at(14)).toBe(false);
    expect(at(15)).toBe(true);
  });

  it("retry-after-ms is read before retry-after", () => {
    const failure = classifyModelFailure({ status: 429, headers: { "retry-after-ms": "90000", "retry-after": "5" }, body: "", at: AT }, { id: "x", api: "anthropic-messages", auth: "api-key" });
    expect(failure).toMatchObject({ resetAt: AT + 90_000, stop: true });
  });

  it("a unified rejection without its reset header pauses until retry-after", () => {
    expect(classify("anthropicSubscriptionLimitNoReset")).toMatchObject({ code: "usage_limit", resetAt: AT + 7_200_000, stop: true });
  });

  it("an owner-set spend limit (400 invalid_request_error, its documented opening): a spend limit; another 400 is not", () => {
    expect(classify("anthropicOwnerSpendLimit")).toMatchObject({ class: "usage_limit", code: "spend_limit", stop: true });
    expect(classify("anthropicOwnerSpendLimit")?.resetAt).toBeUndefined();
  });

  it("a rate limit with no reset: retried by pi-durable, a usage limit with no reset if it never clears", () => {
    expect(classify("anthropicRateLimitBare")).toEqual({ class: "usage_limit", code: "rate_limited", retryable: true, stop: false });
  });

  it("the tier's spend cap (enforced_spend_limit_reached, no retry-after): a usage limit no retry clears, no reset read from its prose", () => {
    expect(classify("anthropicSpendCap")).toEqual({ class: "usage_limit", code: "spend_limit", retryable: false, stop: true });
  });

  it("billing (402): a spend limit", () => {
    expect(classify("anthropicBilling")).toMatchObject({ class: "usage_limit", code: "spend_limit", stop: true });
  });

  it("a refused key (401) and a key without permission (403): permission errors, not retried", () => {
    expect(classify("anthropicKeyRefused")).toEqual({ class: "permission_error", code: "key_refused", retryable: false, stop: true });
    expect(classify("anthropicPermission")).toEqual({ class: "permission_error", code: "key_refused", retryable: false, stop: true });
  });

  it("overload (529) is not a usage limit: a provider error, retried", () => {
    expect(classify("anthropicOverloaded")).toEqual({ class: "provider_error", code: "overloaded", retryable: true, stop: false });
  });

  it("a server error (500): retried", () => {
    expect(classify("anthropicApiError")).toEqual({ class: "provider_error", code: "server_error", retryable: true, stop: false });
  });

  it("an overload inside a stream that began with 200, from pi-ai's text", () => {
    const frame = fixtures.streamed.anthropicOverloaded;
    expect(classifyModelFailure({ status: 200, headers: {}, body: frame.text, at: AT }, { id: "vendor", api: "anthropic-messages", auth: "api-key" })).toMatchObject({
      code: "overloaded",
      stop: false,
    });
  });
});

describe("classifyModelFailure: OpenAI Responses and Completions", () => {
  it("insufficient_quota, credits and spend limits: usage limits no retry clears", () => {
    for (const name of ["openaiInsufficientQuota", "openaiCreditBalance", "openaiProjectSpend"] as const) {
      expect(classify(name), name).toEqual({ class: "usage_limit", code: "spend_limit", retryable: false, stop: true });
    }
  });

  it("a rate limit: retry-after first (20 s: past pi-durable's retries, so it pauses)", () => {
    expect(classify("openaiRateLimit")).toMatchObject({ code: "rate_limited", resetAt: AT + 20_000, stop: true });
  });

  it("a rate limit with only x-ratelimit-reset-* (Go durations): the later of the exhausted ones", () => {
    expect(classify("openaiRateLimitResetHeaders")).toMatchObject({ code: "rate_limited", resetAt: AT + 360_000, stop: true });
    // Only the exhausted window counts: the requests window (1 s) alone at 0 is a short limit, retried.
    const requestsOnly = { status: 429, headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1s", "x-ratelimit-remaining-tokens": "900", "x-ratelimit-reset-tokens": "6m0s" }, body: "", at: AT };
    expect(classifyModelFailure(requestsOnly, { id: "x", api: "openai-responses", auth: "api-key" })).toMatchObject({ resetAt: AT + 1000, stop: false });
  });

  it("with no window at 0 there is no reset to wait for: a short rate limit, retried", () => {
    expect(classify("openaiRateLimitNoneExhausted")).toEqual({ class: "usage_limit", code: "rate_limited", retryable: true, stop: false });
  });

  it("an OpenAI-family 402: a spend limit", () => {
    expect(classify("openaiPaymentRequired")).toMatchObject({ class: "usage_limit", code: "spend_limit", stop: true });
  });

  it("a refused key and a refused region: permission errors", () => {
    expect(classify("openaiKeyRefused")).toMatchObject({ class: "permission_error", code: "key_refused", stop: true });
    expect(classify("openaiRegion")).toMatchObject({ class: "permission_error", code: "key_refused", stop: true });
  });

  it("an overloaded model (503 server_is_overloaded) and a 500: provider errors, retried", () => {
    expect(classify("openaiOverloaded")).toMatchObject({ class: "provider_error", code: "overloaded", stop: false });
    expect(classify("openaiServerError")).toMatchObject({ class: "provider_error", code: "server_error", stop: false });
  });

  it("insufficient_quota inside a stream (response.failed), from pi-ai's `<code>: <message>` text", () => {
    const frame = fixtures.streamed.openaiQuotaFailed;
    expect(classifyModelFailure({ status: 200, headers: {}, body: frame.text, at: AT }, { id: "vendor", api: "openai-responses", auth: "api-key" })).toMatchObject({
      code: "spend_limit",
      stop: true,
    });
  });
});

describe("classifyModelFailure: ChatGPT's usage_limit_reached and plan usage's subscription_sharing_* codes", () => {
  it("usage_limit_reached with resets_at: a usage limit at that reset", () => {
    expect(classify("chatgptUsageLimitReached")).toEqual({ class: "usage_limit", code: "usage_limit", resetAt: AT + 3 * 3_600_000, retryable: true, stop: true });
  });

  it("usage_limit_reached without resets_at: its retry-after", () => {
    expect(classify("chatgptUsageLimitRetryAfter")).toMatchObject({ code: "usage_limit", resetAt: AT + 5_400_000 });
  });

  it("usage_not_included: the plan does not cover it", () => {
    expect(classify("chatgptUsageNotIncluded")).toMatchObject({ class: "permission_error", code: "plan_not_eligible", stop: true });
  });

  it("subscription_sharing_usage_limit_exceeded: a usage limit with no reset (OpenAI: do not infer one from the code)", () => {
    expect(classify("planUsageLimit")).toEqual({ class: "usage_limit", code: "usage_limit", retryable: true, stop: true });
    expect(classify("planUsageWorkspaceLimit")).toMatchObject({ class: "usage_limit", code: "workspace_limit", stop: true });
  });

  it("not eligible, an invalid user, and a refused admission: the sign-in or plan is refused", () => {
    expect(classify("planUsageNotEligible")).toMatchObject({ class: "permission_error", code: "plan_not_eligible", stop: true });
    expect(classify("planUsageInvalidUser")).toMatchObject({ class: "permission_error", code: "sign_in_refused", stop: true });
    expect(classify("planUsageAdmission")).toMatchObject({ class: "permission_error", code: "sign_in_refused", stop: true });
  });

  it("usage unavailable: retried; an unsupported capability: not", () => {
    expect(classify("planUsageUnavailable")).toMatchObject({ class: "provider_error", code: "unavailable", stop: false });
    expect(classify("planUsageUnsupported")).toMatchObject({ class: "provider_error", code: "unsupported_request", retryable: false, stop: true });
  });
});

describe("classifyModelFailure: by auth, and what it leaves alone", () => {
  it("a 401 names what was refused: the key, the sign-in, or no credential at all", () => {
    expect(classify("openaiKeyRefused", "chatgpt")?.code).toBe("sign_in_refused");
    expect(classify("anthropicKeyRefused", "none")?.code).toBe("credential_needed");
  });

  it("a plan-usage code on an API-key endpoint is still read for what it is", () => {
    expect(classify("planUsageLimit", "api-key")?.code).toBe("usage_limit");
  });

  it("an answer that is not a failure it knows: undefined (a 400 the request caused, a 404)", () => {
    expect(classifyModelFailure({ status: 400, headers: {}, body: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}', at: AT }, { id: "x", api: "anthropic-messages", auth: "api-key" })).toBeUndefined();
    expect(classifyModelFailure({ status: 404, headers: {}, body: "not found", at: AT }, { id: "x", api: "openai-completions", auth: "api-key" })).toBeUndefined();
  });

  it("other APIs get the shared rows: a 429 with retry-after, a refused key, a 503", () => {
    const google = { id: "g", api: "google-generative-ai" as const, auth: "api-key" as const };
    expect(classifyModelFailure({ status: 429, headers: { "retry-after": "30" }, body: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', at: AT }, google)).toMatchObject({ code: "rate_limited", resetAt: AT + 30_000 });
    expect(classifyModelFailure({ status: 403, headers: {}, body: '{"error":{"code":403,"status":"PERMISSION_DENIED"}}', at: AT }, google)).toMatchObject({ code: "key_refused" });
    expect(classifyModelFailure({ status: 503, headers: {}, body: "", at: AT }, google)).toMatchObject({ code: "overloaded" });
  });

  it("every transient 5xx is retried; 501 Not Implemented is not", () => {
    const endpoint = { id: "x", api: "anthropic-messages" as const, auth: "api-key" as const };
    for (const status of [500, 502, 504, 507, 520, 521, 524, 529]) expect(classifyModelFailure({ status, headers: {}, body: "", at: AT }, endpoint), String(status)).toMatchObject({ class: "provider_error", retryable: true, stop: false });
    expect(classifyModelFailure({ status: 501, headers: {}, body: "", at: AT }, endpoint)).toMatchObject({ code: "unsupported_request", retryable: false, stop: true });
  });

  it("a retry-after as an HTTP date", () => {
    const at = { status: 429, headers: { "retry-after": new Date(AT + 90_000).toUTCString() }, body: "", at: AT };
    expect(classifyModelFailure(at, { id: "x", api: "mistral-conversations", auth: "api-key" })?.resetAt).toBe(AT + 90_000);
  });
});

describe("modelFailureMessage", () => {
  it("names the endpoint, never repeats the vendor's body", () => {
    const key = classify("openaiKeyRefused")!;
    const message = modelFailureMessage(key, { id: "openai", auth: "api-key" }, 401);
    expect(message).toBe('The Model endpoint "openai" refused its API key (HTTP 401): check it on the Settings page.');
    expect(modelFailureMessage(classify("planUsageLimit")!, { id: "chatgpt", auth: "chatgpt" }, 429)).toContain('The Model endpoint "chatgpt" reached its ChatGPT usage limit');
    expect(modelFailureMessage(classify("anthropicSubscriptionLimit")!, { id: "claude", auth: "api-key" }, 429)).toBe('The Model endpoint "claude" reached its usage limit.');
    for (const name of Object.keys(fixtures.answers) as Array<Name>) {
      const failure = classify(name);
      if (failure === undefined) continue;
      const text = modelFailureMessage(failure, { id: "vendor", auth: endpointFor(name).auth }, fixtures.answers[name].status);
      expect(text, name).toMatch(/^The Model endpoint "vendor"/);
      expect(text, name).not.toContain("sk-proj");
    }
  });
});
