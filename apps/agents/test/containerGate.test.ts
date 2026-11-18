// The Container gate (the nightly's step 2b `leased: true`): a tombstoned worktree's close refuses later starts and waits
// out a start under way, so the stop after it is the last word and no lease outlives the removal.
import { describe, expect, it } from "vitest";

import { CLOSED_MESSAGE, ContainerGate, type GateStore } from "../src/workspace/containerGate.ts";

const store = (): GateStore & { readonly mark: () => boolean } => {
  let closed = false;
  return { closed: () => closed, setClosed: (value) => void (closed = value), mark: () => closed };
};

/** A start the test finishes by hand: the lease taken, the Container still coming up. */
const pendingStart = () => {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { run: () => done, finish, fail };
};

/**
 * A budget and a Container as the Workspace DO drives them: a start first reads its launch (`#launch()`, an await),
 * then leases and starts; a stop finds nothing running and releases nothing it does not hold.
 */
const workspace = (gate: ContainerGate) => {
  const state = { leased: false, running: false };
  const start = (pending: Promise<void>) =>
    gate.start(async () => {
      await pending;
      state.leased = true;
      state.running = true;
    });
  const stop = () => {
    state.running = false;
    state.leased = false;
  };
  return { state, start, stop };
};

describe("ContainerGate", () => {
  it("runs starts while open", async () => {
    const gate = new ContainerGate(store());
    expect(await gate.start(async () => "started")).toBe("started");
    expect(gate.starting).toBe(0);
  });

  it("closing waits out a start under way, so the stop after it leaves no lease", async () => {
    const gate = new ContainerGate(store());
    const ws = workspace(gate);
    const pending = pendingStart();
    const starting = ws.start(pending.run());
    expect(gate.starting).toBe(1);

    let closed = false;
    const closing = gate.close().then(() => void (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);

    pending.finish();
    await starting;
    await closing;
    expect(closed).toBe(true);
    ws.stop();
    expect(ws.state).toEqual({ leased: false, running: false });
  });

  it("without the gate's wait, the same order leaves the lease held (the failure it fixes)", async () => {
    const ws = workspace(new ContainerGate(store()));
    const pending = pendingStart();
    const starting = ws.start(pending.run());
    ws.stop();
    pending.finish();
    await starting;
    expect(ws.state).toEqual({ leased: true, running: true });
  });

  it("refuses every start once closed, before any of it runs, and keeps the mark in its store", async () => {
    const kept = store();
    const gate = new ContainerGate(kept);
    await gate.close();
    let ran = false;
    await expect(gate.start(async () => void (ran = true))).rejects.toThrow(CLOSED_MESSAGE);
    expect(ran).toBe(false);
    expect(kept.mark()).toBe(true);
    // A restarted object reads the same store: still closed.
    await expect(new ContainerGate(kept).start(async () => undefined)).rejects.toThrow(CLOSED_MESSAGE);
  });

  it("a failed start under way still ends the wait", async () => {
    const gate = new ContainerGate(store());
    const pending = pendingStart();
    const starting = gate.start(pending.run);
    const closing = gate.close();
    pending.fail(new Error("the Container cannot start: budget full"));
    await expect(starting).rejects.toThrow("budget full");
    await closing;
    expect(gate.starting).toBe(0);
  });

  it("waits for a start that began while it waited for another", async () => {
    const gate = new ContainerGate(store());
    const first = pendingStart();
    const second = pendingStart();
    const a = gate.start(first.run);
    const b = gate.start(second.run);
    let closed = false;
    const closing = gate.close().then(() => void (closed = true));
    first.finish();
    await a;
    await Promise.resolve();
    expect(closed).toBe(false);
    second.finish();
    await b;
    await closing;
    expect(closed).toBe(true);
  });

  it("starts again once reopened (a restored tombstone, a reprovisioned path)", async () => {
    const gate = new ContainerGate(store());
    await gate.close();
    gate.reopen();
    expect(await gate.start(async () => "started")).toBe("started");
  });
});
