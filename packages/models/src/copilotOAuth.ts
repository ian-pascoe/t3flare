// The GitHub Copilot sign-in's facts (SPI-1166): GitHub's device flow with the Copilot editor client, the exchange of the
// GitHub token for a short-lived Copilot token, and the headers and base URL a Copilot request takes, as pi-ai 1.5.0 uses
// them (`dist/auth/oauth/github-copilot.js`: `CLIENT_ID` :9, `COPILOT_HEADERS` :10-15, `getUrls` :29-35, the device code
// request :155-196, the poll :197-236, the Copilot token :237-263, `getBaseUrlFromToken` :41-49 and
// `getGitHubCopilotBaseUrl` :50-61, the model list's rules `parseGitHubCopilotModelCatalog` :65-100). The Environment runs its own start and poll (credentials/copilot.ts), because pi-ai's
// `login()` keeps its attempt in memory (SPI-1161 Q1); `apps/agents/test/copilotSignInShape.test.ts` runs pi-ai's own
// flow against these, so a pi-ai bump that changes any of them fails the check. No secret: the client is public, and has
// none (so GitHub's revocation API, which takes the client's secret, is closed to us).

/** The Copilot editor's GitHub client id (pi-ai keeps it base64-encoded; this is the decoded value). */
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_SCOPE = "read:user";
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
/** The device flow's grant type (RFC 8628). */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** The user agent of the device flow's requests. */
export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";

/**
 * The editor headers every Copilot request takes, the Copilot token's exchange included (pi-ai's `COPILOT_HEADERS`, also
 * on every model of its Copilot catalog). The Credential broker gives them with the token; they are never an endpoint's.
 */
export const COPILOT_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": COPILOT_USER_AGENT,
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/** The API version Copilot's model list is read with (pi-ai's `COPILOT_API_VERSION` :16, sent on `/models` only). */
export const COPILOT_LIST_HEADERS: Readonly<Record<string, string>> = { "X-GitHub-Api-Version": "2026-06-01" };

/** Where a Copilot token without a proxy endpoint is sent (pi-ai's fallback for github.com). */
export const COPILOT_DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

/** A Copilot API host: GitHub Copilot's own domain only, so a token never goes elsewhere whatever it names. */
const COPILOT_HOST = /^(?:[a-z0-9-]+\.)+githubcopilot\.com$/;

/**
 * A Copilot token's API base URL, pi-ai's way: its `proxy-ep=proxy.<x>` field read as `https://api.<x>`, else the
 * default. Undefined when the token names a host outside GitHub Copilot's domain (such a token is not used).
 */
export const copilotBaseUrl = (token: string): string | undefined => {
  const match = /proxy-ep=([^;]+)/.exec(token);
  if (match === null) return COPILOT_DEFAULT_BASE_URL;
  const host = match[1]!.trim().toLowerCase().replace(/^proxy\./, "api.");
  return COPILOT_HOST.test(host) ? `https://${host}` : undefined;
};
