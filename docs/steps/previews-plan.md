# Previews (parity G11, SPI-1002): plan

Status: in implementation on branch `previews` (2026-11-13). Owner decision D4 (2026-11-11): previews are part of parity, built last. Ticket: SPI-1002. Pinned t3: `t3code` at `d8f3feff0c`. Anchors drift; grep the symbol.

## Review changelog (2026-11-13, implementation)

Fable's review (`previews-plan-review.md`) overrides this plan. Each finding is folded in below; where a section further
down disagrees with this changelog, the changelog wins. The owner accepted O1–O5 as recommended, with the review's two
conditions on O3. Findings that M0 had to settle are marked **(M0)**; their answers are in the M0 section of
`docs/steps/previews.md` and in the rows below once known.

**Findings.**

| # | Change to the plan |
|---|---|
| H1 | Accepted (read `ServerBrowserStream.ts`: `NodeHttpServerRequest.toIncomingMessage(request).socket` is the transport, `writableLength` read per write, `destroy()` on a slow viewer, and `incoming.headers[...]` deleted). Our `platform/httpServer.ts` gives an upgrade request a `source` of `{ headers, socket: { writableLength, destroy } }` backed by the `WebSocketPair`: our code, no Shadow or Patch. `writableLength` is the socket's `bufferedAmount` if workerd has one **(M0)**, else 0, and the 8 MiB slow-viewer guard is recorded as lost under R7. |
| M1 | Accepted: the docs (updated 2026-11-10) say routing lasts until the session closes and applies to later `connectSession()` calls. R3 is rewritten: the question is whether a `ctx.exports.ContainerPreviews({ props })` Fetcher is accepted in `outboundByHost` and keeps its props for a page loaded 5 minutes and 3 Environment invocations after acquisition **(M0 question 2)**. If not, there is no per-Workspace identity and the plan goes to O3. |
| M2 | Accepted. M0 question 1 adds `download.saveAs` + `stat` and `chooser.setFiles(paths)`. The Shadow wraps `Download.saveAs` (the fork's stream written through t3's `node:fs` alias) and `setFiles` with paths (read through t3's `FileSystem`, passed as buffers). |
| M3 | Accepted. M0 question 3 adds `http://t3-page.localhost` under `Fetch.enable`. If it is served, **Shadow 4 shrinks**: there is no Shadow of `headlessChrome.ts`; our process router (already our `ChildProcessSpawner` Layer) answers `PreviewBrowser`'s constant executable with a CDP bridge to a route-less Browser Run browser (fd 3 in, fd 4 out, NUL-delimited, as `--remote-debugging-pipe`), so stock's 638 lines of guards (main frame pinned, other documents failed, WebRTC deleted) keep tracking upstream. Shadow 4 becomes `htmlRender/publicProxy.ts` (224 lines; workerd has no `node:net` server), and Browser Run's own egress replaces its SOCKS guard, which M0 tests against the widened private list (L3). |
| M4 | Accepted. A configured preview URL on `localhost` is probed through the Workspace DO, which never starts the Container and does not count it as use. Any other URL is probed through the MCP Worker, which has `global_fetch_strictly_public`, never from the Environment Worker. The M2 hostile list gets the blind-SSRF probe. |
| M5 | Accepted; R5 becomes Medium. The Shadow keeps its own Browser Run session ids in Environment DO storage, closes any left at boot (never `listSessions`, which is account-wide), and handles `disconnected` (contexts dropped, `onContextClose` fired, `storageState` already saved). The 30-minute cap applies to request-driven use too. M3 gets exit lines for a hidden panel left 30 minutes (browser-seconds recorded) and a tab left past `keepAlive`. |
| M6 | Accepted. `m0-playwright.json` records the bundle's gzipped size before and after and the Worker's startup; `@cloudflare/playwright` is loaded by dynamic import, off the startup path. Question 1's call list was rebuilt by grep (`grantPermissions(['clipboard-write'])`, `emulateMedia`, `newCDPSession(frame)`, `saveAs`, `setFiles`, `ariaSnapshot({ mode: 'ai', boxes: true })`, `exposeFunction`, locator actions). |
| M7 | Accepted. The scan script JSON-encodes every field; the Layer schema-decodes each line, drops a `T3CODE_THREAD_ID` or `term-<key>` marker that names a thread or terminal outside the Workspace, and clips `comm`. |
| L1 | Accepted: M1 and M5 hostile lists get a POST to `/_t3flare/harness/api/mcp/servers` from the opaque-origin page. |
| L2 | Accepted: the stage asserts `Content-Security-Policy: sandbox …` and `X-Content-Type-Options: nosniff` on an HTML asset fetched directly, top-level and with `download`. |
| L3 | Accepted: the private list is `127.0.0.1`, `[::1]`, `0.0.0.0`, `127.1`, `*.localhost`, `10.0.0.1`, `169.254.169.254`, `metadata.google.internal`, the `*.t3flare.internal` names and the t3 host's `/_t3flare`. |
| L4 | Accepted: profile state lives in its own DO SQLite table (`t3flare_preview_profiles`), outside t3's `FileSystem`, saved with `storageState({ indexedDB: true })` and refused over 8 MB a row. |
| L5 | Accepted: `recording` is never set, no Live View URL is minted, and no preview request URL or cookie is logged; a unit test asserts the acquire options and the log lines. |
| L6 | Accepted, checked: `ServerBrowser.ts` navigates only through `page.goto` (`:1111`, `:1789`, `:2646`) and `page.reload`. If R1 holds, the Shadow wraps `goto` on every page of its contexts to translate `localhost:N`; Patch 0005 carries only the thread. |
| L7 | Accepted: R9 adds `crypto.randomUUID` and cross-port `localhost` calls. |
| L8 | Accepted: the shim is also served at `/__t3flare/ws/shim.js`. |
| L9 | Accepted: M2 exit line, a running idle Container still stops at 2 minutes with the panel open and polling. |
| L10 | Accepted: the relay passes `resources/read` only for a `ui://` URI of the calling tool's own server, caps its size, and passes only `_meta.ui` of a tool's `_meta`. |
| O3 | Accepted with both conditions: Chrome in the Container never loads an owner profile, and an R1-only failure is fixed by URL translation (L6), not by O3. |

**Corrections from re-reading stock and the account (not in the review).**

| # | Change to the plan |
|---|---|
| C1 | Stock lists only attributed listeners: `probeWebServers` returns `servers.filter(isOwned)` (`PortScanner.ts`, "Owned listeners are listed as plain HTTP without a request"), plus configured URLs that probe as web. §2.1 and M2 are corrected to stock: an unattributed listener (a `nohup` server) is **not** listed. |
| C2 | **OS1 is not needed.** cloudpid's CI deploy token holds exactly our account permission groups (Workers Scripts Write, Workers Containers Write, Secrets Store Write, Account Settings Read, Access Apps and Policies Write; `~/src/cloudpid/infra/github.ts`) and deploys a Worker with `BROWSER: Cloudflare.Browser()` (`apps/browser/src/resource.ts`) to prod from CI (run 43093747070, "Deploy prod", 2026-11-11, success). No `infra/github.ts` change and no `ci:setup` re-run. |
| C3 | One throwaway stage, `previews`, replaces `prev0`–`prev5` (owner instruction), deployed as few times as possible and destroyed at the end. Nothing lands on `main` from this branch; the owner merges. |
| C4 | M0 question 5 (HMR through the shim) moves to M3's exit: it needs the Container preview that M3 builds, and does not decide the design (cloudpid measured it in production). |
| C5 | `@cloudflare/playwright` 1.4.0 is a port of Playwright **1.62.1**, not 1.64 (`lib/playwright-core/package.json.js`). t3's `import type` of `playwright-core` 1.64.1 is satisfied by casting at the Shadow's boundary; U59 watches the gap. |

The parity rows covered here (`docs/parity.md` § Previews): port discovery, the server browser and dev-server preview, the agent browser tools, HTML visual replies, and MCP apps. The device hub stays refused (ADR-0024).

## 0. What stock t3 actually does (read before the decisions)

Four findings change the brief's framing. Each is checked against the pinned source.

1. **Stock t3 never serves a dev server to the user's browser.** The route registered at `srv/server.ts:800` (`layerMakeRoutes`) is `ServerBrowserStream.routeLayer`: `GET /api/preview-stream/ws` and `/download`, and `POST /api/preview-stream/upload` (`preview/ServerBrowserStream.ts:29`, `:288-296`). It streams **CDP screencast frames** of a headless Chrome that runs on t3's host, one frame in flight with an ack, and sends input back. The user's browser shows JPEGs. The dev server's own JavaScript runs only in t3's headless Chrome, which loads `http://localhost:<port>` (`ServerBrowser.ts:1780`; `docs/user/remote-access.md` "Browser on a remote environment": "every other device … streams them from the host … `localhost` addresses reach servers on the host"). Only the desktop app shows its own environment's tabs directly, and the Cloud Environment is never that.
   - **Consequence:** a stock-faithful port needs **no preview origin, no new hostname and no certificate** on the client side. A dev server's script never runs on t3's origin, because it never runs in the owner's browser at all.
   - An authenticated proxy from the t3 host to a Container port would be a t3flare addition, with no stock counterpart. §2.2 weighs it and keeps it only as a fallback.
2. **Stock auth on the stream** is `authenticateMediaRequest` (`auth/http.ts:165`): t3's own WebSocket-ticket or session check for kind `"media"`, then a scope check. Watching needs `orchestration:read`, and operating needs `preview:operate` (`ServerBrowserStream.ts:73-76`). `/api/preview-stream/*` already sits under `/api`, which our Worker forwards to the Environment DO (`apps/environment/src/worker.ts:30`). No new auth is needed.
3. **HTML renders and MCP apps are isolated on t3's own host, by an opaque origin.** Both are stored as attachments and framed from the asset route.
   - The route answers `text/html` with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads` (`apps/server/src/http.ts:63`, which comments: "Opaque origin blocks cookies, storage and API access while allowing scripts").
   - MCP app snapshots take a `-html` suffix so the same route serves them sandboxed (`mcpApps/McpAppSnapshot.ts:66`).
   - The web client frames them without `allow-same-origin`: `McpAppFrame.tsx:479-480` uses `sandbox="allow-scripts allow-forms"`, and `HtmlRenderFrame.tsx` loads a long-lived asset URL.
   - t3's session cookie is `SameSite=Lax` (`auth/http.ts:209`).
   - So stock needs no second domain for either. cloudpid's ADR-0031 chose a separate registrable domain (`ianpascoe.app`) because the MCP Apps spec asks for one. Stock t3 did not follow that, and under the back-to-stock rule we follow stock (§2.5).
4. **Brief corrections.**
   - `apps/web/src/components/mcp/mcpApps.ts` is the "Use T3 Code in another app" hand-off list (ChatGPT, Claude and other logos), not MCP Apps rendering. The rendering lives in `apps/web/src/components/chat/McpAppFrame.tsx`, `@t3tools/client-runtime/mcp-apps`, and the server's `apps/server/src/mcpApps/` (`McpAppRequests`, `McpAppSnapshot`, `McpAppModelContext`).
   - cloudpid's "hosted browser" decision is its ADR-0007 (one shared Browser Run session) together with **ADR-0023** (Container previews through Browser Run's outbound Workers). Its ADR-0039 is about MCP sampling.

Also relevant:
- `PortScanner.ts` uses lsof only as a fallback. On Linux it reads `/proc/net/tcp{,6}`, `/proc/*/fd`, `/proc/<pid>/comm` and `/proc/<pid>/environ` (`:546-580`), and attributes a listener to a thread by `T3CODE_THREAD_ID` in the process's environment (`:70`, `:357`).
- `ServerBrowser.ts` imports Playwright **types only**. Its one runtime touchpoint is `ServerBrowserContexts.ts` (287 lines), which calls `chromium.launch`, `launchPersistentContext` and `connectOverCDP`.
- `HtmlRender` reaches Chrome only through `htmlRender/headlessChrome.ts` (`captureHtmlScreenshot`, `measureHtmlHeights`) and `PreviewBrowser`, which downloads the executable. Publishing works without a browser: heights fall back (`HtmlRender.ts:435`).

What t3flare does today:
- `composition.ts:446` builds stock `PortScanner.layer` over stock `ProcessRunner`, which reports lsof "not found" and reads `/proc` from the State directory, where it is empty.
- `ServerBrowser.layer` and `PreviewBrowser.layer` are composed (`:748-750`), but the stream route is not mounted (`:717-735`), `serverBrowser` is stripped (`capabilities.ts:76`), and `enableAgentBrowserAccess` is pinned off at each boot (`agents/seedSettings.ts:67`, `layerPinAgentBrowserAccessOff`).
- `T3_TOOL_DENYLIST` holds `html_*`, `preview_*`, `t3_preview_*` and `device_*` (`packages/harness-registry/src/t3Tools.ts:13`).
- The CLI wrapper strips `mcpApps` from every CLI runtime (`provider/cli/wrapper.ts:152`, since step 4a, `143bd11`).
- Patch 0001 already makes `ServerBrowserPage.ts` load in workerd, so the preview modules are in the bundle today.

## 1. The shape

t3's preview stack stays stock above three seams: where Chrome comes from, where `localhost` goes, and how ports are listed.
- **Chrome is Cloudflare Browser Run.** The Browser Run binding (formerly Browser Rendering) is bound on the Environment Worker and driven by t3's own `ServerBrowser` through `@cloudflare/playwright`. It sits behind a Shadow of `ServerBrowserContexts.ts` and a Shadow of `htmlRender/headlessChrome.ts`.
- **`localhost` goes to the Workspace's Container.** It is routed through Browser Run's `outboundByHost` to an entrypoint of ours, which hands the request to the thread's Workspace DO. The DO fetches the Container port with `ctx.container.getTcpPort(port)`, as cloudpid's ADR-0023 does. A small script injected into each page carries HMR WebSockets over HTTP, because Browser Run routes only HTTP.
- **Ports are listed by the Workspace DO** from a `/proc` scan inside a running Container, never starting one. Our own `PortDiscovery` Layer, which replaces `PortScanner.layer`, merges the results.
- **The owner watches through t3's own screencast route.** No dev-server byte reaches the owner's browser except as frames. No new hostname, certificate or DNS record is needed.
- **HTML renders and MCP apps** keep stock's opaque-origin sandbox on the t3 host.
- **The tool denylist shrinks** to `t3_attachment_*`, `t3_thread_send_attachments`, `device_*` and `t3_worktree_*`.

## 2. Decisions, with evidence

### 2.1 Port discovery: a `/proc` scan in the Container, through the Workspace DO; our `PortDiscovery` Layer

- **Where the scan runs.** It is a shell script shipped in the image (`apps/sandbox-image/src/ports.ts`, beside `kill.ts` and `process.ts`), run by the Workspace DO with `ctx.container.exec` (no PTY), the same way the kill script runs.
  - It reads `/proc/net/tcp` and `/proc/net/tcp6` for state `0A` (LISTEN), maps socket inodes to pids through `/proc/[0-9]*/fd`, and prints one JSON line per listener: `port`, `host`, `pid`, `pgid`, `comm`, and two values taken from `/proc/<pid>/environ`.
  - Those values are `T3CODE_THREAD_ID`, which the CLI agents carry (`provider/cli/codexDriver.ts:111`, the ACP profiles), and `T3FLARE_EXEC`, carried by terminals (`term-<key>`, `terminalHost.ts:196`) and by the Durable agent's commands (its exec id).
  - It needs no `lsof` and no new image package. `process.ts:78` already greps `/proc/*/environ` the same way.
- **Why not stock `PortScanner.make` over a routed `FileSystem` and `ProcessRunner`.**
  - One Environment has up to three Containers (`budget.ts` `MAX_CONTAINERS = 3`), each with its own port namespace and pid space.
  - Stock's single-host model would need a `FileSystem` whose `/proc` is a merge of three machines, and pid 1234 would mean three processes.
  - The service is a `Context.Service` with seven methods (`PortScanner.ts:30-67`), so a Layer is the right seam (ADR-0001), not a Shadow.
- **`apps/environment/src/preview/portDiscovery.ts`** provides `PortScanner.PortDiscovery`:
  - **`scan` and `subscribe`** ask each Workspace DO whose Container is **running** (the budget's lease list, `ContainerBudget`) for its listeners.
    - A stopped Container contributes nothing and is **never started**.
    - A scan is neither use nor input: it does not reset the idle stop.
    - Polling follows stock's cadence only while a client `retain`s, and stops when none does.
  - **Each `DiscoveredLocalServer`** keeps stock's shape (`contracts/src/preview.ts:305`): `url: http://localhost:<port>`, `terminal: {threadId, terminalId}` from a `term-<key>` marker (the terminal adapter knows key → thread and terminal), and `agent: {threadId}` from `T3CODE_THREAD_ID`, or from a Durable exec id through the Session's thread.
    - A listener with no marker is a Workspace process (a setup script, `nohup`). It is listed with neither field, as stock lists one it cannot attribute.
    - computerd's own port (`8080`, `apps/sandbox-image/image/Dockerfile:158`) and the image's own daemons are never listed.
  - **`stopServer({pid, port})`** resolves `(pid, port)` against the last snapshot to one Workspace.
    - If two Workspaces have the same pair, it refuses with `not-found`, and the client rescans.
    - Otherwise it sends the image's kill script for the pid's process group. Stock's own guard (`stoppableProcessGroup`) answers `shared-group` when the group holds a shell, a CLI agent or computerd.
  - **`registerTerminalProcesses`, `unregisterTerminal` and `trackAgent`** are no-ops. Attribution comes from the environment markers instead of pids, and our terminal Layer deliberately does not register synthetic pids (`terminal/layer.ts:13`).
  - **`T3CODE_PORT_DISCOVERY=0`** is honoured by a fixed environment value, which we never set.
- **Configured preview URLs** (a project script's **Preview URL**) are web-probed by stock with `HttpClient` from the host. Here a configured URL on `localhost` is probed through the same Workspace DO route as the browser (§2.2). Any other URL is fetched from the Worker, as stock would.
- **A known gap, matching stock's semantics.** Two Workspaces can both list `localhost:5173`. t3's UI scopes a server to a thread by its `terminal` or `agent` field. An unattributed one shows for every thread, and opening it in a thread's tab reaches **that thread's** Workspace (§2.2), as `localhost` on a laptop reaches the one machine.

### 2.2 Dev-server preview: through t3's own server browser, with `localhost` routed to the thread's Container

**Recommended: follow stock.** The owner sees a dev server in t3's browser panel as screencast frames over `/api/preview-stream/ws`, authenticated by t3 (§0.2). The page itself loads in a Browser Run Chrome whose `localhost` reaches the thread's Workspace Container.

- **Routing (cloudpid ADR-0023, reused).**
  - Browser Run refuses `localhost` by policy (`ERR_BLOCKED_BY_ADMINISTRATOR`). Its `outboundByHost` routes only `http`, on port 80, for at most eight exact hostnames fixed when the browser is acquired (docs: `browser-run/features/outbound-workers`; changelog 2026-09-21).
  - So each browser is acquired with eight virtual hosts, `http://<port>.t3flare.internal/`, for ports 3000, 3001, 4173, 4321, 5173, 5174, 8000 and 8787. 8080 is computerd's and is never routed. All eight go to a Fetcher made with `ctx.exports.ContainerPreviews({ props: { workspace } })`.
  - Our Shadow of `ServerBrowserContexts` installs a context-level `route` on `http://localhost:*/**` and `http://127.0.0.1:*/**`. A **main-frame navigation** gets a `302` to `http://<port>.t3flare.internal<path>`.
  - So every stock path works unchanged: the discovered server's `localhost` URL, the agent's `{kind: "port"}` target (`ServerBrowser.ts:1780`), and a typed URL. A port outside the eight answers a short page that names the eight.
  - Subresource requests from a page already on the virtual host go straight to the outbound route, with no interception.
- **One Browser Run browser per Workspace.**
  - Routes are per browser, and a Fetcher's props are fixed at acquisition, so the Workspace is the browser's identity.
  - `contextFor(profileId, isolationKey)` must therefore know the tab's thread. **Patch 0005** adds `snapshot.threadId` as a third argument at its one call site (`ServerBrowser.ts:906-909`). Our Shadow maps thread → Workspace with the existing locator (`agents/workspaceClient.ts` `locate`).
  - The encoder's `scratchPage` (`:1833`) uses a route-less shared browser.
  - **Cost:** concurrent browsers peak at the number of Workspaces with open tabs, at most a handful. Workers Paid includes 10 browsers (a monthly average of the daily peak), then $2 each, and 10 browser-hours a month, then $0.09 an hour (docs: `browser-run/pricing`).
- **Profiles.** Browser Run has no persistent user-data directory, so `launchPersistentContext` becomes `newContext({ storageState })`.
  - Each profile's state is saved to the Environment DO's storage when its context closes and every 60 s while open. That is the same data stock keeps in its profile directory on the host.
  - Last writer wins when two Workspace browsers share a profile.
  - `clearProfile` deletes the stored state.
- **WebSockets (HMR).** cloudpid's `CONTAINER_PREVIEW_SCRIPT` and its Workspace DO side are ported: `~/src/cloudpid/apps/server/src/workspace/container-preview.ts`, `container-preview-script.ts`, `apps/browser/src/container-preview.ts`.
  - The script is injected at the start of each HTML page the DO serves. It replaces `WebSocket` for the page's own host with an SSE stream plus POSTs, and hides `SharedWorker`.
  - The DO holds the real socket to the Container.
  - The endpoints move under `/__t3flare/ws/*`. They require `x-t3flare-preview: 1` and the page's own `Origin`, and a socket id is 256 random bits.
  - cloudpid measured Vite's HMR through this with no reload and no added delay.
- **Container sleep and wake.**
  - The Workspace DO's `containerPreview(request, port)` **never starts the Container**. A stopped one answers `503` ("the Workspace's Container is stopped; run the dev server again"). A port with nothing listening answers `502` ("listen on 0.0.0.0"), because the port is reached on the Container's interface.
  - Each served request is **use**: it resets the 2-minute idle stop. It is not **input** (ADR-0021's terminology).
  - A carried socket is a **hold** capped as ADR-0021 caps a foreground terminal: 30 minutes from the last input in the Workspace. An open preview therefore keeps the Container only while someone works there.
  - A preview never takes a budget lease, because it never starts a Container, so the 3-Container budget is unchanged.
- **Browser lifetime.**
  - The browser's CDP socket lives in the Environment DO, as stock's lives in t3's process. Stock's idle retire (`idleBrowserMs`) closes it.
  - Browser Run's `keepAlive` is set to 10 minutes, so a gap in CDP traffic does not lose the session. The maximum is 20 minutes.
  - An Environment idle reset or restart ends the browsers and their tabs, as it ends terminals (ADR-0021 D1, ADR-0004). Tabs come back empty, and profile state survives.
  - Browser Run also closes sessions when it rolls out a release.
- **The rejected option: an authenticated proxy on a preview host.** It needs:
  - a new origin per Workspace, to keep dev servers' storage apart;
  - a two-level wildcard (`*.preview.ianpascoe.dev`), which needs Advanced Certificate Manager because Universal SSL covers only the apex and first-level names (docs: `ssl/edge-certificates/universal-ssl/limitations`), or a new registrable domain (cloudpid's ADR-0031 reasoning on same-site cookie tossing);
  - a session hand-off from t3's host-only cookie to that origin;
  - and it runs untrusted dev-server JS in the owner's browser.

  Stock has none of it. Under the back-to-stock rule it is **not built**. It is the fallback only if Browser Run's outbound routing goes away or an app needs a secure context (owner decision O3).
- **Not a secure context: the cost of following stock here.** A page's origin is `http://<port>.t3flare.internal`, not `localhost`, so there is no `crypto.subtle`, service worker or clipboard API, and OAuth redirect URIs or CORS lists pinned to `localhost` see another origin. It is recorded as a parity P row.

### 2.3 Server browser and agent browser tools: Browser Run from the Environment Worker (recommended) vs Chrome in the Container

| | **Browser Run** (binding on the Environment Worker, `@cloudflare/playwright`) | Headless Chrome in the Workspace Container |
|---|---|---|
| Reaches the dev server | Yes, through `outboundByHost` and the Workspace DO, eight ports. HMR needs the injected shim | Natively. `localhost` is a secure context |
| Reaches the public web | Yes, from Cloudflare's network. It cannot reach private addresses, as stock's `publicProxy` guarantees for HTML previews | Yes, through the Container's egress |
| Works without a Container | Yes: HTML previews, public pages and t3's own docs | No. Every tab, even a public page or an HTML render, starts a Container and takes one of 3 budget slots |
| Playwright client in workerd | `@cloudflare/playwright` 1.4.0 (standard CDP since 1.3.0; peer `playwright-core *`) | Needs a custom CDP transport over `getTcpPort(9222)`, which nothing ships |
| Cost | $0.09/browser-hour after 10 h/month; 10 concurrent included. A short screenshot is seconds | Image grows by about 400 MB. Chrome takes 0.3–0.6 GB of the 3 GiB beside computerd and the CLIs (`WorkspaceDO.ts:183`). Each open tab holds a Container at about $0.03/h or more |
| Latency | Each subresource makes a Browser Run → Worker → DO → Container round trip. Measured adequate for Vite by cloudpid (spike #244). A screenshot is one CDP call | Lowest |
| Screenshots and screencast | CDP `Page.captureScreenshot` and `Page.startScreencast`, which t3 already uses | Same |
| Precedent | cloudpid ADR-0007, ADR-0023, in production | None |

**Recommendation: Browser Run.** The deciding rows are "works without a Container" and the budget. Stock keeps one browser for HTML renders and tabs. A Container browser would spend a budget slot and Container-hours on every screenshot of agent HTML, and would put Chrome next to the agent's own processes. The agent's browser reaches the Container's dev server through §2.2's routes: an agent tab is just another tab in its Workspace's browser.

**Agent browser tools.**
- `preview_open`, `preview_snapshot`, `preview_act`, `preview_evaluate`, `preview_navigate`, `preview_wait_for`, `preview_status`, `preview_resize`, `preview_set_appearance`, `preview_dialog`, `preview_recording_start` and `preview_recording_stop`, plus `t3_preview_list` and `t3_preview_close`, are t3's own (`apps/server/src/mcp/`). They run against `ServerBrowser` through `PreviewAutomationBroker` (composed, `composition.ts:761`).
- They work once the browser does. What remains is to stop pinning `enableAgentBrowserAccess` off and to lift the denylist (§2.7). Recording uses `scratchPage` and the encoder page, both inside Browser Run.

### 2.4 HTML visual replies (`html_render`, `html_preview`)

- **Rendering in the client is stock.** A published page is an attachment served by the asset route under t3's CSP `sandbox` (§0.3), framed without `allow-same-origin`. That is an opaque origin, so it reads no cookie, no storage of t3's and no API with credentials. `layerAssetRoute` is already mounted. No new origin is needed.
- **`html_render` (publish)** needs no browser. Heights are measured when a browser is available and fall back otherwise (`HtmlRender.ts:409-435`).
- **`html_preview`** (the agent's screenshot check) and publish's height measure go through `headlessChrome.ts`.
  - **Shadow** it with the same exports (`captureHtmlScreenshot`, `measureHtmlHeights`, `ConsoleMessage`, `HtmlRenderBrowserError`) over a **route-less** Browser Run browser. That browser is shared by HTML work, has no `outboundByHost`, and closes 60 s after its last use. A page under check therefore cannot reach any Container, and it never reaches private addresses because Browser Run's egress is public. That is stock's `publicProxy` guarantee (`html-renders.md`), given by the platform.
  - Replace `PreviewBrowser` (a `Context.Service`) with a **Layer** whose executable is a constant and which never downloads. The 120 MB Chrome download (`PreviewBrowser.ts`) does not apply.
  - `PreviewBrowserHost`'s Linux sandbox checks never run.
- **Local images by path** (`readPageFile`, `HtmlRender.ts:441`) read through t3's `FileSystem`. M1 checks whether a Workspace path (`/workspace/...`) resolves through our file system. If it does not, the agent gets t3's own `HtmlRenderImagesNotFoundError`, and the parity row is P until a Layer reads Workspace files.

### 2.5 MCP apps

- **Client side: stock.** `McpAppFrame` frames the app snapshot from the asset route, opaque-origin sandboxed (§0.3). No sandbox domain is needed: stock t3 chose the opaque origin over the ext-apps spec's separate-origin proxy, and parity is stock. Owner decision O4 records the alternative, cloudpid's `ianpascoe.app` scheme.
- **Server side: what blocks it today.**
  1. **The CLI wrapper strips `mcpApps`** (`wrapper.ts:152`). Stop stripping it. Stock implements it for Codex (`CodexAdapterV2.ts:7460`: `listTools`, `callTool` and `readResource` through Codex's app-server). Our Codex is t3's own adapter over the Process channel, so its `mcpApps` works once the CLI can read the resource.
  2. **The MCP relay and host must carry an app.** Today the relay and host serve `tools` only, with no `resources/read` (`docs/steps/tools-plan.md:346`, `:365`, `:623`).
     - Pass through each tool's `_meta.ui` (`resourceUri`, visibility) in `tools/list`.
     - Forward `resources/read` for `ui://` URIs to the owning server. The MCP Worker's engine already runs `resources/read` (`apps/mcp-worker/src/engine/calls.ts:795`).
     - Keep ADR-0028's write-or-read class on app-initiated `tools/call`. Stock's own rule, "T3 Code asks first unless the server marks the tool as read-only", already matches it.
- **Who gets apps.** Stock docs: "Codex and Claude support this today … other providers show these calls as ordinary tool calls".
  - **Codex:** W after this work.
  - **Claude:** ours runs over ACP, not t3's native `ClaudeAdapterV2`, whose `mcpApps` (`:13151`) is native-SDK only. Claude shows ordinary tool rows, recorded as **P** with that reason.
  - **OpenCode, Pi CLI and Pi Durable:** ordinary rows, as stock pi.
  - No Durable differ change is needed for parity.

### 2.6 Origins, DNS and certificates

- **New public hostnames: none.** The screencast is on the t3 host. HTML renders and MCP apps are opaque origins on the t3 host. Container previews are virtual `*.t3flare.internal` names that exist only inside Browser Run's routing table: `.internal` is reserved for private use, never resolves publicly and is not HSTS-preloaded. cloudpid uses `.cloudpid.internal` the same way.
- **Certificates: none.** Universal SSL limits do not arise.
- **Bindings the deploy stack creates by itself** (`apps/environment/alchemy.run.ts`):
  - `BROWSER` (Browser Run) on the Environment Worker;
  - a `ContainerPreviews` entrypoint on the Environment Worker;
  - a service binding from the Environment Worker to a `WorkspaceContainerPreviews` entrypoint on the agents Worker, which has no public URL.
- **Owner-only, possibly:** the CI tokens' permission groups (`infra/github.ts:49`, `STAGE_DEPLOY_PERMISSIONS`) are set by `ci:setup`, which the owner runs with the `admin` profile.
  - If uploading a Worker with a `browser` binding needs a permission beyond `Workers Scripts Write`, the prod deploy fails until the owner re-runs `ci:setup`. That would be "Browser Rendering - Edit"; the docs name it for the REST API.
  - M0 finds out on a throwaway stage. If it is needed, the change to `infra/github.ts` lands with M3 and the owner runs one command. **Flagged: owner-only step OS1.**

### 2.7 The back-to-stock rule

- **Kept, because they are forced:**
  - **Opaque-origin isolation** of HTML and apps. This is stock's own mechanism.
  - **Browser Run's** eight-port list and the virtual hostnames, which come from the platform.
  - **The shim's header and `Origin` checks.** Without them another page in the same browser could write into a carried socket. This is security.
  - **A preview never starts a Container**, which cost forces: the process is gone after a stop anyway.
  - **The 30-minute hold cap**, which follows ADR-0021's cost rule.
- **Not added:** no per-tool approval, no allowlist of sites, no cap on tabs beyond stock's, no preview-specific setting, and no gate on agent browser access beyond t3's own `enableAgentBrowserAccess`.
- **Removed:** `layerPinAgentBrowserAccessOff`. The setting becomes the owner's, with stock's default.
- **The denylist after G11:** `t3_attachment_*`, `t3_thread_send_attachments`, `device_*` (host-bound, ADR-0024) and `t3_worktree_*`. **Leaving it:** `html_*` (in M1), `preview_*` and `t3_preview_*` (in M4). t3's guidance filter (`t3Guidance.ts`) follows the list automatically (U49).
- **Capabilities:** `serverBrowser` is no longer stripped (M3). The device hub flags stay stripped.
- **SPI-1104** (outside agents see `preview_*` and `html_*` tools that cannot work) closes with M4.

## 3. Milestones

Every milestone deploys a throwaway stage (`apps/environment/scripts/stage.ts`, stage `prev`). It writes its evidence to `docs/steps/previews/*.json` and lands on `main` only after `pnpm run check`. An "exit" fails if any line fails. The hostile cases are tests a stage script runs, not arguments.

### M0. Spike: Browser Run under t3's `ServerBrowser` (stage `prev0`; no `main` change)

Questions:
1. Does `@cloudflare/playwright` 1.4.0 serve every Playwright call `ServerBrowser.ts` and `ServerBrowserPage.ts` make? That list is `newContext`, `newPage`, `context.newCDPSession`, `page.on("download" | "filechooser" | "dialog" | "popup")`, `storageState`, `addInitScript`, `route`, `screenshot`, and a raw CDP `Page.startScreencast`. playwright-core is pinned at 1.64.1 by t3. The fork's typings must satisfy t3's `import type` of `playwright-core`.
2. Does `outboundByHost`, with a `ctx.exports` Fetcher made in the same invocation, survive the Environment DO's later invocations? The docs say the Fetcher is "not persisted with the browser session and cannot be reused by a later invocation". cloudpid's ADR-0023 relies on routes that "outlive the invocation and the object that made it"; confirm which holds today.
3. Does a main-frame navigation to `http://localhost:5173/` reach a context `route` handler, or does Browser Run's `URLBlocklist` policy refuse it first (R1)?
4. Is the CI token enough to upload a `browser` binding (OS1)?
5. Does Vite HMR survive the ported shim? Timings: first paint of a Vite app, and an HMR round trip.

Exit:
- [ ] `m0-playwright.json`: each call above passes or is listed with its replacement.
- [ ] `m0-routes.json`: a page loaded 5 minutes and 3 Environment invocations after acquisition still reaches the Container.
- [ ] `m0-localhost.json`: either the 302 path works, or R1's fallback is chosen.
- [ ] `m0-hmr.json`: an edit is applied without a reload, p50 timing recorded.
- [ ] Cost: browser-seconds for one `html_preview`, and for 10 minutes of watching a tab.

A "no" on question 1 or 2 stops the plan. §5 O3 then decides between the Container-Chrome and proxy fallbacks.

### M1. HTML visual replies

- Bind `BROWSER` on the Environment Worker.
- Shadow `htmlRender/headlessChrome.ts` (route-less browser).
- Add a `PreviewBrowser` Layer that never downloads.
- Lift `html_*` from `T3_TOOL_DENYLIST`.
- Update ADR-0022's refinement and the parity row.

Exit (stage `prev1`, `docs/steps/previews/html.json`):
- [ ] Pi Durable and Codex each publish a chart page with `html_render`. It appears in the thread on web, and on mobile if the owner's app is to hand; otherwise the web client's narrow layout. The page follows a theme switch.
- [ ] `html_preview` returns a screenshot that the Durable agent sees as an image. This needs t3-mcp to carry MCP `image` parts as pi image content, a gap today (R6).
- [ ] A CDN script loads in a preview.
- [ ] A local image by Workspace path embeds, or the P row is written with t3's own error.
- [ ] **Hostile:** a published page runs:
  - `document.cookie`: empty or throws, opaque origin;
  - `fetch("/api/auth/session", {credentials:"include"})`: 401, no cookie sent;
  - `localStorage`: throws;
  - `window.top.location = …`: blocked;
  - `window.parent.postMessage` to read t3's state: ignored;
  - a `<form method=post target=_blank action=/api/…>` submit: no session cookie on the popup's POST (SameSite=Lax).

  Each answer is recorded.
- [ ] **Hostile:** `html_preview` of a page that fetches `http://5173.t3flare.internal/`, `http://169.254.169.254/` and `http://10.0.0.1/` is refused or times out each time: no Container is reached.

### M2. Port discovery

- `apps/sandbox-image/src/ports.ts` (the scan script) and an image bump.
- `WorkspaceDO.listeners()` (no start, no use) and `WorkspaceDO.stopListener(pid, pgid)`.
- `apps/environment/src/preview/portDiscovery.ts` replaces `layerPortScanner` in `composition.ts` (both places it is provided).

Exit (stage `prev2`, `ports.json`):
- [ ] `npm run dev` (Vite on 0.0.0.0:5173) in a terminal lists with `terminal: {threadId, terminalId}`.
- [ ] A dev server started by a Codex agent lists with `agent: {threadId}`, and so does one started by a Pi Durable agent.
- [ ] An unattributed `nohup` server lists with neither field.
- [ ] Two Workspaces both on 5173 list twice.
- [ ] computerd (8080) is never listed.
- [ ] With every Container stopped, an open client lists nothing, **the budget's lease list is unchanged** and no Container starts. The Workspace DO's logs show no `container-start` for 10 minutes of an open browser panel.
- [ ] `stopServer` on the Vite pid stops it. On the terminal's shell pid it answers `shared-group`. On a pid in two Workspaces it answers `not-found`.

### M3. Server browser and dev-server preview

- **Shadow `preview/ServerBrowserContexts.ts`:** Browser Run, one browser per Workspace with routes, profiles as `storageState` in Environment DO storage, and the localhost 302 or R1's fallback.
- **Patch 0005:** the thread passed to `contextFor`.
- **The `ContainerPreviews` entrypoint** (Environment Worker), plus the service binding and `WorkspaceContainerPreviews` (agents Worker). The latter answers `ws:<id>` names only and reaches no other DO method.
- **`WorkspaceDO.containerPreview(request, port)`** with the eight-port list, Host and Location rewriting, the carried-socket shim, and the use and hold accounting, all ported from cloudpid.
- **Mount `ServerBrowserStream.routeLayer`** in `layerMakeRoutes`.
- **Stop stripping `serverBrowser`** (`capabilities.ts:76`), and update the ADR-0023 and ADR-0024 tests.
- **OS1, if M0 found it.**

Exit (stage `prev3`, `browser.json`):
- [ ] From the web client, open the discovered `localhost:5173` in a thread's browser panel. Frames arrive. Clicking and typing work with control taken, and a read-only session watches without operating.
- [ ] An edit to the Vite app's source shows in the panel without a reload (HMR).
- [ ] A download is offered to the device. An upload through a file chooser reaches the page.
- [ ] A popup opens as its own tab.
- [ ] A cookie set by a logged-in page survives closing and reopening the tab (profile `storageState`), and `clearProfile` removes it.
- [ ] The Container's idle stop holds while the page is open and someone types in the Workspace. It lets go 30 minutes after the last input with the page still open. A stopped Container answers the panel 503, and the Container is not restarted.
- [ ] An Environment restart closes the tabs and their Browser Run sessions. The active-sessions list (binding `sessions` method) is empty within `keepAlive`.
- [ ] **Hostile (preview JS vs t3):** the dev server serves a page that tries:
  - `fetch("https://<t3 host>/api/auth/session", {credentials:"include"})`;
  - `new WebSocket("wss://<t3 host>/ws")`;
  - `fetch("https://<t3 host>/mcp")`;
  - reading `document.cookie` for t3's cookie.

  Each gets 401 or nothing: the Browser Run browser holds no t3 credential. The owner's real browser receives only frames; `/api/preview-stream/ws` delivers no HTML or script.
- [ ] **Hostile (Workspace A vs B):**
  - From a tab of Workspace A, `fetch("http://5173.t3flare.internal/")` answers A's server, never B's, while B also serves 5173.
  - A request with a forged `Host`, `X-Forwarded-Host` or `ws:<B>` value cannot select B. The entrypoint's props are fixed at acquisition, and `WorkspaceContainerPreviews` checks the name.
  - A page in A posting to `/__t3flare/ws/send` with another socket's id gets a 404.
  - A cross-origin page (a public site in the same browser) posting to `http://5173.t3flare.internal/__t3flare/ws/send` without the header is refused by the preflight, or answered 403.
  - Port 8080 (computerd) through the route answers a 404 page that asked nothing of the Container.
- [ ] **Hostile (route reach):** the agents Worker's `WorkspaceContainerPreviews` is reachable only by service binding. The Environment Worker's public routes do not expose `ContainerPreviews`: `GET https://<t3 host>/__t3flare/ws/open` answers the web client's asset fallback or 404, never a Container.
- [ ] **Unauthenticated stream:** `GET /api/preview-stream/ws` without a ticket gets 401. With an `orchestration:read`-only session it gets frames but no input.

### M4. Agent browser tools

- Delete `layerPinAgentBrowserAccessOff` and its test.
- Lift `preview_*` and `t3_preview_*` from the denylist.
- Make t3-mcp carry image parts (R6).
- Update parity rows; SPI-1104 closes.

Exit (stage `prev4`, `agent-browser.json`):
- [ ] With `enableAgentBrowserAccess` on (owner's setting, stock default), a Pi Durable agent starts Vite, calls `preview_open` with `{kind:"port", port:5173}`, then `preview_snapshot`, `preview_act` (click) and `preview_evaluate`, and reports the page's heading. A Codex agent does the same.
- [ ] The owner watches the agent's tab live in the panel and takes control.
- [ ] `preview_recording_start` and `preview_recording_stop` return a recording.
- [ ] With the setting off, neither agent kind is offered `preview_*`. This is t3's own scope check, not ours.
- [ ] **Hostile:** a dev-server page whose text instructs the agent to "open http://5173.t3flare.internal on workspace B" gets only A's server. The agent's `preview_evaluate` running `fetch` against t3's API gets 401.

### M5. MCP apps

- Stop stripping `mcpApps` in `wrapper.ts`.
- MCP relay and host: `_meta.ui` passes through `tools/list`, and `resources/read` passes for `ui://`.
- Parity row: Codex W, Claude P (ACP), others as stock.

Exit (stage `prev5`, `mcp-apps.json`). The test server is a throwaway public Worker serving the ext-apps example `get-time` app, added as a direct server in the harness panel.
- [ ] A Codex agent calls the tool, and the app renders in place of the tool row on web.
- [ ] The app's call to a read-only tool runs without asking, and its call to a write tool asks first.
- [ ] Its `ui/message` asks before posting. `updateModelContext` reaches the next turn.
- [ ] **Hostile:** the app script runs:
  - `parent.document`: throws;
  - `document.cookie`, `localStorage`: empty or throw;
  - a `fetch` to t3's `/api` with credentials: 401;
  - navigating itself to `https://evil.example`: the app is stopped, as stock says;
  - a `postMessage` with a forged `callTool` for another server's tool: refused by `McpAppRequests` (server name bound to the snapshot).
- [ ] A Claude thread calling the same tool shows an ordinary tool row: P, recorded.

### M6. Records

- New **ADR-0031**: "Previews run in Browser Run, with `localhost` routed to the thread's Workspace Container".
- Refinements: ADR-0024 (previews built), ADR-0022 (denylist), ADR-0010 (the preview stream route mounted), ADR-0021 (preview hold), ADR-0028 (apps through the MCP host).
- `docs/parity.md` Previews rows and G11.
- Fragility U59–U63 (§7).
- GLOSSARY terms: **Container preview**, **Preview browser**.
- Close SPI-1002.

## 4. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | Browser Run's `URLBlocklist` refuses `localhost` before a context `route` can redirect it, so the 302 never runs | Medium / blocks every stock `localhost` URL | M0 question 3. **Fallback:** a second Patch line in `ServerBrowser.ts` passes navigation URLs through an exported `translatePreviewUrl` hook (identity in stock). It is called where `normalizePreviewUrl` results are navigated (`resolveNavigationUrl`, `:1774`; the open path). Our Shadow sets it to map `localhost:N` to `N.t3flare.internal`. Links inside a page that hard-code `localhost` stay broken (a P row) |
| R2 | `@cloudflare/playwright` lags or diverges from playwright-core 1.64 (`newCDPSession`, downloads, file choosers) | Medium / partial browser | M0 question 1. A missing call gets a raw-CDP replacement inside the Shadow, never a t3 change. U59 watches the pin |
| R3 | `outboundByHost` Fetchers do not outlive the acquiring invocation (the docs' constraint, against cloudpid's observation) | Medium / routes die between DO invocations | M0 question 2. If they die: re-acquire the Workspace's browser at the start of each Environment invocation that opens or navigates a preview tab, carrying cookies over in `storageState` (tabs reload). If that is too disruptive, fall back to O3 |
| R4 | Browser Run routes only HTTP: the HMR shim fails for clients that open sockets from workers or to other hosts, and a page whose CSP forbids inline scripts gets no sockets | Medium for non-Vite stacks / no live reload | The same limits as cloudpid's ADR-0023. A P note in parity. A manual reload still works |
| R5 | Cost runaway: an agent leaves tabs open, or many Workspaces browse at once | Low / dollars | Stock's idle retire, Browser Run `keepAlive` of 10 min, browsers close on Environment reset. Concurrency is bounded by Workspaces with tabs. Stage evidence records browser-seconds. Browser hours appear on the Workers bill only, with no t3 meter |
| R6 | Durable agents cannot see screenshots: t3-mcp carries no MCP `image` parts today | High / `html_preview`, `preview_snapshot` blind for Pi Durable | M1 adds image parts to `apps/agents/src/extensions/t3-mcp.ts`, bounded as pi's `read` bounds images |
| R7 | The Environment DO's 128 MB isolate holds screencast frames and carried-socket buffers | Low / DO restart | t3's one-frame-in-flight ack. The shim's unread cap is set well below cloudpid's 96 MiB (8 MiB here; the Environment DO also runs t3) |
| R8 | Profile `storageState` races between two Workspace browsers | Low / a lost login | Last writer wins. Profiles are the owner's own logins |
| R9 | Not a secure context: `crypto.subtle`, service workers and the clipboard are absent on `http://N.t3flare.internal`; apps pinned to `localhost` origins fail OAuth or CORS | Certain for some apps / app-specific | P row. O3's proxy fallback would give `https` |
| R10 | The 8-port list misses a project's port | Medium / no preview for it | The list is a constant. The panel answers with the eight. Widening means swapping ports, still at most 8 |
| R11 | Workspace-path images in `html_render` may not resolve through our `FileSystem` | Medium / images missing | M1 check. A P row, or a later Layer |
| R12 | A nightly reshapes `PortDiscovery`, `ServerBrowserContexts`, `headlessChrome` exports or the `contextFor` call | Medium per bump / build fails | Typecheck catches the service shape. The Shadows are exact-export modules. U59–U63 |

## 5. Owner decisions (the owner is away: the plan proceeds on the recommendations; none blocks M0–M2)

- **O1. Browser Run as t3's browser** (§2.3). **Recommend yes.** The alternative is Chrome in each Workspace Container: native `localhost`, but a Container for every HTML screenshot and public tab, and Chrome inside the 3 GiB.
- **O2. Previews follow stock's screencast; no dev-server proxy to the owner's browser** (§2.2). **Recommend yes.** It needs no new hostname, certificate or session hand-off, and runs no dev-server script in the owner's browser. The cost: pages are not a secure context (R9).
- **O3. Fallback if M0 fails (R1–R3)**, in order of preference:
  - (a) **Chrome in the Container for `localhost` tabs only**, with Browser Run for everything else;
  - (b) **an authenticated preview host**: a new registrable domain with a wildcard, as cloudpid's `ianpascoe.app`. This is owner-only: buying the domain, the zone, and the token's DNS and route permissions.

  **Recommend (a).** (b) adds untrusted script in the owner's browser and owner-only steps.
- **O4. MCP apps keep stock's opaque-origin sandbox on the t3 host** rather than cloudpid's separate-domain proxy, which is what the ext-apps spec asks for (§2.5). **Recommend yes:** it is stock, and parity. The spec's separate origin matters to apps that need their own storage. With an opaque origin, an app's `localStorage` throws, exactly as on stock t3.
- **O5. Claude's MCP apps stay ordinary rows** (ACP has no app channel; stock's support is in its native-SDK adapter). **Recommend accept (P).** Building app support into our ACP driver would be custom scope.
- **OS1 (owner-only step, only if M0 finds it).** Re-run `pnpm --filter @t3flare/infra run ci:setup` after `infra/github.ts` gains the Browser Run permission group. One command, workstation only.

## 6. Shadow and Patch impact (now: 2 Shadows, 4 Patches)

| Kind | Item | Why this layer | After |
|---|---|---|---|
| Layer | `PortScanner.PortDiscovery` → `env/preview/portDiscovery.ts` | A `Context.Service`; a Layer is enough (ADR-0001) | — |
| Layer | `PreviewBrowser.PreviewBrowser` → a constant executable, no download | A `Context.Service` | — |
| Layer | (removed) `layerPinAgentBrowserAccessOff` | back to stock | — |
| **Shadow 3** | `apps/server/src/preview/ServerBrowserContexts.ts` → `env/shadows/serverBrowserContexts.ts` | A class (not a service) that `ServerBrowser.make` constructs with `new`. Its only job is getting Playwright browsers, which is exactly our seam | Shadows **2 → 4** |
| **Shadow 4** | `apps/server/src/htmlRender/headlessChrome.ts` → `env/shadows/headlessChrome.ts` | Module functions `HtmlRender` calls directly; spawns Chrome with `--remote-debugging-pipe` | |
| **Patch 0005** | `ServerBrowser.ts` `contextFor(…, snapshot.threadId)` (one call site, one argument), plus R1's `translatePreviewUrl` hook if M0 needs it | The thread is known only at the call site; a Shadow of the 3,011-line `ServerBrowser.ts` would be far worse | Patches **4 → 5** |

Not changed: `ServerBrowser.ts` beyond Patch 0005, `ServerBrowserStream.ts`, `ServerBrowserPage.ts` (Patch 0001 stays), `Manager.ts`, `HtmlRender.ts`, `McpAppRequests.ts`, `CodexAdapterV2.ts`, and every web component. `build.ts`'s `SHADOWS` gains two entries. `@cloudflare/playwright` is a dependency of `apps/environment` only, added with `pnpm run relock` (ADR-0030).

## 7. Fragility entries (to add to `docs/upstream-fragility.md` as each milestone lands)

### U59. The preview browser's Shadow and Browser Run (M3; M1 for the HTML half)
- **Where:**
  - `env/shadows/serverBrowserContexts.ts`, which replaces `preview/ServerBrowserContexts.ts`. It keeps the class shape `ServerBrowser.make` uses: `contextFor`, `scratchPage`, `connectDesktopPage` (refused), `clearProfile` and `close`, plus the `Options` fields, and `presentAsChrome`.
  - `env/shadows/headlessChrome.ts`, which replaces `htmlRender/headlessChrome.ts`: `captureHtmlScreenshot`, `measureHtmlHeights`, `ConsoleMessage` and `HtmlRenderBrowserError`.
  - `@cloudflare/playwright` against t3's `playwright-core` pin (1.64.1 at `d8f3feff0c`).
- **Breaks when:**
  - t3 adds a method or option to `ServerBrowserContexts`, or a new export to `headlessChrome.ts`;
  - `ServerBrowser.ts` starts using a Playwright API the fork lacks;
  - t3 bumps `playwright-core` past what the fork speaks;
  - Browser Run changes `outboundByHost` (HTTP only, 8 hosts, port 80) or its `keepAlive` bounds.
- **Detection:** the build fails on a missing export, since a Shadow must export what importers use. Typecheck catches the class shape. `test/serverBrowserContexts.test.ts` drives a fake binding. **Silent:** a Playwright call that exists but misbehaves over CDP. Cheapest check: `scripts/previews.ts browser` on a stage.
- **Blast radius:** no browser tabs or no HTML screenshots. Publishing still works.
- **Fix:** diff `ServerBrowserContexts.ts`, `headlessChrome.ts` and the `playwright-core` version in `apps/server/package.json` between tags. Check the fork's changelog.

### U60. Port discovery from the Container (M2)
- **Where:** `env/preview/portDiscovery.ts`, a Layer of `PortScanner.PortDiscovery` (seven methods, `PortScanner.ts:30-67`); `DiscoveredLocalServer` and `PreviewStopLocalServerError` (`contracts/src/preview.ts`); `AGENT_THREAD_ENV` (`T3CODE_THREAD_ID`); the image's `ports.ts`.
- **Breaks when:** t3 adds a method or a field (say, a workspace or cwd on a server), renames the thread env variable, or changes the stop errors' reasons.
- **Detection:** typecheck covers the service and contracts. `test/portDiscovery.test.ts` checks the marker parsing. **Silent:** a renamed `T3CODE_THREAD_ID` makes agent servers unattributed. Cheapest check: `scripts/previews.ts ports`.
- **Blast radius:** servers listed without their thread, or not listed.
- **Fix:** diff `PortScanner.ts` and `contracts/src/preview.ts`.

### U61. Patch 0005: the thread at `contextFor` (M3)
- **Where:** `patches/0005-server-browser-context-thread.patch`, at the one `contexts.contextFor(` call in `ServerBrowser.ts` (and R1's hook if taken).
- **Breaks when:** the call moves, gains arguments, or a second call site appears.
- **Detection:** the patch fails to apply at bump, which is loud. **Silent:** a new call site without the thread falls to the route-less browser, so its tab cannot reach `localhost`. The test asserts every `contextFor(` in `ServerBrowser.ts` passes three arguments.
- **Blast radius:** tabs that cannot reach the dev server.
- **Fix:** re-cut the patch.

### U62. Container previews and the carried-socket shim (M3)
- **Where:** `WorkspaceDO.containerPreview`, `agents/src/workspace/containerPreview.ts` and `containerPreviewScript.ts` (ported from cloudpid, at a recorded cloudpid commit); the `ContainerPreviews` and `WorkspaceContainerPreviews` entrypoints; the 8-port list.
- **Breaks when:** Browser Run starts routing WebSockets (the shim becomes dead weight), a dev-server client changes how it opens sockets (Vite's `SharedWorker` ping), or Containers change `getTcpPort`.
- **Detection:** `test/containerPreview.test.ts` (Host and Location rewriting, refusals, socket framing). **Silent:** HMR stops working while pages still load. Cheapest check: `scripts/previews.ts hmr`.
- **Blast radius:** no live reload; preview page still loads.
- **Fix:** compare with cloudpid's current `container-preview*.ts`; it hits the same breakage first.

### U63. MCP apps through the CLI wrapper and the MCP host (M5)
- **Where:** `provider/cli/wrapper.ts` (no longer strips `mcpApps`); `ProviderAdapterV2McpApps` (`provider-core/src/server/ProviderAdapter.ts:635`); the relay and host's `_meta.ui` passthrough and `resources/read` for `ui://`; `McpAppRequests` and `McpAppSnapshot`.
- **Breaks when:**
  - t3 changes `ProviderAdapterV2McpApps`;
  - Codex's app-server renames `mcpServerStatus/list` or the resource call;
  - the ext-apps spec moves the `_meta` key, which t3 would follow and our passthrough must too.
- **Detection:** typecheck covers the adapter shape. `test/mcpApps.test.ts` covers the passthrough. **Silent:** a renamed `_meta` key shows plain rows. Cheapest check: `scripts/previews.ts apps`.
- **Blast radius:** apps show as ordinary tool rows.
- **Fix:** diff `mcpApps/`, `CodexAdapterV2.ts`'s `mcpApps`, and the ext-apps spec version t3 pins.

## 8. Files and seams

`env/` is `apps/environment/src/`, `agents/` is `apps/agents/src/`, and `t3:` is `t3code/apps/server/src/`.

| Milestone | File (new or changed) | Seam / what changes | Stock counterpart |
|---|---|---|---|
| M0 | `apps/environment/scripts/previews.ts` (new; subcommands `spike`, `html`, `ports`, `browser`, `hmr`, `agent`, `apps`) | The stage harness and the hostile cases | — |
| M1 | `apps/environment/alchemy.run.ts` | `BROWSER` binding on the Environment Worker (alchemy's `BrowserBinding`, `@alchemy.run/cloudflare` `lib/Workers/BrowserBinding`, typed `BrowserRun`) | — |
| M1 | `env/shadows/headlessChrome.ts` (new); `apps/environment/build.ts` `SHADOWS` | Shadow: Browser Run, route-less | `t3:htmlRender/headlessChrome.ts` |
| M1 | `env/preview/previewBrowser.ts` (new); `env/t3/composition.ts:750` | Layer of `PreviewBrowser`: no download | `t3:preview/PreviewBrowser.ts` |
| M1 | `packages/harness-registry/src/t3Tools.ts:13` | `html_*` off the denylist | — |
| M1 | `agents/extensions/t3-mcp.ts` | MCP `image` parts → pi image content (R6) | t3's pi provider |
| M2 | `apps/sandbox-image/src/ports.ts` (new), image build | `/proc` listener scan with environ markers | `t3:preview/PortScanner.ts:546-580` |
| M2 | `agents/workspace/WorkspaceDO.ts` | RPCs `listeners()` and `stopListener()`: never start the Container, not use | — |
| M2 | `env/preview/portDiscovery.ts` (new); `composition.ts:446`, `:449`, `:641` | Layer of `PortDiscovery` replacing `PortScanner.layer` | `t3:preview/PortScanner.ts` |
| M3 | `env/shadows/serverBrowserContexts.ts` (new); `build.ts` `SHADOWS` | Shadow: Browser Run browser per Workspace, `storageState` profiles, localhost redirect | `t3:preview/ServerBrowserContexts.ts` |
| M3 | `patches/0005-server-browser-context-thread.patch` (new) | `contextFor(…, threadId)`; R1's URL hook if needed | `t3:preview/ServerBrowser.ts:906` |
| M3 | `env/preview/containerPreviews.ts` (new; exported `WorkerEntrypoint` `ContainerPreviews`) | `outboundByHost` target, props `{workspace}`, forwards over the service binding | cloudpid `apps/browser/src/container-preview.ts` |
| M3 | `agents/workspace/containerPreview.ts`, `containerPreviewScript.ts` (new); `agents/index.ts` entrypoint `WorkspaceContainerPreviews`; `WorkspaceDO.containerPreview` | `getTcpPort` fetch, 8 ports, Host and Location rewriting, carried sockets, use and hold accounting | cloudpid `apps/server/src/workspace/container-preview*.ts` |
| M3 | `apps/environment/alchemy.run.ts` | Service binding Environment → agents `WorkspaceContainerPreviews` | — |
| M3 | `env/t3/composition.ts:717-735` | Mount `ServerBrowserStream.routeLayer` | `t3:server.ts:800` (`layerMakeRoutes`) |
| M3 | `env/t3/capabilities.ts:76`; `test/capabilities.test.ts` | `serverBrowser` kept | — |
| M3 | `infra/github.ts:49` (only if OS1) | Browser Run permission group | — |
| M4 | `env/agents/seedSettings.ts:67`; `composition.ts:624` | Delete `layerPinAgentBrowserAccessOff` | — |
| M4 | `packages/harness-registry/src/t3Tools.ts:13` | `preview_*` and `t3_preview_*` off the denylist | — |
| M5 | `env/provider/cli/wrapper.ts:152` | Keep `mcpApps` | `t3:orchestration-v2/Adapters/CodexAdapterV2.ts:7460` |
| M5 | `agents/workspace/mcpRelay.ts`; `env/mcp/*` (MCP host); `apps/mcp-worker/src/engine` | `_meta.ui` in `tools/list`; `resources/read` for `ui://` | `t3:mcpApps/McpAppRequests.ts` |
| M6 | `docs/adr/0031-previews-run-in-browser-run-with-localhost-routed-to-the-threads-container.md` (new); ADR-0010, 0021, 0022, 0024 and 0028 refinements; `docs/parity.md`; `docs/upstream-fragility.md`; `GLOSSARY.md` | Records | — |

## 9. Order and size

M0 (spike, about 1 day) → M1 (HTML, small) → M2 (ports, medium) → M3 (browser, large: most of G11's "L") → M4 (agent tools, small) → M5 (MCP apps, medium) → M6.

- M1 and M2 do not depend on M0's routing answers: M1 needs only the route-less browser, and M2 needs no browser. If the owner is still away after M0, they can land first.
- M3 waits for M0, plus OS1 if M0 finds it needed.
