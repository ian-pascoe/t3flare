// SPI-996 (parity G5): plan mode's proposed plan and a running command's live output, as the differ emits them, each
// event decoded with t3's own schemas (the provider event union, its turn item and plan artifact), and the capabilities
// and presentation that turn them on.
import { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { PROPOSE_PLAN_TOOL, type PushedEntry, type SessionState, type ToolSlotSlim } from "@t3flare/session-protocol";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { PI_DURABLE_DRIVER, PiDurableCapabilities } from "../src/provider/capabilities.ts";
import { diff, forgetProposedPlan, makeDifferState, sharedTail, SKIPPED_OUTPUT, type DifferState, type TurnContext } from "../src/provider/differ.ts";
import { PRESENTATION } from "../src/provider/driver.ts";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00.000Z");
const TURN = "provider-turn-1";
const decodeEvent = Schema.decodeUnknownSync(ProviderAdapterV2Event);

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

const result = (id: string, name: string, text: string, entryId: string, isError = false): PushedEntry => ({
  id: entryId,
  kind: "pi.tool-result",
  byTaskId: null,
  turn: TURN,
  role: "toolResult",
  content: [{ type: "text", text }],
  toolCallId: id,
  toolName: name,
  isError,
});

const sessionWith = (entries: ReadonlyArray<PushedEntry>, extra: Partial<SessionState> = {}): SessionState => ({
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

/** Every event, decoded with t3's provider event schema (a shape t3 rejects fails here). */
const decoded = (events: ReturnType<typeof diff>) => events.map((event) => decodeEvent(event));

const withTools = (entries: ReadonlyArray<PushedEntry>, tools: ReadonlyArray<ToolSlotSlim>): SessionState =>
  sessionWith(entries, { live: { run: { taskId: "run-task", turn: TURN }, generation: null, tools, runFailure: null } });

describe("capabilities and presentation (SPI-996)", () => {
  it("are t3's capability shape, with plan mode, the proposed plan and streamed tool output on", () => {
    const capabilities = Schema.decodeUnknownSync(OrchestrationV2ProviderCapabilities)(PiDurableCapabilities);
    expect(capabilities.planning.emitsProposedPlan).toBe(true);
    expect(capabilities.streaming.streamsToolOutput).toBe(true);
    expect(PRESENTATION.showInteractionModeToggle).toBe(true);
  });
});

describe("plan mode's proposed plan (SPI-996)", () => {
  const PLAN = "# Add a cache\n\n1. Read the config.\n2. Add the cache.";

  it("shows a taken propose_plan as t3's proposed plan: a plan node, a proposed_plan item and an active plan artifact", () => {
    const events = decoded(diff(differ(), sessionWith([call("p1", PROPOSE_PLAN_TOOL, { plan: `  ${PLAN}\n` }, "1"), result("p1", PROPOSE_PLAN_TOOL, "captured", "2")]), now));
    const node = events.find((event) => event.type === "node.updated");
    const item = events.find((event) => event.type === "turn_item.updated");
    const plan = events.find((event) => event.type === "plan.updated");
    expect(node).toMatchObject({ node: { kind: "plan", status: "completed" } });
    expect(item).toMatchObject({ turnItem: { type: "proposed_plan", markdown: PLAN, streaming: false, status: "completed" } });
    expect(plan).toMatchObject({ plan: { kind: "proposed_plan", status: "active", markdown: PLAN, threadId: "thread-1", runId: "run-1" } });
    if (item?.type !== "turn_item.updated" || item.turnItem.type !== "proposed_plan" || plan?.type !== "plan.updated" || node?.type !== "node.updated") throw new Error("missing");
    expect(item.turnItem.planId).toBe(plan.plan.id);
    expect(plan.plan.nodeId).toBe(node.node.id);
    expect(events.some((event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool")).toBe(false);
  });

  it("shows nothing until the Session took the call, and the same plan once across re-diffs", () => {
    const state = differ();
    expect(diff(state, sessionWith([call("p1", PROPOSE_PLAN_TOOL, { plan: PLAN }, "1")]), now)).toEqual([]);
    const taken = sessionWith([call("p1", PROPOSE_PLAN_TOOL, { plan: PLAN }, "1"), result("p1", PROPOSE_PLAN_TOOL, "captured", "2")]);
    expect(diff(state, taken, now).filter((event) => event.type === "plan.updated")).toHaveLength(1);
    expect(diff(state, taken, now)).toEqual([]);
  });

  it("supersedes the plan it proposed before, unless a default-mode turn has since left it to t3", () => {
    const state = differ();
    diff(state, sessionWith([call("p1", PROPOSE_PLAN_TOOL, { plan: "# One" }, "1"), result("p1", PROPOSE_PLAN_TOOL, "captured", "2")]), now);
    const revised = decoded(diff(state, sessionWith([call("p2", PROPOSE_PLAN_TOOL, { plan: "# Two" }, "3"), result("p2", PROPOSE_PLAN_TOOL, "captured", "4")]), now));
    const plans = revised.flatMap((event) => (event.type === "plan.updated" && event.plan.kind === "proposed_plan" ? [event.plan] : []));
    expect(plans.map((plan) => [plan.markdown, plan.status])).toEqual([
      ["# One", "superseded"],
      ["# Two", "active"],
    ]);
    forgetProposedPlan(state);
    const later = diff(state, sessionWith([call("p3", PROPOSE_PLAN_TOOL, { plan: "# Three" }, "5"), result("p3", PROPOSE_PLAN_TOOL, "captured", "6")]), now);
    expect(later.flatMap((event) => (event.type === "plan.updated" ? [event.plan.status] : []))).toEqual(["active"]);
  });

  it("shows a refused call (outside plan mode) as a tool item with its error", () => {
    const events = decoded(diff(differ(), sessionWith([call("p1", PROPOSE_PLAN_TOOL, { plan: PLAN }, "1"), result("p1", PROPOSE_PLAN_TOOL, "Refused: not plan mode", "2", true)]), now));
    expect(events.some((event) => event.type === "plan.updated")).toBe(false);
    expect(events.find((event) => event.type === "turn_item.updated")).toMatchObject({ turnItem: { type: "dynamic_tool", toolName: PROPOSE_PLAN_TOOL, status: "failed" } });
  });
});

describe("a running command's live output (SPI-996)", () => {
  const bash = call("b1", "bash", { command: "for i in 1 2 3; do echo $i; sleep 1; done" }, "1");
  const running = (output?: string): ToolSlotSlim => ({ callId: "b1", name: "bash", status: "running", ...(output === undefined ? {} : { output }) });
  const deltas = (events: ReturnType<typeof diff>) => decoded(events).flatMap((event) => (event.type === "command_output.delta" ? [event] : []));
  const itemId = IdAllocator.derive.turnItemFromProviderItem({ driver: PI_DURABLE_DRIVER, nativeItemId: "thread:ports:call:b1" });

  it("streams what is new on each push, to the command's own item, as t3's command_output.delta", () => {
    const state = differ();
    const first = diff(state, withTools([bash], [running("1\n")]), now);
    expect(decoded(first).find((event) => event.type === "turn_item.updated")).toMatchObject({ turnItem: { id: itemId, type: "command_execution", status: "running" } });
    expect(deltas(first)).toMatchObject([{ threadId: "thread-1", itemId, chunk: "1\n" }]);
    expect(deltas(diff(state, withTools([bash], [running("1\n2\n")]), now)).map((event) => event.chunk)).toEqual(["2\n"]);
    expect(deltas(diff(state, withTools([bash], [running("1\n2\n")]), now))).toEqual([]);
  });

  it("follows a sliding tail, and marks output a push missed", () => {
    const state = differ();
    diff(state, withTools([bash], [running("aaaa-line-1\nbbbb-line-2\n")]), now);
    expect(deltas(diff(state, withTools([bash], [running("bbbb-line-2\ncccc-line-3\n")]), now)).map((event) => event.chunk)).toEqual(["cccc-line-3\n"]);
    expect(deltas(diff(state, withTools([bash], [running("zzzz-line-9\n")]), now)).map((event) => event.chunk)).toEqual([`${SKIPPED_OUTPUT}zzzz-line-9\n`]);
  });

  it("stops at the result, which carries the whole output on the item", () => {
    const state = differ();
    diff(state, withTools([bash], [running("1\n")]), now);
    const done = decoded(diff(state, withTools([bash, result("b1", "bash", "1\n2\n3\n", "2")], [{ callId: "b1", name: "bash", status: "done" }]), now));
    expect(done.some((event) => event.type === "command_output.delta")).toBe(false);
    expect(done.find((event) => event.type === "turn_item.updated")).toMatchObject({ turnItem: { type: "command_execution", status: "completed", output: "1\n2\n3\n" } });
    expect(state.liveOutput.size).toBe(0);
  });

  it("streams only commands: another tool's running output stays on its result", () => {
    const events = diff(differ(), withTools([call("r1", "read", { path: "/workspace/repo/a" }, "1")], [{ callId: "r1", name: "read", status: "running", output: "text" }]), now);
    expect(events.some((event) => event.type === "command_output.delta")).toBe(false);
  });

  it("finds the shared part of two tails", () => {
    expect(sharedTail("", "abc")).toBe(0);
    expect(sharedTail("ab", "abc")).toBe(2);
    expect(sharedTail("0123456789", "6789xyz")).toBe(4);
    expect(sharedTail("abc", "xyz")).toBe(0);
    const long = Array.from({ length: 200 }, (_, index) => `line ${index}\n`).join("");
    expect(sharedTail(long, `${long.slice(1_000)}more\n`)).toBe(long.length - 1_000);
  });
});
