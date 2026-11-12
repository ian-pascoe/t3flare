// The `processGroup.ts` Shadow (step 4a): t3's `signalProcessGroup` on a process channel pid kills by marker through
// the channel, and signal 0 answers whether it still runs, as t3's pi `rpc.ts` reads it (`hasExited`).
import { describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { ProcessChannel, type ProcessRemote } from "../src/agents/processChannel.ts";
import { signalProcessGroup } from "../src/shadows/processGroup.ts";

describe("the processGroup Shadow", () => {
  it("signals a channel process by its pid, answers signal 0 from its state, and refuses pids it does not know", async () => {
    const signals: Array<string> = [];
    const remote: ProcessRemote = {
      processStart: async () => ({ ok: true, epoch: 1 }),
      processInput: async () => ({ epoch: 1, unknown: [], accepted: "written" }),
      processTurn: async () => ({ epoch: 1, unknown: [] }),
      processSignal: async (key) => {
        signals.push(key);
        return { epoch: 1, unknown: [] };
      },
      processHeartbeat: async () => ({ epoch: 1, unknown: [] }),
      processRead: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { epoch: 1, unknown: [], batch: 0, frames: [] };
      },
    };
    const processes = new ProcessChannel({ environmentEpoch: 1, place: () => ({ workspace: "demo", t3Path: "/w/demo", remote }), newKey: () => "proc-1" });
    bindEnvironmentServices({ processes } as unknown as EnvironmentServices);
    const process = await processes.start({ cli: "pi", cwd: "/w/demo", argv: ["/opt/t3flare/bin/pi"], env: {} });
    expect(() => signalProcessGroup(process.pid, 0)).not.toThrow();
    signalProcessGroup(process.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toEqual(["proc-1"]);
    process.finish(143);
    expect(() => signalProcessGroup(process.pid, 0)).toThrow(/ESRCH/);
    expect(() => signalProcessGroup(1, 0)).toThrow(/ESRCH/);
    expect(() => signalProcessGroup(123, "SIGKILL")).toThrow(/ESRCH/);
  });
});
