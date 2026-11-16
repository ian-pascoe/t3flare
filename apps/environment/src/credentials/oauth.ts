// What the sign-in vendors (chatgpt.ts, claude.ts) share of OAuth: PKCE's encoding and challenge, random values, each
// request's bound, and reading an OAuth error's code from an answer without its body. Each vendor keeps its own URLs,
// bodies and the codes that end its sign-in.

/** Each request to a vendor's OAuth endpoints is bounded by this. */
export const OAUTH_TIMEOUT_MS = 15_000;

export const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** `bytes` random bytes, base64url-encoded (a state, a nonce, a PKCE verifier). */
export const random = (bytes: number): string => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** PKCE's S256 challenge for `verifier`. */
export const pkceChallenge = async (verifier: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An OAuth error's code from an answer's body (`{ error: "invalid_grant", … }`), or undefined; never the rest of it. */
export const oauthErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
};
