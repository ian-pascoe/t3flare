# The Environment DO is the Credential broker, and each Environment signs in itself

**Status: accepted again on 2026-11-16 (SPI-1164), with the refinement below.** It was superseded on 2026-11-11 by
[ADR-0012](0012-all-model-access-goes-through-the-model-proxy.md), when every Subscription was to stay in the Model
proxy. The owner's Model endpoints decisions of 2026-11-13 ([ADR-0034](0034-model-endpoints-are-the-owners-set-in-the-harness-panel.md))
brought Subscription sign-ins back into t3flare, so there is something to broker again. The GitHub App's tokens, which
this ADR did not cover, are still minted only by the Environment DO ([ADR-0013](0013-github-access-through-a-github-app-with-per-repo-tokens.md)).
The text of 2026-11-10 follows unchanged; the refinement says what was built.

Subscription logins carry rotating refresh tokens, which need a single writer. The Environment DO holds every Subscription credential and is the only process that refreshes; callers (intercept handlers, Session DOs) get access tokens only, cached until near expiry. t3 already ships this for ChatGPT (`CodexChatGptAuth.ts`, single-writer refresh in its secret store), so we extend it with a small broker service for other providers rather than adding a Credentials DO.

Each Environment signs in itself: a rotating credential is never copied from the laptop to the cloud, because two refreshers invalidate each other.

## Considered Options

- **A lease where one runner holds the real `auth.json`**: serializes work and puts a rotating token on Container disk. Kept only as the fallback for Codex if managed mode fails in the cloud.

## Refinement (SPI-1164, 2026-11-16)

Report: [`docs/steps/spi-1164.md`](../steps/spi-1164.md).

1. **A sign-in is a Model endpoint's auth.** An endpoint's auth is an API key, none, or a sign-in (`chatgpt` first,
   `claude` second (item 10); Copilot follows in SPI-1166, each one entry in `SIGN_IN_KINDS` and one vendor in the broker).
   A sign-in fixes its endpoint's API and base URL and allows no headers of the owner's; its auth never changes (remove
   the endpoint to change it). Until the hard cut (SPI-1176), Subscriptions may also stay connected in the Model proxy.
2. **The broker is ours, not t3's.** `credentials/broker.ts` implements pi-ai's `CredentialStore` over the sealed store
   (ADR-0034 §4: AES-256-GCM under the stage's credentials key), keyed by the endpoint's id. t3's `CodexChatGptAuth` is
   not reused: sign-ins are edited on the Harness panel, not t3's provider settings, and the Environment's bundle keeps
   no pi-ai (pi-ai's types only).
3. **One refresher, saved before use.** Every write of an endpoint's sign-in (a renewal, a completed sign-in, a
   sign-out, `modify`, `delete`) runs under the endpoint's lock and is committed before it resolves; a token is renewed
   under it when less than 5 minutes are left (never before OpenAI's `earliest_refresh_at`), so a refresh, or a refused
   one, runs once however many Sessions ask. The renewed credential, its rotated refresh token included, is saved before
   any caller gets its access token; if it cannot be saved, no caller gets it.
4. **A refused renewal signs the endpoint out.** OpenAI's "unusable refresh token" codes (`invalid_grant`,
   `refresh_token_expired`, …) and `invalid_client` remove the tokens, mark the endpoint signed out with the reason, and
   the next turn fails naming the sign-in ("… is not signed in to ChatGPT (…): sign in with ChatGPT again in the Harness
   panel."). A passing failure keeps a token that is still valid, and otherwise fails the turn as retryable. The Session
   records the failure on the turn, typed (`EndpointCredentialFailure`: `signed_out`, `unavailable`, …), and the differ
   shows that, never the error's text.
5. **Sessions ask at use time.** `endpointCredential({ endpointId, target })` gives a sign-in's access token and its
   expiry, under the target rule keys have. The Session keeps it in memory only, for at most 5 minutes and never past 2
   minutes before its expiry, so a long turn's next request takes the renewed token; it drops it on a 401 and on the
   endpoint's sign-out (`endpointSignedOut`). No token reaches pi-durable's storage, the push, a Workspace or a Container.
6. **Sign-out**, in order: after any renewal in flight, the tokens are removed here (the registration is kept: OpenAI's
   issued client id and the account's email, for the next sign-in); then every open Session drops the endpoint's token,
   and stops its live turns when they run on the endpoint (the Session's own storage says, so it holds after a restart);
   then the vendor revokes the refresh token that was current (ChatGPT: at discovery's revocation endpoint, retried
   twice, 30 s in all; Claude: Anthropic offers no revocation, item 10), whatever happened to the Sessions (each is given 5 s). The panel says `revoked` only when the
   vendor confirmed it. Removing a signed-in endpoint signs it out first; a completed sign-in whose endpoint cannot be
   saved, or which a sign-out overtook during its code exchange, is revoked at once, as is a grant the sign-in does not
   keep (no plan-usage scope, an ID token that does not check out). Sign-out forgets the account (its subject), so the
   next sign-in may be another account. Which Sessions are open is in the Environment's memory: after an Environment
   restart it knows only those t3 has opened again; one it misses had its turns ended by the restart (ADR-0004), holds
   a token at most 5 minutes, and gets no other.
7. **Each Environment signs in on its own panel.** The vendor's redirect goes to a loopback address nothing serves; the
   owner pastes the address the browser lands on into the panel. The attempt's state, nonce and PKCE verifier are kept
   sealed in the Environment DO between the start and the paste (30 minutes), never in an isolate's memory: pi-ai's
   `login()` keeps them in memory, and the spike lost such attempts (SPI-1161 Q1).
8. **ChatGPT is plan usage, not the Codex backend** (owner, 2026-11-16). "Sign in with ChatGPT" plan usage
   (`chatgpt.tokens.use.direct`, OpenAI's public Responses API at `api.openai.com/v1`) as OpenAI documents it for
   open-source clients, not the device code for `chatgpt.com/backend-api/codex`, whose edge blocks our Workers
   (SPI-1161 Q3). **It is unverified:** the owner's Free plan was refused at the code exchange (`invalid_grant`), plan
   usage is offered to Plus and Pro plans, and OpenAI documents it for "open-source and locally hosted apps" (a paid or
   remotely hosted app is asked to fill in an interest form). Whether an Environment on the owner's own Cloudflare
   account counts as locally hosted is OpenAI's call. The panel says so beside the sign-in.
9. **The relay does not carry a sign-in yet** (SPI-1171): the relay refuses a sign-in endpoint (501), and every CLI's
   list of endpoints (Codex, Claude Code, OpenCode) starts from `relayedEndpoints`, which leaves sign-ins out. No
   Workspace code asks for a sign-in's token.

10. **Claude is a Claude Pro or Max plan through Claude Code's OAuth sign-in** (SPI-1165; report
    [`docs/steps/spi-1165.md`](../steps/spi-1165.md)). It is pi-ai's copy-code flow: the owner approves at claude.ai,
    Anthropic's page shows a code (`code#state`), and the owner pastes it into the panel. Its client, URLs and scopes are
    pi-ai's (Claude Code's public client), pinned against pi-ai's own flow; its state is a random value of its own, not
    the PKCE verifier pi-ai sends as the state. Its endpoint is `anthropic-messages` at `https://api.anthropic.com`, and
    its requests take the shape pi-ai gives a Claude subscription's token (Bearer auth, Claude Code's betas, user agent
    and identity as the system's first block, its tool names), pinned in a test; the shape follows from the token, so an
    API-key endpoint refuses such a token as its key, and the shape reaches no other endpoint. Its tokens last 8 hours
    and its refresh token rotates on every refresh, a replaced one refused (SPI-1161 Q5), so item 3's one refresher
    matters most here. A refusal of a refresh (a 400, 401 or 403 with a JSON body, but Anthropic's passing codes)
    signs the endpoint out, so a grant removed at claude.ai ends the sign-in rather than failing every turn as
    retryable; a body that is not JSON (an edge's page) is retried. The accepted cost: a JSON 400, 401 or 403 during an incident at Anthropic would sign the owner out (sign in again; the old grant stays at claude.ai), weighed against retrying a removed grant's refresh forever; what Anthropic answers for a removed grant is unverified. Sign-out forgets the account whole (Claude has no registration to keep, so its email goes too).
    **Anthropic offers no revocation to apps** (SPI-1161: `platform.claude.com/v1/oauth/revoke`
    answers 404): sign-out deletes the tokens here and stops the Sessions; the grant stays on the owner's account until the
    owner removes it at claude.ai (Settings, Claude Code), which the panel says beside the sign-in, in Sign out's confirmation
    and in its answer.

    **The terms-of-service risk is the owner's, chosen knowingly** (owner decision, 2026-11-13). Claude Code's OAuth
    client is Anthropic's own, made for Claude Code; Anthropic's terms may not allow a Claude plan's usage through
    another app, and Anthropic may refuse such requests, or act on the account. The owner chose to offer the sign-in
    regardless, for the owner's own Environment. Its requests present themselves as Claude Code (its user agent and identity),
    as pi-ai's do, since Anthropic refuses an OAuth token's requests without the identity (SPI-1161 Q4). The panel names
    the risk as the owner's beside the sign-in.

Considered and not taken:

- **ChatGPT's device code on the Codex backend** (the spike's go): its sign-in runs in a Worker, but every request from
  our Workers to `chatgpt.com` is blocked at its edge.
- **pi-ai's `login()` in the Durable Object**: its attempt lives in memory and is lost before the paste.
- **Claude through the Model proxy only** (Commissary holds a Claude credential): the owner's Model endpoints decisions
  bring Subscriptions into t3flare, and the hard cut (SPI-1176) removes the proxy.
- **pi-ai's state as the verifier** for Claude: it puts the PKCE verifier in the browser's address and on Anthropic's
  page beside the code; a state of our own costs nothing, and Anthropic accepted it (the first real sign-in, on p1165).
- **t3's `CodexChatGptAuth`** (step-2a2's plan): it is the same OAuth flow, but tied to t3's provider settings and secret
  store, which the panel's sign-ins do not use.
