// @effect-diagnostics globalConsole:off
// A sign-out stops the endpoint's Sessions (SPI-1164): every open Session drops the endpoint's token, and the Sessions
// whose model is on the endpoint have their running turns stopped; a Session that does not answer is skipped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetSessionModel, noteSessionModel, stopSessionsOn } from "../src/endpoints/sessions.ts";

beforeEach(() => {
  for (const level of ["log", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("stopping a signed-out endpoint's Sessions", () => {
  it("tells every open Session, and stops the turns of those on the endpoint", async () => {
    const calls: Array<string> = [];
    noteSessionModel("on-chatgpt", "chatgpt");
    noteSessionModel("on-proxy", "anthropic");
    noteSessionModel("closed", "chatgpt");
    forgetSessionModel("closed");
    const result = await stopSessionsOn("chatgpt", {
      open: () => ["on-chatgpt", "on-proxy", "never-ran", "down"],
      session: (name) => ({
        endpointSignedOut: async ({ endpointId }) => {
          if (name === "down") throw new Error("unreachable");
          calls.push(`${name} drop ${endpointId}`);
        },
        abort: async ({ reason }) => void calls.push(`${name} abort ${reason}`),
      }),
    });
    expect(result).toEqual({ told: 3, stopped: 1 });
    expect(calls.sort()).toEqual(["never-ran drop chatgpt", "on-chatgpt abort signed_out", "on-chatgpt drop chatgpt", "on-proxy drop chatgpt"]);
  });
});
