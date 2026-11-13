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

// Only what exec.ts takes from computer (its module loads `cloudflare:` URLs Node cannot).
vi.mock("@cloudflare/computer", () => ({
  shellQuote: (word: string) => `'${word.replaceAll("'", "'\\''")}'`,
  getWorkspace: () => ({
    runtime: {
      exec: () => Promise.reject(refused()),
      killExec: () => Promise.resolve(),
    },
    [Symbol.dispose]: () => undefined,
  }),
}));

const { exec } = await import("./exec.ts");

describe("exec", () => {
  it("shows a refused Container start as the budget's whole refusal", async () => {
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
});
