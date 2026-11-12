// The CLI agents' MCP relay (ADR-0028, plan §3.2), in `WorkspaceProxy`: a CLI process in the Container posts MCP
// messages to `computer.internal/t3flare/mcp/<server>` with its tool handle as the bearer. This handler checks the
// request's shape and hands one JSON-RPC message to the Workspace DO, which resolves the handle and asks the Environment
// DO; nothing of the request but the message goes on (no header, no key). Pure, deps injected.
import { MCP_RELAY_PREFIX, type McpRelayAnswer } from "@t3flare/harness-registry";

/** Requests from the Container are capped (plan §3.2). */
export const MAX_RELAY_BYTES = 1024 * 1024;

export interface RelayDeps {
  /** The Workspace DO's `mcpRelay`. May hold the request while the owner is asked. */
  readonly relay: (input: { readonly handle: string | null; readonly server: string; readonly message: unknown; readonly askId: string }) => Promise<McpRelayAnswer>;
  /** The CLI went away while its call was asked: the card is withdrawn. */
  readonly cancel: (askId: string) => void;
  readonly newId: () => string;
}

const PATH = /^\/t3flare\/mcp\/([a-z0-9-]{1,20})$/;

const plain = (status: number, message: string, extra: Record<string, string> = {}): Response =>
  new Response(`t3flare: ${message}\n`, { status, headers: { "content-type": "text/plain", "cache-control": "no-store", ...extra } });

const jsonRpcError = (id: unknown, code: number, message: string): Response =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: 200, headers: { "cache-control": "no-store" } });

const bearerOf = (headers: Headers): string | null => {
  const value = headers.get("authorization");
  if (value === null) return null;
  const match = /^Bearer ([0-9a-f]{64})$/.exec(value.trim());
  return match === null ? null : match[1]!;
};

/** Reads at most `MAX_RELAY_BYTES` of the body, or null when it is larger. */
const readCapped = async (request: Request): Promise<string | null> => {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RELAY_BYTES) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RELAY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
};

export const isRelayPath = (pathname: string): boolean => pathname.startsWith(MCP_RELAY_PREFIX);

/**
 * One relay request. Streamable HTTP without a server stream: `POST` a message, answered as one JSON body (or 202 for a
 * notification); `GET` (the optional SSE stream) and `DELETE` are 405, which the transport allows.
 */
export const handleRelayRequest = async (request: Request, deps: RelayDeps): Promise<Response> => {
  const match = PATH.exec(new URL(request.url).pathname);
  if (match === null) return plain(404, "not an MCP relay path");
  const server = match[1]!;
  if (request.method !== "POST") return plain(405, "only POST", { allow: "POST" });
  const handle = bearerOf(request.headers);
  if (handle === null) return plain(401, "the relay needs this process's tool handle as its bearer");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return plain(415, "MCP messages are JSON");
  const text = await readCapped(request);
  if (text === null) return plain(413, `MCP messages over ${MAX_RELAY_BYTES} bytes are refused`);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) return jsonRpcError(null, -32600, "one JSON-RPC message per request (no batches)");
  const askId = deps.newId();
  const onAbort = () => deps.cancel(askId);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  let answer: McpRelayAnswer;
  try {
    answer = await deps.relay({ handle, server, message, askId });
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
  if (answer.kind === "refused") return plain(answer.status, answer.message);
  if (answer.kind === "accepted") return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  return Response.json(answer.body, { status: 200, headers: { "cache-control": "no-store" } });
};
