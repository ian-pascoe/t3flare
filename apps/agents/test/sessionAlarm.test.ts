// The Session's one alarm (SessionDO `#arm` and `alarm`), which also sends its pushes: a push goes out from the alarm,
// a request of its own, so it never rides on the depth of the Environment's last call (ADR-0005, 2026-11-21 refinement).
import { describe, expect, it } from "vitest";

import { alarmWork, nextAlarm } from "../src/session/alarmPlan.ts";

const NOW = 1_000_000;

describe("nextAlarm", () => {
  it("arms nothing when no push is due and no housekeeping is", () => {
    expect(nextAlarm(NOW, { pushDue: false, candidates: [] })).toEqual({ at: null, housekeepingAt: undefined });
  });

  it("arms the earliest housekeeping, never sooner than 500 ms", () => {
    expect(nextAlarm(NOW, { pushDue: false, candidates: [NOW + 60_000, NOW + 5_000] })).toEqual({
      at: NOW + 5_000,
      housekeepingAt: NOW + 5_000,
    });
    expect(nextAlarm(NOW, { pushDue: false, candidates: [NOW - 10] })).toEqual({ at: NOW + 500, housekeepingAt: NOW + 500 });
  });

  it("arms now for a due push, without the 500 ms floor, and keeps the housekeeping time", () => {
    expect(nextAlarm(NOW, { pushDue: true, candidates: [] })).toEqual({ at: NOW, housekeepingAt: undefined });
    expect(nextAlarm(NOW, { pushDue: true, candidates: [NOW + 60_000] })).toEqual({ at: NOW, housekeepingAt: NOW + 60_000 });
  });
});

describe("alarmWork", () => {
  it("only pushes when the alarm was armed for a push before housekeeping is due", () => {
    expect(alarmWork(NOW, { pushDue: true, housekeepingAt: NOW + 60_000 })).toEqual({ push: true, housekeeping: false });
    expect(alarmWork(NOW, { pushDue: true, housekeepingAt: undefined })).toEqual({ push: true, housekeeping: false });
  });

  it("pushes and keeps house when both are due", () => {
    expect(alarmWork(NOW, { pushDue: true, housekeepingAt: NOW })).toEqual({ push: true, housekeeping: true });
  });

  it("keeps house on any other alarm: one armed before a restart, or the constructor's fallback", () => {
    expect(alarmWork(NOW, { pushDue: false, housekeepingAt: undefined })).toEqual({ push: false, housekeeping: true });
    expect(alarmWork(NOW, { pushDue: false, housekeepingAt: NOW + 60_000 })).toEqual({ push: false, housekeeping: true });
  });
});
