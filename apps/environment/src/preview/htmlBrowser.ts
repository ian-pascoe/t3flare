// @effect-diagnostics asyncFunction:off globalTimers:off globalDate:off globalConsole:off effectFnOpportunity:off
// t3's HTML renders' browser (G11's M1, ADR-0031): stock `htmlRender/headlessChrome.ts`, unchanged, spawns Chrome with
// `--remote-debugging-pipe` (CDP on fd 3 in and fd 4 out, NUL-delimited) at the path `PreviewBrowser` gives it. Here
// that path is `HTML_BROWSER_EXECUTABLE` (our `PreviewBrowser` Layer), and our process router answers it with this
// bridge to a route-less Browser Run browser, so stock's guards (the main frame pinned to t3's page, every other
// document navigation failed, WebRTC deleted) keep running as upstream wrote them.
//
// - **Route-less**: the browser has no `outboundByHost`, so a page under check reaches no Container, and Browser Run's
//   own egress stands in for stock's SOCKS proxy (`publicProxy.ts`, Shadowed to a no-op).
// - **t3's page origin**: Browser Run refuses `*.localhost` by policy, Fetch interception or not (M0), so the bridge
//   rewrites `http://t3-page.localhost` to `https://t3-page.t3flare.internal` in what t3 sends and back in what it reads.
//   The page is still fulfilled by t3 through `Fetch.fulfillRequest`, never fetched; https keeps it a secure context.
// - **One shared browser**: renders connect to one Browser Run session, closed 60 s after its last connection ends. A
//   render's `Browser.close` is answered here and closes only the contexts that render made.
// - `--version` (stock's missing-library check) is answered without a browser.
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as ChildProcess from "effect/process/ChildProcess";

import type { BrowserRunBinding } from "./browserRun.ts";
import type { CdpWebSocket } from "./cdpSocket.ts";
import { openCdpSocket } from "./cdpSocket.ts";
import type { PreviewStore } from "./store.ts";

/** What our `PreviewBrowser` Layer names as Chrome: no file, only this bridge answers it. */
export const HTML_BROWSER_EXECUTABLE = "/opt/t3flare/browser-run/chrome-headless-shell";

/** Stock's page origin (`headlessChrome.ts` `PAGE_ORIGIN`), and the one Browser Run lets the page have. */
export const STOCK_PAGE_ORIGIN = "http://t3-page.localhost";
export const BRIDGED_PAGE_ORIGIN = "https://t3-page.t3flare.internal";

/** How long the shared browser stays after its last render. */
export const HTML_BROWSER_IDLE_MS = 60_000;

export const toBrowser = (message: string): string => message.replaceAll(STOCK_PAGE_ORIGIN, BRIDGED_PAGE_ORIGIN);
export const fromBrowser = (message: string): string => message.replaceAll(BRIDGED_PAGE_ORIGIN, STOCK_PAGE_ORIGIN);

export interface HtmlBrowserDeps {
  readonly binding: () => BrowserRunBinding | undefined;
  readonly store: () => PreviewStore;
}

/** The shared route-less browser: one Browser Run session, and how many renders hold a connection to it. */
class SharedHtmlBrowser {
  #session: Promise<string> | undefined;
  #holders = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;

  async connect(deps: HtmlBrowserDeps): Promise<{ readonly socket: CdpWebSocket; readonly release: () => void }> {
    const binding = deps.binding();
    if (binding === undefined) throw new Error("Browser Run is not bound here");
    clearTimeout(this.#idle);
    this.#holders++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#holders--;
      if (this.#holders === 0) this.#idle = setTimeout(() => void this.close(deps), HTML_BROWSER_IDLE_MS);
    };
    try {
      for (let attempt = 0; ; attempt++) {
        const fresh = this.#session === undefined;
        this.#session ??= this.#acquire(binding, deps);
        const sessionId = await this.#session;
        if (fresh) {
          // The first connection is the acquire's own.
          const socket = this.#firstSocket;
          this.#firstSocket = undefined;
          if (socket !== undefined) return { socket, release };
        }
        try {
          const connection = await binding.connectSession(sessionId);
          const response = await connection.webSocket.fetch("https://browser-binding.invalid", { headers: { Upgrade: "websocket" } });
          const socket = (response as unknown as { webSocket: CdpWebSocket | null }).webSocket;
          if (socket === null) throw new Error("Browser Run did not return a WebSocket");
          socket.accept();
          return { socket, release };
        } catch (cause) {
          // Browser Run closed the session (its keep-alive, a release): acquire another, once.
          this.#forget(sessionId, deps);
          if (attempt > 0) throw cause;
        }
      }
    } catch (cause) {
      release();
      throw cause;
    }
  }

  #firstSocket: CdpWebSocket | undefined;

  async #acquire(binding: BrowserRunBinding, deps: HtmlBrowserDeps): Promise<string> {
    try {
      const { sessionId, socket } = await openCdpSocket(binding, { keepAliveMs: HTML_BROWSER_IDLE_MS * 2 });
      deps.store().sessionOpened({ id: sessionId, kind: "html", workspace: null, openedAt: Date.now() });
      this.#firstSocket = socket;
      return sessionId;
    } catch (cause) {
      this.#session = undefined;
      throw cause;
    }
  }

  #forget(sessionId: string, deps: HtmlBrowserDeps): void {
    this.#session = undefined;
    deps.store().sessionClosed(sessionId);
  }

  async close(deps: HtmlBrowserDeps): Promise<void> {
    if (this.#holders > 0 || this.#session === undefined) return;
    const pending = this.#session;
    this.#session = undefined;
    const sessionId = await pending.catch(() => undefined);
    if (sessionId === undefined) return;
    deps.store().sessionClosed(sessionId);
    await deps.binding()?.closeSession(sessionId).catch(() => undefined);
  }
}

const shared = new SharedHtmlBrowser();

/** Closes the shared browser now if no render holds it (Environment shutdown, tests). */
export const closeHtmlBrowser = (deps: HtmlBrowserDeps): Promise<void> => shared.close(deps);

const spawnError = (description: string, cause?: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "spawn",
    description: `t3flare: ${description}${cause === undefined ? "" : `: ${(cause instanceof Error ? cause.message : JSON.stringify(cause) ?? "").slice(0, 200)}`}`,
    pathOrDescriptor: HTML_BROWSER_EXECUTABLE,
  });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `--version`: what stock's missing-library check reads; no loader error, so no library is missing. */
const versionHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode("Cloudflare Browser Run\n")),
    stderr: Stream.empty,
    all: Stream.make(encoder.encode("Cloudflare Browser Run\n")),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

interface CdpCommand {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
}

/** The bridge for one `--remote-debugging-pipe` spawn: fd 3 to the browser, the browser to fd 4. */
export const spawnHtmlBrowser = (command: ChildProcess.StandardCommand, deps: HtmlBrowserDeps) =>
  Effect.gen(function* () {
    const args = command.args.map((word) => (typeof word === "string" ? word : ""));
    if (args.includes("--version")) return versionHandle();
    if (!args.includes("--remote-debugging-pipe")) return yield* spawnError("only --remote-debugging-pipe is bridged");
    const input = command.options.additionalFds?.fd3;
    const inputStream = input?.type === "input" ? input.stream : undefined;
    if (inputStream === undefined) return yield* spawnError("fd 3 carries no CDP stream");

    const { socket, release } = yield* Effect.tryPromise({
      try: () => shared.connect(deps),
      catch: (cause) => spawnError("Browser Run could not start a browser", cause),
    });
    const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const exited = yield* Deferred.make<number>();
    /** Contexts this render made: closed on its `Browser.close` or its end, never the shared browser itself. */
    const contexts = new Set<string>();
    const pendingContexts = new Set<number>();
    let open = true;

    const end = (code: number) => {
      if (!open) return;
      open = false;
      for (const browserContextId of contexts) {
        try {
          socket.send(JSON.stringify({ id: 0, method: "Target.disposeBrowserContext", params: { browserContextId } }));
        } catch {
          // The socket is gone, and the contexts with it.
        }
      }
      try {
        socket.close(1000, "render done");
      } catch {
        // Already closed.
      }
      release();
      Queue.endUnsafe(output);
      Deferred.doneUnsafe(exited, Effect.succeed(code));
    };

    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer);
      if (pendingContexts.size > 0) {
        try {
          const reply = JSON.parse(text) as { id?: number; result?: { browserContextId?: string } };
          if (reply.id !== undefined && pendingContexts.delete(reply.id) && reply.result?.browserContextId !== undefined) {
            contexts.add(reply.result.browserContextId);
          }
        } catch {
          // Not JSON: passed on as it came.
        }
      }
      Queue.offerUnsafe(output, encoder.encode(`${fromBrowser(text)}\0`));
    });
    socket.addEventListener("close", () => end(0));
    socket.addEventListener("error", () => end(1));

    const forward = (message: string) => {
      if (!open || message === "") return;
      let parsed: CdpCommand = {};
      try {
        parsed = JSON.parse(message) as CdpCommand;
      } catch {
        // Not JSON: Chrome would ignore it too.
        return;
      }
      if (parsed.method === "Browser.close" && parsed.sessionId === undefined) {
        // The shared browser stays: this render's contexts close, and the render sees its browser go.
        Queue.offerUnsafe(output, encoder.encode(`${JSON.stringify({ id: parsed.id, result: {} })}\0`));
        end(0);
        return;
      }
      if (parsed.method === "Target.createBrowserContext" && parsed.id !== undefined) pendingContexts.add(parsed.id);
      socket.send(toBrowser(message));
    };

    let partial = "";
    yield* Stream.runForEach(inputStream, (chunk) =>
      Effect.sync(() => {
        partial += decoder.decode(chunk, { stream: true });
        let at = partial.indexOf("\0");
        while (at !== -1) {
          forward(partial.slice(0, at));
          partial = partial.slice(at + 1);
          at = partial.indexOf("\0");
        }
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => end(0))),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => end(0)));

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.map(Deferred.await(exited), ChildProcessSpawner.ExitCode),
      isRunning: Effect.sync(() => open),
      kill: () => Effect.sync(() => end(143)),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: (fd) => (fd === 4 ? Stream.fromQueue(output) : Stream.empty),
      unref: Effect.succeed(Effect.void),
    });
  });
