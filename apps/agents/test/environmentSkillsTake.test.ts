// @effect-diagnostics globalTimers:off
// A turn takes the Environment skill set (SPI-1148, plan §4.2): only with a hash and a Workspace, bounded, and never
// failing the turn: a Workspace that predates the call, refuses the set or does not answer in time leaves it as it was.
import { describe, expect, it, vi } from "vitest";

import { takeSkillsForTurn } from "../src/session/environmentSkills.ts";

describe("takeSkillsForTurn", () => {
  it("asks nothing without a hash (an adapter that carries none) or without a Workspace", async () => {
    const taker = { takeEnvironmentSkills: vi.fn() };
    expect(await takeSkillsForTurn(undefined, taker)).toBeUndefined();
    expect(await takeSkillsForTurn("h", undefined)).toBeUndefined();
    expect(taker.takeEnvironmentSkills).not.toHaveBeenCalled();
  });

  it("answers what the Workspace took", async () => {
    const answer = { taken: true, hash: "h2", container: "stopped" as const };
    expect(await takeSkillsForTurn("h2", { takeEnvironmentSkills: async () => answer })).toEqual(answer);
  });

  it("keeps going when the Workspace refuses, fails or predates the call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await takeSkillsForTurn("h", { takeEnvironmentSkills: async () => ({ taken: false, hash: "h0", error: "refused" }) })).toEqual({ taken: false, hash: "h0", error: "refused" });
    expect(await takeSkillsForTurn("h", { takeEnvironmentSkills: () => Promise.reject(new TypeError("The RPC receiver does not implement the method \"takeEnvironmentSkills\".")) })).toBe("failed");
  });

  it("stops waiting at its bound", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await takeSkillsForTurn("h", { takeEnvironmentSkills: () => new Promise(() => undefined) }, 20)).toBe("timeout");
  });
});
