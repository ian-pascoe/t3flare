// SPI-1172: a Session's failed answers from Model endpoints, on a real pi-durable Harness: the recording fetch keeps each
// answer's status, headers and error body; the `afterResponse` hook (and compaction's models) classify the failure once
// by the endpoint's API and auth, record it with the endpoint's own text, and leave pi-durable a text no retry pattern
// matches when no retry can help. A usage limit is one request and never another endpoint's; an overload is retried;
// error text is redacted before pi-durable keeps it. Answers are the recorded vendor shapes of
// packages/models/test/fixtures/vendors.json.
// @effect-diagnostics asyncFunction:off globalTimers:off globalDate:off newPromise:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { ModelEndpoint } from "@t3flare/models/endpoints";
import { type ModelFailureCode, modelFailureDetail } from "@t3flare/models/failures";
import type { EndpointFailureRecord, ProxyFailureRecord } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import fixtures from "../../../packages/models/test/fixtures/vendors.json" with { type: "json" };
import { SessionEndpoints } from "../src/session/endpoints.ts";
import { liveOf, pushedEntry } from "../src/session/state.ts";
import { compactionLimits, type Fault, FAULT_ECHOED_SECRETS, FAULT_FIXTURES, faultAnswer, proxyLimits, recordingFetch } from "../src/session/proxyLimits.ts";

const context = BACKGROUND_CONTEXT;
const T0 = Date.parse(fixtures.now);

type Name = keyof typeof fixtures.answers;
const answerOf = (name: Name) => {
  const answer = fixtures.answers[name];
  return new Response(answer.body, { status: answer.status, headers: { ...answer.headers, "content-type": "application/json" } });
};

const model = { id: "m-1", name: "M", reasoning: false, input: ["text" as const], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, known: false };

const endpointOf = (id: string, api: ModelEndpoint["api"], auth: ModelEndpoint["auth"] = "api-key"): ModelEndpoint => ({
  id,
  label: id,
  api,
  baseUrl: api === "anthropic-messages" ? `https://${id}.example` : `https://${id}.example/v1`,
  auth,
  headers: {},
  models: [model],
});

const CLAUDE = endpointOf("claude", "anthropic-messages");
const OPENAI = endpointOf("openai", "openai-responses");
const OTHER = endpointOf("spare", "anthropic-messages");

/** An Anthropic Messages stream that answers `ok`. */
const okAnswer = () => {
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  const body = [
    event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "m-1", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    event("message_stop", {}),
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

/** The Session's model path over fake endpoints: their providers, the recording fetch, the hook and compaction's limits. */
const openSession = async (answer: (url: string) => Response, options: { readonly on?: ModelEndpoint; readonly fault?: Fault; readonly endpoints?: ReadonlyArray<ModelEndpoint> } = {}) => {
  const on = options.on ?? CLAUDE;
  const endpoints = options.endpoints ?? [on];
  let now = T0;
  const sentTo = new Map<string, number>();
  let requests = 0;
  const records: Array<EndpointFailureRecord> = [];
  const proxyRecords: Array<ProxyFailureRecord> = [];
  let stored = options.fault;
  const recorder = recordingFetch({
    fetch: (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const host = new URL(url).host;
      sentTo.set(host, (sentTo.get(host) ?? 0) + 1);
      return answer(url);
    }) as typeof globalThis.fetch,
    fault: () => stored,
    clearFault: () => {
      stored = undefined;
    },
    now: () => now,
    onRequest: () => {
      requests++;
    },
  });
  const map = new Map<string, unknown>([["t3flare:model-endpoints", { revision: 1, endpoints }]]);
  const models = createModels();
  const session = new SessionEndpoints({
    kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) },
    models,
    fetch: recorder.fetch,
    readMs: 50,
    now: () => now,
    source: () => ({ modelEndpoints: async () => ({ revision: 1, endpoints }), endpointCredential: async () => ({ apiKey: "key-for-tests-only" }) }),
  });
  const limits = {
    last: recorder.last,
    record: (failure: ProxyFailureRecord) => void proxyRecords.push(failure),
    endpoint: (id: string) => session.endpoint(id),
    recordEndpoint: (failure: EndpointFailureRecord) => void records.push(failure),
  };
  compactionLimits(models, limits);
  const registry = createRegistry();
  registry.install(proxyLimits(limits));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } } }, context);
  const root = await harness.root(context, { agent: { model: { provider: on.id, modelId: model.id } } });
  harness.resume();
  return {
    counts: () => ({ requests, sentTo, records, proxyRecords }),
    tick: (ms: number) => void (now += ms),
    submit: async () => {
      const submission = await root.submit({ type: "input", content: "hi" }, context);
      for (;;) {
        const status = await submission.status(context);
        if (status.status === "done" || status.status === "unanswered") return status as { status: string; detail?: unknown };
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
    compact: async () => {
      const before = requests;
      const task = await root.compact(undefined, context);
      const settled = await harness.waitForTask(task, context);
      return { requests: requests - before, outcome: settled.state.outcome };
    },
  };
};

const submit = async (answer: (url: string) => Response, options?: Parameters<typeof openSession>[1]) => {
  const session = await openSession(answer, options);
  const status = await session.submit();
  return { status, ...session.counts() };
};

describe("a Session's Model endpoint failures (SPI-1172)", () => {
  it("Anthropic's unified usage limit: one request, recorded with its reset and the endpoint's text, no fallback", async () => {
    const run = await submit(() => answerOf("anthropicSubscriptionLimit"), { endpoints: [CLAUDE, OTHER] });
    expect(run.requests).toBe(1);
    expect(run.status).toMatchObject({ status: "unanswered", detail: "t3flare model endpoint: usage_limit" });
    expect(run.records).toEqual([
      { endpointId: "claude", class: "usage_limit", code: "usage_limit", message: 'The Model endpoint "claude" reached its usage limit.', retryable: true, resetAt: T0 + 2 * 3_600_000, stop: true, at: T0 },
    ]);
    // Never another endpoint, nor the proxy's classifier.
    expect([...run.sentTo.keys()]).toEqual(["claude.example"]);
    expect(run.proxyRecords).toEqual([]);
  });

  it("a refused key: one request, a permission error naming the endpoint", async () => {
    const run = await submit(() => answerOf("anthropicKeyRefused"));
    expect(run.requests).toBe(1);
    expect(run.records.at(-1)).toMatchObject({ class: "permission_error", code: "key_refused", message: 'The Model endpoint "claude" refused its API key (HTTP 401): check it in the Harness panel.' });
  });

  it("an overload is retried by pi-durable and is not a usage limit", async () => {
    const run = await submit(() => answerOf("anthropicOverloaded"));
    expect(run.requests).toBe(4);
    expect(run.records.at(-1)).toMatchObject({ class: "provider_error", code: "overloaded", stop: false });
  });

  it("OpenAI Responses: insufficient_quota and ChatGPT's usage_limit_reached each end after one request", async () => {
    const quota = await submit(() => answerOf("openaiInsufficientQuota"), { on: OPENAI });
    expect(quota.requests).toBe(1);
    expect(quota.records.at(-1)).toMatchObject({ class: "usage_limit", code: "spend_limit", retryable: false });
    const limited = await submit(() => answerOf("chatgptUsageLimitReached"), { on: OPENAI });
    expect(limited.requests).toBe(1);
    expect(limited.records.at(-1)).toMatchObject({ code: "usage_limit", resetAt: T0 + 3 * 3_600_000 });
  });

  it("a rate limit with no reset is retried, and the next answer's reset ends it", async () => {
    let calls = 0;
    const run = await submit(() => (calls++ === 0 ? answerOf("anthropicRateLimitBare") : answerOf("anthropicRateLimit")));
    expect(run.requests).toBe(2);
    expect(run.records.map((record) => [record.code, record.stop])).toEqual([
      ["throttled", false],
      ["throttled", true],
    ]);
  });

  it("compaction on a usage limit: one request, recorded, failed with the text no retry matches", async () => {
    let compacting = false;
    const session = await openSession(() => (compacting ? answerOf("anthropicSubscriptionLimit") : okAnswer()));
    expect((await session.submit()).status).toBe("done");
    compacting = true;
    const compaction = await session.compact();
    expect(compaction.requests).toBe(1);
    expect(compaction.outcome).toMatchObject({ status: "failed", error: { message: "Summarization failed: t3flare model endpoint: usage_limit" } });
    expect(session.counts().records.at(-1)).toMatchObject({ code: "usage_limit", stop: true });
  });

  it("an error the table does not know keeps pi-ai's text, redacted: an echoed key never reaches pi-durable", async () => {
    const echo = `{"type":"error","error":{"type":"invalid_request_error","message":"bad header x-api-key: ${FAULT_ECHOED_SECRETS[0]}"}}`;
    const run = await submit(() => new Response(echo, { status: 400, headers: { "content-type": "application/json" } }));
    expect(run.records).toEqual([]);
    const detail = String(run.status.detail);
    expect(detail).toContain("[redacted]");
    for (const secret of FAULT_ECHOED_SECRETS) expect(detail).not.toContain(secret);
  });

  it("every code the Session stops on leaves a text no retry pattern of pi-ai's matches", () => {
    const stopped: ReadonlyArray<ModelFailureCode> = [
      "usage_limit",
      "workspace_limit",
      "spend_limit",
      "throttled",
      "key_refused",
      "sign_in_refused",
      "credential_needed",
      "plan_not_eligible",
      "unsupported_request",
    ];
    for (const code of stopped) {
      const errorMessage = modelFailureDetail({ class: "usage_limit", code, retryable: false, stop: true });
      expect(isRetryableAssistantError({ stopReason: "error", errorMessage } as never), code).toBe(false);
    }
  });
});

describe("the fault route's vendor shapes (SPI-1172)", () => {
  it("a usage-limit fault answers in Anthropic's unified shape until its reset, recorded with that reset", async () => {
    const run = await submit(() => okAnswer(), { fault: { fixture: "anthropicUsageLimit", resetAt: T0 + 120_000 } });
    expect(run.sentTo.size).toBe(0);
    expect(run.requests).toBe(1);
    expect(run.records[0]).toMatchObject({ endpointId: "claude", code: "usage_limit", resetAt: T0 + 120_000 });
  });

  it("a refused-key fault names the endpoint, and the secrets it echoes are redacted", async () => {
    const run = await submit(() => okAnswer(), { fault: { fixture: "anthropicKeyRefused", resetAt: T0 + 120_000 } });
    expect(run.records[0]).toMatchObject({ code: "key_refused", message: expect.stringContaining('The Model endpoint "claude"') });
    expect(JSON.stringify(run)).not.toContain(FAULT_ECHOED_SECRETS[0]);
  });

  it("each vendor fault is a failure the classifier knows for its API", async () => {
    const shapes: ReadonlyArray<readonly [Fault["fixture"], ModelEndpoint, ModelFailureCode]> = [
      ["anthropicUsageLimit", CLAUDE, "usage_limit"],
      ["anthropicRateLimit", CLAUDE, "throttled"],
      ["anthropicKeyRefused", CLAUDE, "key_refused"],
      ["openaiUsageLimit", OPENAI, "usage_limit"],
      ["openaiQuota", OPENAI, "spend_limit"],
      ["openaiKeyRefused", OPENAI, "key_refused"],
      ["planUsageLimit", endpointOf("chatgpt", "openai-responses", "chatgpt"), "usage_limit"],
    ];
    for (const [fixture, on, code] of shapes) {
      expect(FAULT_FIXTURES, fixture).toContain(fixture);
      const run = await submit(() => okAnswer(), { on, fault: { fixture, resetAt: T0 + 60_000 } });
      expect(run.records.at(-1)?.code, fixture).toBe(code);
    }
    expect(faultAnswer({ fixture: "anthropicUsageLimit", resetAt: T0 + 60_000 }, T0, "m").headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
  });
});

describe("what the Session pushes is redacted (SPI-1172)", () => {
  it("an assistant entry's error text and a run failure's detail carry no echoed credential", () => {
    const echoed = `401 invalid x-api-key: ${FAULT_ECHOED_SECRETS[0]}; Bearer ${FAULT_ECHOED_SECRETS[1]}; ${FAULT_ECHOED_SECRETS[2]}`;
    const entry = pushedEntry({ id: 1, kind: "message", model: [{ role: "assistant", content: [], stopReason: "error", errorMessage: echoed }] }, "t");
    const live = liveOf({ run: { taskId: "1" }, runFailure: { reason: "model_error", detail: echoed, taskId: "1" } }, () => "t");
    const pushed = JSON.stringify([entry, live]);
    for (const secret of FAULT_ECHOED_SECRETS) expect(pushed).not.toContain(secret);
    expect(pushed).toContain("[redacted]");
  });
});
