// Code mode's nested calls as child items (ADR-0027, plan §2.5): the script's call is one item, each nested call a child
// with `parentItemId` and `parentNodeId` derived as t3's Pi provider derives them (provider-pi adapter.ts:922-975), ids
// stable from the live slot to the committed `details.calls`, an `omittedCalls` count as one more child.
import type { PushedEntry, SessionState } from "@t3flare/session-protocol";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { PI_DURABLE_DRIVER } from "../src/provider/capabilities.ts";
import { diff, makeDifferState, type TurnContext } from "../src/provider/differ.ts";

const now = DateTime.makeUnsafe("2026-11-12T10:00:00.000Z");
const SESSION = "thread:test";

const differ = () => {
  const state = makeDifferState(SESSION);
  state.turns.set("turn-1", {
    providerTurnId: "turn-1",
    threadId: "thread-1",
    runId: "run-1",
    rootNodeId: "node:root",
    providerThreadId: "provider-thread-1",
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    startedAt: now,
    providerTurn: { id: "turn-1", status: "running" },
    contextWindow: 400_000,
    providerSessionId: "provider-session-1",
  } as unknown as TurnContext);
  return state;
};

const call: PushedEntry = {
  id: 1,
  turn: "turn-1",
  role: "assistant",
  byTaskId: "gen-1",
  content: [{ type: "toolCall", id: "cm-1", name: "codemode", arguments: { code: "await tools.bash({ command: 'npm test' })" } }],
} as unknown as PushedEntry;

const base = (patch: Partial<SessionState>): SessionState =>
  ({
    sessionId: SESSION,
    epoch: "e",
    entries: [call],
    more: false,
    live: { run: { taskId: "run-task", turn: "turn-1" }, generation: null, tools: [{ callId: "cm-1", name: "codemode", status: "running" }], runFailure: null },
    agent: { model: null, thinking: null },
    usage: null,
    inbox: { pending: 0 },
    approvals: [],
    turns: { "turn-1": { submissionId: "s", runId: "run-1", attemptId: "a", status: "running", startedAt: 0 } },
    ...patch,
  }) as SessionState;

const items = (events: ReturnType<typeof diff>) => events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
const nodes = (events: ReturnType<typeof diff>) => events.flatMap((event) => (event.type === "node.updated" ? [event.node] : []));
const itemOf = (nativeItemId: string) => IdAllocator.derive.turnItemFromProviderItem({ driver: PI_DURABLE_DRIVER, nativeItemId });
const nodeOf = (nativeItemId: string) => IdAllocator.derive.nodeFromProviderItem({ driver: PI_DURABLE_DRIVER, nativeItemId });

describe("differ: code mode children", () => {
  it("shows the script as one item and a live nested bash as its child command, as t3's Pi provider nests them", () => {
    const events = diff(
      differ(),
      base({
        live: {
          ...base({}).live,
          nestedTools: [{ callId: "cm-1/c1", parentCallId: "cm-1", name: "bash", args: { command: "npm test" }, status: "running", output: "PASS" }],
        },
      }),
      now,
    );
    const parent = items(events).find((item) => item.nativeItemRef?.nativeId === `${SESSION}:call:cm-1`)!;
    expect(parent).toMatchObject({ type: "dynamic_tool", title: "Code mode", parentItemId: null });
    const child = items(events).find((item) => item.nativeItemRef?.nativeId === `${SESSION}:call:cm-1/c1`)!;
    expect(child).toMatchObject({ type: "command_execution", input: "npm test", status: "running", parentItemId: itemOf(`${SESSION}:call:cm-1`) });
    const childNode = nodes(events).find((node) => node.nativeItemRef?.nativeId === `${SESSION}:call:cm-1/c1`)!;
    expect(childNode.parentNodeId).toBe(nodeOf(`${SESSION}:call:cm-1`));
    expect(child.ordinal).toBeGreaterThan(parent.ordinal);
  });

  it("settles the same child from the committed details, and shows omitted calls as one more child", () => {
    const state = differ();
    const live = base({
      live: { ...base({}).live, nestedTools: [{ callId: "cm-1/c1", parentCallId: "cm-1", name: "bash", args: { command: "npm test" }, status: "running" }] },
    });
    const first = items(diff(state, live, now)).find((item) => item.nativeItemRef?.nativeId === `${SESSION}:call:cm-1/c1`)!;
    const result = {
      id: 2,
      turn: "turn-1",
      role: "toolResult",
      toolCallId: "cm-1",
      toolName: "codemode",
      isError: false,
      content: [{ type: "text", text: "done" }],
      details: {
        calls: [
          { id: 1, name: "bash", args: '{"command":"npm test"}', status: "error", error: "exit 1" },
          { id: 2, name: "edit", args: '{"path":"/workspace/repo/a.ts","edits":[]}', status: "ok" },
        ],
        omittedCalls: { count: 40, failed: 3 },
      },
    } as unknown as PushedEntry;
    const events = diff(state, base({ entries: [result], live: { run: null, generation: null, tools: [], runFailure: null } }), now);
    const settled = items(events);
    const bash = settled.find((item) => item.nativeItemRef?.nativeId === `${SESSION}:call:cm-1/c1`)!;
    expect(bash.id).toBe(first.id);
    expect(bash).toMatchObject({ type: "command_execution", status: "failed" });
    expect(settled.find((item) => item.nativeItemRef?.nativeId === `${SESSION}:call:cm-1/c2`)).toMatchObject({ type: "file_change", status: "completed" });
    expect(settled.find((item) => item.nativeItemRef?.nativeId === `${SESSION}:call:cm-1/omitted`)).toMatchObject({
      type: "dynamic_tool",
      title: "40 more calls (3 failed)",
      parentItemId: itemOf(`${SESSION}:call:cm-1`),
    });
  });
});
