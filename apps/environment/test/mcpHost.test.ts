// The MCP host's seam (ADR-0028): `McpHost` over a fake engine. Listing and the view (classes pinned by hash, review
// H3; linked threads see only servers offered to them, M13), calls (disabled servers, failures that may have run, the
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
  it("lists Commissary with the key and redacts it; Commissary's tools take their first-seen hint", async () => {
    const run = setup(() => [tool("fixture_echo", true), tool("fixture_note")]);
    await run.host.list("commissary");
    expect(run.seen[0].target).toMatchObject({ url: "https://proxy.example/mcp", headers: { authorization: "Bearer sk-test-key" }, redact: ["sk-test-key"] });
    const view = await run.host.view({ linked: false });
    expect(view.servers[0]?.tools.map((t) => [t.name, t.class])).toEqual([
      ["mcp__commissary__fixture_echo", "read"],
      ["mcp__commissary__fixture_note", "write"],
    ]);
  });

  it("a hint that flips to read on a changed definition stays write until the owner confirms (H3)", async () => {
    let flipped = false;
    const run = setup(() => [flipped ? tool("fixture_flip", true, "now harmless") : tool("fixture_flip")]);
    await run.host.list("commissary");
    expect((await run.host.view({ linked: false })).servers[0]?.tools[0]?.class).toBe("write");
    flipped = true;
    await run.host.list("commissary");
    const flippedTool = (await run.host.view({ linked: false })).servers[0]!.tools[0]!;
    expect(flippedTool).toMatchObject({ class: "write", unconfirmed: true, suggested: "read" });
    const confirmed = applyMcpChange(run.settings(), { op: "class", server: "commissary", tool: "fixture_flip", class: "read", hash: flippedTool.hash });
    if (!confirmed.ok) throw new Error(confirmed.error);
    run.set(confirmed.harness);
    expect((await run.host.view({ linked: false })).servers[0]?.tools[0]?.class).toBe("read");
  });

  it("a linked thread sees only servers offered to linked threads, off by default (M13); hidden tools are left out", async () => {
    const run = setup(() => [tool("a", true), tool("b")]);
    await run.host.list("commissary");
    expect((await run.host.view({ linked: true })).servers).toEqual([]);
    const offered = applyMcpChange(run.settings(), { op: "server", server: "commissary", linkedOffered: true, toolExposure: { b: "hidden" } });
    if (!offered.ok) throw new Error(offered.error);
    run.set(offered.harness);
    expect((await run.host.view({ linked: true })).servers[0]?.tools.map((t) => t.upstream)).toEqual(["a"]);
    expect(await run.host.call({ server: "commissary", tool: "b", args: {}, linked: true })).toMatchObject({ kind: "unavailable" });
  });

  it("calls a tool by its upstream definition, and refuses calls to a disabled server or an unknown tool", async () => {
    const run = setup(() => [tool("fixture_note")]);
    await run.host.list("commissary");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: { line: "x" }, linked: false, judged: "write" })).toEqual({ kind: "result", isError: false, text: "noted" });
    expect(run.seen.at(-1).request).toMatchObject({ op: "tools/call", tool: { name: "fixture_note" }, arguments: { line: "x" }, ctx: { origin: "agent" } });
    expect(await run.host.call({ server: "commissary", tool: "nope", args: {}, linked: false })).toMatchObject({ kind: "unavailable", mayHaveRun: false });
    const off = applyMcpChange(run.settings(), { op: "server", server: "commissary", enabled: false });
    if (!off.ok) throw new Error(off.error);
    run.set(off.harness);
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, linked: false, judged: "write" })).toMatchObject({ kind: "unavailable", message: expect.stringContaining("removed or disabled") });
  });

  it("a call judged read whose class is write now is refused, to be asked again", async () => {
    const run = setup(() => [tool("fixture_note")]);
    await run.host.list("commissary");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, linked: false, judged: "read" })).toMatchObject({
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
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, linked: false, judged: "write" })).toMatchObject({ kind: "unavailable", mayHaveRun: true, message: expect.stringContaining("may have run") });
    error = new Error("HTTP 401 unauthorized");
    expect(await run.host.call({ server: "commissary", tool: "fixture_note", args: {}, linked: false, judged: "write" })).toMatchObject({ message: expect.stringContaining("MODEL_PROXY_API_KEY") });
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
    const view = await run.host.view({ linked: false });
    expect(view.servers[0]).toMatchObject({ state: "stale" });
    expect(view.servers[0]?.tools).toHaveLength(1);
  });
});
