// The Workspace DO's half of the agent's Terminals (SPI-1057): entries over a fake PTY host that echoes like a REPL,
// rendered by the headless xterm, with termctrl's settle reasons, scrolled-off lines, exits, stops, waits and the cap.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off globalDate:off nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { terminalCommand } from "@t3flare/sandbox-image/terminal";
import { describe, expect, it } from "vitest";

import { AgentTerminals, MAX_LIVE } from "../src/workspace/agentTerminals.ts";

/** A host whose "programs" answer input as `program` says, pushing frames back as the real host does. */
const fakeHost = (program: (data: string, emit: (data: string) => void, exit: (code: number) => void) => void) => {
  const opened: Array<{ key: string; command: string; cwd: string }> = [];
  const closed: Array<string> = [];
  let terminals: AgentTerminals | undefined;
  const seq = new Map<string, number>();
  const emitTo = (key: string) => (data: string) => {
    const n = seq.get(key) ?? 0;
    seq.set(key, n + 1);
    terminals!.frames([{ key, seq: n, data }]);
  };
  const exitTo = (key: string) => (code: number) => terminals!.frames([{ key, seq: 0, exit: { code } }]);
  const host = {
    open: (input: { key: string; command: string; cwd: string }) => {
      opened.push(input);
      if (input.command.includes("tee")) setTimeout(() => emitTo(input.key)("job line 1\r\njob line 2\r\n"), 5);
      else setTimeout(() => emitTo(input.key)("> "), 5);
      return Promise.resolve();
    },
    input: (key: string, data: string) => {
      program(data, emitTo(key), exitTo(key));
      return Promise.resolve();
    },
    close: (key: string) => {
      closed.push(key);
      setTimeout(() => exitTo(key)(130), 5);
      return Promise.resolve();
    },
  };
  let n = 0;
  terminals = new AgentTerminals({ host, now: () => Date.now(), nextId: () => ++n, env: {}, repo: "/workspace/repo" });
  return { terminals, opened, closed };
};

const repl = (data: string, emit: (data: string) => void, exit: (code: number) => void) => {
  if (data === "exit\r") return exit(0);
  emit(`${data.replace("\r", "")}\r\n= ${data.replace("\r", "").toUpperCase()}\r\n> `);
};

const owner = "session-a";
const start = async (terminals: AgentTerminals, kind: "terminal" | "background_job" = "terminal") => {
  const started = await terminals.handle({ op: "start", owner, kind, command: "node", cwd: "/workspace/repo", cols: 40, rows: 6, notify: true });
  if (!started.ok) throw new Error(started.error);
  return started.value.entry.id;
};
const settle = async (terminals: AgentTerminals, id: string, input: { text?: string; mode?: "start" | "input" | "poll"; pattern?: string; waitMs?: number } = {}) => {
  const answer = await terminals.handle({
    op: "settle",
    owner,
    id,
    ...(input.text === undefined ? {} : { text: input.text }),
    mode: input.mode ?? "input",
    deadline: Date.now() + (input.waitMs ?? 2_000),
    chunkMs: 5_000,
    ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
    view: true,
  });
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

describe("agent terminals", () => {
  it("starts a Terminal, types into it, and settles on quiet with the rendered screen and cursor", async () => {
    const { terminals, opened } = fakeHost(repl);
    const id = await start(terminals);
    expect(id).toBe("t1");
    expect(opened[0]?.key).toMatch(/^term-agent-[a-z0-9]+-t1$/);
    const first = await settle(terminals, id, { mode: "start" });
    expect(first.reason).toBe("quiet");
    expect(first.view.screen).toBe("> ");
    const typed = await settle(terminals, id, { text: "abc\r" });
    expect(typed.reason).toBe("quiet");
    expect(typed.view.screen).toBe("> abc\n= ABC\n> ");
    expect(typed.view.cursor).toEqual({ x: 2, y: 2 });
    expect(typed.view.previous).toEqual({ screen: "> ", cursorRow: 0 });
  });

  it("matches wait_for_text, reports lines that scrolled off once, and settles exited", async () => {
    const { terminals } = fakeHost(repl);
    const id = await start(terminals);
    await settle(terminals, id, { mode: "start" });
    const matched = await settle(terminals, id, { text: "one\r", pattern: "/= O.E/" });
    expect(matched.reason).toBe("matched");
    for (const word of ["two", "three"]) await settle(terminals, id, { text: `${word}\r` });
    const after = await settle(terminals, id, { text: "four\r" });
    // 6 rows: "> one" left with `three`; `four` pushes out the next two, and only those are new.
    expect(after.view.scrolledOff).toEqual(["= ONE", "> two"]);
    expect(after.view.outputMissing).toBe(false);
    const exited = await settle(terminals, id, { text: "exit\r" });
    expect(exited.reason).toBe("exited");
    expect(exited.view.exit).toEqual({ code: 0, signal: null });
    const typing = await terminals.handle({ op: "settle", owner, id, text: "x", mode: "input", deadline: Date.now() + 100, chunkMs: 100, view: true });
    expect(typing.ok ? "" : typing.error).toContain("t1 has exited (exit code 0)");
  });

  it("stops and forgets an entry; waits for exits; refuses past the cap; keeps owners apart", async () => {
    const { terminals, closed } = fakeHost(repl);
    const id = await start(terminals);
    const stopped = await terminals.handle({ op: "stop", owner, id });
    expect(stopped.ok && stopped.value.stopped.exit).toEqual({ code: 130, signal: null });
    expect(closed).toHaveLength(1);
    const list = await terminals.handle({ op: "list", owner });
    expect(list.ok && list.value.entries).toEqual([]);
    const other = await terminals.handle({ op: "list", owner: "session-b" });
    expect(other.ok && other.value.entries).toEqual([]);

    const waited = await start(terminals);
    setTimeout(() => void terminals.handle({ op: "settle", owner, id: waited, text: "exit\r", mode: "input", deadline: Date.now() + 500, chunkMs: 500, view: false }), 50);
    const wait = await terminals.handle({ op: "wait", owner, ids: null, deadline: Date.now() + 2_000, chunkMs: 2_000 });
    expect(wait.ok && wait.value.exited.map((entry) => entry.id)).toEqual([waited]);
    const exits = await terminals.handle({ op: "exits", owner, tailLines: 5 });
    expect(exits.ok && exits.value.exits).toEqual([]); // reported by the wait, so not notified again

    for (let index = 0; index < MAX_LIVE; index++) await start(terminals);
    const refused = await terminals.handle({ op: "start", owner, kind: "terminal", command: "x", cwd: "/workspace/repo", cols: 40, rows: 6, notify: true });
    expect(refused.ok ? "" : refused.error).toContain(`already runs ${MAX_LIVE}`);
  });

  it("runs a Background job with its output tee'd to a log, and reports an unseen exit once", async () => {
    const { terminals, opened } = fakeHost(repl);
    const id = await start(terminals, "background_job");
    expect(id).toBe("b1");
    expect(opened[0]?.command).toContain("| tee -a '/tmp/t3flare-jobs/");
    const view = await settle(terminals, id, { mode: "start" });
    expect(view.view.output).toBe("job line 1\njob line 2");
    expect(view.view.logPath).toMatch(/^\/tmp\/t3flare-jobs\/term-agent-.+-b1\.log$/);
    terminals.frames([{ key: opened[0]!.key, seq: 9, exit: { code: 3 } }]);
    const exits = await terminals.handle({ op: "exits", owner, tailLines: 1 });
    expect(exits.ok && exits.value.exits.map((exit) => [exit.id, exit.exit, exit.tail])).toEqual([["b1", { code: 3, signal: null }, "job line 2"]]);
    const again = await terminals.handle({ op: "exits", owner, tailLines: 1 });
    expect(again.ok && again.value.exits).toEqual([]);
  });
});

describe("an agent Terminal's wrapper", () => {
  it("runs the command under bash -c in its cwd, linking nothing for the repo's own path", () => {
    const wrapper = terminalCommand({ marker: "term-agent-x-t1", t3Path: "/workspace/repo", cwd: "/tmp", command: "pwd -P; echo \"it's $((1+1))\"" });
    expect(wrapper).not.toContain("mount");
    const ran = spawnSync("bash", ["-c", wrapper], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim().split("\n").at(-1)).toBe("it's 2");
  });
});
