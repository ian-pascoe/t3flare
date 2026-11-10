// @effect-diagnostics globalDate:off
// A passive tap on each RPC WebSocket, for the step 0 check "the streams the client
// subscribes to at connect, and whether each emits a first value". It reads Effect RPC's
// JSON frames (Request, Chunk, Exit) without changing them.
import type { WebSocket as CfWebSocket } from "@cloudflare/workers-types/index.ts";

export interface RpcCall {
  readonly socket: number;
  readonly id: string;
  readonly tag: string;
  readonly at: number;
  firstValueMs: number | null;
  exit: string | null;
  chunks: number;
}

let nextSocket = 0;
const MAX_CALLS = 500;
export const rpcCalls: Array<RpcCall> = [];
export const sockets: Array<{ id: number; openedAt: number; closedAt: number | null }> = [];

const decoder = new TextDecoder();
const messagesOf = (data: unknown): Array<any> => {
  try {
    const text = typeof data === "string" ? data : decoder.decode(data as Uint8Array);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
};

export const tap = (ws: CfWebSocket): CfWebSocket => {
  const socket = nextSocket++;
  sockets.push({ id: socket, openedAt: Date.now(), closedAt: null });
  ws.addEventListener("close", () => {
    const entry = sockets.find((s) => s.id === socket);
    if (entry) entry.closedAt = Date.now();
  });
  const calls = new Map<string, RpcCall>();
  ws.addEventListener("message", (event) => {
    for (const message of messagesOf(event.data)) {
      if (message?._tag !== "Request") continue;
      const call: RpcCall = { socket, id: String(message.id), tag: String(message.tag), at: Date.now(), firstValueMs: null, exit: null, chunks: 0 };
      calls.set(call.id, call);
      rpcCalls.push(call);
      if (rpcCalls.length > MAX_CALLS) rpcCalls.shift();
    }
  });
  const send = ws.send.bind(ws);
  ws.send = (data: string | ArrayBuffer | ArrayBufferView) => {
    for (const message of messagesOf(data)) {
      const call = calls.get(String(message?.requestId));
      if (call === undefined) continue;
      if (message._tag === "Chunk") {
        call.chunks += Array.isArray(message.values) ? message.values.length : 1;
        call.firstValueMs ??= Date.now() - call.at;
      } else if (message._tag === "Exit") {
        call.exit = message.exit?._tag ?? "unknown";
        if (message.exit?._tag === "Success") call.firstValueMs ??= Date.now() - call.at;
      }
    }
    send(data as never);
  };
  return ws;
};
