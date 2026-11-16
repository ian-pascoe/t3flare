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

/**
 * The options every request to a vendor's OAuth endpoints shares: bounded by `timeoutMs` (and the caller's overall
 * `deadline`, when it has one), and never following a redirect, which would carry a code or a token wherever it points.
 */
export const oauthRequestOptions = (options: { readonly deadline?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {}): Pick<RequestInit, "signal" | "redirect"> => {
  const own = AbortSignal.timeout(options.timeoutMs ?? OAUTH_TIMEOUT_MS);
  return { signal: options.deadline === undefined ? own : AbortSignal.any([own, options.deadline]), redirect: "manual" };
};

/**
 * What an error answer's body says, without the rest of it: whether it was JSON at all (an OAuth or API error, as
 * opposed to an edge's HTML page or nothing), and its OAuth error code (`{ error: "invalid_grant", … }`) when it has one.
 */
export const oauthErrorOf = async (response: Response): Promise<{ readonly json: boolean; readonly code: string | undefined }> => {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { json: false, code: undefined };
  }
  return { json: true, code: isRecord(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined };
};

/** An OAuth error's code from an answer's body, or undefined; never the rest of it. */
export const oauthErrorCode = async (response: Response): Promise<string | undefined> => (await oauthErrorOf(response)).code;
