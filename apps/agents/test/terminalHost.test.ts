// The Workspace DO's terminals (step 2b, ADR-0021) at their seam, `TerminalHost`, over a fake PTY process: what the
// Environment's adapter sees pushed, and what reaches the shell and the kill script. Review F1 (markers), F2 (no
// `ExecProcess.kill`), F10 (only input is use), F11 (the epoch) and D1 (a lapsed heartbeat kills).
// @effect-diagnostics globalTimers:off newPromise:off globalDate:off
import { MARK_BUSY, MARK_PROMPT, scanMarkers } from "@t3flare/sandbox-image/terminal";
import type { TerminalFrame, TerminalPushAnswer } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { HEARTBEAT_LAPSE_MS, MAX_TERMINALS, type ShellProcess, TerminalHost, type TerminalHostDeps } from "../src/workspace/terminalHost.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shell: what is written to its stdin, its stdout to feed, its exit to settle. No `kill`, as the host must not call one. */
const fakeShell = () => {
  const typed: Array<string> = [];
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const resized: Array<[number, number]> = [];
  const process: ShellProcess = {
    stdin: new WritableStream<Uint8Array>({ write: (chunk) => void typed.push(decoder.decode(chunk)) }),
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => void (feed = controller) }),
    exitCode: new Promise<number>((resolve) => (exit = resolve)),
    resize: (cols, rows) => void resized.push([cols, rows]),
  };
  return {
    process,
    typed,
    resized,
    print: (text: string) => feed.enqueue(encoder.encode(text)),
    exit: (code: number) => {
      feed.close();
      exit(code);
    },
  };
};

const harness = (options: { running?: boolean; refuse?: string; answer?: (frames: ReadonlyArray<TerminalFrame>) => TerminalPushAnswer } = {}) => {
  let now = 1_000_000;
  let running = options.running ?? true;
  const shells: Array<ReturnType<typeof fakeShell>> = [];
  const spawned: Array<{ argv: ReadonlyArray<string>; env: Record<string, string> }> = [];
  const frames: Array<TerminalFrame> = [];
  const killed: Array<ReadonlyArray<string>> = [];
  const changes: Array<string> = [];
  let remembered: ReadonlyArray<string> = [];
  const deps: TerminalHostDeps = {
    now: () => now,
    epoch: "epoch-1",
    running: () => running,
    startContainer: async () => {
      if (options.refuse !== undefined) throw new Error(options.refuse);
      running = true;
    },
    spawn: async (argv, spawnOptions) => {
      const shell = fakeShell();
      shells.push(shell);
      spawned.push({ argv, env: spawnOptions.env });
      return shell.process;
    },
    kill: async (markers) => void killed.push(markers),
    push: async (push) => {
      frames.push(...push.frames);
      return options.answer?.(push.frames) ?? { unknown: [] };
    },
    baseEnv: { PATH: "/usr/bin", MISE_YES: "1" },
    filesMayHaveChanged: (why) => void changes.push(why),
    remember: (markers) => void (remembered = markers),
    remembered: () => remembered,
    beforeSpawn: async () => undefined,
    projectRootView: "/workspace/.t3flare/project-root",
  };
  const host = new TerminalHost(deps);
  return {
    host,
    shells,
    spawned,
    frames,
    killed,
    changes,
    advance: (ms: number) => void (now += ms),
    setRemembered: (markers: ReadonlyArray<string>) => void (remembered = markers),
    text: (key: string) => frames.filter((frame) => frame.key === key && frame.data !== undefined).map((frame) => frame.data).join(""),
  };
};

const open = (key: string) => ({ key, t3Path: "/w/demo", cwd: "/w/demo/src", cols: 80, rows: 24, env: { TERM: "xterm-256color" } });

describe("scanMarkers", () => {
  it("strips the rc file's markers and reports the foreground's state and prompts", () => {
    const scanned = scanMarkers("", `ls${MARK_BUSY}a b\r\n${MARK_PROMPT}$ `);
    expect(scanned).toEqual({ text: "lsa b\r\n$ ", busy: false, prompts: 1, carry: "" });
  });

  it("keeps a marker cut by the chunk's end for the next chunk", () => {
    const first = scanMarkers("", `out${MARK_PROMPT.slice(0, 4)}`);
    expect(first).toMatchObject({ text: "out", prompts: 0, carry: MARK_PROMPT.slice(0, 4) });
    const second = scanMarkers(first.carry, `${MARK_PROMPT.slice(4)}$ `);
    expect(second).toEqual({ text: "$ ", busy: false, prompts: 1, carry: "" });
  });

  it("passes other escape sequences and OSCs through", () => {
    const text = "\x1b[1;34mblue\x1b[0m \x1b]0;title\x07 \x1b]6973;x\x07";
    expect(scanMarkers("", text).text).toBe(text);
  });
});

describe("TerminalHost", () => {
  it("opens a shell under the wrapper with the marker and no BASH_ENV, after the status line when the Container is stopped", async () => {
    const h = harness({ running: false });
    const answer = await h.host.open(open("term-a1"));
    expect(answer).toEqual({ epoch: "epoch-1", unknown: [] });
    expect(h.spawned[0]!.argv.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(h.spawned[0]!.argv[2]).toContain("exec bash --rcfile /tmp/t3flare-rc-term-a1 -i");
    expect(h.spawned[0]!.argv[2]).toContain("mount --bind '/workspace/repo' '/w/demo'");
    expect(h.spawned[0]!.env).toEqual({ PATH: "/usr/bin", MISE_YES: "1", TERM: "xterm-256color", T3FLARE_EXEC: "term-a1" });
    await h.host.settled();
    expect(h.text("term-a1")).toContain("Starting the Workspace's Container");
  });

  it("strips the markers, pushes the foreground's state, and holds input until the first prompt", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    await h.host.input("term-a1", "echo hi\r");
    await h.host.input("term-a1", "pwd\r");
    expect(h.shells[0]!.typed).toEqual([]);
    h.shells[0]!.print(`motd\r\n${MARK_PROMPT}# `);
    await tick();
    expect(h.shells[0]!.typed).toEqual(["echo hi\r", "pwd\r"]);
    h.shells[0]!.print(`${MARK_BUSY}hi\r\n`);
    await tick();
    await h.host.settled();
    expect(h.text("term-a1")).toBe("motd\r\n# hi\r\n");
    expect(h.frames.filter((frame) => frame.busy !== undefined).map((frame) => frame.busy)).toEqual([false, true]);
    expect(h.frames.map((frame) => frame.seq)).toEqual([...h.frames.keys()]);
    expect(h.changes).toContain("prompt");
  });

  it("closes through the kill script on the marker, and reports the exit with the shell's code", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    await h.host.close("term-a1");
    expect(h.killed).toEqual([["term-a1"]]);
    h.shells[0]!.exit(143);
    await tick();
    await h.host.settled();
    expect(h.frames.at(-1)).toMatchObject({ key: "term-a1", exit: { code: 143 } });
    expect(h.host.size).toBe(0);
    // What the shell left in its session is killed after the exit too; a later close is answered as unknown.
    expect(h.killed).toEqual([["term-a1"], ["term-a1"]]);
    expect(await h.host.close("term-a1")).toEqual({ epoch: "epoch-1", unknown: ["term-a1"] });
  });

  it("kills a terminal whose Environment stopped heartbeating", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    await h.host.open(open("term-b2"));
    h.advance(HEARTBEAT_LAPSE_MS - 1);
    expect(h.host.heartbeat(["term-b2", "term-zz"])).toEqual({ epoch: "epoch-1", unknown: ["term-zz"] });
    expect(await h.host.expire()).toBe(0);
    h.advance(2);
    expect(await h.host.expire()).toBe(1);
    expect(h.killed).toEqual([["term-a1"]]);
  });

  it("kills a terminal the Environment answers as unknown", async () => {
    const h = harness({ answer: (frames) => ({ unknown: [...new Set(frames.map((frame) => frame.key))] }) });
    await h.host.open(open("term-a1"));
    h.shells[0]!.print("output nobody reads");
    await tick();
    await h.host.settled();
    expect(h.killed).toEqual([["term-a1"]]);
  });

  it("refuses a terminal over the limit and one whose Container cannot start, in the terminal", async () => {
    const h = harness();
    for (let i = 0; i < MAX_TERMINALS; i++) await h.host.open(open(`term-${i}`));
    await h.host.open(open("term-extra"));
    await h.host.settled();
    expect(h.text("term-extra")).toContain(`already has ${MAX_TERMINALS} open terminals`);
    expect(h.frames.at(-1)).toMatchObject({ key: "term-extra", exit: { code: 1 } });

    const refused = harness({ running: false, refuse: "the Container cannot start: 3 Containers are running" });
    await refused.host.open(open("term-a1"));
    await refused.host.settled();
    expect(refused.text("term-a1")).toContain("t3flare: the Container cannot start: 3 Containers are running");
    expect(refused.frames.at(-1)).toMatchObject({ exit: { code: 1 } });
    expect(refused.spawned).toEqual([]);
  });

  it("counts only input as use: output does not move the last input", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    const opened = h.host.lastInput;
    h.advance(60_000);
    h.shells[0]!.print(`${MARK_PROMPT}tick\r\n`.repeat(20));
    await tick();
    expect(h.host.lastInput).toBe(opened);
    await h.host.input("term-a1", "x");
    expect(h.host.lastInput).toBe(opened + 60_000);
  });

  it("kills the shells an earlier instance started and lost, at the first open", async () => {
    const h = harness();
    h.setRemembered(["term-old1", "term-old2"]);
    await h.host.open(open("term-new"));
    expect(h.killed).toEqual([["term-old1", "term-old2"]]);
  });

  it("ends every shell when the Container stops", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    h.host.containerStopped();
    await h.host.settled();
    expect(h.text("term-a1")).toContain("Container stopped");
    expect(h.frames.at(-1)).toMatchObject({ exit: { code: 129 } });
  });
});
