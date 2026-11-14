// The MCP rules every caller shares (ADR-0028, plan §3.3): `decideCall` for a call's class and the thread's modes;
// `classOf`, a tool's class from the owner's override or its own `readOnlyHint`; tool names. Linked threads follow their
// own mode, and there are no hash pins (owner, 2026-11-12, back to stock).
import { describe, expect, it } from "vitest";

import { applyMcpChange, EMPTY_HARNESS, ignoredServersOf, mcpServersOf, type StoredHarness } from "./index.ts";
import { classOf, decideCall, defaultSettingsServer, mcpToolName, toolNamesOf } from "./mcp.ts";

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

// The Settings server's entry (ADR-0034, plan D2): implied on every stage, its name reserved, its kind its own.
describe("the Settings server's entry", () => {
  it("is implied on, deferred and read-write until a change stores one", () => {
    expect(mcpServersOf(EMPTY_HARNESS).settings).toEqual({ kind: "settings", enabled: true, exposure: "deferred", writes: true });
    const off = applyMcpChange(EMPTY_HARNESS, { op: "server", server: "settings", enabled: true, writes: false });
    if (!off.ok) throw new Error(off.error);
    expect(mcpServersOf(off.harness).settings).toMatchObject({ kind: "settings", enabled: true, writes: false });
  });

  it("its name is reserved: no Direct server may be added as settings", () => {
    expect(applyMcpChange(EMPTY_HARNESS, { op: "add", server: "settings", url: "https://x.example/mcp", auth: { kind: "none" } })).toEqual({ ok: false, error: "settings: reserved" });
  });

  it("a Direct server stored as settings before the name was reserved is ignored, named, and dropped at the next change", () => {
    const stale: StoredHarness = { ...EMPTY_HARNESS, mcp: { servers: { settings: { kind: "direct", url: "https://x.example/mcp", auth: { kind: "none" }, enabled: true, exposure: "direct" } } } };
    expect(mcpServersOf(stale).settings).toEqual(defaultSettingsServer());
    expect(ignoredServersOf(stale)).toEqual(["settings"]);
    expect(ignoredServersOf(EMPTY_HARNESS)).toEqual([]);
    // A change to the set stores the Settings server's entry over it; its URL is gone from storage.
    const next = applyMcpChange(stale, { op: "server", server: "settings", enabled: true });
    if (!next.ok) throw new Error(next.error);
    expect(next.harness.mcp?.servers.settings).toEqual(defaultSettingsServer());
    expect(ignoredServersOf(next.harness)).toEqual([]);
    // An entry of kind settings under another name is not a second Settings server.
    const forged: StoredHarness = { ...EMPTY_HARNESS, mcp: { servers: { other: { kind: "settings", enabled: true, exposure: "direct" } } } };
    expect(mcpServersOf(forged).other).toBeUndefined();
    expect(ignoredServersOf(forged)).toEqual(["other"]);
  });

  it("cannot be removed, its classes are fixed, and only it has a writes switch", () => {
    expect(applyMcpChange(EMPTY_HARNESS, { op: "remove", server: "settings" })).toMatchObject({ ok: false });
    expect(applyMcpChange(EMPTY_HARNESS, { op: "class", server: "settings", tool: "change_mcp", class: "read" })).toMatchObject({ ok: false });
    // `commissary` is an ordinary name since SPI-1160: a Direct server under it has no writes switch.
    const added = applyMcpChange(EMPTY_HARNESS, { op: "add", server: "commissary", url: "https://x.example/mcp", auth: { kind: "none" } });
    if (!added.ok) throw new Error(added.error);
    expect(applyMcpChange(added.harness, { op: "server", server: "commissary", writes: false })).toEqual({ ok: false, error: "commissary: only the Settings server has a writes switch" });
  });
});
