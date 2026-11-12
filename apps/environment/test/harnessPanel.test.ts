// The harness panel's seam (ADR-0026, plan §6.4, review H4): `handleHarness` over a store, as the admin entrypoint calls
// it after Access. CSRF and Origin (missing, wrong origin, wrong token, the previous hour, a form-encoded body), the
// script path without CSRF, validation, the audit log, escaping of hostile strings, and the CSP.
import { describe, expect, it } from "vitest";

import { csrfToken } from "../src/harness/csrf.ts";
import { escapeHtml, renderPage } from "../src/harness/page.ts";
import { CSRF_HEADER, handleHarness, type HarnessCaller } from "../src/harness/panel.ts";
import { harnessSecrets } from "../src/harness/secrets.ts";
import { harnessStore } from "../src/harness/store.ts";
import { McpHost } from "../src/mcp/host.ts";
import { resolveHarness, EMPTY_HARNESS } from "@t3flare/harness-registry";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 12, 10, 30);
const owner: HarnessCaller = { kind: "owner", subject: "owner-sub" };

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  };
};

const setup = (caller: HarnessCaller = owner) => {
  const store = harnessStore(memory());
  return { store, deps: { caller, host: HOST, store, now: () => NOW } };
};

const change = async (deps: ReturnType<typeof setup>["deps"], body: unknown, headers: Record<string, string>) =>
  handleHarness(
    new Request(`https://${HOST}/_t3flare/harness/api/extensions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps,
  );

const ownerHeaders = async (store: ReturnType<typeof setup>["store"], at = NOW) => ({
  origin: `https://${HOST}`,
  "sec-fetch-site": "same-origin",
  [CSRF_HEADER]: await csrfToken(store.csrfKey(), "owner-sub", at),
});

describe("harness panel", () => {
  it("the owner's change with the page's token is stored, bumps the revision and is audited", async () => {
    const { store, deps } = setup();
    const response = await change(deps, { extension: "codemode", settings: { inlineBudget: 3000 } }, await ownerHeaders(store));
    expect(response.status).toBe(200);
    expect(store.load().revision).toBe(1);
    expect(resolveHarness(store.load()).codemode.inlineBudget).toBe(3000);
    expect(store.auditLog(5)).toMatchObject([{ caller: "owner:owner-sub", action: "extension.change", target: "codemode", after: { settings: { inlineBudget: 3000 } } }]);
  });

  it("accepts the previous hour's token, refuses an older one", async () => {
    const { store, deps } = setup();
    expect((await change(deps, { extension: "tool-search", enabled: false }, await ownerHeaders(store, NOW - 60 * 60 * 1000))).status).toBe(200);
    expect((await change(deps, { extension: "tool-search", enabled: true }, await ownerHeaders(store, NOW - 2 * 60 * 60 * 1000))).status).toBe(403);
  });

  it("refuses the owner's change without a token, with another subject's token, without Origin, or from another origin", async () => {
    const { store, deps } = setup();
    const good = await ownerHeaders(store);
    const body = { extension: "tool-search", enabled: false };
    expect((await change(deps, body, { ...good, [CSRF_HEADER]: "" })).status).toBe(403);
    expect((await change(deps, body, { ...good, [CSRF_HEADER]: await csrfToken(store.csrfKey(), "someone-else", NOW) })).status).toBe(403);
    const { origin: _origin, ...withoutOrigin } = good;
    expect((await change(deps, body, withoutOrigin)).status).toBe(403);
    expect((await change(deps, body, { ...good, origin: "https://t3.example.dev" })).status).toBe(403);
    expect((await change(deps, body, { ...good, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect(store.load().revision).toBe(0);
  });

  it("refuses a form-encoded body before anything else, for any caller", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    const response = await change(deps, "extension=tool-search&enabled=false", { "content-type": "application/x-www-form-urlencoded" });
    expect(response.status).toBe(403);
    expect(store.load().revision).toBe(0);
  });

  it("a script (service token + admin token, checked before) changes without a CSRF token; Origin, when sent, must still match", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    expect((await change(deps, { extension: "offered-tools", settings: { preset: "everything" } }, {})).status).toBe(200);
    expect((await change(deps, { extension: "offered-tools", settings: { preset: "core" } }, { origin: "https://evil.example" })).status).toBe(403);
    expect(store.auditLog(5)[0]?.caller).toBe("service-token");
  });

  it("refuses an invalid change with the registry's reason and stores nothing", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    const response = await change(deps, { extension: "permissions", enabled: false }, {});
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("locked");
    expect(store.load().revision).toBe(0);
  });

  it("GET never changes state, and other methods are refused", async () => {
    const { store, deps } = setup();
    const get = await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/extensions?extension=tool-search&enabled=false`), deps);
    expect(get.status).toBe(404);
    const put = await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/extensions`, { method: "PUT", body: "{}" }), deps);
    expect(put.status).toBe(405);
    expect(store.load().revision).toBe(0);
  });

  it("serves the page with a hash-only CSP and the owner's token; no 'self' or inline allowance", async () => {
    const { deps } = setup();
    const response = await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), deps);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await response.text();
    expect(html).toContain('name="t3flare-csrf"');
    expect(html).toContain("Code mode");
  });

  it("escapes hostile strings everywhere the page shows them", () => {
    const hostile = `<img src=x onerror="alert(1)">'&`;
    const html = renderPage({
      resolved: resolveHarness(EMPTY_HARNESS),
      csrf: hostile,
      audit: [{ at: NOW, caller: hostile, action: hostile, target: hostile, after: { note: hostile } }],
      status: { [hostile]: hostile },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(hostile));
    expect(escapeHtml(hostile)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;");
  });

  it("a direct server's header value is stored write-only: no answer, page or audit entry carries it (or its base64)", async () => {
    const kv = memory();
    const store = harnessStore(kv);
    const secrets = harnessSecrets(kv);
    const mcp = new McpHost({ kv, engine: undefined, commissary: { url: undefined, key: undefined }, settings: () => store.load() });
    const deps = { caller: { kind: "service-token" } as HarnessCaller, host: HOST, store, mcp, secrets, now: () => NOW };
    const VALUE = "s3cr3t-header-VALUE-1234";
    const add = await handleHarness(
      new Request(`https://${HOST}/_t3flare/harness/api/mcp/servers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server: "fixture", url: "https://fixture.example.dev/mcp", auth: { kind: "header", header: "Authorization" }, value: VALUE }),
      }),
      deps,
    );
    expect(add.status).toBe(200);
    const texts = [
      await add.text(),
      await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/mcp`), deps)).text(),
      await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/audit`), deps)).text(),
      await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/settings`), deps)).text(),
      await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), { ...deps, caller: owner })).text(),
    ];
    for (const text of texts) {
      expect(text).not.toContain(VALUE);
      expect(text).not.toContain(btoa(VALUE));
    }
    expect(texts[1]).toContain('"set":true');
    expect(secrets.read("fixture", "header")).toBe(VALUE);
    // Removing the server deletes its secret at once.
    await handleHarness(
      new Request(`https://${HOST}/_t3flare/harness/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "remove", server: "fixture" }) }),
      deps,
    );
    expect(secrets.read("fixture", "header")).toBeUndefined();
  });

  it("refuses reserved names, IP literals and plain http for a direct server", async () => {
    const { deps } = setup({ kind: "service-token" });
    const kv = memory();
    const withSecrets = { ...deps, secrets: harnessSecrets(kv) };
    for (const [server, url] of [["t3", "https://a.example/mcp"], ["x", "http://a.example/mcp"], ["y", "https://10.0.0.1/mcp"], ["z", "https://user:pw@a.example/mcp"]]) {
      const response = await handleHarness(
        new Request(`https://${HOST}/_t3flare/harness/api/mcp/servers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server, url }) }),
        withSecrets,
      );
      expect(response.status).toBe(400);
    }
  });
});
