// @effect-diagnostics globalDate:off globalTimers:off
// ChatGPT plan usage through "Sign in with ChatGPT" (SPI-1164), as OpenAI documents it for open-source clients
// (developers.openai.com/siwc/token-sharing-open-source: "Registration and sign-in", "Accounts and sessions", "Token
// reference", "Errors and recovery"). A public client, with no secret: the first sign-in registers a client through
// `dynamic_agent_client` and OpenAI's redirect names the issued `client_id` (`oaiapp_…`), which later sign-ins reuse.
//
// The redirect is the loopback `http://127.0.0.1:1455/auth/callback`, which nothing serves here: the browser lands on a
// page that does not load, and the owner pastes its address into the Harness panel (the spike, SPI-1161 Q2). So the
// attempt's state, nonce and PKCE verifier are kept durably (sealed, by the broker) between the start and the paste, never
// in an isolate's memory.
//
// Where pi-ai 1.5.0's `openai-chatgpt` flow differs from OpenAI's docs, the docs win: the ID token is checked (signature
// against OpenAI's JWKS, issuer, audience, expiry, nonce), a saved registration's client id is reused, the revocation
// endpoint comes from discovery, and the redirect port is 1455 from the first registration onward.
//
// Every failure is one of our fixed texts: never a token, a code, a verifier, or the vendor's body.

/** OpenAI's endpoints for this flow (the authorize and token URLs as the docs give them; the rest from discovery). */
export interface ChatGptUrls {
  readonly authorize: string;
  readonly token: string;
  readonly discovery: string;
}

export const CHATGPT_URLS: ChatGptUrls = {
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  discovery: "https://auth.openai.com/.well-known/openid-configuration",
};

const ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
/** The loopback redirect, port 1455 from the first registration onward (only the port may ever vary). */
export const CHATGPT_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_USAGE_SCOPE}`;
/** The app's name on OpenAI's consent page, the same on every installation (first registration only). */
const AGENT_NAME = "t3flare";
const TIMEOUT_MS = 15_000;
/** Clock skew allowed on the ID token's expiry. */
const SKEW_MS = 5 * 60_000;

/** A refresh answer that ends the sign-in (OpenAI's "unusable refresh token" codes, and a client it no longer accepts). */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

export interface ChatGptVendor {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly urls?: ChatGptUrls;
}

/** A sign-in started and not yet completed: kept sealed until the owner pastes the redirect. */
export interface PendingChatGptSignIn {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  /** The saved registration's issued client id (reauthorization), or null for a first registration. */
  readonly clientId: string | null;
  /** The saved registration's account: a reauthorization must return the same one. */
  readonly subject: string | null;
  readonly startedAt: number;
}

/**
 * A signed-in credential, in pi-ai's `OAuthCredential` shape (`{ type: "oauth", access, refresh, expires, …extras }`).
 * `expires` is the access token's real expiry (ms); the broker refreshes before it.
 */
export interface ChatGptCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly subject: string;
  readonly email: string | null;
  /** Kept for `id_token_hint`; never sent anywhere but OpenAI's authorize endpoint. */
  readonly idToken?: string;
  /** OpenAI's `earliest_refresh_at` (ms): no refresh before it. */
  readonly earliestRefreshAt: number | null;
  readonly [key: string]: unknown;
}

/** What is kept of an account after sign-out, for the next sign-in (OpenAI: retain the account/client mapping). */
export interface ChatGptRegistration {
  readonly clientId: string;
  readonly email?: string | null;
  readonly subject?: string | null;
}

export type ChatGptSignInResult =
  | { readonly ok: true; readonly credential: ChatGptCredential }
  /**
   * `spent`: the code was exchanged (or refused), so the attempt is over; otherwise the owner may paste again. `clientId`:
   * the client a first registration was issued, kept for the next attempt (OpenAI: start again with the issued id).
   */
  | { readonly ok: false; readonly problem: string; readonly spent?: boolean; readonly clientId?: string };

export type ChatGptRefreshResult =
  | { readonly ok: true; readonly credential: ChatGptCredential }
  /** `refused`: OpenAI ended the sign-in (sign in again); otherwise a passing failure (retry). */
  | { readonly ok: false; readonly refused: boolean; readonly code?: string; readonly problem: string };

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unbase64url = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
const random = (bytes: number): string => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A new attempt: its authorize URL for the owner's browser, and what the paste is checked against. */
export const startChatGptSignIn = async (input: {
  readonly hostId: string;
  readonly registration?: ChatGptRegistration;
  readonly now?: () => number;
  readonly urls?: ChatGptUrls;
}): Promise<{ readonly authorizeUrl: string; readonly pending: PendingChatGptSignIn }> => {
  const pending: PendingChatGptSignIn = {
    state: random(32),
    nonce: random(32),
    verifier: random(64),
    redirectUri: CHATGPT_REDIRECT_URI,
    clientId: input.registration?.clientId ?? null,
    subject: input.registration?.subject ?? null,
    startedAt: (input.now ?? Date.now)(),
  };
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier))));
  const url = new URL((input.urls ?? CHATGPT_URLS).authorize);
  url.search = new URLSearchParams({
    client_id: pending.clientId ?? "dynamic_agent_client",
    ...(pending.clientId === null ? { agent_name_hint: AGENT_NAME } : typeof input.registration?.email === "string" ? { login_hint: input.registration.email } : {}),
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: pending.redirectUri,
    scope: SCOPE,
    resource: CHATGPT_RESOURCE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();
  return { authorizeUrl: url.toString(), pending };
};

/** The pasted redirect as a URL: the whole address, without its scheme, or only its query (from a phone). */
const pastedUrl = (pasted: string, redirectUri: string): URL | string => {
  const text = pasted.trim();
  const expected = new URL(redirectUri);
  const whole = "Paste the whole address your browser landed on after ChatGPT's approval (it starts http://127.0.0.1:1455/auth/callback).";
  if (!text.includes("=")) return whole;
  let url: URL;
  try {
    if (text.startsWith("?") || /^(?:code|state|error|scope|client_id)=/.test(text)) url = new URL(`${redirectUri}${text.startsWith("?") ? "" : "?"}${text}`);
    else url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return whole;
  }
  if (url.hostname !== expected.hostname || url.pathname !== expected.pathname) {
    return "That is not the address your browser landed on: it starts http://127.0.0.1:1455/auth/callback.";
  }
  if (!url.searchParams.has("state") || (!url.searchParams.has("code") && !url.searchParams.has("error"))) return whole;
  return url;
};

const post = async (vendor: ChatGptVendor, url: string, form: Record<string, string>): Promise<Response> =>
  vendor.fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "manual",
  });

/** An OAuth error's code from an answer's body, or undefined. */
const errorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
};

interface TokenAnswer {
  readonly access: string;
  readonly refresh: string | undefined;
  readonly idToken: string | undefined;
  readonly expiresIn: number;
  readonly scopes: ReadonlyArray<string>;
  readonly earliestRefreshAt: number | null;
}

const tokenAnswer = (body: unknown): TokenAnswer | undefined => {
  if (!isRecord(body)) return undefined;
  const { access_token, refresh_token, id_token, token_type, expires_in, scope, earliest_refresh_at } = body;
  if (typeof access_token !== "string" || access_token === "" || typeof token_type !== "string" || token_type.toLowerCase() !== "bearer") return undefined;
  if (typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0 || typeof scope !== "string") return undefined;
  const earliest = typeof earliest_refresh_at === "number" ? earliest_refresh_at * 1000 : typeof earliest_refresh_at === "string" ? Date.parse(earliest_refresh_at) : Number.NaN;
  return {
    access: access_token,
    refresh: typeof refresh_token === "string" && refresh_token !== "" ? refresh_token : undefined,
    idToken: typeof id_token === "string" && id_token !== "" ? id_token : undefined,
    expiresIn: expires_in,
    scopes: scope.split(/\s+/).filter(Boolean),
    earliestRefreshAt: Number.isFinite(earliest) ? earliest : null,
  };
};

const getJson = async (vendor: ChatGptVendor, url: string): Promise<unknown> => {
  const response = await vendor.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const discovery = async (vendor: ChatGptVendor): Promise<{ readonly issuer: string; readonly jwksUri: string; readonly revocation: string | undefined }> => {
  const body = await getJson(vendor, (vendor.urls ?? CHATGPT_URLS).discovery);
  if (!isRecord(body) || typeof body.issuer !== "string" || typeof body.jwks_uri !== "string") throw new Error("discovery");
  return { issuer: body.issuer, jwksUri: body.jwks_uri, revocation: typeof body.revocation_endpoint === "string" ? body.revocation_endpoint : undefined };
};

/** The ID token's claims once its signature (RS256, OpenAI's JWKS), issuer, audience, expiry and nonce check out. */
const verifiedIdToken = async (vendor: ChatGptVendor, token: string, clientId: string, nonce: string): Promise<{ readonly sub: string; readonly email: string | null } | undefined> => {
  const [head, body, signature] = token.split(".");
  if (head === undefined || body === undefined || signature === undefined) return undefined;
  const header: unknown = JSON.parse(new TextDecoder().decode(unbase64url(head)));
  const claims: unknown = JSON.parse(new TextDecoder().decode(unbase64url(body)));
  if (!isRecord(header) || header.alg !== "RS256" || !isRecord(claims)) return undefined;
  const found = await discovery(vendor);
  if (found.issuer !== ISSUER) return undefined;
  const jwks = await getJson(vendor, found.jwksUri);
  const keys = isRecord(jwks) && Array.isArray(jwks.keys) ? jwks.keys.filter(isRecord) : [];
  const jwk = keys.find((key) => key.kty === "RSA" && (header.kid === undefined || key.kid === header.kid));
  if (jwk === undefined) return undefined;
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: String(jwk.n), e: String(jwk.e) }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unbase64url(signature), new TextEncoder().encode(`${head}.${body}`)))) return undefined;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audience.includes(clientId) || claims.nonce !== nonce) return undefined;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < vendor.now() - SKEW_MS || typeof claims.sub !== "string" || claims.sub === "") return undefined;
  return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
};

const exchangeProblem = (status: number, code: string | undefined): string =>
  code === "invalid_grant"
    ? "OpenAI refused the sign-in code (invalid_grant). ChatGPT plan usage needs a ChatGPT Plus or Pro plan: on another plan this is the expected answer. Otherwise the code expired or was already used: start the sign-in again."
    : code === "invalid_client"
      ? "OpenAI refused this app's client registration (invalid_client): start the sign-in again."
      : `OpenAI did not complete the sign-in (HTTP ${status}${code === undefined ? "" : `, ${code}`}): start it again.`;

/** Completes `pending` with the owner's pasted redirect: the code exchanged, the ID token and plan-usage scope checked. */
export const completeChatGptSignIn = async (vendor: ChatGptVendor, pending: PendingChatGptSignIn, pasted: string): Promise<ChatGptSignInResult> => {
  const url = pastedUrl(pasted, pending.redirectUri);
  if (typeof url === "string") return { ok: false, problem: url };
  const params = url.searchParams;
  if (params.get("state") !== pending.state) return { ok: false, problem: "This address does not belong to the sign-in in progress: start the sign-in again and paste the address it leads to." };
  const error = params.get("error");
  if (error !== null) {
    return {
      ok: false,
      problem: error === "access_denied" ? "ChatGPT's approval was declined: start the sign-in again when you are ready." : "ChatGPT did not approve the sign-in: start it again.",
    };
  }
  const code = params.get("code") ?? "";
  const returned = params.get("client_id");
  const clientId = pending.clientId ?? returned;
  if (clientId === null || !clientId.startsWith("oaiapp_") || (pending.clientId !== null && returned !== null && returned !== pending.clientId)) {
    return { ok: false, problem: "ChatGPT's redirect did not name this app's registration: start the sign-in again." };
  }
  let response: Response;
  try {
    response = await post(vendor, (vendor.urls ?? CHATGPT_URLS).token, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource: CHATGPT_RESOURCE,
    });
  } catch {
    return { ok: false, problem: "OpenAI's token endpoint could not be reached: paste the address again, or start again." };
  }
  const spent = { spent: true, ...(pending.clientId === null ? { clientId } : {}) } as const;
  if (!response.ok) return { ok: false, problem: exchangeProblem(response.status, await errorCode(response)), ...spent };
  const answer = tokenAnswer(await response.json().catch(() => undefined));
  if (answer === undefined || answer.refresh === undefined || answer.idToken === undefined) return { ok: false, problem: "OpenAI's answer to the sign-in was not a usable token set: start the sign-in again.", ...spent };
  const identity = await verifiedIdToken(vendor, answer.idToken, clientId, pending.nonce).catch(() => undefined);
  if (identity === undefined) return { ok: false, problem: "The sign-in could not be verified (OpenAI's ID token did not check out): start it again.", ...spent };
  if (pending.subject !== null && identity.sub !== pending.subject) {
    return { ok: false, problem: "This sign-in returned another ChatGPT account than the one saved: sign out first to change accounts.", ...spent };
  }
  if (!answer.scopes.includes(PLAN_USAGE_SCOPE)) {
    return { ok: false, problem: "Signed in, but ChatGPT did not allow ChatGPT plan usage for t3flare: start again and allow it (it needs a Plus or Pro plan).", ...spent };
  }
  return {
    ok: true,
    credential: {
      type: "oauth",
      access: answer.access,
      refresh: answer.refresh,
      expires: vendor.now() + answer.expiresIn * 1000,
      clientId,
      scopes: answer.scopes,
      subject: identity.sub,
      email: identity.email,
      idToken: answer.idToken,
      earliestRefreshAt: answer.earliestRefreshAt,
    },
  };
};

/** A refresh at OpenAI: the new access token with its replacement refresh token, or why not. */
export const refreshChatGpt = async (vendor: ChatGptVendor, credential: ChatGptCredential): Promise<ChatGptRefreshResult> => {
  let response: Response;
  try {
    response = await post(vendor, (vendor.urls ?? CHATGPT_URLS).token, {
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refresh,
      resource: CHATGPT_RESOURCE,
    });
  } catch {
    return { ok: false, refused: false, problem: "OpenAI's token endpoint could not be reached to renew the ChatGPT sign-in" };
  }
  if (!response.ok) {
    const code = await errorCode(response);
    if (code !== undefined && REFUSED_CODES.has(code)) return { ok: false, refused: true, code, problem: `ChatGPT refused to renew the sign-in (${code})` };
    return { ok: false, refused: false, ...(code === undefined ? {} : { code }), problem: `OpenAI did not renew the ChatGPT sign-in (HTTP ${response.status})` };
  }
  const answer = tokenAnswer(await response.json().catch(() => undefined));
  if (answer === undefined) return { ok: false, refused: false, problem: "OpenAI's renewal was not a usable token set" };
  if (!answer.scopes.includes(PLAN_USAGE_SCOPE)) return { ok: false, refused: true, code: "plan_usage_disabled", problem: "ChatGPT plan usage is no longer allowed for t3flare" };
  return {
    ok: true,
    credential: {
      ...credential,
      access: answer.access,
      // OpenAI always rotates it; a renewal without one keeps the current token.
      refresh: answer.refresh ?? credential.refresh,
      expires: vendor.now() + answer.expiresIn * 1000,
      scopes: answer.scopes,
      earliestRefreshAt: answer.earliestRefreshAt,
    },
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ends the renewable session at OpenAI: the refresh token posted to discovery's revocation endpoint (an empty 200 is
 * success, also for a token already invalid). A network failure or 5xx is retried twice; `confirmed` false otherwise.
 */
export const revokeChatGpt = async (vendor: ChatGptVendor, credential: Pick<ChatGptCredential, "refresh" | "clientId">): Promise<{ readonly confirmed: boolean }> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let retry = true;
    try {
      const { revocation } = await discovery(vendor);
      if (revocation === undefined) return { confirmed: false };
      const response = await post(vendor, revocation, { token: credential.refresh, token_type_hint: "refresh_token", client_id: credential.clientId });
      if (response.status === 200) return { confirmed: true };
      retry = response.status >= 500;
    } catch {
      retry = true;
    }
    if (!retry || attempt === 2) break;
    await sleep(attempt === 0 ? 250 : 1_000);
  }
  return { confirmed: false };
};
