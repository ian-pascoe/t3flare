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

/** The Container budget DO's state as the panel reads it: two Containers running. */
const RUNNING = { max: 3, leases: [{ holder: "a1", until: NOW + 60_000, workspace: "web-app" }, { holder: "b2", until: NOW + 60_000, workspace: null }] };

const setup = (caller: HarnessCaller = owner) => {
  const kv = memory();
  const store = harnessStore(kv);
  return { kv, store, deps: { caller, host: HOST, store, now: () => NOW, budget: async () => RUNNING } };
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
    expect(await getJson(deps, "environment")).toMatchObject({ revision: 1, resolved: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 } });
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

  it("audits only the settings a save moved; a save that moves none stores, bumps and audits nothing", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    const all = { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 };
    await post(deps, "environment", { settings: all }, {});
    expect(store.auditLog(5)).toMatchObject([{ target: "containerSize", before: { containerSize: "cpu-1" }, after: { containerSize: "standard-2" } }]);
    expect(store.auditLog(5)[0]?.after).toEqual({ containerSize: "standard-2" });
    const same = await post(deps, "environment", { settings: all }, {});
    expect(await same.json()).toMatchObject({ ok: true, unchanged: true, revision: 1 });
    expect(store.loadEnvironment().revision).toBe(1);
    expect(store.auditLog(5)).toHaveLength(1);
  });

  it("labels an audit entity the page does not know by its stored name (the audit entity is an open set)", async () => {
    const { kv, deps } = setup();
    kv.put(AUDIT_KEY, [{ at: NOW, entity: "models", caller: "owner:owner-sub", action: "models.change", target: "openai" }]);
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), deps)).text();
    expect(html).toContain('<td data-label="Settings"><div>models</div></td>');
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

  it("answers the settings with their schema, the sizes' costs at the budget set, and the Containers running now", async () => {
    const { store, deps } = setup();
    await post(deps, "environment", { settings: { containerBudget: 5 } }, await ownerHeaders(store));
    const answer = await getJson(deps, "environment");
    expect(answer.revision).toBe(1);
    expect(answer.schema.containerSize.schema.values).toEqual(["cpu-1", "standard-1", "standard-2", "standard-3", "standard-4"]);
    expect(answer.schema.containerBudget.schema).toMatchObject({ minimum: 1, maximum: 10, default: 3 });
    expect(answer.costs.budget).toBe(5);
    expect(answer.costs.rows).toHaveLength(5);
    expect(answer.running).toEqual({ count: 2, holders: ["web-app", "b2"] });
  });

  it("refuses a budget out of 1 to 10", async () => {
    const { deps } = setup({ kind: "service-token" });
    for (const budget of [0, 11]) expect((await post(deps, "environment", { settings: { containerBudget: budget } }, {})).status).toBe(400);
  });

  it("shows an Environment section with the size, the idle time, the budget beside the running Containers, and the cost table", async () => {
    const { store, deps } = setup();
    await post(deps, "environment", { settings: { containerSize: "standard-1" } }, await ownerHeaders(store));
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), deps)).text();
    expect(html).toContain('id="environment"');
    expect(html).toMatch(/<option value="standard-1" selected>/);
    expect(html).toContain('data-setting="containerIdleMinutes"');
    expect(html).toContain('data-setting="containerBudget"');
    expect(html).toContain("$1.20");
    expect(html).toMatch(/Running now<\/dt><dd>2 of 3/);
    // The current size's row and the summary; each row carries its one-Container hour for the script's live update.
    expect(html).toMatch(/<tr data-size="standard-1" data-per-hour="0\.074016" aria-current="true">/);
    expect(html).toContain("With these settings, at most $0.22 an hour: 3 Containers of standard-1, every vCPU busy.");
    expect(html).toContain("data-budget-head>3 Containers, an hour<");
    expect(html).toContain("web-app");
  });
});

// SPI-1152: the Variables in the same section and guards; the audit log keeps names and values (the page shows them to
// the owner anyway), the Workers Logs line neither.
describe("Variables in the panel", () => {
  it("stores a set of Variables through the same route and audits their names and values before and after", async () => {
    const { store, deps } = setup();
    const headers = await ownerHeaders(store);
    expect((await post(deps, "environment", { settings: { variables: { NODE_ENV: "development" } } }, headers)).status).toBe(200);
    const logged: Array<string> = [];
    const log = console.log;
    console.log = (line: string) => void logged.push(line);
    try {
      expect((await post(deps, "environment", { settings: { variables: { NODE_ENV: "test", REGION: "eu" } } }, headers)).status).toBe(200);
    } finally {
      console.log = log;
    }
    expect(await getJson(deps, "environment")).toMatchObject({ revision: 2, resolved: { variables: { NODE_ENV: "test", REGION: "eu" } } });
    expect(store.auditLog(1)).toMatchObject([
      { entity: "environment", action: "environment.change", target: "variables", before: { variables: { NODE_ENV: "development" } }, after: { variables: { NODE_ENV: "test", REGION: "eu" } } },
    ]);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toEqual({ t3flare: "harness-change", entity: "environment", caller: "owner", action: "environment.change", target: "variables" });
  });

  it("refuses a refused name or a credential-looking value with the whole reason, and stores nothing", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    const named = await post(deps, "environment", { settings: { variables: { GITHUB_TOKEN: "x" } } }, {});
    expect(named.status).toBe(400);
    expect(await named.text()).toBe('variables: "GITHUB_TOKEN" is refused: names starting GITHUB_ are GitHub\'s\n');
    const value = await post(deps, "environment", { settings: { variables: { OPENAI: `sk-${"a".repeat(30)}` } } }, {});
    expect(await value.text()).toBe('variables: "OPENAI"\'s value looks like an API key (sk-…), and secrets never enter a Container (ADR-0016)\n');
    expect(store.loadEnvironment().revision).toBe(0);
    expect(store.auditLog(5)).toEqual([]);
  });

  it("shows the Variables as a list in the Environment section: each name and value, escaped, and a way to add one", async () => {
    const { store, deps } = setup();
    await post(deps, "environment", { settings: { variables: { NODE_ENV: "test", GREETING: '<b>"hi"</b>' } } }, await ownerHeaders(store));
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), deps)).text();
    expect(html).toContain('data-setting="variables" data-kind="variables"');
    expect(html).toContain('<input type="text" data-variable-name aria-label="Name" value="NODE_ENV"');
    expect(html).toContain(">test</textarea>");
    expect(html).toContain("&lt;b&gt;&quot;hi&quot;&lt;/b&gt;</textarea>");
    expect(html).not.toContain('<b>"hi"</b>');
    expect(html).toContain("data-variable-add");
  });
});
