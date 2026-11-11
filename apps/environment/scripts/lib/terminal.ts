// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off anyUnknownInErrorContext:off globalDateInEffect:off globalRandom:off
// A headless client of t3's terminal (step 2b): `terminal.attach` streamed on one /ws socket, with writes, resizes and
// closes on the same client, as the web client's terminal drawer does.
import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";

import { protocol, sleep } from "./client.ts";

// biome-ignore lint: control characters are the point
// oxlint-disable-next-line no-control-regex
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\r/g, "");

export interface TerminalEventLike {
  readonly type: string;
  readonly data?: string;
  readonly exitCode?: number | null;
  readonly snapshot?: { readonly history?: string; readonly status?: string; readonly pid?: number | null };
}

export interface TerminalSession {
  readonly events: Array<{ readonly at: number; readonly event: TerminalEventLike }>;
  /** Everything output so far (snapshot history first). */
  output(): string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(deleteHistory?: boolean): Promise<void>;
  /** Waits until the output since `from` matches. */
  until(pattern: RegExp, timeoutMs?: number, from?: number): Promise<{ readonly ms: number; readonly text: string }>;
  /** Types a command and waits for a sentinel its typed echo cannot contain. */
  run(command: string, timeoutMs?: number): Promise<{ readonly ms: number; readonly text: string }>;
  /** Detaches (closes the socket); the terminal stays. */
  detach(): Promise<void>;
}

export const attachTerminal = async (
  cookie: string,
  input: { readonly threadId: string; readonly terminalId: string; readonly cwd?: string; readonly cols?: number; readonly rows?: number; readonly resume?: boolean; readonly env?: Record<string, string> },
): Promise<TerminalSession> => {
  const events: Array<{ at: number; event: TerminalEventLike }> = [];
  let text = "";
  let resolveClient: (client: Record<string, (input: unknown) => any>) => void = () => undefined;
  const clientReady = new Promise<Record<string, (input: unknown) => any>>((resolve) => (resolveClient = resolve));
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const done = Effect.runPromise(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<string, (input: unknown) => any>;
      resolveClient(client);
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(client["terminal.attach"]!({ cols: 100, rows: 30, ...input }) as Stream.Stream<TerminalEventLike, unknown>, (event) =>
          Effect.sync(() => {
            events.push({ at: Date.now(), event });
            if (event.type === "snapshot" && event.snapshot?.history !== undefined) text += event.snapshot.history;
            if (event.type === "output" && event.data !== undefined) text += event.data;
          }),
        ),
      );
      yield* Effect.promise(() => stopped);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped),
  );
  const client = await clientReady;
  const call = (method: string, payload: unknown) => Effect.runPromise(client[method]!(payload) as Effect.Effect<unknown, unknown>).then(() => undefined);
  const session: TerminalSession = {
    events,
    output: () => text,
    write: (data) => call("terminal.write", { threadId: input.threadId, terminalId: input.terminalId, data }),
    resize: (cols, rows) => call("terminal.resize", { threadId: input.threadId, terminalId: input.terminalId, cols, rows }),
    close: (deleteHistory = false) => call("terminal.close", { threadId: input.threadId, terminalId: input.terminalId, deleteHistory }),
    until: async (pattern, timeoutMs = 30_000, from = 0) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const tail = stripAnsi(text.slice(from));
        if (pattern.test(tail)) return { ms: Date.now() - started, text: tail };
        await sleep(10);
      }
      throw new Error(`timed out waiting for ${pattern}; output tail: ${JSON.stringify(text.slice(-300))}`);
    },
    run: async (command, timeoutMs = 30_000) => {
      const from = text.length;
      const token = Math.floor(Math.random() * 1e9);
      await session.write(`${command}; echo T3D$((${token}+1))\r`);
      return session.until(new RegExp(`T3D${token + 1}`), timeoutMs, from);
    },
    detach: async () => {
      stop();
      await done.catch(() => undefined);
    },
  };
  return session;
};
