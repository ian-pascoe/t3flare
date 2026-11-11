// t3's real terminal stack over ours (step 2b, plan M1/M3 "Node with real processes"): t3's `makeWithOptions` with our
// options, t3's real `ProjectSetupScriptRunner`, our PTY adapter, and our Workspace DO terminal host, wired in process,
// whose shells are a real bash under a real PTY (`script`) with our rc file (its markers). Covers open, write, the
// foreground's state through `closeIdle` (review F1), and the setup script's sentinel with exit codes 0 and 3.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off newPromise:off
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as ProjectionStore from "t3/src/orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "t3/src/processRunner.ts";
import * as ProjectService from "t3/src/project/ProjectService.ts";
import * as SetupRunner from "t3/src/project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";
import * as TerminalManager from "t3/src/terminal/Manager.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { terminalRc } from "../../sandbox-image/src/terminal.ts";
import { type ShellProcess, TerminalHost } from "../../agents/src/workspace/terminalHost.ts";
import { TerminalProcesses } from "../src/terminal/ptyAdapter.ts";
import { terminalManagerOptions } from "../src/terminal/layer.ts";

const BASH = ["/opt/homebrew/bin/bash", "/usr/bin/bash", "/bin/bash"].find((candidate) => {
  if (!fs.existsSync(candidate)) return false;
  const version = spawnSync(candidate, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout.trim();
  return Number(version) >= 5; // bracketed paste, which t3's setup runner waits for
});
// Python's pty module makes the PTY (util-linux/BSD `script` want a terminal on stdin).
const PYTHON = spawnSync("python3", ["-c", "import pty"]).status === 0 ? "python3" : undefined;

let dir: string;
let runtime: ManagedRuntime.ManagedRuntime<TerminalManager.TerminalManager | SetupRunner.ProjectSetupScriptRunner, never>;
const shells: Array<ReturnType<typeof spawn>> = [];
const demo = () => path.join(dir, "demo");

/** A real bash under a real PTY with our rc file, as the platform's PTY exec runs the wrapper's last `exec bash`. */
const spawnShell = (env: Record<string, string>): ShellProcess => {
  const rc = path.join(dir, `rc-${shells.length}`);
  fs.writeFileSync(rc, `${terminalRc().replace(/^HISTFILE=.*$/m, `HISTFILE=${dir}/history`).replace(/^.*mise activate.*$/m, "")}\n`);
  const command = [BASH!, "--rcfile", rc, "-i"];
  const argv = ["-c", "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)", ...command];
  const child = spawn(PYTHON!, argv, { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  shells.push(child);
  return {
    stdin: Writable.toWeb(child.stdin!) as WritableStream,
    stdout: Readable.toWeb(child.stdout!) as ReadableStream,
    exitCode: new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)))),
    resize: () => undefined,
  };
};

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-stack-")));
  // t3 checks the cwd exists: the Workspace's path is a real folder here, and so is a folder in no Workspace (as t3's
  // "No project" folder, `/t3/scratch`, is in the Cloud Environment).
  fs.mkdirSync(path.join(dir, "demo"));
  fs.mkdirSync(path.join(dir, "scratch"));
  let processes!: TerminalProcesses;
  const host: TerminalHost = new TerminalHost({
    now: () => Date.now(),
    epoch: "epoch-1",
    running: () => true,
    startContainer: async () => undefined,
    spawn: async (_argv, options) => spawnShell(options.env),
    // The kill script's place: the shell's session is the PTY's, so SIGHUP to the PTY's owner ends it.
    kill: async (markers) => {
      for (const child of shells) if (markers.length > 0 && child.exitCode === null) child.kill("SIGHUP");
    },
    push: async (push) => processes.deliver({ workspace: "demo", ...push }),
    baseEnv: {},
    filesMayHaveChanged: () => undefined,
    remember: () => undefined,
    remembered: () => [],
    beforeSpawn: async () => undefined,
    projectRootView: path.join(dir, "view"),
  });
  let keys = 0;
  processes = new TerminalProcesses({
    newKey: () => `term-k${++keys}`,
    place: (cwd) =>
      cwd.startsWith(demo())
        ? {
            workspace: "demo",
            t3Path: demo(),
            remote: {
              terminalOpen: (input) => host.open(input),
              terminalInput: (key, data) => host.input(key, data),
              terminalResize: async (key, cols, rows) => host.resize(key, cols, rows),
              terminalClose: (key) => host.close(key),
              terminalHeartbeat: async (heartbeatKeys) => host.heartbeat(heartbeatKeys),
            },
          }
        : undefined,
  });
  const platform = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.HomeDirectory, dir),
  );
  const terminals = Layer.effect(TerminalManager.TerminalManager, TerminalManager.makeWithOptions(terminalManagerOptions(processes, path.join(dir, "logs")))).pipe(
    Layer.provide(ProcessRunner.layer),
  );
  const fakes = Layer.mergeAll(
    Layer.succeed(ProjectionStore.ProjectionStoreV2, { getThreadShell: () => Effect.succeed(null) } as never),
    Layer.succeed(ProjectService.ProjectService, {} as never),
    Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({ projectSettingsOverrides: {}, projectSettingsFolded: false, projectScriptOverrides: {}, defaultProjectScripts: [] }),
    } as never),
  );
  const runner = Layer.effect(SetupRunner.ProjectSetupScriptRunner, SetupRunner.make).pipe(Layer.provide(fakes));
  runtime = ManagedRuntime.make(Layer.provideMerge(runner, terminals).pipe(Layer.provideMerge(platform)) as never);
});

afterAll(async () => {
  await runtime?.dispose();
  for (const child of shells) if (child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

const project = (command: string, async = true) => ({
  id: ProjectId.make("p1"),
  workspaceRoot: demo(),
  scripts: [{ id: "setup", name: "Setup", command, icon: "configure" as never, runOnWorktreeCreate: true, async }],
});

const runSetup = (threadId: string, command: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const runner = yield* SetupRunner.ProjectSetupScriptRunner;
      const lines: Array<string> = [];
      const started = yield* runner.runForThread({
        threadId,
        worktreePath: demo(),
        project: project(command),
        observeCompletion: { onOutputLine: (line) => Effect.sync(() => void lines.push(line)) },
      });
      if (started.status !== "started" || started.completion === undefined) return { started, completion: null, lines };
      const completion = yield* started.completion;
      return { started, completion, lines };
    }),
  );

/** What a client of `terminal.attach` shows within `ms`: the snapshot's history, the output, and t3's error lines. */
const attachAndRead = (threadId: string, cwd: string, ms = 3000) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const terminals = yield* TerminalManager.TerminalManager;
      let shown = "";
      const types: Array<string> = [];
      const stream = terminals
        .attachOutputStream({ threadId, terminalId: "default", cwd, cols: 80, rows: 24 }, "viewer-1")
        .pipe(Stream.takeUntil((event) => event.type === "exited" || event.type === "error"));
      yield* Stream.runForEach(stream, (event) =>
        Effect.sync(() => {
          const any = event as { type: string; data?: string; message?: string; snapshot?: { history?: string; status?: string } };
          types.push(any.type === "snapshot" ? `snapshot:${any.snapshot?.status}` : any.type);
          if (any.type === "snapshot") shown += any.snapshot?.history ?? "";
          if (any.type === "output") shown += any.data ?? "";
          if (any.type === "error") shown += `[terminal] ${any.message}`;
        }),
      ).pipe(Effect.timeoutOption(`${ms} millis`));
      return { shown, types };
    }),
  );

describe("a terminal whose cwd is in no Workspace (t3's No project)", () => {
  it("shows why in the terminal at once and ends, instead of a blank terminal", async () => {
    const started = Date.now();
    const { shown, types } = await attachAndRead("thread-scratch", path.join(dir, "scratch"));
    expect(shown, `events: ${types.join(", ")}`).toMatch(/terminals run in a project's Workspace/);
    expect(types).toContain("exited");
    expect(Date.now() - started).toBeLessThan(2000);
  }, 20_000);
});

describe.skipIf(BASH === undefined || PYTHON === undefined)("t3's terminal and setup runner over ours, on a real PTY", () => {
  it("runs a setup script with T3CODE_* set and reports exit code 0, ", async () => {
    const result = await runSetup("thread-ok", 'echo "root=$T3CODE_PROJECT_ROOT tree=$T3CODE_WORKTREE_PATH"; echo setup-ran');
    expect(result.started.status).toBe("started");
    expect(result.completion?.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain(`root=${demo()} tree=${demo()}`);
    expect(result.lines.join("\n")).toContain("setup-ran");
    expect(result.lines.join("\n")).not.toContain("6973"); // the markers never reach t3
  }, 60_000);

  it("reports a failing script's exit code", async () => {
    const result = await runSetup("thread-fail", "echo failing; exit 3");
    expect(result.completion?.exitCode).toBe(3);
  }, 60_000);

  it("keeps a terminal whose foreground runs a command through closeIdle, and closes it once the prompt is back (review F1)", async () => {
    const output = await runtime.runPromise(
      Effect.gen(function* () {
        const terminals = yield* TerminalManager.TerminalManager;
        const seen: Array<string> = [];
        const exits: Array<string> = [];
        yield* terminals.subscribe((event) =>
          Effect.sync(() => {
            if (event.threadId !== "thread-busy") return;
            if (event.type === "output") seen.push(event.data);
            if (event.type === "exited" || event.type === "closed") exits.push(event.type);
          }),
        );
        yield* terminals.open({ threadId: "thread-busy", terminalId: "default", cwd: demo(), cols: 80, rows: 24 });
        const until = (pattern: RegExp, ms = 15_000) =>
          Effect.promise(async () => {
            const end = Date.now() + ms;
            while (Date.now() < end && !pattern.test(seen.join(""))) await new Promise((resolve) => setTimeout(resolve, 20));
            return pattern.test(seen.join(""));
          });
        yield* until(/\$ $/);
        yield* terminals.write({ threadId: "thread-busy", terminalId: "default", data: "sleep 2; echo SL$((1))EPT\r" });
        yield* Effect.sleep("500 millis");
        yield* terminals.closeIdle({ threadId: "thread-busy" });
        yield* Effect.sleep("300 millis");
        const keptWhileBusy = exits.length === 0;
        const finished = yield* until(/SL1EPT[\s\S]*\$ $/, 10_000);
        yield* Effect.sleep("300 millis");
        yield* terminals.closeIdle({ threadId: "thread-busy" });
        const closed = yield* until(/./, 10).pipe(Effect.andThen(Effect.promise(async () => {
          const end = Date.now() + 5000;
          while (Date.now() < end && exits.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
          return exits.length > 0;
        })));
        return { keptWhileBusy, finished, closed };
      }),
    );
    expect(output).toEqual({ keptWhileBusy: true, finished: true, closed: true });
  }, 60_000);
});
