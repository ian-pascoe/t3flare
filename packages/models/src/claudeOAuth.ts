// The Claude subscription sign-in's OAuth facts (SPI-1165): Claude Code's public OAuth client and Anthropic's copy-code
// flow, as pi-ai 1.5.0 uses them (`dist/auth/oauth/anthropic.js`: `CLIENT_ID` :11, `AUTHORIZE_URL` :12, `TOKEN_URL` :13,
// `COPY_CODE_REDIRECT_URI` :20, `SCOPES` :23; the authorize parameters :174-183, the exchange's JSON body :88-95, the
// refresh's :209-213). The Environment runs its own start and exchange (credentials/claude.ts), because pi-ai's `login()`
// keeps its attempt in memory (SPI-1161 Q1); `apps/agents/test/claudeSignInShape.test.ts` runs pi-ai's own flow against
// these, so a pi-ai bump that changes any of them fails the check. No secret: the client is public, and has none.

/** Claude Code's OAuth client id (pi-ai keeps it base64-encoded; this is the decoded value). */
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Anthropic's page that shows the code to copy (`code#state`), for the copy-code flow. */
export const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/** The scope a Claude sign-in needs for model requests. */
export const CLAUDE_INFERENCE_SCOPE = "user:inference";

/**
 * How pi-ai tells a Claude subscription's access token from an API key (`isOAuthToken`, anthropic-messages.js:767): a
 * token holding this gets Claude Code's request shape (Bearer auth, its betas and identity). A Claude sign-in's token must
 * hold it, and an API key must not.
 */
export const CLAUDE_OAUTH_TOKEN_MARK = "sk-ant-oat";

/**
 * The request shape pi-ai gives a Claude subscription's token (anthropic-messages.js: `createClient` :786-801 for the
 * headers, `getBetaFeatures` :858-859 for the betas, `buildParams` :911-926 for the identity block, `claudeCodeVersion`
 * :45), which the model relay restates for a CLI's request on a Claude sign-in (SPI-1171): the CLI sends an API key's
 * shape with its handle, and the relay adds these. `apps/agents/test/claudeSignInShape.test.ts` pins them to pi-ai's wire.
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
/** The betas a subscription token's requests open with, before the request's own. */
export const CLAUDE_OAUTH_BETAS: ReadonlyArray<string> = ["claude-code-20250219", "oauth-2025-04-20"];
/** The headers a subscription token's requests carry beside the bearer (pi-ai's Claude Code identity headers). */
export const CLAUDE_OAUTH_HEADERS: Readonly<Record<string, string>> = {
  "anthropic-dangerous-direct-browser-access": "true",
  "user-agent": "claude-cli/2.1.280",
  "x-app": "cli",
};
