// t3's PTY seam in the Cloud Environment (step 2b, ADR-0021) at the adapter: what t3's TerminalManager sees of a shell
// whose Workspace DO is a fake. The env allowlist (review F0), write order, pushed frames, the foreground's state (F1),
// one close instead of SIGTERM/SIGKILL (F2), and the Workspace DO's epoch (F11).
// @effect-diagnostics globalTimers:off newPromise:off
import type { TerminalAnswer, TerminalOpenInput } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { filterTerminalEnv, SpawnRefused, type TerminalRemote, TerminalProcesses } from "../src/terminal/ptyAdapter.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const fakeRemote = (epoch = "e1") => {
  const calls: Array<string> = [];
  const opens: Array<TerminalOpenInput> = [];
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => (releaseOpen = resolve));
  let releaseInput: (() => void) | undefined;
  let answerEpoch = epoch;
  const answer = (): TerminalAnswer => ({ epoch: answerEpoch, unknown: [] });
  const remote: TerminalRemote = {
    terminalOpen: async (input) => {
      opens.push(input);
      await openGate;
      return answer();
    },
    terminalInput: async (key, data) => {
      calls.push(`input ${key} ${JSON.stringify(data)}`);
      if (data.startsWith("slow")) await new Promise<void>((resolve) => (releaseInput = resolve));
      return answer();
    },
    terminalResize: async (key, cols, rows) => {
      calls.push(`resize ${key} ${cols}x${rows}`);
      return answer();
    },
    terminalClose: async (key) => {
      calls.push(`close ${key}`);
      return answer();
    },
    terminalHeartbeat: async (keys) => {
      calls.push(`heartbeat ${keys.join(",")}`);
      return answer();
    },
  };
  return {
    remote,
    calls,
    opens,
    releaseOpen,
    releaseInput: () => releaseInput?.(),
    restart: (next: string) => void (answerEpoch = next),
  };
};

const setup = (remote = fakeRemote()) => {
  let n = 0;
  const processes = new TerminalProcesses({
    newKey: () => `term-k${++n}`,
    place: (cwd) => (cwd.startsWith("/w/demo") ? { workspace: "demo", t3Path: "/w/demo", remote: remote.remote } : undefined),
  });
  return { processes, remote };
};

const spawn = (processes: TerminalProcesses, env: Record<string, string> = {}) =>
  processes.spawn({ shell: "/bin/bash", cwd: "/w/demo", cols: 80, rows: 24, env: { TERM: "xterm-256color", ...env } });

describe("the terminal env", () => {
  it("keeps terminal, locale and t3's keys, and drops anything named like a credential", () => {
    const { env, droppedCredentials } = filterTerminalEnv({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      T3CODE_PROJECT_ROOT: "/w/demo",
      T3CODE_WORKTREE_PATH: "/w/.wt/demo/x",
      PATH: "/usr/bin",
      HOME: "/t3/home",
      MODEL_PROXY_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghs_x",
      T3CODE_AUTH_TOKEN: "x",
      fish_features: "no-query-term",
    });
    expect(env).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      T3CODE_PROJECT_ROOT: "/w/demo",
      T3CODE_WORKTREE_PATH: "/w/.wt/demo/x",
    });
    expect(droppedCredentials).toEqual(["MODEL_PROXY_API_KEY", "GITHUB_TOKEN", "T3CODE_AUTH_TOKEN"]);
  });
});

describe("TerminalProcesses", () => {
  it("refuses other shells as not found, so t3 tries its next shell", () => {
    const { processes } = setup();
    expect(() => processes.spawn({ shell: "/bin/zsh", cwd: "/w/demo", cols: 80, rows: 24, env: {} })).toThrow(SpawnRefused);
  });

  it("opens with the filtered env, queues writes until the open answers, then sends them in order, one RPC at a time", async () => {
    const { processes, remote } = setup();
    const process = spawn(processes, { SECRET_KEY: "x", T3CODE_PROJECT_ROOT: "/w/demo" });
    expect(process.pid).toBeGreaterThanOrEqual(100_000);
    expect(remote.opens[0]).toMatchObject({ key: "term-k1", t3Path: "/w/demo", cwd: "/w/demo", env: { TERM: "xterm-256color", T3CODE_PROJECT_ROOT: "/w/demo" } });
    process.write("a");
    process.write("b");
    process.resize(100, 30);
    await tick();
    expect(remote.calls).toEqual([]);
    remote.releaseOpen();
    await tick();
    expect(remote.calls).toEqual(["resize term-k1 100x30", 'input term-k1 "ab"']);
    process.write("slow");
    await tick();
    process.write("c");
    process.write("d");
    await tick();
    expect(remote.calls.filter((call) => call.startsWith("input"))).toEqual(['input term-k1 "ab"', 'input term-k1 "slow"']);
    remote.releaseInput();
    await tick();
    expect(remote.calls.filter((call) => call.startsWith("input")).at(-1)).toBe('input term-k1 "cd"');
  });

  it("delivers pushed frames in order, sets the foreground's state before the batch's data, and ends on the exit frame", async () => {
    const { processes, remote } = setup();
    const process = spawn(processes);
    remote.releaseOpen();
    await tick();
    const seen: Array<string> = [];
    process.onData((data) => seen.push(`${data}|busy=${processes.busy(process.pid)}`));
    const exits: Array<number> = [];
    process.onExit((exit) => exits.push(exit.exitCode));
    processes.deliver({
      workspace: "demo",
      epoch: "e1",
      frames: [
        { key: "term-k1", seq: 0, data: "__T3_SETUP_DONE__:0\r\n" },
        { key: "term-k1", seq: 1, busy: false },
        { key: "term-k1", seq: 0, data: "a stale duplicate" },
      ],
    });
    expect(seen).toEqual(["__T3_SETUP_DONE__:0\r\n|busy=false"]);
    expect(processes.deliver({ workspace: "demo", epoch: "e1", frames: [{ key: "term-k1", seq: 2, busy: true }, { key: "term-zz", seq: 0, data: "x" }] })).toEqual({ unknown: ["term-zz"] });
    expect(processes.busy(process.pid)).toBe(true);
    processes.deliver({ workspace: "demo", epoch: "e1", frames: [{ key: "term-k1", seq: 3, exit: { code: 3 } }] });
    expect(exits).toEqual([3]);
    expect(processes.size).toBe(0);
    expect(processes.deliver({ workspace: "demo", epoch: "e1", frames: [{ key: "term-k1", seq: 4, data: "late" }] })).toEqual({ unknown: ["term-k1"] });
  });

  it("sends one close for t3's SIGTERM and SIGKILL, and a kill before the open answers is sent after it", async () => {
    const { processes, remote } = setup();
    const process = spawn(processes);
    process.kill("SIGTERM");
    process.kill("SIGKILL");
    await tick();
    expect(remote.calls).toEqual([]);
    remote.releaseOpen();
    await tick();
    expect(remote.calls).toEqual(["close term-k1"]);
  });

  it("ends a terminal when the Workspace DO answers from a new instance (it lost the shell)", async () => {
    const { processes, remote } = setup();
    const process = spawn(processes);
    remote.releaseOpen();
    await tick();
    const exits: Array<number> = [];
    process.onExit((exit) => exits.push(exit.exitCode));
    await processes.beat();
    expect(exits).toEqual([]);
    remote.restart("e2");
    await processes.beat();
    expect(remote.calls.filter((call) => call.startsWith("heartbeat"))).toEqual(["heartbeat term-k1", "heartbeat term-k1"]);
    expect(exits).toEqual([129]);
  });
});
