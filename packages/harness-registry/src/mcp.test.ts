// The MCP rules every caller shares (ADR-0028, plan §3.3 with review H3, M10, M13): `decideCall` for a call's class, the
// thread's modes and whether it is linked; `classOf`, a tool's class pinned by its definition hash; tool names.
import { describe, expect, it } from "vitest";

import { classOf, decideCall, mcpToolName, strictestMode, toolNamesOf } from "./mcp.ts";

describe("decideCall", () => {
  const owner = { linked: false, accepted: false, interaction: "default" } as const;

  it("runs reads in every mode, linked or not, plan included", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      for (const linked of [false, true]) expect(decideCall({ ...owner, class: "read", mode, linked })).toEqual({ kind: "run" });
    }
    expect(decideCall({ ...owner, class: "read", mode: "full-access", interaction: "plan" })).toEqual({ kind: "run" });
  });

  it("refuses writes in plan mode", () => {
    expect(decideCall({ ...owner, class: "write", mode: "full-access", interaction: "plan" }).kind).toBe("refuse");
  });

  it("an owner thread's write asks unless full access or accepted for the session, and may be accepted for it", () => {
    expect(decideCall({ ...owner, class: "write", mode: "approval-required" })).toEqual({ kind: "ask", perCall: false });
    expect(decideCall({ ...owner, class: "write", mode: "auto-accept-edits" })).toEqual({ kind: "ask", perCall: false });
    expect(decideCall({ ...owner, class: "write", mode: "full-access" })).toEqual({ kind: "run" });
    expect(decideCall({ ...owner, class: "write", mode: "approval-required", accepted: true })).toEqual({ kind: "run" });
  });

  it("a linked thread's write asks every call, in full access and after an acceptance (linked before accepted)", () => {
    expect(decideCall({ ...owner, class: "write", mode: "full-access", linked: true })).toEqual({ kind: "ask", perCall: true });
    expect(decideCall({ ...owner, class: "write", mode: "approval-required", linked: true, accepted: true })).toEqual({ kind: "ask", perCall: true });
  });
});

describe("classOf (review H3)", () => {
  const tool = (readOnlyHint?: boolean) => ({ name: "note", hash: "h1", ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }) });

  it("a Commissary tool first seen takes its hint; a direct server's is write until the owner marks it read", () => {
    expect(classOf("commissary", tool(true), undefined)).toEqual({ class: "read", pin: { class: "read", hash: "h1", by: "hint" } });
    expect(classOf("commissary", tool(), undefined)).toEqual({ class: "write", pin: { class: "write", hash: "h1", by: "hint" } });
    expect(classOf("direct", tool(true), undefined)).toEqual({ class: "write", suggested: "read" });
  });

  it("keeps the pinned class while the definition is the same", () => {
    expect(classOf("direct", tool(), { class: "read", hash: "h1", by: "owner" })).toEqual({ class: "read" });
    expect(classOf("commissary", tool(true), { class: "write", hash: "h1", by: "owner" })).toEqual({ class: "write" });
  });

  it("a changed definition is write until the owner confirms, whatever its hint says", () => {
    const changed = { ...tool(true), hash: "h2" };
    expect(classOf("commissary", changed, { class: "read", hash: "h1", by: "hint" })).toEqual({ class: "write", unconfirmed: true, suggested: "read" });
    expect(classOf("direct", changed, { class: "read", hash: "h1", by: "owner" })).toEqual({ class: "write", unconfirmed: true, suggested: "read" });
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

describe("strictestMode (review M7)", () => {
  it("takes the strictest runtime mode, plan over everything, unknown as approval-required", () => {
    expect(strictestMode([{ runtimeMode: "full-access", interactionMode: "default" }])).toEqual({ mode: "full-access", interaction: "default" });
    expect(strictestMode([{ runtimeMode: "full-access", interactionMode: "default" }, { runtimeMode: "auto-accept-edits", interactionMode: "default" }])).toEqual({ mode: "auto-accept-edits", interaction: "default" });
    expect(strictestMode([{ runtimeMode: "full-access", interactionMode: "default" }, { runtimeMode: "auto", interactionMode: "default" }])).toEqual({ mode: "approval-required", interaction: "default" });
    expect(strictestMode([{ runtimeMode: "full-access", interactionMode: "plan" }, { runtimeMode: "full-access", interactionMode: "default" }])).toEqual({ mode: "full-access", interaction: "plan" });
    expect(strictestMode([])).toEqual({ mode: "approval-required", interaction: "default" });
  });
});
