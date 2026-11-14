// A command the Session stopped before it started is never sent (SPI-1150, ADR-0032's Global mise config refinement): computer
// dispatches it once the Container's connect (and the Global mise config's install) returns; the backend refuses it.
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import { STOPPED_REMEMBERED_MS, StoppedExecs, StoppedExecsBackend } from "../src/workspace/stoppedExecs.ts";

const inner = (sent: Array<string>): WorkspaceBackend =>
  ({
    id: "container-shell",
    type: "cloudflare-container",
    connect: async () =>
      ({
        rpc: {
          sync: {},
          shell: {
            exec: async (input: { env?: Record<string, string> }) => {
              sent.push(input.env?.T3FLARE_EXEC ?? "?");
              return {} as never;
            },
            getExec: async () => ({}) as never,
            killExec: async () => undefined,
            disposeExec: async () => undefined,
          },
        },
        close: async () => undefined,
      }) as unknown as BackendHandle,
  }) as WorkspaceBackend;

describe("StoppedExecsBackend", () => {
  it("refuses a command whose id was stopped, and sends the others", async () => {
    let now = 1_000;
    const stopped = new StoppedExecs(() => now);
    const sent: Array<string> = [];
    const handle = await new StoppedExecsBackend(inner(sent), stopped).connect({} as never);
    stopped.stopped(["exec-a"]);
    await expect(handle.rpc.shell.exec({ source: "touch x", env: { T3FLARE_EXEC: "exec-a" } } as never)).rejects.toThrow("stopped before it started");
    await handle.rpc.shell.exec({ source: "true", env: { T3FLARE_EXEC: "exec-b" } } as never);
    await handle.rpc.shell.exec({ source: "true" } as never);
    expect(sent).toEqual(["exec-b", "?"]);
    // Forgotten once older than any connect.
    now += STOPPED_REMEMBERED_MS + 1;
    stopped.stopped([]);
    await handle.rpc.shell.exec({ source: "touch x", env: { T3FLARE_EXEC: "exec-a" } } as never);
    expect(sent).toEqual(["exec-b", "?", "exec-a"]);
  });
});
