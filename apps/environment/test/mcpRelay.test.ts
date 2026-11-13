// The CLI relay's MCP server (ADR-0028, plan §3.2–3.4; review M9, M10): what a CLI process sees and what a call does,
// judged by the calling thread's own mode, linked threads included; and t3's own entry as stock t3 hands it (SPI-1039).
// Owner, 2026-11-12, back to stock: no per-call linked rule, no strictest-mode rule, no taint rule, no t3 relay.
import type { McpRelayInput } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import type { McpView } from "../src/mcp/host.ts";
import { relayMessage, type RelayDeps } from "../src/mcp/relay.ts";
import { codexRelayOverrides, profileLaunch } from "../src/agents/cliProfiles.ts";

const tool = (upstream: string, cls: "read" | "write", exposure: "direct" | "deferred" | "codemode" | "hidden" = "deferred") => ({
  name: `mcp__commissary__${upstream}`,
  upstream,
  description: upstream,
  inputSchema: { type: "object", properties: {} },
  hash: `h-${upstream}`,
  class: cls,
  hinted: cls,
  exposure,
});

const VIEW: McpView = {
  version: "v",
  servers: [
    {
      name: "commissary",
      kind: "commissary",
      state: "available",
      listedAt: 1,
      exposure: "deferred",
      tools: [tool("fixture_echo", "read"), tool("fixture_note", "write"), tool("fixture_script", "write", "codemode")],
    },
  ],
};

interface Harness {
  readonly deps: RelayDeps;
  readonly asks: Array<{ thread: string; title: string }>;
  readonly calls: Array<{ tool: string }>;
}

const harness = (options: { modes?: Record<string, { runtimeMode?: string; interactionMode?: string }>; answer?: { approved: boolean; forSession?: boolean; reason?: string } } = {}): Harness => {
  const asks: Harness["asks"] = [];
  const calls: Harness["calls"] = [];
  const accepted = new Map<string, Set<string>>();
  const modes = options.modes ?? { "thread-1": { runtimeMode: "approval-required", interactionMode: "default" } };
  return {
    asks,
    calls,
    deps: {
      view: async () => VIEW,
      call: async (input) => {
        calls.push({ tool: input.tool });
        return { kind: "result", isError: false, text: `ran ${input.tool}` };
      },
      state: (thread) => (modes[thread] === undefined ? undefined : { runtimeMode: modes[thread]!.runtimeMode, interactionMode: modes[thread]!.interactionMode }),
      ask: async (input) => {
        asks.push({ thread: input.thread, title: input.title });
        return options.answer ?? { approved: true };
      },
      accepted: {
        has: (thread, key) => accepted.get(thread)?.has(key) === true,
        add: (thread, key) => void accepted.set(thread, new Set([...(accepted.get(thread) ?? []), key])),
      },
      log: () => undefined,
    },
  };
};

const input = (message: unknown, extra: Partial<McpRelayInput> = {}): McpRelayInput => ({
  workspace: "ws-1",
  thread: "thread-1",
  cli: "codex",
  server: "commissary",
  message,
  askId: "ask-1",
  ...extra,
});

const call = (name: string, id = 7) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { text: "hi" } } });
const resultOf = (answer: Awaited<ReturnType<typeof relayMessage>>) => {
  if (answer.kind !== "response") throw new Error(`not a response: ${answer.kind}`);
  return (answer.body as { result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } }).result!;
};

describe("the relay's MCP server", () => {
  it("answers initialize with the client's protocol version and only tools", async () => {
    const answer = await relayMessage(input({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }), harness().deps);
    expect(answer).toMatchObject({ kind: "response", body: { id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } } } } });
  });

  it("accepts notifications without an answer", async () => {
    expect(await relayMessage(input({ jsonrpc: "2.0", method: "notifications/initialized" }), harness().deps)).toEqual({ kind: "accepted" });
  });

  it("lists the server's tools by upstream name with the class as the hint, without scripts-only and hidden ones (M10)", async () => {
    const tools = resultOf(await relayMessage(input({ jsonrpc: "2.0", id: 2, method: "tools/list" }), harness().deps)).tools!;
    expect(tools.map((entry) => [entry.name, entry.annotations.readOnlyHint])).toEqual([
      ["fixture_echo", true],
      ["fixture_note", false],
    ]);
  });

  it("runs a read tool without a card", async () => {
    const h = harness();
    const result = resultOf(await relayMessage(input(call("fixture_echo")), h.deps));
    expect(result).toEqual({ content: [{ type: "text", text: "ran fixture_echo" }], isError: false });
    expect(h.asks).toEqual([]);
  });

  it("asks the owner on the calling thread for a write in approval-required; a decline runs nothing", async () => {
    const h = harness({ answer: { approved: false, reason: "decline" } });
    const result = resultOf(await relayMessage(input(call("fixture_note")), h.deps));
    expect(result.isError).toBe(true);
    expect(h.asks).toEqual([{ thread: "thread-1", title: "Allow commissary: fixture_note?" }]);
    expect(h.calls).toEqual([]);
  });

  it("runs a write in full access, refuses it in plan", async () => {
    const full = harness({ modes: { "thread-1": { runtimeMode: "full-access", interactionMode: "default" } } });
    expect(resultOf(await relayMessage(input(call("fixture_note")), full.deps)).isError).toBe(false);
    expect(full.asks).toEqual([]);
    const plan = harness({ modes: { "thread-1": { runtimeMode: "full-access", interactionMode: "plan" } } });
    const refused = resultOf(await relayMessage(input(call("fixture_note")), plan.deps));
    expect(refused.isError).toBe(true);
    expect(plan.calls).toEqual([]);
  });

  it("decides by the calling thread's own mode, whatever other threads of the Workspace run in", async () => {
    const h = harness({ modes: { "thread-1": { runtimeMode: "full-access", interactionMode: "default" }, "thread-2": { runtimeMode: "approval-required", interactionMode: "default" } } });
    await relayMessage(input(call("fixture_note")), h.deps);
    expect(h.asks).toEqual([]);
    await relayMessage(input(call("fixture_note"), { thread: "thread-2" }), h.deps);
    expect(h.asks.map((ask) => ask.thread)).toEqual(["thread-2"]);
  });

  it("a thread with no known mode is judged as approval-required", async () => {
    const h = harness({ modes: {} });
    await relayMessage(input(call("fixture_note")), h.deps);
    expect(h.asks).toHaveLength(1);
  });

  it("keeps an owner's 'for the session' for that tool on that thread only", async () => {
    const h = harness({ answer: { approved: true, forSession: true } });
    await relayMessage(input(call("fixture_note")), h.deps);
    await relayMessage(input(call("fixture_note")), h.deps);
    await relayMessage(input(call("fixture_note"), { thread: "thread-2" }), h.deps);
    expect(h.asks.map((ask) => ask.thread)).toEqual(["thread-1", "thread-2"]);
  });

  it("refuses a scripts-only or unknown tool", async () => {
    const h = harness({ modes: { "thread-1": { runtimeMode: "full-access" } } });
    expect(resultOf(await relayMessage(input(call("fixture_script")), h.deps)).isError).toBe(true);
    expect(resultOf(await relayMessage(input(call("nope")), h.deps)).isError).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

describe("the CLIs' relay entries (H2, M11)", () => {
  it("gives Codex one entry per server with the handle from its environment, Codex's prompt off, 900 s timeouts", () => {
    expect(codexRelayOverrides(["commissary"])).toEqual([
      'mcp_servers.commissary={url="http://computer.internal/t3flare/mcp/commissary",bearer_token_env_var="T3FLARE_TOOL_HANDLE",default_tools_approval_mode="approve",tool_timeout_sec=900,startup_timeout_sec=20}',
    ]);
    const handle = "a".repeat(64);
    const launch = profileLaunch(
      { cli: "codex", args: ["app-server"], key: "proc-1", cwd: "/w/demo", env: {}, allowProbe: false },
      { proxyUrl: "https://proxy.example", models: [], readStateFile: () => undefined, piExtensionSource: "", relay: { handle, servers: ["commissary"] } },
    );
    if ("refused" in launch) throw new Error(launch.refused);
    expect(launch.env.T3FLARE_TOOL_HANDLE).toBe(handle);
    expect(launch.argv.join(" ")).not.toContain(handle);
    expect(JSON.stringify(launch.files)).not.toContain(handle);
  });
});

describe("pi's t3 entry (SPI-1039, as stock t3 hands it)", () => {
  const handle = "f".repeat(64);
  const pi = (env: Record<string, string>) =>
    profileLaunch(
      { cli: "pi", args: ["--mode", "rpc", "--extension", "/s/ext.ts"], key: "k", cwd: "/w/x", env: { T3_PI_RUNTIME_MODE: "approval-required", ...env }, allowProbe: false },
      { proxyUrl: "https://proxy.example", models: [], readStateFile: () => "SRC", piExtensionSource: "SRC", relay: { handle, servers: [] } },
    );
  it("passes t3's MCP variables when the URL is an https `/mcp`; anything else, none", () => {
    const real = pi({ T3_MCP_URL: "https://t3.example/mcp", T3_MCP_BEARER_TOKEN: "t3-real" });
    if ("refused" in real) throw new Error(real.refused);
    expect(real.env.T3_MCP_URL).toBe("https://t3.example/mcp");
    expect(real.env.T3_MCP_BEARER_TOKEN).toBe("t3-real");
    const other = pi({ T3_MCP_URL: "http://evil.example/x", T3_MCP_BEARER_TOKEN: handle });
    if ("refused" in other) throw new Error(other.refused);
    expect(other.env.T3_MCP_URL).toBeUndefined();
    expect(other.env.T3_MCP_BEARER_TOKEN).toBeUndefined();
  });
});

describe("the relay and MCP apps (G11, review L10)", () => {
  const appView: McpView = {
    version: "v",
    servers: [{ ...VIEW.servers[0]!, tools: [{ ...tool("get_time", "read"), ui: { resourceUri: "ui://time/app.html" } }] }],
  };
  const deps = (reads: Array<string>): RelayDeps => ({
    ...harness().deps,
    view: async () => appView,
    call: async () => ({ kind: "result", isError: false, text: "12:00", structured: { time: "12:00" } }),
    readAppResource: async ({ uri }) => {
      reads.push(uri);
      return uri === "ui://time/app.html" ? { kind: "result", value: { contents: [{ uri, text: "<p>t</p>" }] } } : { kind: "refused", message: "no App there" };
    },
  });

  it("lists a tool's `_meta.ui`, offers resources, and passes structuredContent", async () => {
    const reads: Array<string> = [];
    const init = await relayMessage(input({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), deps(reads));
    expect(init).toMatchObject({ body: { result: { capabilities: { resources: {} } } } });
    const listed = await relayMessage(input({ jsonrpc: "2.0", id: 2, method: "tools/list" }), deps(reads));
    expect(listed).toMatchObject({ body: { result: { tools: [{ name: "get_time", _meta: { ui: { resourceUri: "ui://time/app.html" } } }] } } });
    const called = await relayMessage(input(call("get_time")), deps(reads));
    expect(called).toMatchObject({ body: { result: { structuredContent: { time: "12:00" } } } });
  });

  it("reads a ui:// resource through the host, and refuses any other URI before it", async () => {
    const reads: Array<string> = [];
    expect(await relayMessage(input({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "ui://time/app.html" } }), deps(reads))).toMatchObject({
      body: { result: { contents: [{ text: "<p>t</p>" }] } },
    });
    expect(await relayMessage(input({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "file:///etc/passwd" } }), deps(reads))).toMatchObject({ body: { error: { code: -32602 } } });
    expect(await relayMessage(input({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "ui://other/app.html" } }), deps(reads))).toMatchObject({ body: { error: { code: -32002 } } });
    expect(reads).toEqual(["ui://time/app.html", "ui://other/app.html"]);
    // Without the host's reader (a relay built before G11), resources are not offered at all.
    expect(await relayMessage(input({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "ui://time/app.html" } }), harness().deps)).toMatchObject({ body: { error: { code: -32601 } } });
  });
});
