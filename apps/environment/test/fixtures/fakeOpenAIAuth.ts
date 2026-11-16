// @effect-diagnostics globalDate:off
// A fake of OpenAI's "Sign in with ChatGPT" authorization server (SPI-1164), as its docs describe it
// (developers.openai.com/siwc/token-sharing-open-source): discovery, the JWKS, the authorize step (as a browser approval
// that answers with the loopback callback URL), the token endpoint (authorization code with PKCE, and rotating refresh
// tokens that refuse a replaced one with `invalid_grant`), and revocation. Its ID tokens are RS256 under a key it makes.
// It records every request, so a test can check what was sent and that no token leaks elsewhere.

const ISSUER = "https://auth.openai.com";
export const FAKE_URLS = {
  authorize: `${ISSUER}/api/accounts/authorize`,
  token: `${ISSUER}/api/accounts/oauth/token`,
  discovery: `${ISSUER}/.well-known/openid-configuration`,
  jwks: `${ISSUER}/.well-known/jwks.json`,
  revoke: `${ISSUER}/api/accounts/oauth/revoke`,
} as const;
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeJson = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

interface IssuedCode {
  readonly clientId: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly scope: string;
  used: boolean;
}

export interface FakeOpenAIOptions {
  readonly now?: () => number;
  /** The code exchange answers this OAuth error (a Free plan's `invalid_grant`). */
  exchangeError?: string | undefined;
  /** A refresh answers this OAuth error. */
  refreshError?: string | undefined;
  /** The scope granted (drop `chatgpt.tokens.use.direct` to decline plan usage). */
  grantedScope?: string;
  /** Each token response's `expires_in`. */
  expiresIn?: number;
  /** Held open until released: a refresh in flight. */
  refreshGate?: Promise<void> | undefined;
  /** A request to the token endpoint fails at the network. */
  tokenDown?: boolean;
}

export interface FakeOpenAI {
  readonly fetch: typeof fetch;
  readonly options: FakeOpenAIOptions;
  /** The owner's approval in the browser: the callback URL the browser lands on. */
  approve(authorizeUrl: string, account?: { readonly sub?: string; readonly email?: string }): string;
  readonly requests: Array<{ readonly url: string; readonly method: string; readonly body: string }>;
  /** Every token the fake issued (access, refresh and ID tokens), for leak scans. */
  readonly issued: Array<string>;
  readonly counts: { refreshes: number; exchanges: number; revocations: number };
  readonly revoked: Set<string>;
  /** The refresh token the fake honours now, by client. */
  currentRefresh(): string | undefined;
}

/** One RSA key pair for every fake in a test file: making one is slow, and the tests run side by side with others. */
let kept: Promise<CryptoKeyPair> | undefined;
const signingKeys = (): Promise<CryptoKeyPair> =>
  (kept ??= crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>);

export const fakeOpenAI = async (options: FakeOpenAIOptions = {}): Promise<FakeOpenAI> => {
  const now = options.now ?? Date.now;
  const keys = await signingKeys();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, IssuedCode>();
  const refreshTokens = new Map<string, { readonly clientId: string; alive: boolean; readonly sub: string; readonly email: string; readonly scope: string }>();
  const requests: FakeOpenAI["requests"] = [];
  const issued: Array<string> = [];
  const counts = { refreshes: 0, exchanges: 0, revocations: 0 };
  const revoked = new Set<string>();
  const accounts = new Map<string, { readonly sub: string; readonly email: string }>();
  let serial = 0;
  let current: string | undefined;
  const next = (prefix: string) => `${prefix}-${(serial += 1)}-${crypto.randomUUID()}`;
  const idToken = async (claims: Record<string, unknown>): Promise<string> => {
    const body = `${encodeJson({ alg: "RS256", kid: "fake-1", typ: "JWT" })}.${encodeJson(claims)}`;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body)));
    const token = `${body}.${base64url(signature)}`;
    issued.push(token);
    return token;
  };
  const tokens = async (clientId: string, account: { readonly sub: string; readonly email: string }, scope: string, nonce?: string) => {
    const access = next("at");
    const refresh = next("rt");
    issued.push(access, refresh);
    refreshTokens.set(refresh, { clientId, sub: account.sub, email: account.email, scope, alive: true });
    current = refresh;
    const seconds = Math.floor(now() / 1000);
    return {
      access_token: access,
      refresh_token: refresh,
      id_token: await idToken({ iss: ISSUER, aud: clientId, sub: account.sub, email: account.email, iat: seconds, exp: seconds + 3600, ...(nonce === undefined ? {} : { nonce }) }),
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      scope,
    };
  };
  const oauthError = (error: string, status = 400) => Response.json({ error }, { status });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    requests.push({ url, method, body });
    const path = url.split("?")[0];
    if (path === FAKE_URLS.discovery) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: FAKE_URLS.authorize, token_endpoint: FAKE_URLS.token, jwks_uri: FAKE_URLS.jwks, revocation_endpoint: FAKE_URLS.revoke });
    }
    if (path === FAKE_URLS.jwks) return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(body);
    if (path === FAKE_URLS.revoke && method === "POST") {
      counts.revocations += 1;
      const token = form.get("token") ?? "";
      revoked.add(token);
      const record = refreshTokens.get(token);
      if (record !== undefined) record.alive = false;
      return new Response(null, { status: 200 });
    }
    if (path === FAKE_URLS.token && method === "POST") {
      if (options.tokenDown === true) throw new TypeError("fetch failed");
      if (form.get("resource") !== "https://api.openai.com/v1") return oauthError("invalid_target");
      if (form.get("grant_type") === "authorization_code") {
        counts.exchanges += 1;
        if (options.exchangeError !== undefined) return oauthError(options.exchangeError);
        const code = codes.get(form.get("code") ?? "");
        if (code === undefined || code.used || code.clientId !== form.get("client_id") || code.redirectUri !== form.get("redirect_uri")) return oauthError("invalid_grant");
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")));
        if (base64url(digest) !== code.challenge) return oauthError("invalid_grant");
        code.used = true;
        return Response.json(await tokens(code.clientId, accounts.get(code.clientId) ?? { sub: "user-1", email: "owner@example.com" }, code.scope, code.nonce));
      }
      if (form.get("grant_type") === "refresh_token") {
        counts.refreshes += 1;
        await options.refreshGate;
        if (options.refreshError !== undefined) return oauthError(options.refreshError);
        const record = refreshTokens.get(form.get("refresh_token") ?? "");
        if (record === undefined || !record.alive || record.clientId !== form.get("client_id")) return oauthError("invalid_grant");
        record.alive = false;
        const answer = await tokens(record.clientId, record, record.scope);
        return Response.json({ access_token: answer.access_token, refresh_token: answer.refresh_token, token_type: "Bearer", expires_in: answer.expires_in, scope: answer.scope });
      }
      return oauthError("unsupported_grant_type");
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    fetch: fetcher,
    options,
    requests,
    issued,
    counts,
    revoked,
    currentRefresh: () => current,
    approve: (authorizeUrl, account = {}) => {
      const url = new URL(authorizeUrl);
      const params = url.searchParams;
      const requested = params.get("client_id") ?? "";
      const clientId = requested === "dynamic_agent_client" ? `oaiapp_${next("client")}` : requested;
      accounts.set(clientId, { sub: account.sub ?? "user-1", email: account.email ?? "owner@example.com" });
      const code = next("code");
      codes.set(code, {
        clientId,
        challenge: params.get("code_challenge") ?? "",
        redirectUri: params.get("redirect_uri") ?? "",
        nonce: params.get("nonce") ?? "",
        scope: options.grantedScope ?? SCOPE,
        used: false,
      });
      const callback = new URL(params.get("redirect_uri") ?? "");
      callback.searchParams.set("code", code);
      callback.searchParams.set("scope", options.grantedScope ?? SCOPE);
      callback.searchParams.set("state", params.get("state") ?? "");
      if (requested === "dynamic_agent_client") callback.searchParams.set("client_id", clientId);
      return callback.toString();
    },
  };
};
