# Owner clients reach the Settings server at `/_t3flare/mcp`, behind an Access application of its own

Status: accepted, conditionally (SPI-1196's M0 spike and SPI-1200, 2026-11-14). It rests on a probe the owner has not
run yet: **owner step 1** ([`docs/steps/settings-mcp-m0-owner-steps.md`](../steps/settings-mcp-m0-owner-steps.md)), a
real OAuth token's exchange for the endpoint's path and its refusal at the panel's paths. Until it is recorded, this is
the layout built and deployed to test stages, not a confirmed one, and **prod is deployed without it**: no
`SettingsAccess`, the admin application exactly as before, no `T3FLARE_ACCESS_SETTINGS_AUD`, so `/_t3flare/mcp` on prod
answers 404 `not_configured` (`OWNER_ENDPOINT_EXCLUDED_STAGES` in `apps/environment/src/settings/endpointLayout.ts`).
Enabling prod is removing it from that list, once owner step 1 passes and M5a's stage evidence is recorded. Plan:
[`docs/steps/settings-mcp-plan.md`](../steps/settings-mcp-plan.md) D13. Evidence:
`docs/steps/settings-mcp/m0-access-oauth.json`, `m0-clients.json` (spike branch). Refines
[ADR-0010](0010-the-endpoint-is-public-behind-t3s-own-auth.md) ("Access only on the admin path"),
[ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md) §1-2 (one
Access application, no second one; its SPI-1200 refinement) and
[ADR-0034](0034-agents-change-t3flares-settings-through-the-settings-server.md) §1, which left where the Owner-client
endpoint lives to this record.

An **Owner client** (the owner's Claude Code, pi, Cursor, Codex, OpenCode on his laptop) signs in to the Settings server
with OAuth, and Cloudflare Access issues the grant (managed OAuth). A managed-OAuth token is good for its whole Access
application, so the endpoint cannot share the `/_t3flare` application: there the panel and the Change page admit the
owner's assertion alone, and an Owner client's token would drive them. The endpoint gets an application of its own on a
narrower path of the same host. M0 showed Access routing the two paths apart; that it keeps their **tokens** apart was
tested with a service-token stand-in only, and the OAuth bearer case is owner step 1
(`docs/steps/settings-mcp/m5a-stage-run.md` items 1-4). Until that is recorded, layout (B) is unproven.

1. **The endpoint is `https://<host>/_t3flare/mcp`**, served by the Environment Worker, which verifies Access's
   assertion against the endpoint's own audience (`T3FLARE_ACCESS_SETTINGS_AUD`, `verifySettingsRequest`) and hands the
   Environment DO an already-verified caller (`EnvironmentDO.settingsMcp`). Paths below it answer 404 after Access.
2. **Its Access application, `SettingsAccess`**, has the path `<host>/_t3flare/mcp` and managed OAuth with:
   - dynamic client registration on;
   - redirect URIs: any on `localhost` and any on loopback, plus `cursor://anysphere.cursor-mcp/oauth/callback` (older
     Cursor desktop releases, from third-party reports: **pending owner step 2**, since Cursor was not run in M0), kept
     in one constant (`SETTINGS_OAUTH_REDIRECT_URIS`); no https redirect, since no named client is a web client;
   - access tokens of 15 minutes and sessions of 168 hours, set explicitly because Access checks no bounds (the token's
     actual `expires_in` is m5a-stage-run.md item 1);
   - the same policies as the admin application: the owner's email, and the stage's service token as `non_identity`.
3. **Both applications set the path-cookie attribute** on a stage with the endpoint, so each one's `CF_Authorization` cookie is scoped to its own
   path and a browser sends the longer path's first.
4. **The `/_t3flare` application is otherwise unchanged**: still no managed OAuth, so t3's root
   `/.well-known/oauth-*` documents stay t3's own and t3's `/mcp` sign-in is unaffected.
5. **The Elicitation mode travels in the URL's query** (`?elicitation_mode=`): Access's protected-resource document and
   every named client's `resource` ignore or accept it, and it reaches the origin.

What this rests on, from M0 on a workers.dev stage:

- the more specific application wins a path: `/_t3flare/mcp` and below are `SettingsAccess`'s, `/_t3flare/mcpx` and
  every other `/_t3flare` path the admin application's (P8);
- Access answers none of the host's root or path-inserted well-known documents with managed OAuth on, so clients find
  its authorization server only from the 401's `WWW-Authenticate` `resource_metadata`, which Claude Code, pi, Codex and
  OpenCode all followed (P2, P9, P14);
- a path-scoped `resource`, with or without the query, is accepted and resolves to the endpoint's application (P6, at
  authorize);
- an Access token issued for one application is refused at the other's paths (P12): tested with a service-token
  stand-in only; the OAuth bearer case is owner step 1 (m5a-stage-run.md items 1-4).

**Pending (owner step 1):** the token exchange for the path `resource` (P6 end to end), the OAuth bearer itself refused
at `/_t3flare/harness` and `/_t3flare/echo` (P12), whether `sub` is the same in an OAuth-derived and a browser assertion
(P13), the access token's `expires_in` (P11), and Cursor's actual redirect URI (owner step 2). Prod's custom domain
has not been probed at all (only workers.dev): m5a-stage-run.md records its shape before prod is enabled.

## When to move to layout (C)

Layout (C) is a Worker `t3flare-settings-<stage>` on its own workers.dev host, with an Access application and managed
OAuth on the whole host, calling `EnvironmentDO.settingsMcp` through a cross-Worker binding. Move to it, on every stage
(prod included once enabled), when any of these holds:

- owner step 1 shows an Owner client's OAuth token admitted at a `/_t3flare` path outside the endpoint (P12), or the
  path `resource` failing at the token exchange (P6);
- Access starts answering the host's root `/.well-known/oauth-*` documents (t3's own MCP sign-in would find Access's
  authorization server), or stops preferring the more specific application or scoping cookies by path;
- a named client cannot discover the authorization server from `resource_metadata` and needs the standard documents at
  its host.

Moving costs the clients' URL and nothing in the DO: `src/settings/endpointLayout.ts`, `worker.ts`'s one branch and
`SettingsAccess` in `alchemy.run.ts` are replaced (plan D13).

## Considered options

- **(A) Managed OAuth on the existing `/_t3flare` application.** Rejected: its token would be admitted at the panel and
  the Change page, where the owner's assertion alone is enough.
- **(C) A Worker of its own on its own host.** Equivalent in the DO and passed the same pre-sign-in probes; not chosen
  first because it adds a Worker and a host per stage, and (B) keeps ADR-0010's one-host rule for prod's rate limit
  without a second hostname. It is the fallback above.
- **The mode in a request header** (`X-T3flare-Elicitation-Mode`). It also reaches the origin; kept as the fallback
  should a client's discovery stop tolerating the query.

## Consequences

- The t3 host now has two Access applications. ADR-0010's "Access only on the admin path" reads: Access on `/_t3flare`
  (the admin application) and on `/_t3flare/mcp` (the endpoint's, with managed OAuth); everything else stays public
  behind t3's own auth.
- Managed OAuth is a Cloudflare beta. Drift in its discovery or token scoping breaks Owner clients' sign-in under (B)
  and, at worst, t3's own MCP sign-in; `docs/upstream-fragility.md` U68 says how it is detected.
- Prod is excluded until owner step 1 passes and M5a's stage evidence (`m5a-settings-owner-browser.json`) is recorded:
  on prod there is no Owner-client endpoint, the `/_t3flare` application has no path-cookie attribute, and Owner clients
  cannot connect. Enabling prod then is a one-line change (`OWNER_ENDPOINT_EXCLUDED_STAGES`).
- Only workers.dev was probed. Prod's custom domain was not (a second stage with a domain in the zone would take over
  prod's rate-limit ruleset), so the first prod deploy with the endpoint is the first run on a custom domain.
- Every prod deploy's smoke check (`apps/environment/scripts/smoke.ts`) asserts the host's root `/.well-known/oauth-*`
  documents are still t3's, as acceptance step 2b does on a stage, so drift in Access answering them is caught at the
  deploy after it, prod's endpoint or not.
- Dynamic registrations from probes and clients stay in the team's managed-OAuth client list; they hold no grant.
- Until owner step 1 is recorded, the M5a stage run (`docs/steps/settings-mcp/m5a-stage-run.md` item 1) is the gate: if
  it fails, this ADR is superseded by one for layout (C).
