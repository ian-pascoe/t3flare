// @effect-diagnostics globalTimers:off globalDate:off
// The Global mise config's lay-down as the Workspace DO runs it (SPI-1150, ADR-0032 §8; `GlobalMise`), with a fake
// exec and clock: once per Container (its runtime id), held while it runs, bounded by a deadline, retried after an exec
// failure, and reported. The script itself is `globalMiseScript.test.ts`'s.
import type { GlobalMiseReport } from "@t3flare/harness-registry";
import { describe, expect, it, vi } from "vitest";

import { GLOBAL_MISE_KEY, GlobalMise, type GlobalMiseExec, type GlobalMiseLaunch, type GlobalMiseState, MAX_ATTEMPTS } from "../src/workspace/globalMise.ts";

const SHA = "a".repeat(64);
const LAUNCH: GlobalMiseLaunch = { text: '[tools]\nnode = "24.11.1"\n', bytes: 25, sha256: SHA, revision: 4, source: "environment" };
const answer = (laid: boolean, extra: Record<string, unknown> = {}) => `${JSON.stringify({ revision: 4, sha256: SHA, source: "environment", laid, install: 0, timedOut: false, ms: 5, bytes: 25, ...extra })}\n`;

type Step = { readonly stdout?: string; readonly throws?: string; readonly hang?: boolean };

const setup = (steps: Array<Step>, options: { launch?: GlobalMiseLaunch | undefined; deadlineMs?: number; map?: Map<string, unknown> } = {}) => {
  const map = options.map ?? new Map<string, unknown>();
  const storage = { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) };
  const calls: Array<{ argv: ReadonlyArray<string>; stdin: string }> = [];
  const reports: Array<GlobalMiseReport> = [];
  const events: Array<string> = [];
  let holds = 0;
  let killed = 0;
  const launch = "launch" in options ? options.launch : LAUNCH;
  const deps = {
    exec: async (argv: ReadonlyArray<string>, stdin: string): Promise<GlobalMiseExec> => {
      calls.push({ argv, stdin });
      events.push(`exec held=${holds}`);
      const step = steps.shift() ?? { stdout: answer(true) };
      if (step.throws !== undefined) throw new Error(step.throws);
      return {
        output: step.hang === true ? new Promise(() => undefined) : new Promise((resolve) => setTimeout(() => resolve({ stdout: step.stdout ?? "", exitCode: 0 }), 5)),
        kill: () => void killed++,
      };
    },
    launch: () => launch,
    hold: () => {
      holds++;
      return () => void holds--;
    },
    used: async () => void events.push(`used held=${holds}`),
    report: (report: GlobalMiseReport) => void reports.push(report),
    storage,
    workspace: () => "/w/app",
    now: () => Date.now(),
    deadlineMs: options.deadlineMs ?? 1_000,
  };
  return { mise: new GlobalMise(deps), map, calls, reports, events, storage, holds: () => holds, killed: () => killed };
};

describe("GlobalMise", () => {
  it("runs once per Container: concurrent callers join the run, a later call finds it done", async () => {
    const t = setup([{ stdout: answer(true) }]);
    const [a, b] = await Promise.all([t.mise.ensure("r1"), t.mise.ensure("r1")]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ runtime: "r1", outcome: "laid", attempts: 1 });
    await t.mise.ensure("r1");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.stdin).toBe(LAUNCH.text);
    expect(t.calls[0]!.argv.slice(-3)).toEqual(["4", SHA, "environment"]);
  });

  it("runs again for a new Container (a runtime id it has not seen: one that died on its own and came back)", async () => {
    const t = setup([{ stdout: answer(true) }, { stdout: answer(true) }]);
    await t.mise.ensure("r1");
    await t.mise.ensure("r2");
    expect(t.calls).toHaveLength(2);
  });

  it("keeps the outcome in storage: a new instance (a deploy) does not run a finished lay-down again", async () => {
    const t = setup([{ hang: true }], { deadlineMs: 20 });
    expect(await t.mise.ensure("r1")).toMatchObject({ outcome: "deadline" });
    // A fresh instance over the same storage.
    const fresh = setup([{ stdout: answer(true) }], { map: t.map });
    expect(await fresh.mise.ensure("r1")).toMatchObject({ outcome: "deadline" });
    expect(fresh.calls).toHaveLength(0);
    expect(t.storage.get<GlobalMiseState>(GLOBAL_MISE_KEY)).toMatchObject({ runtime: "r1", outcome: "deadline" });
  });

  it("holds the Container for the whole run, and notes use once the hold is released", async () => {
    const t = setup([{ stdout: answer(true) }]);
    await t.mise.ensure("r1");
    expect(t.events).toEqual(["exec held=1", "used held=0"]);
    expect(t.holds()).toBe(0);
  });

  it("stops waiting at the deadline: kills the exec, not laid and final, and reports it", async () => {
    const t = setup([{ hang: true }], { deadlineMs: 20 });
    expect(await t.mise.ensure("r1")).toMatchObject({ outcome: "deadline", attempts: 1 });
    expect(t.killed()).toBe(1);
    expect(t.holds()).toBe(0);
    expect(t.reports).toMatchObject([{ outcome: "deadline", timedOut: true, runtime: "r1", workspace: "/w/app" }]);
    expect(t.mise.retryFailed("r1")).toBe(false);
  });

  it("retries a failed exec once at once, then from the alarm, at most three times in all", async () => {
    const t = setup([{ throws: "exec refused" }, { throws: "exec refused" }, { throws: "exec refused" }, { stdout: answer(true) }]);
    expect(await t.mise.ensure("r1")).toMatchObject({ outcome: "exec-failed", attempts: 2 });
    expect(t.calls).toHaveLength(2);
    expect(t.mise.retryFailed("r1")).toBe(true);
    await vi.waitFor(() => expect(t.calls).toHaveLength(3));
    await vi.waitFor(() => expect(t.mise.inFlight()).toBe(false));
    expect(t.mise.state()).toMatchObject({ outcome: "exec-failed", attempts: MAX_ATTEMPTS });
    expect(t.mise.retryFailed("r1")).toBe(false);
    expect(await t.mise.ensure("r1")).toMatchObject({ attempts: MAX_ATTEMPTS });
    expect(t.calls).toHaveLength(3);
    expect(t.reports.map((report) => report.outcome)).toEqual(["exec-failed", "exec-failed", "exec-failed"]);
  });

  it("treats a run without an answer, or one that found the lock held, as an exec failure", async () => {
    const t = setup([{ stdout: "bash: mise: command not found\n" }, { stdout: answer(false, { locked: true, install: null }) }]);
    expect(await t.mise.ensure("r1")).toMatchObject({ outcome: "exec-failed", attempts: 2 });
  });

  it("reports a file not laid down with its install's exit", async () => {
    const t = setup([{ stdout: `mise WARN noise\n${answer(false, { install: 1 })}` }]);
    expect(await t.mise.ensure("r1")).toMatchObject({ outcome: "not-laid" });
    expect(t.reports).toMatchObject([{ outcome: "not-laid", install: 1, timedOut: false, revision: 4, sha256: SHA, bytes: 25, source: "environment" }]);
  });

  it("runs nothing for a launch without text on a known Container", async () => {
    const t = setup([], { launch: { ...LAUNCH, text: "", bytes: 0 } });
    expect(await t.mise.ensure("r1")).toMatchObject({ outcome: "not-laid" });
    expect(t.calls).toHaveLength(0);
    expect(t.reports).toHaveLength(0);
  });

  it("runs the script with no text for a launch from before (no Global mise config recorded)", async () => {
    const t = setup([{ stdout: answer(false, { install: null, bytes: 0 }) }], { launch: undefined });
    await t.mise.ensure("r1");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.stdin).toBe("");
  });

  it("without a runtime id, runs the (idempotent) script at every call and keeps nothing", async () => {
    const t = setup([{ stdout: answer(true) }, { stdout: answer(true) }]);
    await t.mise.ensure(undefined);
    await t.mise.ensure(undefined);
    expect(t.calls).toHaveLength(2);
    expect(t.storage.get(GLOBAL_MISE_KEY)).toBeUndefined();
  });

  it("does not retry a failed exec for a passive read's connect, and does for the next command's", async () => {
    const t = setup([{ throws: "exec refused" }, { throws: "exec refused" }, { stdout: answer(true) }]);
    await t.mise.ensure("r1");
    expect(await t.mise.ensure("r1", { retry: false })).toMatchObject({ outcome: "exec-failed", attempts: 2 });
    expect(t.calls).toHaveLength(2);
    expect(await t.mise.ensure("r1")).toMatchObject({ outcome: "laid", attempts: 3 });
  });
});

