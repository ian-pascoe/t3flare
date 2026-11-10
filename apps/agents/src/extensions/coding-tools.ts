// Adapted from cloudpid@b8097ff0:packages/extensions/src/coding-tools.ts (step 2a plan, section 4): pi-durable's `read`,
// `write` and `edit`, and a `bash` that chooses where its command runs (`./bash-routing.ts`): the Worker Shell unless
// the command needs a real binary, so the Container (the costly backend) starts only when a command needs it. Dropped
// from cloudpid's: the Images binding (`read` keeps pi-durable's own image checks), the Call diff of `write` and of
// codemode's nested calls (no codemode here; `edit` records its patch itself). Added: `bash`'s exit code in its result's
// `details`, which the Environment's differ shows on the command item.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileError, Result, ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

import {
  type BashRoute,
  commandPaths,
  missingPaths,
  probeAnswer,
  probeScript,
  resolveRoute,
  routeCommand,
  type WorkerOutput,
  workerShellCannot,
} from "./bash-routing.ts";

/** Where a `bash` command can run: the Worker Shell (`worker`) or the Container (`container`). */
export type BashBackend = "worker" | "container";

/** An execution environment that runs commands on a backend of the model's choosing. */
export interface BackendEnv {
  onBackend(backend: BashBackend): ExecutionEnv;
}

const hasBackends = (env: ExecutionEnv | undefined): env is ExecutionEnv & BackendEnv => env !== undefined && "onBackend" in env;

/** An execution environment that knows which paths are Container-only. */
export interface ContainerOnlyEnv {
  containerOnly(paths: readonly string[], context: Context): Promise<Result<readonly boolean[], FileError>>;
}

const knowsContainerOnly = (env: ExecutionEnv): env is ExecutionEnv & ContainerOnlyEnv => "containerOnly" in env;

const firstContainerOnly = async (env: ContainerOnlyEnv, paths: readonly string[], context: Context): Promise<string | undefined> => {
  if (paths.length === 0) return undefined;
  try {
    const result = await env.containerOnly(paths, context);
    return result.ok ? paths.find((_, at) => result.value[at] === true) : undefined;
  } catch {
    return undefined;
  }
};

const CONTAINER_ONLY_FILES =
  "Paths only the container has (anything outside /workspace, /tmp included, and dependency, build and cache directories such as node_modules, .venv, target and .cache inside it) are read and written through the container, which starts if needed.";

const throughContainer = <T extends { readonly description: string }>(tool: T): T => ({
  ...tool,
  description: `${tool.description} ${CONTAINER_ONLY_FILES}`,
});

const base = createBashTool();
// oxlint-disable-next-line typescript/unbound-method -- dropped, never called
const { prepareArguments: _prepareArguments, ...bashBase } = base;

const backendDescription = [
  "Commands run on one of two backends that share the same files in /workspace. Leave `backend` unset and the cheapest backend that can run the command is chosen.",
  "- worker: a shell inside a Worker (just-bash). It starts instantly. It runs text and file commands (cat, grep, sed, awk, jq, find, sort, head, diff, ls and the like) and a read-only git (status, log --oneline, rev-parse, branch, ls-files). It has no network and cannot run native binaries.",
  "- container: a real Linux container with network access, and the costly backend: it takes seconds to start. It runs anything that needs a real binary: npm, node, python, test runners, compilers, gh, all other git (diff, show, add, commit, checkout, push, pull), and scripts (./script.sh, bash script.sh).",
  'Override `backend` with `"container"` only when the worker ran a command and its output was wrong.',
].join("\n");

const parameters = obj({
  command: str({ description: "Bash command to execute" }),
  timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
  backend: opt(oneOf(["worker", "container"], { description: "Where to run the command (default: chosen from the command)" })),
});

// @effect-diagnostics-next-line extendsNativeError:off -- caught by `bash` itself.
class RunOnContainer extends Error {}

const workerHas = async (worker: ExecutionEnv, programs: readonly string[], known: Map<string, boolean>, context: Context): Promise<ReadonlySet<string>> => {
  const asked = programs.filter((name) => !known.has(name));
  if (asked.length > 0) {
    let stdout = "";
    const result = await worker.exec(probeScript(asked), { onOutput: (text, _context, info) => (stdout += info.stream === "stdout" ? text : "") }, context);
    const present = result.ok ? probeAnswer(asked, stdout) : undefined;
    if (present !== undefined) for (const name of asked) known.set(name, present.has(name));
  }
  return new Set(programs.filter((name) => known.get(name) === true));
};

type ExecResult = Awaited<ReturnType<ExecutionEnv["exec"]>>;
type OutputChunk = [text: string, context: Context, info: ShellOutputInfo];

const containerReason = async (
  result: ExecResult,
  output: WorkerOutput,
  containerOnlyMissing: ((output: WorkerOutput) => Promise<string | undefined>) | undefined,
): Promise<string | undefined> => {
  if (!result.ok) return result.error.code === "spawn_error" ? `the worker could not (${result.error.message})` : undefined;
  const cannot = workerShellCannot(output);
  if (cannot !== undefined) return `the worker could not (${cannot})`;
  const path = await containerOnlyMissing?.(output);
  return path === undefined ? undefined : `${path} is only on the container`;
};

type Rerun = { readonly containerOnlyMissing: ((output: WorkerOutput) => Promise<string | undefined>) | undefined };

const attemptOn = (worker: ExecutionEnv, rerun: Rerun | undefined): ExecutionEnv => {
  const attempt: Pick<ExecutionEnv, "cwd" | "exec"> = {
    cwd: worker.cwd,
    exec: async (command, options, context) => {
      const chunks: OutputChunk[] = [];
      const result = await worker.exec(command, { ...options, onOutput: (...chunk) => chunks.push(chunk) }, context);
      if (rerun !== undefined) {
        const output = { stdout: "", stderr: "" };
        for (const [text, , info] of chunks) output[info.stream] += text;
        const reason = await containerReason(result, output, rerun.containerOnlyMissing);
        if (reason !== undefined) throw new RunOnContainer(reason);
      }
      for (const chunk of chunks) options?.onOutput?.(...chunk);
      return result;
    },
  };
  // SAFETY: pi-durable's `bash` uses only the environment's `cwd` and `exec`.
  return attempt as ExecutionEnv;
};

/** `bash`'s exit code, from its structured output, in `details` too (the differ reads it there). */
const withExitCode = <R extends { readonly structuredOutput?: unknown; readonly details?: unknown }>(result: R): R => {
  const exitCode = (result.structuredOutput as { exitCode?: unknown } | undefined)?.exitCode;
  return typeof exitCode === "number" ? { ...result, details: { ...(result.details as object | undefined), exitCode } } : result;
};

const bashTool = (known: Map<string, boolean>): ToolRegistration<typeof parameters> =>
  defineTool({
    ...bashBase,
    description: `${base.description}\n\n${backendDescription}`,
    parameters,
    async execute({ backend, ...args }, api, context) {
      const env = api.env;
      const runOn = async (on: ExecutionEnv) => withExitCode(await base.execute(args, { ...api, env: on }, context));
      if (!hasBackends(env)) {
        if (backend !== "container") return withExitCode(await base.execute(args, api, context));
        throw new Error("This environment has no container backend: run the command without `backend`.");
      }
      if (backend !== undefined) return runOn(env.onBackend(backend));
      const worker = env.onBackend("worker");
      const route: BashRoute = await resolveRoute(routeCommand(args.command), (programs) => workerHas(worker, programs, known, context));
      if (route.backend === "container") return runOn(env.onBackend("container"));
      const judge = knowsContainerOnly(env) ? env : undefined;
      const named = judge === undefined ? undefined : commandPaths(args.command, env.cwd);
      if (judge !== undefined && named !== undefined && (await firstContainerOnly(judge, named.paths, context)) !== undefined) {
        return runOn(env.onBackend("container"));
      }
      const asked = new Set(named?.paths);
      const containerOnlyMissing =
        judge === undefined || named === undefined
          ? undefined
          : (output: WorkerOutput) =>
              firstContainerOnly(
                judge,
                missingPaths(output, named.directories).filter((path) => !asked.has(path)),
                context,
              );
      try {
        return await runOn(attemptOn(worker, route.writes === undefined ? { containerOnlyMissing } : undefined));
      } catch (error) {
        if (!(error instanceof RunOnContainer)) throw error;
        api.diagnostic({ severity: "info", code: "container_fallback", message: `Ran on the container: ${error.message}` });
        return runOn(env.onBackend("container"));
      }
    },
  });

const GUIDELINES: readonly { readonly tools: readonly string[]; readonly line: string }[] = [
  { tools: ["read"], line: "Use `read` to look at files, not `cat`, `head`, `tail` or `sed -n` in `bash`." },
  {
    tools: ["edit"],
    line: "Use `edit` to change a file: several `edits[]` in one call for separate places in one file. Never change files through `bash` (no `sed -i`, heredocs or scripts that rewrite them).",
  },
  { tools: ["write"], line: "Use `write` only for a new file or a complete rewrite." },
  { tools: ["grep", "find", "ls"], line: "Use `grep`, `find` and `ls` to search and list files rather than `bash`." },
  {
    tools: ["bash"],
    line: "Use `bash` for what the file tools cannot do: tests, builds, package managers, git, and running programs. Leave its `backend` unset. Run related container commands together in one call.",
  },
];

const Guidelines = section("coding_tools", (input) => {
  const offered = new Set(input.agent.tools.map((tool) => tool.name));
  const lines = GUIDELINES.flatMap(({ tools, line }) => (tools.some((tool) => offered.has(tool)) ? [`- ${line}`] : []));
  return lines.length === 0 ? undefined : lines.join("\n");
});

/** `read`, `write`, `edit`, and `bash` with a `backend` argument, and the `coding_tools` section. */
export const codingTools = (): Extension =>
  defineExtension({
    name: "coding-tools",
    tools: [throughContainer(createReadTool()), throughContainer(createWriteTool()), throughContainer(createEditTool()), bashTool(new Map())],
    sections: [Guidelines],
  });
