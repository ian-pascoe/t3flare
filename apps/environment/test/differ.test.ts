// The differ on a recorded Session (step 2a plan, tests): a real Session's state, as `GET /_t3flare/agents/session`
// returned it on the `step2a` stage after `scripts/chat.ts` (an answer, a Stop, a steer).
import type { SessionState, TurnState } from "@t3flare/session-protocol";
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

  it("classifies a 429 as a usage limit and keeps the raw text out", () => {
    const limited = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail: "429 {\"error\":\"rate_limit_error\",\"key\":\"sk-secret\"}", startedAt: 0 }, now);
    expect(limited.class).toBe("usage_limit");
    expect(limited.message).not.toContain("sk-secret");
    const other = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail: "400 bad request", startedAt: 0 }, now);
    expect(other.class).toBe("provider_error");
    expect(other.message).toBe("The model provider returned HTTP 400.");
  });

  describe("a model proxy failure the Session classified", () => {
    const nowMs = DateTime.toEpochMillis(now);
    const failed = (failure: NonNullable<TurnState["proxy"]>["failure"], detail = "t3flare model proxy: x") =>
      ({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail, startedAt: 0, settledAt: nowMs, proxy: { requests: 1, failure } }) as TurnState;

    it("is t3's usage limit with the recorded reset, as an ISO time", () => {
      const resetAt = Date.parse("2026-11-10T21:22:00.000Z");
      expect(failureOf(failed({ class: "usage_limit", code: "proxy_cooldown", row: 1, resetAt, stop: true, at: nowMs - 5000 }), now)).toEqual({
        class: "usage_limit",
        message: "Every account the model proxy has for this model is at its usage limit.",
        code: "proxy_cooldown",
        retryable: true,
        resetAt: "2026-11-10T21:22:00.000Z",
      });
    });

    it("holds a reset at least 30 s after now, so t3 arms a resume and it is not instant", () => {
      const failure = failureOf(failed({ class: "usage_limit", code: "proxy_request_rate", row: 4, resetAt: nowMs + 1000, stop: true, at: nowMs }), now);
      expect(failure.resetAt).toBe("2026-11-10T21:20:30.000Z");
      // No ceiling: a monthly spend limit resets weeks away.
      const far = Date.parse("2026-12-01T00:00:00.000Z");
      expect(failureOf(failed({ class: "usage_limit", code: "proxy_spend_limit", row: 3, resetAt: far, stop: true, at: nowMs }), now).resetAt).toBe("2026-12-01T00:00:00.000Z");
    });

    it("a limit with no reset has none, and t3 does not arm a resume", () => {
      const failure = failureOf(failed({ class: "usage_limit", code: "proxy_upstream_limit", row: 2, stop: false, at: nowMs }), now);
      expect(failure).toMatchObject({ class: "usage_limit", code: "proxy_upstream_limit" });
      expect(failure.resetAt ?? null).toBeNull();
    });

    it("a refused key is a permission error that names the key, not retryable, no reset", () => {
      expect(failureOf(failed({ class: "permission_error", code: "proxy_key_rejected", row: 5, stop: true, at: nowMs }), now)).toEqual({
        class: "permission_error",
        message: "The model proxy refused this Environment's key. Check `MODEL_PROXY_API_KEY`.",
        code: "proxy_key_rejected",
        retryable: false,
      });
    });

    it("without the record (an older push), classifies the detail, the reset counted from the settle time", () => {
      const detail = `429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model m are cooling down via provider claude (reset after 2m0s)"}}`;
      const turn = { ...failed(undefined, detail), proxy: undefined, settledAt: nowMs - 60_000 } as TurnState;
      expect(failureOf(turn, now)).toMatchObject({ class: "usage_limit", code: "proxy_cooldown", resetAt: "2026-11-10T21:21:00.000Z" });
      const overloaded = { ...turn, detail: `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` };
      expect(failureOf(overloaded, now)).toMatchObject({ class: "provider_error", code: "proxy_overloaded", retryable: true });
    });
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

  it("a turn the Session aborted at the 2 h cap ends failed, with the deadline's reason", () => {
    const turnId = Object.keys(state.turns)[0]!;
    const differ = withTurns();
    const events = diff(differ, { ...state, entries: [], turns: { [turnId]: { ...state.turns[turnId]!, status: "aborted", reason: "turn_deadline" } } }, now);
    const terminal = events.find((event) => event.type === "turn.terminal") as { status: string; failure: { code: string } | null } | undefined;
    expect(terminal?.status).toBe("failed");
    expect(terminal?.failure?.code).toBe("turn_deadline");
  });
});
