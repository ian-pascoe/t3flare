// @effect-diagnostics globalConsole:off
// A sign-out stops the endpoint's Sessions (SPI-1164): every open Session is told; each drops the endpoint's token and
// stops its turns when they run on the endpoint (its own storage decides, agents' signOut.test.ts); a Session that does
// not answer is skipped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopSessionsOn } from "../src/endpoints/sessions.ts";

beforeEach(() => {
  for (const level of ["log", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("stopping a signed-out endpoint's Sessions", () => {
  it("tells every open Session and counts those that stopped turns", async () => {
    const told: Array<string> = [];
    const result = await stopSessionsOn("chatgpt", {
      open: () => ["on-chatgpt", "on-proxy", "down"],
      session: (name) => ({
        endpointSignedOut: async ({ endpointId }) => {
          if (name === "down") throw new Error("unreachable");
          told.push(`${name} ${endpointId}`);
          return { dropped: true, stopped: name === "on-chatgpt" };
        },
      }),
    });
    expect(result).toEqual({ told: 2, stopped: 1 });
    expect(told.sort()).toEqual(["on-chatgpt chatgpt", "on-proxy chatgpt"]);
  });
});
