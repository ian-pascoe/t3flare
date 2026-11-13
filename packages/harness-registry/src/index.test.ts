// The harness registry's seam (ADR-0026): what a Session gets from the stored settings (`resolveHarness`), and what the
// panel may store (`applyChange`): defaults, validation against each entry's schema, locked entries, the revision, and
// cloudpid ADR-0027's merge (keyed settings merged key by key, lists replaced whole) for the later per-Project overrides.
import { describe, expect, it } from "vitest";

import { applyChange, EMPTY_HARNESS, extensionOf, EXTENSIONS, resolveHarness } from "./index.ts";

describe("resolveHarness", () => {
  it("gives the defaults for empty settings: code mode on, tool search on, the core preset offered", () => {
    const resolved = resolveHarness(EMPTY_HARNESS);
    expect(resolved.revision).toBe(0);
    expect(resolved.codemode).toEqual({ enabled: true, inlineBudget: 2000 });
    expect(resolved.toolSearch).toEqual({ enabled: true });
    expect(resolved.offered).toEqual([
      "read", "edit", "write", "bash", "ls", "find", "grep", "ask_user", "codemode", "tool_search", "mcp__t3-code__*", "web_fetch", "web_search", "todo", "context_notes", "context_history", "context_rollover", "terminal_start", "terminal_send", "terminal_stop", "terminal_list", "terminal_wait",
    ]);
  });

  it("has the web tools on with web_search off (a search costs a model request), and the search model switchable (SPI-1054)", () => {
    expect(resolveHarness(EMPTY_HARNESS).extensions.web).toEqual({ enabled: true, settings: { search: false, searchModel: "claude-haiku-5-5" } });
    const on = applyChange(EMPTY_HARNESS, { extension: "web", settings: { search: true, searchModel: "claude-sonnet-5-5" } });
    if (!on.ok) throw new Error(on.error);
    expect(resolveHarness(on.harness).extensions.web).toEqual({ enabled: true, settings: { search: true, searchModel: "claude-sonnet-5-5" } });
    expect(applyChange(EMPTY_HARNESS, { extension: "web", settings: { searchModel: "gpt-9" } })).toMatchObject({ ok: false });
  });

  it("has Terminals on with bash's background jobs and a 120x40 viewport (SPI-1057): nothing starts a container until used", () => {
    expect(resolveHarness(EMPTY_HARNESS).extensions.termctrl).toEqual({ enabled: true, settings: { backgroundBash: true, cols: 120, rows: 40 } });
    expect(applyChange(EMPTY_HARNESS, { extension: "termctrl", settings: { cols: 10 } })).toMatchObject({ ok: false });
  });

  it("has the Guardian off (each review is a model request), with Haiku, no thinking, and text rules (SPI-1058)", () => {
    expect(resolveHarness(EMPTY_HARNESS).extensions.guardian).toEqual({ enabled: false, settings: { model: "claude-haiku-5-5", thinkingLevel: "off", tools: "", commands: "", policy: "" } });
    const on = applyChange(EMPTY_HARNESS, { extension: "guardian", enabled: true, settings: { tools: "bash=review", policy: "Never touch prod." } });
    if (!on.ok) throw new Error(on.error);
    expect(resolveHarness(on.harness).extensions.guardian).toMatchObject({ enabled: true, settings: { tools: "bash=review", policy: "Never touch prod." } });
    expect(applyChange(EMPTY_HARNESS, { extension: "guardian", settings: { commands: "x".repeat(4_001) } })).toMatchObject({ ok: false });
    expect(applyChange(EMPTY_HARNESS, { extension: "guardian", settings: { commands: 3 } })).toMatchObject({ ok: false });
  });

  it("gives an extension's defaults to a Session whose resolved view predates the entry", () => {
    const { web: _web, ...older } = resolveHarness(EMPTY_HARNESS).extensions;
    const taken = { ...resolveHarness(EMPTY_HARNESS), extensions: older };
    expect(extensionOf(taken, "web")).toEqual({ enabled: true, settings: { search: false, searchModel: "claude-haiku-5-5" } });
    expect(extensionOf(taken, "nope")).toEqual({ enabled: false, settings: {} });
  });

  it("offers everything when tool search is off, since nothing could load a deferred tool", () => {
    const stored = applyChange(EMPTY_HARNESS, { extension: "tool-search", enabled: false });
    if (!stored.ok) throw new Error(stored.error);
    expect(resolveHarness(stored.harness).offered).toEqual(["*"]);
  });

  it("applies a Project's override over Global, key by key", () => {
    const global = applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { inlineBudget: 4000 } });
    if (!global.ok) throw new Error(global.error);
    const harness = { ...global.harness, overrides: { p1: { extensions: { codemode: { enabled: false } } } } };
    expect(resolveHarness(harness, { projectId: "p1" }).codemode).toEqual({ enabled: false, inlineBudget: 4000 });
    expect(resolveHarness(harness, { projectId: "p2" }).codemode).toEqual({ enabled: true, inlineBudget: 4000 });
  });
});

describe("applyChange", () => {
  it("stores a valid change and bumps the revision", () => {
    const changed = applyChange(EMPTY_HARNESS, { extension: "offered-tools", settings: { preset: "codemode-only" } });
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.harness.revision).toBe(1);
    expect(resolveHarness(changed.harness).offered).toEqual(["codemode", "tool_search"]);
  });

  it("refuses a value outside the schema, an unknown setting, and an unknown extension", () => {
    expect(applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { inlineBudget: 10 } })).toEqual({ ok: false, error: "codemode.inlineBudget: at least 500" });
    expect(applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { inlineBudget: "big" } })).toEqual({ ok: false, error: "codemode.inlineBudget: an integer" });
    expect(applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { other: 1 } })).toEqual({ ok: false, error: "codemode.other: no such setting" });
    expect(applyChange(EMPTY_HARNESS, { extension: "offered-tools", settings: { preset: "all" } })).toEqual({
      ok: false,
      error: "offered-tools.preset: one of core, codemode-only, everything",
    });
    expect(applyChange(EMPTY_HARNESS, { extension: "nope", enabled: true })).toEqual({ ok: false, error: "nope: no such extension" });
  });

  it("refuses to change a locked extension: permissions can never be turned off", () => {
    const permissions = EXTENSIONS.find((entry) => entry.id === "permissions");
    expect(permissions?.locked).toBeDefined();
    expect(applyChange(EMPTY_HARNESS, { extension: "permissions", enabled: false })).toEqual({ ok: false, error: `permissions: locked (${permissions?.locked})` });
  });

  it("refuses to turn an extension without a switch on or off", () => {
    expect(applyChange(EMPTY_HARNESS, { extension: "offered-tools", enabled: false })).toEqual({ ok: false, error: "offered-tools: cannot be turned off" });
  });
});
