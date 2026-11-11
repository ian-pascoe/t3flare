// The Session's running Container commands (step 2a part 2 plan, section 4; review findings 4 and 6): kept in the
// Session's storage while they run, so an aborted call's processes are killed, and a Session that died mid-call kills
// them when it opens again. An id is forgotten only when its command ended by itself or a kill found none of its
// processes left; otherwise the kill is tried again (the Session's alarm).
// @effect-diagnostics globalTimers:off newPromise:off
import { describe, expect, it } from "vitest";

import { type KillAnswer, RunningExecs, type RunningExecsStorage } from "../src/session/runningExecs.ts";

const memoryKv = (): RunningExecsStorage => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
  };
};

/** A kill that records the ids it was asked for, answering each call from `answers` (the last one again). */
const fakeKill = (...answers: Array<KillAnswer | "throw" | "hang">) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const kill = (ids: ReadonlyArray<string>): Promise<KillAnswer> => {
    calls.push([...ids]);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer === "throw") return Promise.reject(new Error("unreachable"));
    if (answer === "hang") return new Promise(() => {});
    return Promise.resolve(answer);
  };
  return { kill, calls };
};

describe("RunningExecs", () => {
  it("forgets a command that ended by itself, without a kill", async () => {
    const kv = memoryKv();
    const { kill, calls } = fakeKill({ survivors: 0 });
    const execs = new RunningExecs(kv, kill);
    execs.started("e1");
    expect(new RunningExecs(kv, kill).ids()).toEqual(["e1"]);
    execs.ended("e1");
    expect(execs.ids()).toEqual([]);
    await execs.killAll(100);
    expect(calls).toEqual([]);
  });

  it("kills a stopped command and forgets it when no process of it is left", async () => {
    const { kill, calls } = fakeKill({ survivors: 0 });
    const execs = new RunningExecs(memoryKv(), kill);
    execs.started("e1");
    execs.started("e2");
    await execs.stopped("e1");
    expect(calls).toEqual([["e1"]]);
    expect(execs.ids()).toEqual(["e2"]);
    expect(execs.retryDue()).toBe(false);
  });

  it("keeps an id while its processes survive or the Workspace cannot be reached, and the retry clears it", async () => {
    const { kill, calls } = fakeKill({ survivors: 2 }, "throw", { survivors: 0 });
    const execs = new RunningExecs(memoryKv(), kill);
    execs.started("e1");
    await execs.stopped("e1");
    expect(execs.ids()).toEqual(["e1"]);
    expect(execs.retryDue()).toBe(true);
    await execs.retry(100);
    expect(execs.ids()).toEqual(["e1"]);
    await execs.retry(100);
    expect(execs.ids()).toEqual([]);
    expect(calls).toEqual([["e1"], ["e1"], ["e1"]]);
  });

  it("an abort kills every running command, bounded: a kill that hangs returns after the bound and is kept", async () => {
    const { kill } = fakeKill("hang");
    const execs = new RunningExecs(memoryKv(), kill);
    execs.started("e1");
    const started = performance.now();
    await execs.killAll(50);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(execs.ids()).toEqual(["e1"]);
    expect(execs.retryDue()).toBe(true);
  });

  it("a Session opened again kills what was running when it died, and only that", async () => {
    const kv = memoryKv();
    const before = new RunningExecs(kv, fakeKill({ survivors: 0 }).kill);
    before.started("old");
    // The object restarts: a new instance over the same storage. A command the resumed Harness starts is not killed.
    const { kill, calls } = fakeKill({ survivors: 0 });
    const after = new RunningExecs(kv, kill);
    const orphans = after.ids();
    after.started("new");
    await after.killAll(100, orphans);
    expect(calls).toEqual([["old"]]);
    expect(after.ids()).toEqual(["new"]);
  });

  it("gives an id up after its kill failed many times (a process the kill cannot reach)", async () => {
    const { kill } = fakeKill({ survivors: 1 });
    const execs = new RunningExecs(memoryKv(), kill);
    execs.started("e1");
    await execs.stopped("e1");
    for (let attempt = 0; attempt < 20; attempt++) await execs.retry(100);
    expect(execs.ids()).toEqual([]);
  });
});
