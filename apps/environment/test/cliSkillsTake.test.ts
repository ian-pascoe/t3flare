// @effect-diagnostics globalTimers:off
// SPI-1153 (hand-off A1): a CLI agent's Workspace takes the Environment skill set before the CLI's process starts and
// before each of its turns, on the Environment's side, bounded and never failing either. The take itself
// (`takeEnvironmentSkillsAt`), the spawner's take before the process channel starts (`spawnCli`), and the wrapper's
// default take before the inner adapter's turn, for each of the four CLI drivers, ahead of the turn's hold and cap.
import * as ChildProcess from "effect/process/ChildProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { spawnCli } from "../src/agents/cliProcess.ts";
import { takeEnvironmentSkillsAt } from "../src/provider/cli/environmentSkillsTake.ts";
import { type CliSessions, wrapCliAdapter } from "../src/provider/cli/wrapper.ts";

const log: Array<string> = [];

/** The Environment's services as the take and the spawner read them: Workspace `demo`, the set's hash `h1`. */
const bind = (hash: () => string = () => "h1") =>
  bindEnvironmentServices({
    workspaces: { list: () => [], resolve: (id: string) => (id === "demo" ? { id } : undefined), get: () => undefined, worktreesOf: () => [] },
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          takeEnvironmentSkills: async (taken: string) => {
            log.push(`take ${name} ${taken}`);
            return { taken: false, hash: taken };
          },
        }),
      },
    },
    environmentSkills: () => ({ hash }),
    modelProxy: undefined,
    catalog: { current: () => ({ models: [] }) },
    faults: true,
    relayServers: () => [],
    processes: {
      newKey: () => "proc-1",
      start: async (input: { cli: string }) => {
        log.push(`start ${input.cli}`);
        return { cli: input.cli, pid: 1, running: true, exit: new Promise(() => undefined), kill: () => undefined, write: async () => undefined, closeStdin: async () => undefined, stdout: (async function* () {})(), stderr: (async function* () {})() };
      },
    },
  } as unknown as EnvironmentServices);

afterEach(() => {
  log.length = 0;
  vi.restoreAllMocks();
});

describe("takeEnvironmentSkillsAt", () => {
  it("has the Workspace of the cwd take the Environment's hash", async () => {
    const taker = { takeEnvironmentSkills: vi.fn(async (hash: string) => ({ taken: true, hash })) };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await Effect.runPromise(takeEnvironmentSkillsAt("/w/demo/pkg", { hash: () => "h1", workspace: (cwd) => (cwd.startsWith("/w/demo") ? taker : undefined) }));
    expect(taker.takeEnvironmentSkills).toHaveBeenCalledWith("h1");
  });

  it("asks nothing without a cwd, outside a Workspace, or without a hash", async () => {
    const taker = { takeEnvironmentSkills: vi.fn() };
    await Effect.runPromise(takeEnvironmentSkillsAt(null, { hash: () => "h1", workspace: () => taker }));
    await Effect.runPromise(takeEnvironmentSkillsAt("/elsewhere", { hash: () => "h1", workspace: () => undefined }));
    await Effect.runPromise(takeEnvironmentSkillsAt("/w/demo", { hash: () => undefined, workspace: () => taker }));
    expect(taker.takeEnvironmentSkills).not.toHaveBeenCalled();
  });

  it("never fails: a registry that throws, a Workspace that refuses or rejects, one that does not answer in time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await Effect.runPromise(
      takeEnvironmentSkillsAt("/w/demo", {
        hash: () => "h1",
        workspace: () => {
          throw new Error("no services");
        },
      }),
    );
    await Effect.runPromise(takeEnvironmentSkillsAt("/w/demo", { hash: () => "h1", workspace: () => ({ takeEnvironmentSkills: () => Promise.reject(new Error("down")) }) }));
    const started = Date.now();
    await Effect.runPromise(takeEnvironmentSkillsAt("/w/demo", { hash: () => "h1", workspace: () => ({ takeEnvironmentSkills: () => new Promise(() => undefined) }) }, 30));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads the Environment's own hash and registry by default, and asks nothing when the services are not bound", async () => {
    bind();
    await Effect.runPromise(takeEnvironmentSkillsAt("/w/demo"));
    expect(log).toEqual(["take demo h1"]);
  });
});

describe("spawnCli", () => {
  it("has the Workspace take the set before the process channel starts the CLI", async () => {
    bind();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await Effect.runPromise(spawnCli(ChildProcess.make("t3flare-probe", [], { cwd: "/w/demo" }) as ChildProcess.StandardCommand).pipe(Effect.scoped));
    expect(log).toEqual(["take demo h1", "start probe"]);
  });

  it("starts the CLI when the take cannot be made", async () => {
    bind(() => {
      throw new Error("the store is down");
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await Effect.runPromise(spawnCli(ChildProcess.make("t3flare-probe", [], { cwd: "/w/demo" }) as ChildProcess.StandardCommand).pipe(Effect.scoped));
    expect(log).toEqual(["start probe"]);
  });
});

/** An inner adapter that records its turns: what each CLI driver's t3 adapter is to the wrapper. */
const innerAdapter = (driver: string) =>
  ({
    instanceId: driver,
    driver,
    getCapabilities: () => Effect.succeed({ sessions: {}, tools: {} }),
    planSelectionTransition: () => Effect.die("unused"),
    openSession: () =>
      Effect.succeed({
        providerSession: { capabilities: { sessions: {}, tools: {} } },
        events: Stream.empty,
        startTurn: () => Effect.sync(() => void log.push("inner startTurn")),
        respondToRuntimeRequest: () => Effect.void,
        forkThread: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
      }),
  }) as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: "/w/demo" };
const turnInput = { threadId: "t1", runId: "r1", rootNodeId: "n1", providerThread: { id: "pt1" }, providerTurnOrdinal: 1, runtimePolicy: policy, message: { text: "hello" } } as never;

const openWrapped = (driver: string, sessions: CliSessions, take?: (cwd: string | null) => Effect.Effect<void>) =>
  wrapCliAdapter(innerAdapter(driver), { sessions, ...(take === undefined ? {} : { takeEnvironmentSkills: take }) }).openSession({ threadId: "t1", providerSessionId: "s1", runtimePolicy: policy } as never);

describe("wrapCliAdapter's take", () => {
  it("is every driver's by default: the Workspace takes the set before the inner adapter's turn", async () => {
    bind();
    for (const driver of ["codex", "pi", "claudeAgent", "opencode"]) {
      log.length = 0;
      await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* openWrapped(driver, new Map());
          yield* runtime.startTurn(turnInput);
        }).pipe(Effect.scoped),
      );
      expect(log, driver).toEqual(["take demo h1", "inner startTurn"]);
    }
  });

  it("comes before the turn's hold and cap: an interrupt during its wait leaves neither behind", async () => {
    const sessions: CliSessions = new Map();
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* openWrapped("claudeAgent", sessions, () => Effect.never);
        const turn = yield* Effect.forkChild(runtime.startTurn(turnInput));
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(turn);
        const session = sessions.get("s1")!;
        expect(session.turnActive).toBe(false);
        expect(session.capFiber).toBeUndefined();
        expect(log).toEqual([]);
      }).pipe(Effect.scoped),
    );
  });
});
