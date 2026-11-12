// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off globalConsoleInEffect:off globalDateInEffect:off effectFnOpportunity:off globalJsonInEffect:off
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
}

export const acpCheck = async (input: AcpCheckInput): Promise<Record<string, unknown>> => {
  const scope = Scope.makeUnsafe();
  const started = Date.now();
  const command = input.cli === "claude" ? ChildProcess.make("claude-agent-acp", [], { cwd: `/w/${input.workspace}` }) : ChildProcess.make("opencode", ["acp"], { cwd: `/w/${input.workspace}` });
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
  const write = (message: unknown) => Effect.runPromise(Stream.run(Stream.make(encoder.encode(`${JSON.stringify(message)}\n`)), handle.stdin).pipe(Effect.ignore));
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
  } finally {
    report.stderr = stderr.slice(-800);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    report.totalMs = Date.now() - started;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  report.markerProcessesAfterKill = key === null ? null : await countMarker(input.workspace, key);
  return report;
};
