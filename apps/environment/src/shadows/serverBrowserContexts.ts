// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off asyncFunction:off newPromise:off globalFetch:off
// Shadow of t3code `apps/server/src/preview/ServerBrowserContexts.ts` (G11's M3, ADR-0031; ADR-0001). Stock launches
// Chrome on its host; here every browser is Cloudflare Browser Run, driven by `@cloudflare/playwright` (a port of
// Playwright 1.62.1; t3 types against `playwright-core` 1.64.1, cast at this boundary). Exports what stock does:
// `presentAsChrome` and `ServerBrowserContexts` (`contextFor`, `scratchPage`, `connectDesktopPage`, `clearProfile`,
// `close`), with stock's `Options`.
//
// - **One browser per Workspace.** `contextFor` takes the tab's thread (Patch 0005); a thread's tabs open in its
//   Workspace's browser, acquired with Browser Run's `outboundByHost` routing the eight Container preview hosts
//   (`http://<port>.t3flare.internal/`) to `ContainerPreviews` made for that Workspace alone (its props are the browser's
//   identity, M0 question 2). A context with no thread, and `scratchPage`, use one route-less browser.
// - **`localhost`.** Browser Run refuses loopback before any route runs (M0, R1), so every page's `goto` translates
//   `localhost:<port>` (and `127.0.0.1`, `[::1]`, `0.0.0.0`) to the port's preview host (review L6); a port outside the
//   eight gets a page that names them.
// - **Profiles** have no user-data directory: each is `storageState({ indexedDB: true })`, kept in the Environment DO's
//   own table (`preview/store.ts`, review L4), loaded into `newContext`, saved every 60 s while open and before a close.
//   A profile context with no page for `idleBrowserMs` is saved and closed, and an idle browser retires, so an open
//   Environment holds no browser nobody uses.
// - **Lifetime and cost** (review M5): each session id is recorded and closed when the browser closes; a new Environment
//   instance closes the ones the last left (`preview/sessions.ts`). Browser Run closes a session after `keepAlive` with no
//   CDP traffic: `disconnected` drops that browser's contexts and fires `onContextClose`, so t3 drops their tabs.
// - **Downloads** (M0: the fork cannot copy an artifact off Browser Run's disk, cloudflare/playwright#93): a download's
//   `saveAs` fetches its URL from the page that started it and writes it through t3's own `node:fs` (the State
//   directory), where t3 reads it back. A cross-origin download the page may not read fails as "not available".
// - **Uploads by path** read the file from the tab's own Workspace (`/w/<id>/…` or the agent's `/workspace/…`) and pass
//   it as a buffer; a path in another Workspace is refused.
// - Never `recording`, never a Live View URL, and no URL or cookie is logged (review L5).
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { CONTAINER_PREVIEW_PORTS, containerPreviewHost, toWorkspace } from "@t3flare/workspace-client";
import * as NodeOS from "node:os";
import type { Browser, BrowserContext, CDPSession, Download, Page } from "playwright-core";

import { environmentServices } from "../agents/bindings.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";
import { BROWSER_KEEP_ALIVE_MS } from "../preview/browserRun.ts";
import { threadWorkspaceFrom } from "../preview/portDiscovery.ts";
import * as StateFs from "../shims/node-fs-promises.ts";

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  readonly launcher?: (executable: string) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** Closes an idle browser, and an idle profile context, after this long. */
  readonly idleBrowserMs?: number;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** Stock's: change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (cdp: CDPSession, host: { readonly platform: NodeJS.Platform; readonly arch: string }) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

/** How often an open profile context's state is saved. */
export const PROFILE_SAVE_MS = 60_000;
/** The most a download or an uploaded file may be here: the isolate has 128 MB. */
export const TRANSFER_MAX_BYTES = 16 * 1024 * 1024;

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[a-z0-9-]+\.localhost)$/i;

/**
 * Where a navigation to `url` goes in Browser Run: a loopback URL on one of the eight preview ports goes to that port's
 * preview host (`http`, as Browser Run routes only HTTP); one on another port to a page naming the eight; any other URL
 * as it is.
 */
export const translatePreviewUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOOPBACK.test(parsed.hostname)) return url;
  const port = parsed.port === "" ? (parsed.protocol === "http:" ? 80 : 443) : Number(parsed.port);
  if (CONTAINER_PREVIEW_PORTS.includes(port)) return `http://${containerPreviewHost(port)}${parsed.pathname}${parsed.search}${parsed.hash}`;
  const ports = CONTAINER_PREVIEW_PORTS.join(", ");
  const page = `<!doctype html><meta charset="utf-8"><title>Port ${port} has no preview</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;line-height:1.5"><h1 style="font-size:1.25rem">Port ${port} has no preview</h1><p>The Cloud Environment previews a Workspace's dev server on ports ${ports}. Start it on one of them, listening on 0.0.0.0, then open it again.</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
};

interface Playwright {
  launch(binding: unknown, options: { keep_alive?: number; outboundByHost?: unknown }): Promise<Browser & { sessionId(): string }>;
}

const loadPlaywright = async (): Promise<Playwright> => (await import("@cloudflare/playwright")) as unknown as Playwright;

/** The bytes of `url` as `page` may read them (its cookies, its origin's rules), at most TRANSFER_MAX_BYTES. */
const fetchFromPage = async (page: Page, url: string): Promise<Uint8Array> => {
  const answer = await page.evaluate(
    async ({ target, max }) => {
      const response = await fetch(target, { credentials: "include" });
      if (!response.ok && response.type !== "basic") throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > max) throw new Error("too large");
      let binary = "";
      for (let at = 0; at < buffer.length; at += 0x8000) binary += String.fromCharCode(...buffer.subarray(at, at + 0x8000));
      return btoa(binary);
    },
    { target: url, max: TRANSFER_MAX_BYTES },
  );
  return Uint8Array.from(atob(answer), (char) => char.charCodeAt(0));
};

type FileInput = string | { readonly name: string; readonly mimeType: string; readonly buffer: Buffer };

/** Upload paths as buffers, read from `workspace` (`/w/<id>/…` of it, or its `/workspace/…`); anything else refused. */
const filesFrom = async (workspace: string | undefined, files: FileInput | ReadonlyArray<FileInput>): Promise<Array<Exclude<FileInput, string>>> => {
  const list = Array.isArray(files) ? (files as ReadonlyArray<FileInput>) : [files as FileInput];
  const out: Array<Exclude<FileInput, string>> = [];
  let total = 0;
  for (const file of list) {
    if (typeof file !== "string") {
      out.push(file);
      continue;
    }
    const at = file.startsWith("/workspace/") && workspace !== undefined ? { id: workspace, inner: file } : toWorkspace(file);
    if (workspace === undefined || at === null || at.id !== workspace) {
      throw new Error(`Upload paths must be in this thread's Workspace: ${file}`);
    }
    const answer = (await workspaceRpc(workspace).fs({ op: "read", path: at.inner })) as { readonly ok?: Uint8Array };
    if (answer.ok === undefined) throw new Error(`Could not read ${file}`);
    total += answer.ok.byteLength;
    if (total > TRANSFER_MAX_BYTES) throw new Error("The files are larger than the Cloud Environment uploads (16 MiB).");
    out.push({ name: file.slice(file.lastIndexOf("/") + 1) || "file", mimeType: "application/octet-stream", buffer: Buffer.from(answer.ok) });
  }
  return out;
};

const patched = new WeakSet<object>();

/** Installs the translations on one prototype the fork's pages, choosers and locators share (once). */
const patchUploads = (target: object, method: string, workspaceOf: (self: object) => string | undefined) => {
  const prototype = Object.getPrototypeOf(target) as Record<string, unknown> | null;
  if (prototype === null || patched.has(prototype) || typeof prototype[method] !== "function") return;
  patched.add(prototype);
  const original = prototype[method] as (this: object, files: FileInput | ReadonlyArray<FileInput>, options?: unknown) => Promise<void>;
  prototype[method] = async function (this: object, files: FileInput | ReadonlyArray<FileInput>, options?: unknown) {
    return original.call(this, await filesFrom(workspaceOf(this), files), options);
  };
};

interface WorkspaceBrowser {
  readonly key: string;
  readonly workspace: string | undefined;
  readonly launched: Promise<Browser & { sessionId(): string }>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  pending: number;
}

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private readonly browsers = new Map<string, WorkspaceBrowser>();
  /** The Workspace each context's tabs are in (undefined: the route-less browser). */
  private readonly workspaceOfContext = new WeakMap<object, string | undefined>();
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private get store() {
    return environmentServices().previewStore;
  }

  private browserFor(workspace: string | undefined): WorkspaceBrowser {
    const key = workspace ?? "";
    const existing = this.browsers.get(key);
    if (existing !== undefined) return existing;
    const launched = (async () => {
      const binding = environmentServices().browserRun;
      if (binding === undefined) throw new Error("Browser Run is not bound in this Environment.");
      const playwright = await loadPlaywright();
      const routes =
        workspace === undefined
          ? undefined
          : (() => {
              const entry = environmentServices().containerPreviews(workspace);
              return Object.fromEntries(CONTAINER_PREVIEW_PORTS.map((port) => [containerPreviewHost(port), entry]));
            })();
      const browser = await playwright.launch(binding, { keep_alive: BROWSER_KEEP_ALIVE_MS, ...(routes === undefined ? {} : { outboundByHost: routes }) });
      const sessionId = browser.sessionId();
      this.store.sessionOpened({ id: sessionId, kind: workspace === undefined ? "shared" : "workspace", workspace: workspace ?? null, openedAt: Date.now() });
      browser.on("disconnected", () => {
        this.store.sessionClosed(sessionId);
        if (this.browsers.get(key)?.launched === launched) this.browsers.delete(key);
        // Browser Run ended it (its keep-alive, a release): the contexts and their tabs are gone; t3 drops them.
        for (const [contextKey, pending] of this.contexts) {
          void pending.then(
            (context) => {
              if (context.browser() === browser) {
                this.contexts.delete(contextKey);
                this.options.onContextClose?.(context);
              }
            },
            () => undefined,
          );
        }
      });
      return browser;
    })();
    const entry: WorkspaceBrowser = { key, workspace, launched, idleTimer: undefined, pending: 0 };
    this.browsers.set(key, entry);
    void launched.catch(() => {
      if (this.browsers.get(key) === entry) this.browsers.delete(key);
    });
    return entry;
  }

  private retireWhenIdle(entry: WorkspaceBrowser) {
    const delay = this.options.idleBrowserMs;
    if (delay === undefined || this.closing || entry.pending > 0) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => void this.retire(entry), delay);
  }

  private async retire(entry: WorkspaceBrowser) {
    const browser = await entry.launched.catch(() => undefined);
    if (!browser || this.browsers.get(entry.key) !== entry || entry.pending > 0) return;
    if (browser.contexts().length > 0) return;
    this.browsers.delete(entry.key);
    await this.closeBrowser(browser);
  }

  private async closeBrowser(browser: Browser & { sessionId(): string }) {
    const sessionId = browser.sessionId();
    await browser.close().catch(() => undefined);
    await environmentServices()
      .browserRun?.closeSession(sessionId)
      .catch(() => undefined);
    this.store.sessionClosed(sessionId);
  }

  /** Every page of `context` gets the `localhost` translation and the download fix before t3's listeners run. */
  private preparePages(context: BrowserContext, workspace: string | undefined) {
    this.workspaceOfContext.set(context, workspace);
    const prepare = (page: Page) => {
      this.workspaceOfContext.set(page, workspace);
      const goto = page.goto.bind(page);
      page.goto = ((url: string, options?: Parameters<Page["goto"]>[1]) => goto(translatePreviewUrl(url), options)) as Page["goto"];
      page.on("download", (download: Download) => {
        const target = download.url();
        (download as { saveAs: (path: string) => Promise<void> }).saveAs = async (path: string) => {
          const bytes = await fetchFromPage(page, target).catch(() => {
            throw new Error("This download is not available in the Cloud Environment: the page may not read it.");
          });
          await StateFs.writeFile(path, bytes);
        };
      });
      page.on("filechooser", (chooser) => patchUploads(chooser, "setFiles", (self) => this.workspaceOfContext.get((self as { page(): Page }).page())));
      patchUploads(page.locator("html"), "setInputFiles", (self) => this.workspaceOfContext.get((self as { page(): Page }).page()));
    };
    for (const page of context.pages()) prepare(page);
    context.on("page", prepare);
  }

  /** A profile context saves its state every PROFILE_SAVE_MS, and is saved and closed after `idleBrowserMs` with no page. */
  private keepProfile(context: BrowserContext, profileId: string, key: string, pending: Promise<BrowserContext>) {
    const save = async () => {
      const state = (await context.storageState({ indexedDB: true } as never)) as unknown;
      if (this.store.saveProfile(profileId, JSON.stringify(state)) === "too-large") {
        console.warn(JSON.stringify({ t3flare: "preview-profile-too-large", profile: profileId.slice(0, 64) }));
      }
    };
    const timer = setInterval(() => void save().catch(() => undefined), PROFILE_SAVE_MS);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const pageCount = () => context.pages().length;
    const watch = () => {
      clearTimeout(idle);
      const delay = this.options.idleBrowserMs;
      if (delay === undefined || pageCount() > 0) return;
      idle = setTimeout(() => {
        if (pageCount() > 0 || this.contexts.get(key) !== pending) return;
        this.contexts.delete(key);
        void save()
          .catch(() => undefined)
          .then(() => context.close())
          .catch(() => undefined);
      }, delay);
    };
    context.on("page", (page) => {
      clearTimeout(idle);
      page.once("close", watch);
    });
    const close = context.close.bind(context);
    context.close = (async (options?: Parameters<BrowserContext["close"]>[0]) => {
      clearInterval(timer);
      clearTimeout(idle);
      if (!context.browser()?.isConnected()) return close(options);
      await save().catch(() => undefined);
      return close(options);
    }) as BrowserContext["close"];
    context.on("close", () => {
      clearInterval(timer);
      clearTimeout(idle);
    });
    watch();
  }

  contextFor(profileId: string, isolationKey?: string, threadId?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const workspace = threadId === undefined ? undefined : threadWorkspaceFrom(environmentServices().sql)(threadId);
    const key = JSON.stringify([profileId, isolationKey ?? null, workspace ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(profileId)?.catch(() => undefined) ?? Promise.resolve();
    const pending: Promise<BrowserContext> = cleared
      .then(() => this.createContext(profileId, isolationKey, workspace))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
          const entry = this.browsers.get(workspace ?? "");
          if (entry !== undefined) this.retireWhenIdle(entry);
        });
        if (this.closing) {
          await context.close().catch(() => undefined);
          throw new Error("The preview browser is closed.");
        }
        const persistent = isolationKey === undefined && profileId !== INCOGNITO_BROWSER_PROFILE_ID;
        if (persistent) this.keepProfile(context, profileId, key, pending);
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey: string | undefined, workspace: string | undefined) {
    const entry = this.browserFor(workspace);
    clearTimeout(entry.idleTimer);
    entry.pending++;
    try {
      const browser = await entry.launched;
      const persistent = isolationKey === undefined && profileId !== INCOGNITO_BROWSER_PROFILE_ID;
      const saved = persistent ? this.store.profile(profileId) : undefined;
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        ...(saved === undefined ? {} : { storageState: JSON.parse(saved) as never }),
      });
      this.preparePages(context, workspace);
      return context;
    } finally {
      entry.pending--;
      this.retireWhenIdle(entry);
    }
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const entry = this.browserFor(undefined);
    clearTimeout(entry.idleTimer);
    entry.pending++;
    try {
      const context = await (await entry.launched).newContext();
      context.on("close", () => this.retireWhenIdle(entry));
      try {
        const page = await context.newPage();
        page.once("close", () => void context.close().catch(() => undefined));
        return page;
      } catch (cause) {
        await context.close().catch(() => undefined);
        throw cause;
      }
    } finally {
      entry.pending--;
      this.retireWhenIdle(entry);
    }
  }

  // oxlint-disable-next-line require-await -- stock's signature; there is no desktop app on this host.
  async connectDesktopPage(_endpoint: string): Promise<{ browser: Browser; page: Page }> {
    throw new Error("The Cloud Environment has no desktop app to attach to.");
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const existing = this.clearing.get(profileId);
    if (existing) return existing;
    const clearing = (async () => {
      for (const [key, pending] of this.contexts) {
        const [id, isolation] = JSON.parse(key) as [string, string | null, string | null];
        if (id !== profileId || isolation !== null) continue;
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        // Its cookies go first, so the save its close makes keeps nothing of them.
        await context?.clearCookies().catch(() => undefined);
        await context?.close().catch(() => undefined);
      }
      this.store.clearProfile(profileId);
    })();
    this.clearing.set(profileId, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(profileId) === clearing) this.clearing.delete(profileId);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled([...this.contexts.values()].map(async (pending) => (await pending).close()));
    this.contexts.clear();
    const entries = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        clearTimeout(entry.idleTimer);
        const browser = await entry.launched.catch(() => undefined);
        if (browser !== undefined) await this.closeBrowser(browser);
      }),
    );
  }
}
