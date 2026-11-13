// Copied from cloudpid@ae5a7b73:packages/computer-env/src/watch.test.ts.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, type FileChange } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { caller } from "./client.ts";
import { PollingWatcher } from "./watch.ts";
import type { Snapshot } from "./wire.ts";

const target = { path: "/workspace", recursive: true, hidden: true, names: [] };
/** A scan as slow as a loaded machine makes it: three of them, with the polls between, overran the old 100 ms wait. */
const SLOW_SCAN_MS = 40;

/**
 * A Workspace DO stand-in that answers each scan with the next step: a snapshot, or a thrown RPC failure; the last
 * step repeats. `settled` resolves when a scan past the last step starts: the watcher polls again only once the
 * previous poll is done, so by then every step has been handled, however slowly the machine ran.
 */
const scripted = (steps: ReadonlyArray<Snapshot | "unreachable">, scanMs: number) => {
  let index = 0;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));

  const call = caller({
    fileOperation: async () => {
      const current = index++;

      if (current === steps.length) settle();
      if (scanMs > 0) await new Promise((resolve) => setTimeout(resolve, scanMs));
      const step = steps[Math.min(current, steps.length - 1)];

      if (step === "unreachable")
        throw new Error("Durable Object reset because its code was updated.");

      return { ok: true, value: step };
    },
  });

  return { call, settled };
};

const changes = async (steps: ReadonlyArray<Snapshot | "unreachable">, scanMs = 0) => {
  const seen: FileChange[] = [];
  const { call, settled } = scripted(steps, scanMs);

  const watcher = getOrThrow(
    await PollingWatcher.open(
      call,
      [target],
      (change) => seen.push(change),
      { pollIntervalMs: 5 },
      BACKGROUND_CONTEXT,
    ),
  );

  await settled;
  await watcher.stop(BACKGROUND_CONTEXT);

  return seen;
};

describe("PollingWatcher", () => {
  it("reports the paths that differ between snapshots", async () => {
    const before: Snapshot = [["/workspace/a", "1"]];
    const after: Snapshot = [["/workspace/a", "2"]];

    expect(await changes([before, after])).toEqual([{ kind: "paths", paths: ["/workspace/a"] }]);
  });

  it("keeps polling through an unreachable Workspace DO and reports overflow once it answers", async () => {
    const snapshot: Snapshot = [["/workspace/a", "1"]];

    expect(await changes([snapshot, "unreachable", "unreachable", snapshot])).toEqual([
      { kind: "overflow" },
    ]);
  });

  // SPI-1109: a loaded machine (the parallel check) makes each scan slow; the outcome must not depend on it.
  it("reports the same overflow when every scan is slow", async () => {
    const snapshot: Snapshot = [["/workspace/a", "1"]];

    expect(await changes([snapshot, "unreachable", "unreachable", snapshot], SLOW_SCAN_MS)).toEqual([
      { kind: "overflow" },
    ]);
  });
});
