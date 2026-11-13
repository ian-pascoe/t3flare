// A refused Container start's reason, whole (ADR-0032 §7), however computer cut its own messages around it.
import { describe, expect, it } from "vitest";

import { describeFailure, startRefusal } from "./startRefusal.ts";

const REASON = "Container budget (1) reached: raise it at /_t3flare/harness#environment";

/** The error a refused start throws, as computer wraps it after a Container exited before (the case met on stage). */
const wrapped = () => {
  const inner = new Error(`t3flare: the Container cannot start: ${REASON}`);
  const backend = new Error(`ContainerBackend(container-shell): connect failed at stage=start priorExit="Container exited with unexpected ex lastError=t3flare: the Container cannot start: Container budget (1`, { cause: inner });
  return new Error("WorkspaceTransportError: shell.exec failed after 1 reconnect retry", { cause: backend });
};

describe("startRefusal", () => {
  it("finds the whole reason in the cause chain when computer's own message is cut", () => {
    expect(startRefusal(wrapped())).toBe(REASON);
  });

  it("reads the reason from a message or a plain string when there is no cause", () => {
    expect(startRefusal(new Error(`x lastError=t3flare: the Container cannot start: ${REASON}`))).toBe(REASON);
    expect(startRefusal(`clone: t3flare: the Container cannot start: ${REASON}`)).toBe(REASON);
  });

  it("answers undefined for another failure, and stops on a cycle", () => {
    expect(startRefusal(new Error("connect timed out", { cause: new Error("socket closed") }))).toBeUndefined();
    const cycle = new Error("a");
    (cycle as { cause?: unknown }).cause = cycle;
    expect(startRefusal(cycle)).toBeUndefined();
  });
});

describe("describeFailure", () => {
  it("shows a refused start as the whole refusal: the budget and where to change it", () => {
    expect(describeFailure(wrapped())).toBe(`t3flare: the Container cannot start: ${REASON}`);
  });

  it("shows any other failure as it is", () => {
    expect(describeFailure(new Error("disk full"))).toBe("Error: disk full");
  });
});
