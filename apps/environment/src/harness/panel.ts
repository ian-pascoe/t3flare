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
import { applyChange, EXTENSIONS, type HarnessChange, resolveHarness } from "@t3flare/harness-registry";

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
  readonly now?: () => number;
}

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
    "MCP servers": "parts 2-4 (after SPI-992)",
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
      const html = renderPage({ resolved: resolveHarness(deps.store.load()), csrf, audit: deps.store.auditLog(50), status: statusOf(deps) });
      return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": await pageCsp() } });
    }
    if (path === `${HARNESS_PATH}/api/settings`) {
      const stored = deps.store.load();
      return json({ revision: stored.revision, resolved: resolveHarness(stored), registry: EXTENSIONS, stored });
    }
    if (path === `${HARNESS_PATH}/api/status`) return json(statusOf(deps));
    if (path === `${HARNESS_PATH}/api/audit`) return json({ entries: deps.store.auditLog(50) });
    return refused(404, "Not found");
  }
  if (request.method !== "POST") return refused(405, "Method not allowed");
  if (path !== `${HARNESS_PATH}/api/extensions`) return refused(404, "Not found");
  const why = await unsafeWrite(request, deps);
  if (why !== undefined) {
    console.log(JSON.stringify({ t3flare: "harness-refused", reason: why, caller: deps.caller.kind }));
    return refused(403, why);
  }
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
