// @effect-diagnostics globalDate:off globalConsole:off
// The harness panel's routes (ADR-0026, plan §6): the page and its JSON API at `/_t3flare/harness` on the t3 host, behind
// the `/_t3flare` Access application (worker.ts verifies it before this runs; owner, 2026-11-12, back to stock: no admin
// host). Pure over its deps, so the safety rules are tested without a Worker:
//
// - `GET` never changes state. A change is a `POST` with `Content-Type: application/json` (a form post from elsewhere is
//   refused before anything else), an `Origin` (when sent) equal to the configured t3 host (`T3FLARE_HOST`), never the request's, and
//   `Sec-Fetch-Site` (when sent) `same-origin`.
// - The owner in a browser (Access assertion, no admin token) must also send the page's CSRF token (csrf.ts). A script
//   (the stage's service token plus the admin token, checked by worker.ts) sends no cookie a page could ride, so it
//   needs none.
// - Every change is validated against the registry, bumps its entity's revision (the Harness settings' or the
//   Environment settings', ADR-0032), and is written to the audit log with its entity. The changes themselves are the
//   transport-free ops (ops.ts, plan D1); this file parses a request into one and answers its outcome. A body may carry
//   `expectedRevision` (plan D15): a moved revision is refused with 409.
import { describeGlobalMise, ENVIRONMENT_SETTINGS, EXTENSIONS, type HarnessChange, ignoredServersOf, type McpChange, resolveEnvironment, resolveHarness } from "@t3flare/harness-registry";

import type { McpHost } from "../mcp/host.ts";
import type { HarnessOAuth } from "./oauth.ts";
import type { HarnessSecrets } from "./secrets.ts";

import { SKILLS_WRITE_ROUTES, type SkillsAnswer, type SkillsApiDeps, skillsOverview, viewSkill } from "../skills/api.ts";
import { ENDPOINTS_PATHS, endpointsChange, endpointsDiscover, type EndpointsAnswer, type EndpointsApiDeps, endpointsOverview } from "../endpoints/api.ts";
import { containerCostTable } from "./containerCost.ts";
import { csrfToken, csrfValid } from "./csrf.ts";
import {
  type AddServer,
  addMcpServer,
  beginMcpSignIn,
  changeEnvironment,
  changeExtension,
  changeMcp,
  changeSkills,
  type OpOptions,
  type OpsDeps,
  type Outcome,
  setMcpHeader,
  testMcpServer,
} from "./ops.ts";
import { pageCsp, renderPage } from "./page.ts";
import type { AuditActor, HarnessStore } from "./store.ts";

export const HARNESS_PATH = "/_t3flare/harness";
export const CSRF_HEADER = "x-t3flare-csrf";

/** Who the admin entrypoint admitted. */
export type HarnessCaller = { readonly kind: "owner"; readonly subject: string } | { readonly kind: "service-token" };

export interface HarnessDeps {
  readonly caller: HarnessCaller;
  /** The t3 host as configured (`T3FLARE_HOST`): what `Origin` must name. */
  readonly host: string;
  readonly store: HarnessStore;
  /** The MCP host (ADR-0028): the servers' inventories and their test. */
  readonly mcp?: Pick<McpHost, "servers" | "inventory" | "tools" | "list" | "forget">;
  /** Direct servers' write-only secrets (part 4). */
  readonly secrets?: HarnessSecrets;
  /** OAuth sign-ins (review M4). */
  readonly oauth?: Pick<HarnessOAuth, "begin" | "status" | "forget">;
  readonly now?: () => number;
  /** The Container budget DO's state (ADR-0032): its leases, each with the Workspace that holds it when known. */
  readonly budget?: () => Promise<{ readonly max: number; readonly leases: ReadonlyArray<{ readonly holder: string; readonly workspace?: string | null }> }>;
  /** The Environment skills (SPI-1148): their store and GitHub reads. */
  readonly skills?: Omit<SkillsApiDeps, "caller" | "now">;
  /** The Model endpoints (SPI-1162): their store, their model lists' read, and who to tell of a change. */
  readonly endpoints?: EndpointsApiDeps;
}

/** The Containers running now, by their Workspaces (a holder's DO id when its Workspace is unknown); null without the budget. */
export const runningContainers = async (deps: Pick<HarnessDeps, "budget">): Promise<{ readonly count: number; readonly holders: ReadonlyArray<string> } | null> => {
  if (deps.budget === undefined) return null;
  try {
    const { leases } = await deps.budget();
    return { count: leases.length, holders: leases.map((lease) => lease.workspace ?? lease.holder) };
  } catch {
    return null;
  }
};

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
      overrides: Object.fromEntries(Object.entries(server.classes ?? {}).filter(([, value]) => value === "read" || value === "write")),
      toolExposure: server.toolExposure ?? {},
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

/** The panel's Status (the Settings server's `get_status` reads it too). */
export const harnessStatus = (deps: Pick<HarnessDeps, "store" | "skills">) => {
  const stored = deps.store.load();
  const ignored = ignoredServersOf(stored);
  const read = deps.store.lastRead();
  const environmentRead = deps.store.lastEnvironmentRead();
  const globalMise = deps.store.lastGlobalMise();
  return {
    "settings revision": stored.revision,
    "last taken by a Session (revision)": read?.revision ?? null,
    "last taken by a Session (at)": read === undefined ? null : new Date(read.at).toISOString(),
    "Environment settings revision": deps.store.loadEnvironment().revision,
    "last taken by a Workspace (revision)": environmentRead?.revision ?? null,
    "last taken by a Workspace (at)": environmentRead === undefined ? null : new Date(environmentRead.at).toISOString(),
    // The last lay-down across all Workspaces (SPI-1150, ADR-0032's Global mise config refinement): a file not laid down shows here.
    "last Global mise lay-down": globalMise === undefined ? null : describeGlobalMise(globalMise),
    Skills: skillsStatus(deps),
    "last Environment skill set refused": latestRefusal(deps) ?? null,
    // A server stored under the Settings server's reserved name or kind (plan D2): ignored until the next MCP change drops it.
    ...(ignored.length === 0 ? {} : { "ignored MCP servers": `${ignored.join(", ")}: stored under a name or kind reserved for the Settings server; add again under another name` }),
  };
};

/** Status's word on skills: Repo skills, and the Environment skills kept, enabled and their set's hash. */
const skillsStatus = (deps: Pick<HarnessDeps, "skills">): string => {
  if (deps.skills === undefined) return "Repo skills on (SPI-1147)";
  const { totals, hash } = skillsOverview(deps.skills);
  return `Repo skills on; ${totals.count} Environment ${totals.count === 1 ? "skill" : "skills"}, ${totals.enabled} enabled, set ${hash.slice(0, 12)}`;
};

/** The latest Workspace refusal of the Environment skill set (plan §4.5), as one line. */
const latestRefusal = (deps: Pick<HarnessDeps, "skills">): string | undefined => {
  const refusal = deps.skills?.store.refusals().at(-1);
  return refusal === undefined ? undefined : `${refusal.workspace} at ${new Date(refusal.at).toISOString()}: ${refusal.message}`;
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
      const environment = resolveEnvironment(deps.store.loadEnvironment());
      const html = renderPage({
        resolved: resolveHarness(deps.store.load()),
        environment,
        costs: containerCostTable(environment.containerBudget),
        running: await runningContainers(deps),
        csrf,
        audit: deps.store.auditLog(50),
        status: harnessStatus(deps),
        mcp: await mcpOverview(deps),
        ...(deps.skills === undefined ? {} : { skills: skillsOverview(deps.skills) }),
        ...(deps.endpoints === undefined ? {} : { endpoints: await endpointsOverview(deps.endpoints) }),
      });
      return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": await pageCsp() } });
    }
    if (path === `${HARNESS_PATH}/api/settings`) {
      const stored = deps.store.load();
      return json({ revision: stored.revision, resolved: resolveHarness(stored), registry: EXTENSIONS, stored });
    }
    if (path === `${HARNESS_PATH}/api/environment`) {
      const stored = deps.store.loadEnvironment();
      const resolved = resolveEnvironment(stored);
      return json({ revision: stored.revision, resolved, schema: ENVIRONMENT_SETTINGS, costs: containerCostTable(resolved.containerBudget), running: await runningContainers(deps), stored });
    }
    if (path === `${HARNESS_PATH}/api/status`) return json(harnessStatus(deps));
    if (path === `${HARNESS_PATH}/api/mcp`) return json({ servers: await mcpOverview(deps) });
    if (path === `${HARNESS_PATH}/api/audit`) return json({ entries: deps.store.auditLog(50) });
    if (path === `${HARNESS_PATH}/api/skills` && deps.skills !== undefined) return json(skillsOverview(deps.skills));
    if (path === `${HARNESS_PATH}/api/skills/view` && deps.skills !== undefined) return skillsResponse(viewSkill(deps.skills, url.searchParams.get("name") ?? ""));
    if (path === `${HARNESS_PATH}${ENDPOINTS_PATHS.list}` && deps.endpoints !== undefined) return json(await endpointsOverview(deps.endpoints));
    return refused(404, "Not found");
  }
  if (request.method !== "POST") return refused(405, "Method not allowed");
  const routes = [`${HARNESS_PATH}/api/extensions`, `${HARNESS_PATH}/api/environment`, `${HARNESS_PATH}/api/mcp`, `${HARNESS_PATH}/api/mcp/test`, `${HARNESS_PATH}/api/mcp/servers`, `${HARNESS_PATH}/api/mcp/oauth`, `${HARNESS_PATH}/api/mcp/secret`];
  const skillsRoute = SKILLS_WRITE_ROUTES.find((route) => path === `${HARNESS_PATH}/api/skills${route}`);
  const endpointsRoute = deps.endpoints === undefined ? undefined : Object.values(ENDPOINTS_PATHS).find((route) => path === `${HARNESS_PATH}${route}`);
  if (!routes.includes(path) && (skillsRoute === undefined || deps.skills === undefined) && endpointsRoute === undefined) return refused(404, "Not found");
  const why = await unsafeWrite(request, deps);
  if (why !== undefined) {
    console.log(JSON.stringify({ t3flare: "harness-refused", reason: why, caller: deps.caller.kind }));
    return refused(403, why);
  }
  const ops = opsOf(deps);
  if (skillsRoute !== undefined && deps.skills !== undefined) {
    const body = await bodyOf(request);
    if (body === undefined) return refused(400, "the body is a JSON object");
    const options = optionsOf(deps, body);
    if (options === undefined) return refused(400, EXPECTED_REVISION);
    return skillsResponse(await changeSkills(ops, skillsRoute, body, options));
  }
  if (endpointsRoute !== undefined && deps.endpoints !== undefined) {
    const body = await bodyOf(request);
    if (body === undefined) return refused(400, "the body is a JSON object");
    const endpoints = deps.endpoints;
    const audit: Parameters<typeof endpointsChange>[2] = (entry) => deps.store.audit({ ...entry, entity: "endpoints", at: deps.now?.() ?? Date.now(), caller: callerName(deps.caller) });
    return endpointsResponse(endpointsRoute === ENDPOINTS_PATHS.discover ? await endpointsDiscover(endpoints, body) : await endpointsChange(endpoints, body, audit));
  }
  const body = await bodyOf(request);
  const options = body === undefined ? { actor: actorOf(deps) } : optionsOf(deps, body);
  if (options === undefined) return refused(400, EXPECTED_REVISION);
  if (path === `${HARNESS_PATH}/api/environment`) {
    const settings = body?.settings;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return refused(400, "the body is one change: { settings: { … } }");
    return answer(await changeEnvironment(ops, settings as Record<string, unknown>, options));
  }
  if (path === `${HARNESS_PATH}/api/mcp/test`) {
    // The test's answer has no `ok`, as before the ops moved out.
    const tested = await testMcpServer(ops, typeof body?.server === "string" ? body.server : "", options);
    if (!tested.ok) return refused(tested.status, tested.error);
    const { ok: _ok, ...shown } = tested;
    return json(shown);
  }
  if (path === `${HARNESS_PATH}/api/mcp`) {
    if (body === undefined || typeof body.op !== "string" || typeof body.server !== "string") return refused(400, "the body is one change: { op, server, … }");
    return answer(changeMcp(ops, changeOf(body) as unknown as McpChange, options));
  }
  if (path === `${HARNESS_PATH}/api/mcp/servers`) {
    return answer(
      await addMcpServer(
        ops,
        {
          server: typeof body?.server === "string" ? body.server : "",
          url: typeof body?.url === "string" ? body.url : "",
          auth: (body?.auth ?? { kind: "none" }) as AddServer["auth"],
          ...(typeof body?.value === "string" ? { value: body.value } : {}),
        },
        options,
      ),
    );
  }
  if (path === `${HARNESS_PATH}/api/mcp/oauth`) return answer(await beginMcpSignIn(ops, typeof body?.server === "string" ? body.server : "", options));
  if (path === `${HARNESS_PATH}/api/mcp/secret`) return answer(await setMcpHeader(ops, { server: typeof body?.server === "string" ? body.server : "", value: body?.value }, options));
  if (body === undefined || typeof body.extension !== "string") return refused(400, "the body is one change: { extension, enabled?, settings? }");
  return answer(changeExtension(ops, changeOf(body) as unknown as HarnessChange, options));
};

const skillsResponse = (answer: SkillsAnswer): Response => ("json" in answer ? json(answer.json, answer.status) : refused(answer.status, answer.text));

/** An op's outcome as the panel answers it: the outcome as JSON, or the refusal's words with its status. */
const answer = <T extends object>(outcome: Outcome<T>): Response => (outcome.ok ? json(outcome) : refused(outcome.status, outcome.error));

const endpointsResponse = (answer: EndpointsAnswer): Response => ("json" in answer ? json(answer.json, answer.status) : refused(answer.status, answer.text));

const bodyOf = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const EXPECTED_REVISION = "expectedRevision, when sent, is the revision read: a whole number";

/** The panel's actor: who the admin entrypoint admitted. An entry without `via` reads as the panel's (plan D15). */
const actorOf = (deps: HarnessDeps): AuditActor => ({ caller: callerName(deps.caller) });

/** The change's options from its body: the panel's actor and the optional `expectedRevision`; undefined when that is malformed. */
const optionsOf = (deps: HarnessDeps, body: Record<string, unknown>): OpOptions | undefined => {
  const expected = body.expectedRevision;
  if (expected === undefined) return { actor: actorOf(deps) };
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) return undefined;
  return { actor: actorOf(deps), expectedRevision: expected };
};

/** The body without `expectedRevision`: the change itself. */
const changeOf = (body: Record<string, unknown>): Record<string, unknown> => {
  const { expectedRevision: _expected, ...change } = body;
  return change;
};

/** The ops' dependencies from the panel's. */
const opsOf = (deps: HarnessDeps): OpsDeps => ({
  store: deps.store,
  now: () => deps.now?.() ?? Date.now(),
  ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }),
  ...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
  ...(deps.oauth === undefined ? {} : { oauth: deps.oauth }),
  ...(deps.skills === undefined ? {} : { skills: deps.skills }),
});
