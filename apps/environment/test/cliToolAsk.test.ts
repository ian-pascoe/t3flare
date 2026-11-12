// The relay's tool cards on a CLI thread (ADR-0028, review M9). Linked threads are asked as any thread (owner,
// 2026-11-12, back to stock).
import { describe, expect, it } from "vitest";

import { approveCliTool, type CliAsk, cliThreadState, registerCliAsker } from "../src/provider/cli/cliAsk.ts";

const register = (thread: string, decision: "accept" | "acceptForSession" | "decline") => {
  const asked: Array<CliAsk> = [];
  const unregister = registerCliAsker(thread, {
    ask: async (ask) => {
      asked.push(ask);
      return decision === "decline" ? { approved: false, reason: "decline" } : { approved: true, forSession: decision === "acceptForSession" };
    },
    state: () => ({ runtimeMode: "approval-required", interactionMode: "default", workspace: "ws-1" }),
  });
  return { asked, unregister };
};

const ask = (thread: string, extra: Partial<Parameters<typeof approveCliTool>[0]> = {}) =>
  approveCliTool({ thread, askId: "a", title: "Allow commissary: fixture_note?", summary: "s", detail: "d", ...extra });

describe("tool cards on a CLI thread", () => {
  it("raise a permission card titled for the tool; 'for the session' is offered and kept", async () => {
    const r = register("t-owner", "acceptForSession");
    expect(await ask("t-owner")).toEqual({ approved: true, forSession: true });
    expect(r.asked[0]).toMatchObject({ title: "Allow commissary: fixture_note?", requestKind: "permission" });
    expect(r.asked[0]!.options.map((option) => option.decision)).toEqual(["accept", "acceptForSession", "decline"]);
    r.unregister();
  });

  it("refuse without a live turn, and report a decline", async () => {
    expect(await ask("t-none")).toMatchObject({ approved: false });
    const r = register("t-decline", "decline");
    expect(await ask("t-decline")).toEqual({ approved: false, reason: "decline" });
    r.unregister();
  });

  it("give the relay the calling thread's modes (none without a live turn)", () => {
    const r = register("t-mode", "accept");
    expect(cliThreadState("t-mode")).toEqual({ runtimeMode: "approval-required", interactionMode: "default", workspace: "ws-1" });
    expect(cliThreadState("t-gone")).toBeUndefined();
    r.unregister();
  });
});
