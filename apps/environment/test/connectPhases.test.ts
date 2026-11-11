// Step 3+ (P3, plan section 4.1): what the owner's phone hears for each way a Durable agent run goes. The thread
// shells are what t3 projects from the differ's events (run status; the pending request's kind, from `requestKindOf`
// and `questionView` in provider/differ.ts); t3's own `projectThreadAwarenessV2` and publisher sanitising decide the
// phase. A bump that changes the mapping fails here. Proven against the real relay on the stage in M2.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

const shell = (overrides: Record<string, unknown>) =>
  ({
    id: "thread-1" as ThreadId,
    lineage: { rootThreadId: "thread-1" as ThreadId, parentThreadId: null, relationshipToParent: null },
    title: "Fix the flaky test",
    modelSelection: { instanceId: ProviderInstanceId.make("piDurable"), model: "claude-sonnet" },
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    settledOverride: null,
    updatedAt: DateTime.makeUnsafe("2026-11-11T12:00:00.000Z"),
    ...overrides,
  }) as never;

const phaseOf = (overrides: Record<string, unknown>) => {
  const state = projectThreadAwarenessV2({ environmentId: "env-1" as EnvironmentId, project: { title: "t3flare" }, thread: shell(overrides) });
  return state === null ? null : { phase: state.phase, headline: state.headline };
};

const request = (kind: string) => ({ id: "request-1", kind, status: "pending" });

describe("what a Durable agent run publishes (plan section 4.1)", () => {
  it("a turn starting and running: starting, then running (no alert)", () => {
    expect(phaseOf({ status: "starting", activityRunStatus: "starting" })).toEqual({ phase: "starting", headline: "Starting agent" });
    expect(phaseOf({})).toEqual({ phase: "running", headline: "Agent is working" });
  });

  it("an approval of each kind the differ raises (bash, an edit, permission, mcp-tool, git-push): Approval needed", () => {
    for (const kind of ["command", "file-change", "permission"]) {
      expect(phaseOf({ status: "waiting", activityRunStatus: "waiting", pendingRuntimeRequest: request(kind) }), kind).toEqual({
        phase: "waiting_for_approval",
        headline: "Approval needed",
      });
    }
  });

  it("an ask_user question: waiting for input", () => {
    expect(phaseOf({ status: "waiting", activityRunStatus: "waiting", pendingRuntimeRequest: request("user_input") })?.phase).toBe("waiting_for_input");
  });

  it("an answered turn: completed; a failed one, a usage limit included: failed", () => {
    expect(phaseOf({ status: "completed", activityRunStatus: "completed" })?.phase).toBe("completed");
    expect(phaseOf({ status: "failed", activityRunStatus: "failed" })?.phase).toBe("failed");
  });

  it("the owner's Stop: nothing (a tombstone), whether it lands as interrupted or a stopped completion", () => {
    expect(phaseOf({ status: "interrupted", activityRunStatus: "interrupted" })).toBeNull();
    expect(phaseOf({ status: "cancelled", activityRunStatus: "cancelled" })).toBeNull();
    expect(phaseOf({ status: "completed", activityRunStatus: "completed", latestRunStopRequested: true })).toBeNull();
  });

  it("a linked thread (delegated from the laptop) publishes like any top-level thread (D4)", () => {
    expect(phaseOf({ status: "completed", activityRunStatus: "completed", delegatedFrom: { environmentId: "laptop" } })?.phase).toBe("completed");
  });
});
