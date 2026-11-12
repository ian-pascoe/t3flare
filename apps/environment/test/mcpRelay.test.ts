// The CLI relay's MCP server (ADR-0028, plan §3.2–3.4, §4; review H1, M7, M9, M10): what a CLI process sees and what a
// call does, for owner, linked and tainted callers, and t3's own tools (SPI-1039).
import type { McpRelayInput } from "@t3flare/harness-registry";
import type { McpRpcRequest } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import type { McpView } from "../src/mcp/host.ts";
import { relayMessage, type RelayDeps } from "../src/mcp/relay.ts";
import { relayT3Message, T3_TAINTED, type T3RelayDeps } from "../src/mcp/t3Relay.ts";
import { isRelayedT3Server } from "../src/provider/cli/codexGuard.ts";
import { codexRelayOverrides, profileLaunch } from "../src/agents/cliProfiles.ts";

const tool = (upstream: string, cls: "read" | "write", exposure: "direct" | "deferred" | "codemode" | "hidden" = "deferred") => ({
  name: `mcp__commissary__${upstream}`,
  upstream,
  description: upstream,
  inputSchema: { type: "object", properties: {} },
  hash: `h-${upstream}`,
  class: cls,
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
  readonly asks: Array<{ thread: string; perCall: boolean; title: string }>;
  readonly calls: Array<{ tool: string; linked: boolean }>;
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
        calls.push({ tool: input.tool, linked: input.linked });
        return { kind: "result", isError: false, text: `ran ${input.tool}` };
      },
      states: (threads) => threads.flatMap((thread) => (modes[thread] === undefined ? [] : [{ thread, runtimeMode: modes[thread]!.runtimeMode, interactionMode: modes[thread]!.interactionMode, workspace: "ws-1" }])),
      ask: async (input) => {
        asks.push({ thread: input.thread, perCall: input.perCall, title: input.title });
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
  linked: false,
  tainted: false,
  threads: ["thread-1"],
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
    expect(h.asks).toEqual([{ thread: "thread-1", perCall: false, title: "Allow commissary: fixture_note?" }]);
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

  it("decides with the strictest mode among the Workspace's live threads (M7)", async () => {
    const h = harness({ modes: { "thread-1": { runtimeMode: "full-access", interactionMode: "default" }, "thread-2": { runtimeMode: "approval-required", interactionMode: "default" } } });
    await relayMessage(input(call("fixture_note"), { threads: ["thread-1", "thread-2"] }), h.deps);
    expect(h.asks).toHaveLength(1);
  });

  it("asks a linked caller per call even in full access, and never keeps a session acceptance (D1, M9)", async () => {
    const h = harness({ modes: { "thread-1": { runtimeMode: "full-access", interactionMode: "default" } }, answer: { approved: true, forSession: true } });
    await relayMessage(input(call("fixture_note"), { linked: true }), h.deps);
    await relayMessage(input(call("fixture_note"), { linked: true }), h.deps);
    expect(h.asks.map((ask) => ask.perCall)).toEqual([true, true]);
    expect(h.calls).toEqual([
      { tool: "fixture_note", linked: true },
      { tool: "fixture_note", linked: true },
    ]);
  });

  it("asks per call for an owner thread in a tainted Workspace (H1), with the owner's servers", async () => {
    const h = harness({ modes: { "thread-1": { runtimeMode: "full-access", interactionMode: "default" } } });
    await relayMessage(input(call("fixture_note"), { tainted: true }), h.deps);
    expect(h.asks.map((ask) => ask.perCall)).toEqual([true]);
    expect(h.calls).toEqual([{ tool: "fixture_note", linked: false }]);
  });

  it("keeps an owner's 'for the session' for that tool on that thread only", async () => {
    const h = harness({ answer: { approved: true, forSession: true } });
    await relayMessage(input(call("fixture_note")), h.deps);
    await relayMessage(input(call("fixture_note")), h.deps);
    await relayMessage(input(call("fixture_note"), { thread: "thread-2", threads: ["thread-1"] }), h.deps);
    expect(h.asks.map((ask) => ask.thread)).toEqual(["thread-1", "thread-2"]);
  });

  it("refuses a scripts-only or unknown tool", async () => {
    const h = harness({ modes: { "thread-1": { runtimeMode: "full-access" } } });
    expect(resultOf(await relayMessage(input(call("fixture_script")), h.deps)).isError).toBe(true);
    expect(resultOf(await relayMessage(input(call("nope")), h.deps)).isError).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

const t3Harness = (tools: ReadonlyArray<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean } }>, credential: string | null = "Bearer real-t3") => {
  const posts: Array<McpRpcRequest> = [];
  const asks: Array<{ perCall: boolean }> = [];
  const deps: T3RelayDeps = {
    post: async (request) => {
      posts.push(request);
      const body = JSON.parse(request.body) as { method: string; id?: number; params?: { name?: string } };
      if (body.method === "initialize") return { status: 200, contentType: "application/json", sessionId: "s-1", body: JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }) };
      if (body.method === "tools/list") return { status: 200, contentType: "text/event-stream", body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } })}\n\n` };
      if (body.method === "tools/call") return { status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `t3 ran ${body.params?.name}` }] } }) };
      return { status: 202, contentType: "", body: "" };
    },
    credential: () => credential ?? undefined,
    cache: new Map(),
    now: () => 0,
    states: () => [{ thread: "thread-1", runtimeMode: "approval-required", interactionMode: "default", workspace: "ws-1" }],
    ask: async (input) => {
      asks.push({ perCall: input.perCall });
      return { approved: true };
    },
    accepted: { has: () => false, add: () => undefined },
    log: () => undefined,
  };
  return { deps, posts, asks };
};

describe("t3's tools through the relay (SPI-1039)", () => {
  const TOOLS = [{ name: "t3_thread_list", annotations: { readOnlyHint: true } }, { name: "delegate_task" }, { name: "request_secret" }, { name: "t3_worktree_create" }];

  it("lists only the allowlisted tools and sends t3 its real bearer, never the handle", async () => {
    const t = t3Harness(TOOLS);
    const tools = resultOf(await relayT3Message(input({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { server: "t3" }), t.deps)).tools!;
    expect(tools.map((entry) => entry.name)).toEqual(["t3_thread_list", "delegate_task"]);
    expect(new Set(t.posts.map((post) => post.authorization))).toEqual(new Set(["Bearer real-t3"]));
  });

  it("drops a description's sentence naming a t3 tool not offered (SPI-1060's rule)", async () => {
    const t = t3Harness([{ name: "t3_thread_list", description: "Lists threads. Link one first with `t3_environment_link`.", annotations: { readOnlyHint: true } }]);
    const tools = resultOf(await relayT3Message(input({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { server: "t3" }), t.deps)).tools! as ReadonlyArray<{ description?: string }>;
    expect(tools[0]!.description).toBe("Lists threads.");
  });

  it("runs a read-only tool, asks for a write in approval-required, refuses a tool outside the allowlist", async () => {
    const t = t3Harness(TOOLS);
    expect(resultOf(await relayT3Message(input(call("t3_thread_list"), { server: "t3" }), t.deps)).content).toEqual([{ type: "text", text: "t3 ran t3_thread_list" }]);
    expect(t.asks).toEqual([]);
    await relayT3Message(input(call("delegate_task"), { server: "t3" }), t.deps);
    expect(t.asks).toEqual([{ perCall: false }]);
    expect(resultOf(await relayT3Message(input(call("request_secret"), { server: "t3" }), t.deps)).isError).toBe(true);
    expect(t.posts.filter((post) => post.body.includes("request_secret"))).toEqual([]);
  });

  it("refuses an owner thread's handle outright while the Workspace is tainted (H1), reads included", async () => {
    const t = t3Harness(TOOLS);
    expect(await relayT3Message(input(call("t3_thread_list"), { server: "t3", tainted: true }), t.deps)).toEqual({ kind: "refused", status: 403, message: T3_TAINTED });
    expect(t.posts).toEqual([]);
  });

  it("asks a linked thread per call for t3's writes (M10's one rule)", async () => {
    const t = t3Harness(TOOLS);
    await relayT3Message(input(call("delegate_task"), { server: "t3", linked: true, tainted: true }), t.deps);
    expect(t.asks).toEqual([{ perCall: true }]);
  });

  it("answers that t3's tools are unavailable without a credential", async () => {
    const t = t3Harness(TOOLS, null);
    expect(resultOf(await relayT3Message(input(call("t3_thread_list"), { server: "t3" }), t.deps)).isError).toBe(true);
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

  it("lets only the relay's t3 entry with a handle into Codex's thread config", () => {
    const handle = `Bearer ${"b".repeat(64)}`;
    expect(isRelayedT3Server({ url: "http://computer.internal/t3flare/mcp/t3", http_headers: { Authorization: handle }, tool_timeout_sec: 3900 })).toBe(true);
    expect(isRelayedT3Server({ url: "https://t3.example/mcp", http_headers: { Authorization: handle } })).toBe(false);
    expect(isRelayedT3Server({ url: "http://computer.internal/t3flare/mcp/t3", http_headers: { Authorization: "Bearer t3-real-token" } })).toBe(false);
  });
});

describe("pi's t3 entry (SPI-1039)", () => {
  const handle = "f".repeat(64);
  const pi = (env: Record<string, string>) =>
    profileLaunch(
      { cli: "pi", args: ["--mode", "rpc", "--extension", "/s/ext.ts"], key: "k", cwd: "/w/x", env: { T3_PI_RUNTIME_MODE: "approval-required", ...env }, allowProbe: false },
      { proxyUrl: "https://proxy.example", models: [], readStateFile: () => "SRC", piExtensionSource: "SRC", relay: { handle, servers: [] } },
    );
  it("passes t3's MCP variables only as the relay with this process's handle", () => {
    const ok = pi({ T3_MCP_URL: "http://computer.internal/t3flare/mcp/t3", T3_MCP_BEARER_TOKEN: handle });
    if ("refused" in ok) throw new Error(ok.refused);
    expect(ok.env.T3_MCP_URL).toBe("http://computer.internal/t3flare/mcp/t3");
    const real = pi({ T3_MCP_URL: "https://t3.example/mcp", T3_MCP_BEARER_TOKEN: "t3-real" });
    if ("refused" in real) throw new Error(real.refused);
    expect(real.env.T3_MCP_URL).toBeUndefined();
    expect(real.env.T3_MCP_BEARER_TOKEN).toBeUndefined();
  });
});
