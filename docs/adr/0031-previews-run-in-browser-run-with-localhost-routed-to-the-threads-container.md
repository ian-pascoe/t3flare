# Previews run in Browser Run, with `localhost` routed to the thread's Container

Status: accepted (owner decisions O1–O5, 2026-11-13; built in G11, SPI-1002). Plan: [`docs/steps/previews-plan.md`](../steps/previews-plan.md) with its review changelog; report: [`docs/steps/previews.md`](../steps/previews.md).

Stock t3's previews stay stock above three seams: where Chrome comes from, where `localhost` goes, and how ports are listed.

- **Chrome is Cloudflare Browser Run.** It is bound on the Environment Worker (`BROWSER`) and driven by t3's own `ServerBrowser` through `@cloudflare/playwright`, behind a Shadow of `preview/ServerBrowserContexts.ts`. t3's HTML renders keep stock `htmlRender/headlessChrome.ts`: our process router answers `PreviewBrowser`'s constant executable with a CDP bridge to a route-less Browser Run browser, and `htmlRender/publicProxy.ts` is Shadowed to a no-op, since Browser Run's egress refuses loopback and private addresses itself.
- **`localhost` is the thread's Workspace Container.** Each Workspace with open tabs has one Browser Run browser, acquired with `outboundByHost` routing eight virtual hosts, `http://<port>.t3flare.internal/` (ports 3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787), to a `ContainerPreviews` entrypoint made with that Workspace in its props. It hands each request to the agents Worker's `WorkspaceContainerPreviews`, which calls one method of that Workspace DO; the DO fetches the Container port with `getTcpPort`. Browser Run refuses `localhost` by policy, so the Shadow translates `localhost:<port>` in every page's `goto`. A page's WebSockets are carried over HTTP by a script injected into each HTML page (cloudpid's ADR-0023, ported). Patch 0005 passes the tab's thread to `contextFor`.
- **Ports are listed by each running Container's own `/proc`** (`WorkspaceDO.listeners`), never starting one, by our `PortDiscovery` Layer. As stock, only attributed listeners are listed: a terminal's (its shell's key) or an agent's (a CLI process's key, or `T3CODE_THREAD_ID`), and only within the scanned Workspace.

The owner watches through t3's own screencast route (`/api/preview-stream/*`, t3's auth), so no dev-server byte reaches the owner's browser except as frames, and no new hostname, certificate or DNS record exists. HTML renders and MCP apps keep stock's opaque-origin sandbox on the t3 host. The tool denylist shrinks to `t3_attachment_*`, `t3_thread_send_attachments`, `device_*` and `t3_worktree_*`; `serverBrowser` and `localServerStop` are advertised; agent browser access is the owner's setting with stock's default.

Forced by the platform or by cost, and kept: the eight-port list; the `*.t3flare.internal` names; a preview never starts a Container; a preview's requests and carried sockets keep a running Container only within ADR-0021's 30 minutes from the Workspace's last input; profiles are `storageState` in the Environment DO's own table (8 MiB a profile); Browser Run sessions are recorded and closed when a new Environment instance starts; nothing records a session or mints a Live View link.

## Considered options

- **Chrome in each Workspace Container** (O1, rejected; O3's fallback (a) for `localhost` tabs only, never with an owner profile). Native `localhost`, but every HTML screenshot and public tab would start a Container and take a budget slot, and Chrome would share the Container's 3 GiB.
- **An authenticated proxy on a preview host** (O2, rejected; O3's fallback (b)). It needs a new registrable domain or Advanced Certificate Manager, a session hand-off, and runs dev-server script in the owner's browser. Stock has none of it.
- **A Shadow of `headlessChrome.ts`** (the plan's Shadow 4). Replaced by the CDP bridge (review M3): stock's 638 lines of page guards keep tracking upstream; the Shadow is `publicProxy.ts` instead.
- **A separate-origin sandbox for MCP apps** (O4, rejected): stock frames apps in an opaque origin on its own host; so do we.

## Consequences

- **Not a secure context.** A dev server's page is `http://<port>.t3flare.internal`: no `crypto.subtle`, `crypto.randomUUID`, service workers or clipboard API, and OAuth redirects, CORS lists and cross-port calls pinned to `localhost` see another origin (R9, L7). HTML renders are `https://t3-page.t3flare.internal`, a secure context, so an `http:` resource in one is mixed content.
- **Eight ports.** A dev server elsewhere gets a page that names them.
- **Downloads** are fetched from the page that started them (the fork cannot copy an artifact off Browser Run's disk, cloudflare/playwright#93): a cross-origin download the page may not read fails.
- **A tab nobody watches ends.** Browser Run closes a session after 10 minutes without CDP traffic; t3 drops its tabs. Profiles survive.
- **Claude's MCP apps are ordinary tool rows** (O5): our Claude runs over ACP, and stock's app support is in its native-SDK adapter.
- **Cost.** Browser Run hours ($0.09/h after 10 a month) and concurrent browsers (10 included, account-wide with cloudpid). A watched tab holds the Environment and its browser; nothing else does.
- **Fragility:** U59–U63 in `docs/upstream-fragility.md`.
