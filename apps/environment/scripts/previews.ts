// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off globalTimers:off anyUnknownInErrorContext:off
// G11's stage harness (docs/steps/previews.md): Browser Run, the Container previews and the hostile cases, on the
// throwaway stage `previews`. Evidence goes to docs/steps/previews/<name>.json; no token, cookie or page URL beyond the
// harness's own is written.
//
//   node scripts/stage.ts run previews previews <part>
//   parts: spike | routes | op <spike op> [match] | browser | agent | publish | l2 <attachment> | keepalive | hidden [minutes]
//          | idle | hold (stage deployed with T3FLARE_TERMINAL_IDLE_MS=180000) | profile | bootclose | tabtrace [minutes] | close
import * as fs from "node:fs";
import * as path from "node:path";

import { admin, base, pair, sleep, updateSettings, wsCall } from "./lib/client.ts";
import { createThread, replyOf, say, settled, t3Calls, until } from "./lib/cloudThread.ts";
import { ensureCloudFixtureProject } from "./lib/fixtureProject.ts";
import { type Line as StageLine, openTab, step, streamStatus, tabEval, VITE_APP, waitFor, watchStream, wsFind } from "./lib/previewStage.ts";
// A run's whole budget: a hung step fails the run rather than holding the stage.
setTimeout(() => {
  console.error("previews: the run took longer than 20 minutes");
  process.exit(1);
}, Number(process.env.PREVIEWS_GUARD_MS ?? 20 * 60_000)).unref();
import { attachTerminal } from "./lib/terminal.ts";

const EVIDENCE = path.resolve(import.meta.dirname, "../../../docs/steps/previews");

const writeEvidence = (name: string, value: Record<string, unknown>) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${name}.json`), `${JSON.stringify({ at: new Date().toISOString(), host: base.host, ...value }, null, 1)}\n`);
  console.log(`${name}: ${value.ok === true ? "PASS" : "FAIL"} -> docs/steps/previews/${name}.json`);
  if (value.ok !== true) process.exitCode = 1;
};

interface Line {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: unknown;
}

const spike = async (op: string, body?: { readonly match?: string; readonly expression?: string }): Promise<ReadonlyArray<Line>> => {
  const { status, json } = await admin("POST", `/_t3flare/previews/spike?op=${op}`, body ?? {});
  if (status !== 200) throw new Error(`spike ${op}: HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
  return (json as { lines: ReadonlyArray<Line> }).lines;
};

const print = (lines: ReadonlyArray<Line>) => {
  for (const line of lines) console.log(`${line.ok ? "ok  " : "FAIL"} ${String(line.ms).padStart(6)} ms  ${line.name}  ${line.detail === undefined ? "" : JSON.stringify(line.detail).slice(0, process.env.FULL === "1" ? 20_000 : 400)}`);
};


/**
 * The published page's own probe (M1 hostile, L1): what an agent's HTML can reach from t3's asset route, reported to its
 * parent (t3's web client frames it), and only then a top navigation, which the sandbox must refuse.
 */
const probePage = (origin: string) => `<!doctype html><html><head><title>Probe</title></head><body style="margin:0;background:#cc0000;color:#fff"><div style="height:160px"></div><pre id="out">pending</pre><script>
(async () => {
  const t = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
  const out = { origin: String(location.origin) };
  try { out.cookie = document.cookie; } catch (e) { out.cookie = "throws " + e.name; }
  try { localStorage.setItem("x", "1"); out.localStorage = "works"; } catch (e) { out.localStorage = "throws " + e.name; }
  try { out.parentDocument = typeof parent.document; } catch (e) { out.parentDocument = "throws " + e.name; }
  out.session = await t(fetch("${origin}/api/auth/session", { credentials: "include" }).then((r) => "status " + r.status, (e) => "error " + e.name));
  out.panel = await t(fetch("${origin}/_t3flare/harness/api/mcp/servers", { method: "POST", credentials: "include", body: "{}" }).then((r) => "status " + r.status, (e) => "error " + e.name));
  document.getElementById("out").textContent = JSON.stringify(out);
  parent.postMessage({ probe: out }, "*");
  try { window.top.location.href = "https://example.com/"; } catch (e) { parent.postMessage({ topNavigation: "throws " + e.name }, "*"); }
})();
</script></body></html>`;

/** Review L2: the published page's asset, fetched directly, is served as an opaque-origin document (inline) or a download. */
const assetChecks = async (cookie: string, attachmentId: string): Promise<Array<StageLine>> => {
  const lines: Array<StageLine> = [];
  for (const disposition of ["inline", "attachment"] as const) {
    await step(lines, `the published page's asset is served sandboxed, ${disposition} (L2)`, async () => {
      const created = (await wsCall(cookie, "assets.createUrl", { resource: { _tag: "attachment", attachmentId, fileName: "probe.html", mimeType: "text/html", disposition } })) as { relativeUrl: string };
      const url = new URL(created.relativeUrl, base);
      const response = await fetch(url);
      await response.body?.cancel();
      const csp = response.headers.get("content-security-policy") ?? "";
      const headers = { status: response.status, csp, nosniff: response.headers.get("x-content-type-options"), type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition") };
      // The capability URL goes to a 0600 file for the browser check, never into the evidence.
      if (disposition === "inline") fs.writeFileSync("/tmp/previews-asset-url", url.toString(), { mode: 0o600 });
      const sandboxed = /(^|;\s*)sandbox\b/.test(csp) && !/allow-same-origin/.test(csp) && headers.nosniff === "nosniff";
      const asDocument = disposition === "inline" ? headers.type?.startsWith("text/html") === true : headers.disposition?.startsWith("attachment") === true && headers.type === "application/octet-stream";
      return { ok: response.status === 200 && sandboxed && asDocument, detail: headers };
    });
  }
  return lines;
};

const [part] = process.argv.slice(2);

switch (part) {
  case "spike": {
    // M0 questions 1, 3 (and review M2, M3, M6, H1): one browser, every call t3 makes, then the HTML page sequence.
    const calls = await spike("playwright");
    print(calls);
    const htmlPage = await spike("html-page");
    print(htmlPage);
    // Question 2: the same browser's routes from three later invocations over five minutes, each also through a fresh
    // `connect` to the stored session.
    const later: Array<{ readonly at: string; readonly lines: ReadonlyArray<Line> }> = [];
    for (const wait of [60_000, 120_000, 120_000]) {
      await sleep(wait);
      const lines = await spike("routes");
      print(lines);
      later.push({ at: new Date().toISOString(), lines });
    }
    const closed = await spike("close");
    print(closed);
    // The answer to question 2: every later invocation reached spike-a's routes through a fresh `connect`.
    const routesHeld = later.every(({ lines }) => lines.some((line) => line.ok && line.name.startsWith("connectSession") && JSON.stringify(line.detail).includes("spike-a")));
    writeEvidence("m0-spike", { ok: routesHeld, playwright: calls, htmlPage, routes: later, closed });
    break;
  }
  case "routes":
    print(await spike("routes"));
    break;
  case "op":
    // Any spike op, printed: `op html-capture`, `op html-page`.
    print(await spike(process.argv[3] ?? "", process.argv[4] === undefined ? undefined : { match: process.argv[4] }));
    break;
  case "close":
    print(await spike("close"));
    break;
  case "browser": {
    // M2 + M3 (+ review M7, L9, H1): a Vite dev server in a thread's terminal, listed, opened, watched, edited, attacked.
    const lines: Array<StageLine> = [];
    const cookie = await pair();
    const { projectId, workspaceRoot } = await ensureCloudFixtureProject(cookie);
    const threadId = await createThread(cookie, projectId, { title: "previews: browser" });
    const term = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: workspaceRoot });
    // The Container starts for the shell (a terminal's open is use, ADR-0021).
    await term.until(/[$#] $/, 180_000);
    const files = VITE_APP(base.origin);
    const write = Object.entries(files)
      .map(([name, text]) => `echo ${Buffer.from(text).toString("base64")} | base64 -d > ${name}`)
      .join(" && ");
    await step(lines, "a Vite app in the Container (/tmp/vapp)", async () => {
      const out = await term.run(`mkdir -p /tmp/vapp && cd /tmp/vapp && ${write} && (test -d node_modules/vite || (npm init -y >/dev/null && npm i --silent vite@6 >/dev/null 2>&1)) && echo vite-ready`, 240_000);
      return { ok: out.text.includes("vite-ready"), detail: { ms: out.ms } };
    });
    await term.write("npx vite --host 0.0.0.0 --port 5173 --strictPort\n");
    await step(lines, "vite listens on 0.0.0.0:5173", async () => ({ ok: true, detail: { ms: (await term.until(/Network:|ready in/i, 90_000)).ms } }));
    const listed = await wsFind(cookie, "subscribeDiscoveredLocalServers", {}, (list: any) => list.servers.some((server: any) => server.port === 5173), 45_000).then((list: any) => list?.servers as Array<any> | undefined);
    const vite = listed?.find((server) => server.port === 5173);
    await step(lines, "port discovery lists 5173 as the terminal's (M2)", async () => ({
      ok: vite?.terminal?.threadId === threadId && vite?.terminal?.terminalId === "default" && vite?.url === "http://localhost:5173",
      detail: listed,
    }));
    await step(lines, "computerd's 8080 is never listed (M2)", async () => ({ ok: !listed?.some((server) => server.port === 8080), detail: listed?.map((server) => server.port) }));
    const tab = await openTab(cookie, threadId, "http://localhost:5173/");
    await step(lines, "preview.open http://localhost:5173/ in the thread's browser (M3)", async () => ({ ok: typeof tab.tabId === "string", detail: { tabId: tab.tabId } }));
    const loaded = await step(lines, "the page loaded through the Container preview, its module ran", async () => {
      const text = await waitFor("the app's text", async () => {
        const value = await tabEval("5173.t3flare.internal", "document.getElementById('app')?.textContent");
        return value === "version-1" ? value : undefined;
      }, 60_000);
      return { ok: text === "version-1", detail: text };
    });
    const query = { threadId, tabId: tab.tabId };
    await step(lines, "frames arrive over /api/preview-stream/ws, as JPEG, acked one at a time (M3, H1)", async () => {
      const watched = await watchStream(cookie, { ...query, maxWidth: "640", maxHeight: "400" }, 6_000);
      return { ok: watched.frames > 0 && watched.jpeg, detail: watched };
    });
    await step(lines, "a stream request without a session is refused (M3)", async () => {
      const status = await streamStatus(null, query);
      return { ok: status === 401 || status === 403, detail: { status } };
    });
    await step(lines, "a read-only watcher's input is ignored, an operator's click reaches the page", async () => {
      await tabEval("5173.t3flare.internal", "(window.__clicks = 0, document.addEventListener('mousedown', () => window.__clicks++), 0)");
      const click = (send: (message: unknown) => void) => {
        for (const action of ["down", "up"]) send({ type: "mouse", action, x: 50, y: 50, button: "left", buttons: action === "down" ? 1 : 0, clickCount: 1 });
      };
      await watchStream(cookie, { ...query, interactive: "false" }, 2_500, click);
      const afterReadOnly = await tabEval("5173.t3flare.internal", "window.__clicks");
      const operated = await watchStream(cookie, query, 3_000, (send) => {
        send({ type: "takeControl" });
        setTimeout(() => click(send), 500);
      });
      const afterOperate = await tabEval("5173.t3flare.internal", "window.__clicks");
      return { ok: afterReadOnly === 0 && Number(afterOperate) > 0, detail: { afterReadOnly, afterOperate, operatorMessages: operated.messages.slice(0, 6) } };
    });
    if (loaded) {
      await step(lines, "an edit applies by HMR, without a reload (C4, M3)", async () => {
        await tabEval("5173.t3flare.internal", "(window.__marker = 'kept', 1)");
        const edit = await attachTerminal(cookie, { threadId, terminalId: "edit", cwd: workspaceRoot });
        await edit.until(/[$#] $/, 60_000);
        const started = Date.now();
        await edit.run(`cd /tmp/vapp && echo ${Buffer.from(files["main.js"].replace("version-1", "version-2")).toString("base64")} | base64 -d > main.js && echo edited`, 30_000);
        const text = await waitFor("the HMR update", async () => {
          const value = await tabEval("5173.t3flare.internal", "document.getElementById('app')?.textContent");
          return value === "version-2" ? value : undefined;
        }, 30_000);
        const marker = await tabEval("5173.t3flare.internal", "window.__marker");
        await edit.close(true).catch(() => undefined);
        return { ok: text === "version-2" && marker === "kept", detail: { text, marker, ms: Date.now() - started } };
      });
    }
    const hostile = await openTab(cookie, threadId, "http://localhost:5173/hostile.html");
    await step(lines, "hostile preview JS gets nothing of t3's, and cannot reach computerd or forge a socket (M3 hostile, L1)", async () => {
      const out = await waitFor("the hostile page's report", async () => {
        const value = await tabEval("hostile.html", "document.getElementById('out')?.textContent");
        return typeof value === "string" && value !== "pending" ? (JSON.parse(value) as Record<string, string>) : undefined;
      }, 60_000);
      const refused = (value: string | undefined) => value === undefined || !/status 2\d\d/.test(value) || value === "status 204";
      const ok =
        out.cookie === "" &&
        refused(out.session) &&
        out.ws !== "open" &&
        refused(out.mcp) &&
        refused(out.panel) &&
        /status 404|error/.test(out.computerd ?? "") &&
        /status 404/.test(out.sendForged ?? "") &&
        /status 403/.test(out.sendNoHeader ?? "");
      return { ok, detail: out };
    });
    await wsCall(cookie, "preview.close", { threadId, tabId: hostile.tabId }).catch(() => undefined);
    // Stop the listed server by its pid (stock's stop), then the list no longer has it.
    await step(lines, "preview.stopLocalServer stops vite's group (M2)", async () => {
      if (vite === undefined) return { ok: false, detail: "not listed" };
      await wsCall(cookie, "preview.stopLocalServer", { pid: vite.pid, port: 5173 });
      const gone = await wsFind(cookie, "subscribeDiscoveredLocalServers", {}, (list: any) => !list.servers.some((server: any) => server.port === 5173), 30_000);
      return { ok: gone !== undefined, detail: { stopped: vite.pid } };
    });
    await step(lines, "a pid nobody lists is not-found (M2)", async () => {
      const answer = await wsCall(cookie, "preview.stopLocalServer", { pid: 999_999, port: 5173 }).then(
        () => "stopped",
        (error: unknown) => JSON.stringify(error).slice(0, 300),
      );
      return { ok: answer.includes("not-found"), detail: answer };
    });
    await term.close(true).catch(() => undefined);
    await wsCall(cookie, "preview.close", { threadId, tabId: tab.tabId }).catch(() => undefined);
    writeEvidence("browser", { ok: lines.every((line) => line.ok), threadId, lines });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "agent": {
    // M1 + M4 (R6): a Pi Durable agent checks and publishes HTML, then drives t3's browser over a server it starts.
    const lines: Array<StageLine> = [];
    const cookie = await pair();
    const { projectId } = await ensureCloudFixtureProject(cookie);
    await updateSettings(cookie, { enableAgentBrowserAccess: true, providerInstances: { piDurable: { driver: "piDurable", enabled: true } } });
    const threadId = await createThread(cookie, projectId, { title: "previews: agent", runtimeMode: "full-access" });
    const origin = base.origin;
    const probe = probePage(origin);
    const prompt = [
      "Do these steps in order with T3's tools, then reply with a short report.",
      `1. Call html_preview with this exact html and tell me the dominant background colour you see in the screenshot:\n${probe}`,
      "2. Call html_render with the same html and the title Probe.",
      "3. In bash run: mkdir -p /tmp/agentapp && cd /tmp/agentapp && printf '<h1>Agent Heading</h1><button id=go onclick=\"document.body.dataset.clicked=1\">Go</button>' > index.html && (nohup python3 -m http.server 3000 --bind 0.0.0.0 >/dev/null 2>&1 &) && sleep 1",
      '4. Call preview_open with target {"kind":"port","port":3000}, then preview_snapshot, then preview_act to click the Go button, then preview_evaluate with expression: document.body.dataset.clicked + "|" + document.querySelector("h1").textContent',
      `5. Call preview_evaluate with expression: fetch("${origin}/api/auth/session", { credentials: "include" }).then((r) => "status " + r.status, (e) => "error " + e.name)`,
      "Report each tool result verbatim on its own line, and the colour.",
    ].join("\n");
    await say(cookie, threadId, prompt);
    const p = await until(cookie, threadId, settled, 900_000);
    const calls = t3Calls(p);
    const reply = replyOf(p);
    const items = (p?.turnItems ?? []) as Array<any>;
    const tool = (name: string) => calls.filter((call: any) => call.tool === name);
    await step(lines, "the turn settled", async () => ({ ok: settled(p), detail: { calls: calls.map((call: any) => `${call.tool}:${call.status}`) } }));
    await step(lines, "html_preview ran and the agent saw its screenshot (R6)", async () => ({
      ok: tool("html_preview").some((call: any) => call.status === "completed") && /red/i.test(reply),
      detail: { reply: reply.slice(0, 600) },
    }));
    const rendered = items.find((item) => item.type === "dynamic_tool" && String(item.toolName).endsWith("html_render"));
    const attachmentId = /"attachmentId"\s*:\s*"([^"]+)"/.exec(JSON.stringify(rendered?.output ?? null))?.[1];
    await step(lines, "html_render published the page (M1)", async () => ({ ok: attachmentId !== undefined, detail: { attachmentId: attachmentId ?? null, output: JSON.stringify(rendered?.output ?? null).slice(0, 300) } }));
    await step(lines, "preview_open/snapshot/act/evaluate drove the agent's tab over its server (M4)", async () => ({
      ok: ["preview_open", "preview_snapshot", "preview_act", "preview_evaluate"].every((name) => tool(name).some((call: any) => call.status === "completed")) && reply.includes("1|Agent Heading"),
      detail: { calls: calls.filter((call: any) => call.tool.startsWith("preview_")) },
    }));
    await step(lines, "preview_evaluate against t3's API gets nothing (M4 hostile)", async () => ({ ok: !/status 200/.test(reply), detail: reply.split("\n").filter((line) => /status|error/.test(line)).slice(0, 4) }));
    if (attachmentId !== undefined) lines.push(...(await assetChecks(cookie, attachmentId)));
    writeEvidence("agent", { ok: lines.every((line) => line.ok), threadId, lines });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "publish": {
    // M1: the Durable agent publishes the probe page alone; its capability URL goes to a 0600 file (`assetChecks`).
    const cookie = await pair();
    const { projectId } = await ensureCloudFixtureProject(cookie);
    const threadId = await createThread(cookie, projectId, { title: "previews: publish", runtimeMode: "full-access" });
    await say(cookie, threadId, `Call html_render with the title Probe and this exact html, then stop:\n${probePage(base.origin)}`);
    const p = await until(cookie, threadId, settled, 600_000);
    const rendered = ((p?.turnItems ?? []) as Array<any>).find((item) => item.type === "dynamic_tool" && String(item.toolName).endsWith("html_render"));
    const attachmentId = /"attachmentId"\s*:\s*"([^"]+)"/.exec(JSON.stringify(rendered?.output ?? null))?.[1];
    const lines = attachmentId === undefined ? [] : await assetChecks(cookie, attachmentId);
    writeEvidence("asset-headers", { ok: attachmentId !== undefined && lines.every((line) => line.ok), threadId, lines });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "keepalive": {
    // Review M5: a tab nobody watches gets no CDP traffic. A client stays connected (a port-list subscription, which
    // touches no browser), so the Environment does not reset; Browser Run then closes the session at its 10-minute
    // keep-alive, and t3 drops the tab (`disconnected` → `onContextClose`). Sampled every minute for 14, with Browser
    // Run's own close reason read at the end.
    const cookie = await pair();
    const { projectId } = await ensureCloudFixtureProject(cookie);
    const threadId = await createThread(cookie, projectId, { title: "previews: keep-alive" });
    const awake = wsFind(cookie, "subscribeDiscoveredLocalServers", {}, () => false, 16 * 60_000);
    const tab = await openTab(cookie, threadId, "https://example.com/");
    const samples: Array<{ readonly minute: number; readonly sessions: number; readonly tabs: number | null }> = [];
    const ids = new Set<string>();
    const started = Date.now();
    let closedAt: number | null = null;
    for (let minute = 0; minute <= 14; minute++) {
      if (minute > 0) await sleep(Math.max(0, started + minute * 60_000 - Date.now()));
      const sessions = await spike("sessions").catch(() => []);
      for (const line of sessions) ids.add((line.detail as { id: string }).id);
      const tabs = (await wsCall(cookie, "preview.list", { threadId }).catch(() => null)) as { sessions?: Array<unknown> } | null;
      samples.push({ minute, sessions: sessions.length, tabs: tabs?.sessions?.length ?? null });
      console.log(JSON.stringify(samples.at(-1)));
      if (closedAt === null && minute > 0 && sessions.length === 0 && (tabs?.sessions?.length ?? 0) === 0) closedAt = Date.now() - started;
    }
    const history = await spike("history", { match: [...ids].join(",") }).catch(() => []);
    void awake;
    writeEvidence("keepalive", { ok: closedAt !== null && closedAt >= 9 * 60_000, threadId, tabId: tab.tabId, closedAfterMs: closedAt, samples, browserRun: history.map((line) => line.detail) });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "hidden": {
    // Review M5: a panel left open and unlooked-at for 30 minutes: what it holds, and the browser time it costs.
    const minutes = Number(process.argv[3] ?? "30");
    const cookie = await pair();
    const { projectId } = await ensureCloudFixtureProject(cookie);
    const threadId = await createThread(cookie, projectId, { title: "previews: hidden panel" });
    const tab = await openTab(cookie, threadId, "https://example.com/");
    const started = Date.now();
    const watching = watchStream(cookie, { threadId, tabId: tab.tabId, maxWidth: "640", maxHeight: "400" }, minutes * 60_000);
    const samples: Array<unknown> = [];
    for (let minute = 0; minute <= minutes; minute += 5) {
      if (minute > 0) await sleep(Math.min(300_000, Math.max(0, started + minute * 60_000 - Date.now())));
      const sessions = await spike("sessions").catch((error: unknown) => [{ name: "error", ok: false, ms: 0, detail: String(error) }]);
      samples.push({ minute, sessions: sessions.map((line) => line.detail) });
      console.log(JSON.stringify(samples.at(-1)).slice(0, 300));
    }
    const watched = await watching;
    const alive = (samples.at(-1) as { sessions: Array<{ browserRun?: { closed: boolean } } | undefined> }).sessions.some((session) => session?.browserRun?.closed === false);
    await wsCall(cookie, "preview.close", { threadId, tabId: tab.tabId }).catch(() => undefined);
    writeEvidence("hidden-panel", {
      ok: true,
      minutes,
      browserSeconds: Math.round((Date.now() - started) / 1000),
      sessionStillUpAtEnd: alive,
      frames: watched.frames,
      closeCode: watched.closeCode,
      samples,
    });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "idle": {
    // Review L9: a running, idle Container still stops at its 2 minutes while a client keeps the port list polling.
    const cookie = await pair();
    const { projectId, workspaceRoot } = await ensureCloudFixtureProject(cookie);
    const workspace = workspaceRoot.slice(3);
    const threadId = await createThread(cookie, projectId, { title: "previews: idle" });
    const term = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: workspaceRoot });
    await term.until(/[$#] $/, 180_000);
    await term.close(true);
    const running = async () => {
      const { json } = await admin("GET", "/_t3flare/agents/workspaces");
      return (json as { workspaces: Array<any> }).workspaces.find((entry) => entry.id === workspace)?.container?.running as boolean | undefined;
    };
    const closedAt = Date.now();
    const samples: Array<unknown> = [];
    // Watching the list: t3 polls the port scan every 3 s while the subscription lives.
    const watching = wsFind(cookie, "subscribeDiscoveredLocalServers", {}, () => false, 300_000);
    let stoppedAfterMs: number | null = null;
    while (Date.now() - closedAt < 300_000) {
      const now = await running().catch(() => undefined);
      samples.push({ sinceCloseMs: Date.now() - closedAt, running: now });
      if (now === false) {
        stoppedAfterMs = Date.now() - closedAt;
        break;
      }
      await sleep(15_000);
    }
    void watching;
    writeEvidence("idle-stop", { ok: stoppedAfterMs !== null && stoppedAfterMs < 240_000, stoppedAfterMs, samples });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "hold": {
    // Review M5, ADR-0021's cap: an open page (its carried HMR socket) keeps a running Container while someone works, and
    // lets it go once the cap passes from the last input (run with T3FLARE_TERMINAL_IDLE_MS=180000 on the stage); the
    // stopped Container then answers the page 503 and is not started again.
    const cookie = await pair();
    const { projectId, workspaceRoot } = await ensureCloudFixtureProject(cookie);
    const workspace = workspaceRoot.slice(3);
    const threadId = await createThread(cookie, projectId, { title: "previews: hold" });
    const term = await attachTerminal(cookie, { threadId, terminalId: "default", cwd: workspaceRoot });
    await term.until(/[$#] $/, 180_000);
    const files = VITE_APP(base.origin);
    const write = Object.entries(files).map(([name, text]) => `echo ${Buffer.from(text).toString("base64")} | base64 -d > ${name}`).join(" && ");
    await term.run(`pkill -f 'vite --host' ; mkdir -p /tmp/vapp && cd /tmp/vapp && ${write} && (test -d node_modules/vite || (npm init -y >/dev/null && npm i --silent vite@6 >/dev/null 2>&1)) && (env -u T3FLARE_EXEC setsid nohup npx vite --host 0.0.0.0 --port 5173 --strictPort >/tmp/vite.log 2>&1 &) && sleep 4 && echo started`, 240_000);
    // Started outside the terminal's marker, so closing the terminal (which kills by it) leaves the dev server running.
    await term.close(true);
    const lastInput = Date.now();
    const tab = await openTab(cookie, threadId, "http://localhost:5173/");
    await waitFor("the page", async () => ((await tabEval("5173.t3flare.internal", "document.getElementById('app')?.textContent").catch(() => undefined)) === "version-1" ? true : undefined), 60_000);
    const running = async () => {
      const { json } = await admin("GET", "/_t3flare/agents/workspaces");
      return (json as { workspaces: Array<any> }).workspaces.find((entry) => entry.id === workspace)?.container?.running as boolean | undefined;
    };
    const samples: Array<{ readonly sinceInputMs: number; readonly running: boolean | undefined }> = [];
    let stoppedAt: number | null = null;
    while (Date.now() - lastInput < 9 * 60_000) {
      const now = await running().catch(() => undefined);
      samples.push({ sinceInputMs: Date.now() - lastInput, running: now });
      console.log(JSON.stringify(samples.at(-1)));
      if (now === false) {
        stoppedAt = Date.now() - lastInput;
        break;
      }
      await sleep(20_000);
    }
    const heldPastIdle = samples.some((sample) => sample.running === true && sample.sinceInputMs > 150_000);
    const afterStop = stoppedAt === null ? null : await tabEval("5173.t3flare.internal", "fetch('/').then((r) => r.status)").catch((error: unknown) => String(error));
    await sleep(20_000);
    const stillStopped = (await running().catch(() => undefined)) === false;
    await wsCall(cookie, "preview.close", { threadId, tabId: tab.tabId }).catch(() => undefined);
    writeEvidence("hold", {
      ok: heldPastIdle && stoppedAt !== null && stoppedAt >= 180_000 && afterStop === 503 && stillStopped,
      capMs: 180_000,
      heldPastIdle,
      stoppedAfterLastInputMs: stoppedAt,
      pageAfterStop: afterStop,
      stillStopped,
      samples,
    });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "profile": {
    // Review L4: a cookie survives the profile context's close (storageState in the Environment DO), and clearProfile ends it.
    const cookie = await pair();
    const { projectId } = await ensureCloudFixtureProject(cookie);
    const threadId = await createThread(cookie, projectId, { title: "previews: profile" });
    const lines: Array<StageLine> = [];
    const readCookie = async () => {
      const tab = await openTab(cookie, threadId, "https://example.com/");
      const value = await waitFor("the tab", async () => (await tabEval("example.com", "document.cookie").catch(() => undefined)) as string | undefined, 60_000);
      return { tab, value };
    };
    const first = await openTab(cookie, threadId, "https://example.com/");
    await waitFor("the tab", async () => tabEval("example.com", "(document.cookie = 't3flare=kept; max-age=3600; path=/', document.cookie)").catch(() => undefined), 60_000);
    await sleep(65_000);
    await wsCall(cookie, "preview.close", { threadId, tabId: first.tabId });
    // The profile context closes after 5 minutes without a page (saving first); its browser retires after.
    await sleep(6.5 * 60_000);
    const sessionsBetween = await spike("sessions");
    const second = await readCookie();
    await step(lines, "the cookie came back after the profile's context closed (storageState, L4)", async () => ({ ok: String(second.value).includes("t3flare=kept"), detail: { cookie: second.value, sessionsBetween: sessionsBetween.length } }));
    await wsCall(cookie, "preview.close", { threadId, tabId: second.tab.tabId });
    await wsCall(cookie, "preview.clearProfile", { profileId: "default" });
    const third = await readCookie();
    await step(lines, "clearProfile removes it", async () => ({ ok: !String(third.value).includes("t3flare=kept"), detail: { cookie: third.value } }));
    await wsCall(cookie, "preview.close", { threadId, tabId: third.tab.tabId }).catch(() => undefined);
    writeEvidence("profile", { ok: lines.every((line) => line.ok), lines });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "bootclose": {
    // Review M5: a new Environment instance closes the Browser Run sessions the last one left (its own record).
    const cookie = await pair();
    const { projectId } = await ensureCloudFixtureProject(cookie);
    const threadId = await createThread(cookie, projectId, { title: "previews: boot close" });
    await openTab(cookie, threadId, "https://example.com/");
    const before = await waitFor("a recorded session", async () => {
      const lines = await spike("sessions");
      return lines.length > 0 ? lines : undefined;
    }, 60_000);
    const ids = before.map((line) => (line.detail as { id: string }).id);
    // An idle reset: the next request constructs a new instance.
    const reset = await admin("POST", "/_t3flare/idle-check?force=1");
    await sleep(5_000);
    await spike("sessions");
    await sleep(5_000);
    const after = await spike("sessions");
    const states = [];
    for (const id of ids) {
      const { json } = await admin("POST", "/_t3flare/previews/spike?op=session-state", { match: id });
      states.push((json as { lines: Array<Line> }).lines[0]?.detail ?? null);
    }
    // Browser Run answers a closed session as closed, or no longer knows it (404).
    const ok = after.length === 0 && states.every((state) => (state as { closed?: boolean } | null)?.closed === true || /not found|404/i.test(String(state)));
    writeEvidence("boot-close", { ok, reset: reset.json, before: ids.length, after: after.length, browserRun: states });
    process.exit(process.exitCode ?? 0);
    break;
  }
  case "tabtrace": {
    // Diagnosis: one unwatched tab, its list entry and the Environment's sessions every 20 s for `minutes`.
    const cookie = await pair();
    const { projectId } = await ensureCloudFixtureProject(cookie);
    const threadId = await createThread(cookie, projectId, { title: "previews: tab trace" });
    const tab = await openTab(cookie, threadId, "https://example.com/");
    const started = Date.now();
    while (Date.now() - started < Number(process.argv[3] ?? "4") * 60_000) {
      const sessions = (await spike("sessions").catch(() => [])).map((line) => (line.detail as { id?: string; browserRun?: unknown } | undefined));
      const tabs = (await wsCall(cookie, "preview.list", { threadId }).catch((error: unknown) => String(error))) as any;
      console.log(JSON.stringify({ s: Math.round((Date.now() - started) / 1000), tab: tab.tabId.slice(-6), tabs: tabs?.sessions?.map((entry: any) => `${String(entry.tabId).slice(-6)}:${entry.navStatus?._tag}:${entry.serverControlled ?? ""}`) ?? tabs, sessions }).slice(0, 400));
      await sleep(20_000);
    }
    process.exit(0);
    break;
  }
  case "l2": {
    const cookie = await pair();
    const lines = await assetChecks(cookie, process.argv[3] ?? "");
    writeEvidence("asset-headers", { ok: lines.every((line) => line.ok), lines });
    process.exit(process.exitCode ?? 0);
    break;
  }
  default:
    console.error("usage: node scripts/stage.ts run previews previews spike|routes|op|browser|close");
    process.exit(2);
}
