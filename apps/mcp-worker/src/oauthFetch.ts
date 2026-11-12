// The MCP Worker's fetch for OAuth (review M5): https only, no credentials in the URL, no redirect followed, bounded.
// @effect-diagnostics globalFetch:off asyncFunction:off
/** Each OAuth request's own bound. */
export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/** A fetch for OAuth: https only, no credentials in the URL, no redirect followed, bounded in time. */
export const guardedFetch =
  (base: typeof fetch = fetch) =>
  async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.protocol !== "https:") throw new Error(`OAuth requests go only to https URLs (not ${url.protocol})`);
    if (url.username !== "" || url.password !== "") throw new Error("OAuth URLs carry no credentials");
    return base(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS) });
  };

