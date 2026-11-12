// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off globalConsoleInEffect:off globalDateInEffect:off effectFnOpportunity:off globalJsonInEffect:off nodeBuiltinImport:off
// Step 4b M1's demo (stages only): Claude Code or OpenCode started through t3's own `ChildProcessSpawner` (the process
// router, the CLI profile, the process channel) in a Workspace's Container, without t3's drivers, and driven over ACP:
// `initialize`, `session/new`, the model chosen, one prompt. Every permission request is refused. Admin
// `POST /_t3flare/agents/acp-check` `{"cli":"claude"|"opencode","workspace":"<id>","model"?:"<catalog id>","prompt"?:"…"}`.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

import { spawn } from "../agents/processRouter.ts";
import { countMarker } from "./processCheck.ts";

const encoder = new TextEncoder();

export interface AcpCheckInput {
  readonly cli: "claude" | "opencode";
  readonly workspace: string;
  readonly model?: string;
  readonly prompt?: string;
  /** Planted in the Environment DO's own `process.env` before the spawn (§1.5's canary): it must reach no process. */
  readonly canary?: string;
}

/** Each marker process's environment names (never values) and whether the canary is in it. */
const envReport = async (workspace: string, key: string, canary: string | undefined) => {
  const { workspaceRpc } = await import("../agents/workspaceClient.ts");
  const safeKey = key.replace(/[^A-Za-z0-9-]/g, "");
  const needle = (canary ?? "no-canary").replace(/[^A-Za-z0-9-]/g, "");
  const script = [
    `for f in $(grep -l -a 'T3FLARE_EXEC=${safeKey}' /proc/[0-9]*/environ 2>/dev/null); do`,
    '  p=${f#/proc/}; p=${p%/environ};',
    String.raw`  printf '%s\t%s\t%s\t%s\n' "$p" "$(tr '\0' ' ' </proc/$p/cmdline | cut -c1-70)" "$(tr '\0' '\n' <$f | cut -d= -f1 | sort | tr '\n' ' ')" "$(grep -c -a '${needle}' $f /proc/$p/cmdline | awk -F: '{s+=$2} END {print s}')";`,
    "done",
  ].join("\n");
  const answer = await workspaceRpc(workspace).exec({ script, timeoutMs: 20_000 });
  return answer.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, command, names, hits] = line.split("\t");
      return { pid, command, envNames: (names ?? "").trim().split(" ").filter((name) => name.length > 0), canaryHits: Number(hits ?? 0) };
    });
};

export const acpCheck = async (input: AcpCheckInput): Promise<Record<string, unknown>> => {
  const scope = Scope.makeUnsafe();
  const started = Date.now();
  if (input.canary !== undefined) process.env.T3FLARE_CANARY = input.canary;
  // One stdin stream for the process's life, as t3's ACP client keeps (each `Stream.run` into the sink would end it).
  const options = { cwd: `/w/${input.workspace}`, stdin: { stream: "pipe", endOnDone: false } } as const;
  const command = input.cli === "claude" ? ChildProcess.make("claude-agent-acp", [], options) : ChildProcess.make("opencode", ["acp"], options);
  const report: Record<string, unknown> = { cli: input.cli };
  const handle = await Effect.runPromise(spawn(command).pipe(Scope.provide(scope)));
  report.spawnMs = Date.now() - started;
  const { environmentServices } = await import("../agents/bindings.ts");
  const key = environmentServices().processes.byPid(handle.pid)?.key ?? null;
  report.key = key;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const permissions: Array<unknown> = [];
  let text = "";
  let stderr = "";
  const queue: Array<Uint8Array> = [];
  const waiters: Array<() => void> = [];
  const source = Stream.fromAsyncIterable(
    {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
          yield queue.shift()!;
        }
      },
    },
    () => new Error("stdin"),
  );
  void Effect.runPromise(Stream.run(source, handle.stdin).pipe(Effect.ignore));
  const write = async (message: unknown) => {
    queue.push(encoder.encode(`${JSON.stringify(message)}\n`));
    for (const waiter of waiters.splice(0)) waiter();
  };
  const decoder = new TextDecoder();
  let carry = "";
  void Effect.runPromise(
    Stream.runForEach(handle.stderr, (chunk) => Effect.sync(() => void (stderr = (stderr + decoder.decode(chunk)).slice(-2000)))).pipe(Effect.ignore),
  );
  void Effect.runPromise(
    Stream.runForEach(handle.stdout, (chunk) =>
      Effect.sync(() => {
        carry += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = carry.indexOf("\n")) >= 0) {
          const line = carry.slice(0, nl).trim();
          carry = carry.slice(nl + 1);
          if (line.length === 0) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (message.method === "session/update") {
            const update = (message.params as { update: { sessionUpdate: string; content?: { type: string; text?: string } } }).update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") text += update.content.text ?? "";
          } else if (message.method === "session/request_permission") {
            const params = message.params as { toolCall: { kind?: string; title?: string }; options: Array<{ optionId: string; kind: string }> };
            permissions.push({ kind: params.toolCall.kind ?? null, title: params.toolCall.title?.slice(0, 80) ?? null, options: params.options.map((option) => option.kind) });
            const reject = params.options.find((option) => option.kind === "reject_once");
            void write({ jsonrpc: "2.0", id: message.id, result: { outcome: reject === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: reject.optionId } } });
          } else if (message.id !== undefined && message.method !== undefined) {
            void write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
          } else if (typeof message.id === "number") {
            pending.get(message.id)?.(message);
          }
        }
      }),
    ).pipe(Effect.ignore),
  );
  let nextId = 1;
  const request = async (method: string, params: unknown, timeoutMs: number) => {
    const id = nextId++;
    const at = Date.now();
    const answer = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    await write({ jsonrpc: "2.0", id, method, params });
    const message = await Promise.race([answer, new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ error: { message: "timeout" } }), timeoutMs))]);
    return { ms: Date.now() - at, result: message.result as Record<string, unknown> | undefined, error: message.error as unknown };
  };
  try {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "t3flare-acp-check", version: "0" } }, 120_000);
    report.initialize = { ms: init.ms, error: init.error, authMethods: (init.result?.authMethods as Array<{ id: string }> | undefined)?.map((method) => method.id) ?? null, agent: init.result?.agentInfo ?? null };
    const session = await request("session/new", { cwd: `/w/${input.workspace}`, mcpServers: [] }, 120_000);
    const result = session.result as { sessionId?: string; modes?: { currentModeId: string; availableModes: Array<{ id: string }> } | null; configOptions?: Array<{ id: string; currentValue: unknown }> } | undefined;
    report.session = {
      ms: session.ms,
      error: session.error,
      modes: result?.modes === undefined || result.modes === null ? null : { current: result.modes.currentModeId, available: result.modes.availableModes.map((mode) => mode.id) },
      config: result?.configOptions?.map((option) => `${option.id}=${String(option.currentValue)}`) ?? null,
    };
    const sessionId = result?.sessionId;
    if (sessionId !== undefined) {
      const model = input.model ?? (input.cli === "claude" ? "claude-haiku-5-5" : "t3flare/claude-haiku-5-5");
      report.setModel = await request("session/set_config_option", { sessionId, configId: "model", value: model }, 60_000).then((answer) => ({ model, ms: answer.ms, error: answer.error ?? null }));
      const prompt = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt ?? "Reply with the single word ok." }] }, 240_000);
      report.prompt = { ms: prompt.ms, stopReason: prompt.result?.stopReason ?? null, error: prompt.error ?? null, text: text.slice(-400) };
    }
    report.permissions = permissions;
    report.markerProcesses = key === null ? null : await countMarker(input.workspace, key);
    if (key !== null) report.processes = await envReport(input.workspace, key, input.canary);
  } finally {
    if (input.canary !== undefined) delete process.env.T3FLARE_CANARY;
    report.stderr = stderr.slice(-800);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    report.totalMs = Date.now() - started;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  report.markerProcessesAfterKill = key === null ? null : await countMarker(input.workspace, key);
  return report;
};
