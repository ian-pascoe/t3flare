# Cloudflare Access managed OAuth on a path-scoped app (t3flare)

Research date: 2026-11-14. Question: can MCP clients reach `https://<host>/_t3flare/mcp` through Access managed OAuth, while the origin (t3) keeps its own OAuth authorization server at the host root for its `/mcp` endpoint?

Conventions:
- **DOCUMENTED** = quoted from a primary source, URL given. A value marked *example* comes from a docs code sample, not a stated contract.
- **INFERRED** = my conclusion from the cited sources; the basis is named.
- **UNKNOWN** = no source I could reach answers it. The matching probe is in "Spike probes" (probe IDs in brackets).
- Third-party field reports are labelled as such and are never used as DOCUMENTED.
- Primary sources: Cloudflare docs (`/index.md` variants), the Access applications API reference, the Cloudflare blog post and changelog, RFC 7591, 8414, 8707, 9728, and the MCP authorization spec.

Sources, short names used below:
- [MOA] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/index.md
- [BLOG] https://blog.cloudflare.com/managed-oauth-for-access
- [CL] https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth
- [API] https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/index.md
- [PATHS] https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/index.md
- [JWT] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/index.md
- [VALIDATE] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/index.md
- [COOKIE] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/index.md
- [AGENTS] https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/index.md
- [401] https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-401/
- [SVC] https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/index.md
- [WKRS] https://developers.cloudflare.com/workers/configuration/cloudflare-access/index.md
- [PRIV] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/self-hosted-private-app
- [MCPAUTH] https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- [RFC8414], [RFC9728], [RFC8707], [RFC7591]: https://datatracker.ietf.org/doc/html/rfc8414 etc.
- [ALCH] `node_modules/.pnpm/@alchemy.run+cloudflare@2.0.0-beta.85_patch_hash=42560d88385a37a4a65b7d0f3d0f4746d76477_e0ce66c27116ec948e885340109430b8/node_modules/@alchemy.run/cloudflare/lib/Access/`

---

## 0. The doc conflict to resolve first

Two Cloudflare pages describe discovery differently.

- DOCUMENTED [MOA]: "The client fetches the OAuth authorization server metadata from the `/.well-known/` endpoint: `https://<your-app-domain>/.well-known/oauth-authorization-server`". [BLOG] says the same URL.
- DOCUMENTED example [AGENTS], Step 1–3: the 401 carries `resource_metadata="https://<hostname>/.well-known/cloudflare-access-protected-resource/"`, that document lists `authorization_servers: ["https://<team>.cloudflareaccess.com"]`, and AS metadata is fetched from `https://<team>.cloudflareaccess.com/.well-known/oauth-authorization-server`.

Both can be true (app-host protected-resource metadata, team-domain AS). Which URL Access serves for a **path-scoped** app is UNKNOWN [P2].

---

## 1. Which URLs does Access answer itself?

- DOCUMENTED [PATHS]: "Application paths define the URLs protected by an Access policy." Path rules cover only the listed path and its children (`example.com/alpha/*` "Does not cover `example.com/alpha`").
- INFERRED from [PATHS]: a request outside `<host>/_t3flare` matches no Access app. Access should not intercept it, so the origin's root `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` should still reach t3. Basis: the policy scope is the app path. No source says whether managed OAuth's discovery paths are exempt from that scope.
- DOCUMENTED [MOA]: "If you run your own OAuth server behind an Access application and rely on your own `WWW-Authenticate` headers, do not enable this feature. Enabling managed OAuth replaces the `401` response behavior on the protected application."
- UNKNOWN [P2]:
  - Whether Access answers `https://<host>/.well-known/oauth-authorization-server` (root). If it does, it shadows the origin's root AS for every path on the host.
  - Whether it answers path-inserted forms `/.well-known/oauth-authorization-server/_t3flare` and `/.well-known/oauth-protected-resource/_t3flare/mcp`.
  - Whether it answers `/_t3flare/.well-known/...` (inside the app path).
  - Whether `/cdn-cgi/access/*` is served on the app host. Docs only name `<team>.cloudflareaccess.com/cdn-cgi/access/...`.
- Risk [INFERRED]: MCP clients fall back to root well-known URIs when `WWW-Authenticate` lacks `resource_metadata` (see Q2). The origin's root `/.well-known/oauth-protected-resource` describes `/mcp` with the origin's AS, so a client on `/_t3flare/mcp` could pick the wrong authorization server. Basis: [MCPAUTH] fallback order plus the root-shadowing question above.

---

## 2. `WWW-Authenticate` contents and endpoint hosts

- DOCUMENTED [MOA]: "The `401` includes a `WWW-Authenticate` header that points the client to Access's OAuth discovery metadata."
- DOCUMENTED example [AGENTS] (Step 1): `www-authenticate: Bearer realm="OAuth", error="invalid_token", error_description="Missing or invalid access token", resource_metadata="https://<hostname>/.well-known/cloudflare-access-protected-resource/"`. The JSON body repeats `resource_metadata`.
- DOCUMENTED [RFC9728] §5.1: `resource_metadata` is "The URL of the protected resource metadata."
- Field report, not primary [GH-478]: the 401 `resource_metadata` pointed at protected-resource metadata listing `"authentication_methods": ["cloudflared", "oauth"]`, with cloudflared first. Source: https://github.com/anthropics/claude-ai-mcp/issues/478
- UNKNOWN: whether the header includes `scope` (MCP says servers SHOULD send it, [MCPAUTH]), and its exact `resource_metadata` value for a path-scoped app [P2].
- RFC constraint [RFC9728] §3.3: when metadata comes from `resource_metadata`, its `resource` value "MUST be identical to the URL that the client used to make the request to the resource server." INFERRED consequence: for `/_t3flare/mcp`, the `resource` in Access's metadata must be exactly `https://<host>/_t3flare/mcp`, or a compliant client rejects it.
- Endpoints:
  - DOCUMENTED [MOA]: AS metadata "returns the authorization and token endpoint URLs for the application". No host named.
  - DOCUMENTED example [AGENTS] Step 3: `authorization_endpoint: https://<team>.cloudflareaccess.com/cdn-cgi/access/oauth/authorization`, `token_endpoint: .../cdn-cgi/access/oauth/token`, `registration_endpoint: .../cdn-cgi/access/oauth/registration`, `revocation_endpoint: .../cdn-cgi/access/oauth/revoke`, `code_challenge_methods_supported: ["S256"]`.
  - Field report [GH-478] corroborates `/cdn-cgi/access/oauth/authorization` on the app host and an `invalid_target` error (see Q6).
  - UNKNOWN: whether the endpoints are on the team domain (as the example shows) or the app host [P2][P6].
- DOCUMENTED [VALIDATE]: JWKS for the token is at `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs`.

---

## 3. How a "non-browser client" is detected

- DOCUMENTED [MOA]: "by default non-browser clients — such as CLIs, AI agents, SDKs, and scripts — cannot complete the browser-based login redirect. They receive a `302`…" With managed OAuth, "Access returns a `401` response instead of a `302` redirect to non-browser clients."
- DOCUMENTED [401]: Access returns 401 instead of its login redirect in these cases: "Requests that use a service token, when strict service token authentication is on"; "AJAX sub-requests with an expired session that send the `X-Requested-With: XMLHttpRequest` header"; "Non-browser clients, when managed OAuth is enabled."
- Accept, Sec-Fetch-*, User-Agent: UNKNOWN. No source defines "non-browser". The XHR-header trigger shows header-based classification exists, which makes the mechanism plausibly header-based [INFERRED, basis: [401]].
- Browser with no cookie: INFERRED still a 302. Basis: [MOA] describes only the non-browser case as changed. UNKNOWN until probed [P4].

---

## 4. Do service tokens keep working?

- DOCUMENTED [SVC]: "Make sure to set the policy action to Service Auth; otherwise, Access will prompt for an identity provider login." Service-token requests send `CF-Access-Client-Id` / `CF-Access-Client-Secret`.
- DOCUMENTED [MOA]: "Access enforces the same policies as a browser login, and your origin sees no difference." Managed OAuth is a "new transport mechanism, not a separate authentication path" [CL].
- INFERRED: a valid service token should still pass a Service Auth policy with managed OAuth on, since the policy is unchanged. Basis: [CL] wording above.
- UNKNOWN: whether a service-token request with no matching token gets 401 or 403 under managed OAuth [P5].

---

## 5. What the origin receives for an OAuth-token request

- DOCUMENTED [MOA]: tokens are opaque (`oauth:...`), "not JSON Web Tokens (JWTs)". "Cloudflare resolves the token into the user's identity on the backend and forwards a signed assertion to your origin. From your origin's perspective, the request looks the same as a browser-authenticated request."
- DOCUMENTED [BLOG]: the client receives "the same JWT from our initial solution". The origin gets the JWT, the client gets the opaque token.
- DOCUMENTED [MOA] (MCP section): "The MCP server must validate the Access JWT sent in the `Cf-Access-Jwt-Assertion` header."
- DOCUMENTED [JWT] claims for an identity session: `aud` (app AUD tag), `email`, `exp`, `iat`, `nbf`, `iss`, `type` (`app`), `identity_nonce`, `sub`, `country`. Service-token form: `common_name` is the Client ID.
- DOCUMENTED [VALIDATE]: "Cloudflare Access assigns a unique AUD tag to each application." So `aud` is per app, not per path.
- UNKNOWN: any claim that marks an OAuth-derived token versus a cookie session (`client_id`, `amr`, a different `type`). No source lists one [P7].
- UNKNOWN: whether `Authorization: Bearer oauth:...` reaches the origin or is stripped. [AGENTS] Step 8 sends it to the origin in an example, but does not say what the origin sees [P7].
- INFERRED: the origin should validate `Cf-Access-Jwt-Assertion` against the app AUD (per [VALIDATE]), not trust the bearer header. Basis: [MOA] MCP section.

---

## 6. RFC 8707 `resource`

- DOCUMENTED [RFC8707] §2: `resource` "MUST be an absolute URI… MUST NOT include a fragment component. It SHOULD NOT include a query component". Also: "The client SHOULD use the base URI of the API as the resource parameter value unless specific knowledge of the resource dictates otherwise."
- DOCUMENTED [MCPAUTH]: MCP clients "MUST identify the MCP server"; canonical examples include `https://mcp.example.com/server/mcp` "(when path component is necessary to identify individual MCP server)". Clients "MUST send this parameter regardless of whether authorization servers support it."
- DOCUMENTED [API]: the feature is "Only compatible with OAuth clients that support RFC 8707".
- DOCUMENTED example [AGENTS]: `resource=<URL-encoded target resource>` in the authorize URL and DCR body. Token response example: `"resource": "https://<hostname>/"`. The example uses the host root, not a path.
- Field report [GH-478]: `/authorize` without `resource` returned `invalid_target` with "No resource parameter found"; the same request with a `resource` value returned a code. Third-party, not used as DOCUMENTED.
- UNKNOWN: whether Access accepts a path-scoped resource (`https://<host>/_t3flare/mcp`), a host-root value, or the app domain, and which one becomes token `aud` [P6].
- INFERRED: the access token is per-application. [MOA] says a token "obtained through any one domain is valid for all domains in the same application", so paths in one app probably share it.

---

## 7. workers.dev, path-scoped domains, and open-beta limits

- DOCUMENTED [WKRS]: hostname-based Access "can be `workers.dev`, a Custom Domain, or a path", applied by "creating a self-hosted application and using the hostname or path as the application domain".
- DOCUMENTED [BLOG]: managed OAuth works "for any internal app, whether it's one built on Cloudflare Workers, or hosted elsewhere."
- DOCUMENTED [CL]: "Managed OAuth can be enabled on any self-hosted Access application or MCP server portal."
- DOCUMENTED [BLOG]: "Now in open beta, every Access application supports managed OAuth." [API]: "This feature is currently in beta."
- INFERRED: managed OAuth works on a `workers.dev` host with a path. No source excludes it. UNKNOWN until probed [P9].
- DCR redirect rules, DOCUMENTED [MOA]:
  - "Allow localhost clients" → `dynamic_client_registration.allow_any_on_localhost`.
  - "Allow loopback clients" → `allow_any_on_loopback` (127.0.0.1).
  - "Allowed redirect URIs": "HTTP and HTTPS paths may end in `/*`… Custom-scheme URIs must be listed explicitly and match exactly; they cannot contain wildcards, credentials, or fragments."
  - INFERRED: a client redirect such as `https://claude.ai/api/mcp/auth_callback` needs an `allowed_uris` entry, since no other rule admits it. A field report says the same [GH-478].
- CIMD (Client ID Metadata Documents): UNKNOWN. [MCPAUTH] says clients check `client_id_metadata_document_supported` in AS metadata. No Cloudflare source mentions CIMD [P10].
- Token lifetimes, DOCUMENTED [MOA], [API], [AGENTS]:
  - Access token default: 15 minutes ([AGENTS] example `expires_in: 900`).
  - Format: "Must be in the format `300ms` or `2h45m`. Valid time units are ns, us (or µs), ms, s, m, h."
  - Recommended: access 5–15 min, grant session 1–2 weeks.
  - Min/max: none documented. UNKNOWN [P11].
- Refresh, DOCUMENTED [MOA]: "When the access token expires, Cloudflare uses the refresh token to issue a new one after re-evaluating the user against your Access policies. When the refresh token expires, the user must re-authenticate with the identity provider."
- Refresh-token rotation: UNKNOWN [P6].

---

## 8. Two Access apps on one host

- DOCUMENTED [WKRS] "Understand Access hierarchy": "When multiple rules could apply to the same request, the most specific rule takes effect first: 1. Hostname or path-based Access…". The example is `admin.example.com` / `example.com/login`.
- DOCUMENTED [PATHS]: "When multiple rules are set for a common root path, the more specific rule takes precedence… no rule is inherited from `dashboard.com/eng`." This is stated for rules, not apps.
- DOCUMENTED [PRIV]: "When a request matches destinations in multiple self-hosted private applications, Access selects the application with the most specific matching destination." Private apps only.
- INFERRED: `/_t3flare/mcp` wins for requests under that path, and a separate app on `/_t3flare/mcp` can have managed OAuth while `/_t3flare` does not. Basis: managed OAuth is a per-app field [API], [CL]. Public-app precedence is UNKNOWN [P8].
- INFERRED risk (cookies): both apps set `CF_Authorization` on the same host. [COOKIE] says that without the cookie-path setting it "is only scoped to the domain and subdomain". Enabling the path attribute on both apps is the likely fix. Not verified [P8].

---

## 9. Alchemy `Cloudflare.Access.Application` coverage

Read from [ALCH] `lib/Access/Application.d.ts` and `Application.js`.

- DOCUMENTED (type): `OAuthConfiguration` has `enabled`; `grant { accessTokenLifetime, sessionDuration }`; `dynamicClientRegistration { enabled, allowedUris, allowAnyOnLocalhost, allowAnyOnLoopback }`. Exposed as the `oauthConfiguration` prop.
- DOCUMENTED (API leaves, self-hosted variant): `oauth_configuration.enabled`; `grant.access_token_lifetime`; `grant.session_duration`; `dynamic_client_registration.enabled`, `.allow_any_on_localhost`, `.allow_any_on_loopback`, `.allowed_uris`. Source: [API] (the `SelfHostedApplication` variant; `enabled` "Defaults to true if omitted"). The `enabled: optional true` line in [API] is for `end_user` apps only.
- Coverage: all six API leaf fields map to alchemy fields. None is missing.
- INFERRED from code: `toRequestOAuthConfiguration` sends the config as-is and `mergeOAuthConfiguration` merges a partial config over the live one. So an update that omits `oauthConfiguration` keeps the live value. The camelCase-to-snake_case conversion happens in the `@distilled.cloud/cloudflare` SDK, which I did not open.
- Drift check: `oauthConfigurationEquals` compares `enabled`, the two grant fields, `dynamicClientRegistration.enabled`, and `allowAnyOnLocalhost`. I did not read the rest of that function.
- Doc comment in `Application.d.ts` shows a managed-OAuth example with `domain: "mcp.example.com"` and no path. `domain` is documented as "Primary hostname and path secured by Access". The `destinations` form is `{ type: "public", uri }`.

---

## Implications for t3flare (INFERRED)

- Keep the origin's root discovery documents unchanged until P2 shows whether Access answers them. If Access does answer them, the origin's `/mcp` AS and its root PRM are shadowed for every path on the host. Options: move the origin's AS and PRM under non-root paths, or drop origin OAuth for `/mcp` once managed OAuth covers `/_t3flare/mcp`.
- The new MCP endpoint's protected-resource metadata must name `https://<host>/_t3flare/mcp` exactly (RFC 9728 §3.3), whatever Access serves.
- The origin must validate `Cf-Access-Jwt-Assertion` against the app AUD, not the bearer token.

---

## Spike probes

Run only on a throwaway stage (never `prod`). Do not read credential files: pass tokens and client secrets through environment variables. Do not print tokens or client secrets into logs. Set `HOST` to the stage host, `TEAM` to the team name, `CID` to a DCR client ID.

**[P1] Baseline before enabling managed OAuth.** Confirms the current 302 behaviour and the origin's answers.
```sh
curl -sS -D - -o /dev/null -H 'Accept: application/json, text/event-stream' "https://$HOST/_t3flare/mcp"
curl -sS -D - -o /dev/null -H 'Accept: text/html' "https://$HOST/_t3flare"
for u in "https://$HOST/.well-known/oauth-authorization-server" \
         "https://$HOST/.well-known/oauth-protected-resource/mcp" \
         "https://$HOST/.well-known/oauth-protected-resource"; do
  printf '%s ' "$u"; curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$u"
done
```

**[P2] Which URLs Access answers, after enabling managed OAuth on the `/_t3flare` app.** Record status, content type, and any `WWW-Authenticate` header for each URL. Repeat with the app disabled to compare with the origin.
```sh
for u in "https://$HOST/.well-known/oauth-authorization-server" \
         "https://$HOST/.well-known/oauth-authorization-server/_t3flare" \
         "https://$HOST/.well-known/oauth-authorization-server/_t3flare/mcp" \
         "https://$HOST/.well-known/oauth-protected-resource/_t3flare/mcp" \
         "https://$HOST/.well-known/oauth-protected-resource/mcp" \
         "https://$HOST/.well-known/oauth-protected-resource" \
         "https://$HOST/.well-known/cloudflare-access-protected-resource/" \
         "https://$HOST/_t3flare/.well-known/oauth-authorization-server" \
         "https://$HOST/cdn-cgi/access/certs" \
         "https://$HOST/cdn-cgi/access/oauth/authorization" \
         "https://$TEAM.cloudflareaccess.com/.well-known/oauth-authorization-server"; do
  printf '%s\n' "$u"
  curl -sS -D - -o /tmp/p2body -H 'Accept: application/json' "$u" | grep -iE '^(HTTP|www-authenticate|content-type|location)'
  head -c 400 /tmp/p2body; echo
done
```
Also dump `resource_metadata` from the 401 on `/_t3flare/mcp` and check whether its `resource` equals `https://$HOST/_t3flare/mcp`.

**[P3] Accept and UA classification (Q3).** Same URL, varied headers. Record 302 vs 401.
```sh
U="https://$HOST/_t3flare/mcp"
curl -sS -o /dev/null -w 'A  %{http_code}\n' -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' "$U"
curl -sS -o /dev/null -w 'B  %{http_code}\n' -H 'Accept: application/json, text/event-stream' "$U"
curl -sS -o /dev/null -w 'C  %{http_code}\n' -H 'Accept: */*' "$U"
curl -sS -o /dev/null -w 'D  %{http_code}\n' -H 'Accept: text/html' -H 'X-Requested-With: XMLHttpRequest' "$U"
curl -sS -o /dev/null -w 'E  %{http_code}\n' -H 'Accept: text/html' -H 'User-Agent: Mozilla/5.0' "$U"
curl -sS -o /dev/null -w 'F  %{http_code}\n' -H 'Accept: application/json' -H 'Sec-Fetch-Mode: cors' -H 'Sec-Fetch-Dest: empty' "$U"
```

**[P4] Browser with no cookie (Q3).** Expect a 302 to the team login.
```sh
curl -sS -D - -o /dev/null -H 'Accept: text/html' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' "https://$HOST/_t3flare" | grep -iE '^(HTTP|location)'
```

**[P5] Service token (Q4).** Expect 200 from origin with a valid token under a Service Auth policy. Then send a wrong secret and record 401 vs 403.
```sh
curl -sS -D - -o /dev/null -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" "https://$HOST/_t3flare/mcp"
curl -sS -D - -o /dev/null -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H 'CF-Access-Client-Secret: wrong' "https://$HOST/_t3flare/mcp"
```

**[P6] OAuth flow and `resource` variants (Q2, Q6, Q7).** Needs a logged-in browser cookie jar for the team domain to get past the login page. Use `-b` with an exported jar (not a credential file in this repo).
```sh
# 6a. AS metadata at each candidate location; save for comparison
curl -sS "https://$HOST/.well-known/oauth-authorization-server" | tee /tmp/as-host.json
curl -sS "https://$TEAM.cloudflareaccess.com/.well-known/oauth-authorization-server" | tee /tmp/as-team.json
# look for: authorization_endpoint, token_endpoint, registration_endpoint, client_id_metadata_document_supported, code_challenge_methods_supported

# 6b. DCR, with the redirect URI you need allowlisted
curl -sS -X POST "$REG_ENDPOINT" -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://localhost:8400/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}'

# 6c. authorize with each resource variant; a 302 with ?code= means accepted, invalid_target means rejected
RV=(none "https://$HOST/_t3flare/mcp" "https://$HOST/_t3flare" "https://$HOST" "$HOST/_t3flare/mcp")
for r in "${RV[@]}"; do
  q="response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A8400%2Fcallback&code_challenge=$CC&code_challenge_method=S256"
  [ "$r" != none ] && q="$q&resource=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$r")"
  printf '%s -> ' "$r"; curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' -b /tmp/team-cookies.txt "$AUTH_ENDPOINT?$q"
done

# 6d. token exchange and refresh; record expires_in, resource, refresh-token rotation
curl -sS -X POST "$TOKEN_ENDPOINT" -d grant_type=authorization_code -d "code=$CODE" -d "client_id=$CID" -d "redirect_uri=http://localhost:8400/callback" -d "code_verifier=$CV" -d "resource=https://$HOST/_t3flare/mcp" | jq '{token_type,expires_in,resource,scope,has_refresh:(.refresh_token!=null)}'
curl -sS -X POST "$TOKEN_ENDPOINT" -d grant_type=refresh_token -d "refresh_token=$RT" -d "client_id=$CID" | jq '{token_type,expires_in,resource,rotated:(.refresh_token!=null)}'
```

**[P7] What the origin sees (Q5).** Point the throwaway stage's `/_t3flare/mcp` at a debug echo that prints the request headers, with values redacted, plus decoded claims of `Cf-Access-Jwt-Assertion` (the decode prints claim names and values, not the signature).
```sh
# a: with OAuth bearer
curl -sS -H "Authorization: Bearer $OAUTH_TOKEN" "https://$HOST/_t3flare/mcp" > /dev/null
# b: cookie session from the same browser for comparison
curl -sS -H "Cookie: CF_Authorization=$CF_COOKIE" "https://$HOST/_t3flare/mcp" > /dev/null
# check the echo for: Authorization present?  Cf-Access-Jwt-Assertion present?  claims: aud, email, sub, type, identity_nonce, any extra (client id, amr, ...)
```

**[P8] Two apps on one host (Q8).** App B on `$HOST/_t3flare/mcp` (managed OAuth on, path cookie on). App A on `$HOST/_t3flare` (managed OAuth off, path cookie on). Then:
```sh
curl -sS -D - -o /dev/null -H 'Accept: application/json' "https://$HOST/_t3flare/mcp" | grep -iE '^(HTTP|www-authenticate|location)'   # expect B
curl -sS -D - -o /dev/null -H 'Accept: text/html' "https://$HOST/_t3flare/other" | grep -iE '^(HTTP|location)'                        # expect A
curl -sS -D - -o /dev/null -H 'Accept: application/json' "https://$HOST/_t3flare/mcp/sub" | grep -iE '^(HTTP|www-authenticate)'       # expect B
```
Also log in through both apps and record the `Set-Cookie` names and `Path` values for `CF_Authorization` to see whether they collide.

**[P9] workers.dev (Q7).** Repeat [P2] and [P6] on `t3flare-environment-<stage>.<sub>.workers.dev` with the app domain `<that host>/_t3flare`.

**[P10] CIMD (Q7).** Check AS metadata for `client_id_metadata_document_supported` (from [P6a]). If true, authorize with `client_id=https://<client-host>/client.json` whose document lists the redirect URI. Record accept or reject.

**[P11] Token lifetime bounds (Q7).** On the throwaway app, PUT `oauth_configuration.grant.access_token_lifetime` with each of `1ns`, `1s`, `15m`, `24h`, `8760h`, `100000h`. Record accepted, rejected, and the returned value. Repeat for `session_duration`. Use the [API] PUT shape and include all existing fields (per [MOA]).

---

### Coverage of the spike list

Every UNKNOWN maps to a probe:
- Q1 root and path-inserted shadowing, and `/cdn-cgi`: [P2].
- Q2 `WWW-Authenticate` contents, `scope`, endpoint host: [P2], [P6].
- Q3 detection signals and browser-no-cookie: [P3], [P4].
- Q4 service tokens: [P5].
- Q5 origin headers and claims: [P7].
- Q6 `resource` acceptance and refresh rotation: [P6].
- Q7 workers.dev, CIMD, token bounds: [P9], [P10], [P11].
- Q8 public-app precedence and cookie collision: [P8].
- Q9 no unknowns (code-level answer).

---

## M0's answers (SPI-1196)

Recorded on stage `psettings` (workers.dev only), 2026-11-14, by the spike on branch `settings-mcp-m0-spike`:
`docs/steps/settings-mcp/m0-access-oauth.json` (probes P1-P13, P15) and `m0-clients.json` there, to be merged with this
branch. "Owner step" refers to `docs/steps/settings-mcp-m0-owner-steps.md` on that branch. What was built on these
answers: [ADR-0035](../adr/0035-owner-clients-reach-the-settings-server-at-t3flare-mcp-behind-an-access-application-of-its-own.md).
Each answer below replaces the matching UNKNOWN above.

| Probe | Answer | Open |
| -- | -- | -- |
| P1 | Before managed OAuth, a path's 302 already carries `WWW-Authenticate: Cloudflare-Access resource_metadata=…/.well-known/cloudflare-access-protected-resource/<path>`, a document Access serves per path. t3's root AS and protected-resource documents answer 200 from the origin; path-inserted ones 404. | |
| P2 | With managed OAuth on a path-scoped application, a non-browser request gets 401 `Bearer realm="OAuth", error="invalid_token", …, resource_metadata="https://<host>/.well-known/cloudflare-access-protected-resource/<request path>"`. That document gains `authentication_methods` oauth, `resource` `https://<host>/<path>` (query dropped) and `authorization_servers` [the team domain]. The AS metadata is the team's (every endpoint on `<team>.cloudflareaccess.com`, registration included, S256, `authorization_code` and `refresh_token`, no CIMD). **Access answers none of the root or path-inserted RFC 8414/9728 documents on the app's host**, so §0's conflict resolves to [AGENTS]'s shape. | |
| P3 | Classification is by `Accept`: one that includes `text/html` gets the 302; `text/html` with `X-Requested-With: XMLHttpRequest` the Cloudflare-Access 401; every other the OAuth 401. `Sec-Fetch-*` and `User-Agent` change nothing. | |
| P4 | A browser with no cookie still gets the 302 to the team login. | |
| P5 | The service token still passes (an assertion with `common_name` and the application's `aud`); a wrong secret gets 401 under managed OAuth. Access forwards a `CF_Authorization` cookie to the origin and sets one with the application's path. | |
| P6 | Dynamic registration works on the team endpoint (public client, `token_endpoint_auth_method: none`). Authorize without `resource` is 400 `invalid_target`; the endpoint's URL, with `?elicitation_mode=…` or a trailing slash, is accepted and resolves to the application; the host root and other paths are `invalid_target`. | the token exchange, `expires_in`, the token's `resource`, refresh rotation: owner step 1 |
| P7 | Service-token assertions: `type: app`, the application's `aud`, `common_name`, `policy_id`, empty `sub`, no OAuth-specific claim. | an OAuth-derived assertion, and whether `Authorization` reaches the origin: owner step 1 |
| P8 | The more specific application wins per path (`/_t3flare/mcp` and below are the endpoint's, `/_t3flare/mcpx` and the rest the admin application's). Both cookies are `CF_Authorization`, with `Path=/_t3flare/mcp` and `Path=/_t3flare` (the path-cookie attribute on both); Access reads the first one sent, and a browser sends the longer path first. | a real browser's cookies: owner step 5 |
| P9 | The whole run was on workers.dev. On an application covering a whole workers.dev host Access serves the standard documents itself (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/<path>]`). | prod's custom domain: not probed (M5a item 4c) |
| P10 | No CIMD: the team's AS metadata has no `client_id_metadata_document_supported`; pi, which prefers CIMD, registered dynamically. | |
| P11 | The applications API stores any `access_token_lifetime` and `session_duration` unvalidated (1ns to 100000h read back verbatim). | what Access issues: owner step 1 checks `expires_in` under `15m` |
| P12 | Stand-in only: a token issued by one application (the service token's `CF_Authorization` JWT, as a cookie, as `cf-access-token` and as a bearer) is refused at every other application's paths, in every direction. | **the OAuth bearer itself: owner step 1, the gate of layout (B)** |
| P13 | Needs the owner's identity. | owner step 1 (the page's answerer check is `sub` until then) |
| P15 | The query reaches the origin through Access; Access drops it from its discovery documents and accepts it inside `resource`. Claude Code, pi and Codex send `resource` without the query; OpenCode sends the configured URL with it. A custom header reaches the origin too (the fallback carrier). | the token's use at the URL with the query: owner step 1 |

Redirect URIs registered (captured before sign-in): Claude Code 2.1.322 `http://localhost:<port>/callback`; pi 1.5.2
`http://127.0.0.1:<port>/callback`; Codex 0.167.2 `http://127.0.0.1:<port>/callback/<random>`; OpenCode 2.2.7
`http://127.0.0.1:<port>/callback`; all four followed the 401's `resource_metadata`. Cursor was not run (owner step 2;
third-party reports: `http://localhost:8787/callback`, older `cursor://anysphere.cursor-mcp/oauth/callback`, web
`https://www.cursor.com/agents/mcp/oauth/callback`). An unlisted custom scheme, https or non-loopback redirect is refused
at registration with `invalid_client_metadata`; registration is team-wide and admits a redirect any of the team's
applications allows, and authorize then enforces the application's own list.
