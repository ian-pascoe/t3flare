// Step 3+ (plan section 4.4, review findings 3 and 8): the publish recorder reads t3's AgentAwarenessRelay log events,
// keeps each publish's outcome, holds the idle reset while a publish is still pending, and classifies a refusal.
// The messages are the shapes `t3/src/relay/AgentAwarenessRelay.ts` logs (fragility U28).
import { beforeEach, describe, expect, it } from "vitest";

import * as Idle from "../src/host/idle.ts";
import { makePublishRecorder } from "../src/connect/recorder.ts";

const memoryStore = () => {
  let value: unknown;
  return { read: () => value, write: (next: unknown) => void (value = next) };
};

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11, 12, 0, seconds));
const T1 = "thread-1";
const deliveries = { total: 1, queued: 0, successful: 1, failed: 0, kinds: ["alert"], failedReasons: [] };

describe("publish recorder", () => {
  beforeEach(() => {
    Idle.holds.clear();
    Object.assign(Idle.activity, { sockets: 0, inFlight: 0, idleSince: at(0).getTime(), unreadableUntil: 0 });
  });

  it("records a publish from its start to the relay's answer, holding the reset until it lands", () => {
    const recorder = makePublishRecorder(memoryStore());
    recorder.record(["publishing agent activity for thread", { threadId: T1, statePhase: "running", hasState: true, reason: "snapshot" }], at(1));
    expect(Idle.activeHolds(at(2).getTime())).toEqual([`publish:${T1}`]);
    recorder.record(["agent activity publish completed", { threadId: T1, ok: true, deliveries }], at(2));
    expect(Idle.activeHolds(at(3).getTime())).toEqual([]);
    expect(recorder.entries()).toEqual([
      { at: at(1).toISOString(), threadId: T1, event: "publishing", phase: "running", reason: "snapshot" },
      { at: at(2).toISOString(), threadId: T1, event: "completed", phase: "running", ok: true, deliveries },
    ]);
  });

  it("holds through the completion's 5 s confirmation and through retries, and lets go once retries are exhausted", () => {
    const recorder = makePublishRecorder(memoryStore());
    recorder.record(["agent activity publish deferred pending confirmation", { threadId: T1, statePhase: "completed", reason: "snapshot" }], at(1));
    expect(Idle.activeHolds(at(5).getTime())).toEqual([`publish:${T1}`]);
    recorder.record(["agent activity publish failed", { threadId: T1, cause: "RelayRequestError: Service Unavailable (status 503)" }], at(7));
    expect(Idle.activeHolds(at(30).getTime())).toEqual([`publish:${T1}`]);
    recorder.record(["agent activity publish retry budget exhausted", { threadId: T1 }], at(40));
    expect(Idle.activeHolds(at(41).getTime())).toEqual([]);
    expect(recorder.entries().map((entry) => entry.event)).toEqual(["deferred", "failed", "exhausted"]);
    expect(recorder.entries()[1]).toMatchObject({ status: 503, rejected: false });
  });

  it("classifies a refusal by its status and keeps none of the failure's text", () => {
    const recorder = makePublishRecorder(memoryStore());
    const cause = "HttpApiClientError: Unauthorized (status 401) Bearer abcdefghijklmnop https://relay.t3.codes/v1/environments/e/threads/t";
    recorder.record(["agent activity publish failed", { threadId: T1, cause }], at(1));
    const [entry] = recorder.entries();
    expect(entry).toMatchObject({ event: "failed", status: 401, rejected: true });
    expect(JSON.stringify(entry)).not.toContain("abcdefghijklmnop");
    expect(recorder.summary()).toMatchObject({ rejected: true, lastFailure: { status: 401 } });
  });

  it("ignores other log events, keeps the last 100 and reads them back after a reset", () => {
    const store = memoryStore();
    const recorder = makePublishRecorder(store);
    recorder.record(["something else entirely", { threadId: T1 }], at(1));
    recorder.record("a plain message", at(1));
    for (let i = 0; i < 120; i++) recorder.record(["publishing agent activity for thread", { threadId: `t${i}`, statePhase: "running" }], at(2));
    expect(recorder.entries()).toHaveLength(100);
    expect(makePublishRecorder(store).entries()).toEqual(recorder.entries());
  });
});
