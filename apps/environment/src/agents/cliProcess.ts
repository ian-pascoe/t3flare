// @effect-diagnostics globalConsole:off globalDate:off globalConsoleInEffect:off globalJsonInEffect:off effectFnOpportunity:off
// t3's spawns of a CLI agent (step 4a): `codex app-server` and `pi --mode rpc …` in a Workspace run there, through the
// process channel, as a streaming `ChildProcessHandle`. Fail closed: only the argv our drivers send, only in a
// Workspace, only through a CLI profile (cliProfiles.ts) that fixes the binary, the environment and the home.
import { toWorkspace } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as ChildProcess from "effect/process/ChildProcess";

import { environmentServices } from "./bindings.ts";
import { traceProtocol } from "./processRouter.ts";
import { type ChannelProcess, type ChannelStart, ProcessRefused } from "./processChannel.ts";
import { type CliName, profileLaunch } from "./cliProfiles.ts";
import { CliSpawn, newToolHandle } from "../provider/cli/wrapper.ts";
import { relayThreadOf } from "../provider/cli/relayedMcp.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "../../../../t3code/packages/provider-pi/src/server/mcpExtensionSource.ts";
import * as StateStore from "../platform/stateStore.ts";

/** The CLI binaries this route answers, by the name t3 spawns. */
export const CLI_NAMES: ReadonlySet<string> = new Set(["codex", "pi", "t3flare-probe", "claude-agent-acp", "opencode"]);

const refused = (name: string, description: string) =>
  PlatformError.systemError({ _tag: "PermissionDenied", module: "ChildProcess", method: "spawn", description: `t3flare: ${description}`, pathOrDescriptor: name });

const failedStart = (name: string, description: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "spawn", description: `t3flare: ${description}`, pathOrDescriptor: name });

const cliOf = (name: string): CliName => (name === "t3flare-probe" ? "probe" : name === "claude-agent-acp" ? "claude" : (name as CliName));

const DISPLAY: Readonly<Record<string, string>> = { pi: "Pi", codex: "Codex", "claude-agent-acp": "Claude Code", opencode: "OpenCode" };

/** The handle t3 reads and writes: the channel's process as Effect streams and a sink. */
export const handleOf = (process: ChannelProcess, stdinEndOnDone: boolean): ChildProcessSpawner.ChildProcessHandle => {
  const streamOf = (queue: ChannelProcess["stdout"]) =>
    Stream.fromAsyncIterable(queue, (cause) => failedStart(process.cli, `reading the process: ${String(cause).slice(0, 200)}`));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(process.pid),
    exitCode: Effect.map(
      Effect.promise(() => process.exit),
      (code) => ChildProcessSpawner.ExitCode(code),
    ),
    isRunning: Effect.sync(() => process.running),
    kill: () => Effect.sync(() => process.kill()),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.promise(() => {
        // The resume proof (M5): pi opens a native session file by name, not a handoff.
        if (process.cli === "pi") {
          const text = new TextDecoder().decode(chunk);
          const at = text.indexOf('"type":"switch_session"');
          if (at !== -1) traceProtocol("pi", "switch_session", /"sessionPath":"([^"]+)"/.exec(text)?.[1] ?? "?");
        }
        return process.write(chunk);
      }),
    ).pipe(
      Sink.ensuring(stdinEndOnDone ? Effect.promise(() => process.closeStdin()) : Effect.void),
    ),
    stdout: streamOf(process.stdout),
    stderr: streamOf(process.stderr),
    all: Stream.merge(streamOf(process.stdout), streamOf(process.stderr)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

/**
 * Spawns a CLI t3 asked for, or fails without starting anything: the argv is not one our drivers send, the cwd is in
 * no Workspace, or the profile refuses. Resolves once the process runs in the Container (a cold start is spent here,
 * before t3's `initialize`). The caller's scope kills it if it still runs when the scope closes.
 */
export const spawnCli = (command: ChildProcess.StandardCommand) =>
  Effect.gen(function* () {
    const name = command.command.replace(/^.*\//, "");
    const args = command.args.map((word) => (typeof word === "string" ? word : Redacted.value(word)));
    const cwd = command.options.cwd;
    const services = environmentServices();
    if (cwd === undefined || toWorkspace(cwd) === null) {
      return yield* refused(name, `${DISPLAY[name] ?? name} runs in a Workspace's Container; start the thread in a project`);
    }
    const channel = services.processes;
    const key = channel.newKey();
    // The opening session (the wrapper's), when t3's adapter spawns inside `openSession`.
    const session = yield* CliSpawn;
    if (services.modelProxy === undefined && name !== "t3flare-probe") return yield* refused(name, "this Environment has no model proxy");
    // ADR-0028: the process's tool handle (the session's, so t3's MCP config can name it too; SPI-1039).
    // pi spawns outside the session's fiber (no CliSpawn): t3 put the handle relayedMcp gave it in the spawn's env; only
    // a handle relayedMcp issued is taken, with its thread.
    const offered = (command.options.env as Record<string, string | undefined> | undefined)?.T3_MCP_BEARER_TOKEN;
    const offeredThread = offered === undefined ? undefined : relayThreadOf(offered);
    const toolHandle = session?.toolHandle ?? (offeredThread === undefined ? undefined : offered) ?? newToolHandle();
    const launch = profileLaunch(
      {
        cli: cliOf(name),
        args,
        key,
        cwd,
        env: (command.options.env ?? {}) as Readonly<Record<string, string | undefined>>,
        allowProbe: services.faults,
      },
      {
        proxyUrl: (services.modelProxy?.url ?? "").replace(/\/+$/, ""),
        models: services.catalog.current().models,
        readStateFile: (path) => {
          const entry = StateStore.get(path);
          return entry !== undefined && entry.kind === "file" ? new TextDecoder().decode(StateStore.readFile(path)) : undefined;
        },
        piExtensionSource: PI_T3_MCP_EXTENSION_SOURCE,
        relay: { handle: toolHandle, servers: services.relayServers(session?.linked === true) },
      },
    );
    if ("refused" in launch) {
      console.warn(JSON.stringify({ t3flare: "cli-spawn-refused", cli: name, reason: launch.refused, argv: args.slice(0, 6) }));
      return yield* refused(name, launch.refused);
    }
    // The relay's wiring for this process (never the handle): whether t3's tools reach it, and through which session.
    console.log(JSON.stringify({ t3flare: "cli-relay", cli: name, session: session !== undefined, offered: offered !== undefined, offeredKnown: offeredThread !== undefined, t3Tools: launch.env.T3_MCP_URL !== undefined }));
    if (launch.droppedEnv.length > 0) console.log(JSON.stringify({ t3flare: "cli-env-dropped", cli: name, keys: launch.droppedEnv }));
    const start: ChannelStart = {
      key,
      cli: cliOf(name),
      cwd,
      argv: launch.argv,
      env: launch.env,
      ...(launch.files === undefined ? {} : { files: launch.files }),
      ...(launch.links === undefined ? {} : { links: launch.links }),
      ...(launch.prune === undefined ? {} : { prune: launch.prune }),
      ...(session !== undefined ? { thread: session.thread } : launch.thread !== undefined ? { thread: launch.thread } : offeredThread === undefined ? {} : { thread: offeredThread }),
      ...(session?.linked === true ? { linked: true } : {}),
      toolHandle,
    };
    const process = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => channel.start(start),
        catch: (cause) => (cause instanceof ProcessRefused ? refused(name, cause.message) : failedStart(name, String(cause).slice(0, 300))),
      }),
      (running: ChannelProcess) => Effect.sync(() => running.kill()),
    );
    if (session !== undefined) session.process = process;
    const stdin = command.options.stdin;
    const endOnDone = typeof stdin === "object" && stdin !== null && "endOnDone" in stdin ? stdin.endOnDone !== false : true;
    return handleOf(process, endOnDone);
  });
