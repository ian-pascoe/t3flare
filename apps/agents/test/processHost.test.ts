// The Workspace DO's CLI processes (step 4a, the process channel) at their seam, `ProcessHost`, over a fake non-PTY
// exec: what the Environment's spawner sees pushed, what reaches the process's stdin, and what the kill script gets.
// Review F6 (ordered input that never skips, bytes, never-dropped output), F7 (the hold), F8 (linked work while a
// process lives) and plan §2.6 (epochs).
// @effect-diagnostics globalTimers:off newPromise:off globalDate:off
import type { ProcessFrame, ProcessStartInput } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import {
  bytes,
  CLI_IDLE_HOLD_MS,
  type CliProcess,
  HEARTBEAT_LAPSE_MS,
  ProcessHost,
  type ProcessHostDeps,
  type ProcessMarker,
  RECLAIMABLE_AFTER_MS,
  textOf,
} from "../src/workspace/processHost.ts";

const decoder = new TextDecoder();
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeProcess = (options: { failWrites?: boolean } = {}) => {
  const written: Array<string> = [];
  let stdinClosed = false;
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const process: CliProcess = {
    stdin: new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (options.failWrites === true) throw new Error("broken pipe");
        written.push(decoder.decode(chunk));
      },
      close: () => void (stdinClosed = true),
    }),
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => void (out = controller) }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => void (err = controller) }),
    exitCode: new Promise<number>((resolve) => (exit = resolve)),
  };
  return {
    process,
    written,
    stdinClosed: () => stdinClosed,
    out: (text: string) => out.enqueue(bytes(text)),
    outBytes: (data: Uint8Array) => out.enqueue(data),
    err: (text: string) => err.enqueue(bytes(text)),
    exit: (code: number) => {
      out.close();
      err.close();
      exit(code);
    },
  };
};

const harness = (options: { running?: boolean; refuse?: string; maxProcesses?: number; failWrites?: boolean } = {}) => {
  let now = 1_000_000;
  let running = options.running ?? true;
  let ack = 0;
  const procs: Array<ReturnType<typeof fakeProcess>> = [];
  const spawned: Array<{ argv: ReadonlyArray<string>; env: Record<string, string> }> = [];
  const frames: Array<ProcessFrame> = [];
  const killed: Array<ReadonlyArray<string>> = [];
  const linked: Array<[string, boolean]> = [];
  let remembered: ReadonlyArray<ProcessMarker> = [];
  const deps: ProcessHostDeps = {
    now: () => now,
    epoch: 7,
    running: () => running,
    startContainer: async () => {
      if (options.refuse !== undefined) throw new Error(options.refuse);
      running = true;
    },
    spawn: async (argv, env) => {
      const proc = fakeProcess(options.failWrites === true ? { failWrites: true } : {});
      procs.push(proc);
      spawned.push({ argv, env });
      return proc.process;
    },
    kill: async (markers) => void killed.push(markers),
    baseEnv: { PATH: "/usr/bin", MISE_YES: "1" },
    remember: (markers) => void (remembered = markers),
    remembered: () => remembered,
    filesMayHaveChanged: () => undefined,
    maxProcesses: options.maxProcesses ?? 4,
    allowProbe: true,
    linkedWork: (thread, alive) => void linked.push([thread, alive]),
  };
  const host = new ProcessHost(deps);
  /** The Environment's reads until nothing is left, each acknowledged. */
  const drain = async (keys: ReadonlyArray<string> = []) => {
    for (let i = 0; i < 20; i++) {
      const answer = await host.read({ keys, ack, waitMs: 0 });
      if (answer.batch === 0) return;
      ack = answer.batch;
      frames.push(...answer.frames);
    }
  };
  return {
    host,
    drain,
    procs,
    spawned,
    frames,
    killed,
    linked,
    advance: (ms: number) => void (now += ms),
    setRemembered: (markers: ReadonlyArray<ProcessMarker>) => void (remembered = markers),
    remembered: () => remembered,
    stop: () => void (running = false),
  };
};

const start = (key: string, extra: Partial<ProcessStartInput> = {}): ProcessStartInput => ({
  key,
  environmentEpoch: 3,
  cli: "codex",
  t3Path: "/w/demo",
  cwd: "/w/demo",
  argv: ["/opt/t3flare/bin/codex", "app-server"],
  env: { CODEX_HOME: "/var/lib/t3flare/cli/x/codex" },
  thread: "thread-1",
  ...extra,
});

describe("ProcessHost", () => {
  it("starts the Container through the budget, then the CLI under the launcher with its marker", async () => {
    const h = harness({ running: false });
    const answer = await h.host.start(start("proc-a"));
    expect(answer).toEqual({ ok: true, epoch: 7 });
    expect(h.spawned[0]!.argv[0]).toBe("bash");
    expect(h.spawned[0]!.argv[2]).toContain("exec setsid --wait '/opt/t3flare/bin/codex' 'app-server'");
    expect(h.spawned[0]!.env).toMatchObject({ T3FLARE_EXEC: "proc-a", CODEX_HOME: "/var/lib/t3flare/cli/x/codex", PATH: "/usr/bin" });
    expect(h.remembered()).toEqual([{ key: "proc-a", environmentEpoch: 3, thread: "thread-1" }]);
  });

  it("fails the start with the budget's reason", async () => {
    const h = harness({ running: false, refuse: "the Container cannot start: 3 Containers are running" });
    expect(await h.host.start(start("proc-a"))).toEqual({ ok: false, epoch: 7, reason: "the Container cannot start: 3 Containers are running" });
    expect(h.spawned).toHaveLength(0);
  });

  it("weighs Claude Code and OpenCode as two Codex processes each (step 4b, M0 P7's memory)", async () => {
    const h = harness({ maxProcesses: 4 });
    expect((await h.host.start(start("proc-a", { cli: "claude" }))).ok).toBe(true);
    expect((await h.host.start(start("proc-b", { cli: "opencode" }))).ok).toBe(true);
    const third = await h.host.start(start("proc-c", { cli: "codex" }));
    expect(third.ok).toBe(false);
    expect(h.spawned).toHaveLength(2);
  });

  it("refuses past the per-Workspace cap", async () => {
    const h = harness({ maxProcesses: 1 });
    await h.host.start(start("proc-a"));
    const answer = await h.host.start(start("proc-b"));
    expect(answer.ok).toBe(false);
    expect(h.spawned).toHaveLength(1);
  });

  it("kills the processes of another Environment epoch, and an earlier instance's orphans, before starting", async () => {
    const h = harness();
    h.setRemembered([
      { key: "proc-old", environmentEpoch: 2, thread: "thread-1" },
      { key: "proc-orphan", environmentEpoch: 3 },
    ]);
    await h.host.start(start("proc-new"));
    expect(h.killed[0]).toEqual(["proc-old", "proc-orphan"]);
    expect(h.spawned).toHaveLength(1);
    expect(h.remembered().map((marker) => marker.key)).toEqual(["proc-new"]);
  });

  it("pushes stdout and stderr as bytes in one ordered sequence, and the exit after every byte", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    const proc = h.procs[0]!;
    proc.out('{"id":1,');
    proc.err("warn\n");
    proc.outBytes(new Uint8Array([0x22, 0xe2, 0x82]));
    proc.outBytes(new Uint8Array([0xac, 0x22, 0x7d, 0x0a]));
    proc.exit(0);
    await tick(150);
    await h.drain();
    expect(h.frames.map((frame) => frame.seq)).toEqual(h.frames.map((_, index) => index));
    expect(textOf(h.frames, "proc-a", "stdout")).toBe('{"id":1,"€"}\n');
    expect(textOf(h.frames, "proc-a", "stderr")).toBe("warn\n");
    expect(h.frames.at(-1)).toMatchObject({ key: "proc-a", stream: "exit", code: 0 });
    expect(h.frames.filter((frame) => frame.data !== undefined).every((frame) => frame.data instanceof Uint8Array)).toBe(true);
  });

  it("writes input in seq order: a duplicate is acknowledged, a gap kills, null closes stdin", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    expect((await h.host.input("proc-a", 0, bytes("one\n"))).accepted).toBe("written");
    expect((await h.host.input("proc-a", 0, bytes("one\n"))).accepted).toBe("duplicate");
    expect((await h.host.input("proc-a", 1, bytes("two\n"))).accepted).toBe("written");
    expect((await h.host.input("proc-a", 2, null)).accepted).toBe("written");
    expect(h.procs[0]!.written).toEqual(["one\n", "two\n"]);
    expect(h.procs[0]!.stdinClosed()).toBe(true);
    await h.host.start(start("proc-b"));
    expect((await h.host.input("proc-b", 3, bytes("x"))).accepted).toBe("gap");
    expect(h.killed).toContainEqual(["proc-b"]);
  });

  it("kills a process whose write failed, rather than skipping the bytes", async () => {
    const h = harness({ failWrites: true });
    await h.host.start(start("proc-a"));
    expect((await h.host.input("proc-a", 0, bytes("x"))).accepted).toBe("failed");
    expect(h.killed).toContainEqual(["proc-a"]);
  });

  it("sends a batch again when its read's answer was lost (the next read does not acknowledge it)", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    h.procs[0]!.out("hello\n");
    await tick(20);
    const first = await h.host.read({ keys: ["proc-a"], ack: 0, waitMs: 0 });
    expect(textOf(first.frames, "proc-a", "stdout")).toBe("hello\n");
    const again = await h.host.read({ keys: ["proc-a"], ack: 0, waitMs: 0 });
    expect(again).toMatchObject({ batch: first.batch, frames: first.frames });
    const next = await h.host.read({ keys: ["proc-a"], ack: first.batch, waitMs: 0 });
    expect(next).toMatchObject({ batch: 0, frames: [] });
  });

  it("waits for output in a read, and answers the keys it does not hold", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    const reading = h.host.read({ keys: ["proc-a", "proc-gone"], ack: 0, waitMs: 5_000 });
    await tick(30);
    h.procs[0]!.out("late\n");
    const answer = await reading;
    expect(answer.unknown).toEqual(["proc-gone"]);
    expect(textOf(answer.frames, "proc-a", "stdout")).toBe("late\n");
  });

  it("kills a process whose heartbeats lapsed, and answers the keys it does not hold", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    expect(h.host.heartbeat(["proc-a", "proc-gone"])).toEqual({ epoch: 7, unknown: ["proc-gone"] });
    h.advance(HEARTBEAT_LAPSE_MS - 1);
    expect(await h.host.expire()).toBe(0);
    h.advance(1);
    expect(await h.host.expire()).toBe(1);
    expect(h.killed).toContainEqual(["proc-a"]);
  });

  it("kills an earlier instance's process when the Environment heartbeats a key this instance does not hold", async () => {
    const h = harness();
    h.setRemembered([{ key: "proc-orphan", environmentEpoch: 3, thread: "t", linked: true }]);
    h.host.heartbeat(["proc-orphan"]);
    await tick(20);
    expect(h.killed).toEqual([["proc-orphan"]]);
    expect(h.linked).toEqual([["t", false]]);
    expect(h.remembered()).toEqual([]);
  });

  it("holds the Container during a turn and for the idle hold after it, then lets it go (review F7)", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    h.host.turn("proc-a", true);
    h.advance(CLI_IDLE_HOLD_MS * 3);
    expect(h.host.holdsContainer()).toBe(true);
    expect(h.host.reclaimable()).toEqual([]);
    h.host.turn("proc-a", false);
    h.advance(RECLAIMABLE_AFTER_MS);
    expect(h.host.reclaimable()).toEqual(["proc-a"]);
    h.advance(CLI_IDLE_HOLD_MS - RECLAIMABLE_AFTER_MS - 1);
    expect(h.host.holdsContainer()).toBe(true);
    h.advance(1);
    expect(h.host.holdsContainer()).toBe(false);
  });

  it("holds linked work while a linked thread's process lives, and releases it at the exit (review F8)", async () => {
    const h = harness();
    await h.host.start(start("proc-a", { linked: true, thread: "thread-9" }));
    expect(h.linked).toEqual([["thread-9", true]]);
    h.procs[0]!.exit(0);
    await tick(50);
    expect(h.linked).toEqual([
      ["thread-9", true],
      ["thread-9", false],
    ]);
  });

  it("ends every process by marker before a stop and waits for their exits", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    await h.host.start(start("proc-b"));
    const stopping = h.host.stopAll(2000);
    await tick(20);
    expect(h.killed).toEqual([["proc-a"], ["proc-b"]]);
    for (const proc of h.procs) proc.exit(143);
    expect(await stopping).toBe(2);
    expect(h.host.size).toBe(0);
  });

  it("ends every process with exit 129 when the Container stops", async () => {
    const h = harness();
    await h.host.start(start("proc-a"));
    h.stop();
    h.host.containerStopped();
    await h.drain();
    expect(h.frames.at(-1)).toMatchObject({ key: "proc-a", stream: "exit", code: 129 });
    expect(h.host.size).toBe(0);
  });

  it("refuses the probe program unless the stage allows it, and a binary that is not absolute", async () => {
    const h = harness();
    const answer = await h.host.start(start("proc-a", { argv: ["codex", "app-server"] }));
    expect(answer).toMatchObject({ ok: false });
  });
});
