// A refused Container start's reason (SPI-1149): computer wraps the budget's refusal in its connect errors and cuts its
// own message at 240 characters, more when the Container exited before (`priorExit=`). The whole reason is the message of
// the innermost cause, which terminals and CLI agents are shown.
import { describe, expect, it } from "vitest";

import { startRefusal } from "../src/workspace/startRefusal.ts";

const REASON = "Container budget (1) reached: raise it at /_t3flare/harness#environment";

describe("startRefusal", () => {
  it("finds the whole reason in the cause chain when computer's own message is cut", () => {
    const inner = new Error(`t3flare: the Container cannot start: ${REASON}`);
    const backend = new Error(`ContainerBackend(container-shell): connect failed at stage=start priorExit="Container exited with unexpected ex lastError=t3flare: the Container cannot start: Container budget (1`, { cause: inner });
    const outer = new Error("WorkspaceTransportError: shell.exec failed after 1 reconnect retry", { cause: backend });
    expect(startRefusal(outer)).toBe(REASON);
  });

  it("reads the reason from the message when there is no cause", () => {
    expect(startRefusal(new Error(`x lastError=t3flare: the Container cannot start: ${REASON}`))).toBe(REASON);
  });

  it("answers undefined for another failure", () => {
    expect(startRefusal(new Error("connect timed out", { cause: new Error("socket closed") }))).toBeUndefined();
    expect(startRefusal("plain")).toBeUndefined();
  });
});
