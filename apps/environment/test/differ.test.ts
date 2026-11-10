// The differ on a recorded Session (step 2a plan, tests): a real Session's state, as `GET /_t3flare/agents/session`
// returned it on the `step2a` stage after `scripts/chat.ts` (an answer, a Stop, a steer).
import type { SessionState } from "@t3flare/session-protocol";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { diff, failureOf, makeDifferState, type DifferState, type TurnContext } from "../src/provider/differ.ts";
import recorded from "./fixtures/session-chat.json" with { type: "json" };

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
    const limited = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail: "429 {\"error\":\"rate_limit_error\",\"key\":\"sk-secret\"}", startedAt: 0 });
    expect(limited.class).toBe("usage_limit");
    expect(limited.message).not.toContain("sk-secret");
    const other = failureOf({ submissionId: "1", runId: "r", attemptId: "a", status: "failed", reason: "model_error", detail: "500 upstream", startedAt: 0 });
    expect(other.class).toBe("provider_error");
    expect(other.message).toBe("The model provider returned HTTP 500.");
  });
});
