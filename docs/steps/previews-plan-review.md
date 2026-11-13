# Review of `docs/steps/previews-plan.md` (G11)

Fable, 2026-11-13, read-only (source and docs; nothing run). Not read: ADRs 0003, 0010, 0024, 0028; `upstream-fragility.md` by headings only; ADR-0021 and cloudpid's `container-preview.ts` grepped; the `@cloudflare/playwright` fork's source not opened.

**Verdict: go with changes.** The architecture is sound and isolates better than any alternative, but M3 cannot pass as written (H1) and the M0 spike misses four risks that decide the design.

## Claims checked

- **Confirmed against t3 at `d8f3feff0c`:** the stream route, its scopes and `authenticateMediaRequest`; the CSP `sandbox` header at `http.ts:63`; `McpAppFrame.tsx:479-480` frames without `allow-same-origin`; the session cookie is `sameSite: "lax"`; the `-html` suffix in `McpAppSnapshot.ts`; `ServerBrowserContexts` is a class built with `new` at `ServerBrowser.ts:527`; one `contextFor` call site at `:906`; `ServerBrowserPage.ts` imports Playwright types only.
- **Confirmed against Cloudflare docs:** pricing, `keepAlive` 10 s to 20 min, HTTP-only outbound routing, routes fixed at acquire, `@cloudflare/playwright` 1.4.0 with peer `playwright-core *`.
- **Not found in the docs:** the eight-hostname and port-80 limits, the `localhost` refusal, and "Browser Run cannot reach private addresses". The last two rest on cloudpid's observation only.

## HIGH

**H1. `ServerBrowserStream.routeLayer` cannot be mounted unchanged; it needs a Node socket.** It calls `NodeHttpServerRequest.toIncomingMessage(request)` (`self => self.source`) and uses `incoming.socket` as `transport`, reading `transport.writableLength` on every write and calling `transport.destroy()`. Our `platform/httpServer.ts` builds requests with `HttpServerRequest.fromWeb`, so `source` is a web `Request`, `socket` is `undefined`, and the first frame write throws. The plan lists this file as unchanged and M0 does not test it. Fix: in our own `httpServer.ts`, give upgrade requests a `source` of `{ headers: {}, socket: { writableLength, destroy } }` backed by the `WebSocketPair` (our code; no Shadow or Patch). The 8 MiB slow-viewer guard then needs a buffered-bytes figure; if workerd exposes none, record the guard as lost under R7. Add to M0.

## MEDIUM

**M1. R3 cites a sentence not in the current docs, which say the opposite.** The outbound-workers page (updated 2026-11-10): "Outbound routing lasts until the browser session closes. It also applies when a later Worker invocation reconnects with `connectSession()`. Routed requests go to the currently deployed version." The docs example uses a static service binding; the real question is whether a `ctx.exports.ContainerPreviews({props})` Fetcher is accepted and keeps its props. Fix: rewrite R3 and M0 question 2 around that; if props do not survive there is no per-Workspace identity, and the plan goes to O3.

**M2. Downloads and path uploads probably cross two file systems.** `ServerBrowser.ts:1175-1181` `download.saveAs(path)` then `NodeFSP.stat(path)`; `:1322` `chooser.setFiles([...paths])`. t3's `node:fs` is aliased to the State directory (`fsAlias`), while the fork needs native `node:fs` (workerd's). Uploads by path name Workspace files t3's file system does not hold. Fix: add both to M0 question 1; repair in the Shadow by wrapping `Download.saveAs` and `setFiles` through t3's `FileSystem`.

**M3. M1 is not independent of R1.** Stock `headlessChrome.ts` loads `http://t3-page.localhost` (`:51`) through `Fetch.fulfillRequest`, which the localhost policy may block too. The stock file also holds security logic the Shadow must copy: main frame pinned to t3's page, other document navigations failed, WebRTC deleted. Fix: add `t3-page.localhost` under `Fetch.enable` to M0 question 3. If it works, consider a smaller Shadow 4: a Layer gives `HtmlRender` a `ChildProcessSpawner` whose fd3/fd4 bridge to Browser Run's CDP socket, and the Shadow covers only `publicProxy.ts` (224 lines), so stock's 638 lines of guards keep tracking upstream (bridge untested).

**M4. The Worker-side probe of configured preview URLs is a blind SSRF.** `previewUrl` comes from the repo's t3 project file (`contracts/src/t3ProjectFile.ts:61`); the Environment Worker lacks `global_fetch_strictly_public` (only the MCP Worker has it). Fix: probe through the MCP Worker's public fetch or the existing guard (`apps/agents/test/web/ssrf.test.ts`). A localhost probe must not count as use; as written it resets the idle stop and a polled URL holds the Container.

**M5. Browser lifetime and cost are under-specified; R5 is not "Low".** The viewer socket goes through `Idle.socketOpened()` and screencast is CDP activity, so a forgotten open panel keeps the Environment and browser alive indefinitely (~$0.09/h). An unwatched tab gets no CDP traffic, so Browser Run closes it at `keepAlive`: the Shadow must handle `disconnected` (drop contexts, fire `onContextClose`, `storageState` already saved). `listSessions` is account-wide (cloudpid and other stages), so M3's "list is empty" check fails falsely. Fix: track our own session ids, persist them, `closeSession` on boot; exit lines for a hidden panel left 30 minutes (browser-seconds recorded) and a tab left past `keepAlive`; apply the 30-minute cap to request-driven use too.

**M6. Bundle size and startup are not in M0.** `@cloudflare/playwright` is 8.2 MB unpacked, added to a Worker already bundling t3's server. Record gzipped size and startup in `m0-playwright.json`. Build question 1's call list by grep: it omits `grantPermissions(["clipboard-write"])`, `emulateMedia`, `newCDPSession(frame)`, `saveAs`, `setFiles` and `ServerBrowserPage`'s snapshot calls.

**M7. Port attribution trusts process environment and `comm`.** An agent can start a server with another thread's `T3CODE_THREAD_ID` or a forged `term-<key>`, or put quotes or newlines in `comm`. Reach is UI spoofing only (opening still routes to the opener's Workspace). Fix: drop markers naming a thread or terminal outside the Workspace, encode fields safely in the script, schema-decode each line.

## LOW

- **L1.** The harness panel on the t3 host: its change guard (`panel.ts:93-102`) refuses an opaque origin; add a POST to `/_t3flare/harness/api/mcp/servers` to the M1 and M5 hostile lists.
- **L2.** Assert `Content-Security-Policy: sandbox…` and `nosniff` on an HTML asset fetched directly, top-level and with `download`, on the stage (all of §0.3 rests on it).
- **L3.** Widen the SSRF list: `[::1]`, `0.0.0.0`, `127.1`, `*.localhost`, `metadata.google.internal`, the t3 host's `/_t3flare`.
- **L4.** `storageState` in its own table outside t3's `FileSystem`; `storageState({ indexedDB: true })` with a size cap (8 MB a row).
- **L5.** Never set `recording`, never mint Live View URLs (credentials), never log preview request URLs or cookies; assert it.
- **L6.** R1's hook may not need a Patch: the Shadow could translate `localhost` in a wrapped `page.goto`, if `ServerBrowser.ts` navigates through `goto` (unchecked).
- **L7.** R9 is larger: `crypto.randomUUID` also needs a secure context; a page on 5173 calling `http://localhost:3000/api` breaks too.
- **L8.** Serve the WebSocket shim from `/__t3flare/ws/shim.js` as well as inline, for pages with `script-src 'self'`.
- **L9.** M2 exit line: a running, idle Container still stops at 2 minutes with the panel open and polling.
- **L10.** M5 relay: limit `resources/read` to `ui://` on the tool's own server, cap size, pass through only `_meta.ui`.

## Isolation summary

Dev-server JS versus t3: sound (never runs in the owner's browser; Browser Run holds no t3 credential). Workspace A versus B: sound if `ctx.exports` props hold (M1). `computer.internal`: not in `outboundByHost`, so it does not resolve. Public pages in the same browser: an `http` page can send blind requests to the dev server, as on a laptop; `https` pages are blocked as mixed content. Agent HTML and MCP apps: opaque origin; the asset URL is a capability scoped to its asset; residual `allow-popups` top-level GETs carry the Lax cookie, as on stock.

## Shadows and Patches (4 and 5)

Shadow 3 necessary (a class built with `new`). Shadow 4 necessary in some form; could shrink to `publicProxy.ts` (M3). Patch 0005 necessary and minimal (`isolationKey` carries the thread only for isolated contexts). H1's fix adds neither.

## O1–O5

- **O1 agree.** The 10 included browsers are shared account-wide with cloudpid.
- **O2 agree.** Stock and strongest isolation; cost is the lost secure context (L7).
- **O3 agree with (a), two conditions:** Chrome in the Container must never load an owner profile (agents could attach to its debug port); an R1-only failure should use URL translation (L6), not O3.
- **O4 agree.** An opaque origin cannot set cookies; L2 is the condition.
- **O5 agree.** Record the reason, since stock's docs name Claude as supported.
