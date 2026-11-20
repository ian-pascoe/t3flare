// Where the Owner-client endpoint lives: ADR-0036 (layout (B), its Access application, and when to move to (C)); plan
// D13; M5a (SPI-1200), chosen by M0 (SPI-1196, `docs/steps/settings-mcp/m0-access-oauth.json`). Everything that knows
// the layout is here, in `worker.ts`'s one branch, and in `alchemy.run.ts`'s `SettingsAccess` application, so layout
// (C) (a Worker on its own host serving its own well-known documents, which calls `EnvironmentDO.settingsMcp` the same
// way) would replace these and nothing else: the DO takes an already-verified caller either way, and moving costs only
// the clients' URL.
//
// (B): the endpoint is `https://<host>/_t3flare/mcp` on the Environment's own host, behind a path-scoped Access
// application of its own with managed OAuth on (M0: the more specific path wins, so `/_t3flare/mcp` and below are this
// application's and `/_t3flare/mcpx` stays the panel's; each application gets its own path cookie; Access answers no
// root or path-inserted well-known document, so clients discover it from the 401's `resource_metadata`). That a token of
// one application is refused at the other's paths was tested with a service-token stand-in, then with a real OAuth
// bearer: owner step 1 passed on 2026-11-15 (P6, P11 at 900 s, P12, P13 the same `sub`; `docs/steps/settings-mcp/m5a-stage-run.md`
// items 1-4). Prod and the t3 bump's `bump` stay out of layout (B) (`OWNER_ENDPOINT_EXCLUDED_STAGES`) until the owner turns it on.

/**
 * The stages deployed without the Owner-client endpoint (ADR-0036): no `SettingsAccess` application, the admin
 * application exactly as before layout (B) (no path-cookie attribute), and no `T3FLARE_ACCESS_SETTINGS_AUD`, so
 * `/_t3flare/mcp` stays under the admin application and the Worker answers it 404 `not_configured` (src/access.ts).
 * Prod is here until the owner turns the endpoint on (owner step 1 passed and M5a's stage evidence is recorded,
 * `docs/steps/settings-mcp/m5a-stage-run.md` items 1-4); enabling prod is removing it from this list. `bump` is here for good (SPI-1195 review): the nightly
 * job deploys it with the CI token `t3flare-ci-bump`, which is not known to be allowed to create a managed-OAuth Access
 * application, and a failure there would break the t3 bump; its acceptance test never calls the endpoint.
 */
export const OWNER_ENDPOINT_EXCLUDED_STAGES: ReadonlyArray<string> = ["prod", "bump"];

/** Whether `stage` is deployed with the Owner-client endpoint (layout (B)): `alchemy.run.ts` reads only this. */
export const ownerEndpointOn = (stage: string): boolean => !OWNER_ENDPOINT_EXCLUDED_STAGES.includes(stage);

/** The endpoint's path on the Environment host. */
export const SETTINGS_MCP_PATH = "/_t3flare/mcp";

/** Whether `pathname` is the endpoint's Access application's: the endpoint, or anything below it (answered 404). */
export const isSettingsMcpPath = (pathname: string): boolean => pathname === SETTINGS_MCP_PATH || pathname.startsWith(`${SETTINGS_MCP_PATH}/`);

/** The endpoint's URL for a host. */
export const settingsMcpUrl = (host: string): string => `https://${host}${SETTINGS_MCP_PATH}`;

/**
 * The custom-scheme redirect URIs the endpoint's managed OAuth allows besides any loopback one (plan D13; M0's
 * `redirectAllowlist`): the named clients' that are not loopback. Claude Code, pi, Codex and OpenCode redirect to
 * `localhost` or `127.0.0.1` (captured in M0); current Cursor desktop is reported to use `localhost` and older Cursor
 * this scheme. **Pending owner step 2**: Cursor was not run in M0, so this URI comes from third-party reports, not a
 * capture; `m5a-stage-run.md` records Cursor's actual redirect. No https redirect (claude.ai and Cursor web are not
 * named clients).
 */
export const SETTINGS_OAUTH_REDIRECT_URIS: ReadonlyArray<string> = ["cursor://anysphere.cursor-mcp/oauth/callback"];

/** The managed-OAuth grant's lifetimes (plan D13): Access checks no bounds, so they are set explicitly (M0 P11). */
export const SETTINGS_OAUTH_GRANT = { accessTokenLifetime: "15m", sessionDuration: "168h" } as const;
