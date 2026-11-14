// @effect-diagnostics globalTimers:off
// A Durable agent's command whose Container start was refused (ADR-0032 §7): the agent is shown the Container budget's
// whole refusal (the budget and where to change it), not computer's wrapper, which cuts the reason short.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";

const REASON = "Container budget (1) reached: raise it at /_t3flare/harness#environment";

/** The error a refused start rejects with, as computer wraps it after a Container exited before (met on stage). */
const refused = () => {
  const inner = new Error(`t3flare: the Container cannot start: ${REASON}`);
  const backend = new Error(`ContainerBackend(container-shell): connect failed at stage=start priorExit="Container exited with unexpected ex lastError=t3flare: the Container cannot start: Container budget (1`, { cause: inner });
  return new Error("WorkspaceTransportError: shell.exec failed after 1 reconnect retry", { cause: backend });
};

/** What the fake computer does: its `runtime.exec` and `killExec`, set per test. */
const fake = vi.hoisted(() => ({
  exec: (() => Promise.reject(new Error("unset"))) as (...args: Array<unknown>) => Promise<unknown>,
  killExec: (_id: string) => Promise.resolve(),
}));

// Only what exec.ts takes from computer (its module loads `cloudflare:` URLs Node cannot).
vi.mock("@cloudflare/computer", () => ({
  shellQuote: (word: string) => `'${word.replaceAll("'", "'\\''")}'`,
  getWorkspace: () => ({
    runtime: {
      exec: (...args: Array<unknown>) => fake.exec(...args),
      killExec: (id: string) => fake.killExec(id),
    },
    [Symbol.dispose]: () => undefined,
  }),
}));

const { exec } = await import("./exec.ts");

describe("exec", () => {
  it("shows a refused Container start as the budget's whole refusal", async () => {
    fake.exec = () => Promise.reject(refused());
    const result = await exec(
      { workspace: {} as never, backend: undefined, cwd: "/workspace/repo", spill: async () => undefined, running: new Set() },
      "true",
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe(`t3flare: the Container cannot start: ${REASON}`);
  });

  /**
   * A command whose Container is still starting (its connect, and the Global mise config's install with it) when its
   * timeout fires: computer dispatches it once the connect returns, after the kill loop has given up. It is killed then.
   */
  const lateStart = (dispatchAfterMs: number) => {
    const order: Array<string> = [];
    let killed = false;
    fake.killExec = async (id: string) => {
      order.push(`kill ${id === "" ? "?" : "id"} ${dispatched ? "after" : "before"} dispatch`);
      killed = dispatched;
    };
    let dispatched = false;
    fake.exec = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          dispatched = true;
          order.push("dispatched");
          resolve({
            async *[Symbol.asyncIterator]() {
              while (!killed) await new Promise((wake) => setTimeout(wake, 5));
              yield { name: "exit", code: 137 };
            },
            [Symbol.dispose]: () => undefined,
          });
        }, dispatchAfterMs),
      );
    return order;
  };

  it("kills a command that timed out before it started as soon as it is dispatched, and hands it to the ledger again", async () => {
    const order = lateStart(800);
    const ledger = { started: vi.fn(), ended: vi.fn(), stopped: vi.fn() };
    const result = await exec({ workspace: {} as never, backend: undefined, cwd: "/workspace/repo", spill: async () => undefined, running: new Set(), ledger }, "sleep 100", { timeout: 0.05 }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Command timed out before it started (the Container was starting)");
    expect(ledger.stopped).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(order).toContain("kill id after dispatch"), { timeout: 3_000 });
    expect(ledger.stopped).toHaveBeenCalledTimes(2);
    expect(ledger.ended).not.toHaveBeenCalled();
  });

  it("names the Global mise config's install when the Workspace says one ran while the command waited", async () => {
    lateStart(300);
    const output: Array<string> = [];
    const result = await exec(
      { workspace: {} as never, backend: undefined, cwd: "/workspace/repo", spill: async () => undefined, running: new Set(), startingNote: async () => "installing the Global mise config" },
      "node --version",
      { timeout: 0.05, onOutput: (text) => void output.push(text) },
      BACKGROUND_CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Command timed out before it started (the Container was installing the Global mise config)");
    // In the output too: pi-durable's bash replaces a timeout's message with its own and keeps the output.
    expect(output).toEqual(["t3flare: the command did not start: the Container was installing the Global mise config\n"]);
  });
});
