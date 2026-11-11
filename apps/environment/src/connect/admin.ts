// @effect-diagnostics globalDate:off globalConsole:off globalFetch:off globalJsonInEffect:off
// The Connect admin routes (step 3+, ADR-0025), under the Worker's admin check (Access plus the admin token):
//
//   POST /_t3flare/connect/sign-in            t3's device flow; answers the code and URL for the owner to approve
//   POST /_t3flare/connect/import-token       R1 fallback: {"accessToken","refreshToken","expiresAtEpochMs"} from a headless CLI
//   POST /_t3flare/connect/relink             the link step again, with the stored account token (stages)
//   POST /_t3flare/connect/unlink             the relay's link (with the token, if held) and ours; keeps the token
//   POST /_t3flare/connect/sign-out           unlink, then remove the account token
//   POST /_t3flare/connect/publish?on=1|0     t3's publish switch
//   GET  /_t3flare/connect/status[?relay=1]   the flow, t3's link state, secrets held (names only), the publish recorder;
//                                             relay=1 adds the relay's view, read with the account token
//   POST /_t3flare/connect/fault/relay-unlink stages only: the relay's link removed, ours kept (as the T3 apps' removal)
//   POST /_t3flare/connect/probe              P2: the relay's /health and a device authorization started and dropped
//   POST /_t3flare/check/connect-refusals     the four relay routes, sent to t3's own app past the DO's 404: refused
//
// Mutations are owner-only on prod (review finding 6): the Worker says which caller it admitted, and only the owner's
// own Access identity passes, never the stage's service token, which CI also holds.
import * as Effect from "effect/Effect";
import type * as CliTokenManager from "t3/src/cloud/CliTokenManager.ts";
import { cloudCliOAuthConfig, relayUrlConfig } from "t3/src/cloud/publicConfig.ts";

import { ADMIN_CALLER_HEADER } from "../access.ts";
import type { EnvironmentDO } from "../environmentDO.ts";
import { Connect, type ConnectError } from "./service.ts";


const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MUTATIONS = new Set([
  "POST /_t3flare/connect/sign-in",
  "POST /_t3flare/connect/import-token",
  "POST /_t3flare/connect/relink",
  "POST /_t3flare/connect/unlink",
  "POST /_t3flare/connect/sign-out",
  "POST /_t3flare/connect/publish",
  "POST /_t3flare/connect/fault/relay-unlink",
]);

/** The four routes only the relay or a client-driven link call (plan section 5), refused twice: here and in t3. */
export const REFUSED_ROUTES = [
  "/api/connect/link-proof",
  "/api/connect/relay-config",
  "/api/t3-connect/health",
  "/api/t3-connect/mint-credential",
] as const;

/** The admitted caller may run this route: reads always; mutations by the owner, or the service token on stages. */
export const callerMayRun = (route: string, caller: string | null, serviceTokenAllowed: boolean) =>
  !MUTATIONS.has(route) || caller === "owner" || (serviceTokenAllowed && caller === "service-token");

const parseToken = (body: unknown): CliTokenManager.PersistedToken | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const { accessToken, refreshToken, expiresAtEpochMs } = body as Record<string, unknown>;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAtEpochMs !== "number") return undefined;
  return { accessToken, refreshToken, expiresAtEpochMs };
};

const probe = Effect.gen(function* () {
  const relayUrl = yield* relayUrlConfig;
  const oauth = yield* cloudCliOAuthConfig;
  return yield* Effect.promise(async () => {
    const timed = async (run: () => Promise<Response>) => {
      const started = Date.now();
      try {
        const response = await run();
        const body = await response.text();
        return { status: response.status, ms: Date.now() - started, body };
      } catch (error) {
        return { status: 0, ms: Date.now() - started, body: String(error).slice(0, 200) };
      }
    };
    const health = await timed(() => fetch(`${relayUrl}/health`, { signal: AbortSignal.timeout(10_000) }));
    // A device authorization started and dropped: nobody sees or approves its code.
    const device = await timed(() =>
      fetch(oauth.deviceAuthorizationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: oauth.clientId, scope: oauth.scopes.join(" ") }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    let deviceFields: Array<string> = [];
    try {
      deviceFields = Object.keys(JSON.parse(device.body) as Record<string, unknown>).toSorted();
    } catch {
      // Not JSON: the status says enough.
    }
    return {
      relay: { url: `${relayUrl}/health`, status: health.status, ms: health.ms, body: health.body.slice(0, 200) },
      // Field names only: the device and user codes are dropped here.
      deviceAuthorization: {
        endpoint: oauth.deviceAuthorizationEndpoint,
        status: device.status,
        ms: device.ms,
        fields: deviceFields,
        error: device.status >= 400 ? device.body.slice(0, 300) : null,
      },
    };
  });
});

export const handleConnectAdmin = async (request: Request, environment: EnvironmentDO): Promise<Response> => {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  const caller = request.headers.get(ADMIN_CALLER_HEADER);
  if (!callerMayRun(route, caller, environment.connectServiceTokenAllowed)) {
    console.log(JSON.stringify({ t3flare: "connect-refused", route, caller }));
    return json({ error: "owner only: sign in to Access as the owner (cloudflared access login), not with the service token" }, 403);
  }
  if (route === "POST /_t3flare/connect/sign-in" && (await environment.isArmed())) {
    // Disarming restarts t3 in place, which would end the sign-in's poll (review finding 4).
    return json({ error: "pairing is armed: disarm it (or let the window close) before signing in" }, 409);
  }
  const runtime = await environment.boot("connect-admin", request);
  const answer = async (use: (service: Connect["Service"]) => Effect.Effect<unknown, ConnectError>) => {
    const result = await runtime.run(Effect.flatMap(Connect, use).pipe(Effect.result));
    if (result._tag === "Success") return json(result.success);
    return json({ error: result.failure.reason, detail: result.failure.detail ?? null }, 502);
  };
  switch (route) {
    case "POST /_t3flare/connect/sign-in":
      return answer((service) => service.signIn);
    case "POST /_t3flare/connect/import-token": {
      const token = parseToken(await request.json().catch(() => null));
      if (token === undefined) return json({ error: "expected {accessToken, refreshToken, expiresAtEpochMs}" }, 400);
      return answer((service) => service.importToken(token));
    }
    case "POST /_t3flare/connect/relink":
      return answer((service) => service.relink);
    case "POST /_t3flare/connect/unlink":
      return answer((service) => service.unlink);
    case "POST /_t3flare/connect/sign-out":
      return answer((service) => service.signOut);
    case "POST /_t3flare/connect/publish": {
      const on = url.searchParams.get("on");
      if (on !== "1" && on !== "0") return json({ error: "on=1 or on=0" }, 400);
      return answer((service) => Effect.as(service.setPublishing(on === "1"), { publishAgentActivity: on === "1" }));
    }
    case "GET /_t3flare/connect/status":
      return answer((service) => service.status({ relay: url.searchParams.get("relay") === "1" }));
    case "POST /_t3flare/connect/fault/relay-unlink":
      if (!environment.connectServiceTokenAllowed) return json({ error: "stages only" }, 404);
      return answer((service) => Effect.map(service.relayUnlinkOnly, (relay) => ({ relay })));
    case "POST /_t3flare/connect/probe":
      return json(await runtime.run(probe));
    case "POST /_t3flare/check/connect-refusals": {
      // Past the DO's own 404 (environmentDO.ts): what t3's app answers, which must be a refusal, not a credential.
      const results: Record<string, { status: number; body: string }> = {};
      for (const path of REFUSED_ROUTES) {
        const body = path.endsWith("link-proof")
          ? { challenge: "c", relayIssuer: "https://relay.t3.codes", endpoint: { httpBaseUrl: "http://127.0.0.1:443", wsBaseUrl: "ws://127.0.0.1:443", providerKind: "manual" }, origin: { localHttpHost: "127.0.0.1", localHttpPort: 443 } }
          : path.endsWith("relay-config")
            ? { relayUrl: "https://relay.example", cloudUserId: "u", environmentCredential: "c", cloudMintPublicKey: "k", endpointRuntime: null }
            : { proof: "a.b.c" };
        const response = await runtime.fetch(
          new Request(new URL(path, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        );
        results[path] = { status: response.status, body: (await response.text()).slice(0, 300) };
      }
      return json(results);
    }
    default:
      return json({ error: `no route ${route}` }, 404);
  }
};
