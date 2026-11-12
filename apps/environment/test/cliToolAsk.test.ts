// The relay's tool cards on a CLI thread (ADR-0028, review M9): the push asker generalised; a tool card never offers the
// push card's trust answer. Linked threads are asked as any thread (owner, 2026-11-12, back to stock).
import { describe, expect, it } from "vitest";

import { approveCliTool, type CliPushAsk, cliThreadState, registerCliPushAsker } from "../src/provider/cli/linkedPushAsk.ts";

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
  approveCliTool({ thread, askId: "a", title: "Allow commissary: fixture_note?", summary: "s", detail: "d", ...extra });

describe("tool cards on a CLI thread", () => {
  it("raise a permission card titled for the tool; 'for the session' is offered and kept for an owner", async () => {
    const r = register("t-owner", false, "acceptForSession");
    expect(await ask("t-owner")).toEqual({ approved: true, forSession: true });
    expect(r.asked[0]).toMatchObject({ title: "Allow commissary: fixture_note?", requestKind: "permission" });
    expect(r.asked[0]!.options.map((option) => option.decision)).toEqual(["accept", "acceptForSession", "decline"]);
    expect(r.asked[0]!.options.some((option) => /trust/i.test(option.label))).toBe(false);
    r.unregister();
  });

  it("ask a linked thread as any thread: 'for the session' offered and kept", async () => {
    const linked = register("t-linked", true, "acceptForSession");
    expect(await ask("t-linked")).toEqual({ approved: true, forSession: true });
    expect(linked.asked[0]).toMatchObject({ linked: true });
    expect(linked.asked[0]!.options.map((option) => option.decision)).toEqual(["accept", "acceptForSession", "decline"]);
    linked.unregister();
  });

  it("refuse without a live turn, and report a decline", async () => {
    expect(await ask("t-none")).toMatchObject({ approved: false });
    const r = register("t-decline", false, "decline");
    expect(await ask("t-decline")).toEqual({ approved: false, reason: "decline" });
    r.unregister();
  });

  it("give the relay the calling thread's modes (none without a live turn)", () => {
    const r = register("t-mode", false, "accept");
    expect(cliThreadState("t-mode")).toEqual({ runtimeMode: "approval-required", interactionMode: "default", workspace: "ws-1" });
    expect(cliThreadState("t-gone")).toBeUndefined();
    r.unregister();
  });
});
