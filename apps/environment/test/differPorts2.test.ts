// The second pi-harness ports in t3's thread (SPI-1057 terminals, SPI-1058 guardian, SPI-1059 advisor): the items the
// differ makes of their calls and entries, each checked against t3's own schema (t3's decoder, not a cast).
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
  const state = makeDifferState("thread:ports2");
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

const entry = (kind: string, details: unknown, entryId: string, role: PushedEntry["role"] = "user"): PushedEntry => ({
  id: entryId,
  kind,
  byTaskId: null,
  turn: TURN,
  role,
  content: role === "user" ? [{ type: "text", text: "for the model" }] : [],
  details,
});

const sessionWith = (entries: ReadonlyArray<PushedEntry>, extra: Partial<SessionState> = {}): SessionState => ({
  sessionId: "thread:ports2",
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

const run = (entries: ReadonlyArray<PushedEntry>, extra: Partial<SessionState> = {}) => items(diff(differ(), sessionWith(entries, extra), now));

describe("terminals in t3's thread (SPI-1057)", () => {
  it("shows terminal_start and typing as commands with the screen, and reads, stops and lists as titled tool items", () => {
    const shown = run([
      call("c1", "terminal_start", { command: "python3" }, "1"),
      result("c1", "terminal_start", "t1 running · settled: quiet · cursor 1:5\n--- screen ---\n>>> ", { id: "t1", state: "running" }, "2"),
      call("c2", "terminal_send", { id: "t1", text: "1+1\n" }, "3"),
      result("c2", "terminal_send", "t1 running · settled: quiet · cursor 3:5\n--- screen ---\n>>> 1+1\n2\n>>> ", { id: "t1" }, "4"),
      call("c3", "terminal_send", { id: "t1", wait_ms: 100 }, "5"),
      result("c3", "terminal_send", "t1 running · settled: timeout · screen unchanged · cursor 3:5", { id: "t1" }, "6"),
      call("c4", "terminal_stop", { id: "t1" }, "7"),
      result("c4", "terminal_stop", "Terminal t1 stopped · cursor 3:5", { id: "t1", state: "exited", exit_code: 130 }, "8"),
      call("c5", "terminal_list", {}, "9"),
      call("c6", "terminal_start", { command: "false" }, "10"),
      result("c6", "terminal_start", "t2 exited with code 1 · settled: exited", { id: "t2", state: "exited", exit_code: 1 }, "11"),
    ]);
    expect(shown.map((item) => [item.type, item.title])).toEqual([
      ["command_execution", "Terminal t1"],
      ["command_execution", "Typed into t1"],
      ["dynamic_tool", "Read t1"],
      ["dynamic_tool", "Stopped t1"],
      ["dynamic_tool", "Terminals and Background jobs"],
      ["command_execution", "Terminal t2"],
    ]);
    expect(shown[0]).toMatchObject({ input: "python3", output: "t1 running · settled: quiet · cursor 1:5\n--- screen ---\n>>> " });
    expect(shown[1]).toMatchObject({ input: 't1 ⟵ "1+1\\n"' });
    expect(shown[5]).toMatchObject({ exitCode: 1, status: "completed" });
  });
});

describe("the ports' notices in t3's thread (SPI-1057, SPI-1058, SPI-1059)", () => {
  it("shows an Advisor finding, a Guardian rejection and a Terminal's exit as system notices", () => {
    const shown = run([
      entry("t3flare.advice", { severity: "concern", message: "The tests were never run after the edit.", evidence: { refs: ["abc"] } }, "1"),
      entry("t3flare.guardian", { tool: "bash", result: "rejected", reason: "Risk: high (destruction). Authorization: low.\nReason: deletes the repo" }, "2", "other"),
      entry("t3flare.terminal-exit", { text: "Background job b1 exited with code 0 after 3s: npm test\nLog: /tmp/x.log" }, "3"),
      entry("t3flare.advice", { nothing: true }, "4"),
    ]);
    expect(shown.map((item) => [item.type, item.title, "message" in item ? item.message : undefined])).toEqual([
      ["system_notice", "Advisor concern", "The tests were never run after the edit."],
      ["system_notice", "Guardian blocked bash", "Risk: high (destruction). Authorization: low.\nReason: deletes the repo"],
      ["system_notice", "Background job b1 exited with code 0 after 3s: npm test", "Background job b1 exited with code 0 after 3s: npm test\nLog: /tmp/x.log"],
    ]);
  });
});
