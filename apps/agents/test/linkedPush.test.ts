// Owner decision D1 (step 3): what the git credential helper's request gets while linked work is active in a Workspace.
import { describe, expect, it } from "vitest";

import { credentialDecision, LINKED_WORK_MS, prunedLinkedWork } from "../src/workspace/linkedPush.ts";

const now = 1_800_000_000_000;

describe("the credential helper's token while linked work is active (D1)", () => {
  it("is the Workspace's token when no linked work is active, whatever git does", () => {
    expect(credentialDecision({}, now, "push")).toEqual({ kind: "token" });
    expect(credentialDecision({ "thread:old": now - 1 }, now, null)).toEqual({ kind: "token" });
  });

  it("is a read-only token for a fetch during linked work", () => {
    expect(credentialDecision({ "thread:l": now + LINKED_WORK_MS }, now, "fetch")).toEqual({ kind: "read-only" });
  });

  it("asks the latest linked Session for a push, and for anything it cannot tell is a fetch", () => {
    const linked = { "thread:a": now + 1_000, "thread:b": now + 5_000, "thread:gone": now - 5 };
    expect(credentialDecision(linked, now, "push")).toEqual({ kind: "ask", session: "thread:b" });
    expect(credentialDecision(linked, now, "unknown")).toEqual({ kind: "ask", session: "thread:b" });
    expect(credentialDecision(linked, now, null)).toEqual({ kind: "ask", session: "thread:b" });
  });

  it("forgets linked work that no longer counts", () => {
    expect(prunedLinkedWork({ a: now - 1, b: now + 1 }, now)).toEqual({ b: now + 1 });
  });
});
