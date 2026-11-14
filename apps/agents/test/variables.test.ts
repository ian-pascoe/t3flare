// Where the Variables reach a command (SPI-1152, ADR-0032's Variables refinement): one function builds a command's
// environment with the Variables as its lowest layer (`commandEnv`), and the Workspace's backends add them under every
// command computer runs (`VariablesBackend`), read when the command is sent, so a Container started since takes its own.
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { describe, expect, it } from "vitest";

import { commandEnv, VariablesBackend } from "../src/workspace/variables.ts";

describe("commandEnv", () => {
  it("puts the Variables under everything else: COMMAND_ENV, a CLI profile's environment, t3's own variables", () => {
    const variables = { NODE_ENV: "development", LOG_LEVEL: "debug", MISE_YES: "0", T3CODE_THREAD_ID: "variable", CODEX_HOME: "/elsewhere" };
    const env = commandEnv(variables, { ...COMMAND_ENV, T3CODE_THREAD_ID: "t1" }, { CODEX_HOME: "/var/lib/t3flare/cli/k1/codex", LOG_LEVEL: "info" });
    // Every COMMAND_ENV name as COMMAND_ENV has it (its mise configs and guards, SPI-1150), the Variable's MISE_YES lost.
    expect(env).toEqual({ ...COMMAND_ENV, NODE_ENV: "development", LOG_LEVEL: "info", T3CODE_THREAD_ID: "t1", CODEX_HOME: "/var/lib/t3flare/cli/k1/codex" });
    expect(env.MISE_YES).toBe("1");
  });

  it("is the layers alone without Variables", () => {
    expect(commandEnv({}, { A: "1" }, undefined, { B: "2" })).toEqual({ A: "1", B: "2" });
  });
});

/** A backend as computer's: its handle's shell records what each command was sent with. */
const fakeBackend = () => {
  const sent: Array<Record<string, unknown>> = [];
  const calls: Array<string> = [];
  const shell = {
    exec: async (input: Record<string, unknown>) => {
      sent.push(input);
      return { id: String(input.id), events: new ReadableStream() };
    },
    getExec: async (input: { id: string }) => {
      calls.push(`getExec ${input.id}`);
      return { id: input.id, events: new ReadableStream() };
    },
    killExec: async (input: { id: string }) => void calls.push(`killExec ${input.id}`),
    disposeExec: async (input: { id: string }) => void calls.push(`disposeExec ${input.id}`),
  };
  const sync = { marker: "sync" };
  const close = async () => void calls.push("close");
  const backend = {
    id: "container-shell",
    type: "container",
    description: "the Container",
    connect: async () => ({ rpc: { sync, shell }, runtimeId: "r1", ignore: { patterns: ["/node_modules"], root: "/workspace", supported: true }, close }),
  };
  return { backend, sent, calls, sync };
};

describe("VariablesBackend", () => {
  it("sends every command with the Variables under its own environment, read when it is sent", async () => {
    const fake = fakeBackend();
    let variables: Readonly<Record<string, string>> = { NODE_ENV: "test", MISE_YES: "0" };
    // SAFETY: the fake implements the members of computer's backend the wrapper uses.
    const wrapped = new VariablesBackend(fake.backend as never, () => variables);
    expect([wrapped.id, wrapped.type, wrapped.description]).toEqual(["container-shell", "container", "the Container"]);
    const handle = await wrapped.connect({} as never);
    await handle.rpc.shell.exec({ source: "env", id: "e1", env: { ...COMMAND_ENV, T3FLARE_EXEC: "e1" } });
    variables = { NODE_ENV: "production" };
    await handle.rpc.shell.exec({ source: "env", id: "e2" });
    expect(fake.sent).toEqual([
      { source: "env", id: "e1", env: { NODE_ENV: "test", ...COMMAND_ENV, T3FLARE_EXEC: "e1" } },
      { source: "env", id: "e2", env: { NODE_ENV: "production" } },
    ]);
  });

  it("leaves the rest of the handle as computer's backend made it", async () => {
    const fake = fakeBackend();
    // SAFETY: as above.
    const handle = await new VariablesBackend(fake.backend as never, () => ({ A: "1" })).connect({} as never);
    expect(handle.rpc.sync).toBe(fake.sync);
    expect([handle.runtimeId, handle.ignore]).toEqual(["r1", { patterns: ["/node_modules"], root: "/workspace", supported: true }]);
    await handle.rpc.shell.getExec({ id: "e1" });
    await handle.rpc.shell.killExec({ id: "e1" });
    await handle.rpc.shell.disposeExec({ id: "e1" });
    await handle.close();
    expect(fake.calls).toEqual(["getExec e1", "killExec e1", "disposeExec e1", "close"]);
  });
});
