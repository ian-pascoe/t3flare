// @effect-diagnostics globalDate:off
// The wake (ADR-0043 §5): a deletion brings the Sweep forward, after 5 s of quiet, on the one alarm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { graceMoved, ownerSweep, SweepWake, WAKE_QUIET_MS } from "../src/agents/sweepWake.ts";

const DAY = 86_400_000;

/** A Sweep schedule over fake timers: the stored next-sweep time, the alarm, and each Sweep as a promise the test ends. */
const harness = (initialNext = Date.now() + DAY) => {
  let next = initialNext;
  let alarm: number | null = null;
  const sweeps: Array<{ readonly at: number; readonly end: () => void }> = [];
  // Each Sweep answers its index, as the Environment's answers its report.
  const wake = new SweepWake({
    now: () => Date.now(),
    nextSweep: () => next,
    setNextSweep: (at: number) => void (next = at),
    arm: async () => {
      if (alarm === null || alarm > next) alarm = next;
    },
    sweep: () => {
      const index = sweeps.length;
      return new Promise<void>((resolve) => {
        sweeps.push({ at: Date.now(), end: resolve });
      }).then(() => {
        next = Date.now() + DAY;
        return index;
      });
    },
    failed: () => undefined,
  });
  return { wake, sweeps, next: () => next, alarm: () => alarm };
};

beforeEach(() => vi.useFakeTimers({ now: Date.parse("2026-11-21T12:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("SweepWake", () => {
  it("runs one Sweep for 20 wakes within a second, 5 s after the last", async () => {
    const h = harness();
    const start = Date.now();
    for (let i = 0; i < 20; i++) {
      h.wake.wake();
      await vi.advanceTimersByTimeAsync(50);
    }
    const last = start + 19 * 50;
    await vi.advanceTimersByTimeAsync(last + WAKE_QUIET_MS - Date.now() - 1);
    expect(h.sweeps).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sweeps).toHaveLength(1);
    expect(h.sweeps[0]?.at).toBe(last + WAKE_QUIET_MS);
    h.sweeps[0]?.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sweeps).toHaveLength(1);
  });

  it("sets the next-sweep time and the alarm at the wake, before the quiet ends", async () => {
    const h = harness();
    const at = Date.now();
    h.wake.wake();
    await Promise.resolve();
    expect(h.next()).toBe(at + WAKE_QUIET_MS);
    expect(h.alarm()).toBe(at + WAKE_QUIET_MS);
    expect(h.sweeps).toHaveLength(0);
  });

  it("keeps an earlier due time a wake finds, and the quiet still holds the Sweep back", async () => {
    // The stored time is already past (an overdue Sweep the idle check has not run yet).
    const overdue = Date.now() - 500;
    const h = harness(overdue);
    h.wake.wake();
    expect(h.next()).toBe(overdue);
    await h.wake.runIfDue();
    expect(h.sweeps).toHaveLength(0);
    // A second wake within the quiet slides it: the quiet is the wake's own.
    await vi.advanceTimersByTimeAsync(1000);
    h.wake.wake();
    expect(h.next()).toBe(Date.now() + WAKE_QUIET_MS);
    await vi.advanceTimersByTimeAsync(WAKE_QUIET_MS);
    expect(h.sweeps).toHaveLength(1);
  });

  it("runs exactly one more Sweep for any number of wakes during a Sweep", async () => {
    const h = harness();
    h.wake.wake();
    await vi.advanceTimersByTimeAsync(WAKE_QUIET_MS);
    expect(h.sweeps).toHaveLength(1);
    for (let i = 0; i < 5; i++) h.wake.wake();
    await vi.advanceTimersByTimeAsync(WAKE_QUIET_MS * 3);
    expect(h.sweeps).toHaveLength(1);
    h.sweeps[0]?.end();
    await vi.advanceTimersByTimeAsync(0);
    // The Sweep's own next date (a day ahead) is brought forward again for the one more run.
    expect(h.next()).toBe(Date.now() + WAKE_QUIET_MS);
    await vi.advanceTimersByTimeAsync(WAKE_QUIET_MS);
    expect(h.sweeps).toHaveLength(2);
    h.sweeps[1]?.end();
    await vi.advanceTimersByTimeAsync(DAY / 2);
    expect(h.sweeps).toHaveLength(2);
  });

  it("runs a due Sweep from the alarm or the idle check, once at a time, and not while a wake waits for quiet", async () => {
    const h = harness();
    await h.wake.runIfDue();
    expect(h.sweeps).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DAY);
    const first = h.wake.runIfDue();
    const second = h.wake.runIfDue();
    expect(h.sweeps).toHaveLength(1);
    h.sweeps[0]?.end();
    await Promise.all([first, second]);
    expect(h.sweeps).toHaveLength(1);
  });

  it("runs the Owner's Sweep now, after the one running and never beside it, and answers its report", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(DAY);
    const scheduled = h.wake.runIfDue();
    expect(h.sweeps).toHaveLength(1);
    let report: number | undefined;
    const owner = h.wake.runNow().then((value) => void (report = value));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sweeps).toHaveLength(1);
    h.sweeps[0]?.end();
    await scheduled;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sweeps).toHaveLength(2);
    // A scheduled Sweep due meanwhile joins it rather than run beside it.
    const joined = h.wake.runIfDue();
    expect(h.sweeps).toHaveLength(2);
    h.sweeps[1]?.end();
    await Promise.all([owner, joined]);
    expect(h.sweeps).toHaveLength(2);
    expect(report).toBe(1);
  });

  it("takes a wake waiting for quiet: one Sweep, now", async () => {
    const h = harness();
    h.wake.wake();
    const owner = h.wake.runNow();
    expect(h.sweeps).toHaveLength(1);
    h.sweeps[0]?.end();
    expect(await owner).toBe(0);
    await vi.advanceTimersByTimeAsync(WAKE_QUIET_MS * 2);
    expect(h.sweeps).toHaveLength(1);
  });

  it("the page's preview runs at once beside a Sweep; its Run waits behind it (ownerSweep)", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(DAY);
    void h.wake.runIfDue();
    let dryRuns = 0;
    const run = ownerSweep(h.wake, async () => -++dryRuns);
    expect(await run(true)).toBe(-1);
    const real = run(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sweeps).toHaveLength(1);
    h.sweeps[0]?.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sweeps).toHaveLength(2);
    h.sweeps[1]?.end();
    expect(await real).toBe(1);
    expect(dryRuns).toBe(1);
  });

  it("rejects the Owner's Sweep with its failure, and logs it", async () => {
    const failed = vi.fn();
    const wake = new SweepWake({
      now: () => Date.now(),
      nextSweep: () => Date.now() + DAY,
      setNextSweep: () => undefined,
      arm: async () => undefined,
      sweep: async () => {
        throw new Error("no projection");
      },
      failed,
    });
    await expect(wake.runNow()).rejects.toThrow("no projection");
    expect(failed).toHaveBeenCalledWith("sweep", expect.any(Error));
  });

  it("logs a failed Sweep and runs the next wake", async () => {
    const failed = vi.fn();
    let runs = 0;
    const wake = new SweepWake({
      now: () => Date.now(),
      nextSweep: () => Date.now() + DAY,
      setNextSweep: () => undefined,
      arm: async () => undefined,
      sweep: async () => {
        runs++;
        throw new Error("no projection");
      },
      failed,
    });
    wake.wake();
    await vi.advanceTimersByTimeAsync(WAKE_QUIET_MS);
    expect(failed).toHaveBeenCalledWith("sweep", expect.any(Error));
    wake.wake();
    await vi.advanceTimersByTimeAsync(WAKE_QUIET_MS);
    expect(runs).toBe(2);
  });
});

describe("a change to the Grace (ADR-0043 §4, §5)", () => {
  it("turning purging off forgets when it was turned on at once, so on again inside the quiet starts a new Grace", () => {
    let purgingSince: number | null = 1_000;
    let wakes = 0;
    const moved = (purging: boolean) => graceMoved({ purging, clearPurgingSince: () => void (purgingSince = null), wake: () => void wakes++ });
    moved(true);
    expect(purgingSince).toBe(1_000);
    moved(false);
    expect(purgingSince).toBeNull();
    // On again before any Sweep ran: nothing restores the old time; the next Sweep that finds purging on starts it.
    moved(true);
    expect(purgingSince).toBeNull();
    expect(wakes).toBe(3);
  });
});
