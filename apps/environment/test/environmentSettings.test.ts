// The Environment settings in the panel (SPI-1149, ADR-0032): `handleHarness` over a store, as for the Harness settings.
// Their own revision (an Environment change never moves the Harness one, and the reverse), the audit log's `entity`
// (old entries read as harness), validation, the same CSRF and Origin guards as the old routes, and the page's section.
import { describe, expect, it } from "vitest";

import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness, type HarnessCaller } from "../src/harness/panel.ts";
import { AUDIT_KEY, harnessStore } from "../src/harness/store.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 13, 10, 30);
const owner: HarnessCaller = { kind: "owner", subject: "owner-sub" };

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
  };
};

const setup = (caller: HarnessCaller = owner) => {
  const kv = memory();
  const store = harnessStore(kv);
  return { kv, store, deps: { caller, host: HOST, store, now: () => NOW } };
};

const post = (deps: ReturnType<typeof setup>["deps"], path: string, body: unknown, headers: Record<string, string>) =>
  handleHarness(
    new Request(`https://${HOST}/_t3flare/harness/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps,
  );

const ownerHeaders = async (store: ReturnType<typeof setup>["store"]) => ({
  origin: `https://${HOST}`,
  "sec-fetch-site": "same-origin",
  [CSRF_HEADER]: await csrfToken(store.csrfKey(), "owner-sub", NOW),
});

const getJson = async (deps: ReturnType<typeof setup>["deps"], path: string) =>
  (await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/${path}`), deps)).json() as Promise<any>;

describe("Environment settings in the panel", () => {
  it("an Environment change moves only the Environment revision; a Harness change moves only the Harness one", async () => {
    const { store, deps } = setup();
    const headers = await ownerHeaders(store);
    expect((await post(deps, "environment", { settings: { containerSize: "standard-2" } }, headers)).status).toBe(200);
    expect(store.loadEnvironment().revision).toBe(1);
    expect(store.load().revision).toBe(0);
    expect((await post(deps, "extensions", { extension: "tool-search", enabled: false }, headers)).status).toBe(200);
    expect(store.load().revision).toBe(1);
    expect(store.loadEnvironment().revision).toBe(1);
    expect(await getJson(deps, "environment")).toMatchObject({ revision: 1, resolved: { containerSize: "standard-2", containerIdleMinutes: 2 } });
  });

  it("audits an Environment change with entity environment and the changed settings before and after; old entries read as harness", async () => {
    const { kv, store, deps } = setup({ kind: "service-token" });
    kv.put(AUDIT_KEY, [{ at: NOW - 1000, caller: "service-token", action: "extension.change", target: "codemode", after: { enabled: false } }]);
    await post(deps, "environment", { settings: { containerSize: "standard-3", containerIdleMinutes: 10 } }, {});
    await post(deps, "environment", { settings: { containerIdleMinutes: 5 } }, {});
    await post(deps, "extensions", { extension: "codemode", enabled: true }, {});
    expect(store.auditLog(10)).toMatchObject([
      { entity: "harness", action: "extension.change", target: "codemode" },
      { entity: "environment", action: "environment.change", target: "containerIdleMinutes", before: { containerIdleMinutes: 10 }, after: { containerIdleMinutes: 5 } },
      {
        entity: "environment",
        action: "environment.change",
        target: "containerSize, containerIdleMinutes",
        before: { containerSize: "cpu-1", containerIdleMinutes: 2 },
        after: { containerSize: "standard-3", containerIdleMinutes: 10 },
      },
      { entity: "harness", action: "extension.change", target: "codemode", after: { enabled: false } },
    ]);
    expect((await getJson(deps, "audit")).entries[3].entity).toBe("harness");
  });

  it("refuses an invalid change with the setting named, and stores and audits nothing", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    for (const body of [{ settings: { containerSize: "lite" } }, { settings: { containerIdleMinutes: 0 } }, { settings: { secrets: "x" } }, { containerSize: "standard-1" }, "[]"]) {
      expect((await post(deps, "environment", body, {})).status).toBe(400);
    }
    const response = await post(deps, "environment", { settings: { containerIdleMinutes: 61 } }, {});
    expect(await response.text()).toContain("containerIdleMinutes: at most 60");
    expect(store.loadEnvironment().revision).toBe(0);
    expect(store.auditLog(10)).toEqual([]);
  });

  it("refuses the owner's change without CSRF, with a wrong Origin, cross-site, or form-encoded; a script's wrong Origin too", async () => {
    const { store, deps } = setup();
    const good = await ownerHeaders(store);
    const body = { settings: { containerSize: "standard-4" } };
    expect((await post(deps, "environment", body, { ...good, [CSRF_HEADER]: "" })).status).toBe(403);
    expect((await post(deps, "environment", body, { ...good, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(deps, "environment", body, { ...good, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(deps, "environment", "settings=x", { ...good, "content-type": "application/x-www-form-urlencoded" })).status).toBe(403);
    const script = setup({ kind: "service-token" });
    expect((await post(script.deps, "environment", body, { origin: "https://evil.example" })).status).toBe(403);
    expect(store.loadEnvironment().revision).toBe(0);
  });

  it("answers the settings with their schema, the sizes' resources and costs, and the budget", async () => {
    const { deps } = setup();
    const answer = await getJson(deps, "environment");
    expect(answer.revision).toBe(0);
    expect(answer.schema.containerSize.schema.values).toEqual(["cpu-1", "standard-1", "standard-2", "standard-3", "standard-4"]);
    expect(answer.costs.budget).toBe(3);
    expect(answer.costs.rows).toHaveLength(5);
  });

  it("shows an Environment section with the size, the idle time, the read-only budget and the cost table", async () => {
    const { store, deps } = setup();
    await post(deps, "environment", { settings: { containerSize: "standard-1" } }, await ownerHeaders(store));
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), deps)).text();
    expect(html).toContain('id="environment"');
    expect(html).toMatch(/<option value="standard-1" selected>/);
    expect(html).toContain('data-setting="containerIdleMinutes"');
    expect(html).toContain("$1.20");
    expect(html).toMatch(/Container budget<\/dt><dd>3/);
  });
});
