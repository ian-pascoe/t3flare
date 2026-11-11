// The Session's MCP client over a fake `EnvironmentDO.mcp`: one initialisation per credential, a 404 initialises
// again, a new credential gets its own MCP session, a 401 is "unavailable", and an SSE answer reads like a JSON one.
import type { McpRpcAnswer, McpRpcRequest, T3McpCredential } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { T3McpClient, UNAVAILABLE } from "../src/session/t3McpClient.ts";

const json = (status: number, body: unknown, sessionId?: string): McpRpcAnswer => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
  ...(sessionId === undefined ? {} : { sessionId }),
});

const fakeEnvironment = () => {
  const seen: Array<McpRpcRequest & { readonly method?: string }> = [];
  const live = new Set<string>();
  let sessions = 0;
  let unauthorized = false;
  const post = async (input: McpRpcRequest): Promise<McpRpcAnswer> => {
    const body = JSON.parse(input.body) as { method?: string };
    seen.push({ ...input, ...(body.method === undefined ? {} : { method: body.method }) });
    if (unauthorized) return json(401, { error: "invalid_token" });
    if (body.method === "initialize") {
      const id = `mcp-${++sessions}`;
      live.add(id);
      return json(200, { jsonrpc: "2.0", id: 0, result: {} }, id);
    }
    if (input.sessionId === undefined || !live.has(input.sessionId)) return json(404, {});
    if (body.method === "tools/list") return json(200, { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "t3_thread_read" }] } });
    return { status: 200, contentType: "text/event-stream", body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hi" }] } })}\n\n` };
  };
  return {
    post,
    seen,
    restart: () => live.clear(),
    revoke: () => {
      unauthorized = true;
    },
  };
};

const credential = (n: number): T3McpCredential => ({ authorization: `Bearer token-${n}`, providerSessionId: `ps-${n}`, instructions: "" });

describe("the Session's MCP client", () => {
  it("initialises once, lists and calls, and reads an SSE answer", async () => {
    const environment = fakeEnvironment();
    const client = new T3McpClient(environment.post, () => credential(1));
    expect(await client.listTools()).toEqual([{ name: "t3_thread_read" }]);
    expect(await client.callTool("t3_thread_read", {})).toEqual({ kind: "result", text: "hi", isError: false });
    expect(environment.seen.filter((r) => r.method === "initialize").length).toBe(1);
    expect(environment.seen.every((r) => r.authorization === "Bearer token-1")).toBe(true);
  });

  it("initialises again after a 404 (the Environment restarted) and for a new credential", async () => {
    const environment = fakeEnvironment();
    let current = credential(1);
    const client = new T3McpClient(environment.post, () => current);
    await client.callTool("t3_thread_read", {});
    environment.restart();
    expect((await client.callTool("t3_thread_read", {})).kind).toBe("result");
    current = credential(2);
    await client.callTool("t3_thread_read", {});
    expect(environment.seen.filter((r) => r.method === "initialize").length).toBe(3);
  });

  it("a 401 or no credential is 'unavailable'", async () => {
    const environment = fakeEnvironment();
    environment.revoke();
    expect(await new T3McpClient(environment.post, () => credential(1)).callTool("t3_thread_read", {})).toEqual({ kind: "unavailable", message: UNAVAILABLE });
    expect((await new T3McpClient(environment.post, () => undefined).callTool("t3_thread_read", {})).kind).toBe("unavailable");
  });
});
