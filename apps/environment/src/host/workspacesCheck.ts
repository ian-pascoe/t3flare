// @effect-diagnostics globalDate:off asyncFunction:off
// M2's check (step 2a plan, section 7): `POST /_t3flare/check/workspaces`. Paths under `/w` whose Workspace the registry
// does not list fail as not found without a Workspace DO being touched; `/w` lists the registry; git in such a path
// fails as git would. Never boots t3.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import { environmentServices } from "../agents/bindings.ts";
import * as ProcessRouter from "../agents/processRouter.ts";
import { workspaceStubs } from "../agents/workspaceClient.ts";
import * as RoutingFileSystem from "../platform/routingFileSystem.ts";

const outcome = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value as unknown };
    const error = Cause.findErrorOption(exit.cause);
    return { ok: false, error: Option.isSome(error) ? error.value.reason._tag : String(exit.cause) };
  });

export const workspacesCheck = async () => {
  const unlisted = `not-listed-${Date.now().toString(36)}`;
  const fs: FileSystem.FileSystem = RoutingFileSystem.make();
  const stubsBefore = [...workspaceStubs.values()].reduce((sum, count) => sum + count, 0);
  const path = `/w/${unlisted}`;
  const fileOps = {
    stat: await outcome(fs.stat(path)),
    exists: await outcome(fs.exists(path)),
    readDirectory: await outcome(fs.readDirectory(path)),
    readFile: await outcome(fs.readFile(`${path}/README.md`)),
    writeFile: await outcome(fs.writeFile(`${path}/x.txt`, new TextEncoder().encode("x"))),
    nestedMkdir: await outcome(fs.makeDirectory(`${path}/sub`, { recursive: false })),
  };
  const spawner = ChildProcessSpawner.make((command) => ProcessRouter.spawn(command));
  const git = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make("git", ["status", "--porcelain=2"], { cwd: path }));
        const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr));
        return { exitCode: Number(yield* handle.exitCode), stderr: stderr.trim() };
      }),
    ),
  );
  const stubsAfter = [...workspaceStubs.values()].reduce((sum, count) => sum + count, 0);
  const listing = await outcome(fs.readDirectory("/w"));
  const registry = environmentServices().workspaces.list().map((record) => record.id);
  const failedAsNotFound = Object.entries(fileOps).every(([name, result]) =>
    name === "exists" ? result.ok && result.value === false : !result.ok && result.error === "NotFound",
  );
  return {
    at: new Date().toISOString(),
    unlisted: path,
    fileOps,
    git,
    workspaceStubsMade: stubsAfter - stubsBefore,
    listing,
    registry,
    ok:
      failedAsNotFound &&
      stubsAfter === stubsBefore &&
      git.exitCode === 128 &&
      listing.ok &&
      JSON.stringify(listing.value) === JSON.stringify(registry),
  };
};
