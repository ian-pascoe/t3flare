// The pi-harness ports in t3's thread (SPI-1054 web, SPI-1055 todo, SPI-1056 context): the items the differ makes of
// their calls, each checked against t3's own schema (t3's decoder, not a cast).
import { OrchestrationV2PlanArtifact, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { PushedEntry, SessionState } from "@t3flare/session-protocol";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { diff, makeDifferState, type DifferState, type TurnContext } from "../src/provider/differ.ts";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00.000Z");
const TURN = "provider-turn-1";
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

const differ = (): DifferState => {
  const state = makeDifferState("thread:ports");
  state.turns.set(TURN, {
    providerTurnId: TURN,
    threadId: "thread-1",
    runId: "run-1",
    rootNodeId: "node:root",
    providerThreadId: "provider-thread-1",
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    startedAt: now,
    providerTurn: { id: TURN, providerThreadId: "provider-thread-1", nodeId: "node:root", runAttemptId: "attempt-1", nativeTurnRef: null, ordinal: 1, status: "running", startedAt: now, completedAt: null },
    contextWindow: 400_000,
    providerSessionId: "provider-session-1",
  } as unknown as TurnContext);
  return state;
};

const call = (id: string, name: string, args: Record<string, unknown>, entryId: string): PushedEntry => ({
  id: entryId,
  kind: "pi.assistant",
  byTaskId: `task-${entryId}`,
  turn: TURN,
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});

const result = (id: string, name: string, text: string, details: unknown, entryId: string, isError = false): PushedEntry => ({
  id: entryId,
  kind: "pi.tool-result",
  byTaskId: null,
  turn: TURN,
  role: "toolResult",
  content: [{ type: "text", text }],
  toolCallId: id,
  toolName: name,
  isError,
  details,
});

export const sessionWith = (entries: ReadonlyArray<PushedEntry>, extra: Partial<SessionState> = {}): SessionState => ({
  sessionId: "thread:ports",
  epoch: "e",
  entries,
  more: false,
  live: { run: { taskId: "run-task", turn: TURN }, generation: null, tools: [], runFailure: null },
  agent: { model: null, thinking: null },
  usage: null,
  inbox: { pending: 0 },
  approvals: [],
  turns: { [TURN]: { submissionId: "s", runId: "run-1", attemptId: "attempt-1", status: "running", startedAt: 0 } },
  ...extra,
});

const items = (events: ReturnType<typeof diff>) => events.flatMap((event) => (event.type === "turn_item.updated" ? [decodeItem(event.turnItem)] : []));

describe("web tools in t3's thread (SPI-1054)", () => {
  it("shows web_search as t3's web search item, with the query and each page found", () => {
    const events = diff(
      differ(),
      sessionWith([
        call("c1", "web_search", { query: "pi durable" }, "1"),
        result("c1", "web_search", "Title: One…", { provider: "model-proxy:claude-haiku-5-5", query: "pi durable", results: [{ url: "https://a.example/one", title: "One", snippet: "agents" }, { url: "" }] }, "2"),
      ]),
      now,
    );
    const [item] = items(events);
    expect(item).toMatchObject({ type: "web_search", status: "completed", title: null, patterns: ["pi durable"], results: [{ url: "https://a.example/one", title: "One", snippet: "agents" }] });
  });

  it("shows web_fetch as a fetched page, and a failed call as a tool item with its error", () => {
    const events = diff(
      differ(),
      sessionWith([
        call("c1", "web_fetch", { url: "https://example.com/a" }, "1"),
        result("c1", "web_fetch", "# Hello", { url: "https://example.com/a", title: "Hello", snippet: "# Hello" }, "2"),
        call("c2", "web_fetch", { url: "http://127.0.0.1/" }, "3"),
        result("c2", "web_fetch", "Unable to fetch http://127.0.0.1/: blocked: loopback address", undefined, "4", true),
      ]),
      now,
    );
    const [fetched, failed] = items(events);
    expect(fetched).toMatchObject({ type: "web_search", title: "Fetched a page", patterns: ["https://example.com/a"], results: [{ url: "https://example.com/a", title: "Hello" }] });
    expect(failed).toMatchObject({ type: "dynamic_tool", status: "failed", toolName: "web_fetch" });
  });
});

describe("the Todo List in t3's thread (SPI-1055)", () => {
  const todo = (rev: number, statuses: ReadonlyArray<"pending" | "active" | "completed">) => ({
    rev,
    tasks: statuses.map((status, index) => ({ id: index + 1, title: `Task ${index + 1}`, status })),
  });

  it("shows each change as a todo_list row and the turn's plan, without the todo calls themselves", () => {
    const state = differ();
    const first = diff(
      state,
      sessionWith([call("c1", "todo", { action: "add", tasks: [{ title: "Task 1" }, { title: "Task 2" }] }, "1"), result("c1", "todo", "Added 2 Tasks", { todoRev: 1 }, "2")], {
        todo: todo(1, ["pending", "pending"]),
      }),
      now,
    );
    const [row] = items(first);
    expect(items(first)).toHaveLength(1);
    expect(row).toMatchObject({ type: "todo_list", title: "Todo list", steps: [{ id: "todo:1", text: "Task 1", status: "pending" }, { id: "todo:2", status: "pending" }] });
    const plan = first.find((event) => event.type === "plan.updated");
    expect(plan).toMatchObject({ plan: { kind: "todo_list", status: "active", threadId: "thread-1", runId: "run-1" } });
    expect(() => Schema.decodeUnknownSync(OrchestrationV2PlanArtifact)((plan as { plan: unknown }).plan)).not.toThrow();
    // The same revision again: nothing; a new one: a new row on the same plan, its active Task running.
    expect(diff(state, sessionWith([], { todo: todo(1, ["pending", "pending"]) }), now)).toEqual([]);
    const second = diff(state, sessionWith([], { todo: todo(2, ["completed", "active"]) }), now);
    const [next] = items(second);
    expect(next?.id).not.toBe(row?.id);
    expect(next).toMatchObject({ steps: [{ status: "completed" }, { status: "running" }] });
    expect(second.find((event) => event.type === "plan.updated")).toMatchObject({ plan: { id: (plan as { plan: { id: string } }).plan.id } });
    const done = diff(state, sessionWith([], { todo: todo(3, ["completed", "completed"]) }), now);
    expect(done.find((event) => event.type === "plan.updated")).toMatchObject({ plan: { status: "completed" } });
  });

  it("keeps a failed todo call as a tool item, and shows no list outside a live turn", () => {
    const failed = diff(differ(), sessionWith([call("c1", "todo", { action: "remove", id: 9 }, "1"), result("c1", "todo", "Todo remove failed: Task #9 was not found", undefined, "2", true)]), now);
    expect(items(failed)).toMatchObject([{ type: "dynamic_tool", status: "failed", toolName: "todo" }]);
    const settled = sessionWith([], { todo: todo(1, ["pending"]), live: { run: null, generation: null, tools: [], runFailure: null }, turns: {} });
    expect(diff(differ(), settled, now)).toEqual([]);
  });
});

describe("context management in t3's thread (SPI-1056)", () => {
  it("shows Notes, History and a Rollover as tool items titled by what they did", () => {
    const events = diff(
      differ(),
      sessionWith([
        call("c1", "context_notes", { action: "write", name: "plan", content: "step 1" }, "1"),
        result("c1", "context_notes", '{"action":"write","name":"plan","saved":true}', undefined, "2"),
        call("c2", "context_history", { action: "search", query: "plan" }, "3"),
        result("c2", "context_history", '{"matches":[],"next_offset":null}', undefined, "4"),
        call("c3", "context_rollover", { handoff: "Continue with step 2" }, "5"),
        result("c3", "context_rollover", "Handoff saved. The new context starts from it after this tool round.", { handoffCharacters: 20, notes: 1 }, "6"),
      ]),
      now,
    );
    expect(items(events).map((item) => [item.type, item.title])).toEqual([
      ["dynamic_tool", 'Notes: write "plan"'],
      ["dynamic_tool", "History: search"],
      ["dynamic_tool", "Context rollover: the agent hands off to a fresh context"],
    ]);
  });
});
