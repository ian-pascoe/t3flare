# The endpoint is public, behind t3's own auth

Stock t3 desktop and mobile clients, and Peer links, cannot pass Cloudflare Access, so `/ws` and `/mcp` are public and protected only by t3's pairing, sessions, DPoP and MCP OAuth. Upstream already exposes servers publicly through T3 Connect tunnels. To narrow the surface, our composition mounts only the routes we need (no guest links, webhook route, OTLP proxy, device hub or relay routes), and a WAF rule rate-limits the auth paths. The first pairing uses t3's bootstrap token, supplied from a Worker secret. t3 turns it into a grant that any holder can reuse for 24 h after every boot, and logs a fresh pairing token at every boot, so: the boot log is suppressed (nothing secret reaches Workers Logs), and the bootstrap grant is seeded only while an admin route has armed it for a short window. Later devices pair through pairing links from an already-paired client, as stock t3 does. t3's server secrets (signing keys created at runtime) live in DO key-value storage, kept apart from SQL. Our own admin routes (`/_t3flare/*`) sit behind Access plus a token.

## How step 1 does it

- **Access only on the admin path.** Each stage's alchemy stack creates an Access application whose destination is `<host>/_t3flare` (and below) on every host the Worker serves (its workers.dev host, and its custom domain when it has one: prod's is `t3.ianpascoe.dev`), with two policies: an Allow for the owner's email, and a Service Auth (`non_identity`) for the stage's own Access service token, which the acceptance test and the bump job use. The Worker does not trust that Access ran: it verifies `Cf-Access-Jwt-Assertion` itself (RS256 against the team's keys, issuer, lifetime, the application's `aud`, then the owner's email or that service token's client id) and then the admin token, and answers 404 to anything else. A Worker without its audience, team or token refuses every admin request.
- **Pairing is armed, not standing.** `T3_BOOTSTRAP_TOKEN` reaches t3's `ServerConfig.desktopBootstrapToken` only on a boot while pairing is armed (`POST /_t3flare/arm-bootstrap`, 15 minutes by default, 60 at most). Arming restarts t3 in place so the grant is seeded; when the window closes the alarm restarts it without the grant; and outside the window the Environment DO refuses a bootstrap exchange that presents the token, even if t3 still holds a grant in memory.
- **No token in the logs.** t3's Console (and the loggers writing through it) is a redacting one: it drops t3's startup pairing-URL line and redacts `token=` values and bearer credentials.
- **`remote-reachable`.** `ServerConfig.host` is the Worker's public host, so t3's auth descriptor reports `remote-reachable` (its session cookie name then derives from the environment id alone, so it is stable). Nothing else in t3's auth is configured with the public origin: origin checks, DPoP's `htu`, MCP OAuth's issuer and pairing URLs are all taken from each request, and the session cookie is host-only, so a stage answers the same on its custom domain and its workers.dev host (a browser session on one is not a session on the other).

## The auth rate limit exists, and a domain stage has no workers.dev host (refinement, 2026-11-11)

The WAF rule above was not built until now. Two changes, both in `apps/environment/alchemy.run.ts` and both only for a stage with a custom domain (today: prod, `t3.ianpascoe.dev`):

- **One host.** The Worker's workers.dev URL and its version preview URLs are off (`workersDev: false`), so the rate limit cannot be sidestepped through a second host, and the Access application's only destination is `<domain>/_t3flare`. The stage's credentials file, the smoke check and the admin helpers all use the custom domain. A stage without a domain is still served at workers.dev only, as before. The "answers the same on its custom domain and its workers.dev host" point above no longer arises for prod.
- **The rule.** The `http_ratelimit` phase of the domain's zone (`ianpascoe.dev`, Free plan) holds one rule: `POST` to t3's credential-presenting routes on that host (`/oauth/token`, `/api/auth/browser-session`, `/oauth/mcp/register`, `/oauth/mcp/approval`, `/oauth/mcp/decision`, `/oauth/mcp/token`; the code lists where t3 defines each), counted per IP and data center, **10 requests per 10 s, then 429 for 10 s**. The Free plan fixes the period and the block at 10 s and allows one rule (checked against the API: a host and method expression is accepted, a block longer than 10 s is not). Normal use peaks far below: pairing is one request per client, an MCP client's sign-in three or four, and t3 has no refresh grant (sessions last 30 days), so a reconnecting client never touches these routes; what it does call on every reconnect (`GET /api/auth/session`, `POST /api/auth/websocket-ticket`, `/ws`, `/mcp`) needs its session and is not limited. The rule keeps floods off the Environment DO (every auth request wakes it); bootstrap tokens are 256-bit and armed only for minutes, so guessing was never the risk. The resource owns the zone's whole `http_ratelimit` entrypoint, so only one stage may have a domain in a zone, and the prod CI token (`infra/github.ts`) has Zone WAF Write on that zone.

## Refinement (step 3)

- **`/oauth/mcp/decision` joins the bootstrap refusal**: outside the Pairing window, a decision whose pairing code is the bootstrap token is refused by the Environment DO (`{"error":"pairing is not armed"}`, 401) before t3 sees it. This is defence in depth: t3 alone already refuses a grant that is not one-time there ("That is not a one-time pairing code", `EnvironmentAuth.consumeMcpApprovalCode`), and our bootstrap grant is a `desktop-bootstrap` one. `/oauth/mcp/approval` carries no credential. Both answers are checked by `acceptance.ts --peer` (F11).
- **A Peer link is a 30-day MCP client session** with no refresh grant: it costs three rate-limited `POST`s per link, is renewed with a new pairing code, and is revoked in Sharing & access. A link takes a plain pairing code only (t3 refuses an access-bound "app approval" code for a link); the access the linking side asks for is capped by the code's scopes: a code minted with `orchestration:read` and `operate` alone cannot sign a full-access link, and is not spent by the refusal.

## Refinement (SPI-1005): T3 Connect's routes are mounted

"No relay routes" above is true of the relay tunnel and the guest routes, but not of T3 Connect's own HTTP group. `CloudHttp.layer` is part of `HttpApiBuilder.layer(EnvironmentHttpApi)` (`composition.ts`, `layerMakeRoutes`), and that builder needs every group, so these routes answer:

- `/api/connect/link-proof`, `relay-config`, `link-state`, `reachability`, `unlink` and `preferences`. They sit behind t3's `EnvironmentAuthenticatedAuth`, so a paired client's session, like every other environment route.
- `/api/t3-connect/health` and `/api/t3-connect/mint-credential`. They have no session middleware; t3's `CloudLink` verifies the relay's signed JWT proof (`verifyRelayJwt`) against the T3 Connect link (`t3code/apps/server/src/cloud/http.ts`). A request without a valid proof is refused.

They stay mounted rather than refused in the Environment DO: step 3+ (the T3 Connect publish-only link) needs them, and t3's own auth already covers them. The guest routes (`t3code/apps/server/src/guest/http.ts`) are still not mounted, and guest links are off under ADR-0023's managed policy (`guestSharingEnabled` locked).

## Refinement (SPI-1006): the bootstrap token pairs the first device only

The bootstrap grant is t3's `desktop-bootstrap` grant, and t3 issues a session from it with `replaceActiveForSubjectAndMethod` (`t3code/apps/server/src/auth/EnvironmentAuth.ts:989`). That revokes every active session of the same subject and method (`persistence/AuthSessions.ts:267`). So pairing a second device with the armed bootstrap token signs the first one out, if it used the same kind of token (a bearer client such as the mobile app). Pair every later device with a **one-time pairing link** made in an already-paired client (Settings → Sharing & access), as stock t3 does. Arm the bootstrap token only for the first device, or to recover when no paired client is left.

The mobile app speaks t3's orchestration protocol. Its version must match the pinned nightly's (`ORCHESTRATION_PROTOCOL_VERSION`, now 2), so a client far ahead of or behind the pin may refuse to connect. The desktop and web clients have the same rule, but the web client is served by the Environment itself, so it always matches.

## Refinement (step 3+): T3 Connect, publish-only

The cloud links outward to `relay.t3.codes` with a `manual` link scoped to agent-activity notifications, signed in by the owner through t3's device flow from an admin route (ADR-0025). It sends thread and project titles, phases and model ids, never content. It supersedes the SPI-1005 refinement for four routes: "no relay routes" above becomes **relay routes only for link state, preferences, unlink and the reachability answer** (`/api/connect/link-state`, `preferences`, `unlink`, `reachability`, each behind t3's session scopes). The four routes only the relay or a client-driven link would call are refused twice:

- **In the Environment DO, before t3 boots, for any method:** `/api/connect/link-proof`, `/api/connect/relay-config`, `/api/t3-connect/health` and `/api/t3-connect/mint-credential` answer 404, compared after percent-decoding, dot segments, repeated and trailing slashes, `;` parameters and case (`host/relayRoutes.ts`). An upper-case spelling never reaches the DO at all: the Worker routes `/api` case-sensitively, so it gets the web client's assets.
- **Inside t3:** its HTTP routes get a `CloudLink` whose `linkProof`, `applyRelayConfig`, `answerHealthRequest` and `mintCredential` fail with t3's own managed-policy refusal (403), as t3's policy variant does. The admin routes' Connect service keeps the real one.

Why both, corrected from the plan:

- `health` and `mint-credential` carry **no scope check** in t3 (`cloud/http.ts`): mint needs only a proof signed with the stored mint key, and answers a 2-minute pairing credential with the standard client scopes. So the mint key is also **deleted after every link**: publishing never reads it.
- `relay-config` accepts, from any session with `relay:write`, any https relay URL and any well-formed mint key while no account is linked.
- A `manual` link proof (`link-proof`) lets another T3 Connect account link this environment, receive its pushes and, by linking it again, revoke our credential. t3 signs one for a non-loopback request host when the session's subject is `desktop-bootstrap`, which is what our first pairing's sessions are.

No tunnel, no `cloudflared`, no machine slot; T3 Connect can neither reach the Environment nor mint a session on it.

## Refinement (tools step): the harness panel, and two public OAuth paths

The harness panel (ADR-0026) is `/_t3flare/harness` on the t3 host, behind the `/_t3flare` Access application (owner, 2026-11-12, back to stock; it was first built on a dedicated admin host with its own Access application). There the Worker admits the owner's Access assertion **without the admin token**: a browser cannot send it, so CSRF, Origin and `Sec-Fetch-Site` checks take its place. A service-token caller still needs the admin token, and every other admin route is unchanged.

Two exact paths on the t3 host are public, outside `/_t3flare` (so outside its Access application, like `/mcp`), because an OAuth authorization server must reach them without Access:
- `/t3flare/oauth/callback`, the redirect. It is a GET, but it changes state only by redeeming a single-use 256-bit `state`, with PKCE and an `iss` check.
- `/t3flare/oauth/client.json`, our Client ID Metadata Document.

Evidence: `docs/steps/tools/m3-panel-safety.json`, `m6-oauth.json` (P13).
