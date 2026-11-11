// The Workspace DO's syncs for its terminals (step 2b; review F9) at their seam, `TerminalSync`: when pulls and pushes
// run, that they never run with the Container stopped, never overlap, and back off while quiet pulls find nothing.
// @effect-diagnostics globalTimers:off globalDate:off
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_QUIET_BACKOFF_MS, PUSH_EVERY_MS, TerminalSync } from "../src/workspace/terminalSync.ts";

const harness = (pullEntries: () => number = () => 0) => {
  const calls: Array<string> = [];
  let running = true;
  let revision = 0;
  let active = true;
  let inFlight = 0;
  let overlapped = false;
  const op = (name: string, entries: () => number) => async () => {
    inFlight++;
    if (inFlight > 1) overlapped = true;
    calls.push(`${name}@${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    inFlight--;
    return entries();
  };
  const sync = new TerminalSync({
    now: () => Date.now(),
    running: () => running,
    pull: op("pull", () => {
      const entries = pullEntries();
      revision += entries; // a pull's writes move the change log too
      return entries;
    }),
    push: op("push", () => 1),
    revision: () => revision,
    active: () => active,
  });
  return {
    sync,
    calls,
    names: () => calls.map((call) => call.split("@")[0]),
    times: () => calls.map((call) => Number(call.split("@")[1])),
    stop: () => void (running = false),
    write: () => void revision++,
    deactivate: () => void (active = false),
    overlapped: () => overlapped,
  };
};

describe("TerminalSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("pulls soon after a prompt, at most one pull every 2 s", async () => {
    const h = harness(() => 1);
    h.sync.changed("prompt");
    await vi.advanceTimersByTimeAsync(400);
    expect(h.names()).toEqual(["pull"]);
    h.sync.changed("prompt");
    h.sync.changed("exit");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.names()).toEqual(["pull"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.names()).toEqual(["pull", "pull"]);
    expect(h.times()[1]! - h.times()[0]!).toBeGreaterThanOrEqual(2000);
  });

  it("debounces output, and backs off while quiet pulls find nothing", async () => {
    const h = harness(() => 0);
    for (let i = 0; i < 5; i++) {
      h.sync.changed("output");
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(h.names()).toEqual([]); // output kept coming: the quiet pull waits
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.names()).toEqual(["pull"]);
    // A chatty process: output every second, every pull empty. The gaps grow to the cap instead of 2 s forever.
    for (let i = 0; i < 600; i++) {
      h.sync.changed("output");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.names().length).toBeLessThan(5);
    // A prompt resets it.
    h.sync.changed("prompt");
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.names().at(-1)).toBe("pull");
    expect(MAX_QUIET_BACKOFF_MS).toBe(60_000);
  });

  it("never syncs while the Container is stopped", async () => {
    const h = harness(() => 1);
    h.stop();
    h.sync.changed("prompt");
    h.sync.startPushing();
    h.write();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await h.sync.pullNow()).toBe(0);
    expect(h.names()).toEqual([]);
    h.sync.stop();
  });

  it("pushes the DO's writes every 2 s while terminals are open, not what a pull brought", async () => {
    const h = harness(() => 3);
    h.sync.startPushing();
    await vi.advanceTimersByTimeAsync(PUSH_EVERY_MS * 2);
    expect(h.names()).toEqual([]);
    const pulled = h.sync.pullNow();
    await vi.advanceTimersByTimeAsync(100);
    await pulled;
    await vi.advanceTimersByTimeAsync(PUSH_EVERY_MS);
    expect(h.names()).toEqual(["pull"]);
    h.write();
    await vi.advanceTimersByTimeAsync(PUSH_EVERY_MS + 100);
    expect(h.names()).toEqual(["pull", "push"]);
    h.deactivate();
    h.write();
    await vi.advanceTimersByTimeAsync(PUSH_EVERY_MS * 3);
    expect(h.names()).toEqual(["pull", "push"]);
  });

  it("runs one sync at a time", async () => {
    const h = harness(() => 1);
    h.sync.startPushing();
    h.write();
    const pulls = [h.sync.pullNow(), h.sync.pullNow(), h.sync.pushIfChanged()];
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pulls);
    expect(h.overlapped()).toBe(false);
    h.sync.stop();
  });
});
