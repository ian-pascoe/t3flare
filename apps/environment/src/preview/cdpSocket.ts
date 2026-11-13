// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
// A Browser Run browser's browser-level CDP WebSocket (G11, ADR-0031), as `--remote-debugging-pipe` would give it: one
// socket, flattened target sessions, JSON text messages. Acquired with the options t3flare always uses (`acquireOptions`)
// and never with `recording` or a Live View link (review L5).
import type { BrowserRunBinding, BrowserRunFetcher } from "./browserRun.ts";
import { BROWSER_KEEP_ALIVE_MS } from "./browserRun.ts";

/** The WebSocket end workerd hands back from an upgrade: accepted before use. */
export interface CdpWebSocket {
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export interface AcquireInput {
  /** The Container preview routes (`http://<port>.t3flare.internal` → the Workspace's entrypoint); none for HTML work. */
  readonly outboundByHost?: Readonly<Record<string, BrowserRunFetcher>>;
  readonly keepAliveMs?: number;
}

/** What every acquire passes Browser Run, and nothing else: no `recording`, no Live View (L5). */
export const acquireOptions = (input: AcquireInput) => ({
  keepAlive: input.keepAliveMs ?? BROWSER_KEEP_ALIVE_MS,
  ...(input.outboundByHost === undefined ? {} : { outboundByHost: { ...input.outboundByHost } }),
});

/** Acquire a browser and open its CDP socket; the caller closes the session (`binding.closeSession`). */
export const openCdpSocket = async (
  binding: BrowserRunBinding,
  input: AcquireInput,
): Promise<{ readonly sessionId: string; readonly socket: CdpWebSocket }> => {
  const connection = await binding.launch(acquireOptions(input) as never);
  try {
    const response = await connection.webSocket.fetch("https://browser-binding.invalid", { headers: { Upgrade: "websocket" } });
    const socket = (response as unknown as { webSocket: CdpWebSocket | null }).webSocket;
    if (socket === null) throw new Error("Browser Run did not return a WebSocket");
    socket.accept();
    return { sessionId: connection.sessionId, socket };
  } catch (cause) {
    await binding.closeSession(connection.sessionId).catch(() => undefined);
    throw cause;
  }
};

/** A minimal CDP client over such a socket: commands by id, events by method (and flattened session). */
export class CdpClient {
  readonly #socket: CdpWebSocket;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Set<(method: string, params: unknown, sessionId: string | undefined) => void>();
  #nextId = 0;
  #closed = false;

  constructor(socket: CdpWebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#receive(event.data));
    const onClose = () => {
      this.#closed = true;
      for (const waiter of this.#pending.values()) waiter.reject(new Error("CDP socket closed"));
      this.#pending.clear();
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<A = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<A> {
    if (this.#closed) return Promise.reject(new Error("CDP socket closed"));
    const id = ++this.#nextId;
    return new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as A);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  on(listener: (method: string, params: unknown, sessionId: string | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close(1000, "done");
    } catch {
      // Already closed.
    }
  }

  #receive(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    let message: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message: string } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.method !== undefined) for (const listener of this.#listeners) listener(message.method, message.params, message.sessionId);
  }
}
