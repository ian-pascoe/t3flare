// The pi-harness ports in t3's thread (SPI-1054 web, SPI-1055 todo, SPI-1056 context): the items the differ makes of
// their calls, each checked against t3's own schema (t3's decoder, not a cast).
import { OrchestrationV2TurnItem } from "@t3tools/contracts";
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
