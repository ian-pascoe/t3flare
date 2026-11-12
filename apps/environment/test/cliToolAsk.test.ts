// The relay's tool cards on a CLI thread (ADR-0028, review M9): the push asker generalised with its own perCall flag;
// a tool card never offers the push card's trust answer, and a linked or per-call card offers no "for the session".
import { describe, expect, it } from "vitest";

import { approveCliTool, type CliPushAsk, cliThreadStates, registerCliPushAsker } from "../src/provider/cli/linkedPushAsk.ts";

const register = (thread: string, linked: boolean, decision: "accept" | "acceptForSession" | "decline") => {
  const asked: Array<CliPushAsk> = [];
  const unregister = registerCliPushAsker(thread, {
    linked,
    ask: async (ask) => {
      asked.push(ask);
      return decision === "decline" ? { approved: false, reason: "decline" } : { approved: true, trust: decision === "acceptForSession" };
    },
    state: () => ({ runtimeMode: "approval-required", interactionMode: "default", workspace: "ws-1" }),
  });
  return { asked, unregister };
};

const ask = (thread: string, extra: Partial<Parameters<typeof approveCliTool>[0]> = {}) =>
  approveCliTool({ thread, linked: false, perCall: false, askId: "a", title: "Allow commissary: fixture_note?", summary: "s", detail: "d", ...extra });

describe("tool cards on a CLI thread", () => {
  it("raise a permission card titled for the tool; 'for the session' is offered and kept for an owner", async () => {
    const r = register("t-owner", false, "acceptForSession");
    expect(await ask("t-owner")).toEqual({ approved: true, forSession: true });
    expect(r.asked[0]).toMatchObject({ title: "Allow commissary: fixture_note?", requestKind: "permission" });
    expect(r.asked[0]!.options.map((option) => option.decision)).toEqual(["accept", "acceptForSession", "decline"]);
    expect(r.asked[0]!.options.some((option) => /trust/i.test(option.label))).toBe(false);
    r.unregister();
  });

  it("offer this call only for a per-call ask, and never keep 'for the session'", async () => {
    const r = register("t-taint", false, "acceptForSession");
    expect(await ask("t-taint", { perCall: true })).toEqual({ approved: true, forSession: false });
    expect(r.asked[0]!.options.map((option) => option.decision)).toEqual(["accept", "decline"]);
    r.unregister();
  });

  it("treat a linked thread's every ask as per call, and refuse a linked caller on an owner's turn", async () => {
    const linked = register("t-linked", true, "acceptForSession");
    expect(await ask("t-linked", { linked: true })).toEqual({ approved: true, forSession: false });
    linked.unregister();
    const owner = register("t-owner2", false, "accept");
    expect(await ask("t-owner2", { linked: true })).toEqual({ approved: false, reason: "not linked work" });
    expect(owner.asked).toEqual([]);
    owner.unregister();
  });

  it("refuse without a live turn, and report a decline", async () => {
    expect(await ask("t-none")).toMatchObject({ approved: false });
    const r = register("t-decline", false, "decline");
    expect(await ask("t-decline")).toEqual({ approved: false, reason: "decline" });
    r.unregister();
  });

  it("give the relay the live threads' modes", () => {
    const r = register("t-mode", false, "accept");
    expect(cliThreadStates(["t-mode", "t-gone"])).toEqual([{ thread: "t-mode", runtimeMode: "approval-required", interactionMode: "default", workspace: "ws-1" }]);
    r.unregister();
  });
});
