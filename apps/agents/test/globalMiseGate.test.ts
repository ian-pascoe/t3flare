// @effect-diagnostics globalTimers:off
// "mise install runs before the first command of each Container start" (SPI-1150, ADR-0032): every command sent to
// the Container that is not a passive read waits for the lay-down, at the point it is sent (`GlobalMiseBackend`), whoever
// sends it: a Durable agent's command comes through computer, never `WorkspaceDO.exec`. Passive reads never run it.
// Terminals and CLI processes wait before their spawn (`readyForSpawn`).
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import { GlobalMiseBackend, PASSIVE_MARKER, readyForSpawn } from "../src/workspace/globalMiseGate.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A Container backend whose connect answers runtime `r1`, recording each command as it is sent. */
const container = (sent: Array<string>): WorkspaceBackend =>
  ({
    id: "container-shell",
    type: "cloudflare-container",
    connect: async () =>
      ({
        runtimeId: "r1",
        rpc: {
          sync: {},
          shell: {
            exec: async (input: { source: string; env?: Record<string, string> }) => {
              sent.push(`${input.source}${input.env?.[PASSIVE_MARKER] === undefined ? "" : " (marker kept!)"}`);
              return {} as never;
            },
            getExec: async () => ({}) as never,
            killExec: async () => undefined,
            disposeExec: async () => undefined,
          },
        },
        close: async () => undefined,
      }) as unknown as BackendHandle,
  }) as WorkspaceBackend;

/** A lay-down that ends when `release` is called; records what it was asked for. */
const layDown = () => {
  const asked: Array<string | undefined> = [];
  let release: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { asked, release: () => release(), ensure: (runtime: string | undefined) => {
      asked.push(runtime);
      return done;
    } };
};

const passive = (source: string) => ({ source, env: { [PASSIVE_MARKER]: "1", A: "x" } }) as never;
const active = (source: string) => ({ source, env: { T3FLARE_EXEC: "exec-1" } }) as never;

describe("GlobalMiseBackend", () => {
  it("a Durable agent's command arriving while a passive read holds the connect waits for the lay-down; the read does not", async () => {
    const sent: Array<string> = [];
    const gate = layDown();
    const handle = await new GlobalMiseBackend(container(sent), gate.ensure).connect({} as never);
    // A status poll (passive, marked by WorkspaceDO.exec) is in flight on the shared connect.
    await handle.rpc.shell.exec(passive("git status"));
    expect(sent).toEqual(["git status"]);
    expect(gate.asked).toEqual([]);
    // The agent's command (unmarked, through computer's stub) on the same handle.
    const agent = handle.rpc.shell.exec(active("node --version"));
    await tick();
    expect(gate.asked).toEqual(["r1"]);
    expect(sent).toEqual(["git status"]);
    gate.release();
    await agent;
    expect(sent).toEqual(["git status", "node --version"]);
  });

  it("a Container a passive read started still lays down before the first active command", async () => {
    const sent: Array<string> = [];
    const gate = layDown();
    const backend = new GlobalMiseBackend(container(sent), gate.ensure);
    // The passive read's connect starts the Container and its command runs without the lay-down.
    const first = await backend.connect({} as never);
    await first.rpc.shell.exec(passive("git rev-parse HEAD"));
    expect(gate.asked).toEqual([]);
    gate.release();
    await first.rpc.shell.exec(active("bash -c 'node --version'"));
    expect(gate.asked).toEqual(["r1"]);
    expect(sent).toEqual(["git rev-parse HEAD", "bash -c 'node --version'"]);
  });

  it("a Terminal's start on a stopped Container, with a passive read in flight, waits for the lay-down before its spawn", async () => {
    const sent: Array<string> = [];
    const gate = layDown();
    const handle = await new GlobalMiseBackend(container(sent), gate.ensure).connect({} as never);
    const read = handle.rpc.shell.exec(passive("git status"));
    // The Terminal host starts the Container with an active `true`, then spawns once it is ready.
    const events: Array<string> = [];
    const start = handle.rpc.shell.exec(active("true")).then(() => events.push("started"));
    const spawn = start.then(() => readyForSpawn({ running: () => true, runtime: () => "r1", start: async () => undefined, ensure: gate.ensure })).then(() => events.push("spawned"));
    await read;
    await tick();
    expect(events).toEqual([]);
    gate.release();
    await spawn;
    expect(events).toEqual(["started", "spawned"]);
    expect(sent).toEqual(["git status", "true"]);
  });
});

describe("readyForSpawn", () => {
  it("starts (and so lays down) through an active command when the runtime is not known yet, else waits for its lay-down", async () => {
    const calls: Array<string> = [];
    const deps = { start: async () => void calls.push("start"), ensure: async (runtime: string | undefined) => void calls.push(`ensure ${runtime}`) };
    await readyForSpawn({ ...deps, running: () => true, runtime: () => undefined });
    await readyForSpawn({ ...deps, running: () => true, runtime: () => "r2" });
    await readyForSpawn({ ...deps, running: () => false, runtime: () => "r2" });
    expect(calls).toEqual(["start", "ensure r2"]);
  });
});
