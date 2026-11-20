// @effect-diagnostics globalDate:off
// T-endpoint, T-guards, T-state (plan §5; ADR-0035, plan D11, D12's `browser`), M5a (SPI-1200): the Owner-client
// endpoint over one Environment's Settings server (settingsFixture). Version negotiation for each version and an unknown
// method; capabilities from 2026's `_meta` on each request and from 2025's signed session; every guard of D11; the signed
// `requestState`, session and elicitation id refused when tampered, expired, another identity's, another kind's, or for
// another call, applying nothing. The audiences (the panel's at the endpoint and the endpoint's at the panel) are in
// access.test.ts; `browser`'s delivery and holds are in settingsModes.test.ts.
import { applyMcpChange } from "@t3flare/harness-registry";
import { afterEach, describe, expect, it } from "vitest";

import { BODY_MAX, LEGACY_VERSIONS, MODERN_VERSION, SUPPORTED_VERSIONS } from "../src/settings/endpoint.ts";
import { isSettingsMcpPath, OWNER_ENDPOINT_EXCLUDED_STAGES, ownerEndpointOn, SETTINGS_MCP_PATH, settingsMcpUrl } from "../src/settings/endpointLayout.ts";
import { SETTINGS_TOOLS } from "../src/settings/tools.ts";
import { signToken } from "../src/settings/tokens.ts";
import { ASKED, BOTH, bodyOf, ENDPOINT, endpointOf, FREE, initialize, KEY, legacy, modern, modernMeta, post, setAccess, structuredOf, SUB } from "./settingsEndpointFixture.ts";
import { NOW, settingsFixture, type SettingsFixture } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
const world = () => {
  fixture = settingsFixture();
  return fixture;
};
afterEach(() => fixture?.dispose());

describe("T-guards: D11's guards, before the body is parsed", () => {
  it.each(["GET", "DELETE", "OPTIONS", "PUT"])("answers %s with 405", async (method) => {
    const response = await endpointOf(world())(new Request(ENDPOINT, { method, headers: { accept: "text/event-stream" } }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""])("answers Content-Type %j with 415", async (type) => {
    const response = await endpointOf(world())(new Request(ENDPOINT, { method: "POST", headers: type === "" ? {} : { "content-type": type }, body: "{}" }));
    expect(response.status).toBe(415);
  });

  it("takes application/json with a charset", async () => {
    const response = await endpointOf(world())(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "content-type": "application/json; charset=utf-8" } }));
    expect(response.status).toBe(200);
  });

  it.each([
    ["Origin", { origin: "https://t3.example.dev" }],
    ["Origin null", { origin: "null" }],
    ["Sec-Fetch-Site", { "sec-fetch-site": "same-origin" }],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }],
  ])("answers any %s with 403", async (_name, headers) => {
    const response = await endpointOf(world())(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers }));
    expect(response.status).toBe(403);
  });

  it("does not refuse Sec-Fetch-Mode alone (pi's undici sends cors, M0)", async () => {
    const response = await endpointOf(world())(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "sec-fetch-mode": "cors", "user-agent": "undici" } }));
    expect(response.status).toBe(200);
  });

  it("answers a body over 256 KiB with 413, by its length header and by what is read", async () => {
    const endpoint = endpointOf(world());
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(BODY_MAX) } });
    expect((await endpoint(post(big))).status).toBe(413);
    // No length header: a stream of chunks.
    const chunks = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (let index = 0; index < 5; index++) controller.enqueue(new Uint8Array(64 * 1024).fill(32));
        controller.close();
      },
    });
    const streamed = new Request(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: chunks, duplex: "half" } as RequestInit);
    expect((await endpoint(streamed)).status).toBe(413);
  });

  it.each([
    ["an unknown value", "?elicitation_mode=natve"],
    ["a repeated one", "?elicitation_mode=browser&elicitation_mode=browser"],
    ["a mis-cased value", "?elicitation_mode=Browser"],
    ["a mis-cased name", "?Elicitation_Mode=browser"],
    ["an empty value", "?elicitation_mode="],
  ])("answers %s of elicitation_mode with 400 at initialize, naming the three", async (_name, query) => {
    const response = await endpointOf(world())(post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }, { query }));
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error?.message).toMatch(/browser, native or model/);
  });

  it("takes each of the three values, and ignores every other query parameter (OpenCode's codemode=false)", async () => {
    const endpoint = endpointOf(world());
    for (const query of ["?elicitation_mode=browser", "?elicitation_mode=native", "?elicitation_mode=model", "?elicitation_mode=native&codemode=false", "?codemode=false", ""]) {
      expect((await endpoint(post({ jsonrpc: "2.0", id: 1, method: "ping" }, { query }))).status).toBe(200);
    }
  });

  it("sends no CORS header and never lets an answer be stored", async () => {
    const endpoint = endpointOf(world());
    for (const response of [
      await endpoint(post({ jsonrpc: "2.0", id: 1, method: "ping" })),
      await endpoint(modern("tools/list")),
      await endpoint(post({ jsonrpc: "2.0", method: "notifications/initialized" })),
      await endpoint(post("{nope")),
      await endpoint(new Request(ENDPOINT)),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("T-endpoint: versions and methods", () => {
  it.each(LEGACY_VERSIONS)("initialize at %s answers that version, the tools capability and a session", async (version) => {
    const { response, session, body } = await initialize(endpointOf(world()), version);
    expect(response.status).toBe(200);
    expect(body.result).toMatchObject({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "t3flare-settings" } });
    expect(typeof body.result.instructions).toBe("string");
    expect(session).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("initialize at an unknown or 2026 version answers the newest 2025 version", async () => {
    for (const asked of ["1999-01-01", MODERN_VERSION]) expect((await initialize(endpointOf(world()), asked)).body.result.protocolVersion).toBe("2025-11-25");
  });

  it("2026: server/discover lists every version, the tools capability, resultType and cache fields", async () => {
    const body = await bodyOf(await endpointOf(world())(modern("server/discover")));
    expect(body.result).toMatchObject({ resultType: "complete", supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: { listChanged: false } }, ttlMs: 0, cacheScope: "private" });
    expect(SUPPORTED_VERSIONS).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
  });

  it("2026: every result carries resultType; ping is empty but for it", async () => {
    const endpoint = endpointOf(world());
    expect((await bodyOf(await endpoint(modern("ping")))).result).toMatchObject({ resultType: "complete" });
    expect((await bodyOf(await endpoint(modern("tools/list")))).result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    expect((await bodyOf(await endpoint(modern("tools/call", { name: "get_status", arguments: {} })))).result).toMatchObject({ resultType: "complete", isError: false });
  });

  it("2025: no result carries resultType", async () => {
    const endpoint = endpointOf(world());
    const { session } = await initialize(endpoint, "2025-11-25");
    expect((await bodyOf(await endpoint(legacy("ping", {}, { session })))).result).toEqual({});
    expect((await bodyOf(await endpoint(legacy("tools/list", {}, { session })))).result).not.toHaveProperty("resultType");
  });

  it("2026: an unsupported version is 400 with -32022 naming the supported ones; a mismatched header is 400 with -32020", async () => {
    const endpoint = endpointOf(world());
    const unsupported = await endpoint(post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2027-01-01" } } }));
    expect(unsupported.status).toBe(400);
    expect((await bodyOf(unsupported)).error).toMatchObject({ code: -32022, data: { supported: [...SUPPORTED_VERSIONS], requested: "2027-01-01" } });
    const mismatch = await endpoint(post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } }, { headers: { "mcp-protocol-version": "2025-11-25" } }));
    expect(mismatch.status).toBe(400);
    expect((await bodyOf(mismatch)).error?.code).toBe(-32020);
  });

  it("2026: MCP-Protocol-Version and Mcp-Method on every request and Mcp-Name on tools/call are required and must match the body (-32020, 400)", async () => {
    const endpoint = endpointOf(world());
    const send = async (method: string, params: Record<string, unknown>, headers: Record<string, string>) => {
      const response = await endpoint(post({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: modernMeta() } }, { headers }));
      return { status: response.status, code: (await bodyOf(response)).error?.code };
    };
    const base = { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" };
    expect(await send("tools/list", {}, { "mcp-method": "tools/list" })).toEqual({ status: 400, code: -32020 });
    expect(await send("tools/list", {}, { "mcp-protocol-version": MODERN_VERSION })).toEqual({ status: 400, code: -32020 });
    expect(await send("tools/list", {}, { ...base, "mcp-method": "ping" })).toEqual({ status: 400, code: -32020 });
    expect(await send("tools/list", {}, base)).toEqual({ status: 200, code: undefined });
    const call = { name: "get_status", arguments: {} };
    const callHeaders = { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/call" };
    expect(await send("tools/call", call, callHeaders)).toEqual({ status: 400, code: -32020 });
    expect(await send("tools/call", call, { ...callHeaders, "mcp-name": "get_settings" })).toEqual({ status: 400, code: -32020 });
    expect(await send("tools/call", call, { ...callHeaders, "mcp-name": "get_status" })).toEqual({ status: 200, code: undefined });
    // The Base64 sentinel form is decoded before it is compared.
    expect(await send("tools/call", call, { ...callHeaders, "mcp-name": `=?base64?${btoa("get_status")}?=` })).toEqual({ status: 200, code: undefined });
    expect(await send("tools/call", call, { ...callHeaders, "mcp-name": "=?base64?***?=" })).toEqual({ status: 400, code: -32020 });
  });

  it("2025: an unknown MCP-Protocol-Version is 400; a missing one is 2025-03-26; initialize's header is not judged", async () => {
    const endpoint = endpointOf(world());
    const unknown = await endpoint(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { "mcp-protocol-version": "2024-01-01" } }));
    expect(unknown.status).toBe(400);
    expect((await bodyOf(unknown)).error).toMatchObject({ code: -32600, data: { requested: "2024-01-01" } });
    // A 2026 header with no 2026 `_meta`: the header and the body disagree, -32020 (SPI-1201 review), on any method.
    for (const method of ["tools/list", "server/discover"]) {
      const disagreeing = await endpoint(post({ jsonrpc: "2.0", id: 1, method, params: {} }, { headers: { "mcp-protocol-version": MODERN_VERSION, "mcp-method": method } }));
      expect(disagreeing.status).toBe(400);
      expect((await bodyOf(disagreeing)).error).toMatchObject({ code: -32020 });
    }
    const missing = await endpoint(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(missing.status).toBe(200);
    expect((await bodyOf(missing)).result).not.toHaveProperty("resultType");
    const init = await endpoint(post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }, { headers: { "mcp-protocol-version": "1999-01-01" } }));
    expect(init.status).toBe(200);
  });

  it("an unsupported method is -32601: 404 on 2026, 200 on 2025", async () => {
    const endpoint = endpointOf(world());
    const newer = await endpoint(modern("resources/list"));
    expect(newer.status).toBe(404);
    expect((await bodyOf(newer)).error?.code).toBe(-32601);
    for (const method of ["resources/list", "prompts/list", "tasks/get", "completion/complete"]) {
      const older = await endpoint(legacy(method));
      expect(older.status).toBe(200);
      expect((await bodyOf(older)).error?.code).toBe(-32601);
    }
  });

  it("answers a notification 202 with no body, and refuses a batch, a non-JSON body and a non-2.0 message", async () => {
    const endpoint = endpointOf(world());
    const note = await endpoint(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    expect((await bodyOf(await endpoint(post([{ jsonrpc: "2.0", id: 1, method: "ping" }])))).error?.code).toBe(-32600);
    expect((await bodyOf(await endpoint(post("{not json")))).error?.code).toBe(-32700);
    expect((await bodyOf(await endpoint(post({ jsonrpc: "1.0", id: 1, method: "ping" })))).error?.code).toBe(-32600);
  });

  it("lists the thirteen tools with readOnlyHint from their class, and never resume", async () => {
    const body = await bodyOf(await endpointOf(world())(modern("tools/list")));
    const tools = body.result?.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    expect(tools.map((tool) => tool.name)).toEqual(SETTINGS_TOOLS.map((tool) => tool.name));
    expect(tools).toHaveLength(13);
    for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(SETTINGS_TOOLS.find((each) => each.name === tool.name)!.class === "read");
    expect(tools.map((tool) => tool.name)).not.toContain("resume");
  });

  it("the access switch: off lists nothing and refuses every call naming the panel; read-only lists and runs reads only", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    setAccess(f, { writes: false });
    const readOnly = (await bodyOf(await endpoint(modern("tools/list")))).result?.tools as Array<{ name: string }>;
    expect(readOnly.map((tool) => tool.name)).toEqual(SETTINGS_TOOLS.filter((tool) => tool.class === "read").map((tool) => tool.name));
    expect(await structuredOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: FREE })))).toEqual({ status: "refused" });
    expect((await bodyOf(await endpoint(modern("tools/call", { name: "get_status", arguments: {} })))).result?.isError).toBe(false);
    setAccess(f, { enabled: false });
    expect((await bodyOf(await endpoint(modern("tools/list")))).result?.tools).toEqual([]);
    for (const name of ["get_status", "change_environment"]) {
      const result = (await bodyOf(await endpoint(modern("tools/call", { name, arguments: FREE })))).result;
      expect(result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
      expect(JSON.stringify(result?.content)).toMatch(/Harness panel/);
    }
  });

  it("SPI-1195 review: a tool the owner hid on the Settings server's entry is neither listed nor run, as at the own door", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const hid = applyMcpChange(f.store.load(), { op: "server", server: "settings", toolExposure: { change_environment: "hidden", get_status: "hidden" } });
    if (!hid.ok) throw new Error(hid.error);
    f.store.save(hid.harness);
    const listed = (await bodyOf(await endpoint(modern("tools/list")))).result?.tools as Array<{ name: string }>;
    expect(listed.map((tool) => tool.name)).toEqual(SETTINGS_TOOLS.map((tool) => tool.name).filter((name) => name !== "change_environment" && name !== "get_status"));
    const revision = f.store.loadEnvironment().revision;
    for (const name of ["get_status", "change_environment"]) {
      const result = (await bodyOf(await endpoint(modern("tools/call", { name, arguments: FREE })))).result;
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result?.content)).toContain(`${name} is hidden by the owner.`);
    }
    expect(f.store.loadEnvironment().revision).toBe(revision);
    // The own door refuses the same tools the same way (McpHost.call).
    expect(await f.call(f.durable(), "change_environment", FREE)).toMatchObject({ kind: "unavailable", message: "change_environment is hidden by the owner." });
    expect((await bodyOf(await endpoint(modern("tools/call", { name: "get_settings", arguments: { entity: "environment" } })))).result?.isError).toBe(false);
  });

  it("SPI-1195 review: the server's own exposure hidden hides every tool on both doors, but a tool's own exposure overrides it", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const hid = applyMcpChange(f.store.load(), { op: "server", server: "settings", exposure: "hidden", toolExposure: { get_settings: "direct" } });
    if (!hid.ok) throw new Error(hid.error);
    f.store.save(hid.harness);
    const listed = (await bodyOf(await endpoint(modern("tools/list")))).result?.tools as Array<{ name: string }>;
    expect(listed.map((tool) => tool.name)).toEqual(["get_settings"]);
    for (const name of ["get_status", "change_environment"]) {
      const result = (await bodyOf(await endpoint(modern("tools/call", { name, arguments: FREE })))).result;
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result?.content)).toContain(`${name} is hidden by the owner.`);
      expect(await f.call(f.durable(), name, FREE)).toMatchObject({ kind: "unavailable", message: `${name} is hidden by the owner.` });
    }
    expect(f.store.loadEnvironment().revision).toBe(0);
    expect((await bodyOf(await endpoint(modern("tools/call", { name: "get_settings", arguments: { entity: "environment" } })))).result?.isError).toBe(false);
    expect(await f.call(f.durable(), "get_settings", { entity: "environment" })).toMatchObject({ kind: "result", isError: false });
  });

  it("an unknown tool or arguments that are not an object is -32602", async () => {
    const endpoint = endpointOf(world());
    expect((await bodyOf(await endpoint(modern("tools/call", { name: "resume", arguments: {} })))).error?.code).toBe(-32602);
    expect((await bodyOf(await endpoint(modern("tools/call", { name: "get_status", arguments: [] })))).error?.code).toBe(-32602);
  });

  it("a read runs and a free change applies at once, audited as the Owner client's with its label (unverified) and no subject read back", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const read = (await bodyOf(await endpoint(modern("tools/call", { name: "get_settings", arguments: { entity: "environment" } })))).result;
    expect(read).toMatchObject({ isError: false, structuredContent: { entity: "environment", revision: 0 } });
    expect(await structuredOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: FREE })))).toMatchObject({ status: "applied", revision: 1 });
    const [entry] = f.store.auditLog(1);
    expect(entry).toMatchObject({ via: "mcp", caller: `owner:${SUB}`, tier: "free", client: { name: "claude-code 2.1.322", source: "clientInfo in _meta" } });
    expect(entry).not.toHaveProperty("thread");
    const audit = (await bodyOf(await endpoint(modern("tools/call", { name: "read_audit", arguments: {} })))).result?.structuredContent as { entries: Array<Record<string, unknown>> };
    expect(JSON.stringify(audit)).not.toContain(SUB);
  });

  it("the service token is its own caller, audited as service-token", async () => {
    const f = world();
    await endpointOf(f)(modern("tools/call", { name: "change_environment", arguments: FREE }), { kind: "service-token" });
    expect(f.store.auditLog(1)[0]).toMatchObject({ via: "mcp", caller: "service-token", tier: "free" });
  });

  it("the client label: 2026 _meta, else the session's clientInfo, else User-Agent, cut to 60 characters without control or bidi characters", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const { session } = await initialize(endpoint, "2025-11-25");
    await endpoint(legacy("tools/call", { name: "change_environment", arguments: FREE }, { session }));
    expect(f.store.auditLog(1)[0]?.client).toEqual({ name: "opencode 2.2.7", source: "clientInfo at initialize" });
    await endpoint(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "change_environment", arguments: { expectedRevision: 1, settings: { containerIdleMinutes: 8 } } } }, { headers: { "user-agent": `agent/${"x".repeat(100)}` } }));
    expect(f.store.auditLog(1)[0]?.client).toEqual({ name: `agent/${"x".repeat(54)}`, source: "User-Agent" });
    const hostile = { name: `evil\u202Eclient\u0007${"x".repeat(100)}`, version: "1" };
    await endpoint(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 2, settings: { containerIdleMinutes: 9 } }, _meta: { "io.modelcontextprotocol/clientInfo": hostile } }));
    const label = f.store.auditLog(1)[0]?.client;
    expect(label?.source).toBe("clientInfo in _meta");
    expect(label?.name).toHaveLength(60);
    expect(label?.name).toMatch(/^evilclientx+$/);
  });
});

describe("T-state: capabilities per request (2026) and from the signed session (2025)", () => {
  it("2026: each request's _meta decides; the same client with and without url elicitation gets input_required and then the link", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    expect((await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED })))).result?.resultType).toBe("input_required");
    const formOnly = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED }, { capabilities: { elicitation: {} } })));
    expect(formOnly.result).toMatchObject({ resultType: "complete", structuredContent: { status: "waiting" } });
  });

  it("2025: a session with url elicitation gets the page elicitation; a forged, another identity's, expired or missing session reads as none", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const { session } = await initialize(endpoint, "2025-11-25");
    const forged = `${session.slice(0, -4)}AAAA`;
    const other = (await initialize(endpoint, "2025-11-25", BOTH, { kind: "owner", subject: "someone-else" })).session;
    const expired = await signToken(KEY, { kind: "session", sub: SUB, exp: NOW - 1, protocolVersion: "2025-11-25", elicitation: { form: true, url: true } });
    const wrongKind = await signToken(KEY, { kind: "state", sub: SUB, exp: NOW + 60_000, protocolVersion: "2025-11-25", elicitation: { form: true, url: true } });
    for (const each of [forged, other, expired, wrongKind, undefined]) {
      const response = await endpoint(legacy("tools/call", { name: "get_status", arguments: {} }, each === undefined ? {} : { session: each }));
      expect(response.headers.get("content-type")).toBe("application/json");
      expect((await bodyOf(response)).result?.isError).toBe(false);
    }
    // Asked with each: the link in the result, never a stream.
    for (const each of [forged, other, expired, wrongKind]) {
      const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session: each }));
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await structuredOf(response)).toMatchObject({ status: "waiting" });
    }
    const real = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }));
    expect(real.headers.get("content-type")).toBe("text/event-stream");
    await real.text();
  });

  it("2025-06-18 and older keep no url elicitation in the session, whatever the client declares", async () => {
    const endpoint = endpointOf(world());
    for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const { session } = await initialize(endpoint, version);
      const response = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session, version }));
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await structuredOf(response)).toMatchObject({ status: "waiting" });
    }
  });
});

describe("layout (B): the endpoint's paths (settings/endpointLayout.ts)", () => {
  it("is /_t3flare/mcp; below it is the endpoint's application too, /_t3flare/mcpx is the panel's (M0 P8)", () => {
    expect(SETTINGS_MCP_PATH).toBe("/_t3flare/mcp");
    expect(settingsMcpUrl("t3.example.dev")).toBe(ENDPOINT);
    expect(isSettingsMcpPath("/_t3flare/mcp")).toBe(true);
    expect(isSettingsMcpPath("/_t3flare/mcp/anything")).toBe(true);
    for (const path of ["/_t3flare/mcpx", "/_t3flare/harness", "/_t3flare", "/mcp", "/_t3flare/mc"]) expect(isSettingsMcpPath(path)).toBe(false);
  });

  it("SPI-1195 review: prod is deployed without the endpoint until the owner turns it on, and bump (the t3 bump's) without it; every other stage with it", () => {
    // alchemy.run.ts creates `SettingsAccess`, the admin application's path cookie and `T3FLARE_ACCESS_SETTINGS_AUD` only
    // when `ownerEndpointOn(stage)`; the stack itself needs Cloudflare's providers, so this switch is what is tested.
    expect(OWNER_ENDPOINT_EXCLUDED_STAGES).toEqual(["prod", "bump"]);
    expect(ownerEndpointOn("prod")).toBe(false);
    expect(ownerEndpointOn("bump")).toBe(false);
    for (const stage of ["psettings", "pdev", "dev"]) expect(ownerEndpointOn(stage)).toBe(true);
  });
});
