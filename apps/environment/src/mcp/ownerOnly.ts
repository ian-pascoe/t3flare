// An MCP server's question is the owner's to answer (SPI-1079, cloudpid ADR-0041's first rule as ported). Its approval
// cards cannot be answered by an agent (t3's `t3_pending_request` answers `user_input` requests only), but its form cards
// are `user_input` requests, which t3 lets an agent answer, and even tells a parent agent to (a delegated child's
// question). So every request to t3's own `/mcp` (a CLI's, a linked laptop's, and a Durable Session's through
// `EnvironmentDO.mcp`) is read here first: a `t3_pending_request` naming a card of ours (its id carries
// `MCP_QUESTION_MARKER`) is answered with a tool error, and t3 never sees it. `list` still lists the id (t3's answer);
// `read` and `respond` on it are refused.
import { MCP_QUESTION_MARKER } from "@t3flare/session-protocol";

export const OWNER_ONLY_REFUSAL =
  "Refused: this question comes from an MCP server, and only the owner answers it, on its card in a t3 client. Tell the owner it is waiting; do not answer it for them.";

const isOurs = (message: unknown): boolean => {
  if (typeof message !== "object" || message === null) return false;
  const { method, params } = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (method !== "tools/call" || params?.name !== "t3_pending_request") return false;
  const args = (params.arguments ?? {}) as { action?: unknown; requestId?: unknown };
  return args.action !== "list" && typeof args.requestId === "string" && args.requestId.includes(MCP_QUESTION_MARKER);
};

/**
 * The JSON-RPC answer refusing `body` (one message or a batch) when it calls `t3_pending_request` on an MCP question's
 * card; undefined when t3 may have it. A batch with one such call is refused whole.
 */
export const refuseOwnerOnly = (body: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (!messages.some(isOurs)) return undefined;
  const answers = messages
    .filter((message): message is { id: unknown } => typeof message === "object" && message !== null && "id" in message)
    .map((message) => ({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: OWNER_ONLY_REFUSAL }], isError: true } }));
  return JSON.stringify(Array.isArray(parsed) ? answers : answers[0]);
};
