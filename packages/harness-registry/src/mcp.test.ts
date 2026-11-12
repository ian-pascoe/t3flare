// The MCP rules every caller shares (ADR-0028, plan §3.3): `decideCall` for a call's class and the thread's modes;
// `classOf`, a tool's class from the owner's override or its own `readOnlyHint`; tool names. Linked threads follow their
// own mode, and there are no hash pins (owner, 2026-11-12, back to stock).
import { describe, expect, it } from "vitest";

import { classOf, decideCall, mcpToolName, toolNamesOf } from "./mcp.ts";

describe("decideCall", () => {
  const thread = { accepted: false, interaction: "default" } as const;

  it("runs reads in every mode, plan included", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) expect(decideCall({ ...thread, class: "read", mode })).toEqual({ kind: "run" });
    expect(decideCall({ ...thread, class: "read", mode: "full-access", interaction: "plan" })).toEqual({ kind: "run" });
  });

  it("refuses writes in plan mode", () => {
    expect(decideCall({ ...thread, class: "write", mode: "full-access", interaction: "plan" }).kind).toBe("refuse");
  });

  it("a write asks unless full access or accepted for the session", () => {
    expect(decideCall({ ...thread, class: "write", mode: "approval-required" })).toEqual({ kind: "ask" });
    expect(decideCall({ ...thread, class: "write", mode: "auto-accept-edits" })).toEqual({ kind: "ask" });
    expect(decideCall({ ...thread, class: "write", mode: "full-access" })).toEqual({ kind: "run" });
    expect(decideCall({ ...thread, class: "write", mode: "approval-required", accepted: true })).toEqual({ kind: "run" });
  });
});

describe("classOf", () => {
  const tool = (readOnlyHint?: unknown) => (readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } });

  it("trusts the tool's own readOnlyHint: true is read, anything else write", () => {
    expect(classOf(tool(true), undefined)).toBe("read");
    expect(classOf(tool(false), undefined)).toBe("write");
    expect(classOf(tool("true"), undefined)).toBe("write");
    expect(classOf(tool(), undefined)).toBe("write");
  });

  it("the owner's override wins over the hint, either way", () => {
    expect(classOf(tool(true), "write")).toBe("write");
    expect(classOf(tool(), "read")).toBe("read");
  });
});

describe("tool names", () => {
  it("names a server's tool mcp__<server>__<tool>, sanitised, and refuses names that collide or are too long", () => {
    expect(mcpToolName("fixture", "fixture_echo")).toBe("mcp__fixture__fixture_echo");
    expect(mcpToolName("fixture", "a.b-c")).toBe("mcp__fixture__a_b_c");
    const named = toolNamesOf("fixture", ["a.b", "a_b", "ok", "x".repeat(60)]);
    expect(named.names).toEqual({ ok: "mcp__fixture__ok" });
    expect(named.refused.map((r) => r.tool).sort()).toEqual(["a.b", "a_b", "x".repeat(60)].sort());
  });
});
