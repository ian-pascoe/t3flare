// The push gateway's policy (SPI-992; review H1, M2): what a Container's push gets, from the Workspace's linked work,
// its durable taint, t3's own push expectations, and which of the owner's threads could be asked.
import { describe, expect, it } from "vitest";

import { LINKED_WORK_MS, matchExpectation, prunedLinkedWork, pushDecision, type PushExpectation, taintAfter } from "../src/workspace/linkedPush.ts";

const now = 1_800_000_000_000;
const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const update = (ref: string, next: string, old = A) => ({ old, new: next, ref });
const quiet = { linked: {}, taint: null, expectations: [], owners: { sessions: [], cli: [] }, now };

describe("pushDecision", () => {
  it("allows a push in a Workspace that never ran linked work", () => {
    expect(pushDecision({ ...quiet, updates: [update("refs/heads/x", B)] })).toEqual({ kind: "allow", why: "untainted" });
  });

  it("asks the latest live linked thread: a Session, or a CLI thread", () => {
    const linked = { "thread:a": now + 1_000, "thread:b": now + 5_000, "thread:gone": now - 5 };
    const taint = taintAfter(null, "thread:a", now);
    expect(pushDecision({ ...quiet, linked, taint, updates: [update("refs/heads/x", B)] })).toEqual({ kind: "ask", on: { kind: "session", name: "thread:b", linked: true } });
    expect(pushDecision({ ...quiet, linked: { "cli:t1": Number.MAX_SAFE_INTEGER }, taint, updates: [update("refs/heads/x", B)] })).toEqual({ kind: "ask", on: { kind: "cli", thread: "t1", linked: true } });
  });

  it("keeps asking after the window lapsed: the taint lasts until the owner clears it (H1)", () => {
    const taint = taintAfter(null, "thread:a", now - 10 * LINKED_WORK_MS);
    const lapsed = { "thread:a": now - 1 };
    expect(pushDecision({ ...quiet, linked: lapsed, taint, owners: { sessions: ["thread:o"], cli: [] }, updates: [update("refs/heads/x", B)] })).toEqual({ kind: "ask", on: { kind: "session", name: "thread:o", linked: false } });
    expect(pushDecision({ ...quiet, taint, owners: { sessions: [], cli: ["t9"] }, updates: [update("refs/heads/x", B)] })).toEqual({ kind: "ask", on: { kind: "cli", thread: "t9", linked: false } });
  });

  it("refuses with a named message when no thread, or more than one, could be the one pushing", () => {
    const taint = taintAfter(null, "thread:a", now - 10 * LINKED_WORK_MS);
    const none = pushDecision({ ...quiet, taint, updates: [update("refs/heads/x", B)] });
    expect(none.kind).toBe("refuse");
    expect(none.kind === "refuse" && none.reason).toMatch(/ran linked work/);
    expect(pushDecision({ ...quiet, taint, owners: { sessions: ["thread:o"], cli: ["t9"] }, updates: [update("refs/heads/x", B)] }).kind).toBe("refuse");
  });

  it("allows t3's own push when every update is an expectation's, and only that", () => {
    const taint = taintAfter(null, "thread:a", now);
    const expectations: ReadonlyArray<PushExpectation> = [{ id: "e1", updates: [{ ref: "refs/heads/x", new: B }], until: now + 60_000 }];
    const linked = { "thread:a": now + 60_000 };
    expect(pushDecision({ ...quiet, linked, taint, expectations, updates: [update("refs/heads/x", B)] })).toEqual({ kind: "allow", why: "expected", expectation: "e1" });
    // A different commit, another ref, or one more update than t3 asked for: not t3's push.
    expect(pushDecision({ ...quiet, linked, taint, expectations, updates: [update("refs/heads/x", C)] }).kind).toBe("ask");
    expect(pushDecision({ ...quiet, linked, taint, expectations, updates: [update("refs/heads/y", B)] }).kind).toBe("ask");
    expect(pushDecision({ ...quiet, linked, taint, expectations, updates: [update("refs/heads/x", B), update("refs/heads/y", B)] }).kind).toBe("ask");
    // Expired.
    expect(pushDecision({ ...quiet, linked, taint, expectations: [{ ...expectations[0]!, until: now - 1 }], updates: [update("refs/heads/x", B)] }).kind).toBe("ask");
  });

  it("matches a delete expectation by its all-zero new id", () => {
    const expectations: ReadonlyArray<PushExpectation> = [{ id: "d", updates: [{ ref: "refs/heads/x", new: ZERO }], until: now + 1 }];
    expect(matchExpectation(expectations, [update("refs/heads/x", ZERO)], now)).toBe("d");
  });
});

describe("taint", () => {
  it("records when it began and every linked thread that added to it", () => {
    const first = taintAfter(null, "thread:a", now);
    expect(taintAfter(taintAfter(first, "cli:t", now + 5), "thread:a", now + 9)).toEqual({ since: now, by: ["thread:a", "cli:t"] });
  });
});

describe("prunedLinkedWork", () => {
  it("forgets linked work that no longer counts", () => {
    expect(prunedLinkedWork({ a: now - 1, b: now + 1 }, now)).toEqual({ b: now + 1 });
  });
});
