// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off globalDate:off nodeBuiltinImport:off preferEffectArray:off
// G11's M0 spike and the stage's browser checks (test stages only; `POST /_t3flare/previews/spike`, `scripts/previews.ts`):
// Browser Run under the Playwright calls t3's `ServerBrowser` makes, the Container preview routes and their props across
// invocations, `localhost` and `t3-page.localhost` under Browser Run's policy, and what a page there can reach. Every
// result is a line `{ name, ok, ms, detail }`; nothing a page returns is logged.
import * as NodeFS from "node:fs";

import type { DurableObjectStorage } from "@cloudflare/workers-types/index.ts";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

import { environmentServices } from "../agents/bindings.ts";
import { BROWSER_KEEP_ALIVE_MS, CONTAINER_PREVIEW_PORTS, containerPreviewHost } from "./browserRun.ts";
import { CdpClient, openCdpSocket } from "./cdpSocket.ts";

/** The fork's entry points, typed with t3's own `playwright-core` types (the fork's resolve to `any` here). */
interface Playwright {
  launch(binding: unknown, options: { keep_alive?: number; outboundByHost?: unknown }): Promise<Browser & { sessionId(): string }>;
  connect(binding: unknown, sessionId: string): Promise<Browser>;
}

interface Line {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: unknown;
}

const SESSION_KEY = "t3flare:previews-spike-session";

/** The spike's browser, kept across invocations in this isolate (as t3's `ServerBrowser` keeps its own). */
let spikeBrowser: { browser: Browser; sessionId: string; workspace: string; at: number } | undefined;

const clip = (value: unknown) => String(value instanceof Error ? value.message : value).slice(0, 300);

const step = async (lines: Array<Line>, name: string, run: () => Promise<unknown>): Promise<unknown> => {
  const started = Date.now();
  try {
    const detail = await run();
    lines.push({ name, ok: true, ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    return detail;
  } catch (error) {
    lines.push({ name, ok: false, ms: Date.now() - started, detail: clip(error) });
    return undefined;
  }
};

const routes = (workspace: string) => {
  const entry = environmentServices().containerPreviews(workspace);
  return Object.fromEntries(CONTAINER_PREVIEW_PORTS.map((port) => [containerPreviewHost(port), entry]));
};

const binding = () => {
  const browserRun = environmentServices().browserRun;
  if (browserRun === undefined) throw new Error("no BROWSER binding");
  return browserRun;
};

const playwright = async (): Promise<Playwright> => (await import("@cloudflare/playwright")) as unknown as Playwright;

/** Question 1 (and M2, M6 of the review): every Playwright call t3 makes, against one browser with the routes. */
const playwrightCalls = async (storage: DurableObjectStorage): Promise<Array<Line>> => {
  const lines: Array<Line> = [];
  const pw = (await step(lines, "import @cloudflare/playwright", () => playwright().then((module) => module))) as Playwright | undefined;
  if (pw === undefined) return lines;
  const workspace = "spike-a";
  const browser = (await step(lines, "launch (outboundByHost via ctx.exports, keep_alive 600 s)", () =>
    pw.launch(binding(), { keep_alive: BROWSER_KEEP_ALIVE_MS, outboundByHost: routes(workspace) }),
  )) as (Browser & { sessionId(): string }) | undefined;
  if (browser === undefined) return lines;
  spikeBrowser = { browser, sessionId: browser.sessionId(), workspace, at: Date.now() };
  storage.kv.put(SESSION_KEY, { sessionId: browser.sessionId(), workspace, at: Date.now() });
  const context = (await step(lines, "browser.newContext({ viewport, deviceScaleFactor })", () =>
    browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }),
  )) as BrowserContext | undefined;
  if (context === undefined) return lines;
  const page = (await step(lines, "context.newPage", () => context.newPage())) as Page | undefined;
  if (page === undefined) return lines;
  const cdp = (await step(lines, "context.newCDPSession(page)", () => context.newCDPSession(page))) as CDPSession | undefined;
  await step(lines, "cdp Browser.getVersion + Emulation.setUserAgentOverride (presentAsChrome)", async () => {
    const version = (await cdp!.send("Browser.getVersion")) as { userAgent: string; product: string };
    await cdp!.send("Emulation.setUserAgentOverride", { userAgent: version.userAgent.replace("HeadlessChrome", "Chrome") });
    return version.product;
  });
  await step(lines, "context.grantPermissions(['clipboard-write'])", () => context.grantPermissions(["clipboard-write"]));
  await step(lines, "page.emulateMedia({ colorScheme: 'dark' })", () => page.emulateMedia({ colorScheme: "dark" }));
  await step(lines, "context.addInitScript", () => context.addInitScript({ content: "globalThis.__spikeInit = 1;" }));
  await step(lines, "page.exposeFunction", () => page.exposeFunction("__spikeExposed", () => "exposed"));
  await step(lines, "page.setViewportSize", () => page.setViewportSize({ width: 1024, height: 700 }));
  page.setDefaultTimeout(20_000);
  // Question 2's first leg: the route reaches the entrypoint with this browser's props.
  await step(lines, "goto http://5173.t3flare.internal/ (props through outboundByHost)", async () => {
    const response = await page.goto(`http://${containerPreviewHost(5173)}/`, { waitUntil: "load" });
    return { status: response?.status(), props: await page.locator("#props").textContent(), host: await page.locator("#host").textContent() };
  });
  await step(lines, "initScript ran", () => page.evaluate(() => (globalThis as unknown as { __spikeInit?: number }).__spikeInit));
  await step(lines, "exposeFunction callable", () => page.evaluate(() => (globalThis as unknown as { __spikeExposed: () => Promise<string> }).__spikeExposed()));
  await step(lines, "page.ariaSnapshot({ mode: 'ai', boxes: true })", async () => (await page.ariaSnapshot({ mode: "ai", boxes: true, timeout: 10_000 } as never)).slice(0, 200));
  await step(lines, "locator.fill / click / hover / selectOption / boundingBox / scrollIntoViewIfNeeded / count", async () => {
    await page.locator("#t").fill("typed");
    await page.locator("#s").selectOption("b");
    await page.locator("#b").hover();
    await page.locator("#b").scrollIntoViewIfNeeded();
    const box = await page.locator("#b").boundingBox();
    await page.locator("#b").click();
    return { value: await page.locator("#t").inputValue(), box: box !== null, count: await page.locator("button").count() };
  });
  await step(lines, "keyboard.insertText / press, mouse.move / click", async () => {
    await page.locator("#t").focus();
    await page.keyboard.insertText("!");
    await page.keyboard.press("End");
    await page.mouse.move(10, 10);
    await page.mouse.click(10, 10);
    return page.locator("#t").inputValue();
  });
  await step(lines, "context.newCDPSession(frame) (out-of-process iframes)", async () => {
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame === undefined) throw new Error("no iframe");
    const session = await context.newCDPSession(frame).catch((error: unknown) => `same-process: ${clip(error)}`);
    if (typeof session === "string") return session;
    await session.detach();
    return "attached";
  });
  await step(lines, "page.screenshot", async () => (await page.screenshot({ type: "jpeg", quality: 50 })).byteLength);
  await step(lines, "cdp Page.startScreencast (one frame, acked)", async () => {
    const frame = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame in 10 s")), 10_000);
      cdp!.on("Page.screencastFrame", (event: { sessionId: number; data: string }) => {
        clearTimeout(timer);
        void cdp!.send("Page.screencastFrameAck", { sessionId: event.sessionId });
        resolve(event.data.length);
      });
    });
    await cdp!.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 400, everyNthFrame: 1 });
    await page.mouse.move(20, 20);
    const bytes = await frame;
    await cdp!.send("Page.stopScreencast");
    return { base64Bytes: bytes };
  });
  await step(lines, "page.on('dialog') + dialog.accept", async () => {
    const seen = new Promise<string>((resolve) => page.once("dialog", (dialog) => void dialog.accept().then(() => resolve(dialog.type()))));
    await page.evaluate(() => setTimeout(() => alert("spike"), 10));
    return seen;
  });
  await step(lines, "page.on('popup') (target=_blank link)", async () => {
    const popup = page.waitForEvent("popup", { timeout: 10_000 });
    await page.locator("#pop").click();
    const opened = await popup;
    await opened.waitForLoadState("load");
    const url = opened.url();
    await opened.close();
    return url;
  });
  await step(lines, "page.on('download') + download.saveAs + native stat (+ t3's node:fs alias)", async () => {
    const downloadPage = await context.newPage();
    try {
      const waiting = downloadPage.waitForEvent("download", { timeout: 15_000 });
      await downloadPage.goto(`http://${containerPreviewHost(5173)}/download`).catch(() => undefined);
      const download = await waiting;
      const failure = await download.failure();
      const path = "/tmp/spike-download.txt";
      await download.saveAs(path);
      const native = NodeFS.statSync(path).size;
      // t3's own `node:fs` is the State directory (ADR-0007): the alias does not see the fork's file.
      const { promises: shim } = await import("../shims/node-fs.ts");
      const aliased = await shim.stat(path).then((stat) => stat.size, (error: unknown) => `alias: ${clip(error)}`);
      const stream = await download.createReadStream().then((readable) => (readable === null ? "null" : "stream"), (error: unknown) => clip(error));
      return { failure, suggested: download.suggestedFilename(), native, aliased, stream };
    } finally {
      await downloadPage.close();
    }
  });
  await step(lines, "page.on('filechooser') + setFiles(buffer) and setFiles(native path)", async () => {
    await page.goto(`http://${containerPreviewHost(5173)}/upload`);
    const chooser1 = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.locator("#f").click();
    await (await chooser1).setFiles([{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("buffer-upload") }]);
    await page.waitForFunction(() => document.getElementById("out")?.textContent !== "none");
    const fromBuffer = await page.locator("#out").textContent();
    NodeFS.writeFileSync("/tmp/spike-upload.txt", "path-upload");
    const chooser2 = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.locator("#f").click();
    const fromPath = await (await chooser2).setFiles("/tmp/spike-upload.txt").then(
      async () => {
        await page.waitForFunction(() => document.getElementById("out")?.textContent?.includes("spike-upload"), undefined, { timeout: 5_000 });
        return page.locator("#out").textContent();
      },
      (error: unknown) => `refused: ${clip(error)}`,
    );
    return { fromBuffer, fromPath };
  });
  await step(lines, "locator.setInputFiles(buffer)", async () => {
    await page.locator("#f").setInputFiles({ name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("locator-upload") });
    await page.waitForFunction(() => document.getElementById("out")?.textContent?.includes("b.txt"));
    return page.locator("#out").textContent();
  });
  await step(lines, "context.storageState({ indexedDB: true }) and restore in a new context", async () => {
    await page.goto(`http://${containerPreviewHost(5173)}/cookie`);
    await page.evaluate(() => localStorage.setItem("spike", "kept"));
    const state = await context.storageState({ indexedDB: true } as never);
    const restored = await browser.newContext({ storageState: state as never });
    const restoredPage = await restored.newPage();
    await restoredPage.goto(`http://${containerPreviewHost(5173)}/`);
    const result = {
      bytes: JSON.stringify(state).length,
      cookies: (await restored.cookies()).map((cookie) => cookie.name),
      localStorage: await restoredPage.evaluate(() => localStorage.getItem("spike")),
    };
    await restored.close();
    return result;
  });
  await step(lines, "goBack / goForward / reload / title / waitForLoadState", async () => {
    await page.goBack();
    await page.goForward();
    await page.reload();
    await page.waitForLoadState("load");
    return page.title();
  });
  await step(lines, "a page's WebSocket to its own preview host (expected to fail: HTTP only)", async () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(`ws://${location.host}/ws`);
          socket.onopen = () => resolve("open");
          socket.onerror = () => resolve("error");
          setTimeout(() => resolve("timeout"), 5_000);
        }),
    ),
  );
  // R1: Browser Run's policy and a context route for localhost.
  await step(lines, "goto http://localhost:5173/ with no route (R1)", async () => {
    const probe = await context.newPage();
    try {
      return await probe.goto("http://localhost:5173/", { timeout: 10_000 }).then((response) => `loaded ${response?.status()}`, (error: unknown) => clip(error));
    } finally {
      await probe.close();
    }
  });
  await step(lines, "goto http://localhost:5173/ with a context route answering 302 (R1, L6)", async () => {
    const routed = await browser.newContext();
    let fired = 0;
    await routed.route(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//, async (route) => {
      fired++;
      const target = new URL(route.request().url());
      await route.fulfill({ status: 302, headers: { location: `http://${target.port || "80"}.t3flare.internal${target.pathname}` } });
    });
    const probe = await routed.newPage();
    try {
      const outcome = await probe.goto("http://localhost:5173/", { timeout: 10_000 }).then(
        async () => ({ url: probe.url(), props: await probe.locator("#props").textContent().catch(() => null) }),
        (error: unknown) => clip(error),
      );
      return { fired, outcome };
    } finally {
      await routed.close();
    }
  });
  // L3: what a page in Browser Run reaches. A main-frame navigation shows the network error plainly.
  const privateTargets = [
    "http://127.0.0.1:8080/",
    "http://127.1/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://spike.localhost/",
    "http://8080.t3flare.internal/",
    "http://computer.internal/",
  ];
  await step(lines, "private targets from a Browser Run page (L3)", async () => {
    const out: Record<string, string> = {};
    const probe = await context.newPage();
    try {
      for (const target of privateTargets) {
        out[target] = await probe.goto(target, { timeout: 8_000 }).then(
          (response) => `loaded ${response?.status()}`,
          (error: unknown) => clip(error).split("\n")[0]!.slice(0, 120),
        );
      }
    } finally {
      await probe.close();
    }
    return out;
  });
  await step(lines, "workerd WebSocket bufferedAmount (H1)", async () => {
    const pair = new (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, { accept(): void; send(data: string): void; bufferedAmount?: number; close(): void }> }).WebSocketPair();
    pair[1].accept();
    pair[1].send("x".repeat(1024));
    const amount = pair[1].bufferedAmount;
    pair[1].close();
    return { has: "bufferedAmount" in pair[1], type: typeof amount, value: amount };
  });
  await step(lines, "page.close / context.close", async () => {
    await page.close();
    await context.close();
  });
  return lines;
};

/** Question 2: a later invocation reaches the same routes, with the same props, through the browser kept in the isolate and through a fresh `connect`. */
const routeCheck = async (storage: DurableObjectStorage): Promise<Array<Line>> => {
  const lines: Array<Line> = [];
  const stored = storage.kv.get<{ sessionId: string; workspace: string; at: number }>(SESSION_KEY);
  lines.push({ name: "stored session", ok: stored !== undefined, ms: 0, detail: stored === undefined ? null : { ageMs: Date.now() - stored.at, workspace: stored.workspace } });
  if (spikeBrowser !== undefined) {
    await step(lines, "kept browser: new page on 5173.t3flare.internal", async () => {
      const page = await spikeBrowser!.browser.newPage();
      try {
        await page.goto(`http://${containerPreviewHost(5173)}/`, { timeout: 15_000 });
        return { props: await page.locator("#props").textContent(), connected: spikeBrowser!.browser.isConnected(), ageMs: Date.now() - spikeBrowser!.at };
      } finally {
        await page.close();
      }
    });
  } else {
    lines.push({ name: "kept browser", ok: false, ms: 0, detail: "none in this isolate (reset or new isolate)" });
  }
  if (stored !== undefined) {
    await step(lines, "connectSession from this invocation: new page on 4173.t3flare.internal", async () => {
      const pw = await playwright();
      const browser = await pw.connect(binding(), stored.sessionId);
      const page = await browser.newPage();
      try {
        await page.goto(`http://${containerPreviewHost(4173)}/echo`, { timeout: 15_000 });
        return JSON.parse((await page.locator("body").textContent()) ?? "null") as unknown;
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  }
  return lines;
};

/** Question 3 (review M3): stock `headlessChrome.ts`'s sequence over a raw browser-level CDP socket to a route-less browser. */
const htmlPageCheck = async (): Promise<Array<Line>> => {
  const lines: Array<Line> = [];
  const opened = (await step(lines, "launch route-less + CDP socket", () => openCdpSocket(binding(), { keepAliveMs: 60_000 }))) as
    | Awaited<ReturnType<typeof openCdpSocket>>
    | undefined;
  if (opened === undefined) return lines;
  const cdp = new CdpClient(opened.socket);
  try {
    const { browserContextId } = (await step(lines, "Target.createBrowserContext", () => cdp.send("Target.createBrowserContext"))) as { browserContextId: string };
    const { targetId } = (await step(lines, "Target.createTarget", () => cdp.send("Target.createTarget", { url: "about:blank", browserContextId }))) as { targetId: string };
    const { sessionId } = (await step(lines, "Target.attachToTarget flatten", () => cdp.send("Target.attachToTarget", { targetId, flatten: true }))) as {
      sessionId: string;
    };
    const paused: Array<string> = [];
    const loaded = new Promise<void>((resolve) => {
      cdp.on((method, params, from) => {
        if (from !== sessionId) return;
        if (method === "Page.loadEventFired") resolve();
        if (method === "Fetch.requestPaused") {
          const event = params as { requestId: string; request: { url: string }; resourceType?: string };
          paused.push(`${event.resourceType}:${event.request.url}`);
          if (event.request.url.startsWith("http://t3-page.localhost/page.html")) {
            const body = btoa("<!doctype html><html><body><h1 id=x>t3-page</h1><script>document.title='ok:'+location.origin+':'+isSecureContext</script></body></html>");
            void cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body }, sessionId);
          } else {
            void cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "AccessDenied" }, sessionId);
          }
        }
      });
    });
    await step(lines, "Page.enable / Runtime.enable / Log.enable / addScriptToEvaluateOnNewDocument", async () => {
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Log.enable", {}, sessionId);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "delete window.RTCPeerConnection;", runImmediately: true }, sessionId);
    });
    await step(lines, "Fetch.enable (t3-page.localhost + every Document)", () =>
      cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://t3-page.localhost/*" }, { urlPattern: "*", resourceType: "Document" }] }, sessionId),
    );
    await step(lines, "Page.navigate http://t3-page.localhost/page.html (Q3)", async () => {
      const navigation = (await cdp.send("Page.navigate", { url: "http://t3-page.localhost/page.html#theme" }, sessionId)) as { errorText?: string };
      if (navigation.errorText) return { errorText: navigation.errorText, paused };
      await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error("no load in 10 s")), 10_000))]);
      const title = (await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId)) as { result: { value: string } };
      return { title: title.result.value, paused };
    });
    await step(lines, "Page.captureScreenshot", async () => ((await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId)) as { data: string }).data.length);
    await step(lines, "Target.closeTarget + Browser.close", async () => {
      await cdp.send("Target.closeTarget", { targetId });
      await cdp.send("Browser.close").catch((error: unknown) => clip(error));
    });
  } finally {
    cdp.close();
    await binding().closeSession(opened.sessionId).catch(() => undefined);
  }
  return lines;
};

const closeAll = async (storage: DurableObjectStorage): Promise<Array<Line>> => {
  const lines: Array<Line> = [];
  const stored = storage.kv.get<{ sessionId: string }>(SESSION_KEY);
  if (spikeBrowser !== undefined) await step(lines, "browser.close (kept)", () => spikeBrowser!.browser.close());
  spikeBrowser = undefined;
  if (stored !== undefined) await step(lines, "closeSession (stored)", () => binding().closeSession(stored.sessionId));
  storage.kv.delete(SESSION_KEY);
  return lines;
};

export const runSpike = async (op: string, storage: DurableObjectStorage): Promise<{ readonly op: string; readonly lines: ReadonlyArray<Line> }> => {
  switch (op) {
    case "playwright":
      return { op, lines: await playwrightCalls(storage) };
    case "routes":
      return { op, lines: await routeCheck(storage) };
    case "html-page":
      return { op, lines: await htmlPageCheck() };
    case "close":
      return { op, lines: await closeAll(storage) };
    default:
      throw new Error(`unknown spike op ${op}`);
  }
};
