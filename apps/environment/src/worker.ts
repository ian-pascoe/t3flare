// @effect-diagnostics globalConsole:off
// The environment Worker (ADR-0014): the front door, the Environment DO, and the stock t3 web client as
// static assets. Kept tiny: t3 itself loads inside the DO, on first use.
import { OAUTH_PUBLIC_PATHS } from "./harness/oauth.ts";

import * as Access from "./access.ts";
import type { EnvironmentEnv } from "./environmentDO.ts";
import { type HarnessCaller, isHarnessPath } from "./harness/panel.ts";

export { EnvironmentDO } from "./environmentDO.ts";

export interface Env extends EnvironmentEnv {
  readonly ENVIRONMENT: {
    getByName(name: string): { fetch(request: Request): Promise<Response>; harness(request: Request, caller: HarnessCaller): Promise<Response>; harnessPublic(request: Request): Promise<Response> };
  };
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly T3FLARE_ADMIN_TOKEN?: string;
  readonly T3FLARE_ACCESS_TEAM_DOMAIN?: string;
  readonly T3FLARE_ACCESS_AUD?: string;
  readonly T3FLARE_OWNER_EMAIL?: string;
  readonly T3FLARE_ACCESS_SERVICE_CLIENT_ID?: string;
  /** Set only by wrangler.local.jsonc: there is no Access in front of localhost. */
  readonly T3FLARE_LOCAL_MODE?: string;
}

/** The hosts local workerd serves on, with an optional port and nothing else. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/** Paths t3's server answers; everything else is the web client (t3's DEV_PROXIED_PATH_PREFIXES). */
const SERVER_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp", "/_t3flare"];
const isServerPath = (pathname: string) =>
  SERVER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

/** One Environment DO per deploy (ADR-0002). */
const ENVIRONMENT_NAME = "environment";

const guardConfig = (env: Env): Access.GuardConfig => ({
  teamDomain: env.T3FLARE_ACCESS_TEAM_DOMAIN,
  audience: env.T3FLARE_ACCESS_AUD,
  ownerEmail: env.T3FLARE_OWNER_EMAIL,
  serviceTokenClientId: env.T3FLARE_ACCESS_SERVICE_CLIENT_ID,
  adminToken: env.T3FLARE_ADMIN_TOKEN,
});

// Per isolate: the team's signing keys, kept an hour.
let keys: { readonly team: string; readonly lookup: Access.TeamKeyLookup } | undefined;
const keysFor = (team: string) => {
  if (keys?.team !== team) keys = { team, lookup: Access.teamKeys(Access.loadTeamKeysFrom(team)) };
  return keys.lookup;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The direct MCP servers' OAuth callback and client metadata document (ADR-0026, ADR-0010's refinement): public, GET
    // only, exact paths; the callback checks its single-use state.
    if (OAUTH_PUBLIC_PATHS.has(url.pathname)) return env.ENVIRONMENT.getByName(ENVIRONMENT_NAME).harnessPublic(request);
    // The harness panel (ADR-0026) at `/_t3flare/harness`, behind the `/_t3flare` Access application (owner, 2026-11-12,
    // back to stock: no admin host). The owner's own Access identity reaches the panel without the admin token; every
    // other admin route still needs it.
    if (isHarnessPath(url.pathname)) {
      const config = guardConfig(env);
      const verdict = await Access.verifyHarnessRequest(request, config, keysFor(config.teamDomain ?? ""));
      if (!verdict.admitted) {
        console.log(JSON.stringify({ t3flare: "harness-refused", reason: verdict.reason, path: url.pathname }));
        return new Response("Not found\n", { status: 404 });
      }
      const caller: HarnessCaller = verdict.caller.kind === "owner" ? { kind: "owner", subject: verdict.caller.subject ?? "" } : { kind: "service-token" };
      return env.ENVIRONMENT.getByName(ENVIRONMENT_NAME).harness(request, caller);
    }
    if (url.pathname === "/_t3flare" || url.pathname.startsWith("/_t3flare/")) {
      const config = guardConfig(env);
      // Local mode (local workerd only): no Access assertion, but still the admin token, and only on loopback.
      const local = env.T3FLARE_LOCAL_MODE === "true" && LOOPBACK_HOST.test(url.host);
      const verdict = local
        ? Access.verifyAdminToken(request, config)
        : await Access.verifyAdminRequest(request, config, keysFor(config.teamDomain ?? ""));
      if (!verdict.admitted) {
        // The caller learns nothing; the log says why.
        console.log(JSON.stringify({ t3flare: "admin-refused", reason: verdict.reason, path: url.pathname }));
        return new Response("Not found\n", { status: 404 });
      }
      // Step 3+ (review finding 6): the DO admits the Connect mutations by who was admitted here, so the header is
      // always ours, never the caller's.
      const headers = new Headers(request.headers);
      headers.set(Access.ADMIN_CALLER_HEADER, verdict.caller.kind);
      return env.ENVIRONMENT.getByName(ENVIRONMENT_NAME).fetch(new Request(request, { headers }));
    }
    if (isServerPath(url.pathname)) return env.ENVIRONMENT.getByName(ENVIRONMENT_NAME).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
