// SPI-1175: the Model endpoint a stage, the acceptance test and CI set up through the panel's API: where its spec comes
// from (scripts/lib/modelEndpointSpec.ts), and how it is saved (scripts/lib/modelEndpoint.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import { type AdminCall, ensureModelEndpoint } from "../scripts/lib/modelEndpoint.ts";
import { ENDPOINT_APIS, type EndpointApi } from "@t3flare/models/endpoints";

import {
  cliCoverage,
  keptReportJson,
  maskCommands,
  modelEndpointSecret,
  modelEndpointSpec,
  type ModelEndpointSpec,
  scrubSecrets,
  secretsOf,
  SPEC_APIS,
  type SpecApi,
  stageEndpointSpec,
} from "../scripts/lib/modelEndpointSpec.ts";
import { sealedStore } from "../src/credentials/sealed.ts";
import type { Discovery } from "../src/endpoints/discover.ts";
import { endpointStore } from "../src/endpoints/store.ts";
import { handleHarness, type HarnessDeps } from "../src/harness/panel.ts";
import { harnessStore } from "../src/harness/store.ts";

const KEY = "sk-spi1175-secret-key-0123456789";
const SECOND_KEY = "rk-other-endpoint-abcdefghijkl";
const HOST = "t3.example.dev";
const NOW = Date.UTC(2026, 10, 14, 10, 0);

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

/**
 * The panel's real routes behind a script's admin call (the stage's service token plus the admin token, which worker.ts
 * checks before the panel runs). `listed` is the endpoint's model list; `down` answers that many calls as Access does
 * before the stage's service token is honoured.
 */
const stagePanel = (options: { readonly listed?: ReadonlyArray<string> | string; readonly down?: number } = {}) => {
  const kv = memory();
  const endpoints = endpointStore(kv, sealedStore(kv, "d".repeat(64), () => NOW));
  const discovered: Array<{ baseUrl: string; apiKey: string | undefined }> = [];
  const calls: Array<string> = [];
  let down = options.down ?? 0;
  const deps: HarnessDeps = {
    caller: { kind: "service-token" },
    host: HOST,
    store: harnessStore(kv),
    now: () => NOW,
    endpoints: {
      store: endpoints,
      discover: async (target, apiKey): Promise<Discovery> => {
        discovered.push({ baseUrl: target.baseUrl, apiKey });
        const listed = options.listed ?? [];
        return typeof listed === "string" ? { ok: false, error: listed } : { ok: true, models: listed.map((id) => ({ id })) };
      },
    },
  };
  const admin: AdminCall = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (down > 0) {
      down--;
      return { status: 302, text: "" };
    }
    const response = await handleHarness(
      new Request(`https://${HOST}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }),
      deps,
    );
    return { status: response.status, text: await response.text() };
  };
  return { admin, endpoints, discovered, calls };
};

const noWait = { waitMs: 60_000, sleep: async () => {} };

describe("cliCoverage: every CLI the acceptance test runs has an endpoint for its API", () => {
  it("names each CLI no endpoint serves, with what it needs; nothing when every one is served", () => {
    const anth = [{ api: "anthropic-messages" as const }];
    expect(cliCoverage(["codex", "pi", "claude", "opencode"], anth)).toEqual([{ cli: "codex", needs: "an endpoint speaking openai-responses in T3FLARE_MODEL_ENDPOINT" }]);
    expect(cliCoverage(["codex", "pi", "claude", "opencode"], [{ api: "openai-responses" }]).map((entry) => entry.cli)).toEqual(["claude"]);
    expect(cliCoverage(["codex", "pi", "claude", "opencode"], [...anth, { api: "openai-responses" }])).toEqual([]);
    expect(cliCoverage(["pi", "codex"], []).map((entry) => entry.cli)).toEqual(["pi", "codex"]);
    expect(cliCoverage([], [])).toEqual([]);
  });
});

describe("modelEndpointSpec", () => {
  it("reads T3FLARE_MODEL_ENDPOINT, with defaults for what it leaves out", () => {
    const value = JSON.stringify({ id: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: KEY, models: ["gpt-5-mini"] });
    const found = modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: value });
    expect(found).toEqual({
      ok: true,
      source: "T3FLARE_MODEL_ENDPOINT",
      spec: { id: "openai", label: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: KEY, headers: {}, models: ["gpt-5-mini"] },
      specs: [{ id: "openai", label: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: KEY, headers: {}, models: ["gpt-5-mini"] }],
    });
  });

  it("reads a list, one endpoint per API, the first being the stage's own; ids unique", () => {
    const anth = { id: "anth", baseUrl: "https://llm.example.com", apiKey: KEY };
    const resp = { id: "resp", api: "openai-responses", baseUrl: "https://llm.example.com/v1", apiKey: SECOND_KEY };
    const found = modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: JSON.stringify([anth, resp]) });
    if (!found.ok) throw new Error(found.reason);
    expect(found.specs.map((spec) => [spec.id, spec.api])).toEqual([["anth", "anthropic-messages"], ["resp", "openai-responses"]]);
    expect(found.spec).toEqual(found.specs[0]);
    // Both keys are masked and scrubbed, not only the first's.
    expect(maskCommands({ T3FLARE_MODEL_ENDPOINT: JSON.stringify([anth, resp]) })).toEqual([`::add-mask::${KEY}`, `::add-mask::${SECOND_KEY}`]);
    // The second key shares nothing with the first: scrubbing the first alone leaves it.
    const kept = keptReportJson({ a: KEY, b: `second ${SECOND_KEY}` }, { T3FLARE_MODEL_ENDPOINT: JSON.stringify([anth, resp]) });
    expect(kept).not.toContain(KEY);
    expect(kept).not.toContain(SECOND_KEY);
    // ci:setup writes it back as a list.
    expect(modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: modelEndpointSecret(found.specs) })).toEqual(found);
    expect(modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: JSON.stringify([anth, anth]) })).toMatchObject({ ok: false, invalid: true, reason: 'T3FLARE_MODEL_ENDPOINT has the id "anth" twice' });
    expect(modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: "[]" })).toMatchObject({ ok: false, invalid: true, reason: "T3FLARE_MODEL_ENDPOINT is an empty list" });
    expect(modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: JSON.stringify([anth, { id: "y" }]) })).toMatchObject({ ok: false, invalid: true, reason: "T3FLARE_MODEL_ENDPOINT[1] has no baseUrl" });
  });

  it("reads back the secret ci:setup writes", () => {
    const given = modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: JSON.stringify({ id: "commissary", baseUrl: "https://llm.example.com", apiKey: KEY, match: "^claude-" }) });
    if (!given.ok) throw new Error(given.reason);
    expect(modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: modelEndpointSecret([given.spec]) })).toEqual({ ok: true, source: "T3FLARE_MODEL_ENDPOINT", spec: given.spec, specs: [given.spec] });
    // One endpoint is stored as one object, as the owner writes it.
    expect(JSON.parse(modelEndpointSecret([given.spec]))).toMatchObject({ id: "commissary" });
  });

  it("derives nothing from the retired Model proxy's settings (SPI-1176): a missing T3FLARE_MODEL_ENDPOINT is a skip, not an error", () => {
    const retired = { MODEL_PROXY_URL: "https://llm.example.com", MODEL_PROXY_API_KEY: KEY };
    expect(modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: "", ...retired })).toEqual({ ok: false, invalid: false, reason: "T3FLARE_MODEL_ENDPOINT is not set" });
    expect(modelEndpointSpec({})).toEqual({ ok: false, invalid: false, reason: "T3FLARE_MODEL_ENDPOINT is not set" });
  });

  it("refuses a malformed value without repeating it", () => {
    const cases = [
      `{"id":"x","baseUrl":"https://a.example","apiKey":"${KEY}"`,
      JSON.stringify(["https://a.example", KEY]),
      JSON.stringify({ id: "x", baseUrl: "https://a.example" }),
      JSON.stringify({ id: "x", apiKey: KEY }),
      JSON.stringify({ baseUrl: "https://a.example", apiKey: KEY }),
      JSON.stringify({ id: "x", baseUrl: "https://a.example", apiKey: KEY, models: "all" }),
      JSON.stringify({ id: "x", baseUrl: "https://a.example", apiKey: KEY, match: "(" }),
      JSON.stringify({ id: "x", baseUrl: "https://a.example", apiKey: KEY, headers: { "x-a": 1 } }),
      JSON.stringify({ id: "x", baseUrl: "https://a.example", apiKey: KEY, api: "bedrock" }),
    ];
    for (const value of cases) {
      const found = modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: value });
      expect(found.ok, value).toBe(false);
      if (!found.ok) {
        expect(found.invalid).toBe(true);
        expect(found.reason).toMatch(/^T3FLARE_MODEL_ENDPOINT(\[\d+\])? /);
        expect(found.reason).not.toContain(KEY);
        expect(found.reason).not.toContain("a.example");
      }
    }
  });
});

describe("the APIs a spec may name", () => {
  it("are the endpoints' own", () => {
    expect([...SPEC_APIS]).toEqual([...ENDPOINT_APIS]);
    expectTypeOf<SpecApi>().toEqualTypeOf<EndpointApi>();
  });
});

describe("stageEndpointSpec (stage.ts and acceptance.ts)", () => {
  const retired = { MODEL_PROXY_URL: "https://llm.example.com", MODEL_PROXY_API_KEY: KEY };
  it("is the setting alone, on a laptop as in CI: nothing from the retired proxy's settings", () => {
    expect(stageEndpointSpec(retired)).toEqual({ ok: false, invalid: false, reason: "T3FLARE_MODEL_ENDPOINT is not set" });
    expect(stageEndpointSpec({ ...retired, GITHUB_ACTIONS: "true" })).toEqual({ ok: false, invalid: false, reason: "T3FLARE_MODEL_ENDPOINT is not set" });
    expect(stageEndpointSpec({ T3FLARE_MODEL_ENDPOINT: WITH_HEADERS })).toMatchObject({ ok: true, spec: { id: "gw" } });
  });
});

const HEADER_SECRET = "gw-route-token-5555";
const WITH_HEADERS = JSON.stringify({ id: "gw", baseUrl: "https://gw.example.com", apiKey: KEY, headers: { "x-gateway-token": HEADER_SECRET, "x-short": "1" } });

describe("masking and scrubbing the endpoint's secrets", () => {
  it("masks the key and each header value in CI, each on its own; short values are left", () => {
    expect(maskCommands({ T3FLARE_MODEL_ENDPOINT: WITH_HEADERS })).toEqual([`::add-mask::${KEY}`, `::add-mask::${HEADER_SECRET}`]);
  });
  it("masks nothing more when the setting is unset or unusable (GitHub masks the whole value)", () => {
    expect(maskCommands({})).toEqual([]);
    expect(maskCommands({ T3FLARE_MODEL_ENDPOINT: "{not json" })).toEqual([]);
  });
  it("scrubs the key and header values from any text", () => {
    const parsed = modelEndpointSpec({ T3FLARE_MODEL_ENDPOINT: WITH_HEADERS });
    if (!parsed.ok) throw new Error(parsed.reason);
    const text = scrubSecrets(`{"error":"bad ${KEY} and ${HEADER_SECRET}","n":1}`, secretsOf(parsed.spec));
    expect(text).toBe('{"error":"bad [redacted] and [redacted]","n":1}');
  });
});

describe("keptReportJson (the acceptance report and bump-report.json)", () => {
  // A key holding JSON's escapes, and a header value that is a JSON token.
  const QUOTED_KEY = 'sk-"quoted"\\key-0123456789';
  const ci = { GITHUB_ACTIONS: "true", T3FLARE_MODEL_ENDPOINT: JSON.stringify({ id: "gw", baseUrl: "https://gw.example.com", apiKey: QUOTED_KEY, headers: { "x-flag": "true" } }) };
  const report = { ok: true, failures: [`refused ${QUOTED_KEY}`], modelEndpoint: { ok: false, error: "header true was refused" }, count: 3, nested: [{ note: QUOTED_KEY }] };

  it("scrubs the key and header values from every string, and stays JSON with its tokens intact", () => {
    const kept = keptReportJson(report, ci);
    const parsed = JSON.parse(kept);
    expect(parsed).toEqual({ ok: true, failures: ["refused [redacted]"], modelEndpoint: { ok: false, error: "header [redacted] was refused" }, count: 3, nested: [{ note: "[redacted]" }] });
    expect(kept).not.toContain('quoted\\"');
    expect(kept).not.toContain("quoted");
  });

  it("scrubs the Owner's email (a secret in CI)", () => {
    expect(JSON.parse(keptReportJson({ who: "owner@example.com signed in" }, { T3FLARE_OWNER_EMAIL: "owner@example.com" }))).toEqual({ who: "[redacted] signed in" });
  });

  it("is the plain report when there is no endpoint", () => {
    expect(JSON.parse(keptReportJson(report, { GITHUB_ACTIONS: "true" }))).toEqual(report);
  });

  it("is how acceptance.ts and bump.ts write their reports", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    for (const file of ["apps/environment/scripts/acceptance.ts", "scripts/bump.ts"]) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      expect(source, file).toContain("keptReportJson(report, process.env)");
      expect(source, file).not.toMatch(/JSON\.stringify\(report\b/);
    }
  });
});

/** Commissary as an ordinary Anthropic Messages endpoint, its Claude models read from its list. */
const COMMISSARY: ModelEndpointSpec = { id: "commissary", label: "Commissary", api: "anthropic-messages", baseUrl: "https://llm.example.com", apiKey: KEY, headers: {}, match: "^claude-" };

describe("ensureModelEndpoint", () => {
  it("on a fresh stage, saves the endpoint with its key and the listed models `match` keeps; the turn model is its small model", async () => {
    const panel = stagePanel({ listed: ["gpt-5.4-mini", "claude-sonnet-5-5", "claude-haiku-5-5", "gemini-3-flash"] });
    const result = await ensureModelEndpoint(panel.admin, COMMISSARY, { overwrite: true, ...noWait });
    expect(result).toEqual({ ok: true, outcome: "created", id: "commissary", models: 2, turnModel: "commissary/claude-haiku-5-5" });
    expect(panel.discovered).toEqual([{ baseUrl: "https://llm.example.com", apiKey: KEY }]);
    const [saved] = panel.endpoints.load().endpoints;
    expect(saved).toMatchObject({ id: "commissary", label: "Commissary", api: "anthropic-messages", auth: "api-key" });
    expect(saved!.models.map((model) => model.id)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect((await panel.endpoints.resolve("commissary"))?.apiKey).toBe(KEY);
  });

  it("saves the models the spec names without reading the list; with no small model, the turn runs on the first", async () => {
    const panel = stagePanel({ listed: ["other"] });
    const spec: ModelEndpointSpec = { ...COMMISSARY, id: "mine", models: ["claude-sonnet-5-5", "claude-opus-5-5"] };
    const result = await ensureModelEndpoint(panel.admin, spec, { overwrite: true, ...noWait });
    expect(result).toMatchObject({ ok: true, outcome: "created", models: 2, turnModel: "mine/claude-sonnet-5-5" });
    expect(panel.discovered).toEqual([]);
  });

  it("keeps an endpoint already there when told not to overwrite (prod: the owner's edits stand)", async () => {
    const panel = stagePanel({ listed: ["claude-haiku-5-5"] });
    await ensureModelEndpoint(panel.admin, { ...COMMISSARY, models: ["claude-haiku-5-5"] }, { overwrite: true, ...noWait });
    const before = panel.endpoints.load().revision;
    const result = await ensureModelEndpoint(panel.admin, { ...COMMISSARY, apiKey: "sk-another-key-0000", models: ["claude-sonnet-5-5"] }, { overwrite: false, ...noWait });
    expect(result).toEqual({ ok: true, outcome: "kept", id: "commissary", models: 1, turnModel: "commissary/claude-haiku-5-5" });
    expect(panel.endpoints.load().revision).toBe(before);
    expect((await panel.endpoints.resolve("commissary"))?.apiKey).toBe(KEY);
  });

  it("saves it again on a test stage, with the key given", async () => {
    const panel = stagePanel();
    await ensureModelEndpoint(panel.admin, { ...COMMISSARY, models: ["claude-haiku-5-5"] }, { overwrite: true, ...noWait });
    const result = await ensureModelEndpoint(panel.admin, { ...COMMISSARY, apiKey: "sk-another-key-0000", models: ["claude-haiku-5-5", "claude-sonnet-5-5"] }, { overwrite: true, ...noWait });
    expect(result).toMatchObject({ ok: true, outcome: "updated", models: 2 });
    expect((await panel.endpoints.resolve("commissary"))?.apiKey).toBe("sk-another-key-0000");
  });

  it("waits for a freshly deployed stage's panel to admit the service token", async () => {
    const panel = stagePanel({ down: 3 });
    const result = await ensureModelEndpoint(panel.admin, { ...COMMISSARY, models: ["claude-haiku-5-5"] }, { overwrite: true, ...noWait });
    expect(result).toMatchObject({ ok: true, outcome: "created" });
    expect(panel.calls.slice(0, 4)).toEqual(Array(4).fill("GET /_t3flare/settings/api/endpoints"));
  });

  it("gives up when the panel never answers, saying how it answered", async () => {
    const panel = stagePanel({ down: 1000 });
    let clock = 0;
    const result = await ensureModelEndpoint(panel.admin, COMMISSARY, {
      overwrite: true,
      waitMs: 30_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    expect(result).toEqual({ ok: false, error: "the Harness panel did not answer GET /_t3flare/settings/api/endpoints (HTTP 302)" });
  });

  it("fails when the list has no model `match` keeps, saving nothing", async () => {
    const panel = stagePanel({ listed: ["gpt-5-mini"] });
    const result = await ensureModelEndpoint(panel.admin, COMMISSARY, { overwrite: true, ...noWait });
    expect(result).toEqual({ ok: false, error: 'the Model endpoint "commissary" lists no model matching ^claude- (1 listed)' });
    expect(panel.endpoints.load().endpoints).toEqual([]);
  });

  it("fails when the model list cannot be read, with the panel's reason", async () => {
    const panel = stagePanel({ listed: "the endpoint answered HTTP 401" });
    const result = await ensureModelEndpoint(panel.admin, COMMISSARY, { overwrite: true, ...noWait });
    expect(result).toEqual({ ok: false, error: 'the Model endpoint "commissary"\'s model list could not be read (HTTP 200): the endpoint answered HTTP 401' });
    expect(panel.endpoints.load().endpoints).toEqual([]);
  });

  it("passes the panel's refusal on without the key, even when an answer repeats it", async () => {
    const refusing: AdminCall = async (method, path) =>
      method === "GET" ? { status: 200, text: JSON.stringify({ revision: 0, endpoints: [] }) } : { status: 400, text: `refused ${path} with ${KEY}` };
    const result = await ensureModelEndpoint(refusing, { ...COMMISSARY, models: ["claude-haiku-5-5"] }, { overwrite: true, ...noWait });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result).toEqual({ ok: false, error: "the Harness panel refused the Model endpoint \"commissary\" (HTTP 400): refused /_t3flare/settings/api/endpoints with [redacted]" });
  });

  it("scrubs a header's value from a refusal too", async () => {
    const refusing: AdminCall = async (method) =>
      method === "GET" ? { status: 200, text: JSON.stringify({ revision: 0, endpoints: [] }) } : { status: 400, text: `bad header ${HEADER_SECRET}` };
    const result = await ensureModelEndpoint(refusing, { ...COMMISSARY, headers: { "x-gateway-token": HEADER_SECRET }, models: ["claude-haiku-5-5"] }, { overwrite: true, ...noWait });
    expect(JSON.stringify(result)).not.toContain(HEADER_SECRET);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("bad header [redacted]") });
  });

  it("refuses an endpoint the panel's validation refuses (a plain-http URL), saying why", async () => {
    const panel = stagePanel();
    const result = await ensureModelEndpoint(panel.admin, { ...COMMISSARY, baseUrl: "http://llm.example.com", models: ["claude-haiku-5-5"] }, { overwrite: true, ...noWait });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^the Harness panel refused the Model endpoint "commissary" \(HTTP 400\): .*https/);
  });
});
