// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// SPI-1086's stage evidence: seeds a little harness state on a throwaway stage and screenshots the panel through Access
// with agent-browser, at desktop and phone widths, in light and dark. Run through the stage's `run`, which sets the
// stage's service token and admin token (never printed):
//
//   node scripts/stage.ts run panel panel seed              # MCP servers (one failing), a class override, an extension change
//   node scripts/stage.ts run panel panel shoot <label>     # docs/steps/panel/<label>-<desktop|phone>-<light|dark>.png
//   node scripts/stage.ts run panel panel states            # docs/steps/panel/states-<state>-…png (tests, a refusal, the form)
//
// Screenshots are resized to at most 1400 px wide (sips).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HARNESS = process.env.T3FLARE_HARNESS_URL ?? "";
const OUT = path.resolve(import.meta.dirname, "../../../docs/steps/panel");
const headers = {
  "cf-access-client-id": process.env.T3FLARE_ACCESS_CLIENT_ID ?? "",
  "cf-access-client-secret": process.env.T3FLARE_ACCESS_CLIENT_SECRET ?? "",
  authorization: `Bearer ${process.env.T3FLARE_ADMIN_TOKEN ?? ""}`,
};

const api = async (method: string, pathname: string, body?: unknown) => {
  const response = await fetch(new URL(pathname, HARNESS), {
    method,
    redirect: "manual",
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  console.log(`${method} ${pathname} -> ${response.status} ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  return { status: response.status, text };
};

const FIXTURE_URL = `https://t3flare-mcpfixture-panel.ian-g-pascoe.workers.dev`;

const seed = async () => {
  // The stage's fixture MCP Worker (scripts/tools/fixtureMcp.ts), signed in with a header: a server that lists tools.
  await api("POST", "/_t3flare/harness/api/mcp/servers", { server: "fixture", url: `${FIXTURE_URL}/mcp`, auth: { kind: "header", header: "Authorization" }, value: `Bearer ${process.env.T3FLARE_FIXTURE_BEARER ?? ""}` });
  await api("POST", "/_t3flare/harness/api/mcp/test", { server: "fixture" });
  // A direct server on a host that does not resolve: its test fails, so the page shows a server with an error.
  await api("POST", "/_t3flare/harness/api/mcp/servers", { server: "docs", url: "https://mcp.docs-fixture.invalid/mcp", auth: { kind: "header", header: "Authorization" }, value: "panel-fixture-not-a-real-token" });
  // An OAuth server never signed in.
  await api("POST", "/_t3flare/harness/api/mcp/servers", { server: "linear", url: "https://mcp.linear.app/mcp", auth: { kind: "oauth" } });
  await api("POST", "/_t3flare/harness/api/mcp/test", { server: "commissary" });
  await api("POST", "/_t3flare/harness/api/mcp/test", { server: "docs" });
  await api("POST", "/_t3flare/harness/api/extensions", { extension: "codemode", settings: { inlineBudget: 3000 } });
  const servers = JSON.parse((await api("GET", "/_t3flare/harness/api/mcp")).text) as { servers: Array<{ name: string; tools: Array<{ upstream: string; class: string }> }> };
  const tool = servers.servers.find((server) => server.name === "fixture")?.tools[0];
  if (tool !== undefined) await api("POST", "/_t3flare/harness/api/mcp", { op: "class", server: "fixture", tool: tool.upstream, class: tool.class === "read" ? "write" : "read" });
};

const browser = (...args: Array<string>) => {
  const result = spawnSync("agent-browser", ["--session", "panel", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`agent-browser ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  return result.stdout;
};

const shoot = (label: string) => {
  fs.mkdirSync(OUT, { recursive: true });
  const url = new URL("/_t3flare/harness", HARNESS).toString();
  for (const scheme of ["light", "dark"]) {
    for (const [name, width, height, scale] of [["desktop", 1280, 860, 1], ["phone", 390, 844, 2]] as const) {
      browser("--headers", JSON.stringify(headers), "--color-scheme", scheme, "open", url);
      browser("set", "viewport", String(width), String(height), String(scale));
      browser("set", "media", scheme);
      browser("open", url);
      browser("wait", "--load", "networkidle");
      const file = path.join(OUT, `${label}-${name}-${scheme}.png`);
      browser("screenshot", "--full", file);
      const widthOf = () => Number(/pixelWidth: (\d+)/.exec(spawnSync("sips", ["-g", "pixelWidth", file], { encoding: "utf8" }).stdout)?.[1]);
      if (widthOf() > 1400) spawnSync("sips", ["--resampleWidth", "1400", file], { stdio: "ignore" });
      if (widthOf() > 1400) throw new Error(`${file} is wider than 1400 px`);
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
      browser("close");
    }
  }
};

const pause = (ms: number) => spawnSync("sleep", [String(ms / 1000)]);

/**
 * The states the page reaches by acting: a test running (its button held busy for the shot), test results (one listed,
 * one failed), a refused add (the notice), and the add form with the header sign-in chosen.
 */
const states = () => {
  fs.mkdirSync(OUT, { recursive: true });
  const url = new URL("/_t3flare/harness", HARNESS).toString();
  for (const [scheme, name, width, height, scale] of [["dark", "desktop", 1280, 860, 1], ["light", "phone", 390, 844, 2]] as const) {
    const save = (shot: string) => {
      const file = path.join(OUT, `states-${shot}-${name}-${scheme}.png`);
      browser("screenshot", file);
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    };
    browser("--headers", JSON.stringify(headers), "--color-scheme", scheme, "open", url);
    browser("set", "viewport", String(width), String(height), String(scale));
    browser("set", "media", scheme);
    browser("open", url);
    browser("wait", "--load", "networkidle");
    // Tests: the docs server fails, the fixture lists its tools; then the commissary test is caught mid-flight.
    browser("eval", `document.querySelector('[data-mcp-test="docs"]').click(); document.querySelector('[data-mcp-test="fixture"]').click();`);
    pause(3000);
    browser("eval", `(() => { const b = document.querySelector('[data-mcp-test="commissary"]'); b.setAttribute('aria-busy', 'true'); b.disabled = true; document.querySelector('[data-test-result="commissary"]').textContent = 'Testing…'; document.getElementById('mcp').scrollIntoView(); })()`);
    pause(500);
    save("tests");
    browser("eval", `document.querySelector('[data-test-result="docs"]').closest('article').scrollIntoView()`);
    pause(300);
    save("tests-failed");
    browser("eval", `document.querySelector('[data-test-result="fixture"]').closest('article').scrollIntoView()`);
    pause(300);
    save("tests-ok");
    // A refused add (a reserved name), shown in the page's notice; then the header sign-in's fields.
    browser("eval", `(() => { const f = document.querySelector('form[data-mcp-add]'); f.querySelector('[name=server]').value = 't3'; f.querySelector('[name=url]').value = 'https://mcp.example.com/mcp'; f.querySelector('[name=auth][value=none]').checked = true; f.requestSubmit(); })()`);
    pause(2000);
    browser("eval", `window.scrollTo(0, 0)`);
    pause(300);
    save("refused");
    browser("eval", `(() => { const f = document.querySelector('form[data-mcp-add]'); f.querySelector('[name=server]').value = 'executor'; const r = f.querySelector('[name=auth][value=header]'); r.checked = true; r.dispatchEvent(new Event('change')); f.scrollIntoView(); })()`);
    pause(300);
    save("add-header");
    browser("close");
  }
};

const [command, label] = process.argv.slice(2);
if (command === "seed") await seed();
else if (command === "shoot" && label !== undefined) shoot(label);
else if (command === "states") states();
else {
  console.error("usage: panel.ts seed | shoot <label> | states");
  process.exit(2);
}
