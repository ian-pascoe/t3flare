// The differ on a recorded Session (step 2a plan, tests): a real Session's state, as `GET /_t3flare/agents/session`
// returned it on the `step2a` stage after `scripts/chat.ts` (an answer, a Stop, a steer).
import type { SessionState, TurnState } from "@t3flare/session-protocol";
import { makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { approvalIdOf, diff, failureOf, makeDifferState, runtimeRequestIdOf, type DifferState, type TurnContext } from "../src/provider/differ.ts";
import recorded from "./fixtures/session-chat.json" with { type: "json" };
import recordedTools from "./fixtures/session-tools.json" with { type: "json" };

const state = recorded as unknown as SessionState;
const now = DateTime.makeUnsafe("2026-11-10T21:20:00.000Z");

const withTurns = (): DifferState => {
  const differ = makeDifferState("thread:test");
  Object.entries(state.turns).forEach(([providerTurnId, turn], index) => {
    differ.turns.set(providerTurnId, {
      providerTurnId,
      threadId: "thread-1",
      runId: turn.runId,
      rootNodeId: `node:${index}`,
      providerThreadId: "provider-thread-1",
      runOrdinal: index + 1,
      providerTurnOrdinal: index + 1,
      startedAt: now,
      providerTurn: {
        id: providerTurnId,
        providerThreadId: "provider-thread-1",
        nodeId: `node:${index}`,
        runAttemptId: turn.attemptId,
        nativeTurnRef: null,
        ordinal: index + 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
      contextWindow: 400_000,
      providerSessionId: "provider-session-1",
    } as unknown as TurnContext);
  });
  return differ;
};

const types = (events: ReadonlyArray<{ type: string }>) => events.map((event) => event.type);

describe("differ", () => {
  it("turns a recorded Session into t3's events, one terminal per turn", () => {
    const events = diff(withTurns(), state, now);
    const terminals = events.filter((event) => event.type === "turn.terminal");
    expect(terminals.map((event) => (event as { status: string }).status)).toEqual(["completed", "cancelled", "completed"]);
    const items = events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
    expect(items.filter((item) => item.type === "assistant_message").length).toBeGreaterThanOrEqual(3);
    expect(items.some((item) => item.type === "reasoning")).toBe(true);
    // Every assistant message has its message.
    const messageIds = new Set(events.flatMap((event) => (event.type === "message.updated" ? [event.message.id] : [])));
    for (const item of items) if (item.type === "assistant_message") expect(messageIds.has(item.messageId)).toBe(true);
  });

  it("emits nothing new when the same state is applied again", () => {
    const differ = withTurns();
    diff(differ, state, now);
    expect(types(diff(differ, state, now))).toEqual([]);
  });

  it("derives the same ids from a fresh state (a re-diff after a restart)", () => {
    const ids = (events: ReturnType<typeof diff>) =>
      events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem.id] : [])).sort();
    expect(ids(diff(withTurns(), state, now))).toEqual(ids(diff(withTurns(), state, now)));
  });

  it("keeps a response's id from its live partial to its committed entry", () => {
    const answered = state.entries.find((entry) => entry.role === "assistant" && entry.content.some((block) => block.type === "text"))!;
    const turnId = answered.turn!;
    const differ = withTurns();
    const live: SessionState = {
      ...state,
      entries: [],
      live: {
        run: { taskId: answered.byTaskId!, turn: turnId },
        generation: { taskId: answered.byTaskId!, attempt: 2, content: answered.content },
        tools: [],
        runFailure: null,
      },
      turns: { [turnId]: { ...state.turns[turnId]!, status: "running" } },
    };
    const streaming = diff(differ, live, now).flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
    const committed = diff(differ, { ...state, turns: { [turnId]: state.turns[turnId]! } }, now).flatMap((event) =>
      event.type === "turn_item.updated" ? [event.turnItem] : [],
    );
    const streamedIds = streaming.filter((item) => item.type === "assistant_message").map((item) => item.id);
    const committedIds = committed.filter((item) => item.type === "assistant_message").map((item) => item.id);
    expect(streamedIds.length).toBeGreaterThan(0);
    expect(committedIds.filter((id) => streamedIds.includes(id))).toEqual(streamedIds);
    expect(streaming.every((item) => item.status === "running")).toBe(true);
  });

  it("ignores entries of turns it did not start", () => {
    expect(diff(makeDifferState("thread:test"), state, now)).toEqual([]);
  });

  it("without the Session's record, names the error's HTTP status and keeps the raw text out", () => {
    // The Model proxy's text classifier went at the hard cut (SPI-1176): a 429 with no record is the provider's error.
    const limited = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail: "429 {\"error\":\"rate_limit_error\",\"key\":\"sk-secret\"}", startedAt: 0 }, now);
    expect(limited).toMatchObject({ class: "provider_error", message: "The model provider returned HTTP 429.", code: "429" });
    expect(limited.message).not.toContain("sk-secret");
    const other = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail: "400 bad request", startedAt: 0 }, now);
    expect(other.class).toBe("provider_error");
    expect(other.message).toBe("The model provider returned HTTP 400.");
  });

  it("says which model is gone when its Model endpoint was removed or no longer lists it (SPI-1162)", () => {
    const failure = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "no_model", detail: "Model openai/gpt-5-mini is not available", startedAt: 0 }, now);
    expect(failure).toMatchObject({ class: "provider_error", code: "no_model" });
    expect(failure.message).toBe("The model openai/gpt-5-mini is not available: its Model endpoint was removed or no longer lists it. Pick another model.");
    const bare = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "no_model", startedAt: 0 }, now);
    expect(bare.message).toBe("The selected model is not available: its Model endpoint was removed or no longer lists it. Pick another model.");
  });

  it("points to the setup when a selection from before the hard cut found no endpoint to fall back to (SPI-1176)", () => {
    for (const detail of ["Model anthropic/claude-x is not available", "Model /claude-x is not available"]) {
      expect(failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "no_model", detail, startedAt: 0 }, now), detail).toMatchObject({
        class: "provider_error",
        code: "no_model",
        message: "No Model endpoint is set up: add one in the Harness panel (/_t3flare/harness), under Model endpoints.",
      });
    }
    // pi-durable's settlement without a detail: the setup state decides (no endpoint lists a model).
    const bare = { submissionId: "1", runId: "r", attemptId: "a", status: "failed" as const, reason: "no_model", startedAt: 0 };
    expect(failureOf(bare, now, () => true).message).toBe("No Model endpoint is set up: add one in the Harness panel (/_t3flare/harness), under Model endpoints.");
    expect(failureOf(bare, now, () => false).message).toBe("The selected model is not available: its Model endpoint was removed or no longer lists it. Pick another model.");
  });

  it("shows a Model endpoint's credential failure as the Session recorded it, typed, never the error's text (SPI-1164)", () => {
    const at = (credential: { endpointId: string; kind: "signed_out" | "unavailable"; message: string; retryable: boolean } | undefined, detail: string) =>
      failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail, startedAt: 0, ...(credential === undefined ? {} : { proxy: { requests: 0, credential } }) }, now);
    const message = 'The Model endpoint "chatgpt" is not signed in to ChatGPT (ChatGPT refused to renew the sign-in (invalid_grant)): sign in with ChatGPT again in the Harness panel.';
    expect(at({ endpointId: "chatgpt", kind: "signed_out", message, retryable: false }, `API key auth failed for provider chatgpt: ${message} sk-secret`)).toMatchObject({ class: "provider_error", code: "signed_out", retryable: false, message });
    expect(at({ endpointId: "chatgpt", kind: "unavailable", message: "m", retryable: true }, "")).toMatchObject({ code: "unavailable", retryable: true, message: "m" });
    // Without the record, the text is never read for it: the generic model error.
    expect(at(undefined, `API key auth failed for provider chatgpt: ${message}`).message).toBe("The model provider reported an error.");
  });

  describe("a Model endpoint's failure the Session classified by its API and auth (SPI-1172)", () => {
    const nowMs = DateTime.toEpochMillis(now);
    const failed = (endpointFailure: NonNullable<TurnState["proxy"]>["endpointFailure"], extra: Partial<NonNullable<TurnState["proxy"]>> = {}) =>
      ({
        submissionId: "1",
        runId: "r",
        attemptId: "a",
        status: "failed",
        reason: "model_error",
        detail: "t3flare model endpoint: usage_limit, not retried",
        startedAt: 0,
        settledAt: nowMs,
        proxy: { requests: 1, endpointFailure, ...extra },
      }) as TurnState;

    it("a usage limit pauses with its reset, the Session's text naming the endpoint", () => {
      const resetAt = Date.parse("2026-11-10T23:20:00.000Z");
      const message = 'The Model endpoint "claude" reached its usage limit.';
      expect(failureOf(failed({ endpointId: "claude", class: "usage_limit", code: "usage_limit", message, retryable: true, resetAt, stop: true, at: nowMs }), now)).toEqual({
        class: "usage_limit",
        message,
        code: "usage_limit",
        retryable: true,
        resetAt: "2026-11-10T23:20:00.000Z",
      });
    });

    it("a reset held to at least 30 s after now; none when the vendor gave none", () => {
      const soon = failureOf(failed({ endpointId: "e", class: "usage_limit", code: "rate_limited", message: "m", retryable: true, resetAt: nowMs + 1000, stop: true, at: nowMs }), now);
      expect(soon.resetAt).toBe("2026-11-10T21:20:30.000Z");
      const none = failureOf(failed({ endpointId: "e", class: "usage_limit", code: "usage_limit", message: "m", retryable: true, stop: true, at: nowMs }), now);
      expect(none.resetAt ?? null).toBeNull();
    });

    it("a refused key is a permission error naming the endpoint, with no reset", () => {
      const message = 'The Model endpoint "commissary" refused its API key (HTTP 401): check it in the Harness panel.';
      expect(failureOf(failed({ endpointId: "commissary", class: "permission_error", code: "key_refused", message, retryable: false, stop: true, at: nowMs }), now)).toEqual({
        class: "permission_error",
        message,
        code: "key_refused",
        retryable: false,
      });
    });

    it("an overload is a provider error, retryable, never a usage limit", () => {
      expect(failureOf(failed({ endpointId: "e", class: "provider_error", code: "overloaded", message: "m", retryable: true, stop: false, at: nowMs }), now)).toMatchObject({
        class: "provider_error",
        code: "overloaded",
        retryable: true,
      });
    });

    it("a credential the Session could not get comes first; the record wins over the error's text", () => {
      const credential = { endpointId: "e", kind: "no_key" as const, message: "no key", retryable: false };
      expect(failureOf(failed({ endpointId: "e", class: "usage_limit", code: "usage_limit", message: "m", retryable: true, stop: true, at: nowMs }, { credential }), now).code).toBe("no_key");
      const overText = { ...failed({ endpointId: "e", class: "permission_error", code: "key_refused", message: "m", retryable: false, stop: true, at: nowMs }), detail: '429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}' };
      expect(failureOf(overText, now).code).toBe("key_refused");
    });
  });

  it("shows a record of the retired Model proxy's classifier (a push from before the hard cut) as the provider's error (SPI-1176)", () => {
    const nowMs = DateTime.toEpochMillis(now);
    const old = { class: "usage_limit", code: "proxy_cooldown", row: 1, resetAt: nowMs + 60_000, stop: true, at: nowMs };
    const turn = { submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail: "t3flare model proxy: proxy_cooldown", startedAt: 0, settledAt: nowMs, proxy: { requests: 1, failure: old } } as unknown as TurnState;
    expect(failureOf(turn, now)).toEqual({ class: "provider_error", message: "The model provider reported an error.", code: null, retryable: null });
  });

  it("opens a pending approval as a runtime request, and closes it as resolved or cancelled", () => {
    const turnId = Object.keys(state.turns)[0]!;
    const differ = withTurns();
    const running = { ...state, entries: [], turns: { [turnId]: { ...state.turns[turnId]!, status: "running" as const } } };
    const approval = {
      requestId: "42",
      turn: turnId,
      callId: "call-1",
      tool: "bash",
      kind: "command" as const,
      summary: "cd /workspace/repo && bash test.sh",
      createdAt: Date.parse("2026-11-10T21:19:00.000Z"),
    };
    const textOut = (text: string) => text.replaceAll("/workspace/repo", "/w/fixture");
    const opened = diff(differ, { ...running, approvals: [approval] }, now, undefined, textOut);
    expect(types(opened)).toEqual(["runtime_request.updated", "node.updated", "turn_item.updated"]);
    const request = (opened[0] as { runtimeRequest: { id: string; status: string; kind: string } }).runtimeRequest;
    expect(request).toMatchObject({ status: "pending", kind: "command" });
    expect(approvalIdOf("thread:test", request.id)).toBe("42");
    expect(request.id).toBe(runtimeRequestIdOf("thread:test", "42"));
    expect((opened[2] as { turnItem: { prompt: string } }).turnItem.prompt).toBe("cd /w/fixture && bash test.sh");
    // Applied again: nothing new.
    expect(types(diff(differ, { ...running, approvals: [approval] }, now, undefined, textOut))).toEqual([]);
    // Answered (the adapter keeps the decision), then gone from the Session: resolved.
    differ.decisions.set(request.id, { decision: "accept" });
    const closed = diff(differ, { ...running, approvals: [] }, now);
    expect((closed[0] as { runtimeRequest: { status: string; decision: string } }).runtimeRequest).toMatchObject({ status: "resolved", decision: "accept" });
    // Another one withdrawn without an answer (Stop): cancelled.
    diff(differ, { ...running, approvals: [{ ...approval, requestId: "43" }] }, now);
    const withdrawn = diff(differ, { ...running, approvals: [] }, now);
    expect((withdrawn[0] as { runtimeRequest: { status: string } }).runtimeRequest.status).toBe("cancelled");
  });

  it("opens a T3 tool's approval as a permission request, and a command's as a command (step 3)", () => {
    const turnId = Object.keys(state.turns)[0]!;
    const differ = withTurns();
    const running = { ...state, entries: [], turns: { [turnId]: { ...state.turns[turnId]!, status: "running" as const } } };
    const base = { turn: turnId, callId: "call-1", summary: "delegate_task {}", createdAt: Date.parse("2026-11-10T21:19:00.000Z") };
    const opened = diff(differ, {
      ...running,
      approvals: [
        { ...base, requestId: "m", tool: "mcp__t3-code__delegate_task", kind: "mcp-tool" as const },
        { ...base, requestId: "p", tool: "bash", kind: "command" as const },
      ],
    }, now);
    const kinds = opened.flatMap((event) => (event.type === "runtime_request.updated" ? [event.runtimeRequest.kind] : []));
    expect(kinds).toEqual(["permission", "command"]);
    const titles = opened.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem.title] : []));
    expect(titles).toEqual(["Allow mcp__t3-code__delegate_task?", "Allow bash?"]);
  });

  it("opens an ask_user question as t3's user_input request, resolves it with the answer, cancels it when withdrawn (step 3)", () => {
    const turnId = Object.keys(state.turns)[0]!;
    const differ = withTurns();
    const running = { ...state, entries: [], turns: { [turnId]: { ...state.turns[turnId]!, status: "running" as const } } };
    const question = { requestId: "q1", turn: turnId, callId: "ask-1", question: "Which color?", options: ["red", "blue"], allowFreeText: false, createdAt: Date.parse("2026-11-10T21:19:00.000Z") };
    const opened = diff(differ, { ...running, approvals: [], questions: [question] }, now);
    expect(types(opened)).toEqual(["runtime_request.updated", "node.updated", "turn_item.updated"]);
    const request = (opened[0] as { runtimeRequest: { id: string; kind: string; status: string } }).runtimeRequest;
    expect(request).toMatchObject({ kind: "user_input", status: "pending" });
    expect((opened[1] as { node: { kind: string } }).node.kind).toBe("user_input_request");
    const item = (opened[2] as { turnItem: { type: string; questions: ReadonlyArray<{ id: string; question: string; options: ReadonlyArray<{ value: string }>; allowCustomAnswer: boolean }> } }).turnItem;
    expect(item.type).toBe("user_input_request");
    expect(item.questions[0]).toMatchObject({ id: "q1", question: "Which color?", allowCustomAnswer: false });
    expect(item.questions[0]!.options.map((option) => option.value)).toEqual(["red", "blue"]);
    expect(approvalIdOf("thread:test", request.id)).toBe("q1");
    differ.decisions.set(request.id, { decision: "accept", answers: { q1: "blue" } });
    const closed = diff(differ, { ...running, approvals: [], questions: [] }, now);
    expect((closed[0] as { runtimeRequest: { status: string; answers: unknown } }).runtimeRequest).toMatchObject({ status: "resolved", answers: { q1: "blue" } });
    diff(differ, { ...running, approvals: [], questions: [{ ...question, requestId: "q2" }] }, now);
    const withdrawn = diff(differ, { ...running, approvals: [], questions: [] }, now);
    expect((withdrawn[0] as { runtimeRequest: { status: string } }).runtimeRequest.status).toBe("cancelled");
  });

  it("opens an MCP server's confirmation as t3's mcp-elicitation card, and its form as a user_input card with its questions (SPI-1079)", () => {
    const turnId = Object.keys(state.turns)[0]!;
    const differ = withTurns();
    const running = { ...state, entries: [], turns: { [turnId]: { ...state.turns[turnId]!, status: "running" as const } } };
    const createdAt = Date.parse("2026-11-10T21:19:00.000Z");
    const approval = { requestId: "t3flare-elicit-a", turn: turnId, callId: "c", tool: "fixture", kind: "mcp-elicitation" as const, title: "fixture asks", summary: "Delete it?", options: [{ decision: "accept" as const, label: "Approve" }], createdAt };
    const form = { requestId: "t3flare-elicit-f", turn: turnId, callId: "c", question: "fixture asks", options: [], allowFreeText: false, questions: [{ id: "colour", header: "Colour", question: "Colour?", options: [{ label: "red", description: "red", value: "red" }] }], createdAt };
    const opened = diff(differ, { ...running, approvals: [approval], questions: [form] }, now);
    expect(opened.flatMap((event) => (event.type === "runtime_request.updated" ? [[event.runtimeRequest.kind, event.runtimeRequest.id.includes("t3flare-elicit")]] : []))).toEqual([
      ["mcp-elicitation", true],
      ["user_input", true],
    ]);
    const items = opened.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem as { type: string; title: string; requestKind?: string; prompt?: string; questions?: ReadonlyArray<{ id: string }> }] : []));
    expect(items[0]).toMatchObject({ type: "approval_request", title: "fixture asks", requestKind: "mcp-elicitation", prompt: "Delete it?" });
    expect(items[1]).toMatchObject({ type: "user_input_request", title: "fixture asks" });
    expect(items[1]?.questions?.map((question) => question.id)).toEqual(["colour"]);
  });

  it("shows a call of t3's own tool as t3 shows it for its Pi provider (step 3)", () => {
    const turnId = Object.keys(state.turns)[0]!;
    const differ = withTurns();
    const running = { ...state, turns: { [turnId]: { ...state.turns[turnId]!, status: "running" as const } } };
    const call = { type: "toolCall", id: "mcp-1", name: "mcp__t3-code__t3_thread_list", arguments: {} };
    const entries = [
      { id: "900", kind: "message", byTaskId: null, turn: turnId, role: "assistant" as const, content: [call], stopReason: "toolUse" },
      { id: "901", kind: "message", byTaskId: null, turn: turnId, role: "toolResult" as const, content: [{ type: "text", text: "{\"threads\":[]}" }], toolCallId: "mcp-1", toolName: call.name, isError: false },
    ];
    const events = diff(differ, { ...running, entries }, now);
    const item = events.flatMap((event) => (event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool" ? [event.turnItem] : [])).at(-1) as
      | { toolName: string; toolSource?: unknown; title?: string; status: string }
      | undefined;
    // A known T3 tool gets no presentation fields: t3's clients present it from its `mcp__t3-code__` name.
    expect(item?.toolName).toBe("mcp__t3-code__t3_thread_list");
    expect(item?.toolSource).toBeUndefined();
    expect(item?.title).toBe("mcp__t3-code__t3_thread_list");
    expect(item?.status).toBe("completed");
  });

  it("maps a recorded tool turn (step 2a M3) with each call's result arriving in a later push than the call", () => {
    const tools = recordedTools as unknown as SessionState;
    const differ = makeDifferState("thread:test");
    Object.entries(tools.turns).forEach(([providerTurnId, turn], index) => {
      differ.turns.set(providerTurnId, {
        providerTurnId,
        threadId: "thread-1",
        runId: turn.runId,
        rootNodeId: `node:${index}`,
        providerThreadId: "provider-thread-1",
        runOrdinal: index + 1,
        providerTurnOrdinal: index + 1,
        startedAt: now,
        providerTurn: { id: providerTurnId, providerThreadId: "provider-thread-1", nodeId: `node:${index}`, runAttemptId: turn.attemptId, nativeTurnRef: null, ordinal: index + 1, status: "running", startedAt: now, completedAt: null },
        contextWindow: 400_000,
        providerSessionId: "provider-session-1",
      } as unknown as TurnContext);
    });
    const firstResult = tools.entries.findIndex((entry) => entry.role === "toolResult");
    const live = Object.fromEntries(Object.entries(tools.turns).map(([id, turn]) => [id, { ...turn, status: "running" as const }]));
    const pathOut = (path: string) => path.replace(/^\/workspace\/repo(?=\/|$)/, "/w/fixture");
    const textOut = (text: string) => text.replaceAll("/workspace/repo", "/w/fixture");
    const events = [
      ...diff(differ, { ...tools, entries: tools.entries.slice(0, firstResult), turns: live }, now, pathOut, textOut),
      ...diff(differ, { ...tools, entries: tools.entries.slice(firstResult) }, now, pathOut, textOut),
    ];
    const items = new Map(events.flatMap((event) => (event.type === "turn_item.updated" ? [[event.turnItem.id, event.turnItem] as const] : [])));
    const finals = [...items.values()];
    const edit = finals.find((item) => item.type === "file_change") as { fileName: string; diffStr?: string; status: string } | undefined;
    expect(edit?.fileName).toBe("/w/fixture/src/greeting.txt");
    expect(edit?.diffStr).toContain("+Hello from M3.");
    expect(edit?.status).toBe("completed");
    const bash = finals.find((item) => item.type === "command_execution") as { input: string; output?: string; exitCode?: number } | undefined;
    expect(bash).toMatchObject({ input: "cd /w/fixture && bash test.sh", output: "all checks passed\n", exitCode: 0 });
    expect(events.filter((event) => event.type === "turn.terminal").length).toBe(1);
  });

  it("a failed turn's error item is the one t3 makes from its terminal, so the thread shows the failure once", () => {
    // t3's ingestor turns a failed `turn.terminal` into an error item of its own (ProviderEventIngestor.ts,
    // `makeProviderFailureTurnItem`); the item the differ emits must be that item, not a second one.
    const turnId = Object.keys(state.turns)[0]!;
    const detail = `429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model m are cooling down via provider claude (reset after 2m0s)"}}`;
    const events = diff(withTurns(), { ...state, entries: [], turns: { [turnId]: { ...state.turns[turnId]!, status: "failed", reason: "model_error", detail } } }, now);
    const errors = events.flatMap((event) => (event.type === "turn_item.updated" && event.turnItem.type === "error" ? [event.turnItem] : []));
    const terminal = events.find((event) => event.type === "turn.terminal");
    if (terminal?.type !== "turn.terminal" || terminal.status !== "failed") throw new Error("no failed terminal");
    const ingested = makeProviderFailureTurnItem({
      driver: terminal.driver,
      threadId: errors[0]!.threadId,
      runId: errors[0]!.runId,
      nodeId: errors[0]!.nodeId,
      providerThreadId: terminal.providerThreadId,
      providerTurnId: terminal.providerTurnId,
      itemOrdinal: terminal.failureItemOrdinal,
      failure: terminal.failure,
      occurredAt: now,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe(ingested.id);
    expect(errors[0]!.ordinal).toBe(ingested.ordinal);
  });

  it("a turn the Session aborted at the 2 h cap ends failed, with the deadline's reason", () => {
    const turnId = Object.keys(state.turns)[0]!;
    const differ = withTurns();
    const events = diff(differ, { ...state, entries: [], turns: { [turnId]: { ...state.turns[turnId]!, status: "aborted", reason: "turn_deadline" } } }, now);
    const terminal = events.find((event) => event.type === "turn.terminal") as { status: string; failure: { code: string } | null } | undefined;
    expect(terminal?.status).toBe("failed");
    expect(terminal?.failure?.code).toBe("turn_deadline");
  });
});
