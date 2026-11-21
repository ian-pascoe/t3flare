// The MCP host's seam (ADR-0028): `McpHost` over a fake engine. Listing and the view (classes from the tool's own
// hint or the owner's override; every enabled server for every thread: owner, 2026-11-12, back to stock), calls (disabled
// servers, failures that may have run), and the target it hands the engine (the header value, and nothing else, to
// redact). Commissary is an ordinary direct server the owner adds with its `x-api-key` header (SPI-1160).
import { applyMcpChange, EMPTY_HARNESS, type StoredHarness } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { McpHost, type McpEngineBinding } from "../src/mcp/host.ts";

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const tool = (name: string, readOnlyHint?: boolean, description = name) => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});

const fakeEngine = (tools: () => Array<Record<string, unknown>>, answer: () => unknown = () => ({ content: [{ type: "text", text: "noted" }] })) => {
  const seen: Array<any> = [];
  const engine: McpEngineBinding = {
    discover: async (target) => {
      seen.push({ op: "discover", target });
      return { kind: "discovered", era: "legacy", protocolVersion: "2025-06-18", capabilities: { tools: {} }, tools: tools(), prompts: [], problems: [], fetchedAt: 0, state: { era: { v: 1 } } } as never;
    },
    request: async (target, _prior, request) => {
      seen.push({ op: "request", target, request });
      const value = answer();
      if (value instanceof Error) return { kind: "failed", error: { _tag: "Unreachable", message: value.message }, state: {} } as never;
      return { kind: "complete", result: { kind: "inline", value }, cacheable: false, fetchedAt: 0, state: {} } as never;
    },
  };
  return { engine, seen };
};

const COMMISSARY_URL = "https://api.commissary.example/mcp?toolkits=fixture";
const COMMISSARY_KEY = "cms-test-key";

/** Settings with Commissary added by the owner as a direct server signed in with its `x-api-key` header. */
const withCommissary = (): StoredHarness => {
  const added = applyMcpChange(EMPTY_HARNESS, { op: "add", server: "commissary", url: COMMISSARY_URL, auth: { kind: "header", header: "x-api-key" } });
  if (!added.ok) throw new Error(added.error);
  return added.harness;
};

const setup = (tools: () => Array<Record<string, unknown>>, answer?: () => unknown, harness: StoredHarness = withCommissary()) => {
  let settings = harness;
  const { engine, seen } = fakeEngine(tools, answer);
  const host = new McpHost({
    kv: memory(),
    engine,
    settings: () => settings,
    secret: async (server, field) => (server === "commissary" && field === "header" ? COMMISSARY_KEY : undefined),
    now: () => 1_000_000,
  });
  return { host, seen, set: (next: StoredHarness) => (settings = next), settings: () => settings };
};

describe("McpHost", () => {
  it("lists Commissary, added as a direct server, with its x-api-key header and redacts it; tools take their own hint", async () => {
    const run = setup(() => [tool("fixture_echo", true), tool("fixture_note")]);
    await run.host.list("commissary");
    expect(run.seen[0].target).toEqual(expect.objectContaining({ url: COMMISSARY_URL, headers: { "x-api-key": COMMISSARY_KEY }, redact: [COMMISSARY_KEY] }));
    const view = await run.host.view();
    expect(view.servers[0]?.tools.map((t) => [t.name, t.class])).toEqual([
      ["mcp__commissary__fixture_echo", "read"],
      ["mcp__commissary__fixture_note", "write"],
    ]);
  });

  it("offers no server the owner has not added, beside the Settings server's implied entry", async () => {
    const run = setup(() => [tool("fixture_echo", true)], undefined, EMPTY_HARNESS);
    expect(Object.keys(run.host.servers())).toEqual(["settings"]);
    expect((await run.host.view()).servers.map((server) => server.name)).toEqual(["settings"]);
  });

  it("a stored settings document that still names the built-in commissary server loads without it, and a call to it reaches nothing", async () => {
    // That the name is free again for a direct server is harnessPanel.test.ts's, through the panel.
    const fixture = { kind: "direct", url: "https://fixture.example/mcp", auth: { kind: "none" }, enabled: true, exposure: "deferred" };
    const stored = { revision: 7, global: {}, overrides: {}, mcp: { servers: { commissary: { kind: "commissary", enabled: true, exposure: "deferred" }, fixture } } } as unknown as StoredHarness;
    const run = setup(() => [tool("fixture_echo", true)], undefined, stored);
    expect(Object.keys(run.host.servers())).toEqual(["fixture", "settings"]);
    expect((await run.host.view()).servers.map((server) => server.name)).toEqual(["fixture", "settings"]);
    expect(await run.host.call({ server: "commissary", tool: "fixture_echo", args: {} })).toMatchObject({ kind: "unavailable", mayHaveRun: false });
    expect(run.seen.filter((call) => call.op === "request")).toEqual([]);
  });

  it("a tool's class follows its hint as it changes, and the owner's override wins until cleared", async () => {
    let flipped = false;
    const run = setup(() => [flipped ? tool("fixture_flip", true, "now harmless") : tool("fixture_flip")]);
    await run.host.list("commissary");
    expect((await run.host.view()).servers[0]?.tools[0]?.class).toBe("write");
    flipped = true;
    await run.host.list("commissary");
    expect((await run.host.view()).servers[0]?.tools[0]).toMatchObject({ class: "read", hinted: "read" });
    const marked = applyMcpChange(run.settings(), { op: "class", server: "commissary", tool: "fixture_flip", class: "write" });
    if (!marked.ok) throw new Error(marked.error);
    run.set(marked.harness);
    expect((await run.host.view()).servers[0]?.tools[0]).toMatchObject({ class: "write", hinted: "read" });
    const cleared = applyMcpChange(run.settings(), { op: "class", server: "commissary", tool: "fixture_flip", class: null });
    if (!cleared.ok) throw new Error(cleared.error);
    run.set(cleared.harness);
    expect((await run.host.view()).servers[0]?.tools[0]?.class).toBe("read");
  });

  it("a tool named after an Object.prototype key takes its server's Exposure and its own hint (SPI-1198 review)", async () => {
    const added = applyMcpChange(EMPTY_HARNESS, { op: "add", server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } });
    if (!added.ok) throw new Error(added.error);
    const hidden = applyMcpChange(added.harness, { op: "server", server: "fixture", exposure: "hidden", toolExposure: { other: "hidden" } });
    if (!hidden.ok) throw new Error(hidden.error);
    const run = setup(() => [tool("constructor", true), tool("toString"), tool("other", true)], undefined, hidden.harness);
    await run.host.list("fixture");
    const { tools } = await run.host.tools("fixture", run.host.servers().fixture!, run.host.inventory("fixture"));
    expect(tools.map((t) => [t.upstream, t.exposure, t.class])).toEqual([
      ["constructor", "hidden", "read"],
      ["toString", "hidden", "write"],
      ["other", "hidden", "read"],
    ]);
    // A call naming a prototype key of a server's map reaches the tool, not Object.prototype.
    expect(await run.host.call({ server: "fixture", tool: "hasOwnProperty", args: {} })).toMatchObject({ kind: "unavailable" });
    expect(await run.host.call({ server: "toString", tool: "x", args: {} })).toMatchObject({ kind: "unavailable" });
  });

  it("every thread sees every enabled server; hidden tools are left out and refused", async () => {
    const run = setup(() => [tool("a", true), tool("b")]);
    await run.host.list("commissary");
    const hidden = applyMcpChange(run.settings(), { op: "server", server: "commissary", toolExposure: { b: "hidden" } });
    if (!hidden.ok) throw new Error(hidden.error);
    run.set(hidden.harness);
    expect((await run.host.view()).servers[0]?.tools.map((t) => t.upstream)).toEqual(["a"]);
    expect(await run.host.call({ server: "commissary", tool: "b", args: {} })).toMatchObject({ kind: "unavailable" });
  });

  it("calls a tool by its upstream definition, and refuses calls to a disabled server or an unknown tool", async () => {
    const run = setup(() => [tool("fixture_note")]);
    await run.host.list("commissary");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: { line: "x" }, judged: "write" })).toEqual({ kind: "result", isError: false, text: "noted" });
    expect(run.seen.at(-1).request).toMatchObject({ op: "tools/call", tool: { name: "fixture_note" }, arguments: { line: "x" }, ctx: { origin: "agent" } });
    expect(await run.host.call({ server: "commissary", tool: "nope", args: {} })).toMatchObject({ kind: "unavailable", mayHaveRun: false });
    const off = applyMcpChange(run.settings(), { op: "server", server: "commissary", enabled: false });
    if (!off.ok) throw new Error(off.error);
    run.set(off.harness);
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, judged: "write" })).toMatchObject({ kind: "unavailable", message: expect.stringContaining("removed or disabled") });
  });

  it("a call judged read whose class is write now is refused, to be asked again", async () => {
    const run = setup(() => [tool("fixture_note")]);
    await run.host.list("commissary");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, judged: "read" })).toMatchObject({
      kind: "unavailable",
      mayHaveRun: false,
      message: expect.stringContaining("now a write tool"),
    });
    expect(run.seen.filter((call) => call.op === "request")).toEqual([]);
  });

  it("a failed call may have run and says so", async () => {
    let error = new Error("timed out");
    const run = setup(() => [tool("fixture_note")], () => error);
    await run.host.list("commissary");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, judged: "write" })).toMatchObject({ kind: "unavailable", mayHaveRun: true, message: expect.stringContaining("may have run") });
    error = new Error("HTTP 401 unauthorized");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, judged: "write" })).toMatchObject({ kind: "unavailable", message: expect.stringContaining("401") });
  });

  it("a failed list keeps the last inventory, marked stale", async () => {
    let fail = false;
    const run = setup(() => {
      if (fail) throw new Error("down");
      return [tool("fixture_echo", true)];
    });
    await run.host.list("commissary");
    fail = true;
    await run.host.list("commissary");
    const view = await run.host.view();
    expect(view.servers[0]).toMatchObject({ state: "stale" });
    expect(view.servers[0]?.tools).toHaveLength(1);
  });
});

describe("McpHost.forget: a server added again under its name starts fresh, even with old work in flight", () => {
  /** An engine whose answers wait on gates the test opens; it records the prior each request was sent with. */
  const gatedEngine = () => {
    const priors: Array<unknown> = [];
    const gates: Array<{ open: () => void; wait: Promise<void> }> = [];
    const gate = () => {
      let open = () => {};
      const wait = new Promise<void>((resolve) => (open = resolve));
      gates.push({ open, wait });
      return wait;
    };
    const answers: Array<{ readonly gated: boolean; readonly tools: Array<Record<string, unknown>>; readonly session: string }> = [];
    const engine: McpEngineBinding = {
      discover: async (_target, prior) => {
        priors.push(structuredClone(prior));
        const answer = answers.shift() ?? { gated: false, tools: [], session: "s-none" };
        if (answer.gated) await gate();
        return { kind: "discovered", era: "legacy", protocolVersion: "2025-06-18", capabilities: { tools: {} }, tools: answer.tools, prompts: [], problems: [], fetchedAt: 0, state: { session: answer.session } } as never;
      },
      request: async (_target, prior) => {
        priors.push(structuredClone(prior));
        await gate();
        return { kind: "complete", result: { kind: "inline", value: { content: [{ type: "text", text: "ok" }] } }, cacheable: false, fetchedAt: 0, state: { session: "s-old" } } as never;
      },
    };
    const host = new McpHost({ kv: memory(), engine, settings: () => withCommissary(), secret: async () => COMMISSARY_KEY, now: () => 1_000_000 });
    return { host, priors, answers, opened: () => gates.length, openAll: () => gates.forEach((g) => g.open()) };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a list in flight across a forget keeps neither its tools nor its session, and a new list does not join it", async () => {
    const run = gatedEngine();
    run.answers.push({ gated: true, tools: [tool("old_tool", true)], session: "s-old" }, { gated: false, tools: [tool("new_tool", true)], session: "s-new" });
    const old = run.host.list("commissary");
    await tick();
    run.host.forget("commissary");
    const fresh = await run.host.list("commissary");
    run.openAll();
    await old;
    expect(Object.keys(fresh.definitions)).toEqual(["new_tool"]);
    expect(Object.keys(run.host.inventory("commissary").definitions)).toEqual(["new_tool"]);
    await run.host.list("commissary");
    expect(run.priors).toEqual([{}, {}, { session: "s-new" }]);
  });

  it("a call in flight across a forget does not write its session back", async () => {
    const run = gatedEngine();
    run.answers.push({ gated: false, tools: [tool("note")], session: "s-first" });
    await run.host.list("commissary");
    const call = run.host.call({ server: "commissary", tool: "note", args: {}, judged: "write" });
    while (run.opened() === 0) await tick();
    run.host.forget("commissary");
    run.openAll();
    expect(await call).toMatchObject({ kind: "result", text: "ok" });
    await run.host.list("commissary");
    expect(run.priors).toEqual([{}, { session: "s-first" }, {}]);
  });
});

describe("McpHost and MCP apps (G11, review L10)", () => {
  const appTool = { ...tool("get_time", true), _meta: { ui: { resourceUri: "ui://time/app.html", visibility: ["model", "app"], csp: { connect: ["*"] } }, secret: "x" } };

  it("keeps a tool's `_meta.ui` (its App and visibility) and nothing else of its `_meta`", async () => {
    const run = setup(() => [appTool, tool("plain", true)]);
    await run.host.list("commissary");
    const tools = (await run.host.view()).servers[0]!.tools;
    expect(tools.find((t) => t.upstream === "get_time")?.ui).toEqual({ resourceUri: "ui://time/app.html", visibility: ["model", "app"] });
    expect(tools.find((t) => t.upstream === "plain")?.ui).toBeUndefined();
  });

  it("reads only a ui:// resource one of the server's own tools declares, as an App read", async () => {
    const run = setup(() => [appTool], () => ({ contents: [{ uri: "ui://time/app.html", mimeType: "text/html;profile=mcp-app", text: "<p>t</p>" }] }));
    await run.host.list("commissary");
    expect(await run.host.readAppResource({ server: "commissary", uri: "ui://time/app.html" })).toMatchObject({ kind: "result", value: { contents: [{ text: "<p>t</p>" }] } });
    expect(run.seen.at(-1).request).toMatchObject({ op: "resources/read", uri: "ui://time/app.html", app: true });
    const before = run.seen.length;
    expect((await run.host.readAppResource({ server: "commissary", uri: "ui://other/app.html" })).kind).toBe("refused");
    expect((await run.host.readAppResource({ server: "commissary", uri: "file:///etc/passwd" })).kind).toBe("refused");
    expect((await run.host.readAppResource({ server: "nope", uri: "ui://time/app.html" })).kind).toBe("refused");
    expect(run.seen.length).toBe(before);
  });

  it("passes a result's structuredContent beside its text", async () => {
    const run = setup(() => [appTool], () => ({ content: [{ type: "text", text: "12:00" }], structuredContent: { time: "12:00" } }));
    await run.host.list("commissary");
    expect(await run.host.call({ server: "commissary", tool: "get_time", args: {}, judged: "read" })).toEqual({ kind: "result", isError: false, text: "12:00", structured: { time: "12:00" } });
  });
});

// The Settings server (ADR-0035, plan D2), M3: a member of the set with static tools, reached without the engine.
describe("McpHost and the Settings server", () => {
  it("lists its static tools without the engine, never stale; a call without the Environment's caller or server is refused", async () => {
    const run = setup(() => []);
    const inventory = await run.host.list("settings");
    expect(inventory).toMatchObject({ status: "ok" });
    expect(run.seen).toEqual([]);
    const settings = (await run.host.view()).servers.find((server) => server.name === "settings");
    expect(settings).toMatchObject({ kind: "settings", state: "available" });
    expect(settings?.tools.find((t) => t.upstream === "get_settings")).toMatchObject({ class: "read", hinted: "read", exposure: "deferred" });
    expect(settings?.tools.find((t) => t.upstream === "change_mcp")).toMatchObject({ class: "write", hinted: "write" });
    expect(await run.host.call({ server: "settings", tool: "get_settings", args: { entity: "harness" }, caller: { door: "own", thread: "t", agent: "piDurable" } })).toMatchObject({ kind: "unavailable" });
    // Commissary's stale inventory is listed again in the background; nothing goes to the engine for the Settings server.
    expect(run.seen.filter((seen) => seen.target.name === "settings")).toEqual([]);
  });
});
