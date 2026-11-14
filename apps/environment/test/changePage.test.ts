// @effect-diagnostics globalDate:off globalConsole:off
// T-page (plan §5; ADR-0034, plan D6, D10), M4 (SPI-1199): the Change page. Every kind of D10's table renders escaped,
// and a hostile value (`<script>`, a bidi control) is inert; the POST's guards; a secret typed on the page reaches the
// secret store and nothing else; a sign-in's authorization URL goes only in the page's own response; the page's CSP is
// hash-only and its script hash matches; the panel lists the Open changes.
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { csrfToken } from "../src/harness/csrf.ts";
import { addMcpServer } from "../src/harness/ops.ts";
import { renderChangePage } from "../src/harness/changePage.ts";
import { CHANGE_SCRIPT } from "../src/harness/changePageScript.ts";
import { CHANGES_API_PATH, changePagePath } from "../src/harness/paths.ts";
import type { AccessCaller } from "../src/access.ts";
import { handleHarness } from "../src/harness/panel.ts";
import { CHANGE_TTL_MS, type ChangeRecord, newChangeId } from "../src/settings/changes.ts";
import type { ChangeItem } from "../src/settings/types.ts";
import { AUTHORIZATION_URL, HOST, NOW, settingsFixture, type SettingsFixture, until } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
afterEach(() => {
  fixture?.dispose();
  vi.restoreAllMocks();
});

const HOSTILE = `<script>alert(1)</script>\u202Eevil'"&`;
const SECRET = "typed-s3cr3t-header-value";
const OWNER: AccessCaller = { kind: "owner", subject: "owner-sub" };

const record = (items: ReadonlyArray<ChangeItem>, extra: Partial<ChangeRecord> = {}): ChangeRecord => ({
  id: newChangeId(),
  entity: "harness",
  expectedRevision: 3,
  tool: "change_mcp",
  args: { expectedRevision: 3, change: { op: "add", server: HOSTILE } },
  hash: "h",
  tier: "asked",
  shown: { entity: "harness", subject: "the MCP server set", revision: 3, appliesAt: HOSTILE, reasons: [HOSTILE], items, lines: [HOSTILE] },
  mode: "card",
  caller: { door: "own", key: "thread-1", principal: "agent", thread: HOSTILE, agent: HOSTILE },
  createdAt: NOW,
  expiresAt: NOW + CHANGE_TTL_MS,
  state: "open",
  ...extra,
});

const EVERY_KIND: ReadonlyArray<ChangeItem> = [
  { kind: "scalar", name: HOSTILE, before: HOSTILE, after: { nested: HOSTILE } },
  { kind: "variables", name: "variables", added: [[HOSTILE, HOSTILE]], changed: [["B", HOSTILE, "x"]], removed: [["C", HOSTILE]] },
  { kind: "text", name: "globalMiseConfig", before: `[tools]\n${HOSTILE}\nnode = "22"`, after: `[tools]\nnode = "24"\n${HOSTILE}` },
  { kind: "mcp-add", server: HOSTILE, url: `https://evil.example/${HOSTILE}`, host: "evil.example", auth: "header", header: HOSTILE },
  { kind: "mcp-remove", server: HOSTILE, url: `https://x.example/${HOSTILE}` },
  { kind: "header-value", server: HOSTILE, header: HOSTILE, set: true },
  { kind: "sign-in", server: HOSTILE, url: `https://x.example/${HOSTILE}` },
  {
    kind: "skills",
    op: "install",
    source: HOSTILE,
    repo: "o/r",
    ref: HOSTILE,
    commit: "a".repeat(40),
    skills: [{ name: HOSTILE, description: HOSTILE, path: "skills/a", files: 2, bytes: 10, digest: "d".repeat(64), skillMd: `---\nname: a\n---\n${HOSTILE}`, paths: ["SKILL.md", HOSTILE], problems: [HOSTILE] }],
  },
  { kind: "skill", op: "remove", name: HOSTILE, repo: "o/r", commit: "b".repeat(40) },
];

/** Every `<script` in `html`: only the page's own, once. */
const scripts = (html: string) => html.match(/<script/gi) ?? [];

describe("the Change page renders every kind escaped, a hostile value inert", () => {
  it("each kind of D10's table", () => {
    const html = renderChangePage(record(EVERY_KIND, { needsPage: "secret" }), { csrf: "tok", now: NOW });
    expect(scripts(html)).toHaveLength(1);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // A bidi override is shown, never applied.
    expect(html).not.toContain("\u202E");
    expect(html).toContain("\\u{202e}");
    // The variables table, the line diff, the URL's host set apart, the password field, the skill's SKILL.md and links.
    expect(html).toContain(">added<");
    expect(html).toContain('<span class="del">- node = &quot;22&quot;</span>');
    expect(html).toContain('<span class="add">+ node = &quot;24&quot;</span>');
    expect(html).toContain('<span class="url-host">evil.example</span>');
    expect(html).toContain('type="password" autocomplete="off"');
    expect(html).toContain(`https://github.com/o/r/blob/${"a".repeat(40)}/skills/a/SKILL.md`);
    expect(html).toContain("name: a");
    expect(html).toContain("Remove the Environment skill");
    expect(html).toContain('data-action="approve"');
    // No attribute is opened by a value.
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
  });

  it("a closed change shows its outcome and no answer; an unknown id is gone", async () => {
    const closed = renderChangePage(record(EVERY_KIND.slice(0, 1), { state: "declined", closed: { at: NOW, by: "card" } }), { csrf: "", now: NOW });
    expect(closed).toContain("Declined");
    expect(closed).not.toContain('data-action="approve"');
    fixture = settingsFixture();
    const response = await handleHarness(new Request(`https://${HOST}${changePagePath(newChangeId())}`), fixture.panel());
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This change is gone");
    const bad = await handleHarness(new Request(`https://${HOST}/_t3flare/harness/changes/chg_short%3Cscript%3E`), fixture.panel());
    expect(bad.status).toBe(404);
  });
});

describe("the Change page's POST", () => {
  const post = async (run: SettingsFixture, id: string, body: unknown, headers: Record<string, string>, caller: AccessCaller = OWNER) =>
    handleHarness(new Request(`https://${HOST}${CHANGES_API_PATH}/${id}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), run.panel(caller));
  const good = async (run: SettingsFixture) => ({
    "content-type": "application/json",
    origin: `https://${HOST}`,
    "sec-fetch-site": "same-origin",
    "x-t3flare-csrf": await csrfToken(run.store.csrfKey(), "owner-sub", run.now()),
  });

  it("is refused without JSON, with a wrong Origin, without the CSRF token, and for a GET; then answers", async () => {
    fixture = settingsFixture({ answer: () => new Promise(() => undefined) });
    const run = fixture;
    void run.call(run.durable(), "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } });
    await until(() => run.cards.length === 1);
    const [open] = run.deps.changes.open();
    const id = open!.id;
    const headers = await good(run);
    expect((await post(run, id, { action: "approve" }, { ...headers, "content-type": "text/plain" })).status).toBe(403);
    expect((await post(run, id, { action: "approve" }, { ...headers, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(run, id, { action: "approve" }, { ...headers, "sec-fetch-site": "cross-site" })).status).toBe(403);
    const { "x-t3flare-csrf": _csrf, ...noCsrf } = headers;
    expect((await post(run, id, { action: "approve" }, noCsrf)).status).toBe(403);
    expect((await handleHarness(new Request(`https://${HOST}${CHANGES_API_PATH}/${id}?action=approve`), run.panel())).status).toBe(404);
    expect((await post(run, id, { action: "maybe" }, headers)).status).toBe(400);
    // The service token answers its own changes only, never an agent's.
    expect((await post(run, id, { action: "approve" }, { "content-type": "application/json" }, { kind: "service-token" })).status).toBe(403);
    expect(run.store.loadEnvironment().revision).toBe(0);
    expect(run.deps.changes.get(id)?.state).toBe("open");
    const answered = await post(run, id, { action: "approve" }, headers);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ status: "applied", revision: 1 });
    expect((await post(run, id, { action: "decline" }, headers)).status).toBe(409);
  });

  it("a secret typed on the page reaches the secret store and appears in no response, log line, audit entry or record", async () => {
    fixture = settingsFixture({ answer: { decision: "accept" } });
    const run = fixture;
    const lines: Array<string> = [];
    vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => void lines.push(args.map(String).join(" ")));
    await addMcpServer(run.deps.ops, { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "old-value" }, { actor: { caller: "owner:o" } });
    const pending = run.call(run.durable(), "change_mcp", { expectedRevision: 1, change: { op: "header-value", server: "keyed" } });
    await until(() => run.cards.length === 1);
    const [open] = run.deps.changes.open();
    const page = await handleHarness(new Request(`https://${HOST}${changePagePath(open!.id)}`), run.panel());
    const pageHtml = await page.text();
    expect(pageHtml).toContain('name="value"');
    const headers = await good(run);
    // Without the value it is refused, and nothing is stored.
    expect((await post(run, open!.id, { action: "approve" }, headers)).status).toBe(400);
    const answered = await post(run, open!.id, { action: "approve", value: SECRET }, headers);
    const answerText = await answered.text();
    expect(answered.status).toBe(200);
    const result = await pending;
    expect(run.secrets.read("keyed", "header")).toBe(SECRET);
    for (const text of [pageHtml, answerText, JSON.stringify(result), JSON.stringify(run.logs), lines.join("\n"), JSON.stringify(run.store.auditLog(50)), JSON.stringify(run.deps.changes.get(open!.id)), JSON.stringify(run.cards)]) {
      expect(text).not.toContain(SECRET);
    }
    expect(run.store.auditLog(1)[0]).toMatchObject({ action: "mcp.secret.set", answeredBy: "page", tier: "asked" });
    expect(result).toMatchObject({ kind: "result", structured: { status: "applied" } });
  });

  it("a sign-in's authorization URL goes only in the page's own response", async () => {
    fixture = settingsFixture({ answer: { decision: "accept" } });
    const run = fixture;
    const lines: Array<string> = [];
    vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => void lines.push(args.map(String).join(" ")));
    await addMcpServer(run.deps.ops, { server: "oauthy", url: "https://oauthy.example/mcp", auth: { kind: "oauth" } }, { actor: { caller: "owner:o" } });
    const pending = run.call(run.durable(), "start_mcp_sign_in", { expectedRevision: 1, server: "oauthy" });
    await until(() => run.cards.length === 1);
    const [open] = run.deps.changes.open();
    const answered = await post(run, open!.id, { action: "approve" }, await good(run));
    expect(await answered.json()).toEqual({ status: "applied", revision: 1, authorizationUrl: AUTHORIZATION_URL });
    expect(run.begun).toEqual(["oauthy"]);
    const result = await pending;
    expect(result).toMatchObject({ kind: "result", structured: { status: "applied" } });
    for (const text of [JSON.stringify(result), JSON.stringify(run.logs), lines.join("\n"), JSON.stringify(run.store.auditLog(50)), JSON.stringify(run.deps.changes.get(open!.id)), JSON.stringify(run.cards)]) {
      expect(text).not.toContain("auth.example");
      expect(text).not.toContain("s3cr3t-state");
    }
  });

  it("SPI-1195 review: a failed sign-in's error quoting a URL with ?key= is kept, logged and answered without the query", async () => {
    fixture = settingsFixture({ answer: { decision: "accept" } });
    const run = fixture;
    const lines: Array<string> = [];
    vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => void lines.push(args.map(String).join(" ")));
    await addMcpServer(run.deps.ops, { server: "oauthy", url: "https://oauthy.example/mcp", auth: { kind: "oauth" } }, { actor: { caller: "owner:o" } });
    run.oauth.begin = async () => ({ ok: false, error: "discovery failed at https://oauthy.example/.well-known/oauth-authorization-server?key=k3y-s3cr3t" }) as never;
    const pending = run.call(run.durable(), "start_mcp_sign_in", { expectedRevision: 1, server: "oauthy" });
    await until(() => run.cards.length === 1);
    const [open] = run.deps.changes.open();
    const answered = await post(run, open!.id, { action: "approve" }, await good(run));
    const answerText = await answered.text();
    const result = await pending;
    const record = run.deps.changes.get(open!.id);
    expect(record?.state).toBe("failed");
    expect(record?.closed?.error).toContain("https://oauthy.example/.well-known/oauth-authorization-server");
    for (const text of [answerText, JSON.stringify(result), JSON.stringify(run.logs), lines.join("\n"), JSON.stringify(record), JSON.stringify(run.deps.changes.closedBy("own:thread-d", 0))]) {
      expect(text).not.toContain("k3y-s3cr3t");
    }
  });
});

describe("the Change page's CSP and the panel's list", () => {
  it("is hash-only, and its script hash matches the script", async () => {
    fixture = settingsFixture({ answer: () => new Promise(() => undefined) });
    const run = fixture;
    void run.call(run.durable(), "change_environment", { expectedRevision: 0, settings: { containerBudget: 4 } });
    await until(() => run.cards.length === 1);
    const [open] = run.deps.changes.open();
    const response = await handleHarness(new Request(`https://${HOST}${changePagePath(open!.id)}`), run.panel());
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    const hash = createHash("sha256").update(CHANGE_SCRIPT).digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toMatch(/script-src[^;]*'self'/);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain(`<script>${CHANGE_SCRIPT}</script>`);
    expect(CHANGE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    // The panel lists it, linking to its page, and so does its API.
    const panel = await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness`), run.panel())).text();
    expect(panel).toContain('id="changes"');
    expect(panel).toContain(changePagePath(open!.id));
    const listed = (await (await handleHarness(new Request(`https://${HOST}/_t3flare/harness/api/changes`), run.panel())).json()) as { changes: Array<Record<string, unknown>> };
    expect(listed.changes).toMatchObject([{ changeId: open!.id, thread: "thread-d", agent: "piDurable", url: `https://${HOST}${changePagePath(open!.id)}` }]);
  });
});
