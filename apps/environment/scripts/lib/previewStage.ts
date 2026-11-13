// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off anyUnknownInErrorContext:off
// G11's stage flow (scripts/previews.ts): a Vite dev server in a thread's terminal in the fixture Workspace, listed by
// port discovery, opened in t3's server browser, watched over t3's stream route, edited for HMR, and a hostile page run
// in it. What a tab's page sees is read through the stage-only `tab-eval` spike op (a second CDP connection).
import * as https from "node:https";

import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";

import { admin, base, protocol, sleep, wsCall } from "./client.ts";

export interface Line {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: unknown;
}

export const step = async (lines: Array<Line>, name: string, run: () => Promise<{ readonly ok: boolean; readonly detail?: unknown }>) => {
  const started = Date.now();
  try {
    const { ok, detail } = await run();
    lines.push({ name, ok, ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? "ok  " : "FAIL"} ${name} ${JSON.stringify(detail ?? null).slice(0, 300)}`);
    return ok;
  } catch (error) {
    lines.push({ name, ok: false, ms: Date.now() - started, detail: String(error).slice(0, 500) });
    console.log(`FAIL ${name} ${String(error).slice(0, 300)}`);
    return false;
  }
};

/** The first value of a streaming WS method `match` accepts, or undefined after `ms`. */
export const wsFind = (cookie: string, method: string, payload: unknown, match: (value: any) => boolean, ms: number): Promise<any> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = (yield* RpcClient.make(WsRpcGroup)) as unknown as Record<string, (input: unknown) => Stream.Stream<unknown, unknown>>;
      return yield* Stream.runHead(client[method]!(payload).pipe(Stream.filter(match)));
    }).pipe(Effect.provide(protocol(cookie)), Effect.scoped, Effect.timeoutOption(ms)),
  ).then((head: any) => (head?._tag === "Some" && head.value?._tag === "Some" ? head.value.value : undefined));

/** `expression` in the stage's open tab whose URL contains `match` (stage-only spike op). */
export const tabEval = async (match: string, expression: string): Promise<unknown> => {
  const { status, json } = await admin("POST", "/_t3flare/previews/spike?op=tab-eval", { match, expression });
  if (status !== 200) throw new Error(`tab-eval: HTTP ${status}`);
  const lines = (json as { lines: ReadonlyArray<Line> }).lines;
  const found = lines.find((line) => line.ok && (line.detail as { value?: unknown } | undefined)?.value !== undefined);
  if (found === undefined) throw new Error(`no tab matches ${match}: ${JSON.stringify(lines).slice(0, 400)}`);
  return (found.detail as { value: unknown }).value;
};

export interface StreamWatch {
  readonly frames: number;
  readonly jpeg: boolean;
  readonly messages: ReadonlyArray<string>;
  readonly closeCode: number | null;
  readonly openError: string | null;
}

/** Watches a tab over t3's stream route for `ms`, acking each frame as the web client does; optionally sends input. */
export const watchStream = (
  cookie: string | null,
  query: Record<string, string>,
  ms: number,
  input?: (send: (message: unknown) => void) => void,
): Promise<StreamWatch> =>
  new Promise((resolve) => {
    const url = new URL("/api/preview-stream/ws", base);
    url.protocol = "wss:";
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const socket = new WebSocket(url, { headers: { ...(cookie === null ? {} : { cookie }), origin: base.origin } } as never);
    socket.binaryType = "arraybuffer";
    let frames = 0;
    let jpeg = false;
    let closeCode: number | null = null;
    let openError: string | null = null;
    const messages: Array<string> = [];
    const send = (message: unknown) => socket.send(JSON.stringify(message));
    socket.addEventListener("open", () => input?.(send));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        messages.push(event.data.slice(0, 200));
        return;
      }
      frames++;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) jpeg = true;
      send({ type: "ack" });
    });
    socket.addEventListener("error", () => (openError ??= "error"));
    socket.addEventListener("close", (event) => (closeCode = event.code));
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        // closed
      }
      setTimeout(() => resolve({ frames, jpeg, messages, closeCode, openError }), 300);
    }, ms);
  });

/** The stream route's answer to an upgrade request (its status), as a client without a session gets it. */
export const streamStatus = (cookie: string | null, query: Record<string, string>): Promise<number> =>
  new Promise((resolve) => {
    const url = new URL("/api/preview-stream/ws", base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const request = https.request(url, {
      headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...(cookie === null ? {} : { cookie }) },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 101);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", () => resolve(0));
    request.end();
  });

export const openTab = async (cookie: string, threadId: string, url: string): Promise<{ readonly tabId: string }> =>
  (await wsCall(cookie, "preview.open", { threadId, url, runtime: "server" })) as { tabId: string };

export const waitFor = async <A>(what: string, read: () => Promise<A | undefined>, ms: number): Promise<A> => {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < ms) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await sleep(1500);
  }
  throw new Error(`timed out: ${what}${last === undefined ? "" : ` (${(last instanceof Error ? last.message : JSON.stringify(last)).slice(0, 200)})`}`);
};

/** The dev server's files: a page with a marker for HMR, and the hostile page (preview JS against t3, M3 hostile). */
export const VITE_APP = (t3Origin: string) => ({
  "index.html": `<!doctype html><html><head><title>vapp</title></head><body><h1 id="app">loading</h1><script type="module" src="/main.js"></script></body></html>`,
  "main.js": `document.getElementById("app").textContent = "version-1";\nif (import.meta.hot) import.meta.hot.accept();\n`,
  "hostile.html": `<!doctype html><html><head><title>hostile</title></head><body><pre id="out">pending</pre><script>
(async () => {
  const out = { cookie: document.cookie };
  const t = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
  out.session = await t(fetch(${JSON.stringify(`${t3Origin}/api/auth/session`)}, { credentials: "include" }).then((r) => "status " + r.status, (e) => "error " + e.name));
  out.mcp = await t(fetch(${JSON.stringify(`${t3Origin}/mcp`)}, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => "status " + r.status, (e) => "error " + e.name));
  out.ws = await t(new Promise((r) => { const s = new WebSocket(${JSON.stringify(`${t3Origin.replace("https:", "wss:")}/ws`)}); s.onopen = () => r("open"); s.onerror = () => r("error"); s.onclose = (e) => r("closed " + e.code); }));
  out.panel = await t(fetch(${JSON.stringify(`${t3Origin}/_t3flare/harness/api/mcp/servers`)}, { method: "POST", credentials: "include", body: "{}" }).then((r) => "status " + r.status, (e) => "error " + e.name));
  out.otherWorkspace = await t(fetch("http://5174.t3flare.internal/", { mode: "no-cors" }).then((r) => "answered " + r.type, (e) => "error " + e.name));
  out.computerd = await t(fetch("http://8080.t3flare.internal/").then((r) => "status " + r.status, (e) => "error " + e.name));
  out.forgedHost = await t(fetch("/", { headers: { "x-forwarded-host": "8080.t3flare.internal" } }).then((r) => "status " + r.status, (e) => "error " + e.name));
  out.sendForged = await t(fetch("/__t3flare/ws/send?id=" + "0".repeat(64), { method: "POST", headers: { "x-t3flare-preview": "1" }, body: "x" }).then((r) => "status " + r.status, (e) => "error " + e.name));
  out.sendNoHeader = await t(fetch("/__t3flare/ws/send?id=x", { method: "POST", body: "x" }).then((r) => "status " + r.status, (e) => "error " + e.name));
  document.getElementById("out").textContent = JSON.stringify(out);
})();
</script></body></html>`,
});

/**
 * The shell command that lays out the Vite app in `/tmp/vapp` (the Container's own disk, gone when it stops), with
 * `extra` files, and installs Vite when it is not there yet.
 */
export const viteAppCommand = (t3Origin: string, extra: Record<string, string> = {}): string => {
  const write = Object.entries({ ...VITE_APP(t3Origin), ...extra })
    .map(([name, text]) => `mkdir -p "$(dirname ${name})" && echo ${Buffer.from(text).toString("base64")} | base64 -d > ${name}`)
    .join(" && ");
  return `pkill -f 'vite --host' ; mkdir -p /tmp/vapp && cd /tmp/vapp && ${write} && (test -d node_modules/vite || (npm init -y >/dev/null && npm i --silent vite@6 >/dev/null 2>&1))`;
};

/** Starts Vite on 0.0.0.0:5173 in the background; `detached` runs it outside the terminal's marker (it outlives the terminal). */
export const viteStartCommand = (detached: boolean): string =>
  `(${detached ? "env -u T3FLARE_EXEC setsid " : ""}nohup npx vite --host 0.0.0.0 --port 5173 --strictPort >/tmp/vite.log 2>&1 &) && sleep 4 && echo started`;
