// The MCP host's seam (ADR-0028): `McpHost` over a fake engine. Listing and the view (classes from the tool's own
// hint or the owner's override; every enabled server for every thread: owner, 2026-11-12, back to stock), calls (disabled servers, failures that may have run, the
// key named on a refusal), and the target it hands the engine (the key, and nothing else, to redact).
import { applyMcpChange, EMPTY_HARNESS, type StoredHarness } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { McpHost, type McpEngineBinding } from "../src/mcp/host.ts";

const memory = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) };
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

const setup = (tools: () => Array<Record<string, unknown>>, answer?: () => unknown, harness: StoredHarness = EMPTY_HARNESS) => {
  let settings = harness;
  const { engine, seen } = fakeEngine(tools, answer);
  const host = new McpHost({ kv: memory(), engine, commissary: { url: "https://proxy.example/mcp", key: "sk-test-key" }, settings: () => settings, now: () => 1_000_000 });
  return { host, seen, set: (next: StoredHarness) => (settings = next), settings: () => settings };
};

describe("McpHost", () => {
  it("lists Commissary with the key and redacts it; tools take their own hint", async () => {
    const run = setup(() => [tool("fixture_echo", true), tool("fixture_note")]);
    await run.host.list("commissary");
    expect(run.seen[0].target).toMatchObject({ url: "https://proxy.example/mcp", headers: { authorization: "Bearer sk-test-key" }, redact: ["sk-test-key"] });
    const view = await run.host.view();
    expect(view.servers[0]?.tools.map((t) => [t.name, t.class])).toEqual([
      ["mcp__commissary__fixture_echo", "read"],
      ["mcp__commissary__fixture_note", "write"],
    ]);
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

  it("a direct server's tools take their own hint too (no write-until-marked rule)", async () => {
    const added = applyMcpChange(EMPTY_HARNESS, { op: "add", server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } });
    if (!added.ok) throw new Error(added.error);
    const run = setup(() => [tool("fixture_echo", true), tool("fixture_note")], undefined, added.harness);
    await run.host.list("fixture");
    expect((await run.host.view()).servers.find((server) => server.name === "fixture")?.tools.map((t) => t.class)).toEqual(["read", "write"]);
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

  it("a failed call may have run and says so; a refusal of the key names it", async () => {
    let error = new Error("timed out");
    const run = setup(() => [tool("fixture_note")], () => error);
    await run.host.list("commissary");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, judged: "write" })).toMatchObject({ kind: "unavailable", mayHaveRun: true, message: expect.stringContaining("may have run") });
    error = new Error("HTTP 401 unauthorized");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, judged: "write" })).toMatchObject({ message: expect.stringContaining("MODEL_PROXY_API_KEY") });
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
