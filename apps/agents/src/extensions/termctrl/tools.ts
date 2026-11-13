// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-termctrl/src/terminal-tools.ts and exit-notification.ts
// (SPI-1057): the owner's `terminal_start`, `terminal_send`, `terminal_stop`, `terminal_list` and `terminal_wait`, as
// plain pi-durable tools over the Workspace DO's agent terminals (`workspace/agentTerminals.ts`). Kept: the parameters,
// defaults and clamps, the settle reasons, `wait_for_text`, the result's first line, the Screen Delta, scrolled-off lines
// within `termctrl.scrollback`'s default limits (100 lines or 16 KB, first and last kept), `changed`, the exit texts, and
// the Steer Yield (a queued steer ends a wait as `steered`). Changed: the wait runs in the Workspace DO in slices, and
// between slices the tool checks this conversation's inbox for a steer; nothing is written to files on the Worker
// (termctrl's full-output files), so a cut result says to run the command with `bash` or redirect it; the cwd is the
// Workspace's (`/workspace/repo`), and t3's `/w/<id>` paths are translated as `bash`'s are (`permissions.ts`).
// @effect-diagnostics asyncFunction:off globalDate:off
import type { Context } from "@earendil-works/chord";
import { defineTool, InboxDoc, type JsonObject, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { AgentEntryInfo, AgentExit, AgentSettleReason, AgentTerminalRequest, AgentTerminalResult, AgentView } from "@t3flare/workspace-client";

export const QUIET_MS = 250;
export const START_WAIT_MS = 2_000;
export const INPUT_WAIT_MS = 500;
export const POLL_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 5 * 60_000;
/** How long one Workspace slice of a wait lasts before the tool checks for a steer. */
export const SLICE_MS = 5_000;
/** termctrl's `scrollback` default: scrolled-off lines a result shows. */
export const SCROLLBACK = { lines: 100, bytes: 16_384 };
/** pi's tool output limits (2,000 lines or 50 KB), which the screen is cut to first. */
const OUTPUT = { lines: 2_000, bytes: 51_200 };
/** termctrl's `exitTailLines` default. */
export const EXIT_TAIL_LINES = 20;

export const TERMINAL_KEYS: ReadonlyArray<string> = [
  "Enter",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

/** What the tools need of the Session: its Workspace's agent terminals, the owner name, the viewport, path translation. */
export interface TermctrlHost {
  readonly call: <R extends AgentTerminalRequest>(request: R) => Promise<AgentTerminalResult<R["op"]>>;
  /** This Session (the owner of its entries). */
  readonly owner: () => string;
  readonly viewport: () => { readonly cols: number; readonly rows: number };
  /** t3's `/w/<id>` as `/workspace/repo` in a command or typed text (`permissions.ts` `toToolPath`). */
  readonly toToolPath: (text: string) => string;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

export const clampWait = (requested: number | undefined, fallback: number): number => Math.min(MAX_WAIT_MS, Math.max(0, requested ?? fallback));

/** How a process ended (exit-notification.ts `describeExitStatus`). */
export const describeExitStatus = (exit: AgentExit): string => {
  if (exit.signal !== null && exit.code !== null) return `exited with code ${exit.code} (${exit.signal})`;
  if (exit.signal !== null) return `ended by ${exit.signal}`;
  return `exited with code ${exit.code ?? "unknown"}`;
};

export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const lastLines = (output: string, count: number): string => {
  if (count === 0) return "";
  return output.replace(/\n+$/u, "").split("\n").slice(-count).join("\n");
};

/** One exit as an Exit notification and `terminal_wait` describe it (exit-notification.ts `formatExitNotice`). */
export const formatExitNotice = (entry: AgentEntryInfo, output: string, tailLines: number): string => {
  const label = entry.kind === "terminal" ? "Terminal" : "Background job";
  const exit = entry.exit ?? { code: null, signal: null };
  const head = `${label} ${entry.id} ${describeExitStatus(exit)} after ${formatDuration((entry.endedAt ?? entry.startedAt) - entry.startedAt)}: ${entry.command}\n${
    entry.logPath !== undefined ? `Log: ${entry.logPath}` : `terminal_send {"id": "${entry.id}"} returns its final screen.`
  }`;
  const tail = lastLines(output, tailLines);
  return tail === "" ? head : `${head}\nLast lines of ${entry.kind === "terminal" ? "final screen" : "output"}:\n${tail}`;
};

const exitFields = (exit: AgentExit | null): { exit_code?: number; signal?: string } => ({
  ...(exit?.code === null || exit?.code === undefined ? {} : { exit_code: exit.code }),
  ...(exit?.signal === null || exit?.signal === undefined ? {} : { signal: exit.signal }),
});

const splitRows = (screen: string): Array<string> => (screen === "" ? [] : screen.split("\n"));

/** The last `limits` of `text`'s lines. */
const keepTail = (text: string, limits: { readonly lines: number; readonly bytes: number }): { readonly text: string; readonly cut: boolean } => {
  let lines = splitRows(text);
  const cut = lines.length > limits.lines || bytes(text) > limits.bytes;
  lines = lines.slice(-limits.lines);
  while (lines.length > 1 && bytes(lines.join("\n")) > limits.bytes) lines = lines.slice(1);
  return { text: lines.join("\n"), cut };
};

/** Scrolled-off lines within termctrl's scrollback limits: the first and last kept around a marker. */
export const fitScrolled = (lines: ReadonlyArray<string>): { readonly text: string; readonly summary?: string } => {
  const text = lines.join("\n");
  if (lines.length <= SCROLLBACK.lines && bytes(text) <= SCROLLBACK.bytes) return { text };
  const marker = (count: number) => `[… ${count} lines omitted …]`;
  const bodyLines = SCROLLBACK.lines - 1;
  const bodyBytes = SCROLLBACK.bytes - bytes(marker(lines.length));
  const head: Array<string> = [];
  let headBytes = 0;
  for (const line of lines) {
    if (head.length >= Math.ceil(bodyLines / 2) || headBytes + bytes(line) + 1 > Math.floor(bodyBytes / 2)) break;
    head.push(line);
    headBytes += bytes(line) + 1;
  }
  const tail: Array<string> = [];
  let tailBytes = 0;
  for (let index = lines.length - 1; index >= head.length; index--) {
    const line = lines[index] ?? "";
    if (tail.length >= bodyLines - head.length || tailBytes + bytes(line) + 1 > bodyBytes - headBytes) break;
    tail.unshift(line);
    tailBytes += bytes(line) + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return {
    text: [...head, marker(omitted), ...tail].join("\n"),
    summary: `Showing the first ${head.length} and last ${tail.length} of ${lines.length} scrolled-off lines (16.0KB or ${SCROLLBACK.lines} line limit).`,
  };
};

const GAP_NOTICE =
  "[Earlier output is missing: the Terminal keeps limited scrollback and dropped lines, or the screen was cleared. For complete output, run the command with bash or redirect it to a file.]";

export type TerminalResult = {
  readonly id: string;
  readonly state: "running" | "exited";
  readonly settle_reason: AgentSettleReason | "steered";
  readonly exit_code?: number;
  readonly signal?: string;
  readonly changed: boolean;
  readonly cursor: { readonly row: number; readonly column: number } | null;
  readonly screen: string;
  readonly screen_from_row?: number;
  readonly scrolled_off: string;
  readonly output_missing?: boolean;
};

/** A result whose structured value is also its details (the differ reads them). */
const toolResult = (text: string, value: object) => ({ output: [{ type: "text" as const, text }], structuredOutput: value as JsonObject, details: value as JsonObject });

/**
 * Where a Screen Delta starts (terminal-tools.ts `screenDeltaStart`): the previous cursor row moved up by the rows the
 * screen scrolled, when every row above it still on the screen is unchanged; 0 shows the whole screen.
 */
const deltaStart = (view: AgentView, rows: ReadonlyArray<string>): number => {
  const previous = view.previous;
  if (previous === null || previous.cursorRow === null || view.shift === null) return 0;
  const start = previous.cursorRow - view.shift;
  if (start <= 0 || start >= rows.length) return 0;
  const before = splitRows(previous.screen);
  for (let row = view.shift; row < previous.cursorRow; row++) if ((before[row] ?? "") !== (rows[row - view.shift] ?? "")) return 0;
  return start;
};

/** The agent's view of a Terminal after a wait (terminal-tools.ts `terminalResult` and `formatTerminalText`). */
export const terminalResult = (
  view: AgentView,
  reason: AgentSettleReason | "steered",
  options: { readonly note?: string | undefined; readonly fullScreen?: boolean | undefined; readonly label?: string } = {},
) => {
  const rows = splitRows(view.screen);
  // A line the agent saw on its previous screen is not repeated when it scrolls off unchanged.
  const seen = view.shift === null ? [] : splitRows(view.previous?.screen ?? "");
  const scrolled = view.scrolledOff.filter((line, index) => line !== seen[index]);
  const fitted = fitScrolled(scrolled);
  const unchanged = view.previous !== null && view.previous.screen === view.screen;
  const start = options.fullScreen === true || unchanged ? 0 : deltaStart(view, rows);
  const omitted = options.fullScreen !== true && unchanged;
  const shown = keepTail(start === 0 ? view.screen : rows.slice(start).join("\n"), OUTPUT);
  const cursor = view.cursor === null ? null : { row: view.cursor.y + 1, column: view.cursor.x + 1 };
  const result: TerminalResult = {
    id: view.id,
    state: view.state,
    settle_reason: reason,
    ...exitFields(view.state === "exited" ? view.exit : null),
    changed: !unchanged,
    cursor,
    screen: view.screen,
    ...(start > 0 ? { screen_from_row: start + 1 } : {}),
    scrolled_off: fitted.text,
    ...(view.outputMissing ? { output_missing: true } : {}),
  };
  const exit = view.state === "running" ? "running" : describeExitStatus(view.exit ?? { code: null, signal: null });
  const parts = [`${view.id} ${exit} · settled: ${reason}${unchanged ? " · screen unchanged" : ""} · ${cursor === null ? "cursor hidden" : `cursor ${cursor.row}:${cursor.column}`}`];
  if (options.note !== undefined) parts.push(options.note);
  if (fitted.text !== "") parts.push(`--- scrolled off ---\n${fitted.text}`);
  if (!omitted) {
    const label = options.label ?? "screen";
    const marker = start === 0 ? `--- ${label} ---` : `--- ${label} (rows ${start + 1}-${rows.length} of ${rows.length}; rows above unchanged) ---`;
    parts.push(`${marker}\n${shown.text === "" ? "(blank)" : shown.text}`);
  }
  const notices = [
    ...(view.outputMissing ? [GAP_NOTICE] : []),
    ...(fitted.summary === undefined ? [] : [`[${fitted.summary} For complete output, run the command with bash or redirect it to a file.]`]),
    ...(shown.cut ? ["[The screen was cut to its last 2000 lines or 50KB.]"] : []),
  ];
  const text = notices.length === 0 ? parts.join("\n") : `${parts.join("\n")}\n\n${notices.join("\n")}`;
  return { text, result };
};

/** Throws the Workspace's error, else answers its value. */
const valueOf = <Op extends AgentTerminalRequest["op"]>(answer: AgentTerminalResult<Op>) => {
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

/** A steer queued for this conversation (Follow-ups never count): the Steer Yield. */
const steerQueued = async (api: ToolExecutionApi, context: Context): Promise<boolean> => {
  const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
  return inbox?.items.some((item) => item.mode === "steer") === true;
};

/**
 * A settle wait in Workspace slices: the input goes with the first, and a steer queued between slices ends the wait as
 * `steered` (the Terminal keeps running).
 */
const settle = async (
  host: TermctrlHost,
  api: ToolExecutionApi,
  context: Context,
  input: { readonly id: string; readonly text?: string; readonly keys?: ReadonlyArray<string>; readonly mode: "start" | "input" | "poll"; readonly waitMs: number; readonly pattern?: string },
): Promise<{ readonly view: AgentView; readonly reason: AgentSettleReason | "steered" }> => {
  const deadline = Date.now() + input.waitMs;
  let since: string | undefined;
  for (;;) {
    const steered = since !== undefined && (await steerQueued(api, context));
    const answer = valueOf(
      await host.call({
        op: "settle",
        owner: host.owner(),
        id: input.id,
        ...(since === undefined && input.text !== undefined ? { text: host.toToolPath(input.text) } : {}),
        ...(since === undefined && input.keys !== undefined ? { keys: input.keys } : {}),
        mode: input.mode,
        // A steer found between slices: one last, immediate read of the screen as the result.
        deadline: steered ? Date.now() : deadline,
        chunkMs: SLICE_MS,
        ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
        ...(since === undefined ? {} : { since }),
        view: true,
      }),
    );
    if (steered) return { view: answer.view, reason: "steered" };
    if (answer.reason !== "chunk") return { view: answer.view, reason: answer.reason };
    since = answer.startScreen;
  }
};

const unmatchedNote = (reason: string, pattern: string | undefined): string | undefined =>
  (reason === "timeout" || reason === "steered") && pattern !== undefined ? `wait_for_text ${JSON.stringify(pattern)} was not seen before the wait ended.` : undefined;

/** Loose schemas: the shapes are the results above; code mode scripts get them as values. */
const OBJECT = { type: "object" } as const;

const waitMs = (description: string) => opt(int({ minimum: 0, description }));

export const terminalStartTool = (host: TermctrlHost): ToolRegistration =>
  defineTool({
    name: "terminal_start",
    description:
      "Start a program in a new interactive Terminal (a PTY in the Workspace's container) and return its screen once it settles: 250 ms of quiet, exit, wait_ms (default 2000), or a message queued for you (settle_reason steered; the Terminal keeps running). Use it for REPLs, TUIs, prompts and other programs that need input or a screen. Drive it with terminal_send and end it with terminal_stop.",
    parameters: obj({
      command: str({ description: "Shell command that starts the program" }),
      cwd: opt(str({ description: "Working directory (default: the repo)" })),
      wait_ms: waitMs("Maximum milliseconds to wait (clamped to 300000)"),
      notify: opt(bool({ description: "Send an Exit notification when it exits (default true); to block until it exits, use terminal_wait" })),
    }),
    structuredOutputSchema: OBJECT,
    async execute(args, api, context) {
      const cwd = args.cwd === undefined ? "/workspace/repo" : host.toToolPath(args.cwd.startsWith("/") ? args.cwd : `/workspace/repo/${args.cwd}`);
      const { entry } = valueOf(
        await host.call({ op: "start", owner: host.owner(), kind: "terminal", command: host.toToolPath(args.command), cwd, ...host.viewport(), notify: args.notify ?? true }),
      );
      const { view, reason } = await settle(host, api, context, { id: entry.id, mode: "start", waitMs: clampWait(args.wait_ms, START_WAIT_MS) });
      const shown = terminalResult(view, reason, { fullScreen: true });
      return toolResult(shown.text, shown.result);
    },
  });

export const terminalSendTool = (host: TermctrlHost): ToolRegistration =>
  defineTool({
    name: "terminal_send",
    description:
      "Type text and press keys in a Terminal, then return its screen once it settles: 250 ms of quiet, a wait_for_text match, exit, wait_ms (default 500), or a message queued for you (settle_reason steered; the Terminal keeps running). With neither text nor keys it polls: it waits up to wait_ms (default 30000) for new output. Results include the lines that scrolled off since your previous result. When the rows above the previous result's cursor row are unchanged, the screen shows only the rows from there down; an unchanged screen shows no rows; full_screen: true shows the whole screen.",
    parameters: obj({
      id: str({ description: "Terminal id, such as t1" }),
      text: opt(str({ description: "Text to type; \\n presses Enter" })),
      keys: opt(arr(str(), { description: `Keys pressed after text: ${TERMINAL_KEYS.join(", ")}, Control+A to Control+Z` })),
      wait_for_text: opt(str({ description: "Wait until the screen shows this text, or /regex/flags" })),
      wait_ms: waitMs("Maximum milliseconds to wait (clamped to 300000)"),
      full_screen: opt(bool({ description: "Show the whole screen in this result, even when the rows above the previous cursor row are unchanged or the screen is unchanged" })),
    }),
    structuredOutputSchema: OBJECT,
    async execute(args, api, context) {
      if (/^b\d+$/.test(args.id)) throw new Error(`${args.id} is a Background job, which accepts no input. Read its log or stop it with terminal_stop.`);
      const keys = args.keys ?? [];
      const hasInput = (args.text ?? "") !== "" || keys.length > 0;
      const { view, reason } = await settle(host, api, context, {
        id: args.id,
        ...(args.text === undefined || args.text === "" ? {} : { text: args.text.replaceAll("\n", "\r") }),
        ...(keys.length === 0 ? {} : { keys }),
        mode: hasInput ? "input" : "poll",
        waitMs: clampWait(args.wait_ms, hasInput ? INPUT_WAIT_MS : POLL_WAIT_MS),
        ...(args.wait_for_text === undefined ? {} : { pattern: args.wait_for_text }),
      });
      const shown = terminalResult(view, reason, { note: unmatchedNote(reason, args.wait_for_text), fullScreen: args.full_screen });
      return toolResult(shown.text, shown.result);
    },
  });

export const terminalStopTool = (host: TermctrlHost): ToolRegistration =>
  defineTool({
    name: "terminal_stop",
    description:
      "Stop a Terminal (t1) or Background job (b1) and forget it. Running processes are killed; exited ones are removed. Returns a Terminal's final screen (omitted when unchanged since your previous result) and scrolled-off lines, or a Background job's recent output.",
    parameters: obj({ id: str({ description: "A Terminal id (t1) or Background job id (b1)" }) }),
    structuredOutputSchema: OBJECT,
    async execute(args) {
      const { stopped, view } = valueOf(await host.call({ op: "stop", owner: host.owner(), id: args.id }));
      if (stopped.kind === "background_job") {
        const result = { id: stopped.id, kind: stopped.kind, state: "exited" as const, ...exitFields(stopped.exit), output: view.output ?? "" };
        const text = `Background job ${stopped.id} stopped (${describeExitStatus(stopped.exit ?? { code: null, signal: null })}).\n--- recent output ---\n${view.output === "" ? "(none)" : (view.output ?? "")}`;
        return toolResult(text, result);
      }
      const shown = terminalResult(view, "exited", { label: "final screen" });
      const text = shown.text.replace(/^[^\n]*/, `Terminal ${stopped.id} stopped · ${view.cursor === null ? "cursor hidden" : `cursor ${view.cursor.y + 1}:${view.cursor.x + 1}`}`);
      return toolResult(text, { ...shown.result, kind: stopped.kind });
    },
  });

const listLine = (entry: AgentEntryInfo, now: number): string =>
  `${entry.id} ${entry.state === "running" ? "running" : describeExitStatus(entry.exit ?? { code: null, signal: null })} · ${Math.round((now - entry.startedAt) / 1000)}s · ${entry.command}${
    entry.logPath === undefined ? "" : ` · log ${entry.logPath}`
  }`;

const listEntry = (entry: AgentEntryInfo, now: number) => ({
  id: entry.id,
  command: entry.command,
  state: entry.state,
  ...exitFields(entry.exit),
  age_seconds: Math.round((now - entry.startedAt) / 1000),
  ...(entry.logPath === undefined ? {} : { log_path: entry.logPath }),
});

export const terminalListTool = (host: TermctrlHost): ToolRegistration =>
  defineTool({
    name: "terminal_list",
    description: "List your Terminals and Background jobs, running and exited, with their state. Background jobs include their log path.",
    parameters: obj({}),
    structuredOutputSchema: OBJECT,
    replay: "safe",
    async execute() {
      const { entries } = valueOf(await host.call({ op: "list", owner: host.owner() }));
      const now = Date.now();
      const terminals = entries.filter((entry) => entry.kind === "terminal");
      const jobs = entries.filter((entry) => entry.kind === "background_job");
      const section = (title: string, items: ReadonlyArray<AgentEntryInfo>) => `${title}:\n${items.length === 0 ? "(none)" : items.map((entry) => listLine(entry, now)).join("\n")}`;
      const result = { terminals: terminals.map((entry) => listEntry(entry, now)), background_jobs: jobs.map((entry) => listEntry(entry, now)) };
      return toolResult(`${section("Terminals", terminals)}\n\n${section("Background jobs", jobs)}`, result);
    },
  });

const WAIT_REASON_TEXT = {
  timeout: (ms: number) => `Nothing exited within ${Math.round(ms / 1000)}s.`,
  steered: () => "Returned early: a message is queued for you.",
  nothing_running: () => "Nothing to wait for: you have no running Terminals or Background jobs.",
} as const;

export const terminalWaitTool = (host: TermctrlHost): ToolRegistration =>
  defineTool({
    name: "terminal_wait",
    description:
      "Wait until one of your Terminals or Background jobs exits, then return every exit so far and what is still running. Returns early when wait_ms (default 300000) runs out or a steer is queued for you; whatever it waited on keeps running. Exits it returns send no Exit notification.",
    parameters: obj({
      ids: opt(arr(str(), { description: "Terminal or Background job ids to wait for (default: all of yours still running)" })),
      wait_ms: waitMs("Maximum milliseconds to wait (default and maximum 300000)"),
    }),
    structuredOutputSchema: OBJECT,
    async execute(args, api, context) {
      const ms = clampWait(args.wait_ms, MAX_WAIT_MS);
      const deadline = Date.now() + ms;
      let reason: "exited" | "timeout" | "steered" | "nothing_running" = "nothing_running";
      let answer: { readonly exited: ReadonlyArray<AgentEntryInfo>; readonly running: ReadonlyArray<AgentEntryInfo>; readonly timedOut: boolean } | undefined;
      for (;;) {
        answer = valueOf(await host.call({ op: "wait", owner: host.owner(), ids: args.ids ?? null, deadline, chunkMs: SLICE_MS }));
        if (answer.exited.length > 0) reason = "exited";
        else if (answer.running.length === 0 && args.ids === undefined) reason = "nothing_running";
        else if (answer.timedOut || Date.now() >= deadline) reason = "timeout";
        else if (await steerQueued(api, context)) reason = "steered";
        else continue;
        break;
      }
      const tails = await Promise.all(
        answer.exited.map(async (entry) => {
          // A Terminal's final screen, or a job's output, for the exit's last lines; the view is not the owner's.
          const settled = await host.call({ op: "settle", owner: host.owner(), id: entry.id, mode: "poll", deadline: Date.now(), chunkMs: 0, view: false });
          return settled.ok ? (entry.kind === "terminal" ? settled.value.view.screen : (settled.value.view.output ?? "")) : "";
        }),
      );
      const now = Date.now();
      const parts = answer.exited.map((entry, index) => formatExitNotice(entry, tails[index] ?? "", EXIT_TAIL_LINES));
      if (reason !== "exited") parts.unshift(WAIT_REASON_TEXT[reason](ms));
      const running = answer.running;
      if (running.length > 0) parts.push(`Still running:\n${running.map((entry) => listLine(entry, now)).join("\n")}`);
      const result = {
        reason,
        exited: answer.exited.map((entry, index) => ({
          id: entry.id,
          kind: entry.kind,
          command: entry.command,
          ...exitFields(entry.exit),
          duration_ms: (entry.endedAt ?? now) - entry.startedAt,
          output: lastLines(tails[index] ?? "", EXIT_TAIL_LINES),
          ...(entry.logPath === undefined ? {} : { log_path: entry.logPath }),
        })),
        running: running.map((entry) => ({ id: entry.id, kind: entry.kind, command: entry.command, age_seconds: Math.round((now - entry.startedAt) / 1000) })),
      };
      return toolResult(parts.join("\n\n"), result);
    },
  });

/** pi-termctrl's prompt guidelines, for the tools the request offers. */
export const TERMCTRL_GUIDELINES: Readonly<Record<string, string>> = {
  terminal_start:
    "Use terminal_start, terminal_send and terminal_stop for programs that need input or a screen; use bash for everything else. Terminals keep limited scrollback, so long output can be lost; run commands whose full output you need with bash, or redirect their output to a file.",
  terminal_wait:
    "Do not poll a Background job's log or a Terminal in a loop to learn when it finishes: keep working and rely on its Exit notification, or call terminal_wait when nothing else can proceed.",
};
