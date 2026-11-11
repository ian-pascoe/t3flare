// The Session's handling of the model proxy's failures (step 2a part 2 plan, section 3; review finding 3) on a real
// pi-durable Harness: the recording fetch sees each answer's status and `retry-after`, and the `afterResponse` hook
// classifies a failed response once, records it with the answer's time, and leaves pi-durable a text no retry pattern
// matches when no retry can help. So a limited or refused submission makes one proxy request; an overload is retried.
// @effect-diagnostics asyncFunction:off globalTimers:off globalDate:off newPromise:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { STATIC_CATALOG } from "@t3flare/models/catalog";
import { classifyProxyFailure, type ProxyFailureCode, proxyFailureDetail } from "@t3flare/models/proxyFailure";
import type { ProxyFailureRecord } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import fixtures from "../../../packages/models/test/fixtures/proxy.json" with { type: "json" };
import { proxyModels } from "../src/session/models.ts";
import { compactionLimits, type Fault, faultAnswer, proxyLimits, recordingFetch } from "../src/session/proxyLimits.ts";

const context = BACKGROUND_CONTEXT;
const T0 = Date.parse("2026-11-12T10:00:00.000Z");

type Name = keyof typeof fixtures.answers;
const answerOf = (name: Name) => {
  const answer = fixtures.answers[name];
  return new Response(answer.body, { status: answer.status, headers: { ...answer.headers, "content-type": "application/json" } });
};

/** An answer the proxy streams for a turn that succeeds: one text block, `ok`. */
const okAnswer = () => {
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  const body = [
    event("message_start", {
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } },
    }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    event("message_stop", {}),
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

/** A Session's model path: a fake proxy answering `answer`, the recording fetch, the hooks; runs one submission. */
const submit = async (answer: () => Response, fault?: Fault) => {
  const session = await openSession(answer, fault);
  return { ...(await session.submit()), ...session.counts() };
};

/** The Session's model path over a fake proxy: the recording fetch, the `afterResponse` hook and compaction's limits. */
const openSession = async (answer: () => Response, fault?: Fault) => {
  let now = T0;
  let proxied = 0;
  let requests = 0;
  const records: Array<ProxyFailureRecord> = [];
  let stored = fault;
  const recorder = recordingFetch({
    fetch: (async () => {
      proxied++;
      now += 1000;
      return answer();
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
  const limits = { last: recorder.last, record: (failure: ProxyFailureRecord) => void records.push(failure) };
  const models = compactionLimits(proxyModels({ url: "https://proxy.example", apiKey: "k" }, () => STATIC_CATALOG, recorder.fetch), limits);
  const registry = createRegistry();
  registry.install(proxyLimits(limits));
  const harness = await Harness.open(
    new MemoryStorage(),
    // Any earlier turn is enough to compact.
    { models, registry, settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } } },
    context,
  );
  const root = await harness.root(context, { agent: { model: { provider: "anthropic", modelId: "claude-haiku-5-5" } } });
  harness.resume();
  return {
    counts: () => ({ requests, proxied, records }),
    submit: async () => {
      const submission = await root.submit({ type: "input", content: "hi" }, context);
      for (;;) {
        const status = await submission.status(context);
        if (status.status === "done" || status.status === "unanswered") return { status: status as { status: string; detail?: unknown } };
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

describe("the Session's model proxy failures", () => {
  it("all accounts cooling down: one request, recorded with the reset counted from the answer's time", async () => {
    const run = await submit(() => answerOf("cooldown"));
    expect(run.requests).toBe(1);
    expect(run.status).toMatchObject({ status: "unanswered", detail: "t3flare model proxy: proxy_cooldown" });
    expect(run.records).toEqual([{ class: "usage_limit", code: "proxy_cooldown", row: 1, resetAt: T0 + 1000 + 7384_000, stop: true, at: T0 + 1000 }]);
  });

  it("a refused key: one request, a permission error", async () => {
    const run = await submit(() => answerOf("invalidKey"));
    expect(run.requests).toBe(1);
    expect(run.records.at(-1)).toMatchObject({ class: "permission_error", code: "proxy_key_rejected" });
  });

  it("an overload is still retried by pi-durable, and the last answer is the record", async () => {
    const run = await submit(() => answerOf("overloaded"));
    expect(run.requests).toBe(4);
    expect(run.records).toHaveLength(4);
    expect(run.records.at(-1)).toMatchObject({ code: "proxy_overloaded", stop: false });
  });

  it("an upstream 429 without a reset is retried; the next answer, Commissary's cooldown, ends it", async () => {
    let calls = 0;
    const run = await submit(() => (calls++ === 0 ? answerOf("upstreamLimit") : answerOf("cooldown")));
    expect(run.requests).toBe(2);
    expect(run.records.map((record) => record.code)).toEqual(["proxy_upstream_limit", "proxy_cooldown"]);
  });

  it("compaction on a usage limit or a refused key: one request, recorded, failed with the text no retry matches", async () => {
    for (const [name, code] of [
      ["cooldown", "proxy_cooldown"],
      ["invalidKey", "proxy_key_rejected"],
    ] as const) {
      let compacting = false;
      const session = await openSession(() => (compacting ? answerOf(name) : okAnswer()));
      expect((await session.submit()).status.status, name).toBe("done");
      compacting = true;
      const compaction = await session.compact();
      expect(compaction.requests, name).toBe(1);
      expect(compaction.outcome, name).toMatchObject({ status: "failed", error: { message: `Summarization failed: t3flare model proxy: ${code}` } });
      expect(session.counts().records.at(-1), name).toMatchObject({ code, stop: true });
    }
  });

  it("compaction on an overload is still retried by pi-durable", async () => {
    let compacting = false;
    const session = await openSession(() => (compacting ? answerOf("overloaded") : okAnswer()));
    await session.submit();
    compacting = true;
    const compaction = await session.compact();
    expect(compaction.requests).toBe(4);
    expect(compaction.outcome).toMatchObject({ status: "failed" });
  });

  it("a fault answers in the proxy's place until its reset, counted as a request, with the proxy never called", async () => {
    const run = await submit(() => answerOf("overloaded"), { fixture: "cooldown", resetAt: T0 + 120_000 });
    expect(run.proxied).toBe(0);
    expect(run.requests).toBe(1);
    expect(run.records[0]).toMatchObject({ code: "proxy_cooldown", resetAt: T0 + 120_000 });
  });

  it("an expired fault is cleared, and the proxy answers", async () => {
    const run = await submit(() => answerOf("invalidKey"), { fixture: "cooldown", resetAt: T0 - 1 });
    expect(run.proxied).toBe(1);
    expect(run.records[0]).toMatchObject({ code: "proxy_key_rejected" });
  });

  it("every fixture, through pi-ai's real client, is recorded as the classifier reads Commissary's raw answer", async () => {
    // A pi-ai or SDK upgrade that changes the error text fails here.
    for (const name of Object.keys(fixtures.answers) as Array<Name>) {
      const raw = fixtures.answers[name];
      const headers = raw.headers as Record<string, string>;
      const direct = classifyProxyFailure({ status: raw.status, retryAfter: headers["retry-after"] ?? null, text: raw.body, at: 0 });
      const run = await submit(() => answerOf(name));
      expect(run.records.at(-1) && { class: run.records.at(-1)!.class, code: run.records.at(-1)!.code }, name).toEqual({ class: direct!.class, code: direct!.code });
    }
  });

  it("the text left for pi-durable matches no retry pattern of pi-ai's, for every code", () => {
    const codes: ReadonlyArray<ProxyFailureCode> = [
      "proxy_cooldown",
      "proxy_upstream_limit",
      "proxy_spend_limit",
      "proxy_request_rate",
      "proxy_account_unavailable",
      "proxy_key_rejected",
      "proxy_account_rejected",
      "proxy_no_account",
    ];
    for (const code of codes) {
      const errorMessage = proxyFailureDetail({ class: "usage_limit", code, row: 1, stop: true });
      expect(isRetryableAssistantError({ stopReason: "error", errorMessage } as never), code).toBe(false);
    }
  });

  it("each fault fixture is an answer the classifier knows", async () => {
    for (const fixture of ["cooldown", "spendLimit", "invalidKey", "overloaded", "accountUnavailable"] as const) {
      const response = faultAnswer({ fixture, resetAt: T0 + 60_000 }, T0, "m");
      expect(response.status, fixture).toBeGreaterThanOrEqual(400);
    }
  });
});
