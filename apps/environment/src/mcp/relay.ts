// The CLI relay's MCP server (ADR-0028, plan §3.2–3.4): one JSON-RPC message of a CLI process, its caller already
// resolved from the tool handle by the Workspace DO. The relay terminates MCP: the CLI talks to this server, which lists
// and calls through the MCP host as a Session does, with the same `decideCall`; a write that asks raises t3's card on
// the calling thread (`approveCliTool`) while the HTTP request is held.
//
// Hand-written rather than the SDK's server (plan §3.2 named `McpRelayServer` in the MCP Worker): stateless, tools
// only, never an elicitation, so `initialize`, `ping`, `tools/list` and `tools/call` are the whole surface, and the MCP
// Worker keeps no inbound entrypoint.
import { cardText, decideCall, type McpRelayAnswer, type McpRelayInput, strictestMode, type ToolClass } from "@t3flare/harness-registry";

import type { McpCallAnswer, McpView } from "./host.ts";

/** Protocol versions the relay speaks; it answers with the client's when it knows it. */
export const RELAY_PROTOCOL_VERSIONS: ReadonlyArray<string> = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface RelayDeps {
  readonly view: (input: { readonly linked: boolean }) => Promise<McpView>;
  readonly call: (input: { readonly server: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly linked: boolean; readonly judged: ToolClass }) => Promise<McpCallAnswer>;
  /** The live threads' modes, by thread (review M7). */
  readonly states: (threads: ReadonlyArray<string>) => ReadonlyArray<{ readonly thread: string; readonly runtimeMode: string | undefined; readonly interactionMode: string | undefined; readonly workspace: string | null }>;
  readonly ask: (input: { readonly thread: string; readonly linked: boolean; readonly perCall: boolean; readonly askId: string; readonly title: string; readonly summary: string; readonly detail: string }) => Promise<{ readonly approved: boolean; readonly forSession?: boolean; readonly reason?: string }>;
  /** "Accept for the session" by thread, keyed by server, upstream name and definition hash. */
  readonly accepted: { has(thread: string, key: string): boolean; add(thread: string, key: string): void };
  readonly log: (event: Record<string, unknown>) => void;
}

const ok = (id: unknown, result: unknown): McpRelayAnswer => ({ kind: "response", body: { jsonrpc: "2.0", id, result } });
const fail = (id: unknown, code: number, message: string): McpRelayAnswer => ({ kind: "response", body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } });
const toolError = (id: unknown, text: string): McpRelayAnswer => ok(id, { content: [{ type: "text", text }], isError: true });

/** Tools a CLI may call: the view's, without the owner's hidden ones and the scripts-only ones (review M10). */
const offered = (view: McpView, server: string) => {
  const entry = view.servers.find((candidate) => candidate.name === server);
  return entry === undefined ? undefined : { ...entry, tools: entry.tools.filter((tool) => tool.exposure !== "hidden" && tool.exposure !== "codemode") };
};

/** One MCP message from a CLI process (a server other than t3's own). */
export const relayMessage = async (input: McpRelayInput, deps: RelayDeps): Promise<McpRelayAnswer> => {
  const message = input.message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : undefined;
  if (method === undefined) return id === undefined ? { kind: "accepted" } : fail(id, -32600, "not a request");
  if (id === undefined || id === null) return { kind: "accepted" };
  // Review H1: a caller in a tainted Workspace is judged as linked (every write asks, per call). Which servers it sees
  // stays its thread's (review M13's switch is about linked threads).
  const linked = input.linked || input.tainted;
  const offeredTo = { linked: input.linked };
  switch (method) {
    case "initialize": {
      const asked = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = typeof asked === "string" && RELAY_PROTOCOL_VERSIONS.includes(asked) ? asked : RELAY_PROTOCOL_VERSIONS[1]!;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `t3flare-${input.server}`, version: "1" },
        instructions: `Tools of the MCP server "${input.server}" through t3flare. Write tools may wait for the owner's approval on this thread.`,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list": {
      const server = offered(await deps.view(offeredTo), input.server);
      if (server === undefined) return ok(id, { tools: [] });
      return ok(id, {
        tools: server.tools.map((tool) => ({
          name: tool.upstream,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.class === "read" },
        })),
      });
    }
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") return fail(id, -32602, "tools/call needs a tool name");
      const args = params.arguments === undefined ? {} : params.arguments;
      if (args === null || typeof args !== "object" || Array.isArray(args)) return fail(id, -32602, "arguments must be an object");
      const server = offered(await deps.view(offeredTo), input.server);
      const tool = server?.tools.find((candidate) => candidate.upstream === params.name);
      if (server === undefined || tool === undefined) return toolError(id, `${input.server} offers no tool ${params.name} to this thread.`);
      const states = deps.states(input.threads).filter((state) => state.workspace === null || state.workspace === input.workspace);
      const { mode, interaction } = strictestMode(states.length === 0 ? [{ runtimeMode: undefined, interactionMode: undefined }] : states);
      const acceptKey = `${input.server}/${tool.upstream}@${tool.hash}`;
      const verdict = decideCall({ class: tool.class, mode, interaction, linked, accepted: deps.accepted.has(input.thread, acceptKey) });
      const log = (outcome: string, extra: Record<string, unknown> = {}) =>
        deps.log({ t3flare: "mcp-relay-call", workspace: input.workspace, thread: input.thread, cli: input.cli, server: input.server, tool: tool.upstream, class: tool.class, mode, interaction, linked: input.linked, tainted: input.tainted, outcome, ...extra });
      if (verdict.kind === "refuse") {
        log("refused");
        return toolError(id, verdict.reason);
      }
      if (verdict.kind === "ask") {
        const answer = await deps.ask({
          thread: input.thread,
          linked: input.linked,
          perCall: verdict.perCall,
          askId: input.askId,
          title: cardText(`Allow ${input.server}: ${tool.upstream}?`, 200),
          summary: cardText(`${input.server}: ${tool.upstream}\n${JSON.stringify(args, null, 2)}`),
          detail: `A ${tool.class} tool (${server.kind === "commissary" ? "Commissary's class" : "class set in the harness panel"}${tool.unconfirmed === true ? "; its definition changed since" : ""}), called by ${input.cli}.${
            verdict.perCall ? (input.tainted && !input.linked ? " This Workspace carries linked work's taint: this answer covers this call only." : " Linked work's write: this answer covers this call only.") : ""
          }`,
        });
        if (!answer.approved) {
          log("declined", { reason: answer.reason ?? null });
          return toolError(id, `Not run: the owner did not approve this call (${answer.reason ?? "declined"}).`);
        }
        if (answer.forSession === true && !verdict.perCall) deps.accepted.add(input.thread, acceptKey);
        log("approved", { forSession: answer.forSession === true });
      } else log("run");
      const result = await deps.call({ server: input.server, tool: tool.upstream, args: args as Record<string, unknown>, linked: input.linked, judged: tool.class });
      if (result.kind === "unavailable") return toolError(id, result.message);
      return ok(id, { content: [{ type: "text", text: result.text }], isError: result.isError });
    }
    default:
      return fail(id, -32601, `method ${method} is not offered by the relay`);
  }
};
