# M5a (SPI-1200): what the stage run must record

M5a's code and unit tests (T-endpoint, T-guards, T-state, and T-modes' `browser` cases) landed without a deploy. Its
evidence, `m5a-settings-owner-browser.json`, needs a deployed workers.dev stage (`psettings`, now in `STAGES`; never
`prod`) and the owner signing in. Record each item with the commit deployed, the stage, timestamps, the client and its
version, and the change ids. Never record a token, a cookie, an authorization code or a header value; record an
assertion by its decoded claims with `sub` and `email` reduced to "same as …" comparisons.

## Before the run

1. `node scripts/stage.ts deploy psettings` (from `apps/environment`). The deploy makes the `SettingsAccess` application
   on `<host>/_t3flare/mcp` (managed OAuth: dynamic registration, any localhost and loopback redirect,
   `cursor://anysphere.cursor-mcp/oauth/callback`, access token 15 min, session 168 h) and turns the path-cookie
   attribute on for both applications. Record the stack's `settingsAccessAud` and `settingsMcpUrl` outputs, and that
   `.alchemy/stages/psettings.access.json` gained `settingsMcpUrl` (without printing the file).
2. Record the application as Access shows it (dashboard or API): its domain, its policies (owner email, the stage's
   service token as `non_identity`), its `oauthConfiguration`, and the admin application's unchanged policies.

## `m5a-settings-owner-browser.json`

### Access, layout (B)

Layout (B) is unproven until items 1-4 pass: M0 tested that one application's token is refused at the other's paths with
a service-token stand-in only (ADR-0035). Items 1-4 are owner step 1's OAuth bearer case.

1. **M0's open conditions (owner step 1)**: the owner signs in from a named client (Claude Code first). Record that the
   token exchange works for the path `resource` (P6), the claims of the OAuth-derived assertion the origin receives
   (P7, as decoded claims), and that the client's token presented at `/_t3flare/harness` and `/_t3flare/echo`-like paths
   of the admin application is refused (P12, as a bearer and as `cf-access-token`). Record the token response's
   `expires_in` (P11): it must be 900 (the `15m` of `SETTINGS_OAUTH_GRANT`) or less; a longer one means Access ignored
   the setting, and the grant's lifetime must be fixed before the endpoint is trusted. If the exchange or P12 fails,
   layout (B) is out: stop, and move to (C) (ADR-0035; replace `src/settings/endpointLayout.ts`, the worker branch and
   `SettingsAccess`).
2. **P13**: compare the `sub` of the endpoint's OAuth-derived assertion with the owner's browser assertion at the panel
   (the Change page). The page lets only the asking `sub` answer an Owner client's change (`openChanges.ts`); if the two
   differ, item 7 below fails with "only the owner who asked answers this change", and the answerer check must move to
   the email (plan D8).
3. **The root well-known documents are still t3's**: `GET /.well-known/oauth-authorization-server` and
   `/.well-known/oauth-protected-resource` and `…/mcp` on the host answer t3's documents, not Access's. A 401 at
   `/_t3flare/mcp` carries `WWW-Authenticate` with `resource_metadata` naming Access's
   `/.well-known/cloudflare-access-protected-resource/_t3flare/mcp`.
4. `/_t3flare/mcpx` and `/_t3flare/mcp/anything`: the first is the admin application's (its Access login), the second
   the endpoint's and answered 404 after Access.
   - **4b. Cursor (owner step 2)**: the redirect allowlist's one custom scheme,
     `cursor://anysphere.cursor-mcp/oauth/callback`, comes from third-party reports. Record the `redirect_uri` Cursor
     registers (decoded from Access's sign-in URL, before signing in) and whether registration succeeds. If Cursor uses
     another scheme, change `SETTINGS_OAUTH_REDIRECT_URIS` (one constant) and ADR-0035; if it uses `localhost`, the
     scheme may be dropped.
   - **4c. Prod's custom domain shape** (no deploy to prod; nothing changes there): M0 probed workers.dev only. Without
     touching prod's Access applications, record from prod's host (`t3.ianpascoe.dev`) as it is today: what
     `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`,
     `/.well-known/cloudflare-access-protected-resource/_t3flare` and `/_t3flare/mcp` answer (status,
     `WWW-Authenticate`, and whether Access or the origin answers), so the first prod deploy of `SettingsAccess` has a
     baseline to compare with. After that deploy (CI's, not this run), the same requests must show `/_t3flare/mcp` as
     its own application and the root documents still t3's; `scripts/acceptance.ts` step 2b asserts the latter on every
     run.

### A named client, end to end (Claude Code 2.1.322 on 2026-07-28; then OpenCode or Claude Code forced to 2025-11-25)

Configure the client with `<settingsMcpUrl>?elicitation_mode=browser` (and once with no query).

5. **Sign-in and discovery**: the client follows `resource_metadata`, registers dynamically, the owner signs in, and the
   client lists the thirteen tools (no `resume`). Record `server/discover` (2026) or `initialize` (2025) and the
   `settings-*` log lines (none should say `settings-refused` for a guard).
6. **A read and a free change**: `get_settings` (environment), then `change_environment` lowering `containerIdleMinutes`
   or `containerBudget`. Record `status: applied` with the revision, and the audit entry (`via: mcp`,
   `caller: owner:<sub>` shown as "owner:…", `tier: free`, `client: { name, source }`).
7. **An asked change approved on the page**: `change_environment` raising `containerBudget`.
   - 2026: the client shows the URL elicitation with the Change page's URL; "Open in browser" opens the page (Access's
     login for the admin application if the browser has no cookie); the owner approves on the page; "I'm done,
     continue" retries and the call answers `applied` within the 45 s hold. Record the `input_required` result's shape
     (the `requestState` as "present"), the retry's `inputResponses`, and the audit entry (`tier: asked`,
     `mode: browser`, `answeredBy: page`, `change`).
   - 2025-11-25: the same through the call's stream (`elicitation/create` with `elicitationId`), the result written when
     the page approves.
8. **Declined and withdrawn**: decline on the page (`status: declined`); and decline the client's own URL prompt (the
   change closes `withdrawn`, `closed.by: client`; the page shows it closed).
9. **The hold running out**: leave the page unanswered for 45 s: the call answers `waiting` with the link; approving on
   the page later still applies it (`get_settings` shows the new revision).
10. **The link fallback**: pi 1.5.2 (no elicitation) makes an asked change: the result is `waiting` with the link, and
    the page applies it.
11. **`native` and `model` until M5b**: a client configured with `?elicitation_mode=native` and `=model` connects, lists
    no `resume`, and its asked change behaves as `browser` with the result saying so. Only at commits before M5b: from
    M5b (SPI-1201) on, the two modes are `m5b-stage-run.md`'s, and this item is not run.
12. **Guards from outside**: with the service token and the admin token (so Access admits the request), record 405 for
    GET, 415 for `text/plain`, 403 with an `Origin` and with `Sec-Fetch-Site`, 413 for 300 KiB, and 400 for
    `?elicitation_mode=natve`, each with `cache-control: no-store` and no `access-control-*` header. Without Access
    credentials the endpoint answers Access's 401, never the origin.
13. **The access switch**: on the panel, set the Settings server read-only (the client lists reads only and a write is
    refused naming the panel), then off (the client lists nothing; every call is refused naming the panel), then back on.
