// @effect-diagnostics effectFnOpportunity:off
// The platform services t3 gets from `@effect/platform-node` on a laptop, for a Durable
// Object: the State directory file system with the Workspaces at `/w`, POSIX paths, Node's crypto (real in
// workerd), a process spawner that routes git to Workspaces' Containers, and a PTY that reports every shell as
// missing (the Environment DO runs no processes).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Terminal from "effect/Terminal";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRouter from "../agents/processRouter.ts";
import * as DoFileSystem from "./fileSystem.ts";
import * as RoutingFileSystem from "./routingFileSystem.ts";

/** Commands t3 tried to spawn that nothing answers, for the spike's report. */
export { spawnAttempts } from "../agents/processRouter.ts";

// Every process t3 spawns is answered by the process router: git in a Workspace's Container, `gh auth token`, and
// missing binaries for the rest (step 2a plan, section 2).
export const layerChildProcessSpawner = ProcessRouter.layer;

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
// interfaces and `/w`, the Workspaces, as home (step 2a: the web client's clone and add-project dialogs start there).
export const layerHostProcess = Layer.mergeAll(
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostProcess.Architecture, "x64"),
  Layer.succeed(HostProcess.LinuxLibc, "gnu"),
  Layer.succeed(HostProcess.Hostname, "t3flare"),
  Layer.succeed(HostProcess.Username, "t3"),
  Layer.succeed(HostProcess.HomeDirectory, "/w"),
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
  RoutingFileSystem.layer,
  layerTerminal,
  layerHttpPlatform,
  Path.layer,
  layerChildProcessSpawner,
  NodeCrypto.layer,
  layerPty,
);
