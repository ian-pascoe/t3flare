// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-termctrl (SPI-1057; parity row pi-termctrl): the owner's
// Terminals and Background jobs for the Durable agent, as PTYs in the Workspace's container under t3flare's terminal host
// (ADR-0021; the Workspace DO's half is `workspace/agentTerminals.ts`). cloudpid has no port of it (its v2 list names
// termctrl "needs a PTY computer lacks"); the platform's PTY exec has one.
//
// - Tools: `terminal_start`, `terminal_send`, `terminal_stop`, `terminal_list`, `terminal_wait` (`termctrl/tools.ts`),
//   and `bash`'s `background` (`coding-tools.ts`, `backgroundJobs` here).
// - Approvals follow the thread's mode as `bash`'s do (`permissions.ts`): `terminal_start`, and a `terminal_send` that
//   types, are commands; a poll, `terminal_stop`, `terminal_list` and `terminal_wait` never ask.
// - Exit notifications (exit-notification.ts): an exit the agent has not seen is told at the end of a tool round, as a
//   steer into the run (`whenIdle: "reject"`), or after the answer as a note the next turn reads; never a run of its own
//   (pi-termctrl starts a turn when idle; t3 owns the runs here).
// - Nothing starts a container until a Terminal or a job starts: the tools are free to offer.
// @effect-diagnostics asyncFunction:off globalDate:off
import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, GenerationTask, type Harness, hook, type HookApi, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

import type { BackgroundJobs } from "./coding-tools.ts";
import {
  EXIT_TAIL_LINES,
  formatExitNotice,
  START_WAIT_MS,
  TERMCTRL_GUIDELINES,
  type TermctrlHost,
  terminalListTool,
  terminalSendTool,
  terminalStartTool,
  terminalStopTool,
  terminalWaitTool,
} from "./termctrl/tools.ts";

export { type TermctrlHost } from "./termctrl/tools.ts";

export const TERMCTRL_EXTENSION = "termctrl";

/** An Exit notification's entry: the model reads its text; t3 shows it as a notice (the differ). */
export const EXIT_ENTRY = "t3flare.terminal-exit";

export const TERMCTRL_NAMESPACE: CodemodeNamespace = { name: "terminal", description: "Terminals and Background jobs in the Workspace's container", prefix: "terminal_" };

export interface TermctrlOptions {
  readonly host: TermctrlHost;
  /** Whether this Session ever started an entry (no Workspace call is made for exits before). */
  readonly used: () => boolean;
}

/** The Exit notifications due: exits of this Session's entries it has not seen, each told once. */
const dueExits = async (host: TermctrlHost): Promise<string | undefined> => {
  const answer = await host.call({ op: "exits", owner: host.owner(), tailLines: EXIT_TAIL_LINES });
  if (!answer.ok || answer.value.exits.length === 0) return undefined;
  return answer.value.exits.map((exit) => formatExitNotice(exit, exit.tail, EXIT_TAIL_LINES)).join("\n\n");
};

/** Tells the run of the exits: a steer while it works, else a note placed after its answer (never a run of its own). */
const notify = async (harness: () => Promise<Harness>, options: TermctrlOptions, api: HookApi, context: Context, steer: boolean): Promise<void> => {
  if (!options.used()) return;
  const text = await dueExits(options.host).catch(() => undefined);
  if (text === undefined) return;
  const conversation = await (await harness()).conversation(api.conversationId, context);
  if (conversation === undefined) return;
  const entry = { kind: EXIT_ENTRY, data: { text } };
  if (steer) {
    try {
      await conversation.submit({ type: "input", content: text, whenBusy: "steer", whenIdle: "reject", entry }, context);
      return;
    } catch {
      // Idle meanwhile: the note below, for the next turn.
    }
  }
  await conversation.submit({ type: "write", entry: { ...entry, model: [{ role: "user", content: text, timestamp: Date.now() }] } }, context);
};

export const termctrlExtension = (harness: () => Promise<Harness>, options: TermctrlOptions): Extension =>
  defineExtension({
    name: TERMCTRL_EXTENSION,
    tools: [terminalStartTool(options.host), terminalSendTool(options.host), terminalStopTool(options.host), terminalListTool(options.host), terminalWaitTool(options.host)],
    hooks: [
      hook(GenerationTask, {
        afterTools: async (_assistant, _results, api, context) => {
          await notify(harness, options, api, context, true);
        },
        onYield: async (_answer, api, context) => {
          await notify(harness, options, api, context, false);
          return undefined;
        },
      }),
    ],
    sections: [
      section("terminals", (input) => {
        const offered = new Set(input.agent.tools.map((tool) => tool.name));
        const lines = Object.entries(TERMCTRL_GUIDELINES).flatMap(([tool, line]) => (offered.has(tool) ? [`- ${line}`] : []));
        return lines.length === 0 ? undefined : lines.join("\n");
      }),
    ],
  });

/**
 * `bash`'s `background: true` (pi-termctrl `bash-replacement.ts`): the command starts as a Background job and waits 2 s;
 * one that finished answers as `bash` does (its output and exit code), else the call returns the job's id and log.
 */
export const backgroundJobs = (host: TermctrlHost): BackgroundJobs => ({
  async run(command: string, cwd: string, _api: ToolExecutionApi, _context: Context) {
    const owner = host.owner();
    const started = await host.call({ op: "start", owner, kind: "background_job", command: host.toToolPath(command), cwd, ...host.viewport(), notify: true });
    if (!started.ok) throw new Error(started.error);
    const id = started.value.entry.id;
    const settled = await host.call({ op: "settle", owner, id, mode: "start", deadline: Date.now() + START_WAIT_MS, chunkMs: START_WAIT_MS, pattern: "\u0000never", view: true });
    if (!settled.ok) throw new Error(settled.error);
    const view = settled.value.view;
    const output = view.output ?? "";
    if (view.state === "exited") {
      // Finished in the foreground: an ordinary `bash` result, and no job is left behind.
      await host.call({ op: "stop", owner, id });
      const exitCode = view.exit?.code ?? null;
      const text = `${output === "" ? "(no output)" : output}${exitCode === 0 ? "" : `\n\nCommand ${exitCode === null ? `ended by ${view.exit?.signal ?? "a signal"}` : `exited with code ${exitCode}`}`}`;
      return {
        output: [{ type: "text" as const, text }],
        isError: exitCode !== 0,
        details: exitCode === null ? {} : { exitCode },
        structuredOutput: { output, truncated: false, ...(exitCode === null ? {} : { exitCode }) },
      };
    }
    const status = `Command moved to the background as ${id}. Its output so far and all later output go to ${view.logPath ?? "its log"}. You will get an Exit notification when it ends, so do not poll the log in a loop; to block until it ends, call terminal_wait. Stop it with terminal_stop {"id": "${id}"}.`;
    return {
      output: [{ type: "text" as const, text: output === "" ? status : `${output}\n\n${status}` }],
      details: { background: { id, log_path: view.logPath ?? null } },
      structuredOutput: { output, truncated: false, background: { id, log_path: view.logPath ?? "" } },
    };
  },
});
