// t3's own tools for CLI agents through the relay (SPI-1039, ADR-0028 with ADR-0022's refinement): a CLI process posts
// to `/t3flare/mcp/t3` with its tool handle; here the handle's thread is swapped for t3's real per-thread bearer, which
// never leaves the Environment DO, and the call goes to t3's `/mcp` over `EnvironmentDO.mcp` as a Session's does. t3's
// own auth, link fence and mode ceiling run unchanged; the relay adds the allowlist (fails closed), the same
// `decideCall` as every other tool (t3's annotation as the class; review M10), and review H1: while the Workspace is
// tainted, an owner thread's handle is refused outright (linked work in the same checkout could have read it).
import { cardText, decideCall, descriptionFor, type McpRelayAnswer, type McpRelayInput, strictestMode, T3_TOOL_ALLOWLIST } from "@t3flare/harness-registry";
import type { McpRpcAnswer, McpRpcRequest } from "@t3flare/session-protocol";

import type { RelayDeps } from "./relay.ts";
import { RELAY_PROTOCOL_VERSIONS } from "./relay.ts";

const T3_PROTOCOL_VERSION = "2025-06-18";
/** How long t3's tool list (for classes) is kept per credential. */
const LIST_TTL_MS = 5 * 60_000;

export interface T3RelayDeps extends Pick<RelayDeps, "states" | "ask" | "accepted" | "log"> {
  /** `EnvironmentDO.mcp`: t3's `/mcp`, never the public host. */
  readonly post: (input: McpRpcRequest) => Promise<McpRpcAnswer>;
  /** t3's real `Authorization` for `thread`'s provider session (`relayedMcp`), or undefined. */
  readonly credential: (thread: string) => string | undefined;
  /** MCP session ids and tool lists by credential (memory). */
  readonly cache: Map<string, { sessionId?: string; tools?: ReadonlyArray<T3Tool>; listedAt?: number; nextId?: number }>;
  readonly now: () => number;
}

export interface T3Tool {
  readonly name: string;
  readonly annotations?: { readonly readOnlyHint?: unknown };
  readonly [key: string]: unknown;
}

interface Message {
  readonly result?: Record<string, unknown> & { readonly tools?: ReadonlyArray<T3Tool> };
  readonly error?: { readonly code: number; readonly message: string };
}

const ok = (id: unknown, result: unknown): McpRelayAnswer => ({ kind: "response", body: { jsonrpc: "2.0", id, result } });
const fail = (id: unknown, code: number, message: string): McpRelayAnswer => ({ kind: "response", body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } });
const toolError = (id: unknown, text: string): McpRelayAnswer => ok(id, { content: [{ type: "text", text }], isError: true });

/** The JSON-RPC message of t3's answer: its JSON body, or its SSE stream's last `data:` event. */
const messageOf = (answer: McpRpcAnswer): Message | undefined => {
  const text = answer.contentType.includes("text/event-stream")
    ? answer.body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== "")
        .at(-1)
    : answer.body;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Message;
  } catch {
    return undefined;
  }
};

export const T3_UNAVAILABLE = "T3's tools are unavailable for this thread now (no live provider session); they come back with the next turn.";
export const T3_TAINTED =
  "While this Workspace carries linked work's taint, t3's tools refuse an owner thread's handle (linked work in this checkout could have read it); the owner clears the taint by trusting the Workspace again.";

/** One request to t3 with `authorization`, initialising its MCP session first (and again once on a 404). */
const request = async (deps: T3RelayDeps, authorization: string, method: string, params: unknown): Promise<McpRpcAnswer> => {
  const entry = deps.cache.get(authorization) ?? {};
  deps.cache.set(authorization, entry);
  const send = async (): Promise<McpRpcAnswer> => {
    if (entry.sessionId === undefined) {
      const init = await deps.post({
        authorization,
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: T3_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t3flare-relay", version: "1" } } }),
      });
      if (init.status !== 200 || init.sessionId === undefined) return init;
      entry.sessionId = init.sessionId;
      await deps.post({ authorization, sessionId: init.sessionId, protocolVersion: T3_PROTOCOL_VERSION, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    }
    entry.nextId = (entry.nextId ?? 0) + 1;
    return deps.post({ authorization, sessionId: entry.sessionId, protocolVersion: T3_PROTOCOL_VERSION, body: JSON.stringify({ jsonrpc: "2.0", id: entry.nextId, method, params }) });
  };
  let answer = await send();
  if (answer.status === 404) {
    delete entry.sessionId;
    answer = await send();
  }
  return answer;
};

/** t3's tools for `authorization`, allowlisted, from the cache when fresh. */
const toolsOf = async (deps: T3RelayDeps, authorization: string, fresh: boolean): Promise<ReadonlyArray<T3Tool> | undefined> => {
  const entry = deps.cache.get(authorization);
  if (!fresh && entry?.tools !== undefined && deps.now() - (entry.listedAt ?? 0) < LIST_TTL_MS) return entry.tools;
  const answer = await request(deps, authorization, "tools/list", {});
  if (answer.status !== 200) return undefined;
  const listed = (messageOf(answer)?.result?.tools ?? []).filter((tool) => typeof tool.name === "string" && T3_TOOL_ALLOWLIST.has(tool.name));
  // SPI-1060's rule for CLI agents too: a description never names a t3 tool this thread is not offered.
  const offered: ReadonlySet<string> = new Set(listed.map((tool) => tool.name));
  const tools = listed.map((tool) => (typeof tool["description"] === "string" ? { ...tool, description: descriptionFor(tool["description"], offered) } : tool));
  const kept = deps.cache.get(authorization) ?? {};
  kept.tools = tools;
  kept.listedAt = deps.now();
  deps.cache.set(authorization, kept);
  return tools;
};

/** One MCP message of a CLI process for t3's own tools. */
export const relayT3Message = async (input: McpRelayInput, deps: T3RelayDeps): Promise<McpRelayAnswer> => {
  const message = input.message as { id?: unknown; method?: unknown; params?: unknown };
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : undefined;
  if (input.tainted && !input.linked) {
    deps.log({ t3flare: "mcp-relay-t3-refused", workspace: input.workspace, thread: input.thread, cli: input.cli, why: "tainted" });
    return { kind: "refused", status: 403, message: T3_TAINTED };
  }
  if (method === undefined) return id === undefined ? { kind: "accepted" } : fail(id, -32600, "not a request");
  if (id === undefined || id === null) return { kind: "accepted" };
  if (method === "initialize") {
    const asked = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    return ok(id, {
      protocolVersion: typeof asked === "string" && RELAY_PROTOCOL_VERSIONS.includes(asked) ? asked : T3_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "t3-code", version: "t3flare-relay" },
    });
  }
  if (method === "ping") return ok(id, {});
  const authorization = deps.credential(input.thread);
  if (authorization === undefined) return method === "tools/call" ? toolError(id, T3_UNAVAILABLE) : method === "tools/list" ? ok(id, { tools: [] }) : fail(id, -32601, `method ${method} is not offered`);
  if (method === "tools/list") {
    const tools = await toolsOf(deps, authorization, true);
    return ok(id, { tools: tools ?? [] });
  }
  if (method !== "tools/call") return fail(id, -32601, `method ${method} is not offered by the relay`);
  const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== "string") return fail(id, -32602, "tools/call needs a tool name");
  // Fails closed (ADR-0022): a tool t3 adds is not offered until a bump adds it to the allowlist.
  if (!T3_TOOL_ALLOWLIST.has(params.name)) return toolError(id, `${params.name} is not one of t3's tools offered here.`);
  const tool = (await toolsOf(deps, authorization, false))?.find((candidate) => candidate.name === params.name);
  if (tool === undefined) return toolError(id, `t3 offers no tool ${params.name} to this thread.`);
  const readOnly = tool.annotations?.readOnlyHint === true;
  const states = deps.states(input.threads).filter((state) => state.workspace === null || state.workspace === input.workspace);
  const { mode, interaction } = strictestMode(states.length === 0 ? [{ runtimeMode: undefined, interactionMode: undefined }] : states);
  const acceptKey = `t3/${tool.name}`;
  const verdict = decideCall({ class: readOnly ? "read" : "write", mode, interaction, linked: input.linked, accepted: deps.accepted.has(input.thread, acceptKey) });
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    deps.log({ t3flare: "mcp-relay-call", workspace: input.workspace, thread: input.thread, cli: input.cli, server: "t3", tool: tool.name, class: readOnly ? "read" : "write", mode, interaction, linked: input.linked, outcome, ...extra });
  if (verdict.kind === "refuse") {
    log("refused");
    return toolError(id, verdict.reason);
  }
  const args = params.arguments ?? {};
  if (verdict.kind === "ask") {
    const answer = await deps.ask({
      thread: input.thread,
      linked: input.linked,
      perCall: verdict.perCall,
      askId: input.askId,
      title: cardText(`Allow t3: ${tool.name}?`, 200),
      summary: cardText(`${tool.name} ${JSON.stringify(args, null, 2)}`),
      detail: `t3's own tool, called by ${input.cli}.${verdict.perCall ? " Linked work's write: this answer covers this call only." : ""}`,
    });
    if (!answer.approved) {
      log("declined", { reason: answer.reason ?? null });
      return toolError(id, `Not run: the owner did not approve this call (${answer.reason ?? "declined"}).`);
    }
    if (answer.forSession === true && !verdict.perCall) deps.accepted.add(input.thread, acceptKey);
    log("approved");
  } else log("run");
  const answer = await request(deps, authorization, "tools/call", { name: tool.name, arguments: args });
  if (answer.status === 401) return toolError(id, T3_UNAVAILABLE);
  if (answer.status !== 200) return toolError(id, `T3 answered HTTP ${answer.status}.`);
  const reply = messageOf(answer);
  if (reply?.error !== undefined) return fail(id, reply.error.code, reply.error.message);
  return ok(id, reply?.result ?? { content: [], isError: true });
};
