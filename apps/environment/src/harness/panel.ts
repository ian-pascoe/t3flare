// @effect-diagnostics globalDate:off globalConsole:off
// The harness panel's routes (ADR-0026, plan §6 with review H4): the page and its JSON API, reached only through the
// Environment Worker's `HarnessAdmin` entrypoint on the dedicated admin host (worker.ts), which has verified Access
// before this runs. Pure over its deps, so the safety rules are tested without a Worker:
//
// - `GET` never changes state. A change is a `POST` with `Content-Type: application/json` (a form post from elsewhere is
//   refused before anything else), an `Origin` (when sent) equal to the configured admin host, never the request's, and
//   `Sec-Fetch-Site` (when sent) `same-origin`.
// - The owner in a browser (Access assertion, no admin token) must also send the page's CSRF token (csrf.ts). A script
//   (the stage's service token plus the admin token, checked by worker.ts) sends no cookie a page could ride, so it
//   needs none.
// - Every change is validated against the registry, bumps the revision, and is written to the audit log.
import { applyChange, applyMcpChange, EXTENSIONS, type HarnessChange, type McpChange, resolveHarness } from "@t3flare/harness-registry";

import type { McpHost } from "../mcp/host.ts";
import type { HarnessOAuth } from "./oauth.ts";
import type { HarnessSecrets } from "./secrets.ts";

import { csrfToken, csrfValid } from "./csrf.ts";
import { pageCsp, renderPage } from "./page.ts";
import type { HarnessStore } from "./store.ts";

export const HARNESS_PATH = "/_t3flare/harness";
export const CSRF_HEADER = "x-t3flare-csrf";

/** Who the admin entrypoint admitted. */
export type HarnessCaller = { readonly kind: "owner"; readonly subject: string } | { readonly kind: "service-token" };

export interface HarnessDeps {
  readonly caller: HarnessCaller;
  /** The admin host as configured (`T3FLARE_HARNESS_HOST`): what `Origin` must name. */
  readonly host: string;
  readonly store: HarnessStore;
  /** The MCP host (ADR-0028): the servers' inventories and their test. */
  readonly mcp?: Pick<McpHost, "servers" | "inventory" | "tools" | "list">;
  /** Direct servers' write-only secrets (part 4). */
  readonly secrets?: HarnessSecrets;
  /** OAuth sign-ins (review M4). */
  readonly oauth?: Pick<HarnessOAuth, "begin" | "status" | "forget">;
  readonly now?: () => number;
}

/** The MCP server set as the panel shows it: settings (no secret), inventory state, tools with classes. */
export const mcpOverview = async (deps: HarnessDeps) => {
  if (deps.mcp === undefined) return [];
  const rows = [];
  for (const [name, server] of Object.entries(deps.mcp.servers())) {
    const inventory = deps.mcp.inventory(name);
    const { tools, refused } = await deps.mcp.tools(name, server, inventory);
    rows.push({
      name,
      setting: server,
      ...(server.auth?.kind === "header" && deps.secrets !== undefined ? { secret: deps.secrets.mark(name, "header") } : {}),
      ...(server.auth?.kind === "oauth" && deps.oauth !== undefined ? { oauth: deps.oauth.status(name) } : {}),
      status: inventory.status,
      listedAt: inventory.listedAt > 0 ? inventory.listedAt : null,
      error: inventory.error ?? null,
      tools: tools.map(({ inputSchema: _schema, ...tool }) => tool),
      refused,
    });
  }
  return rows;
};

export const isHarnessPath = (pathname: string) => pathname === HARNESS_PATH || pathname.startsWith(`${HARNESS_PATH}/`);

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: SECURITY_HEADERS });
const refused = (status: number, reason: string) => new Response(`${reason}\n`, { status, headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" } });

const callerName = (caller: HarnessCaller) => (caller.kind === "owner" ? `owner:${caller.subject}` : "service-token");

const statusOf = (deps: HarnessDeps) => {
  const stored = deps.store.load();
  const read = deps.store.lastRead();
  return {
    "settings revision": stored.revision,
    "last taken by a Session (revision)": read?.revision ?? null,
    "last taken by a Session (at)": read === undefined ? null : new Date(read.at).toISOString(),
    Skills: "deferred (SPI-1001)",
  };
};

/** Why a state-changing request is refused before its body is read, or undefined. */
const unsafeWrite = async (request: Request, deps: HarnessDeps): Promise<string | undefined> => {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return "a change is JSON (Content-Type: application/json)";
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== `https://${deps.host}`) return "wrong origin";
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return "not same-origin";
  if (deps.caller.kind === "owner") {
    if (origin === null) return "a browser change needs its Origin";
    const now = deps.now?.() ?? Date.now();
    if (!(await csrfValid(deps.store.csrfKey(), deps.caller.subject, request.headers.get(CSRF_HEADER), now))) return "bad CSRF token";
  }
  return undefined;
};

/** The panel's answer to `request`. */
export const handleHarness = async (request: Request, deps: HarnessDeps): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET") {
    if (path === HARNESS_PATH || path === `${HARNESS_PATH}/`) {
      const subject = deps.caller.kind === "owner" ? deps.caller.subject : "";
      const csrf = subject === "" ? "" : await csrfToken(deps.store.csrfKey(), subject, deps.now?.() ?? Date.now());
      const html = renderPage({ resolved: resolveHarness(deps.store.load()), csrf, audit: deps.store.auditLog(50), status: statusOf(deps), mcp: await mcpOverview(deps) });
      return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": await pageCsp() } });
    }
    if (path === `${HARNESS_PATH}/api/settings`) {
      const stored = deps.store.load();
      return json({ revision: stored.revision, resolved: resolveHarness(stored), registry: EXTENSIONS, stored });
    }
    if (path === `${HARNESS_PATH}/api/status`) return json(statusOf(deps));
    if (path === `${HARNESS_PATH}/api/mcp`) return json({ servers: await mcpOverview(deps) });
    if (path === `${HARNESS_PATH}/api/audit`) return json({ entries: deps.store.auditLog(50) });
    return refused(404, "Not found");
  }
  if (request.method !== "POST") return refused(405, "Method not allowed");
  const routes = [`${HARNESS_PATH}/api/extensions`, `${HARNESS_PATH}/api/mcp`, `${HARNESS_PATH}/api/mcp/test`, `${HARNESS_PATH}/api/mcp/servers`, `${HARNESS_PATH}/api/mcp/oauth`];
  if (!routes.includes(path)) return refused(404, "Not found");
  const why = await unsafeWrite(request, deps);
  if (why !== undefined) {
    console.log(JSON.stringify({ t3flare: "harness-refused", reason: why, caller: deps.caller.kind }));
    return refused(403, why);
  }
  if (path === `${HARNESS_PATH}/api/mcp/test`) return testServer(request, deps);
  if (path === `${HARNESS_PATH}/api/mcp`) return changeMcp(request, deps);
  if (path === `${HARNESS_PATH}/api/mcp/servers`) return addServer(request, deps);
  if (path === `${HARNESS_PATH}/api/mcp/oauth`) return beginOAuth(request, deps);
  let change: HarnessChange;
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body) || typeof (body as { extension?: unknown }).extension !== "string") throw new Error("shape");
    change = body as HarnessChange;
  } catch {
    return refused(400, "the body is one change: { extension, enabled?, settings? }");
  }
  const before = deps.store.load();
  const applied = applyChange(before, change);
  if (!applied.ok) return refused(400, applied.error);
  deps.store.save(applied.harness);
  deps.store.audit({
    at: deps.now?.() ?? Date.now(),
    caller: callerName(deps.caller),
    action: "extension.change",
    target: change.extension,
    before: before.global.extensions?.[change.extension] ?? null,
    after: applied.harness.global.extensions?.[change.extension] ?? null,
  });
  return json({ ok: true, revision: applied.harness.revision, resolved: resolveHarness(applied.harness) });
};

const bodyOf = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The panel's "test": lists the server now, from the MCP Worker, and shows what came back. */
const testServer = async (request: Request, deps: HarnessDeps): Promise<Response> => {
  const body = await bodyOf(request);
  const server = typeof body?.server === "string" ? body.server : "";
  if (deps.mcp === undefined || deps.mcp.servers()[server] === undefined) return refused(404, "no such server");
  const started = deps.now?.() ?? Date.now();
  const inventory = await deps.mcp.list(server);
  deps.store.audit({ at: started, caller: callerName(deps.caller), action: "mcp.test", target: server, after: { status: inventory.status } });
  return json({ server, status: inventory.status, error: inventory.error ?? null, tools: Object.keys(inventory.definitions).length, refused: inventory.refused.length, ms: (deps.now?.() ?? Date.now()) - started });
};

/** One change to the MCP server set (enable, Exposure, the linked switch, a tool's class, remove). */
const changeMcp = async (request: Request, deps: HarnessDeps): Promise<Response> => {
  const body = await bodyOf(request);
  if (body === undefined || typeof body.op !== "string" || typeof body.server !== "string") return refused(400, "the body is one change: { op, server, … }");
  // A direct server is added with its secret through its own route (part 4); here only what holds no secret.
  if (body.op === "add") return refused(400, "add a server through /api/mcp/servers");
  const before = deps.store.load();
  const applied = applyMcpChange(before, body as unknown as McpChange);
  if (!applied.ok) return refused(400, applied.error);
  deps.store.save(applied.harness);
  // A removed server's secrets go at once (plan §6.2).
  if (body.op === "remove") {
    deps.secrets?.remove(body.server, ["header"]);
    deps.oauth?.forget(body.server);
  }
  deps.store.audit({
    at: deps.now?.() ?? Date.now(),
    caller: callerName(deps.caller),
    action: `mcp.${body.op}`,
    target: body.op === "class" ? `${body.server}/${String(body.tool)}` : body.server,
    before: before.mcp?.servers?.[body.server] ?? null,
    after: applied.harness.mcp?.servers?.[body.server] ?? null,
  });
  return json({ ok: true, revision: applied.harness.revision });
};

/**
 * Adds a direct server (Route B, decision (b)): its name, URL and sign-in, and for a header sign-in the value, stored
 * write-only. The answer and the audit log carry `set`, `setAt` and a fingerprint, never the value.
 */
const addServer = async (request: Request, deps: HarnessDeps): Promise<Response> => {
  const body = await bodyOf(request);
  const server = typeof body?.server === "string" ? body.server : "";
  const url = typeof body?.url === "string" ? body.url : "";
  const auth = (body?.auth ?? { kind: "none" }) as { kind?: unknown; header?: unknown };
  const value = typeof body?.value === "string" ? body.value : undefined;
  if (auth.kind === "header" && (value === undefined || value === "")) return refused(400, "a header sign-in needs its value");
  if (deps.secrets === undefined) return refused(500, "no secret store");
  const before = deps.store.load();
  const applied = applyMcpChange(before, { op: "add", server, url, auth: auth.kind === "header" ? { kind: "header", header: String(auth.header) } : auth.kind === "oauth" ? { kind: "oauth" } : { kind: "none" } });
  if (!applied.ok) return refused(400, applied.error);
  const mark = auth.kind === "header" && value !== undefined ? await deps.secrets.put(server, "header", value) : undefined;
  deps.store.save(applied.harness);
  deps.store.audit({
    at: deps.now?.() ?? Date.now(),
    caller: callerName(deps.caller),
    action: "mcp.add",
    target: server,
    after: { ...applied.harness.mcp?.servers?.[server], ...(mark === undefined ? {} : { secret: mark }) },
  });
  return json({ ok: true, revision: applied.harness.revision, ...(mark === undefined ? {} : { secret: mark }) });
};

/**
 * Starts an OAuth sign-in for a direct server added with `auth: oauth` (review M4): the URL the owner's browser opens.
 * The server's authorization server sends the browser back to the public callback (oauth.ts).
 */
const beginOAuth = async (request: Request, deps: HarnessDeps): Promise<Response> => {
  const body = await bodyOf(request);
  const server = typeof body?.server === "string" ? body.server : "";
  const setting = deps.mcp?.servers()[server];
  if (setting === undefined || setting.kind !== "direct" || setting.url === undefined) return refused(404, "no such direct server");
  if (setting.auth?.kind !== "oauth") return refused(400, `${server} does not sign in with OAuth`);
  if (deps.oauth === undefined) return refused(500, "no OAuth");
  const begun = await deps.oauth.begin(server, setting.url);
  if (!begun.ok) return refused(502, `the sign-in could not start: ${begun.error}`);
  deps.store.audit({ at: deps.now?.() ?? Date.now(), caller: callerName(deps.caller), action: "mcp.oauth.start", target: server, after: { registration: begun.value.registration } });
  return json({ ok: true, authorizationUrl: begun.value.authorizationUrl });
};
