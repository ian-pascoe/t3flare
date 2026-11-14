// The Workspace DO's read of the Environment settings before a Container start (SPI-1149, ADR-0032), and what the start
// launches with: the Environment's answer within a bounded wait, else the copy it last kept, else the defaults; the size
// name as an `instance` that is never omitted, the idle time, and the budget carried only when it was read fresh.
import { describe, expect, it } from "vitest";

import type { ResolvedEnvironment } from "@t3flare/harness-registry";

import { launchOf, shownLaunch, takeEnvironment, withGlobalMise } from "../src/workspace/containerLaunch.ts";

const CPU_1 = { vcpu: 1, memoryMib: 3072, diskMb: 12000 };
const DEFAULTS: ResolvedEnvironment = { revision: 0, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 3, variables: {}, globalMiseConfig: "" };

const keeper = (initial?: ResolvedEnvironment) => {
  let kept = initial;
  return { kept: () => kept, keep: (value: ResolvedEnvironment) => void (kept = value), now: () => kept };
};
const never = () => new Promise<ResolvedEnvironment>(() => undefined);

describe("takeEnvironment", () => {
  it("takes the Environment's answer and keeps it", async () => {
    const store = keeper({ revision: 1, containerSize: "standard-1", containerIdleMinutes: 3, containerBudget: 2, variables: {}, globalMiseConfig: "" });
    const answer: ResolvedEnvironment = { revision: 2, containerSize: "standard-3", containerIdleMinutes: 9, containerBudget: 5, variables: {}, globalMiseConfig: "" };
    expect(await takeEnvironment({ read: async () => answer, kept: store.kept, keep: store.keep, waitMs: 50 })).toEqual({ settings: answer, source: "environment" });
    expect(store.now()).toEqual(answer);
  });

  it("falls back to its kept copy when the Environment does not answer in time, or fails", async () => {
    const copy: ResolvedEnvironment = { revision: 4, containerSize: "standard-2", containerIdleMinutes: 7, containerBudget: 2, variables: {}, globalMiseConfig: "" };
    const store = keeper(copy);
    expect(await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: copy, source: "kept" });
    const failing = async (): Promise<ResolvedEnvironment> => {
      throw new Error("the Environment DO reset");
    };
    expect(await takeEnvironment({ read: failing, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: copy, source: "kept" });
    expect(store.now()).toEqual(copy);
  });

  it("starts with the defaults when the Environment does not answer and nothing is kept", async () => {
    const store = keeper();
    expect(await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: DEFAULTS, source: "default" });
  });

  it("reads its kept copy against this Worker's schema: an unknown size starts the default, a missing setting its default", async () => {
    // SAFETY: deliberately outside the type: a copy kept by another Worker's version.
    const odd = { revision: 6, containerSize: "standard-9", containerBudget: 2 } as unknown as ResolvedEnvironment;
    const store = keeper(odd);
    const taken = await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 });
    expect(taken).toEqual({ settings: { revision: 6, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 2, variables: {}, globalMiseConfig: "" }, source: "kept" });
    expect(launchOf(taken).instance).toEqual(CPU_1);
  });

  it("reads an answer from an Environment newer or older than this Worker against this Worker's schema", async () => {
    const store = keeper();
    // SAFETY: deliberately outside the type, as another Worker's version may answer.
    const odd = { revision: 9, containerSize: "standard-9", containerIdleMinutes: 61, containerBudget: 11, misePolicy: "x" } as unknown as ResolvedEnvironment;
    const taken = await takeEnvironment({ read: async () => odd, kept: store.kept, keep: store.keep, waitMs: 50 });
    expect(taken).toEqual({ settings: { ...DEFAULTS, revision: 9 }, source: "environment" });
    expect(store.now()).toEqual({ ...DEFAULTS, revision: 9 });
  });
});

describe("launchOf", () => {
  it("launches with the Variables it took, fresh or kept: a running Container keeps them (SPI-1152)", () => {
    const variables = { NODE_ENV: "test" };
    expect(launchOf({ settings: { ...DEFAULTS, variables }, source: "environment" }).variables).toEqual(variables);
    expect(launchOf({ settings: { ...DEFAULTS, variables }, source: "kept" }).variables).toEqual(variables);
  });

  it("launches a named size by its name and cpu-1 as its resources, with the idle time in milliseconds", () => {
    expect(launchOf({ settings: { revision: 3, containerSize: "standard-4", containerIdleMinutes: 10, containerBudget: 4, variables: {}, globalMiseConfig: "" }, source: "environment" })).toEqual({
      size: "standard-4",
      instance: "standard-4",
      idleMs: 600_000,
      budget: 4,
      revision: 3,
      variables: {},
    });
    expect(launchOf({ settings: DEFAULTS, source: "environment" })).toEqual({ size: "cpu-1", instance: CPU_1, idleMs: 120_000, budget: 3, revision: 0, variables: {} });
  });

  it("carries no budget unless it was read fresh: a kept copy or the defaults never overwrite the owner's", () => {
    const copy: ResolvedEnvironment = { revision: 4, containerSize: "standard-2", containerIdleMinutes: 7, containerBudget: 1, variables: {}, globalMiseConfig: "" };
    expect(launchOf({ settings: copy, source: "kept" }).budget).toBeUndefined();
    expect(launchOf({ settings: DEFAULTS, source: "default" }).budget).toBeUndefined();
    expect(launchOf({ settings: copy, source: "kept" }).instance).toBe("standard-2");
  });
});

describe("the launch's Global mise config", () => {
  const taken = { settings: { revision: 7, containerSize: "cpu-1" as const, containerIdleMinutes: 2, containerBudget: 3, globalMiseConfig: '[tools]\nnode = "24.11.1"\n' }, source: "kept" as const };

  it("carries the start's text, its size and SHA-256, its revision and where the settings came from", async () => {
    const launch = await withGlobalMise(launchOf(taken), taken);
    expect(launch.globalMise).toEqual({ text: '[tools]\nnode = "24.11.1"\n', bytes: 25, sha256: "0eb09ceb981ac62b1ed4ebb30295ad081a471bb40b9ebda4eb48fcf45aae8cf3", revision: 7, source: "kept" });
  });

  it("is shown by its digest only, never its text", async () => {
    const shown = shownLaunch(await withGlobalMise(launchOf(taken), taken));
    expect(shown.globalMise).toEqual({ bytes: 25, sha256: "0eb09ceb981ac62b1ed4ebb30295ad081a471bb40b9ebda4eb48fcf45aae8cf3", revision: 7, source: "kept" });
    expect(JSON.stringify(shown)).not.toContain("24.11.1");
  });
});
