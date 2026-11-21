// T-clients (ADR-0035's 2026-11-15 refinement, plan D12): an Owner client's Elicitation mode is the owner's setting on the
// Settings page, by caller key and `clientInfo.name`, since Claude Code's OAuth discovery does not survive a query on the
// endpoint's URL. The kept mode decides when the URL names none; `?elicitation_mode=` still overrides; an unknown client
// and a request with no client name are `browser`. Keys are isolated; the table is capped per key and `lastSeen` is
// throttled. Only the panel's CSRF-guarded POST changes a mode: no MCP door, no Settings tool, no other panel route.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { csrfToken } from "../src/harness/csrf.ts";
import { SETTINGS_PAGE_PATH } from "../src/harness/paths.ts";
import { CLIENTS_API_PATH, handleHarness } from "../src/harness/panel.ts";
import { CLIENT_NAME_MAX, CLIENTS_PER_KEY, SEEN_EVERY_MS } from "../src/settings/clients.ts";
import { readAudit } from "../src/harness/ops.ts";
import { MODERN_VERSION } from "../src/settings/endpoint.ts";
import { OWNER_MODE_INSTRUCTIONS, RESUME_TOOL, SETTINGS_TOOLS } from "../src/settings/tools.ts";
import { ASKED, BOTH, bodyOf, CLAUDE_INFO, endpointOf, initialize, legacy, modern, post, SUB } from "./settingsEndpointFixture.ts";
import { HOST, settingsFixture, type SettingsFixture } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
const world = () => {
  fixture = settingsFixture();
  return fixture;
};
afterEach(() => {
  fixture?.dispose();
  vi.restoreAllMocks();
});

const panelHeaders = async (f: SettingsFixture) => ({
  "content-type": "application/json",
  origin: `https://${HOST}`,
  "sec-fetch-site": "same-origin",
  "x-t3flare-csrf": await csrfToken(f.store.csrfKey(), SUB, f.now()),
});

const panelPost = async (f: SettingsFixture, body: unknown, headers?: Record<string, string>, path = CLIENTS_API_PATH) =>
  handleHarness(new Request(`https://${HOST}${path}`, { method: "POST", headers: headers ?? (await panelHeaders(f)), body: JSON.stringify(body) }), f.panel());

const setMode = async (f: SettingsFixture, mode: string, clientName = CLAUDE_INFO.name, key = SUB) => {
  const response = await panelPost(f, { key, clientName, mode });
  expect(response.status).toBe(200);
};

const modeOf = (f: SettingsFixture, clientName = CLAUDE_INFO.name, key = SUB) => f.clients.list().find((entry) => entry.key === key && entry.clientName === clientName)?.mode;

/** A 2026 `tools/list` with this client info (`null`: none); the tools' names. */
const listedBy = async (endpoint: ReturnType<typeof endpointOf>, info: unknown = CLAUDE_INFO, query?: string, caller?: Parameters<ReturnType<typeof endpointOf>>[1]) => {
  const meta: Record<string, unknown> = { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION, "io.modelcontextprotocol/clientCapabilities": BOTH };
  if (info !== null) meta["io.modelcontextprotocol/clientInfo"] = info;
  const request = post(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    { headers: { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list", "user-agent": "claude-code/2.1.322" }, ...(query === undefined ? {} : { query }) },
  );
  const body = await bodyOf(await endpoint(request, caller));
  return ((body.result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
};

describe("the kept mode decides when the URL names none", () => {
  it("records a client at its first request, in browser, keyed by its clientInfo name without the version", async () => {
    const f = world();
    await endpointOf(f)(modern("ping"));
    expect(f.clients.list()).toEqual([{ key: SUB, clientName: "claude-code", mode: "browser", firstSeen: f.now(), lastSeen: f.now() }]);
  });

  it("uses the stored mode with no query: model lists resume and opens a model change; native opens a native one", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    expect(await listedBy(endpoint)).not.toContain(RESUME_TOOL.name);
    await setMode(f, "model");
    expect(await listedBy(endpoint)).toContain(RESUME_TOOL.name);
    await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED }));
    expect(f.deps.changes.open()[0]?.mode).toBe("model");
    await setMode(f, "native");
    const native = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: { expectedRevision: 0, settings: { containerBudget: 6 } } })));
    expect(native.result).toMatchObject({ resultType: "input_required", inputRequests: { change: { params: { mode: "form" } } } });
    expect(f.deps.changes.open().map((record) => String(record.mode)).sort((a, b) => a.localeCompare(b))).toEqual(["model", "native"]);
  });

  it("tells the client its mode in the instructions, naming the panel, not the query", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"));
    await setMode(f, "model");
    const discovered = await bodyOf(await endpoint(modern("server/discover")));
    expect(discovered.result?.instructions).toContain(OWNER_MODE_INSTRUCTIONS.model);
    // The mode may come from the panel or from the query, so the text does not say which.
    expect(OWNER_MODE_INSTRUCTIONS.model).not.toContain("Settings page");
    expect(OWNER_MODE_INSTRUCTIONS.native).not.toContain("elicitation_mode");
  });

  it("an explicit ?elicitation_mode= overrides the kept mode, and a bad one is still 400", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"));
    await setMode(f, "model");
    expect(await listedBy(endpoint, CLAUDE_INFO, "?elicitation_mode=browser")).not.toContain(RESUME_TOOL.name);
    await setMode(f, "browser");
    expect(await listedBy(endpoint, CLAUDE_INFO, "?elicitation_mode=model")).toContain(RESUME_TOOL.name);
    expect((await endpoint(modern("ping", {}, { query: "?elicitation_mode=natve" }))).status).toBe(400);
    // The override is no setting: the kept mode is unchanged.
    expect(modeOf(f)).toBe("browser");
  });

  it("an unknown client is browser, and a request with no client name is browser and recorded nowhere", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"));
    await setMode(f, "model");
    // Another name: its own row, in browser.
    expect(await listedBy(endpoint, { name: "cursor", version: "3" })).not.toContain(RESUME_TOOL.name);
    expect(modeOf(f, "cursor")).toBe("browser");
    // No clientInfo (the User-Agent is a label only, never the key), an empty name, a name of hidden characters only.
    for (const info of [null, { version: "1" }, { name: "" }, { name: "\u200B\u202E" }]) expect(await listedBy(endpoint, info)).not.toContain(RESUME_TOOL.name);
    expect(f.clients.list().map((entry) => entry.clientName).sort((a, b) => a.localeCompare(b))).toEqual(["claude-code", "cursor"]);
  });

  it("a 2025-11-25 session uses the clientInfo name from initialize", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    // initialize records opencode (the fixture's clientInfo) as seen.
    await initialize(endpoint, "2025-11-25");
    expect(modeOf(f, "opencode")).toBe("browser");
    await setMode(f, "model", "opencode");
    const { session, body } = await initialize(endpoint, "2025-11-25");
    expect(body.result.instructions).toContain(OWNER_MODE_INSTRUCTIONS.model);
    const listed = async (withSession: boolean) =>
      (((await bodyOf(await endpoint(legacy("tools/list", {}, withSession ? { session } : {})))).result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    expect(await listed(true)).toContain(RESUME_TOOL.name);
    // No session: no client name, so browser.
    expect(await listed(false)).not.toContain(RESUME_TOOL.name);
    // The session's change is opened in its client's mode.
    await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session }));
    expect(f.deps.changes.open()[0]).toMatchObject({ mode: "model", caller: { client: { name: "opencode 2.2.7" } } });
  });

  it("an open change keeps its mode: after the owner moves the client off native, its retry is refused as other-mode", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"));
    await setMode(f, "native");
    const first = await bodyOf(await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED })));
    const [record] = f.deps.changes.open();
    expect(record?.mode).toBe("native");
    await setMode(f, "browser");
    const retry = await bodyOf(
      await endpoint(modern("tools/call", { name: "change_environment", arguments: ASKED, requestState: first.result?.requestState, inputResponses: { change: { action: "accept" } } }, { id: 2 })),
    );
    expect(retry.result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
    expect(JSON.stringify(retry.result?.content)).toContain("native Elicitation mode");
    expect(f.deps.changes.get(record!.id)?.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });
});

describe("the table: keys isolated, capped per key, lastSeen throttled", () => {
  it("isolates keys: another identity's and the service token's same-named client keep their own mode", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    const other = { kind: "owner" as const, subject: "someone-else" };
    const service = { kind: "service-token" as const };
    await endpoint(modern("ping"));
    await endpoint(modern("ping"), other);
    await endpoint(modern("ping"), service);
    await setMode(f, "model");
    expect(await listedBy(endpoint)).toContain(RESUME_TOOL.name);
    expect(await listedBy(endpoint, CLAUDE_INFO, undefined, other)).not.toContain(RESUME_TOOL.name);
    expect(await listedBy(endpoint, CLAUDE_INFO, undefined, service)).not.toContain(RESUME_TOOL.name);
    await setMode(f, "native", "claude-code", "service-token");
    expect(f.clients.list().map((entry) => [entry.key, entry.mode])).toEqual([
      [SUB, "model"],
      ["service-token", "native"],
      ["someone-else", "browser"],
    ]);
  });

  it(`keeps at most ${CLIENTS_PER_KEY} clients per key, evicting the least recently seen; other keys untouched`, async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"), { kind: "service-token" });
    for (let index = 0; index < CLIENTS_PER_KEY; index++) {
      f.advance(1000);
      f.clients.seen(SUB, `client-${index}`);
    }
    await setMode(f, "model", "client-0");
    // client-0 is seen again past the throttle, so client-1 is now the least recently seen.
    f.advance(SEEN_EVERY_MS);
    f.clients.seen(SUB, "client-0");
    f.advance(1000);
    expect(f.clients.seen(SUB, "a-random-name")).toBe("browser");
    const mine = f.clients.list().filter((entry) => entry.key === SUB);
    expect(mine).toHaveLength(CLIENTS_PER_KEY);
    expect(mine.map((entry) => entry.clientName)).not.toContain("client-1");
    expect(modeOf(f, "client-0")).toBe("model");
    expect(f.clients.list().filter((entry) => entry.key === "service-token")).toHaveLength(1);
  });

  it("evicts the least recently seen browser row first: a flood of names never drops a mode the owner set", async () => {
    const f = world();
    for (let index = 0; index < CLIENTS_PER_KEY; index++) {
      f.advance(1000);
      f.clients.seen(SUB, `client-${index}`);
    }
    // The oldest and the newest rows are the owner's; every other row is browser.
    await setMode(f, "model", "client-0");
    await setMode(f, "native", `client-${CLIENTS_PER_KEY - 1}`);
    for (let index = 0; index < CLIENTS_PER_KEY * 2; index++) {
      f.advance(1000);
      f.clients.seen(SUB, `flood-${index}`);
    }
    const mine = f.clients.list().filter((entry) => entry.key === SUB);
    expect(mine).toHaveLength(CLIENTS_PER_KEY);
    expect(modeOf(f, "client-0")).toBe("model");
    expect(modeOf(f, `client-${CLIENTS_PER_KEY - 1}`)).toBe("native");
    expect(mine.filter((entry) => entry.mode !== "browser").map((entry) => entry.clientName).sort((a, b) => a.localeCompare(b))).toEqual(["client-0", `client-${CLIENTS_PER_KEY - 1}`]);
  });

  it("with no browser row left, evicts the least recently seen of any mode", async () => {
    const f = world();
    for (let index = 0; index < CLIENTS_PER_KEY; index++) {
      f.advance(1000);
      f.clients.seen(SUB, `client-${index}`);
      await setMode(f, "model", `client-${index}`);
    }
    f.advance(1000);
    expect(f.clients.seen(SUB, "newcomer")).toBe("browser");
    const mine = f.clients.list().filter((entry) => entry.key === SUB);
    expect(mine).toHaveLength(CLIENTS_PER_KEY);
    expect(mine.map((entry) => entry.clientName)).not.toContain("client-0");
    expect(modeOf(f, "client-1")).toBe("model");
  });

  it("cuts a name to its maximum and matches it cut", async () => {
    const f = world();
    const long = `x${"y".repeat(CLIENT_NAME_MAX + 20)}`;
    await listedBy(endpointOf(f), { name: long, version: "1" });
    expect(f.clients.list()[0]?.clientName).toBe(long.slice(0, CLIENT_NAME_MAX));
  });

  it("writes lastSeen at most once an hour per client", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"));
    const first = f.now();
    const exec = vi.spyOn(f.sql, "exec");
    f.advance(SEEN_EVERY_MS / 2);
    await endpoint(modern("ping"));
    expect(exec.mock.calls.filter(([query]) => String(query).startsWith("UPDATE"))).toHaveLength(0);
    expect(f.clients.list()[0]).toMatchObject({ firstSeen: first, lastSeen: first });
    f.advance(SEEN_EVERY_MS / 2);
    await endpoint(modern("ping"));
    expect(f.clients.list()[0]).toMatchObject({ firstSeen: first, lastSeen: f.now() });
  });
});

describe("only the panel's CSRF-guarded POST changes a mode", () => {
  it("is refused without the CSRF token, from another origin, cross-site, or as text; then sets it, audited", async () => {
    const f = world();
    await endpointOf(f)(modern("ping"));
    const headers = await panelHeaders(f);
    const { "x-t3flare-csrf": _csrf, ...noCsrf } = headers;
    const body = { key: SUB, clientName: "claude-code", mode: "model" };
    expect((await panelPost(f, body, noCsrf)).status).toBe(403);
    expect((await panelPost(f, body, { ...headers, "x-t3flare-csrf": "forged" })).status).toBe(403);
    expect((await panelPost(f, body, { ...headers, origin: "https://evil.example" })).status).toBe(403);
    expect((await panelPost(f, body, { ...headers, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await panelPost(f, body, { ...headers, "content-type": "text/plain" })).status).toBe(403);
    expect(modeOf(f)).toBe("browser");
    expect((await panelPost(f, body)).status).toBe(200);
    expect(modeOf(f)).toBe("model");
    expect(f.store.auditLog(1)[0]).toMatchObject({ entity: "owner-clients", caller: `owner:${SUB}`, action: "client-mode", target: "claude-code", before: { mode: "browser" }, after: { mode: "model" } });
  });

  it("refuses an unknown client, a bad mode and a malformed body; removes a client, audited", async () => {
    const f = world();
    await endpointOf(f)(modern("ping"));
    expect((await panelPost(f, { key: SUB, clientName: "never-seen", mode: "model" })).status).toBe(404);
    expect((await panelPost(f, { key: SUB, clientName: "claude-code", mode: "Model" })).status).toBe(400);
    expect((await panelPost(f, { clientName: "claude-code", mode: "model" })).status).toBe(400);
    expect((await panelPost(f, { key: SUB, clientName: "x".repeat(CLIENT_NAME_MAX + 1), mode: "model" })).status).toBe(400);
    expect((await panelPost(f, { key: SUB, clientName: "claude-code", remove: true })).status).toBe(200);
    expect(f.clients.list()).toEqual([]);
    expect(f.store.auditLog(1)[0]).toMatchObject({ entity: "owner-clients", action: "client-remove", target: "claude-code", before: { mode: "browser" }, after: null });
    expect((await panelPost(f, { key: SUB, clientName: "claude-code", remove: true })).status).toBe(404);
  });

  it("no MCP door, no Settings tool and no other panel route sets or removes one: a model-mode client cannot promote itself", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"));
    await setMode(f, "model");
    const setModeSpy = vi.spyOn(f.clients, "setMode");
    const removeSpy = vi.spyOn(f.clients, "remove");
    const attempt = { key: SUB, clientName: "claude-code", mode: "native", remove: true, elicitation_mode: "native", expectedRevision: 0 };
    // Every tool of the Owner-client endpoint, `resume` included, with and without the query override.
    for (const tool of [...SETTINGS_TOOLS.map((each) => each.name), RESUME_TOOL.name]) {
      for (const query of [undefined, "?elicitation_mode=native"]) await endpoint(modern("tools/call", { name: tool, arguments: attempt }, query === undefined ? {} : { query }));
    }
    // Every tool of the own agents' door.
    for (const tool of SETTINGS_TOOLS) await f.call(f.durable(), tool.name, attempt);
    // Every other panel POST route, with the same body.
    for (const route of ["/api/extensions", "/api/environment", "/api/mcp", "/api/mcp/test", "/api/mcp/servers", "/api/mcp/oauth", "/api/mcp/secret", "/api/skills/enable", "/api/changes/x"]) {
      await panelPost(f, attempt, undefined, `${SETTINGS_PAGE_PATH}${route}`);
    }
    expect(setModeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(modeOf(f)).toBe("model");
    // The endpoint is given `seen` alone (settingsEndpointFixture.ts, environmentDO.ts): no tool text names the clients table.
    expect(JSON.stringify(SETTINGS_TOOLS)).not.toMatch(/clientName|client mode/i);
  });

  it("the panel shows the plain endpoint URL, each client escaped, its mode selected, and Remove", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await listedBy(endpoint, { name: `<script>alert(1)</script>\u202E`, version: "1" });
    await endpoint(modern("ping"));
    await setMode(f, "native");
    const html = await (await handleHarness(new Request(`https://${HOST}${SETTINGS_PAGE_PATH}`), f.panel())).text();
    expect(html).toContain(`<code>https://${HOST}/_t3flare/mcp</code>`);
    expect(html).not.toContain("/_t3flare/mcp?");
    expect(html).not.toContain("<script>alert(1)");
    // Hidden characters are dropped from a name when it is kept; the rest is escaped.
    expect(html).toContain("<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>");
    expect(html).toMatch(/data-client-mode data-client-key="owner-sub" data-client-name="claude-code"[^>]*><option value="browser">browser<\/option><option value="native" selected>/);
    expect(html).toContain("data-client-remove");
    for (const mode of ["browser", "native", "model"]) expect(html).toContain(`<li><strong>${mode}</strong>: `);
    // `model` is learned at the connect (instructions and the tool list are read once), so a change to or from it needs a reconnect.
    expect(html).toContain("must reconnect after a change to or from <strong>model</strong>");
    const listed = (await (await handleHarness(new Request(`https://${HOST}${CLIENTS_API_PATH}`), f.panel())).json()) as { clients: Array<{ clientName: string }> };
    expect(listed.clients.map((client) => client.clientName)).toContain("claude-code");
  });
});

describe("a 2025 native form answer takes its mode from its session's client name", () => {
  const OPENCODE = "opencode";
  const answerBody = (id: unknown) => ({ jsonrpc: "2.0", id, result: { action: "accept", content: {} } });
  const eventsOf = (text: string): Array<Record<string, unknown>> =>
    text
      .split("\n\n")
      .flatMap((block) => block.split("\n").filter((line) => line.startsWith("data: ")))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

  /** A native-mode client with a 2025-11-25 session, and its change held open on a form (no query anywhere). */
  const asked = async () => {
    const f = world();
    const endpoint = endpointOf(f, { beatMs: 30 });
    const { session } = await initialize(endpoint, "2025-11-25");
    await setMode(f, "native", OPENCODE);
    const held = await endpoint(legacy("tools/call", { name: "change_environment", arguments: ASKED }, { session, id: 7 }));
    expect(held.headers.get("content-type")).toBe("text/event-stream");
    const reader = held.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const ask = eventsOf(text)[0]!;
    const [record] = f.deps.changes.open();
    expect(record).toMatchObject({ mode: "native", state: "open" });
    const answer = (withSession: boolean) => endpoint(post(answerBody(ask.id), { headers: withSession ? { "mcp-session-id": session } : {} }));
    return { f, reader, record: record!, answer };
  };

  it("native on the panel, a session, no query: 202, and the change applies", async () => {
    const { f, reader, record, answer } = await asked();
    const posted = await answer(true);
    expect(posted.status).toBe(202);
    await reader.cancel();
    expect(f.deps.changes.get(record.id)).toMatchObject({ state: "applied", closed: { by: "client" } });
    expect(f.store.loadEnvironment().revision).toBe(1);
  });

  it("the mode moved to browser on the panel: 400 other-mode, and the change stays open", async () => {
    const { f, reader, record, answer } = await asked();
    await setMode(f, "browser", OPENCODE);
    const posted = await answer(true);
    expect(posted.status).toBe(400);
    expect(JSON.stringify(await posted.json())).toContain("this client is in another now");
    await reader.cancel();
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
    expect(f.logs).toContainEqual(expect.objectContaining({ t3flare: "settings-refused", reason: "other-mode" }));
  });

  it("the client's row removed on the panel: 400 other-mode, and the change stays open", async () => {
    const { f, reader, record, answer } = await asked();
    expect((await panelPost(f, { key: SUB, clientName: OPENCODE, remove: true })).status).toBe(200);
    const posted = await answer(true);
    expect(posted.status).toBe(400);
    await reader.cancel();
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
    // The answer's request recorded the client again, in browser: the owner's mode went with the row.
    expect(modeOf(f, OPENCODE)).toBe("browser");
  });

  it("no Mcp-Session-Id: 400 other-mode saying so, and the change stays open", async () => {
    const { f, reader, record, answer } = await asked();
    const posted = await answer(false);
    expect(posted.status).toBe(400);
    const text = JSON.stringify(await posted.json());
    expect(text).toContain("Mcp-Session-Id");
    expect(text).not.toContain("this client is in another now");
    await reader.cancel();
    expect(f.deps.changes.get(record.id)?.state).toBe("open");
    expect(f.store.loadEnvironment().revision).toBe(0);
  });
});

describe("read_audit never carries the owner's Access subject (plan D14)", () => {
  it("after a client-mode change and a client-remove, on the Owner endpoint and the own agents' door", async () => {
    const f = world();
    const endpoint = endpointOf(f);
    await endpoint(modern("ping"));
    await setMode(f, "model");
    await setMode(f, "native");
    expect((await panelPost(f, { key: SUB, clientName: "claude-code", remove: true })).status).toBe(200);
    expect(f.store.auditLog(10).filter((entry) => entry.entity === "owner-clients").map((entry) => entry.action)).toEqual(["client-remove", "client-mode", "client-mode"]);
    // The stored entries carry the client's name and mode only; the subject is only in `caller`, which `read_audit` redacts.
    expect(JSON.stringify(f.store.auditLog(10).map(({ caller: _caller, ...entry }) => entry))).not.toContain(SUB);

    const viaEndpoint = JSON.stringify(await bodyOf(await endpoint(modern("tools/call", { name: "read_audit", arguments: {} }))));
    const viaOwn = JSON.stringify(await f.call(f.durable(), "read_audit", {}));
    for (const read of [viaEndpoint, viaOwn, JSON.stringify(readAudit(f.deps.ops))]) {
      expect(read).toContain("client-remove");
      expect(read).toContain("client-mode");
      expect(read).not.toContain(SUB);
    }
  });
});

describe("the excluded-stage panel (no Owner-client endpoint)", () => {
  it("renders the not-deployed line alone: no URL, no mode meanings, no query note", async () => {
    const f = world();
    const html = await (await handleHarness(new Request(`https://${HOST}${SETTINGS_PAGE_PATH}`), f.panel(undefined, { ownerEndpoint: false }))).text();
    const block = /<details class="tools" open data-owner-clients>[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(block).toContain("The Owner-client endpoint is not deployed on this Environment.");
    expect(html).not.toContain("/_t3flare/mcp");
    expect(block).not.toContain("<li><strong>");
    expect(block).not.toContain("elicitation_mode");
    expect(block).not.toContain("reconnect");
  });
});

describe("only the panel writes a client's mode", () => {
  it("in the sources, the table's setMode and remove are called from harness/panel.ts alone", () => {
    const root = join(import.meta.dirname, "..", "src");
    const files = (dir: string): Array<string> => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
    const called = files(root)
      .filter((file) => /\b[cC]lients\)?\??\.(?:setMode|remove)\b|\bownerClients\([^)]*\)\.(?:setMode|remove)\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1));
    expect(called).toEqual(["harness/panel.ts"]);
    // `setMode` as a name: the table's own module, and the panel that calls it, only (acpFlavor's is another thing).
    const named = files(root)
      .filter((file) => /\bsetMode\b/.test(readFileSync(file, "utf8")) && !file.endsWith("acpFlavor.ts"))
      .map((file) => file.slice(root.length + 1))
      .sort((a, b) => a.localeCompare(b));
    expect(named).toEqual(["harness/panel.ts", "settings/clients.ts"]);
  });
});
