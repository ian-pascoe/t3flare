// The Workspace DO's read of the Environment settings before a Container start (SPI-1149, ADR-0032), and what the start
// launches with: the Environment's answer within a bounded wait, else the copy it last kept, else the defaults; the size
// name as an `instance` that is never omitted, and the idle time.
import { describe, expect, it } from "vitest";

import type { ResolvedEnvironment } from "@t3flare/harness-registry";

import { launchOf, takeEnvironment } from "../src/workspace/containerLaunch.ts";

const CPU_1 = { vcpu: 1, memoryMib: 3072, diskMb: 12000 };

const keeper = (initial?: ResolvedEnvironment) => {
  let kept = initial;
  return { kept: () => kept, keep: (value: ResolvedEnvironment) => void (kept = value), now: () => kept };
};

describe("takeEnvironment", () => {
  it("takes the Environment's answer and keeps it", async () => {
    const store = keeper({ revision: 1, containerSize: "standard-1", containerIdleMinutes: 3, containerBudget: 3 });
    const answer = { revision: 2, containerSize: "standard-3", containerIdleMinutes: 9, containerBudget: 3 };
    expect(await takeEnvironment({ read: async () => answer, kept: store.kept, keep: store.keep, waitMs: 50 })).toEqual({ settings: answer, source: "environment" });
    expect(store.now()).toEqual(answer);
  });

  it("falls back to its kept copy when the Environment does not answer in time, or fails", async () => {
    const copy = { revision: 4, containerSize: "standard-2", containerIdleMinutes: 7, containerBudget: 3 };
    const store = keeper(copy);
    const never = () => new Promise<ResolvedEnvironment>(() => undefined);
    expect(await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: copy, source: "kept" });
    const failing = async (): Promise<ResolvedEnvironment> => {
      throw new Error("the Environment DO reset");
    };
    expect(await takeEnvironment({ read: failing, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: copy, source: "kept" });
    expect(store.now()).toEqual(copy);
  });

  it("starts with the defaults when the Environment does not answer and nothing is kept", async () => {
    const store = keeper();
    const never = () => new Promise<ResolvedEnvironment>(() => undefined);
    expect(await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({
      settings: { revision: 0, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 3 },
      source: "default",
    });
  });
});

describe("launchOf", () => {
  it("launches a named size by its name and cpu-1 as its resources, with the idle time in milliseconds", () => {
    expect(launchOf({ revision: 3, containerSize: "standard-4", containerIdleMinutes: 10, containerBudget: 3 })).toEqual({ size: "standard-4", instance: "standard-4", idleMs: 600_000, budget: 3, revision: 3 });
    expect(launchOf({ revision: 0, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 3 })).toEqual({ size: "cpu-1", instance: CPU_1, idleMs: 120_000, budget: 3, revision: 0 });
  });

  it("launches the default for a size it does not offer (an Environment newer or older than this Worker), never an omitted instance", () => {
    const launch = launchOf({ revision: 9, containerSize: "standard-9", containerIdleMinutes: 2, containerBudget: 3 });
    expect(launch.size).toBe("cpu-1");
    expect(launch.instance).toEqual(CPU_1);
  });

  it("carries the budget the settings give, and the default for one out of bounds", () => {
    expect(launchOf({ revision: 2, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 7 }).budget).toBe(7);
    for (const budget of [0, 11, 2.5]) expect(launchOf({ revision: 2, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: budget }).budget).toBe(3);
  });

  it("launches the default idle time for one out of bounds", () => {
    for (const minutes of [0, -1, 61, 1.5, Number.NaN]) expect(launchOf({ revision: 1, containerSize: "cpu-1", containerIdleMinutes: minutes, containerBudget: 3 }).idleMs).toBe(120_000);
  });
});
