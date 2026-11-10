// @effect-diagnostics globalConsole:off
// The environment Worker (ADR-0014): the front door, the Environment DO, and the stock t3 web client as
// static assets. Kept tiny: t3 itself loads inside the DO, on first use.
import * as Access from "./access.ts";
import type { EnvironmentEnv } from "./environmentDO.ts";

export { EnvironmentDO } from "./environmentDO.ts";

export interface Env extends EnvironmentEnv {
  readonly ENVIRONMENT: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
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
    }
    if (isServerPath(url.pathname)) return env.ENVIRONMENT.getByName(ENVIRONMENT_NAME).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
