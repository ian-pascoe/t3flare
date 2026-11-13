// G11 (previews, ADR-0031): the seams of the Cloud Environment's previews that run without Browser Run or a Container:
// where a `localhost` navigation goes, which listeners are listed and whose (review M7), the configured URLs stock takes
// (review M4), the Browser Run sessions and profiles kept in the Environment DO (reviews L4, M5), the acquire options
// (review L5), the HTML bridge (review M3), the stream route's socket (review H1) and the Shadow's shape (U59).
import type { PortScan } from "@t3flare/sandbox-image/ports";
import { stopGroupArgv } from "@t3flare/sandbox-image/ports";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { describe, expect, it } from "vitest";

import { acquireOptions } from "../src/preview/cdpSocket.ts";
import { BRIDGED_PAGE_ORIGIN, fromBrowser, HTML_BROWSER_EXECUTABLE, spawnHtmlBrowser, STOCK_PAGE_ORIGIN, toBrowser } from "../src/preview/htmlBrowser.ts";
import { type Lookups, normalizeConfiguredUrls, serversOf, threadWorkspaceFrom } from "../src/preview/portDiscovery.ts";
import { closeLeftoverSessions } from "../src/preview/sessions.ts";
import { PROFILE_MAX_BYTES, previewStore, profileChunks } from "../src/preview/store.ts";
import { nodeSocketShim } from "../src/platform/httpServer.ts";
import * as Shadow from "../src/shadows/serverBrowserContexts.ts";
import * as Stock from "t3/src/preview/ServerBrowserContexts.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

describe("a navigation to localhost in Browser Run (R1, review L6)", () => {
  it("goes to the port's Container preview host, path and query kept, for each loopback name", () => {
    expect(Shadow.translatePreviewUrl("http://localhost:5173/app?x=1#h")).toBe("http://5173.t3flare.internal/app?x=1#h");
    expect(Shadow.translatePreviewUrl("http://127.0.0.1:3000/")).toBe("http://3000.t3flare.internal/");
    expect(Shadow.translatePreviewUrl("https://[::1]:8787/api")).toBe("http://8787.t3flare.internal/api");
    expect(Shadow.translatePreviewUrl("http://0.0.0.0:4173")).toBe("http://4173.t3flare.internal/");
  });

  it("names the eight ports for any other port, computerd's included, and leaves other URLs alone", () => {
    for (const url of ["http://localhost:8080/", "http://localhost:9999/", "http://localhost/"]) {
      const page = decodeURIComponent(Shadow.translatePreviewUrl(url));
      expect(page.startsWith("data:text/html")).toBe(true);
      expect(page).toContain("3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787");
    }
    expect(Shadow.translatePreviewUrl("https://example.com/")).toBe("https://example.com/");
    expect(Shadow.translatePreviewUrl("http://5173.t3flare.internal/")).toBe("http://5173.t3flare.internal/");
    expect(Shadow.translatePreviewUrl("not a url")).toBe("not a url");
  });
});

const scan = (listeners: PortScan["listeners"], computerd: number | null = 7): PortScan => ({ computerd, listeners, table: [] });
const listener = (over: Partial<PortScan["listeners"][number]>): PortScan["listeners"][number] => ({
  port: 5173,
  host: "0.0.0.0",
  pid: 100,
  pgid: 100,
  comm: "node",
  exec: null,
  thread: null,
  ...over,
});

const LOOKUPS: Lookups = {
  terminal: (key) =>
    ({
      "term-a": { workspace: "ws-a", owner: { threadId: "thread-a", terminalId: "default" } },
      "term-b": { workspace: "ws-b", owner: { threadId: "thread-b", terminalId: "default" } },
      "term-unnamed": { workspace: "ws-a", owner: undefined },
    })[key],
  process: (key) =>
    ({
      "proc-a": { workspace: "ws-a", thread: "thread-a" },
      "proc-b": { workspace: "ws-b", thread: "thread-b" },
    })[key],
  threadWorkspace: (thread) => ({ "thread-a": "ws-a", "thread-b": "ws-b" })[thread],
};

describe("port discovery from a Container's scan (C1, review M7)", () => {
  it("lists a terminal's server as the terminal's, and an agent's (CLI key or thread variable) as the agent's", () => {
    const servers = serversOf(
      "ws-a",
      scan([listener({ port: 5173, exec: "term-a" }), listener({ port: 3000, pid: 101, exec: "proc-a" }), listener({ port: 8000, pid: 102, exec: "exec-9", thread: "thread-a" })]),
      LOOKUPS,
    );
    expect(servers).toEqual([
      { host: "localhost", port: 3000, url: "http://localhost:3000", processName: "node", pid: 101, terminal: null, agent: { threadId: "thread-a" } },
      { host: "localhost", port: 5173, url: "http://localhost:5173", processName: "node", pid: 100, terminal: { threadId: "thread-a", terminalId: "default" }, agent: null },
      { host: "localhost", port: 8000, url: "http://localhost:8000", processName: "node", pid: 102, terminal: null, agent: { threadId: "thread-a" } },
    ]);
  });

  it("leaves out what stock leaves out: an unattributed server, computerd and its port", () => {
    const servers = serversOf("ws-a", scan([listener({ exec: null }), listener({ port: 8080, pid: 7, comm: "computerd" }), listener({ port: 9000, pid: 7, exec: "term-a" })]), LOOKUPS);
    expect(servers).toEqual([]);
  });

  it("ignores a marker that names another Workspace's terminal, process or thread (review M7)", () => {
    const servers = serversOf(
      "ws-a",
      scan([
        listener({ port: 3000, exec: "term-b" }),
        listener({ port: 3001, exec: "proc-b" }),
        listener({ port: 4173, exec: "exec-1", thread: "thread-b" }),
        listener({ port: 4321, exec: "exec-2", thread: "no-such-thread" }),
        listener({ port: 5174, exec: "term-unnamed" }),
      ]),
      LOOKUPS,
    );
    expect(servers).toEqual([]);
  });

  it("keeps a hostile process name as data, clipped", () => {
    const [server] = serversOf("ws-a", scan([listener({ exec: "term-a", comm: `"><img src=x>\n${"y".repeat(100)}` })]), LOOKUPS);
    expect(server?.processName).toBe(`"><img src=x>\n${"y".repeat(100)}`.trim().slice(0, 64));
  });

  it("refuses to signal group 1 or a malformed group", () => {
    expect(stopGroupArgv(1, [1])).toEqual([]);
    expect(stopGroupArgv(0, [])).toEqual([]);
    expect(stopGroupArgv(1.5, [])).toEqual([]);
    expect(stopGroupArgv(42, [42, -1, 43]).slice(3)).toEqual(["t3flare-stop", "42", "42", "43"]);
  });
});

describe("configured preview URLs (review M4)", () => {
  it("are taken only on loopback, as stock takes them: nothing else is ever probed", () => {
    expect(
      normalizeConfiguredUrls(["http://localhost:5173/", "http://0.0.0.0:3000/x", "https://example.com/", "http://169.254.169.254/", "http://10.0.0.1/", "file:///etc/passwd", "nonsense"]),
    ).toEqual(["http://localhost:5173/", "http://localhost:3000/x"]);
  });
});

describe("a thread's Workspace, from t3's projection", () => {
  it("is its worktree's, else its project's, and none for a deleted thread or an unreadable table", () => {
    const sql = nodeSqlStorage();
    sql.exec("CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT)");
    sql.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT)");
    sql.exec("INSERT INTO projection_projects VALUES ('p', '/w/demo')");
    sql.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'p', '{}', NULL)");
    sql.exec(`INSERT INTO orchestration_v2_projection_threads VALUES ('t2', 'p', '{"worktreePath":"/w/.wt/demo/feature"}', NULL)`);
    sql.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('t3', 'p', '{}', '2026-01-01')");
    const of = threadWorkspaceFrom(sql);
    expect(of("t1")).toBe("demo");
    expect(of("t2")).toBe(".wt/demo/feature");
    expect(of("t3")).toBeUndefined();
    expect(threadWorkspaceFrom(nodeSqlStorage())("t1")).toBeUndefined();
  });
});

describe("the Environment's Browser Run records (reviews L4, M5)", () => {
  it("keeps the sessions it acquired, and a new instance closes them all", async () => {
    const store = previewStore(nodeSqlStorage());
    store.sessionOpened({ id: "s1", kind: "workspace", workspace: "demo", openedAt: 1 });
    store.sessionOpened({ id: "s2", kind: "html", workspace: null, openedAt: 2 });
    const closed: Array<string> = [];
    expect(await closeLeftoverSessions({ closeSession: async (id: string) => (closed.push(id), { status: "closed" }) } as never, store)).toBe(2);
    expect(closed).toEqual(["s1", "s2"]);
    expect(store.sessions()).toEqual([]);
  });

  it("keeps a profile's state across rows without splitting a character, and refuses one over 8 MiB", () => {
    const store = previewStore(nodeSqlStorage());
    const big = `${"a".repeat(512 * 1024 - 1)}😀${"b".repeat(600 * 1024)}`;
    expect(profileChunks(big).every((chunk) => chunk.length <= 512 * 1024)).toBe(true);
    expect(profileChunks(big).join("")).toBe(big);
    expect(store.saveProfile("default", big)).toBe("saved");
    expect(store.profile("default")).toBe(big);
    expect(store.saveProfile("default", "x".repeat(PROFILE_MAX_BYTES + 1))).toBe("too-large");
    expect(store.profile("default")).toBe(big);
    store.clearProfile("default");
    expect(store.profile("default")).toBeUndefined();
  });

  it("acquires every browser with a keep-alive and routes, never recording or a Live View (review L5)", () => {
    const options = acquireOptions({ outboundByHost: { "5173.t3flare.internal": {} as never } });
    expect(Object.keys(options).sort()).toEqual(["keepAlive", "outboundByHost"]);
    expect(options.keepAlive).toBe(600_000);
    expect(acquireOptions({})).toEqual({ keepAlive: 600_000 });
  });
});

/** A fake Browser Run browser-level socket: records what t3 sent, answers what the test says. */
const fakeSocket = () => {
  const sent: Array<string> = [];
  const listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};
  const socket = {
    accept: () => undefined,
    send: (message: string) => void sent.push(message),
    close: () => {
      for (const listener of listeners.close ?? []) listener({ data: null });
    },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => void (listeners[type] ??= []).push(listener),
  };
  return { socket, sent, emit: (data: string) => (listeners.message ?? []).forEach((listener) => listener({ data })) };
};

describe("t3's HTML-render Chrome, bridged to Browser Run (review M3)", () => {
  it("rewrites t3's page origin to one Browser Run serves, both ways", () => {
    const sent = JSON.stringify({ method: "Page.navigate", params: { url: `${STOCK_PAGE_ORIGIN}/page.html#x` } });
    expect(toBrowser(sent)).toContain(`${BRIDGED_PAGE_ORIGIN}/page.html#x`);
    expect(fromBrowser(toBrowser(sent))).toBe(sent);
  });

  it("answers stock's library check without a browser", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnHtmlBrowser(ChildProcess.make(HTML_BROWSER_EXECUTABLE, ["--version"]) as ChildProcess.StandardCommand, {
            binding: () => undefined,
            store: () => previewStore(nodeSqlStorage()),
          });
          return yield* Stream.mkString(Stream.decodeText(handle.stdout));
        }),
      ),
    );
    expect(out).toContain("Browser Run");
  });

  it("carries fd 3 to the browser and the browser to fd 4, closes only its own contexts, and keeps the shared browser", async () => {
    const fake = fakeSocket();
    const store = previewStore(nodeSqlStorage());
    const closedSessions: Array<string> = [];
    const binding = {
      launch: async () => ({ sessionId: "shared-1", webSocket: { fetch: async () => ({ webSocket: fake.socket }) } }),
      connectSession: async () => {
        throw new Error("not expected");
      },
      closeSession: async (id: string) => void closedSessions.push(id),
    };
    const encoder = new TextEncoder();
    const commands = [
      JSON.stringify({ id: 1, method: "Target.createBrowserContext", params: {} }),
      JSON.stringify({ id: 2, method: "Page.navigate", params: { url: `${STOCK_PAGE_ORIGIN}/page.html` }, sessionId: "s" }),
      JSON.stringify({ id: 3, method: "Browser.close", params: {} }),
    ];
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnHtmlBrowser(
            ChildProcess.make(HTML_BROWSER_EXECUTABLE, ["--headless=new", "--remote-debugging-pipe"], {
              additionalFds: {
                fd3: {
                  type: "input",
                  // As t3 sends them: Browser.close after the context's reply came back.
                  stream: Stream.fromIterable(commands.slice(0, 2).map((command) => encoder.encode(`${command}\0`))).pipe(
                    Stream.concat(Stream.fromEffect(Effect.sleep(50).pipe(Effect.as(encoder.encode(`${commands[2]}\0`))))),
                    Stream.concat(Stream.never),
                  ),
                },
                fd4: { type: "output" },
              },
            }) as ChildProcess.StandardCommand,
            { binding: () => binding as never, store: () => store },
          );
          yield* Effect.sleep(10);
          fake.emit(JSON.stringify({ id: 1, result: { browserContextId: "ctx-1" } }));
          fake.emit(JSON.stringify({ method: "Fetch.requestPaused", params: { request: { url: `${BRIDGED_PAGE_ORIGIN}/page.html` } }, sessionId: "s" }));
          const text = yield* Stream.mkString(Stream.decodeText(handle.getOutputFd(4)));
          const code = yield* handle.exitCode;
          return { text, code };
        }),
      ),
    );
    expect(fake.sent[0]).toContain("Target.createBrowserContext");
    expect(fake.sent[1]).toContain(`${BRIDGED_PAGE_ORIGIN}/page.html`);
    // Browser.close is answered here, and only this render's context is disposed.
    expect(fake.sent.some((message) => message.includes("Browser.close"))).toBe(false);
    expect(fake.sent.at(-1)).toContain('"Target.disposeBrowserContext"');
    expect(fake.sent.at(-1)).toContain("ctx-1");
    expect(output.text.split("\0").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      { id: 1, result: { browserContextId: "ctx-1" } },
      { method: "Fetch.requestPaused", params: { request: { url: `${STOCK_PAGE_ORIGIN}/page.html` } }, sessionId: "s" },
      { id: 3, result: {} },
    ]);
    expect(output.code).toBe(0);
    expect(closedSessions).toEqual([]);
    expect(store.sessions().map((session) => session.kind)).toEqual(["html"]);
  });
});

describe("the preview stream's socket (review H1)", () => {
  it("gives t3 the headers and a socket whose destroy closes the WebSocket", () => {
    let destroyed = 0;
    const shim = nodeSocketShim(new Request("https://t3.example/api/preview-stream/ws", { headers: { "sec-websocket-extensions": "permessage-deflate" } }), () => {
      destroyed++;
      throw new Error("already closed");
    });
    expect(shim.headers["sec-websocket-extensions"]).toBe("permessage-deflate");
    delete (shim.headers as Record<string, string>)["sec-websocket-extensions"];
    expect(shim.socket.writableLength).toBe(0);
    expect(() => shim.socket.destroy()).not.toThrow();
    expect(destroyed).toBe(1);
  });
});

describe("the ServerBrowserContexts Shadow (U59)", () => {
  it("exports what stock exports, and the class has stock's public methods", () => {
    expect(Object.keys(Shadow)).toEqual(expect.arrayContaining(Object.keys(Stock)));
    const methods = (prototype: object) =>
      Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor" && typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === "function");
    const stock = methods(Stock.ServerBrowserContexts.prototype).filter((name) => !["launchOptions", "launch", "sharedBrowser", "sharedContext", "retireWhenIdle", "retire", "createContext", "profileDirectory", "dispose"].includes(name));
    expect(methods(Shadow.ServerBrowserContexts.prototype)).toEqual(expect.arrayContaining(stock));
  });
});
