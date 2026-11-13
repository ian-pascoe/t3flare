# Previews (parity G11, SPI-1002): report

Date: 2026-11-13. Branch `previews`, rebased onto `main` at 4561bb6. Plan: [`previews-plan.md`](previews-plan.md), with Fable's review folded in as its review changelog. Decision: [ADR-0031](../adr/0031-previews-run-in-browser-run-with-localhost-routed-to-the-threads-container.md). Evidence: [`previews/`](previews/). Stage harness: `apps/environment/scripts/previews.ts` (`lib/previewStage.ts`), with stage-only spike ops behind `POST /_t3flare/previews/spike`.

Throwaway stage `previews`: added to `STAGES`, deployed about ten times, then destroyed (9 resources).
- Most of those deploys were fixes found on the stage: the stream socket shim, the `tab-eval` op, the idle-reset close and the gesture flag.
- One set `T3FLARE_TERMINAL_IDLE_MS=180000` for the hold check.

t3code is untouched (pinned at d8f3feff, `v0.1.10-nightly.20261112.4606`). **Counts: Shadows 2 → 4, Patches 4 → 5**, as the plan expected, with one Shadow swapped (ADR-0001's counts):
- new Shadows: `preview/ServerBrowserContexts.ts`, `htmlRender/publicProxy.ts`;
- new Patch: `0005-server-browser-context-thread.patch`.

## For the owner

1. **Nothing owner-only is needed.** OS1 turned out unnecessary: the CI token's permission groups are the same ones cloudpid deploys a Browser Run binding with (C2). Merge `previews` when you are ready; prod's deploy creates the `BROWSER` binding, the `ContainerPreviews` export and the `WORKSPACE_PREVIEWS` service binding by itself.
2. **Cost (SPI-1123).** An open server-browser tab keeps its Browser Run session while anything keeps the Environment awake, an open web client included. Browser Run's 10-minute keep-alive never fires, because the profile is saved every 60 s over CDP. With no client, the Environment resets about 60 s after the last request, and the reset closes the sessions. The rate is about $0.09/h past the 10 included hours a month. Pick one of SPI-1123's three options: save on change only, retire unwatched tabs after 30 minutes as stock does for agent tabs, or accept the cost.
3. **Agent browser access is yours again,** with stock's default (on). The pin that held it off is gone.
4. **Not stage-checked (tickets):** Codex's HTML and browser tools and MCP apps end to end (SPI-1124); Workspace A against B on one port (SPI-1125).
5. SPI-1002 is In Review. SPI-1104 can close once this merges (`preview_*` and `html_*` now work for outside agents).

## M0 (the spike): what decided the design

`m0-spike.json` has every line; `m0-summary.json` reads them.

| Question | Answer | Consequence |
|---|---|---|
| 1. Does `@cloudflare/playwright` 1.4.0 serve t3's calls? (+ M2, M6) | Yes for every call t3 makes. It is a port of Playwright **1.62.1**. The exception is download content: `saveAs` cannot copy the artifact off Browser Run's disk (cloudflare/playwright#93). | The Shadow replaces `saveAs` with a fetch from the page. Upload paths are read from the tab's Workspace. |
| 2. Do `ctx.exports` props survive in `outboundByHost`? (review M1) | **Yes.** Props held at 81 s, 207 s and 330 s, through the kept browser and through a fresh `connect` from a later invocation. | No O3. |
| 3. Does `localhost` reach a context route? (R1, + review M3) | **No.** `ERR_BLOCKED_BY_ADMINISTRATOR` comes before any route, and `t3-page.localhost` is blocked too. | L6: the Shadow translates `localhost` in `goto`. The HTML bridge rewrites t3's page origin. No O3. |
| 4. OS1 | Not needed (C2). | — |
| H1 | workerd's WebSocket has no `bufferedAmount`. | `writableLength` is 0, so the 8 MiB slow-viewer guard is lost (R7). |
| M6 | 9.54 → 12.25 MiB raw, 2.64 → 3.35 MB gzip (the limit is 10 MB). Playwright is a lazy chunk, and the deploy passed the startup check. | — |

None of this changed the plan materially, so M1–M6 proceeded. The parent was messaged at M0.

## What was built

- **M1, HTML renders.** `BROWSER` is bound. `PreviewBrowser` is a Layer that answers a constant executable. Our process router bridges that executable's `--remote-debugging-pipe` to a shared, route-less Browser Run browser, which closes 60 s after its last render.
  - The bridge rewrites `http://t3-page.localhost` to `https://t3-page.t3flare.internal`, so renders are secure contexts.
  - It answers `Browser.close` itself, closing only that render's contexts.
  - So stock `headlessChrome.ts` runs unchanged, and Shadow 4 is `publicProxy.ts`, a no-op (review M3).
  - `html_*` is off the denylist. t3 tool results carry images to the Durable agent (R6).
- **M2, ports.** `apps/sandbox-image/src/ports.ts` scans `/proc` in the image's Node and JSON-encodes every field. It ships with the Worker's code, as the kill script does, so there is no image bump.
  - `WorkspaceDO.listeners` / `stopProcessGroup` / `probePort` never start the Container and are not use.
  - `preview/portDiscovery.ts` replaces `PortScanner.layer`. As stock, it lists only owned servers (C1): a terminal's (`term-<key>`, named by t3's own `registerTerminalProcesses`, which our terminal Layer now passes), a CLI process's (`proc-<uuid>`), or a Durable agent's (`T3CODE_THREAD_ID`, now set by the Session).
  - Every marker must belong to the scanned Workspace (review M7).
  - Stop uses stock's `stoppableProcessGroup`, with computerd as the server.
  - Configured URLs are taken only on loopback, as stock takes them, and are probed only on a running Container. Review M4's public-URL probe does not arise (rebutted).
- **M3, browser.**
  - Shadow `ServerBrowserContexts`: one Browser Run browser per Workspace, routed with `ctx.exports.ContainerPreviews({ props: { workspace } })` for the eight ports. Thread-less contexts use a route-less browser.
    - Profiles are `storageState` in their own table (8 MiB a profile, in rows under DO SQLite's 2 MB; L4), saved every 60 s and before close.
    - Session ids are recorded, closed at the next instance's boot and at idle reset (M5).
    - `disconnected` drops the tabs.
    - Download and upload are fixed as above. Patch 0005 passes the thread.
  - `ContainerPreviews` (Environment Worker) hands requests to `WorkspaceContainerPreviews` (agents Worker), which calls one Workspace DO method, `containerPreview`.
    - This is cloudpid's Container preview and socket script, ported with `/__t3flare/ws/`, a header check, 256-bit ids, an 8 MiB unread cap and `shim.js` (L8).
    - Requests are use, and carried sockets are a hold, both only within ADR-0021's 30 minutes from the Workspace's last input (M5).
  - The stream route is mounted.
    - Our `httpServer.ts` gives its upgrade a Node-socket shim, a Proxy of the web request with a `socket` (H1).
    - `serverBrowser` and `localServerStop` are advertised.
- **M4, agent tools.** The pin is gone. `preview_*` and `t3_preview_*` are off the denylist. `device_*` stays denied.
- **M5, MCP apps.** The CLI wrapper keeps `mcpApps`. The relay passes `_meta.ui` alone, `structuredContent`, and `resources/read` of a `ui://` URI one of the server's own offered tools declares, read as an App read (L10).
- **M6, records.**
  - ADR-0031.
  - Refinements to ADR-0001 (counts), 0010, 0021, 0022, 0023, 0024 and 0028.
  - `parity.md` Previews rows and G11.
  - Fragility U59–U63.
  - Glossary: **Preview browser**, **Container preview**.
  - Tickets SPI-1123, SPI-1124 and SPI-1125.

## Checks

Stage `previews` unless noted. PASS means the check's own criterion held.

| Check | Result | Evidence |
|---|---|---|
| M0 Playwright calls (Q1) | PASS except download content (worked around; see transfer) | `m0-spike.json` |
| M0 props across invocations (Q2, review M1) | PASS | `m0-spike.json` |
| M0 `localhost` / `t3-page.localhost` under Browser Run (Q3, M3) | Blocked: L6 translation and the bridge rewrite chosen | `m0-summary.json` |
| M1 stock `captureHtmlScreenshot` and `measureHtmlHeights` through the bridge | PASS (3.8 s; 1.7 s for three widths) | `m1-html-bridge.json` |
| M1 / L3 what a render's page reaches (loopback, `[::1]`, `0.0.0.0`, `127.1`, `*.localhost`, 10.0.0.1, 169.254.169.254, `metadata.google.internal`, `*.t3flare.internal`) | PASS: Browser Run's proxy answers 403 or the name does not resolve; no Container reached; the https page is a secure context | `m1-html-bridge.json` |
| M1 Pi Durable `html_preview` seen as an image (R6), `html_render` published | PASS | `agent.json` |
| M1 / L1 hostile published page, framed as the web client frames it, with a valid t3 session in the browser: cookie, localStorage, `parent.document`, credentialed `/api/auth/session`, harness panel POST, top navigation | PASS: every one throws or fails; messages come from origin `null` | `html-hostile.json` |
| L2 CSP `sandbox` and `nosniff` on the asset, inline and as a download | PASS | `asset-headers.json` (`agent.json`'s download line failed on a wrong criterion, fixed and re-run here) |
| M1 a CDN script loads | PASS (jsdelivr 200 from the render's page) | `m1-html-bridge.json` |
| M1 Codex publishing; a Workspace-path image; a theme switch | NOT RUN (SPI-1124; image and theme follow stock code) | — |
| M2 a terminal's Vite is listed as the terminal's; 8080 never listed | PASS | `browser.json` |
| M2 stop by pid; an unknown pid is `not-found` | PASS | `browser.json` |
| M2 / L9 an idle Container stops at 2 minutes with the port list polling | PASS (124 s) | `idle-stop.json` |
| M2 / M7 forged markers, hostile `comm`; configured URLs off loopback never probed (M4) | PASS (unit) | `test/previews.test.ts` |
| M2 agent-started servers listed as the agent's; `shared-group`; two Workspaces on 5173 | Unit only; NOT RUN on a stage (SPI-1125) | `test/previews.test.ts`, `apps/agents/test/portsScript.test.ts` |
| M3 open `localhost:5173` in the thread's browser; frames as JPEG over the stream route | PASS | `browser.json` |
| M3 no session gets 401; a read-only watcher's click is ignored and an operator's reaches the page | PASS (read-only by `interactive=false`, not by a read-only scope) | `browser.json` |
| M3 / C4 HMR applies without a reload | PASS (1.0–1.3 s) | `browser.json` |
| M3 hostile preview JS against t3: cookie, `/api/auth/session`, `/mcp`, `wss:/ws`, the panel POST; computerd through the route; a forged socket id; a send without the header | PASS | `browser.json` |
| M3 route reach: the t3 host's `/__t3flare/ws/*` is the asset fallback, never a Container | PASS | `route-reach.json` |
| M3 / M2 download offered to the viewer and served; upload through the file chooser | PASS | `transfer.json` |
| M3 / L4 a cookie survives the profile context's close; `clearProfile` removes it | PASS | `profile.json` |
| M3 / M5 an open page holds the Container while someone works, lets go at the cap, then answers 503 without a start | PASS (cap 3 min on the stage; stopped at 286 s) | `hold.json` |
| M5 a new instance closes the sessions the last one left | PASS | `boot-close.json` |
| M5 a hidden panel left open 30 minutes | PASS as a measurement: the session was up at 10 minutes and gone by 15 | `hidden-panel.json` |
| M5 an unwatched tab ends at keep-alive | **FAIL**: it lives while a client keeps the Environment awake (SPI-1123) | `keepalive.json` |
| M3 popup as its own tab | Spike only (the `popup` event works) | `m0-spike.json` |
| M4 Pi Durable: `preview_open` `{kind:"port"}`, snapshot, act, evaluate over its own server | PASS | `agent.json` |
| M4 hostile: `preview_evaluate` against t3's API | PASS (TypeError) | `agent.json` |
| M4 Codex; setting off hides `preview_*` | NOT RUN (SPI-1124; the second is t3's own scope check) | — |
| M5 relay `_meta.ui`, `structuredContent`, `resources/read` refusals | PASS (unit) | `test/mcpHost.test.ts`, `test/mcpRelay.test.ts` |
| M5 Codex App end to end, its hostile list | NOT RUN (SPI-1124) | — |
| L5 no `recording`, no Live View, no URL in logs | PASS (unit on acquire options; log lines carry ports and error names only) | `test/previews.test.ts` |
| `pnpm run check` | PASS (32/32 tasks; environment 414 tests, agents 430 passed and 14 skipped) | local |

## Code review (two axes, since `main` at 4561bb6)

No sub-agents were available, so the two axes were reviewed one after the other, against the same diff and kept apart.

### Standards

Sources: `AGENTS.md`; ADR-0001 (Layer, then Shadow, then Patch); ADR-0030 (relock, lint scripts with `OXLINT_TSGOLINT_PATH`); `docs/agents/*`; the smell baseline.

- **ADR-0001: followed.** Each Shadow exports what stock exports, which `test/previews.test.ts` checks. The Patch is one line. Everything else is a Layer or our own code.
- **ADR-0030: followed.** The lock changed only through `scripts/relock.ts`; after the rebase, its only change is `@cloudflare/playwright` and `playwright-core`. No new lint script was added.
- **Possible Duplicated Code (judgement).** `chromeIdentity` and `presentAsChrome` are copied from stock into the Shadow. The Shadow rule requires it, and U59 watches it. The stage parts' Vite setup was duplicated three times; it was extracted into `viteAppCommand` and `viteStartCommand`.
- **Prototype patching (judgement).** The Shadow wraps `goto` per page, and `setFiles` / `setInputFiles` on the fork's prototypes. It reaches into the fork's classes, and a fork release could move them. U59 names it as silent.
- **Large stage-only module (judgement).** `src/preview/spike.ts` (about 560 lines) ships in the Worker as a lazy chunk, answered only with `T3FLARE_FAULTS=1`, as `host/processCheck.ts` and `acpCheck.ts` are.
- **Review M7 asked to schema-decode each scan line (judgement).** The scan is one JSON object, made by `JSON.stringify` in the image; `serversOf` checks each field's type and range rather than an Effect Schema.
- Fixed during review:
  - a duplicated `history` op;
  - `String(state)` where the state could be an object (lint);
  - the upload patch reading the Workspace from the first instance's map (now module state).

### Spec

Against the plan as overridden by the review changelog.

- **Missing or partial:**
  - Codex's lines in M1, M4 and M5 (SPI-1124);
  - two Workspaces on one port (SPI-1125);
  - a Workspace-path image, the theme switch and the mobile layout;
  - agent-started servers listed as the agent's, on a stage;
  - the `shared-group` answer on a stage;
  - a read-only *scope* session (the check used `interactive=false`);
  - a popup on a stage.
- **Wrong against the plan's expectation:** keep-alive does not end an unwatched tab (M5's exit line). The Shadow's 60 s profile save is CDP traffic (SPI-1123).
- **Departures, each recorded:**
  - no `headlessChrome.ts` Shadow (the bridge, review M3);
  - no image bump (the scan ships with the Worker, as `kill.ts` does);
  - no Worker probe of public configured URLs (stock never probes them; M4's half rebutted);
  - `localServerStop` advertised (stock's stop, now implemented);
  - sessions closed at idle reset (M5);
  - one stage, `previews`, instead of `prev0`–`prev5` (C3);
  - HMR measured in M3, not M0 (C4).
- **Scope creep:** none beyond the stage harness parts (`transfer`, `tabtrace`), which are checks.

## Rebuttals and corrections, in short

- **Review M4, half rebutted.** Stock drops every non-loopback configured URL (`parseConfiguredUrl` → `isLoopbackHost`), so nothing public is probed. The loopback half is done: probed on a running Container only, and never counted as use.
- **Review L4's "8 MB a row".** DO SQLite holds at most 2 MB a row, so a profile is 512 Ki-character rows under an 8 MiB cap.
- **Plan §2.1** said an unattributed listener would be listed. Stock lists only owned ones (C1).
- **The plan's image bump** is not needed (the scan ships with the Worker's code).

## Not done here

- Rows marked NOT RUN above; their tickets are SPI-1124 and SPI-1125.
- The cost decision (SPI-1123).
- Merging to `main` (the owner merges).
