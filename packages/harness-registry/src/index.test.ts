// The harness registry's seam (ADR-0026): what a Session gets from the stored settings (`resolveHarness`), and what the
// panel may store (`applyChange`): defaults, validation against each entry's schema, locked entries, the revision, and
// cloudpid ADR-0027's merge (keyed settings merged key by key, lists replaced whole) for the later per-Project overrides.
import { describe, expect, it } from "vitest";

import { applyChange, applyToolsChange, BUILTIN_TOOLS, mcpServersOf, EMPTY_HARNESS, extensionOf, EXTENSIONS, resolvedToolsOf, resolveHarness, type StoredHarness, type ToolsChange, withoutQuery } from "./index.ts";

describe("resolveHarness", () => {
  it("gives the defaults for empty settings: every tool direct (the core preset), web_search hidden, t3's tools direct", () => {
    const resolved = resolveHarness(EMPTY_HARNESS);
    expect(resolved.revision).toBe(0);
    expect(resolved.codemode).toEqual({ enabled: true, inlineBudget: 2000 });
    expect(resolved.toolSearch).toEqual({ enabled: true });
    expect(resolved.tools).toEqual({
      ...Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, "direct"])),
      web_search: "hidden",
    });
    expect(resolved.t3).toEqual({ exposure: "direct", tools: {} });
    expect(resolved.offered).toBeUndefined();
  });

  it("has the web tools on with web_search hidden (a search costs a model request), and the search model switchable (SPI-1054)", () => {
    expect(resolveHarness(EMPTY_HARNESS).extensions.web).toEqual({ enabled: true, settings: { searchModel: "default" } });
    const on = applyChange(EMPTY_HARNESS, { extension: "web", settings: { searchModel: "claude-sonnet-5-5" } });
    if (!on.ok) throw new Error(on.error);
    expect(resolveHarness(on.harness).extensions.web).toEqual({ enabled: true, settings: { searchModel: "claude-sonnet-5-5" } });
    expect(applyChange(EMPTY_HARNESS, { extension: "web", settings: { search: true } })).toEqual({ ok: false, error: "web.search: no such setting" });
    // Since SPI-1176 the setting is text, resolved against the Model endpoints at use: any slug is taken, an overlong one is not.
    expect(applyChange(EMPTY_HARNESS, { extension: "web", settings: { searchModel: "openai/gpt-9" } })).toMatchObject({ ok: true });
    expect(applyChange(EMPTY_HARNESS, { extension: "web", settings: { searchModel: "x".repeat(301) } })).toMatchObject({ ok: false });
  });

  it("has Terminals on with bash's background jobs and a 120x40 viewport (SPI-1057): nothing starts a container until used", () => {
    expect(resolveHarness(EMPTY_HARNESS).extensions.termctrl).toEqual({ enabled: true, settings: { backgroundBash: true, cols: 120, rows: 40 } });
    expect(applyChange(EMPTY_HARNESS, { extension: "termctrl", settings: { cols: 10 } })).toMatchObject({ ok: false });
  });

  it("has the Guardian off (each review is a model request), with the endpoints' small model (default), no thinking, and text rules (SPI-1058)", () => {
    expect(resolveHarness(EMPTY_HARNESS).extensions.guardian).toEqual({ enabled: false, settings: { model: "default", thinkingLevel: "off", tools: "", commands: "", policy: "" } });
    const on = applyChange(EMPTY_HARNESS, { extension: "guardian", enabled: true, settings: { tools: "bash=review", policy: "Never touch prod." } });
    if (!on.ok) throw new Error(on.error);
    expect(resolveHarness(on.harness).extensions.guardian).toMatchObject({ enabled: true, settings: { tools: "bash=review", policy: "Never touch prod." } });
    expect(applyChange(EMPTY_HARNESS, { extension: "guardian", settings: { commands: "x".repeat(4_001) } })).toMatchObject({ ok: false });
    expect(applyChange(EMPTY_HARNESS, { extension: "guardian", settings: { commands: 3 } })).toMatchObject({ ok: false });
  });

  it("has the Advisor off (each review is a model request), inheriting the model, reviewing every turn (SPI-1059)", () => {
    expect(resolveHarness(EMPTY_HARNESS).extensions.advisor).toEqual({ enabled: false, settings: { model: "inherit", reviewEvery: "turn", thinkingLevel: "high", correctiveTurns: 1 } });
    expect(applyChange(EMPTY_HARNESS, { extension: "advisor", enabled: true, settings: { reviewEvery: "3", model: "claude-sonnet-5-5" } })).toMatchObject({ ok: true });
    expect(applyChange(EMPTY_HARNESS, { extension: "advisor", settings: { reviewEvery: "7" } })).toMatchObject({ ok: false });
  });

  it("gives an extension's defaults to a Session whose resolved view predates the entry", () => {
    const { web: _web, ...older } = resolveHarness(EMPTY_HARNESS).extensions;
    const taken = { ...resolveHarness(EMPTY_HARNESS), extensions: older };
    expect(extensionOf(taken, "web")).toEqual({ enabled: true, settings: { searchModel: "default" } });
    expect(extensionOf(taken, "nope")).toEqual({ enabled: false, settings: {} });
  });

  it("resolves settings stored before Exposures: switches off hide their tools, the preset defers, web search follows its old switch", () => {
    const legacy: StoredHarness = {
      revision: 7,
      overrides: {},
      global: { extensions: { "offered-tools": { settings: { preset: "codemode-only" } }, todo: { enabled: false }, web: { settings: { search: true } } } },
    };
    const resolved = resolveHarness(legacy);
    expect(resolved.tools).toMatchObject({ codemode: "direct", tool_search: "direct", read: "deferred", todo: "hidden", web_search: "deferred", ask_user: "deferred" });
    expect(resolved.t3.exposure).toBe("deferred");
    expect(resolved.extensions.todo?.enabled).toBe(false);
    // Tool search off offered everything: nothing was deferred.
    const noSearch = resolveHarness({ ...legacy, global: { extensions: { "tool-search": { enabled: false }, codemode: { enabled: false } } } });
    expect(noSearch.tools).toMatchObject({ tool_search: "hidden", codemode: "hidden", read: "direct", terminal_wait: "direct" });
    expect(noSearch.toolSearch.enabled).toBe(false);
    expect(noSearch.codemode.enabled).toBe(false);
    // A tool's own Exposure wins over what the old settings gave it.
    const own = applyToolsChange(legacy, { tools: { todo: "codemode", read: "direct" } });
    if (!own.ok) throw new Error(own.error);
    expect(resolveHarness(own.harness).tools).toMatchObject({ todo: "codemode", read: "direct", grep: "deferred" });
  });

  it("reads the tools of a view a Session kept from before Exposures", () => {
    const { tools: _tools, t3: _t3, ...rest } = resolveHarness(EMPTY_HARNESS);
    const kept = { ...rest, offered: ["codemode", "tool_search"], extensions: { ...rest.extensions, termctrl: { enabled: false, settings: {} } } };
    expect(resolvedToolsOf(kept).tools).toMatchObject({ read: "deferred", codemode: "direct", terminal_start: "hidden", web_search: "hidden" });
    expect(extensionOf(kept, "termctrl").enabled).toBe(false);
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
    const changed = applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { inlineBudget: 4000 } });
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.harness.revision).toBe(1);
    expect(resolveHarness(changed.harness).codemode).toEqual({ enabled: true, inlineBudget: 4000 });
  });

  it("refuses a value outside the schema, an unknown setting, and an unknown extension", () => {
    expect(applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { inlineBudget: 10 } })).toEqual({ ok: false, error: "codemode.inlineBudget: at least 500" });
    expect(applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { inlineBudget: "big" } })).toEqual({ ok: false, error: "codemode.inlineBudget: an integer" });
    expect(applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { other: 1 } })).toEqual({ ok: false, error: "codemode.other: no such setting" });
    expect(applyChange(EMPTY_HARNESS, { extension: "advisor", settings: { reviewEvery: "7" } })).toEqual({ ok: false, error: "advisor.reviewEvery: one of turn, 2, 3, 5, request" });
    expect(applyChange(EMPTY_HARNESS, { extension: "nope", enabled: true })).toEqual({ ok: false, error: "nope: no such extension" });
    expect(applyChange(EMPTY_HARNESS, { extension: "codemode", settings: { constructor: 1 } })).toEqual({ ok: false, error: "codemode.constructor: no such setting" });
  });

  it("refuses a switch that is not true or false: a stored null would resolve to the default, on", () => {
    const off = applyChange(EMPTY_HARNESS, { extension: "advisor", enabled: false });
    if (!off.ok) throw new Error(off.error);
    expect(applyChange(off.harness, { extension: "advisor", enabled: null as unknown as boolean })).toEqual({ ok: false, error: "enabled: true or false" });
    expect(applyChange(off.harness, { extension: "advisor", enabled: "no" as unknown as boolean })).toEqual({ ok: false, error: "enabled: true or false" });
  });

  it("refuses to change a locked extension: permissions can never be turned off", () => {
    const permissions = EXTENSIONS.find((entry) => entry.id === "permissions");
    expect(permissions?.locked).toBeDefined();
    expect(applyChange(EMPTY_HARNESS, { extension: "permissions", enabled: false })).toEqual({ ok: false, error: `permissions: locked (${permissions?.locked})` });
  });

  it("refuses to turn an extension with tools on or off: its tools' Exposures are its switch", () => {
    expect(applyChange(EMPTY_HARNESS, { extension: "todo", enabled: false })).toEqual({ ok: false, error: "todo: on while any of its tools is not hidden; set its tools' Exposure instead" });
  });
});

describe("applyToolsChange", () => {
  const apply = (change: ToolsChange, stored: StoredHarness = EMPTY_HARNESS) => {
    const applied = applyToolsChange(stored, change);
    if (!applied.ok) throw new Error(applied.error);
    return applied.harness;
  };

  it("sets each tool's Exposure; hiding all of an extension's tools turns it off; null returns a tool to its default", () => {
    const changed = apply({ tools: { ask_user: "hidden", read: "codemode", web_search: "deferred" } });
    expect(changed.revision).toBe(1);
    const resolved = resolveHarness(changed);
    expect(resolved.tools).toMatchObject({ ask_user: "hidden", read: "codemode", web_search: "deferred" });
    expect(resolved.extensions["ask-user"]?.enabled).toBe(false);
    expect(resolved.extensions["coding-tools"]?.enabled).toBe(true);
    expect(resolveHarness(apply({ tools: { read: null } }, changed)).tools.read).toBe("direct");
    expect(resolveHarness(apply({ tools: { codemode: "hidden", tool_search: "hidden" } })).codemode.enabled).toBe(false);
  });

  it("sets t3's tools one by one, and a default for those without their own", () => {
    const changed = resolveHarness(apply({ t3: { exposure: "deferred", tools: { t3_thread_read: "codemode", t3_thread_wait: "hidden" } } }));
    expect(changed.t3).toEqual({ exposure: "deferred", tools: { t3_thread_read: "codemode", t3_thread_wait: "hidden" } });
  });

  it("applies a preset to every tool that is not hidden and is not a switch, t3's included; hidden ones stay hidden", () => {
    const before = apply({ tools: { ask_user: "hidden", codemode: "hidden", grep: "codemode" }, t3: { tools: { t3_thread_read: "codemode", t3_thread_wait: "hidden" } } });
    const resolved = resolveHarness(apply({ preset: "codemode-only" }, before));
    expect(resolved.tools).toMatchObject({ ask_user: "hidden", codemode: "hidden", tool_search: "direct", grep: "deferred", read: "deferred", web_search: "hidden" });
    // A t3 tool the owner set keeps an Exposure of its own, the preset's (one t3 asks for in every request stays so).
    expect(resolved.t3).toEqual({ exposure: "deferred", tools: { t3_thread_read: "deferred", t3_thread_wait: "hidden" } });
    expect(resolveHarness(apply({ preset: "everything" }, before)).tools).toMatchObject({ read: "direct", grep: "direct", ask_user: "hidden" });
  });

  it("gives a t3 tool the owner offered the preset's Exposure while t3's default is hidden", () => {
    const before = apply({ t3: { exposure: "hidden", tools: { t3_y: "direct", t3_z: "hidden" } } });
    expect(resolveHarness(apply({ preset: "codemode-only" }, before)).t3).toEqual({ exposure: "hidden", tools: { t3_y: "deferred", t3_z: "hidden" } });
    expect(resolveHarness(apply({ preset: "everything" }, before)).t3).toEqual({ exposure: "hidden", tools: { t3_y: "direct", t3_z: "hidden" } });
  });

  it("applies a preset to MCP servers: each server not hidden takes its Exposure, each tool's own goes back to it", () => {
    const fixture = { kind: "direct" as const, url: "https://fixture.example/mcp", enabled: true, exposure: "direct" as const, toolExposure: { a: "codemode" as const, b: "hidden" as const, d: "direct" as const } };
    const shut = { kind: "direct" as const, url: "https://shut.example/mcp", enabled: true, exposure: "hidden" as const, toolExposure: { c: "direct" as const } };
    const scripts = { kind: "direct" as const, url: "https://scripts.example/mcp", enabled: true, exposure: "codemode" as const };
    const before: StoredHarness = { ...EMPTY_HARNESS, mcp: { servers: { fixture, shut, scripts } } };
    const core = apply({ preset: "core" }, before);
    // Code mode only is left as the old wrap left it, a server's or a tool's.
    expect(mcpServersOf(core)).toMatchObject({
      fixture: { exposure: "deferred", toolExposure: { a: "codemode", b: "hidden" } },
      shut: { exposure: "hidden", toolExposure: { c: "deferred" } },
      scripts: { exposure: "codemode" },
      settings: { exposure: "deferred" },
    });
    expect(mcpServersOf(core).fixture!.toolExposure).toEqual({ a: "codemode", b: "hidden" });
    // The implied Settings server's entry is stored only when the preset moves it.
    expect(core.mcp?.servers.settings).toBeUndefined();
    const everything = apply({ preset: "everything" }, before);
    expect(mcpServersOf(everything)).toMatchObject({ fixture: { exposure: "direct" }, shut: { exposure: "hidden", toolExposure: { c: "direct" } }, settings: { kind: "settings", exposure: "direct" } });
    expect(apply({ preset: "core" }, EMPTY_HARNESS).mcp).toBeUndefined();
  });

  it("refuses more t3 tools set one by one than t3 lists", () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`t3_${index}`, "hidden" as const]));
    expect(applyToolsChange(EMPTY_HARNESS, { t3: { tools: many } })).toEqual({ ok: false, error: "t3 tools: at most 200 set one by one" });
  });

  it("refuses an unknown tool or preset, an Exposure a tool cannot have, and a malformed t3 tool name", () => {
    expect(applyToolsChange(EMPTY_HARNESS, { tools: { nope: "direct" } })).toEqual({ ok: false, error: "nope: not a built-in tool" });
    expect(applyToolsChange(EMPTY_HARNESS, { tools: { codemode: "deferred" } })).toEqual({ ok: false, error: "codemode: one of direct, hidden, or null" });
    expect(applyToolsChange(EMPTY_HARNESS, { tools: { read: "all" as never } })).toEqual({ ok: false, error: "read: one of direct, deferred, codemode, hidden, or null" });
    expect(applyToolsChange(EMPTY_HARNESS, { preset: "all" as never })).toEqual({ ok: false, error: "preset: one of core, codemode-only, everything" });
    expect(applyToolsChange(EMPTY_HARNESS, { t3: { tools: { t3_thread_wait: "codemode" } } })).toEqual({ ok: false, error: "t3-code/t3_thread_wait: one of direct, deferred, hidden, or null" });
    expect(applyToolsChange(EMPTY_HARNESS, { t3: { tools: { "a b": "direct" } } })).toEqual({ ok: false, error: "a b: not a t3 tool name" });
    expect(applyToolsChange(EMPTY_HARNESS, { t3: { exposure: "all" as never } })).toEqual({ ok: false, error: "t3 exposure: one of direct, deferred, codemode, hidden" });
  });

  it("keeps a tool named like an Object.prototype key a key like any other", () => {
    expect(resolveHarness(apply({ t3: { tools: { __proto__: "hidden" } as never } })).t3.tools).toEqual({});
    const named = resolveHarness(apply({ t3: { tools: JSON.parse('{"__proto__":"hidden"}') } }));
    expect(Object.hasOwn(named.t3.tools, "__proto__")).toBe(true);
  });
});

describe("withoutQuery", () => {
  it("drops a URL's query and fragment (a key an owner put there), and leaves other text alone", () => {
    expect(withoutQuery("https://mcp.example/mcp?connection=conn_1&key=s3cr3t#frag")).toBe("https://mcp.example/mcp");
    expect(withoutQuery("https://mcp.example/mcp")).toBe("https://mcp.example/mcp");
    expect(withoutQuery("not a url")).toBe("not a url");
  });

  it("SPI-1195 review: cuts what the URL parser refuses at its first ? or #", () => {
    expect(withoutQuery("https://h:99999/p?key=x")).toBe("https://h:99999/p");
    expect(withoutQuery("https://?key=s3cr3t")).toBe("https://");
    expect(withoutQuery("https://h:99999/p#key=x?y")).toBe("https://h:99999/p");
    expect(withoutQuery("not a url ?key=x")).toBe("not a url ");
  });
});
