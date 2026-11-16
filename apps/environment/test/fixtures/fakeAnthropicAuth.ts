// A fake of Anthropic's OAuth for a Claude subscription (SPI-1165), as pi-ai 1.5.0's copy-code flow uses it and the
// spike saw it (SPI-1161 Q1, Q5, Sign-out): the authorize step at claude.ai as a browser approval that answers with the
// `code#state` Anthropic's page shows; the token endpoint (JSON; the authorization code with PKCE and its state, and
// refresh tokens that rotate on every refresh and refuse a replaced one with `invalid_grant`); and no revocation endpoint
// (404, as `platform.claude.com/v1/oauth/revoke` answered). It records every request, so a test can check what was sent
// and that no token leaks elsewhere.
import { CLAUDE_AUTHORIZE_URL, CLAUDE_CLIENT_ID, CLAUDE_INFERENCE_SCOPE, CLAUDE_SCOPES, CLAUDE_TOKEN_URL } from "@t3flare/models/claudeOAuth";

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The scope Anthropic grants: what was asked, less `org:create_api_key` (the spike's grant lacked it). */
const GRANTED = CLAUDE_SCOPES.split(" ")
  .filter((scope) => scope !== "org:create_api_key")
  .join(" ");

interface IssuedCode {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly account: { readonly uuid: string; readonly email: string };
  used: boolean;
}

export interface FakeAnthropicOptions {
  /** The code exchange answers this OAuth error. */
  exchangeError?: string | undefined;
  /** A refresh answers this OAuth error. */
  refreshError?: string | undefined;
  /** A refresh answers this HTTP status with no OAuth error (a passing failure). */
  refreshStatus?: number | undefined;
  /** The scope granted (drop `user:inference` to decline model use). */
  grantedScope?: string;
  /** Each token response's `expires_in` (Anthropic's: 8 h). */
  expiresIn?: number;
  /** The access tokens it issues lack Anthropic's `sk-ant-oat` form. */
  plainTokens?: boolean;
  /** Held open until released, and signalled on arrival. */
  refreshGate?: Promise<void> | undefined;
  onRefresh?: (() => void) | undefined;
  exchangeGate?: Promise<void> | undefined;
  onExchange?: (() => void) | undefined;
  /** A request to the token endpoint fails at the network. */
  tokenDown?: boolean;
}

export interface FakeAnthropic {
  readonly fetch: typeof fetch;
  readonly options: FakeAnthropicOptions;
  /** The owner's approval at claude.ai: the text Anthropic's page shows to copy, `code#state`. */
  approve(authorizeUrl: string, account?: { readonly uuid?: string; readonly email?: string }): string;
  readonly requests: Array<{ readonly url: string; readonly method: string; readonly body: string }>;
  /** Every token it issued (access and refresh), for leak scans. */
  readonly issued: Array<string>;
  readonly accessTokens: Array<string>;
  /** Everything secret it saw or made: tokens, codes, and each attempt's state, challenge and verifier. */
  secrets(): ReadonlyArray<string>;
  readonly counts: { refreshes: number; exchanges: number; other: number };
  /** The refresh token it honours now. */
  currentRefresh(): string | undefined;
}

export const fakeAnthropic = (options: FakeAnthropicOptions = {}): FakeAnthropic => {
  const codes = new Map<string, IssuedCode>();
  const refreshTokens = new Map<string, { alive: boolean; readonly account: IssuedCode["account"]; readonly scope: string }>();
  const requests: FakeAnthropic["requests"] = [];
  const issued: Array<string> = [];
  const accessTokens: Array<string> = [];
  const seen: Array<string> = [];
  const counts = { refreshes: 0, exchanges: 0, other: 0 };
  let serial = 0;
  let current: string | undefined;
  const next = (prefix: string) => `${prefix}${(serial += 1)}-${crypto.randomUUID()}`;
  const tokens = (account: IssuedCode["account"], scope: string) => {
    const access = next(options.plainTokens === true ? "at-" : "sk-ant-oat01-");
    const refresh = next("sk-ant-ort01-");
    issued.push(access, refresh);
    accessTokens.push(access);
    refreshTokens.set(refresh, { alive: true, account, scope });
    current = refresh;
    return {
      token_type: "Bearer",
      access_token: access,
      refresh_token: refresh,
      expires_in: options.expiresIn ?? 28_800,
      refresh_token_expires_in: 2_592_000,
      scope,
      token_uuid: crypto.randomUUID(),
      account: { uuid: account.uuid, email_address: account.email },
      organization: { uuid: "org-1", name: "Owner's Organization" },
    };
  };
  const oauthError = (error: string, status = 400) => Response.json({ error, error_description: "Refresh token not found or invalid" }, { status });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method, body });
    if (url !== CLAUDE_TOKEN_URL || method !== "POST") {
      counts.other += 1;
      return new Response("not found", { status: 404 });
    }
    let form: Record<string, unknown>;
    try {
      form = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return oauthError("invalid_request");
    }
    for (const name of ["code", "code_verifier", "state", "refresh_token"]) if (typeof form[name] === "string") seen.push(form[name]);
    if (options.tokenDown === true) throw new TypeError("fetch failed");
    if (new Headers(init?.headers).get("content-type") !== "application/json") return oauthError("invalid_request");
    if (form.client_id !== CLAUDE_CLIENT_ID) return oauthError("invalid_client", 401);
    if (form.grant_type === "authorization_code") {
      counts.exchanges += 1;
      options.onExchange?.();
      await options.exchangeGate;
      if (options.exchangeError !== undefined) return oauthError(options.exchangeError);
      // pi-ai's exchange body, exactly (claudeSignInShape.test.ts pins it against pi-ai's own flow).
      if (Object.keys(form).sort().join() !== "client_id,code,code_verifier,grant_type,redirect_uri,state") return oauthError("invalid_request");
      const code = codes.get(String(form.code));
      if (code === undefined || code.used || code.redirectUri !== form.redirect_uri || code.state !== form.state) return oauthError("invalid_grant");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(form.code_verifier))));
      if (base64url(digest) !== code.challenge) return oauthError("invalid_grant");
      code.used = true;
      return Response.json(tokens(code.account, options.grantedScope ?? GRANTED));
    }
    if (form.grant_type === "refresh_token") {
      counts.refreshes += 1;
      options.onRefresh?.();
      await options.refreshGate;
      if (options.refreshError !== undefined) return oauthError(options.refreshError);
      if (options.refreshStatus !== undefined) return new Response("upstream trouble", { status: options.refreshStatus });
      const record = refreshTokens.get(String(form.refresh_token));
      if (record === undefined || !record.alive) return oauthError("invalid_grant");
      // Every refresh rotates it; the replaced one is refused from now on (SPI-1161 Q5).
      record.alive = false;
      return Response.json(tokens(record.account, record.scope));
    }
    return oauthError("unsupported_grant_type");
  }) as typeof fetch;
  return {
    fetch: fetcher,
    options,
    requests,
    issued,
    accessTokens,
    secrets: () => [...issued, ...seen, ...codes.keys()],
    counts,
    currentRefresh: () => current,
    approve: (authorizeUrl, account = {}) => {
      const url = new URL(authorizeUrl);
      if (`${url.origin}${url.pathname}` !== CLAUDE_AUTHORIZE_URL) throw new Error(`not Anthropic's authorize URL: ${url.origin}${url.pathname}`);
      const params = url.searchParams;
      for (const name of ["state", "code_challenge"]) if (params.get(name)) seen.push(params.get(name)!);
      if (params.get("client_id") !== CLAUDE_CLIENT_ID || params.get("code_challenge_method") !== "S256" || !(params.get("scope") ?? "").includes(CLAUDE_INFERENCE_SCOPE)) {
        throw new Error("Anthropic would refuse this authorize request");
      }
      const code = next("code-");
      const state = params.get("state") ?? "";
      codes.set(code, {
        challenge: params.get("code_challenge") ?? "",
        redirectUri: params.get("redirect_uri") ?? "",
        state,
        account: { uuid: account.uuid ?? "acct-1", email: account.email ?? "owner@example.com" },
        used: false,
      });
      return `${code}#${state}`;
    },
  };
};
