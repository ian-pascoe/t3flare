// OAuth for direct MCP servers (review M4, M5; ADR-0028): every outbound request of a sign-in (discovery, dynamic client
// registration, the token exchange and each refresh) is made here, in the Worker with `global_fetch_strictly_public` and
// no bindings, through a fetch that takes only https URLs without credentials and follows no redirect. The Environment
// DO keeps the state (the `state` value, the PKCE verifier, the client and the tokens) and calls these three methods over
// its `MCP_OAUTH` service binding; nothing here is stored.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off
import {
  type AuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorizationCode,
  type OAuthClientInformationMixed,
  type OAuthTokens,
  refreshAuthorization,
  registerClient,
  selectResource,
  startAuthorization,
} from "@cloudpid/mcp/oauth";
import { WorkerEntrypoint } from "cloudflare:workers";

import { guardedFetch } from "./oauthFetch.ts";

export { guardedFetch, OAUTH_REQUEST_TIMEOUT_MS } from "./oauthFetch.ts";

export interface BeginInput {
  readonly serverUrl: string;
  readonly redirectUrl: string;
  /** Our Client ID Metadata Document's URL, used as `client_id` where the server takes CIMD. */
  readonly clientMetadataUrl: string;
  readonly clientName: string;
  readonly state: string;
  /** A client kept from an earlier sign-in to this server, reused. */
  readonly client?: OAuthClientInformationMixed;
}

export interface BeginAnswer {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly client: OAuthClientInformationMixed;
  readonly authorizationServerUrl: string;
  readonly metadata?: AuthorizationServerMetadata;
  readonly resource?: string;
  readonly registration: "kept" | "cimd" | "dcr";
}

export interface TokenInput {
  readonly authorizationServerUrl: string;
  readonly metadata?: AuthorizationServerMetadata;
  readonly client: OAuthClientInformationMixed;
  readonly resource?: string;
}

export type OAuthAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const failed = (error: unknown): { readonly ok: false; readonly error: string } => ({ ok: false, error: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500) });

/** The methods, apart from the entrypoint, so tests run them on a stubbed fetch. */
export const oauthMethods = (fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>) => ({
  async begin(input: BeginInput): Promise<OAuthAnswer<BeginAnswer>> {
    try {
      const info = await discoverOAuthServerInfo(input.serverUrl, { fetch: fetcher });
      const metadata = info.authorizationServerMetadata;
      const resource = selectResource(input.serverUrl, info.resourceMetadata);
      let client = input.client;
      let registration: BeginAnswer["registration"] = "kept";
      if (client === undefined) {
        if (metadata?.client_id_metadata_document_supported === true) {
          client = { client_id: input.clientMetadataUrl };
          registration = "cimd";
        } else if (metadata?.registration_endpoint !== undefined) {
          client = await registerClient(info.authorizationServerUrl, {
            ...(metadata === undefined ? {} : { metadata }),
            clientMetadata: { redirect_uris: [input.redirectUrl], client_name: input.clientName, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
            fetch: fetcher,
          });
          registration = "dcr";
        } else return { ok: false, error: "The server's authorization server takes neither a Client ID Metadata Document nor dynamic registration." };
      }
      const scope = info.resourceMetadata?.scopes_supported?.join(" ");
      const started = await startAuthorization(info.authorizationServerUrl, {
        ...(metadata === undefined ? {} : { metadata }),
        clientInformation: client,
        redirectUrl: input.redirectUrl,
        state: input.state,
        ...(resource === undefined ? {} : { resource }),
        ...(scope === undefined || scope === "" ? {} : { scope }),
      });
      return {
        ok: true,
        value: {
          authorizationUrl: started.authorizationUrl.toString(),
          codeVerifier: started.codeVerifier,
          client,
          authorizationServerUrl: info.authorizationServerUrl,
          ...(metadata === undefined ? {} : { metadata }),
          ...(resource === undefined ? {} : { resource }),
          registration,
        },
      };
    } catch (error) {
      return failed(error);
    }
  },

  async exchange(input: TokenInput & { readonly code: string; readonly codeVerifier: string; readonly redirectUrl: string }): Promise<OAuthAnswer<OAuthTokens>> {
    try {
      return {
        ok: true,
        value: await exchangeAuthorizationCode(input.authorizationServerUrl, {
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          clientInformation: input.client,
          ...(input.resource === undefined ? {} : { resource: input.resource }),
          code: input.code,
          codeVerifier: input.codeVerifier,
          redirectUrl: input.redirectUrl,
          fetch: fetcher,
        }),
      };
    } catch (error) {
      return failed(error);
    }
  },

  async refresh(input: TokenInput & { readonly refreshToken: string }): Promise<OAuthAnswer<OAuthTokens>> {
    try {
      return {
        ok: true,
        value: await refreshAuthorization(input.authorizationServerUrl, {
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          clientInformation: input.client,
          ...(input.resource === undefined ? {} : { resource: input.resource }),
          refreshToken: input.refreshToken,
          fetch: fetcher,
        }),
      };
    } catch (error) {
      return failed(error);
    }
  },
});

/** The OAuth entrypoint the Environment binds as `MCP_OAUTH`. */
export class McpOAuth extends WorkerEntrypoint {
  readonly #methods = oauthMethods(guardedFetch());

  begin(input: BeginInput): Promise<OAuthAnswer<BeginAnswer>> {
    return this.#methods.begin(input);
  }

  exchange(input: TokenInput & { readonly code: string; readonly codeVerifier: string; readonly redirectUrl: string }): Promise<OAuthAnswer<OAuthTokens>> {
    return this.#methods.exchange(input);
  }

  refresh(input: TokenInput & { readonly refreshToken: string }): Promise<OAuthAnswer<OAuthTokens>> {
    return this.#methods.refresh(input);
  }
}
