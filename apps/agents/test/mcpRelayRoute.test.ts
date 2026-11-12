// The relay route in `WorkspaceProxy` (ADR-0028): only POSTed single JSON-RPC messages with a tool handle reach the
// Workspace DO; nothing else of the request goes on, and a CLI that goes away withdraws its card.
import type { McpRelayAnswer } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { handleRelayRequest, MAX_RELAY_BYTES, type RelayDeps } from "../src/workspace/mcpRelay.ts";

const HANDLE = "e".repeat(64);
const URL_ = "http://computer.internal/t3flare/mcp/commissary";

const deps = (answer: McpRelayAnswer = { kind: "response", body: { jsonrpc: "2.0", id: 1, result: {} } }) => {
  const seen: Array<Parameters<RelayDeps["relay"]>[0]> = [];
  const cancelled: Array<string> = [];
  const value: RelayDeps = {
    relay: async (input) => {
      seen.push(input);
      return answer;
    },
    cancel: (askId) => void cancelled.push(askId),
    newId: () => "ask-1",
  };
  return { value, seen, cancelled };
};

const post = (body: string, headers: Record<string, string> = {}, url = URL_) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${HANDLE}`, ...headers }, body });

describe("the MCP relay route", () => {
  it("passes one message with the handle and the server, and answers its JSON", async () => {
    const d = deps();
    const response = await handleRelayRequest(post('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', { "x-other": "y" }), d.value);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(d.seen).toEqual([{ handle: HANDLE, server: "commissary", message: { jsonrpc: "2.0", id: 1, method: "tools/list" }, askId: "ask-1" }]);
  });

  it("answers a notification 202 and a refusal with its status", async () => {
    expect((await handleRelayRequest(post('{"jsonrpc":"2.0","method":"notifications/initialized"}'), deps({ kind: "accepted" }).value)).status).toBe(202);
    expect((await handleRelayRequest(post('{"jsonrpc":"2.0","id":1,"method":"ping"}'), deps({ kind: "refused", status: 401, message: "unknown tool handle" }).value)).status).toBe(401);
  });

  it("refuses without a handle, other methods, other paths, batches, non-JSON and oversized bodies", async () => {
    const d = deps();
    expect((await handleRelayRequest(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), d.value)).status).toBe(401);
    expect((await handleRelayRequest(post("{}", { authorization: "Bearer not-a-handle" }), d.value)).status).toBe(401);
    expect((await handleRelayRequest(new Request(URL_, { method: "GET", headers: { authorization: `Bearer ${HANDLE}` } }), d.value)).status).toBe(405);
    expect((await handleRelayRequest(post("{}", {}, "http://computer.internal/t3flare/mcp/../model-key"), d.value)).status).toBe(404);
    expect((await handleRelayRequest(post("{}", { "content-type": "text/plain" }), d.value)).status).toBe(415);
    expect(await (await handleRelayRequest(post("[]"), d.value)).json()).toMatchObject({ error: { code: -32600 } });
    expect(await (await handleRelayRequest(post("{"), d.value)).json()).toMatchObject({ error: { code: -32700 } });
    expect((await handleRelayRequest(post(`{"x":"${"a".repeat(MAX_RELAY_BYTES)}"}`), d.value)).status).toBe(413);
    expect(d.seen).toEqual([]);
  });

  it("withdraws the card when the CLI goes away", async () => {
    const abort = new AbortController();
    const d = deps();
    const held: RelayDeps = {
      ...d.value,
      relay: () => new Promise((resolve) => (abort.signal.aborted ? resolve({ kind: "accepted" }) : abort.signal.addEventListener("abort", () => resolve({ kind: "accepted" })))),
    };
    const request = new Request(URL_, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${HANDLE}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}', signal: abort.signal });
    const pending = handleRelayRequest(request, held);
    abort.abort();
    await pending;
    expect(d.cancelled).toEqual(["ask-1"]);
  });
});
