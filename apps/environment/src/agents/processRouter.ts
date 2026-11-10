// @effect-diagnostics globalDate:off globalDateInEffect:off effectFnOpportunity:off
// The Environment's process spawner (step 2a plan, section 2): the Environment DO runs no processes, so every command
// t3 spawns is answered here. `git` in a Workspace (`/w/<id>/…`) runs in that Workspace's Container; t3's clone into
// `/w` makes a Workspace; `gh auth token` is the Environment's own GitHub token (t3's PR features); everything else is
// a missing binary, as in step 1. Every routed command is kept in a short trace (admin `GET /_t3flare/agents/router-trace`).
import { fromWorkspaceText, normalize, toWorkspace } from "@t3flare/workspace-client";
import {
  CONTAINER_GITHUB_PERMISSIONS,
  CONTAINER_WORKFLOWS_PERMISSIONS,
  ENVIRONMENT_GITHUB_PERMISSIONS,
} from "@t3flare/github-app/permissions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as ChildProcess from "effect/process/ChildProcess";

import { environmentServices } from "./bindings.ts";
import { cloneRequestOf, gitEnvOf, intoWorkspace, mayStartContainer, readScopeOf, remoteRepoOf, subcommandOf } from "./gitRoutes.ts";
import { workspaceRpc } from "./workspaceClient.ts";

/** Commands t3 tried to spawn that nothing answers (step 1's report). */
export const spawnAttempts = new Map<string, number>();

export type Route = "container" | "cache" | "stale-patched" | "stale-last-answer" | "container-stopped" | "clone" | "gh-token" | "emulated" | "no-workspace" | "not-found" | "error";

export interface TraceEntry {
  readonly at: number;
  readonly command: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string | null;
  readonly route: Route;
  readonly exitCode: number | null;
  readonly ms: number;
  readonly detail?: string;
}

const TRACE_MAX = 300;
const trace: Array<TraceEntry> = [];

export const routerTrace = (): ReadonlyArray<TraceEntry> => [...trace];
export const clearRouterTrace = (): void => void trace.splice(0);

const record = (entry: TraceEntry) => {
  trace.push(entry);
  if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
};

interface Answer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly route: Route;
  readonly detail?: string;
}

/** Every live GitHub token taken out of `text`. */
const redactTokens = (text: string): string => {
  let out = text;
  for (const token of environmentServices().github().live()) out = out.split(token).join("***");
  return out;
};

/** An argv as the trace keeps it: credentials in URLs and anything token-like removed. */
const traceArgv = (args: ReadonlyArray<string>) =>
  args.map((arg) => redactTokens(arg.replace(/\/\/[^/@\s]+@/g, "//***@")).slice(0, 300));

const ghToken = async (): Promise<Answer> => {
  const services = environmentServices();
  const repos = services.workspaces.list().filter((ws) => ws.host === "github.com" && ws.owner !== null && ws.name !== null);
  const owner = repos[0]?.owner;
  if (owner === undefined || owner === null) {
    return { exitCode: 1, stdout: "", stderr: "no oauth token: no GitHub Workspace in this Environment\n", route: "gh-token" };
  }
  const names = [...new Set(repos.filter((ws) => ws.owner === owner).map((ws) => ws.name!))];
  const minted = await services.github().mint({ owner, repositories: names, permissions: ENVIRONMENT_GITHUB_PERMISSIONS });
  return { exitCode: 0, stdout: `${minted.token}\n`, stderr: "", route: "gh-token", detail: `${owner}: ${names.join(",")}` };
};

const clone = async (request: { readonly id: string; readonly url: string }): Promise<Answer> => {
  const services = environmentServices();
  const remote = remoteRepoOf(request.url);
  const url = remote?.https ?? request.url;
  const fields = { host: remote?.host ?? null, owner: remote?.owner ?? null, name: remote?.name ?? null, cloneUrl: url };
  // t3 creates the project, and with it the folder (an empty Workspace), before it clones into it.
  const existing = services.workspaces.get(request.id);
  if (existing !== undefined && existing.cloneUrl !== null) {
    return { exitCode: 128, stdout: "", stderr: `fatal: destination path '${request.id}' already exists and is not an empty directory.\n`, route: "clone" };
  }
  let created;
  try {
    if (existing === undefined) created = services.workspaces.create({ id: request.id, ...fields });
    else {
      services.workspaces.setRemote(request.id, fields);
      created = services.workspaces.get(request.id)!;
    }
  } catch (error) {
    return { exitCode: 128, stdout: "", stderr: `fatal: ${(error as Error).message}\n`, route: "clone" };
  }
  let token: string | null = null;
  let detail = "public";
  if (remote?.host === "github.com") {
    try {
      token = (
        await services.github().mint({
          owner: remote.owner.toLowerCase(),
          repositories: [remote.name],
          permissions: created.workflows ? CONTAINER_WORKFLOWS_PERMISSIONS : CONTAINER_GITHUB_PERMISSIONS,
        })
      ).token;
      detail = "github-app";
    } catch (error) {
      // Not in the App's installation: a public repo still clones, a private one fails with git's own message.
      detail = `no token: ${String(error).slice(0, 200)}`;
    }
  }
  const answer = await workspaceRpc(request.id).clone({ url, token });
  if (!answer.ran || answer.exitCode !== 0) {
    if (existing === undefined) services.workspaces.remove(request.id);
    else services.workspaces.setRemote(request.id, { host: null, owner: null, name: null, cloneUrl: null });
    const stderr = answer.ran ? answer.stderr : `fatal: ${answer.detail}\n`;
    return { exitCode: answer.ran ? answer.exitCode || 128 : 128, stdout: "", stderr, route: "clone", detail };
  }
  services.workspaces.setState(request.id, "ready");
  return { exitCode: 0, stdout: "", stderr: answer.stderr, route: "clone", detail };
};

const git = async (args: ReadonlyArray<string>, cwd: string, env: Readonly<Record<string, unknown>> | undefined, stdin: string | undefined): Promise<Answer> => {
  const at = toWorkspace(cwd);
  if (at === null || environmentServices().workspaces.get(at.id) === undefined) {
    return { exitCode: 128, stdout: "", stderr: `fatal: cannot change to '${cwd}': No such file or directory\n`, route: "no-workspace" };
  }
  const startContainer = mayStartContainer(args);
  const answer = await workspaceRpc(at.id).git({
    argv: args.map((arg) => intoWorkspace(at.id, arg)),
    cwd: at.inner,
    env: gitEnvOf(at.id, env),
    ...(stdin === undefined ? {} : { stdin }),
    startContainer,
    readScope: readScopeOf(args),
  });
  if (!answer.ran) {
    const stopped = answer.reason === "container_stopped";
    return {
      exitCode: 128,
      stdout: "",
      stderr: `fatal: t3flare: ${stopped ? "the Workspace's Container is stopped" : answer.detail}\n`,
      route: stopped ? "container-stopped" : "error",
      detail: answer.detail,
    };
  }
  return {
    exitCode: answer.exitCode,
    stdout: fromWorkspaceText(at.id, answer.stdout),
    stderr: fromWorkspaceText(at.id, answer.stderr),
    route: answer.stale !== undefined ? `stale-${answer.stale}` : answer.cached === true ? "cache" : "container",
    detail: `${startContainer ? "action" : "passive"} ${answer.ms}ms`,
  };
};

/** What `git --version` says: the Workspace image's git (apps/sandbox-image; M0's check printed 2.56.0). */
const GIT_VERSION = "git version 2.56.0";

/** `-C <dir>` options folded into the cwd, as git applies them (each relative to the last). */
const withoutDashC = (argv: ReadonlyArray<string>, cwd: string | undefined): { readonly args: ReadonlyArray<string>; readonly cwd: string | undefined } => {
  const args: Array<string> = [];
  let at = cwd;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-C" && i + 1 < argv.length) {
      const dir = argv[++i]!;
      at = dir.startsWith("/") ? dir : at === undefined ? undefined : `${at}/${dir}`;
    } else if (arg === "-c" && i + 1 < argv.length) {
      args.push(arg, argv[++i]!);
    } else if (arg.startsWith("-")) {
      args.push(arg);
    } else break;
  }
  return { args: [...args, ...argv.slice(i)], cwd: at === undefined ? undefined : normalize(at) };
};

/** gh as t3's GitHub provider uses it: its version, its sign-in, and its token, from the GitHub App. */
const ghRouteOf = (args: ReadonlyArray<string>): (() => Promise<Answer>) | null => {
  if (args[0] === "--version") return async () => ({ exitCode: 0, stdout: "gh version 2.83.0 (t3flare)\n", stderr: "", route: "emulated" });
  if (args[0] === "config" && args[1] === "get") return async () => ({ exitCode: 0, stdout: "\n", stderr: "", route: "emulated" });
  if (args[0] === "auth" && args[1] === "token") return () => ghToken();
  if (args[0] === "auth" && args[1] === "status") {
    return async () => {
      const owner = environmentServices()
        .workspaces.list()
        .find((ws) => ws.host === "github.com" && ws.owner !== null)?.owner;
      if (owner === undefined || owner === null) {
        return { exitCode: 1, stdout: JSON.stringify({ hosts: {} }), stderr: "You are not logged into any GitHub hosts.\n", route: "emulated" };
      }
      const hosts = { "github.com": [{ state: "success", active: true, host: "github.com", login: owner, tokenSource: "t3flare-github-app" }] };
      return { exitCode: 0, stdout: `${JSON.stringify({ hosts })}\n`, stderr: "", route: "emulated" };
    };
  }
  return null;
};

/** What answers `command`, or null when nothing does (a missing binary). */
const routeOf = (
  name: string,
  argv: ReadonlyArray<string>,
  spawnCwd: string | undefined,
): ((env: Readonly<Record<string, unknown>> | undefined, stdin: string | undefined) => Promise<Answer>) | null => {
  if (name === "gh") return ghRouteOf(argv);
  if (name !== "git") return null;
  if (argv.length === 1 && argv[0] === "--version") return async () => ({ exitCode: 0, stdout: `${GIT_VERSION}\n`, stderr: "", route: "emulated" });
  // `git -C <dir> …`: the directory is the command's cwd.
  const { args, cwd } = withoutDashC(argv, spawnCwd);
  if (cwd === undefined) return null;
  const cloneRequest = cloneRequestOf(args, cwd);
  if (cloneRequest !== null) return () => clone(cloneRequest);
  const normal = normalize(cwd);
  // Outside the Workspaces there is no repository: git says so, as it would on a laptop.
  if (!normal.startsWith("/w/")) {
    return async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      route: "no-workspace",
    });
  }
  return (env, stdin) => git(args, normal, env, stdin);
};

const notFound = (name: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: `t3flare: the Environment DO cannot run '${name}'`,
      pathOrDescriptor: name,
    }),
  );

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const spawn = (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    if (command._tag !== "StandardCommand") {
      spawnAttempts.set("pipeline", (spawnAttempts.get("pipeline") ?? 0) + 1);
      return yield* notFound("pipeline");
    }
    const name = command.command.replace(/^.*\//, "");
    const args = command.args.map((word) => (typeof word === "string" ? word : Redacted.value(word)));
    const cwd = command.options.cwd;
    const route = routeOf(name, args, cwd);
    if (route === null) {
      spawnAttempts.set(name, (spawnAttempts.get(name) ?? 0) + 1);
      record({ at: Date.now(), command: name, argv: traceArgv(args), cwd: cwd ?? null, route: "not-found", exitCode: null, ms: 0 });
      return yield* notFound(name);
    }

    // stdin arrives through the handle's sink, written alongside the output's reads; the command runs once it ends
    // (or at once, when nothing writes it within a few milliseconds).
    const stdinChunks: Array<Uint8Array> = [];
    let stdinStarted = false;
    const stdinDone = yield* Deferred.make<void>();
    const env = command.options.env as Readonly<Record<string, unknown>> | undefined;
    const started = Date.now();
    const answer = yield* Effect.cached(
      Effect.gen(function* () {
        yield* Effect.sleep(5);
        if (stdinStarted) yield* Deferred.await(stdinDone);
        const stdin = stdinChunks.length === 0 ? undefined : stdinChunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");
        return yield* Effect.tryPromise({
          try: () => route(env, stdin),
          catch: (cause) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "spawn",
              description: `t3flare: ${name}: ${String(cause).slice(0, 300)}`,
              pathOrDescriptor: name,
            }),
        });
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            record({
              at: started,
              command: name,
              argv: traceArgv(args),
              cwd: cwd ?? null,
              route: result.route,
              exitCode: result.exitCode,
              ms: Date.now() - started,
              ...(result.detail === undefined ? {} : { detail: redactTokens(result.detail) }),
            }),
          ),
        ),
        Effect.tapError((error) =>
          Effect.sync(() =>
            record({ at: started, command: name, argv: traceArgv(args), cwd: cwd ?? null, route: "error", exitCode: null, ms: Date.now() - started, detail: String(error).slice(0, 300) }),
          ),
        ),
      ),
    );

    const output = (pick: (result: Answer) => string) =>
      Stream.fromEffect(answer).pipe(
        Stream.map((result) => encoder.encode(pick(result))),
        Stream.filter((bytes) => bytes.byteLength > 0),
      );

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.map(answer, (result) => ChildProcessSpawner.ExitCode(result.exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.sync(() => {
          stdinStarted = true;
          stdinChunks.push(chunk);
        }),
      ).pipe(Sink.ensuring(Deferred.succeed(stdinDone, undefined))),
      stdout: output((result) => result.stdout),
      stderr: output((result) => result.stderr),
      all: Stream.concat(
        output((result) => result.stdout),
        output((result) => result.stderr),
      ),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  });

export const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));

/** For tests: the subcommand a traced argv ran. */
export const subcommand = (argv: ReadonlyArray<string>) => subcommandOf(argv).name;
