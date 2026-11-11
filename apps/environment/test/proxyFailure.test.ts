// The model proxy's failure answers, classified (step 2a part 2 plan, section 3): each fixture is what Commissary's own
// code answers (packages/models/test/fixtures/proxy.json, made by docs/steps/step-2a-part2/gen-proxy-fixtures.ts), as
// pi-ai reports it (`<status> <body>`, or the body alone for an error inside a stream), with the status and
// `retry-after` the Session's recording fetch saw.
import { classifyProxyFailure, proxyFailureMessage } from "@t3flare/models/proxyFailure";
import { describe, expect, it } from "vitest";

import fixtures from "../../../packages/models/test/fixtures/proxy.json" with { type: "json" };

const AT = Date.parse("2026-11-12T10:00:00.000Z");

type Name = keyof typeof fixtures.answers;

/** A fixture as the Session sees it: pi-ai's errorMessage, and the recorded status and `retry-after`. */
const answered = (name: Name, at = AT) => {
  const answer = fixtures.answers[name];
  const headers = answer.headers as Record<string, string>;
  return { status: answer.status, retryAfter: headers["retry-after"] ?? null, text: `${answer.status} ${answer.body}`, at };
};

/** An error inside a stream that began with 200: no status, no header, the frame's body as pi-ai reports it. */
const streamed = (name: keyof typeof fixtures.streamed, at = AT) => {
  const frame = fixtures.streamed[name];
  return { status: 200, retryAfter: null, text: frame.slice(frame.indexOf("data: ") + 6).trim(), at };
};

describe("classifyProxyFailure", () => {
  it("all accounts cooling down: a usage limit whose reset is the recorded retry-after", () => {
    expect(classifyProxyFailure(answered("cooldown"))).toEqual({
      class: "usage_limit",
      code: "proxy_cooldown",
      row: 1,
      resetAt: AT + 7384_000,
      stop: true,
    });
  });

  it("reads the retry-after header before the message's rounded hint", () => {
    // The header said 100 s and the hint 2m0s: the header wins (Commissary may also pass an upstream's own headers).
    expect(classifyProxyFailure({ ...answered("cooldownShort"), retryAfter: "100" })?.resetAt).toBe(AT + 100_000);
  });

  it("inside a stream (no status, no header): the cooling-down body, reset from its Go-duration hint", () => {
    expect(classifyProxyFailure(streamed("cooldown"))).toEqual({
      class: "usage_limit",
      code: "proxy_cooldown",
      row: 10,
      resetAt: AT + (2 * 3600 + 3 * 60 + 4) * 1000,
      stop: true,
    });
  });

  it("a spend limit: reset at the time its message names, whatever the header", () => {
    expect(classifyProxyFailure({ ...answered("spendLimit"), retryAfter: "5" })).toEqual({
      class: "usage_limit",
      code: "proxy_spend_limit",
      row: 3,
      resetAt: Date.parse("2026-11-13T00:00:00.000Z"),
      stop: true,
    });
  });

  it("Commissary Cloud's request rate: reset after its retry-after", () => {
    expect(classifyProxyFailure(answered("requestRate"))).toEqual({ class: "usage_limit", code: "proxy_request_rate", row: 4, resetAt: AT + 60_000, stop: true });
  });

  it("an upstream's own 429: a reset only with a retry-after, and retried without one (the next answer is the cooldown)", () => {
    expect(classifyProxyFailure(answered("upstreamLimitWithRetryAfter"))).toEqual({
      class: "usage_limit",
      code: "proxy_upstream_limit",
      row: 2,
      resetAt: AT + 5400_000,
      stop: true,
    });
    expect(classifyProxyFailure(answered("upstreamLimit"))).toEqual({ class: "usage_limit", code: "proxy_upstream_limit", row: 2, stop: false });
    expect(classifyProxyFailure(streamed("upstreamLimit"))).toEqual({ class: "usage_limit", code: "proxy_upstream_limit", row: 10, stop: false });
  });

  it("503 no auth available: a usage limit when it says when an account recovers, else no usable account", () => {
    expect(classifyProxyFailure(answered("accountUnavailable"))).toEqual({
      class: "usage_limit",
      code: "proxy_account_unavailable",
      row: 8,
      resetAt: AT + 90_000,
      stop: true,
    });
    expect(classifyProxyFailure(answered("noAccount"))).toEqual({ class: "provider_error", code: "proxy_no_account", row: 8, stop: true });
    expect(classifyProxyFailure(answered("noAccountAtAll"))).toEqual({ class: "provider_error", code: "proxy_no_account", row: 8, stop: true });
  });

  it("the proxy refused the key (401, 403 in its own flat shape): a permission error, never retried", () => {
    for (const name of ["invalidKey", "missingKey", "forbidden"] as const) {
      expect(classifyProxyFailure(answered(name)), name).toEqual({ class: "permission_error", code: "proxy_key_rejected", row: 5, stop: true });
    }
  });

  it("an upstream account was refused (401/403 in Anthropic's shape): a permission error that names the proxy's account", () => {
    expect(classifyProxyFailure(answered("accountRejected"))).toEqual({ class: "permission_error", code: "proxy_account_rejected", row: 7, stop: true });
  });

  it("overload and upstream 5xx: provider errors pi-durable retries", () => {
    expect(classifyProxyFailure(answered("overloaded"))).toEqual({ class: "provider_error", code: "proxy_overloaded", row: 9, stop: false });
    expect(classifyProxyFailure(streamed("overloaded"))).toEqual({ class: "provider_error", code: "proxy_overloaded", row: 10, stop: false });
    expect(classifyProxyFailure(answered("serverError"))).toEqual({ class: "provider_error", code: "proxy_server_error", row: 9, stop: false });
  });

  it("anything else is not the proxy's failure", () => {
    expect(classifyProxyFailure({ status: 400, retryAfter: null, text: '400 {"type":"error","error":{"type":"invalid_request_error","message":"x"}}', at: AT })).toBeUndefined();
    expect(classifyProxyFailure({ status: 200, retryAfter: null, text: "Request was aborted", at: AT })).toBeUndefined();
  });

  it("a usage limit's failure is the class and the code; the text is fixed, never the proxy's body", () => {
    for (const name of Object.keys(fixtures.answers) as Array<Name>) {
      const failure = classifyProxyFailure(answered(name))!;
      const message = proxyFailureMessage(failure);
      expect(message.length, name).toBeGreaterThan(10);
      expect(message, name).not.toContain("credentials");
      expect(message, name).not.toContain("{");
    }
    expect(proxyFailureMessage(classifyProxyFailure(answered("invalidKey"))!)).toContain("MODEL_PROXY_API_KEY");
  });
});
