// @effect-diagnostics globalDate:off
// t3's TerminalManager in the Cloud Environment (step 2b, ADR-0021): a Layer of ours that restates `Manager.make` and
// calls t3's exported `makeWithOptions`, so all of t3's terminal behaviour (sessions, viewers, scrollback, history
// files, resume, setup scripts) stays stock above the PTY seam. `TerminalManager.layer` is not used.
//
// The options that differ from `make`:
// - `env`: a fixed base, never `process.env` (review F0's second layer; the PTY adapter's allowlist is the third);
// - `ptyAdapter`: ours (`ptyAdapter.ts`), shells in the Workspace's Container;
// - `shellResolver`: bash;
// - `subprocessInspector`: the rc file's markers (review F1), so t3 never spawns `ps` and `closeIdle` keeps a terminal
//   that runs `npm run dev`;
// - `historyByteLimit` 1 MiB and `maxRetainedInactiveSessions` 16, for the 128 MB isolate;
// - no `registerTerminalProcesses` (synthetic pids would feed port discovery) and no
//   `resolveProviderInstanceEnvironment` (a provider instance's env can carry credentials, ADR-0016; review F10).
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "t3/src/config.ts";
import * as ProcessRunner from "t3/src/processRunner.ts";
import * as TerminalManager from "t3/src/terminal/Manager.ts";

import { locate } from "../agents/workspaceClient.ts";
import { setCurrentTerminals } from "./current.ts";
import { TerminalProcesses } from "./ptyAdapter.ts";

/** The shell's base env: t3 adds its own runtime keys (`T3CODE_*`, `NO_COLOR`, …) on top. */
export const TERMINAL_BASE_ENV: Readonly<Record<string, string>> = {
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  SHELL: "/bin/bash",
};

export const HISTORY_BYTE_LIMIT = 1024 * 1024;
export const MAX_RETAINED_INACTIVE_SESSIONS = 16;

const newKey = (): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `term-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export const makeTerminalProcesses = (): TerminalProcesses =>
  new TerminalProcesses({
    newKey,
    place: (cwd) => {
      const located = locate(cwd);
      if (located === undefined) return undefined;
      const parent = located.record.kind === "worktree" ? located.record.parent : null;
      return { workspace: located.id, t3Path: `/w/${located.id}`, remote: located.rpc, ...(parent === null ? {} : { projectRoot: `/w/${parent}` }) };
    },
  });

/** `makeWithOptions`' options for this Environment's terminals (shared with the Node test of the real stack). */
export const terminalManagerOptions = (processes: TerminalProcesses, logsDir: string) => ({
  logsDir,
  env: { ...TERMINAL_BASE_ENV },
  shellResolver: () => "/bin/bash",
  historyByteLimit: HISTORY_BYTE_LIMIT,
  maxRetainedInactiveSessions: MAX_RETAINED_INACTIVE_SESSIONS,
  ptyAdapter: {
    spawn: (input: PtyAdapter.PtySpawnInput) =>
      Effect.try({
        try: (): PtyAdapter.PtyProcess => processes.spawn(input),
        catch: (cause) => new PtyAdapter.PtySpawnError({ adapter: "t3flare", shell: input.shell, cause }),
      }),
  },
  subprocessInspector: (pid: number) => Effect.succeed({ hasRunningSubprocess: processes.busy(pid), childCommand: null, processIds: [] }),
});

export const layer = Layer.effect(
  TerminalManager.TerminalManager,
  Effect.gen(function* () {
    const { terminalLogsDir } = yield* ServerConfig.ServerConfig;
    const processes = makeTerminalProcesses();
    setCurrentTerminals(processes);
    return yield* TerminalManager.makeWithOptions(terminalManagerOptions(processes, terminalLogsDir));
  }),
).pipe(Layer.provide(ProcessRunner.layer));
