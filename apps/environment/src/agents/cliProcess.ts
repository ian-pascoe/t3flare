// @effect-diagnostics globalConsole:off globalDate:off globalConsoleInEffect:off globalJsonInEffect:off effectFnOpportunity:off
// t3's spawns of a CLI agent (step 4a): `codex app-server` and `pi --mode rpc …` in a Workspace run there, through the
// process channel, as a streaming `ChildProcessHandle`. Fail closed: only the argv our drivers send, only in a
// Workspace, only through a CLI profile (cliProfiles.ts) that fixes the binary, the environment and the home.
import { retiredSelectionSlug } from "@t3flare/models/endpoints";
import { endpointsOfApi } from "@t3flare/models/relay";
import { newHandle, toWorkspace } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as ChildProcess from "effect/process/ChildProcess";

import { environmentServices } from "./bindings.ts";
import { traceProtocol } from "./processRouter.ts";
import { scratchProjectOf } from "./scratch.ts";
import { type ChannelProcess, type ChannelStart, ProcessRefused } from "./processChannel.ts";
import { type CliName, profileLaunch } from "./cliProfiles.ts";
import { CliSpawn } from "../provider/cli/wrapper.ts";
import { takeEnvironmentSkillsAt } from "../provider/cli/environmentSkillsTake.ts";
import { claudeRelayOf } from "../provider/cli/claudeEndpoints.ts";
import { opencodeRelayOf } from "../provider/cli/opencodeEndpoints.ts";
import { lineMapper, piLineFromPi, piLineToPi, piRelayOf } from "../provider/cli/piEndpoints.ts";
import { currentTextGenerationModel } from "./seedSettings.ts";
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

/**
 * The process's protocol lines, each mapped on its way: `toCli` on stdin, `fromCli` on stdout (SPI-1170: pi's model
 * names on the relay, `piEndpoints.ts`).
 */
export interface LineMaps {
  readonly toCli: (line: string) => string;
  readonly fromCli: (line: string) => string;
}

/** The handle t3 reads and writes: the channel's process as Effect streams and a sink. */
export const handleOf = (process: ChannelProcess, stdinEndOnDone: boolean, lines?: LineMaps): ChildProcessSpawner.ChildProcessHandle => {
  /** The process's bytes on one of its outputs. */
  const bytesOf = (queue: ChannelProcess["stdout"]) =>
    Stream.fromAsyncIterable(queue, (cause) => failedStart(process.cli, `reading the process: ${String(cause).slice(0, 200)}`));
  /** One output as t3 reads it: its bytes, or with `map`, its lines each mapped. */
  const outputOf = (queue: ChannelProcess["stdout"], map?: (line: string) => string) => {
    if (map === undefined) return bytesOf(queue);
    const mapper = lineMapper(map);
    return bytesOf(queue).pipe(
      Stream.map(mapper.chunk),
      Stream.concat(Stream.sync(() => mapper.flush())),
      Stream.filter((bytes) => bytes.length > 0),
    );
  };
  const toCli = lines === undefined ? undefined : lineMapper(lines.toCli);
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
        if (toCli === undefined) return process.write(chunk);
        const mapped = toCli.chunk(chunk);
        return mapped.length === 0 ? Promise.resolve() : process.write(mapped);
      }),
    ).pipe(
      Sink.ensuring(
        Effect.promise(async () => {
          const rest = toCli?.flush();
          if (rest !== undefined && rest.length > 0) await process.write(rest);
          if (stdinEndOnDone) await process.closeStdin();
        }),
      ),
    ),
    stdout: outputOf(process.stdout, lines?.fromCli),
    stderr: outputOf(process.stderr),
    all: Stream.merge(outputOf(process.stdout, lines?.fromCli), outputOf(process.stderr)),
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
    if (cwd === undefined || (toWorkspace(cwd) === null && scratchProjectOf(cwd) === undefined)) {
      return yield* refused(name, `${DISPLAY[name] ?? name} runs in a Workspace's Container; start the thread in a project`);
    }
    const channel = services.processes;
    const key = channel.newKey();
    // The opening session (the wrapper's), when t3's adapter spawns inside `openSession`.
    const session = yield* CliSpawn;
    // SPI-1167: the Model endpoints Codex reaches through the model relay (OpenAI Responses), as stored now.
    const responsesEndpoints = endpointsOfApi(services.modelEndpoints?.(), "openai-responses", "codex");
    // SPI-1168: Claude Code on the Anthropic Messages endpoints through the relay.
    const claudeRelay = name === "claude-agent-acp" ? claudeRelayOf(services.modelEndpoints?.(), currentTextGenerationModel()) : undefined;
    // SPI-1169: OpenCode on the endpoints whose API it speaks.
    const opencodeRelay = name === "opencode" ? opencodeRelayOf(services.modelEndpoints?.(), currentTextGenerationModel()) : undefined;
    // SPI-1170: pi on every endpoint that lists a model.
    const piRelay = name === "pi" ? piRelayOf(services.modelEndpoints?.()) : undefined;
    // SPI-1176: a CLI with no endpoint for its API is refused by its profile, saying so.
    // ADR-0028: the process's tool handle for the relay's third-party servers (the session's; pi spawns outside the
    // session's fiber and gets one of its own).
    const toolHandle = session?.toolHandle ?? newHandle();
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
        readStateFile: (path) => {
          const entry = StateStore.get(path);
          return entry !== undefined && entry.kind === "file" ? new TextDecoder().decode(StateStore.readFile(path)) : undefined;
        },
        piExtensionSource: PI_T3_MCP_EXTENSION_SOURCE,
        relay: { handle: toolHandle, servers: services.relayServers() },
        endpoints: responsesEndpoints,
        ...(session?.model === undefined ? {} : { model: session.model }),
        ...(claudeRelay === undefined ? {} : { claudeRelay }),
        ...(opencodeRelay === undefined ? {} : { opencodeRelay }),
        ...(piRelay === undefined ? {} : { piRelay }),
      },
    );
    if ("refused" in launch) {
      console.warn(JSON.stringify({ t3flare: "cli-spawn-refused", cli: name, reason: launch.refused, argv: args.slice(0, 6) }));
      return yield* refused(name, launch.refused);
    }
    // The relay's wiring for this process (never the handle): whether t3's tools reach it, and through which session.
    console.log(JSON.stringify({ t3flare: "cli-relay", cli: name, session: session !== undefined, t3Tools: launch.env.T3_MCP_URL !== undefined }));
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
      ...(session !== undefined ? { thread: session.thread } : launch.thread !== undefined ? { thread: launch.thread } : {}),
      toolHandle,
      ...(launch.modelRelay === undefined ? {} : { modelRelay: launch.modelRelay }),
    };
    // SPI-1153: the Workspace takes the Environment skill set first, so a CLI that reads its Skills at start (through
    // its link, or pi's flag) reads the current set. Bounded, and never the spawn's failure.
    yield* takeEnvironmentSkillsAt(cwd);
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
    // SPI-1170: pi on the relay names an endpoint's model by its own provider id; t3's adapter by the endpoint's.
    const relayEndpointIds = new Set(launch.modelRelay ?? []);
    const piLineMaps: LineMaps | undefined =
      name === "pi" && relayEndpointIds.size > 0 ? { toCli: (line) => piLineToPi(line, relayEndpointIds, (modelId) => retiredSelectionSlug(`anthropic/${modelId}`, piRelay?.endpoints ?? [], piRelay?.model)), fromCli: (line) => piLineFromPi(line, relayEndpointIds) } : undefined;
    const handle = handleOf(process, endOnDone, piLineMaps);
    // A stdin given as a Stream is piped in, as Node's spawner does (t3's `codex exec` prompt, parity G7).
    const input = typeof stdin === "object" && stdin !== null && "stream" in stdin ? stdin.stream : stdin;
    if (Stream.isStream(input)) yield* Effect.forkScoped(Stream.run(input as Stream.Stream<Uint8Array, PlatformError.PlatformError>, handle.stdin).pipe(Effect.ignore));
    return handle;
  });
