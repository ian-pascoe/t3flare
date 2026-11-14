// Where the Owner-client endpoint lives (ADR-0034, plan D13), M5a (SPI-1200): layout (B), chosen by M0 (SPI-1196,
// `docs/steps/settings-mcp/m0-access-oauth.json`). Everything that knows the layout is here, in `worker.ts`'s one branch,
// and in `alchemy.run.ts`'s `SettingsAccess` application, so layout (C) (a Worker on its own host serving its own
// well-known documents, which calls `EnvironmentDO.settingsMcp` the same way) would replace these and nothing else: the
// DO takes an already-verified caller either way, and moving costs only the clients' URL.
//
// (B): the endpoint is `https://<host>/_t3flare/mcp` on the Environment's own host, behind a path-scoped Access
// application of its own with managed OAuth on (M0: the more specific path wins, so `/_t3flare/mcp` and below are this
// application's and `/_t3flare/mcpx` stays the panel's; each application gets its own path cookie; a token of one is
// refused at the other's paths; Access answers no root or path-inserted well-known document, so clients discover it from
// the 401's `resource_metadata`). Pending the owner's confirmation with a real OAuth token (M0 owner step 1, P6 and P12).

/** The endpoint's path on the Environment host. */
export const SETTINGS_MCP_PATH = "/_t3flare/mcp";

/** Whether `pathname` is the endpoint's Access application's: the endpoint, or anything below it (answered 404). */
export const isSettingsMcpPath = (pathname: string): boolean => pathname === SETTINGS_MCP_PATH || pathname.startsWith(`${SETTINGS_MCP_PATH}/`);

/** The endpoint's URL for a host. */
export const settingsMcpUrl = (host: string): string => `https://${host}${SETTINGS_MCP_PATH}`;

/**
 * The custom-scheme redirect URIs the endpoint's managed OAuth allows besides any loopback one (plan D13; M0's
 * `redirectAllowlist`): the named clients' that are not loopback. Claude Code, pi, Codex and OpenCode redirect to
 * `localhost` or `127.0.0.1`; current Cursor desktop to `localhost` and older Cursor to this scheme. No https redirect
 * (claude.ai and Cursor web are not named clients).
 */
export const SETTINGS_OAUTH_REDIRECT_URIS: ReadonlyArray<string> = ["cursor://anysphere.cursor-mcp/oauth/callback"];

/** The managed-OAuth grant's lifetimes (plan D13): Access checks no bounds, so they are set explicitly (M0 P11). */
export const SETTINGS_OAUTH_GRANT = { accessTokenLifetime: "15m", sessionDuration: "168h" } as const;
