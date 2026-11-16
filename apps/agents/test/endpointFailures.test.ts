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
import { ERROR_BODY_BYTES, type ModelFailureCode, modelFailureDetail } from "@t3flare/models/failures";
import type { EndpointFailureRecord, ProxyFailureRecord, ProxyRecord } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import fixtures from "../../../packages/models/test/fixtures/vendors.json" with { type: "json" };
import { SessionEndpoints } from "../src/session/endpoints.ts";
import { liveOf, pushedEntry, turnDetail } from "../src/session/state.ts";
import { armFault, compactionLimits, sessionLimits, type Fault, FAULT_ECHOED_SECRETS, FAULT_FIXTURES, faultAnswer, proxyLimits, recordingFetch } from "../src/session/proxyLimits.ts";

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
const openSession = async (
  answer: (url: string) => Response,
  options: { readonly on?: ModelEndpoint; readonly fault?: Fault; readonly endpoints?: ReadonlyArray<ModelEndpoint>; readonly baseUrl?: string } = {},
) => {
  const on = options.on ?? CLAUDE;
  const endpoints = options.endpoints ?? [on];
  let now = T0;
  const sentTo = new Map<string, number>();
  let requests = 0;
  // Every failed answer's record, `undefined` where it cleared the record (an answer the table does not know).
  const records: Array<EndpointFailureRecord | undefined> = [];
  const proxyRecords: Array<ProxyFailureRecord | undefined> = [];
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
    usage: { session: () => "s", record: () => undefined },
    limits: () => undefined,
    readMs: 50,
    now: () => now,
    source: () => ({ modelEndpoints: async () => ({ revision: 1, endpoints }), endpointCredential: async () => ({ apiKey: "key-for-tests-only" }) }),
  });
  const limits = {
    last: recorder.last,
    record: (failure: ProxyFailureRecord | undefined) => void proxyRecords.push(failure),
    // A test may move the endpoint's base URL away from where its requests go (the answers are then not its).
    endpoint: (id: string) => {
      const endpoint = session.endpoint(id);
      return endpoint === undefined || options.baseUrl === undefined ? endpoint : { ...endpoint, baseUrl: options.baseUrl };
    },
    recordEndpoint: (failure: EndpointFailureRecord | undefined) => void records.push(failure),
    secrets: (id: string) => session.secrets(id),
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
    expect(run.status).toMatchObject({ status: "unanswered", detail: "t3flare model endpoint: usage_limit, not retried" });
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

  it("a rate limit with no reset is retried, and the next answer's long reset ends it", async () => {
    let calls = 0;
    const run = await submit(() => (calls++ === 0 ? answerOf("anthropicRateLimitBare") : answerOf("anthropicRateLimitLong")));
    expect(run.requests).toBe(2);
    expect(run.records.map((record) => [record?.code, record?.stop])).toEqual([
      ["rate_limited", false],
      ["rate_limited", true],
    ]);
  });

  it("compaction on a usage limit: one request, recorded, failed with the text no retry matches", async () => {
    let compacting = false;
    const session = await openSession(() => (compacting ? answerOf("anthropicSubscriptionLimit") : okAnswer()));
    expect((await session.submit()).status).toBe("done");
    compacting = true;
    const compaction = await session.compact();
    expect(compaction.requests).toBe(1);
    expect(compaction.outcome).toMatchObject({ status: "failed", error: { message: "Summarization failed: t3flare model endpoint: usage_limit, not retried" } });
    expect(session.counts().records.at(-1)).toMatchObject({ code: "usage_limit", stop: true });
  });

  it("an error the table does not know keeps pi-ai's text, redacted: an echoed key never reaches pi-durable", async () => {
    const echo = `{"type":"error","error":{"type":"invalid_request_error","message":"bad header x-api-key: ${FAULT_ECHOED_SECRETS[0]}"}}`;
    const run = await submit(() => new Response(echo, { status: 400, headers: { "content-type": "application/json" } }));
    expect(run.records).toEqual([undefined]);
    const detail = String(run.status.detail);
    expect(detail).toContain("[redacted]");
    for (const secret of FAULT_ECHOED_SECRETS) expect(detail).not.toContain(secret);
  });

  it("the last failed answer wins: a retried 529, then a 400 the table does not know, clears the overload", async () => {
    let calls = 0;
    const tooLong = '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}';
    const run = await submit(() => (calls++ < 2 ? answerOf("anthropicOverloaded") : new Response(tooLong, { status: 400, headers: { "content-type": "application/json" } })));
    expect(run.requests).toBe(3);
    expect(run.records.map((record) => record?.code)).toEqual(["overloaded", "overloaded", undefined]);
  });

  it("a bare 529, 521 or 507 (no body pi-ai's patterns know) is retried; 501 is not", async () => {
    for (const status of [529, 521, 507]) {
      const run = await submit(() => new Response("", { status }));
      expect(run.requests, String(status)).toBe(4);
      expect(run.records.at(-1), String(status)).toMatchObject({ class: "provider_error", stop: false });
    }
    const notImplemented = await submit(() => new Response("", { status: 501 }));
    expect(notImplemented.requests).toBe(1);
    expect(notImplemented.records.at(-1)).toMatchObject({ code: "unsupported_request", stop: true });
  });

  it("a 429 resetting within pi-durable's retries (14 s) is retried; one past them, even at 20 s, stops after one request", async () => {
    const short = await submit(() => new Response(answerOf("anthropicRateLimitBare").body, { status: 429, headers: { "retry-after": "2" } }));
    expect(short.requests).toBe(4);
    expect(short.records.at(-1)).toMatchObject({ code: "rate_limited", stop: false });
    const beyond = await submit(() => new Response(answerOf("anthropicRateLimitBare").body, { status: 429, headers: { "retry-after": "20" } }));
    expect(beyond.requests).toBe(1);
    expect(beyond.records.at(-1)).toMatchObject({ code: "rate_limited", stop: true, class: "usage_limit" });
    const long = await submit(() => answerOf("anthropicRateLimitLong"));
    expect(long.requests).toBe(1);
  });

  it("the endpoint's own key is redacted from its error text whatever its shape", async () => {
    const echo = '{"type":"error","error":{"type":"invalid_request_error","message":"bad request for key key-for-tests-only"}}';
    const run = await submit(() => new Response(echo, { status: 400, headers: { "content-type": "application/json" } }));
    expect(String(run.status.detail)).not.toContain("key-for-tests-only");
  });

  it("an answer is the endpoint's only when it came from under its base URL: the unified headers are read only then", async () => {
    const own = await submit(() => answerOf("anthropicSubscriptionLimit"));
    expect(own.records.at(-1)).toMatchObject({ code: "usage_limit", stop: true });
    // Another base URL: the recorded answer is not this endpoint's, so only pi-ai's text is read (a rate limit, no reset).
    const other = await submit(() => answerOf("anthropicSubscriptionLimit"), { baseUrl: "https://elsewhere.example" });
    expect(other.records.at(-1)).toMatchObject({ code: "rate_limited", stop: false });
  });

  it("every code the Session stops on leaves a text no retry pattern of pi-ai's matches; every one it retries, one that does", () => {
    const stopped: ReadonlyArray<ModelFailureCode> = [
      "usage_limit",
      "workspace_limit",
      "spend_limit",
      "rate_limited",
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
    for (const code of ["rate_limited", "overloaded", "server_error", "unavailable"] as const) {
      const errorMessage = modelFailureDetail({ class: "provider_error", code, retryable: true, stop: false });
      expect(isRetryableAssistantError({ stopReason: "error", errorMessage } as never), code).toBe(true);
    }
  });
});

describe("the recording fetch (SPI-1172)", () => {
  const recorder = (answer: () => Response) =>
    recordingFetch({ fetch: (async () => answer()) as typeof globalThis.fetch, fault: () => undefined, clearFault: () => undefined, now: () => T0, onRequest: () => undefined });

  it("never reads or buffers a success's body: it streams to pi-ai untouched", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          pulls++;
          controller.enqueue(new TextEncoder().encode("data: x\n\n"));
          controller.close();
        },
      }, { highWaterMark: 0 });
    const r = recorder(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await r.fetch("https://claude.example/v1/messages");
    expect(pulls).toBe(0);
    expect(r.last()?.body).toBeUndefined();
    expect(await response.text()).toBe("data: x\n\n");
  });

  it("keeps at most ERROR_BODY_BYTES of an error's body, and pi-ai still reads it whole", async () => {
    const big = `{"error":{"message":"${"x".repeat(20 * 1024)}"}}`;
    const r = recorder(() => new Response(big, { status: 400 }));
    const response = await r.fetch("https://claude.example/v1/messages");
    expect(r.last()?.body?.length).toBe(ERROR_BODY_BYTES);
    expect(await response.text()).toBe(big);
  });
});

describe("the fault gate (SPI-1172)", () => {
  it("arms only where the deployment has T3FLARE_FAULTS=1, a known fixture and a finite reset", () => {
    expect(armFault("1", { fixture: "anthropicUsageLimit", resetAt: T0 })).toEqual({ fixture: "anthropicUsageLimit", resetAt: T0 });
    expect(armFault(undefined, { fixture: "anthropicUsageLimit", resetAt: T0 })).toBeInstanceOf(Error);
    expect(armFault("0", { fixture: "anthropicUsageLimit", resetAt: T0 })).toBeInstanceOf(Error);
    expect(armFault("1", { fixture: "nope", resetAt: T0 })).toBeInstanceOf(Error);
    expect(armFault("1", { fixture: "cooldown", resetAt: Number.NaN })).toBeInstanceOf(Error);
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
      ["anthropicRateLimit", CLAUDE, "rate_limited"],
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

  it("a turn's failure detail as the Session keeps it is redacted and bounded", () => {
    const detail = turnDetail(`run failed: ${FAULT_ECHOED_SECRETS[2]} ${"y".repeat(3000)}`);
    expect(detail).not.toContain(FAULT_ECHOED_SECRETS[2]);
    expect(detail?.length).toBe(2048);
    expect(turnDetail(undefined)).toBeUndefined();
  });
});

describe("the Session's record of a turn's failures (sessionLimits, SPI-1172 review 2)", () => {
  const proxyFailure = { class: "provider_error" as const, code: "proxy_overloaded", row: 9, stop: false, at: 1 };
  const endpointFailure = { endpointId: "claude", class: "provider_error" as const, code: "overloaded", message: "m", retryable: true, stop: false, at: 2 };
  const session = () => {
    let record: ProxyRecord = { requests: 3 };
    const options = sessionLimits({
      last: () => undefined,
      note: (update) => void (record = update(record)),
      endpoints: { endpoint: (id) => (id === "claude" ? CLAUDE : undefined), secrets: (id) => (id === "claude" ? ["claude-key-held-now"] : []) },
      proxyKey: "proxy-key-of-the-stage",
    });
    return { options, record: () => record };
  };

  it("each failed answer replaces the record: an endpoint's clears the proxy's, and undefined clears both", () => {
    const s = session();
    s.options.record(proxyFailure);
    expect(s.record()).toEqual({ requests: 3, failure: proxyFailure });
    s.options.recordEndpoint?.(endpointFailure);
    expect(s.record()).toEqual({ requests: 3, endpointFailure });
    s.options.recordEndpoint?.(undefined);
    expect(s.record()).toEqual({ requests: 3 });
    s.options.recordEndpoint?.(endpointFailure);
    s.options.record(undefined);
    expect(s.record()).toEqual({ requests: 3 });
    s.options.record(proxyFailure);
    s.options.record(undefined);
    expect(s.record()).toEqual({ requests: 3 });
  });

  it("names a provider's endpoint and credentials: the proxy's key for anthropic, the held one for an endpoint", () => {
    const s = session();
    expect(s.options.endpoint?.("claude")).toBe(CLAUDE);
    expect(s.options.endpoint?.("anthropic")).toBeUndefined();
    expect(s.options.secrets?.("anthropic")).toEqual(["proxy-key-of-the-stage"]);
    expect(s.options.secrets?.("claude")).toEqual(["claude-key-held-now"]);
  });
});
