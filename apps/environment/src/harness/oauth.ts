// @effect-diagnostics globalDate:off globalConsole:off asyncFunction:off
// OAuth sign-ins for direct MCP servers (review M4, ADR-0010's and ADR-0012's refinements; cloudpid ADR-0034's model):
// the owner starts one in the harness panel, the server's authorization server sends the browser back to a public exact
// path on the admin host (an Access Bypass application covers only it and the client metadata document), and the
// Environment DO keeps the client and the tokens write-only in its secret store. Every outbound request (discovery,
// registration, the token exchange, each refresh) is the MCP Worker's (`McpOAuth`, review M5).
//
// - `state`: 256 random bits, single use, 10 minutes, bound to the server it was made for.
// - PKCE (S256) always; the verifier never leaves this object but to the MCP Worker for the exchange.
// - RFC 9207: an `iss` that differs from the authorization server's issuer is refused, and a server that says it sends
//   `iss` must send it.
// - Refresh: one in flight per server; a refreshed token replaces the old one at once (rotating refresh tokens).
import type { HarnessSecrets } from "./secrets.ts";
import type { KvStorage } from "./store.ts";

export const OAUTH_CALLBACK_PATH = "/_t3flare/harness/oauth/callback";
export const OAUTH_CLIENT_PATH = "/_t3flare/harness/oauth/client.json";
/** The admin host's public paths (the Access Bypass application's): nothing else of the panel is reachable unsigned. */
export const OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set([OAUTH_CALLBACK_PATH, OAUTH_CLIENT_PATH]);

export const STATE_TTL_MS = 10 * 60_000;
/** A token is refreshed this long before it expires. */
export const REFRESH_MARGIN_MS = 60_000;

interface ClientInformation {
  readonly client_id: string;
  readonly client_secret?: string;
  readonly [key: string]: unknown;
}

interface Tokens {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

interface Metadata {
  readonly issuer?: string;
  readonly authorization_response_iss_parameter_supported?: boolean;
  readonly [key: string]: unknown;
}

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** The MCP Worker's `McpOAuth` entrypoint, as bound (`MCP_OAUTH`). */
export interface McpOAuthBinding {
  begin(input: { serverUrl: string; redirectUrl: string; clientMetadataUrl: string; clientName: string; state: string; client?: ClientInformation }): Promise<
    Answer<{ authorizationUrl: string; codeVerifier: string; client: ClientInformation; authorizationServerUrl: string; metadata?: Metadata; resource?: string; registration: string }>
  >;
  exchange(input: { authorizationServerUrl: string; metadata?: Metadata; client: ClientInformation; resource?: string; code: string; codeVerifier: string; redirectUrl: string }): Promise<Answer<Tokens>>;
  refresh(input: { authorizationServerUrl: string; metadata?: Metadata; client: ClientInformation; resource?: string; refreshToken: string }): Promise<Answer<Tokens>>;
}

/** What is kept of a server's authorization server (no secret). */
interface AuthServer {
  readonly authorizationServerUrl: string;
  readonly metadata?: Metadata;
  readonly resource?: string;
}

interface PendingState extends AuthServer {
  readonly server: string;
  readonly codeVerifier: string;
  readonly client: ClientInformation;
  readonly expiresAt: number;
}

interface KeptTokens {
  readonly access: string;
  readonly refresh?: string;
  readonly expiresAt?: number;
}

const stateKey = (state: string) => `t3flare:harness:oauth:state:${state}`;
const asKey = (server: string) => `t3flare:harness:oauth:as:${server}`;

export interface OAuthDeps {
  readonly kv: KvStorage & { delete(key: string): unknown };
  readonly secrets: HarnessSecrets;
  readonly engine: McpOAuthBinding | undefined;
  /** The admin host (`T3FLARE_HARNESS_HOST`). */
  readonly host: string;
  readonly now?: () => number;
  readonly audit?: (entry: { readonly action: string; readonly target: string; readonly after?: unknown }) => void;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (status: number, title: string, text: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><p>${escapeHtml(text)}</p>\n`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'", "referrer-policy": "no-referrer", "x-frame-options": "DENY" },
  });

const randomState = () => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export class HarnessOAuth {
  readonly #deps: OAuthDeps;
  readonly #refreshing = new Map<string, Promise<string | undefined>>();

  constructor(deps: OAuthDeps) {
    this.#deps = deps;
  }

  #now() {
    return this.#deps.now?.() ?? Date.now();
  }

  get redirectUrl(): string {
    return `https://${this.#deps.host}${OAUTH_CALLBACK_PATH}`;
  }

  get clientMetadataUrl(): string {
    return `https://${this.#deps.host}${OAUTH_CLIENT_PATH}`;
  }

  /** Our Client ID Metadata Document (served publicly at OAUTH_CLIENT_PATH). */
  clientDocument(): Response {
    return Response.json(
      {
        client_id: this.clientMetadataUrl,
        client_name: `t3flare (${this.#deps.host})`,
        redirect_uris: [this.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  }

  #client(server: string): ClientInformation | undefined {
    const kept = this.#deps.secrets.read(server, "oauth-client");
    return kept === undefined ? undefined : (JSON.parse(kept) as ClientInformation);
  }

  #tokens(server: string): KeptTokens | undefined {
    const kept = this.#deps.secrets.read(server, "oauth-tokens");
    return kept === undefined ? undefined : (JSON.parse(kept) as KeptTokens);
  }

  async #keepTokens(server: string, tokens: Tokens, previous?: KeptTokens): Promise<KeptTokens> {
    const kept: KeptTokens = {
      access: tokens.access_token,
      ...((tokens.refresh_token ?? previous?.refresh) === undefined ? {} : { refresh: (tokens.refresh_token ?? previous?.refresh)! }),
      ...(tokens.expires_in === undefined ? {} : { expiresAt: this.#now() + tokens.expires_in * 1000 }),
    };
    await this.#deps.secrets.put(server, "oauth-tokens", JSON.stringify(kept));
    return kept;
  }

  /** Whether `server` holds tokens, and until when (no value). */
  status(server: string): { readonly signedIn: boolean; readonly expiresAt: number | null; readonly refreshable: boolean } {
    const tokens = this.#tokens(server);
    return { signedIn: tokens !== undefined, expiresAt: tokens?.expiresAt ?? null, refreshable: tokens?.refresh !== undefined };
  }

  /** Starts a sign-in to `server` at `serverUrl`: the URL the owner's browser opens. */
  async begin(server: string, serverUrl: string): Promise<Answer<{ readonly authorizationUrl: string; readonly registration: string }>> {
    if (this.#deps.engine === undefined) return { ok: false, error: "the MCP Worker's OAuth entrypoint is not bound" };
    const state = randomState();
    const kept = this.#client(server);
    const answer = await this.#deps.engine.begin({
      serverUrl,
      redirectUrl: this.redirectUrl,
      clientMetadataUrl: this.clientMetadataUrl,
      clientName: `t3flare (${this.#deps.host})`,
      state,
      ...(kept === undefined ? {} : { client: kept }),
    });
    if (!answer.ok) return answer;
    const { codeVerifier, client, authorizationServerUrl, metadata, resource } = answer.value;
    if (kept === undefined) await this.#deps.secrets.put(server, "oauth-client", JSON.stringify(client));
    const pending: PendingState = {
      server,
      codeVerifier,
      client,
      authorizationServerUrl,
      ...(metadata === undefined ? {} : { metadata }),
      ...(resource === undefined ? {} : { resource }),
      expiresAt: this.#now() + STATE_TTL_MS,
    };
    this.#deps.kv.put(stateKey(state), pending);
    this.#deps.audit?.({ action: "mcp.oauth.begin", target: server, after: { registration: answer.value.registration, authorizationServer: authorizationServerUrl } });
    return { ok: true, value: { authorizationUrl: answer.value.authorizationUrl, registration: answer.value.registration } };
  }

  /** The authorization server's redirect back (public, Access Bypass): the code exchanged, the tokens kept. */
  async callback(url: URL): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    if (!/^[0-9a-f]{64}$/.test(state)) return page(400, "Sign-in refused", "This sign-in link is not one t3flare started.");
    const pending = this.#deps.kv.get<PendingState>(stateKey(state));
    // Single use: gone whatever happens next.
    this.#deps.kv.delete(stateKey(state));
    if (pending === undefined || pending.expiresAt < this.#now()) return page(400, "Sign-in refused", "This sign-in expired or was already used; start it again from the harness panel.");
    const error = url.searchParams.get("error");
    if (error !== null) {
      this.#deps.audit?.({ action: "mcp.oauth.refused", target: pending.server, after: { error: error.slice(0, 100) } });
      return page(400, "Sign-in refused", `The server refused the sign-in: ${error.slice(0, 100)}`);
    }
    const issuer = pending.metadata?.issuer;
    const iss = url.searchParams.get("iss");
    if ((iss !== null && issuer !== undefined && iss !== issuer) || (iss === null && pending.metadata?.authorization_response_iss_parameter_supported === true)) {
      this.#deps.audit?.({ action: "mcp.oauth.refused", target: pending.server, after: { error: "issuer mismatch" } });
      return page(400, "Sign-in refused", "The answer did not come from the server's authorization server (iss).");
    }
    const code = url.searchParams.get("code");
    if (code === null || code === "" || this.#deps.engine === undefined) return page(400, "Sign-in refused", "No authorization code came back.");
    const exchanged = await this.#deps.engine.exchange({
      authorizationServerUrl: pending.authorizationServerUrl,
      ...(pending.metadata === undefined ? {} : { metadata: pending.metadata }),
      client: pending.client,
      ...(pending.resource === undefined ? {} : { resource: pending.resource }),
      code,
      codeVerifier: pending.codeVerifier,
      redirectUrl: this.redirectUrl,
    });
    if (!exchanged.ok) {
      this.#deps.audit?.({ action: "mcp.oauth.failed", target: pending.server, after: { error: exchanged.error.slice(0, 200) } });
      return page(502, "Sign-in failed", `The token exchange failed: ${exchanged.error.slice(0, 200)}`);
    }
    const kept = await this.#keepTokens(pending.server, exchanged.value);
    const server: AuthServer = { authorizationServerUrl: pending.authorizationServerUrl, ...(pending.metadata === undefined ? {} : { metadata: pending.metadata }), ...(pending.resource === undefined ? {} : { resource: pending.resource }) };
    this.#deps.kv.put(asKey(pending.server), server);
    this.#deps.audit?.({ action: "mcp.oauth.signed-in", target: pending.server, after: { expiresAt: kept.expiresAt ?? null, refreshable: kept.refresh !== undefined } });
    return page(200, "Signed in", `Signed in to ${pending.server}. You can close this tab.`);
  }

  /**
   * The access token for `server` (the MCP engine's `auth` hook): kept while fresh; refreshed (one refresh in flight)
   * when it is about to expire or the server refused it (`stale`). Undefined: the owner must sign in again.
   */
  async accessToken(server: string, stale: boolean): Promise<string | undefined> {
    const tokens = this.#tokens(server);
    if (tokens === undefined) return undefined;
    const fresh = tokens.expiresAt === undefined || tokens.expiresAt - REFRESH_MARGIN_MS > this.#now();
    if (!stale && fresh) return tokens.access;
    const running = this.#refreshing.get(server);
    if (running !== undefined) return running;
    const refresh = this.#refresh(server, tokens).finally(() => this.#refreshing.delete(server));
    this.#refreshing.set(server, refresh);
    return refresh;
  }

  async #refresh(server: string, tokens: KeptTokens): Promise<string | undefined> {
    const as = this.#deps.kv.get<AuthServer>(asKey(server));
    const client = this.#client(server);
    if (tokens.refresh === undefined || as === undefined || client === undefined || this.#deps.engine === undefined) return undefined;
    const answer = await this.#deps.engine.refresh({ ...as, client, refreshToken: tokens.refresh });
    if (!answer.ok) {
      console.warn(JSON.stringify({ t3flare: "mcp-oauth-refresh-failed", server, error: answer.error.slice(0, 200) }));
      return undefined;
    }
    return (await this.#keepTokens(server, answer.value, tokens)).access;
  }

  /** A removed server's OAuth state goes with it. */
  forget(server: string): void {
    this.#deps.secrets.remove(server, ["oauth-client", "oauth-tokens"]);
    this.#deps.kv.delete(asKey(server));
  }
}
