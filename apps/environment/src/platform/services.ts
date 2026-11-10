// @effect-diagnostics effectFnOpportunity:off
// The platform services t3 gets from `@effect/platform-node` on a laptop, for a Durable
// Object: the State directory file system, POSIX paths, Node's crypto (real in workerd),
// and a process spawner and PTY that report every binary as missing, because the
// Environment DO runs no processes (they belong to a Container, from step 2a).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Terminal from "effect/Terminal";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DoFileSystem from "./fileSystem.ts";

/** Commands t3 tried to spawn, for the spike's report. */
export const spawnAttempts = new Map<string, number>();

export const layerChildProcessSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) => {
    const name = "command" in command ? String(command.command) : "pipeline";
    spawnAttempts.set(name, (spawnAttempts.get(name) ?? 0) + 1);
    return Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: `t3flare: the Environment DO cannot run '${name}'`,
        pathOrDescriptor: name,
      }),
    );
  }),
);

export const layerPty = Layer.succeed(PtyAdapter.PtyAdapter, {
  spawn: (input) =>
    Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "t3flare", shell: input.shell })),
});

// No TTY: t3's CLI paths never run in the DO.
export const layerTerminal = Layer.succeed(
  Terminal.Terminal,
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    size: Effect.die("t3flare: no terminal"),
    readInput: Effect.die("t3flare: no terminal"),
    readLine: Effect.die("t3flare: no terminal"),
    display: (text) => Effect.log(text),
  }),
);

// Effect's web HttpPlatform: file responses stream from the State directory.
export const layerHttpPlatform = HttpPlatform.layer.pipe(
  Layer.provideMerge(Etag.layerWeak),
  Layer.provide(DoFileSystem.layer),
);

// The host t3 thinks it runs on: a Linux machine with no executable, no network
// interfaces and the State directory as home (process.* is mostly empty in workerd).
export const layerHostProcess = Layer.mergeAll(
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostProcess.Architecture, "x64"),
  Layer.succeed(HostProcess.LinuxLibc, "gnu"),
  Layer.succeed(HostProcess.Hostname, "t3flare"),
  Layer.succeed(HostProcess.Username, "t3"),
  Layer.succeed(HostProcess.HomeDirectory, "/t3/home"),
  Layer.succeed(HostProcess.Environment, { HOME: "/t3/home", PATH: "/usr/bin:/bin" }),
  Layer.succeed(HostProcess.WorkingDirectory, "/t3"),
  Layer.succeed(HostProcess.ExecutablePath, "/bundle/t3"),
  Layer.succeed(HostProcess.Arguments, ["/bundle/t3", "serve"]),
  Layer.succeed(HostProcess.InvokedAs, "t3"),
  Layer.succeed(HostProcess.IsExecutable, false),
  Layer.succeed(HostProcess.Addresses, Effect.succeed(new Set<string>())),
  Layer.succeed(HostProcess.UserId, 1000),
);

export const layer = Layer.mergeAll(
  layerHostProcess,
  DoFileSystem.layer,
  layerTerminal,
  layerHttpPlatform,
  Path.layer,
  layerChildProcessSpawner,
  NodeCrypto.layer,
  layerPty,
);
