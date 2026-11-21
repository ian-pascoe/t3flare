// The Settings API's change bodies are decoded, not trusted (SPI audit): `handleHarness` over a store, as a script calls
// it. A body of the wrong shape is refused with 400 and leaves the stored Harness as it was.
import { describe, expect, it } from "vitest";

import type { AccessCaller } from "../src/access.ts";
import { handleHarness } from "../src/harness/panel.ts";
import { harnessSecrets } from "../src/harness/secrets.ts";
import { harnessStore } from "../src/harness/store.ts";
import { McpHost } from "../src/mcp/host.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 12, 10, 30);
const script: AccessCaller = { kind: "service-token" };

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  };
};

const setup = () => {
  const kv = memory();
  const store = harnessStore(kv);
  const mcp = new McpHost({ kv, engine: undefined, settings: () => store.load() });
  const deps = { caller: script, host: HOST, store, mcp, secrets: harnessSecrets(kv), now: () => NOW };
  const post = (path: string, body: unknown) =>
    handleHarness(new Request(`https://${HOST}/_t3flare/settings${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), deps);
  return { store, post };
};

describe("Settings API change bodies", () => {
  it("refuses an MCP class change whose tool is not a string, and stores nothing", async () => {
    const { store, post } = setup();
    expect((await post("/api/mcp/servers", { server: "executor", url: "https://mcp.executor.example/mcp", auth: { kind: "none" } })).status).toBe(200);
    const before = store.load();
    const response = await post("/api/mcp", { op: "class", server: "executor", tool: 42, class: "read" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("tool");
    expect(store.load()).toEqual(before);
    // A well-formed one still lands.
    expect((await post("/api/mcp", { op: "class", server: "executor", tool: "search", class: "read" })).status).toBe(200);
    expect(store.load().mcp?.servers?.["executor"]).toMatchObject({ classes: { search: "read" } });
  });

  it("refuses an extension change whose settings are null, not an object, and stores nothing", async () => {
    const { store, post } = setup();
    const before = store.load();
    const response = await post("/api/extensions", { extension: "codemode", settings: null });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("settings");
    expect(store.load()).toEqual(before);
    expect((await post("/api/extensions", { extension: "codemode", settings: { inlineBudget: 3000 } })).status).toBe(200);
    expect(store.load().revision).toBe(before.revision + 1);
  });
});
