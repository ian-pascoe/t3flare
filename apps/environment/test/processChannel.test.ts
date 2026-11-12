// The Environment's half of the process channel (step 4a) at its seam, `ProcessChannel`, over a fake Workspace DO:
// starts and refusals, ordered gap-free input that is retried but never skipped, output delivered in order with
// duplicates dropped, backpressure on stdout, stderr that cannot stall it, and the epoch (review F6).
// @effect-diagnostics globalTimers:off newPromise:off globalDate:off
import type { ProcessAnswer, ProcessInputAnswer, ProcessStartAnswer, ProcessStartInput } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { ByteQueue, ProcessChannel, ProcessRefused, type ProcessRemote } from "../src/agents/processChannel.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const fakeWorkspace = (options: { start?: ProcessStartAnswer; loseAnswers?: number; inputAnswer?: ProcessInputAnswer["accepted"] } = {}) => {
  const starts: Array<ProcessStartInput> = [];
  const inputs: Array<{ key: string; seq: number; data: string | null }> = [];
  const signals: Array<string> = [];
  const turns: Array<[string, boolean]> = [];
  let lose = options.loseAnswers ?? 0;
  let epoch = 5;
  const answer = (unknown: ReadonlyArray<string> = []): ProcessAnswer => ({ epoch, unknown });
  const remote: ProcessRemote = {
    processStart: async (input) => {
      starts.push(input);
      return options.start ?? { ok: true, epoch };
    },
    processInput: async (key, seq, data) => {
      inputs.push({ key, seq, data: data === null ? null : decoder.decode(data) });
      if (lose > 0) {
        lose--;
        throw new Error("network connection lost");
      }
      return { ...answer(), accepted: options.inputAnswer ?? "written" };
    },
    processTurn: async (key, active) => {
      turns.push([key, active]);
      return answer();
    },
    processSignal: async (key) => {
      signals.push(key);
      return answer();
    },
    processHeartbeat: async (keys) => answer(keys.filter((key) => key === "gone")),
  };
  return { remote, starts, inputs, signals, turns, restart: () => void (epoch += 1) };
};

const channel = (workspace: ReturnType<typeof fakeWorkspace>) => {
  let n = 0;
  return new ProcessChannel({
    environmentEpoch: 12,
    place: (cwd) => (cwd.startsWith("/w/demo") ? { workspace: "demo", t3Path: "/w/demo", remote: workspace.remote } : undefined),
    newKey: () => `proc-${++n}`,
  });
};

const start = { cli: "codex" as const, cwd: "/w/demo", argv: ["/opt/t3flare/bin/codex", "app-server"], env: {}, thread: "t1" };
const readAll = async (queue: ByteQueue) => {
  let text = "";
  for await (const chunk of queue) text += decoder.decode(chunk, { stream: true });
  return text;
};

describe("ProcessChannel", () => {
  it("starts in the cwd's Workspace with the Environment's epoch, and refuses a cwd in none before any RPC", async () => {
    const ws = fakeWorkspace();
    const ch = channel(ws);
    const process = await ch.start(start);
    expect(ws.starts[0]).toMatchObject({ key: "proc-1", environmentEpoch: 12, t3Path: "/w/demo", cwd: "/w/demo", thread: "t1" });
    expect(process.pid).toBeGreaterThan(1);
    await expect(ch.start({ ...start, cwd: "/t3/scratch" })).rejects.toThrow(/start the thread in a project/);
    expect(ws.starts).toHaveLength(1);
  });

  it("fails the start with the Workspace's reason (the budget's)", async () => {
    const ws = fakeWorkspace({ start: { ok: false, epoch: 5, reason: "the Container cannot start: 3 Containers are running" } });
    await expect(channel(ws).start(start)).rejects.toThrow(ProcessRefused);
  });

  it("sends stdin in order without gaps, retrying a lost answer with the same seq", async () => {
    const ws = fakeWorkspace({ loseAnswers: 1 });
    const process = await channel(ws).start(start);
    void process.write(encoder.encode("one\n"));
    void process.write(encoder.encode("two\n"));
    await process.closeStdin();
    expect(ws.inputs.map((input) => [input.seq, input.data])).toEqual([
      [0, "one\n"],
      [0, "one\n"],
      [1, "two\n"],
      [2, null],
    ]);
  });

  it("ends the process when the Workspace refuses a write, never skipping it", async () => {
    const ws = fakeWorkspace({ inputAnswer: "gap" });
    const process = await channel(ws).start(start);
    await process.write(encoder.encode("x"));
    expect(await process.exit).toBe(129);
    await process.write(encoder.encode("y"));
    expect(ws.inputs).toHaveLength(1);
  });

  it("delivers frames in order, drops duplicates, and ends with the exit code", async () => {
    const ws = fakeWorkspace();
    const ch = channel(ws);
    const process = await ch.start(start);
    const out = readAll(process.stdout);
    const frame = (seq: number, text: string) => ({ key: "proc-1", seq, stream: "stdout" as const, data: encoder.encode(text) });
    await ch.deliver({ workspace: "demo", epoch: 5, frames: [frame(0, "a"), frame(1, "b")] });
    await ch.deliver({ workspace: "demo", epoch: 5, frames: [frame(1, "b"), frame(2, "c"), { key: "proc-1", seq: 3, stream: "exit", code: 3 }] });
    expect(await out).toBe("abc");
    expect(await process.exit).toBe(3);
  });

  it("answers keys it does not know, and frames from another Workspace instance, as unknown", async () => {
    const ws = fakeWorkspace();
    const ch = channel(ws);
    await ch.start(start);
    const answer = await ch.deliver({
      workspace: "demo",
      epoch: 6,
      frames: [
        { key: "proc-1", seq: 0, stream: "stdout", data: encoder.encode("x") },
        { key: "proc-9", seq: 0, stream: "stdout", data: encoder.encode("y") },
      ],
    });
    expect(answer.unknown.toSorted()).toEqual(["proc-1", "proc-9"]);
  });

  it("holds the Workspace's push while stdout is full, and never lets stderr stall it", async () => {
    const queue = new ByteQueue(10, "wait");
    await queue.offer(encoder.encode("12345678"));
    let offered = false;
    const pending = queue.offer(encoder.encode("abcdef")).then(() => (offered = true));
    await tick();
    expect(offered).toBe(false);
    await queue.take();
    await pending;
    expect(offered).toBe(true);
    const errors = new ByteQueue(10, "drop-oldest");
    await errors.offer(encoder.encode("12345678"));
    await errors.offer(encoder.encode("abcdef"));
    expect(errors.dropped).toBe(8);
  });

  it("ends a process the heartbeat names unknown, or whose Workspace answers with another epoch", async () => {
    const ws = fakeWorkspace();
    const ch = channel(ws);
    const process = await ch.start(start);
    ws.restart();
    process.turn(true);
    expect(await process.exit).toBe(129);
    expect(ch.size).toBe(0);
  });

  it("ends a Workspace's processes after three failed heartbeats in a row (its lapse killed them there)", async () => {
    const ws = fakeWorkspace();
    const ch = channel(ws);
    const process = await ch.start(start);
    ws.remote.processHeartbeat = async () => {
      throw new Error("stub broken");
    };
    await ch.beat();
    await ch.beat();
    expect(process.running).toBe(true);
    await ch.beat();
    expect(await process.exit).toBe(129);
  });

  it("kills through the Workspace by marker, and finds a process by its pid", async () => {
    const ws = fakeWorkspace();
    const ch = channel(ws);
    const process = await ch.start(start);
    expect(ch.byPid(process.pid)).toBe(process);
    process.kill();
    process.kill();
    await tick();
    expect(ws.signals).toEqual(["proc-1"]);
  });
});
