// The kill script run on the Container only while it runs, never starting it (step 2a part 2's leftover race): the
// platform's `ctx.container`, faked. Its `exec` never starts a Container (only `start()` does), so a Container that
// stops between the check and the exec makes the exec fail rather than start it; that failure is "not running".
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";

import { killInRunningContainer, type RunningContainer } from "../src/workspace/containerKill.ts";

const encode = (text: string) => new TextEncoder().encode(text);

/** A platform Container that is `running`, answers `stdout`, and records its exec calls; `start` must never be called. */
const fakeContainer = (options: { running: boolean; stdout?: string; execFails?: Error; stopsBeforeExec?: boolean }) => {
  const calls: Array<ReadonlyArray<string>> = [];
  let running = options.running;
  const container = {
    get running() {
      return running;
    },
    start: () => {
      throw new Error("a kill must never start the Container");
    },
    exec: async (argv: ReadonlyArray<string>) => {
      calls.push(argv);
      if (options.stopsBeforeExec === true) {
        running = false;
        throw new Error("container is not running");
      }
      if (options.execFails !== undefined) throw options.execFails;
      return { output: async () => ({ exitCode: 0, stdout: encode(options.stdout ?? ""), stderr: encode("") }) };
    },
  };
  return { container: container as unknown as RunningContainer, calls };
};

describe("the kill script on the Container", () => {
  it("runs straight on a running Container, with the markers as arguments", async () => {
    const { container, calls } = fakeContainer({ running: true, stdout: '{"signalled":2,"survivors":0}\n' });
    expect(await killInRunningContainer(container, ["exec-1", "exec-2"])).toEqual({ exitCode: 0, stdout: '{"signalled":2,"survivors":0}\n', stderr: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(calls[0]?.slice(3)).toEqual(["t3flare-kill", "exec-1", "exec-2"]);
  });

  it("does nothing on a stopped Container, or without one, or without markers", async () => {
    const stopped = fakeContainer({ running: false });
    expect(await killInRunningContainer(stopped.container, ["exec-1"])).toBeUndefined();
    expect(stopped.calls).toHaveLength(0);
    expect(await killInRunningContainer(undefined, ["exec-1"])).toBeUndefined();
    const running = fakeContainer({ running: true });
    expect(await killInRunningContainer(running.container, [])).toBeUndefined();
    expect(running.calls).toHaveLength(0);
  });

  it("counts a Container that stopped between the check and the exec as not running, without starting it", async () => {
    const { container, calls } = fakeContainer({ running: true, stopsBeforeExec: true });
    expect(await killInRunningContainer(container, ["exec-1"])).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("fails when the exec fails on a Container still running", async () => {
    const { container } = fakeContainer({ running: true, execFails: new Error("internal error") });
    await expect(killInRunningContainer(container, ["exec-1"])).rejects.toThrow("internal error");
  });

  it("passes only ids the kill script can take", async () => {
    const { container, calls } = fakeContainer({ running: true });
    await killInRunningContainer(container, ["exec-1", "x; rm -rf /", "exec-2"]);
    expect(calls[0]?.slice(3)).toEqual(["t3flare-kill", "exec-1", "exec-2"]);
  });
});
