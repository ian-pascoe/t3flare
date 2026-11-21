# Owner clients reach the Settings server at `/_t3flare/mcp`, behind an Access application of its own

Status: accepted (SPI-1196's M0 spike and SPI-1200, 2026-11-14), confirmed on 2026-11-15: **owner step 1**
([`docs-archive-1:docs/steps/settings-mcp-m0-owner-steps.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/settings-mcp-m0-owner-steps.md)), a real OAuth token's exchange
for the endpoint's path and its refusal at the panel's paths, **passed** on the `psmcp` stage (P6, P11 at 900 s, P12,
P13 the same `sub`; recorded in `docs/steps/settings-mcp/m5a-settings-owner-browser.json`). Owner step 2 (Cursor's
redirect URI) is still open. **Prod is still deployed without the endpoint**: no `SettingsAccess`, the admin
application exactly as before, no `T3FLARE_ACCESS_SETTINGS_AUD`, so `/_t3flare/mcp` on prod answers 404 `not_configured`
(`OWNER_ENDPOINT_EXCLUDED_STAGES` in `apps/environment/src/settings/endpointLayout.ts`). Enabling prod is removing it
from that list, when the owner turns the endpoint on. The nightly job's `bump` stage is on that list for good. Plan:
[`docs-archive-1:docs/steps/settings-mcp-plan.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/settings-mcp-plan.md) D13. Evidence:
`docs/steps/settings-mcp/m0-access-oauth.json`, `m0-clients.json` (copied from the spike branch). Refines
[ADR-0010](0010-the-endpoint-is-public-behind-t3s-own-auth.md) ("Access only on the admin path"),
[ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md) §1-2 (one
Access application, no second one; its SPI-1200 refinement) and
[ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md) §1, which left where the Owner-client
endpoint lives to this record.

An **Owner client** (the owner's Claude Code, pi, Cursor, Codex, OpenCode on his laptop) signs in to the Settings server
with OAuth, and Cloudflare Access issues the grant (managed OAuth). A managed-OAuth token is good for its whole Access
application, so the endpoint cannot share the `/_t3flare` application: there the panel and the Change page admit the
owner's assertion alone, and an Owner client's token would drive them. The endpoint gets an application of its own on a
narrower path of the same host. M0 showed Access routing the two paths apart; that it keeps their **tokens** apart was
tested with a service-token stand-in in M0, and with a real OAuth bearer in owner step 1, which passed on 2026-11-15
(`docs-archive-1:docs/steps/settings-mcp/m5a-stage-run.md` items 1-4).

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
3. **Both applications set the path-cookie attribute** on a stage with the endpoint, so each one's `CF_Authorization`
   cookie is scoped to its own path and a browser sends the longer path's first.
4. **The `/_t3flare` application is otherwise unchanged**: still no managed OAuth, so t3's root
   `/.well-known/oauth-*` documents stay t3's own and t3's `/mcp` sign-in is unaffected.
5. **The Elicitation mode travels in the URL's query** (`?elicitation_mode=`): Access's protected-resource document and
   every named client's `resource` ignore or accept it, and it reaches the origin. **Superseded 2026-11-15** (below):
   Claude Code's discovery does not survive the query; the mode is set per client on the Harness panel and the URL is
   added without a query.

What this rests on, from M0 on a workers.dev stage:

- the more specific application wins a path: `/_t3flare/mcp` and below are `SettingsAccess`'s, `/_t3flare/mcpx` and
  every other `/_t3flare` path the admin application's (P8);
- Access answers none of the host's root or path-inserted well-known documents with managed OAuth on, so clients find
  its authorization server only from the 401's `WWW-Authenticate` `resource_metadata`, which Claude Code, pi, Codex and
  OpenCode all followed (P2, P9, P14);
- a path-scoped `resource`, with or without the query, is accepted and resolves to the endpoint's application (P6, at
  authorize);
- an Access token issued for one application is refused at the other's paths (P12): tested with a service-token
  stand-in in M0, and with the OAuth bearer itself in owner step 1 (m5a-stage-run.md items 1-4).

**Passed in owner step 1 (2026-11-15):** the token exchange for the path `resource` (P6 end to end), the OAuth bearer
itself refused at `/_t3flare/harness` and `/_t3flare/echo` (P12), the same `sub` in an OAuth-derived and a browser
assertion (P13), and the access token's `expires_in` at 900 s (P11).

**Still open:** Cursor's actual redirect URI (owner step 2). Prod's custom domain has not been probed at all (only
workers.dev): m5a-stage-run.md records its shape before prod is enabled.

## When to move to layout (C)

Layout (C) is a Worker `t3flare-settings-<stage>` on its own workers.dev host, with an Access application and managed
OAuth on the whole host, calling `EnvironmentDO.settingsMcp` through a cross-Worker binding. Move to it, on every stage
(prod included once enabled), when any of these holds:

- an Owner client's OAuth token is admitted at a `/_t3flare` path outside the endpoint (P12), or the path `resource`
  fails at the token exchange (P6) (neither happened in owner step 1; a later change in Access could bring them);
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
  and, at worst, t3's own MCP sign-in; `docs/upstream-fragility.md` U72 says how it is detected.
- Prod stays excluded until the owner turns the endpoint on (owner step 1 passed and M5a's stage evidence,
  `m5a-settings-owner-browser.json`, is recorded): on prod there is no Owner-client endpoint, the `/_t3flare`
  application has no path-cookie attribute, and Owner clients cannot connect. Enabling prod is a one-line change
  (`OWNER_ENDPOINT_EXCLUDED_STAGES`).
- `bump` is excluded for good: the nightly job deploys it with the CI token `t3flare-ci-bump`, which is not known to be
  allowed to create a managed-OAuth Access application, and a failure there would break the nightly job. Its
  acceptance run never calls the endpoint, so nothing it proves is lost; a throwaway stage (`psettings`) proves (B).
- Only workers.dev was probed. Prod's custom domain was not (a second stage with a domain in the zone would take over
  prod's rate-limit ruleset), so the first prod deploy with the endpoint is the first run on a custom domain.
- Every prod deploy's smoke check (`apps/environment/scripts/smoke.ts`) asserts the host's root `/.well-known/oauth-*`
  documents are still t3's, as acceptance step 2b does on a stage, so drift in Access answering them is caught at the
  deploy after it, prod's endpoint or not.
- Dynamic registrations from probes and clients stay in the team's managed-OAuth client list; they hold no grant.
- Owner step 1 passed (M5a item 1). If a later run of it fails, this ADR is superseded by one for layout (C).

## Refinement: the URL carries no query (SPI-1201, 2026-11-15)

§5 held in M0 for authorize (P6) but not for a whole sign-in. On the psmcp stage, Claude Code 2.1.322 added with
`…/_t3flare/mcp?elicitation_mode=…` failed to sign in: with a query on the URL its OAuth discovery falls back to the
origin's root authorization server instead of the 401's per-path `resource_metadata`, and Access answers no root
document here (the reason t3's own root documents stay t3's). The same URL without the query signed in. Neither the
request-header fallback under Considered options nor Access's consent page helps: Claude Code sends no configured header
on discovery, and the consent page is Access's.

So Owner clients are added with the plain endpoint URL, `https://<host>/_t3flare/mcp`, and each client's Elicitation
mode is a setting on the Harness panel, per Access identity and client name
([ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md)'s refinement of the same date). The
endpoint still honours `?elicitation_mode=` as an override, for scripts and for clients that keep a query, so the
layout and every probe above are unchanged. `docs/upstream-fragility.md` U74 records the client behaviour.
