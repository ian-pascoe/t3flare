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

Report: [`docs-archive-1:docs/steps/spi-1164.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/spi-1164.md).

1. **A sign-in is a Model endpoint's auth.** An endpoint's auth is an API key, none, or a sign-in (`chatgpt` first,
   `claude` second (item 10), `copilot` third (item 11), each one entry in `SIGN_IN_KINDS` and one vendor in the
   broker). A sign-in fixes its endpoint's API and base URL and allows no headers of the owner's (Copilot's base URL is
   its token's, item 11); its auth never changes (remove the endpoint to change it). Until the hard cut (SPI-1176),
   Subscriptions could also stay connected in the Model proxy; since it, a Model endpoint's sign-in is the only place
   one lives in t3flare.
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
   twice, 30 s in all; Claude and Copilot: the vendor offers no revocation, items 10 and 11), whatever happened to the Sessions (each is given 5 s). The panel says `revoked` only when the
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
9. **The relay carries sign-ins since SPI-1171** (it refused them with 501 until then): see the SPI-1171 refinement
   below. No Workspace code asks for a sign-in's token through `endpointCredential`.

10. **Claude is a Claude Pro or Max plan through Claude Code's OAuth sign-in** (SPI-1165; report
    [`docs-archive-1:docs/steps/spi-1165.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/spi-1165.md)). It is pi-ai's copy-code flow: the owner approves at claude.ai,
    Anthropic's page shows a code (`code#state`), and the owner pastes it into the panel. Its client, URLs and scopes
    are pi-ai's (Claude Code's public client), pinned against pi-ai's own flow; its state is a random value of its own,
    not the PKCE verifier pi-ai sends as the state. Its endpoint is `anthropic-messages` at `https://api.anthropic.com`,
    and its requests take the shape pi-ai gives a Claude subscription's token (Bearer auth, Claude Code's betas, user
    agent and identity as the system's first block, its tool names), pinned in a test; the shape follows from the token,
    so an API-key endpoint refuses such a token as its key, and the shape reaches no other endpoint. Its tokens last 8
    hours and its refresh token rotates on every refresh, a replaced one refused (SPI-1161 Q5), so item 3's one
    refresher matters most here.

    **A refused refresh signs the endpoint out**, so a grant removed at claude.ai ends the sign-in rather than failing
    every turn as retryable. A refusal is a 400, 401 or 403 whose body is an error object: an OAuth error (a JSON object
    with a string `error`) or Anthropic's API error (`{ type: "error", error: { type } }`), but for Anthropic's passing
    codes (`temporarily_unavailable`, `server_error`, `slow_down`). Any other body (an edge's HTML page, none, a bare
    JSON value, a list, another object's shape) and any other status is passing trouble: retried at the next use, and
    shown on the panel until a renewal succeeds. **The accepted cost:** an error object at 400, 401 or 403 during an
    incident at Anthropic would sign the owner out (sign in again; the old grant stays at claude.ai), weighed against
    retrying a removed grant's refresh forever. What Anthropic answers for a removed grant is unverified. Sign-out
    forgets the account whole (Claude's next sign-in is hinted with nothing, so its email goes too).

    **Anthropic offers no revocation to apps** (SPI-1161: `platform.claude.com/v1/oauth/revoke` answers 404): sign-out
    deletes the tokens here and stops the Sessions; the grant stays on the owner's account until the owner removes it at
    claude.ai (Settings, Claude Code), which the panel says beside the sign-in, in Sign out's confirmation and in its
    answer.

    **The terms-of-service risk is the owner's, chosen knowingly** (owner decision, 2026-11-13). Claude Code's OAuth
    client is Anthropic's own, made for Claude Code; Anthropic's terms may not allow a Claude plan's usage through
    another app, and Anthropic may refuse such requests, or act on the account. The owner chose to offer the sign-in
    regardless, for the owner's own Environment. Its requests present themselves as Claude Code (its user agent and
    identity), as pi-ai's do, since Anthropic refuses an OAuth token's requests without the identity (SPI-1161 Q4). The
    panel names the risk as the owner's beside the sign-in.

11. **GitHub Copilot is a Copilot plan through GitHub's device flow** (SPI-1166; report
    [`docs-archive-1:docs/steps/spi-1166.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/spi-1166.md)), with the Copilot editor's public GitHub client, as pi-ai signs in
    to Copilot: the panel shows GitHub's device page and a code, the owner enters it there and approves, and the
    Environment asks GitHub whether it was approved once per panel ask, no sooner than GitHub's interval (slowed as
    `slow_down` says). The device code is sealed with the attempt, as item 7's state and verifier are; no paste.

    **Two tokens.** The long-lived GitHub token is the sign-in's grant, sealed, and sent only to GitHub's Copilot token
    endpoint. The short-lived Copilot token (about 30 minutes) is derived from it under item 3's lock, once however many
    Sessions ask, and given to a Session with the base URL the token names (`proxy-ep`, as pi-ai derives it, only https
    on `githubcopilot.com`, one rule the Session checks again) and the editor headers Copilot requires. Neither the base
    URL nor the headers are the endpoint's stored config: the endpoint keeps a fixed stand-in base URL for the target
    rule, and its requests go where the token says. The Session adds what pi-ai adds for its own `github-copilot`
    provider (the `X-Initiator` and `Openai-Intent` headers; no thinking-off `reasoning`), pinned on the wire against
    pi-ai's own provider. The endpoint speaks Copilot's Responses API only (one API per endpoint): Copilot's Claude and
    Gemini models, on its Messages and Chat Completions APIs, are not listed on it.

    **A refused renewal signs the endpoint out**, by item 10's rule: a 400, 401 or 403 whose body is an error object
    (GitHub's `{ message }` or an OAuth error), unless it is a rate limit: a 429, `retry-after`,
    `x-ratelimit-remaining: 0`, or a 403 whose message names a rate limit, too many requests or too many login attempts
    (GitHub answers its rate limits with 403 or 429, its secondary limits sometimes with only the message). That is a
    revoked GitHub token, or an account whose Copilot plan ended; anything else is passing trouble, retried and shown on
    the panel. A rate limit is retried only after the time GitHub names (`retry-after`, else the limit's
    reset; at least a minute, at most 15), kept as the credential's `earliestRefreshAt`, so the Sessions asking
    meanwhile get a retryable failure without each reaching GitHub. The accepted cost is item 10's: an error object at
    401 or 403 during an incident at GitHub signs the owner out.

    **GitHub offers this client no revocation**: it revokes an app's token only with the app's client secret, which a
    public client has none of. Sign-out deletes the tokens here and stops the Sessions; the grant stays on the owner's
    GitHub account until the owner revokes it at github.com, under Settings, Applications, which the panel says beside
    the sign-in, in Sign out's confirmation and in its answer.

    **The terms-of-service risk is the owner's, chosen knowingly** (owner decision, 2026-11-16, SPI-1166's E2). The
    client is the Copilot editor extension's; GitHub's terms may not allow a Copilot plan's usage outside its own
    editors, and its requests present themselves as that editor (its headers), as pi-ai's do. The owner chose to offer
    the sign-in regardless, for the owner's own Environment; the panel names the risk as the owner's beside the sign-in
    ("Your risk").

    **Unverified against a Copilot plan**: on p1166 GitHub's device flow ran from a Worker and the owner approved, but
    the owner's Copilot subscription had ended, so GitHub refused the Copilot token (403 `subscription_ended`) and no
    turn ran on it (SPI-1226).

Considered and not taken:

- **ChatGPT's device code on the Codex backend** (the spike's go): its sign-in runs in a Worker, but every request from
  our Workers to `chatgpt.com` is blocked at its edge.
- **pi-ai's `login()` in the Durable Object**: its attempt lives in memory and is lost before the paste.
- **Claude through the Model proxy only** (Commissary holds a Claude credential): the owner's Model endpoints decisions
  bring Subscriptions into t3flare, and the hard cut (SPI-1176) removes the proxy.
- **pi-ai's state as the verifier** for Claude: it puts the PKCE verifier in the browser's address and on Anthropic's
  page beside the code; a state of our own costs nothing, and Anthropic accepted it (the first real sign-in, on p1165).
- **pi-ai's Copilot `login()`**: it polls GitHub in a loop held in memory, which an isolate's restart loses; and it
  switches on the account's "unconfigured" model policies, which t3flare leaves to the owner.
- **One Copilot endpoint over all three of Copilot's APIs** (a per-model API): every endpoint has one API, which the
  target rule, the relay and the CLIs' lists build on; a second Copilot sign-in endpoint per API is the follow-up if
  the owner wants its Claude models.
- **t3's `CodexChatGptAuth`** (step-2a2's plan): it is the same OAuth flow, but tied to t3's provider settings and secret
  store, which the panel's sign-ins do not use.

## Refinement (SPI-1171, 2026-11-16): the model relay is a caller too

Report: [`docs-archive-1:docs/steps/spi-1171.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/spi-1171.md); the relay's side is ADR-0016's SPI-1171 refinement.

1. **The model relay asks at use time, per request.** `modelRelayTarget` gives a sign-in's access token for one relayed
   request (the broker's `access`, renewed first under item 3's lock when near its expiry). The Workspace DO hands it
   to the relay's route in the agents Worker and keeps only its hash; it never reaches the Container. A mid-thread
   renewal is the next request's, without restarting the CLI.
2. **A passing failure says when to try again.** `BrokerAccess` carries `retryAt` while a vendor's back-off holds
   (`earliestRefreshAt`, item 11): no caller reaches the vendor before then, and the relay passes it to the CLI as
   `retry-after`.
3. **Two broker reads for checks only.** `secrets` gives the stored access and refresh tokens, renewing nothing, only to
   the Environment DO's `signInLeakPatterns`, which hashes them for the admin leak check: no RPC answers with a token,
   one too short to hash is only named, and only hashes go to the Workspace DO (ADR-0016's SPI-1171 item 6;
   `signInSecretsReach.test.ts` pins the one caller). `expire` marks the stored token expired so its next use renews
   it; the Environment DO's `expireSignIn` runs it only where its faults are on (`T3FLARE_FAULTS=1`, bound on every
   stage but prod), whoever calls it, and the admin route checks the same (`expireHook.test.ts`).
4. **Unverified live** (owner decision, 2026-11-16): no subscription was signed in on the stage, so no CLI turn on a
   subscription, no live mid-thread renewal and no live sign-out ran through the relay. Each is unit-tested.

## Refinement (the open-source release, 2026-11-19): the sign-ins stay, with each vendor's terms in front of the Owner

The Canonical repository is public, so "the owner" in items 8, 10 and 11 is any Deployment's Owner. The ChatGPT, Claude
and Copilot sign-ins stay as built: each Deployment signs in for its one Owner and shares the sign-in with no one, and
the Owner who signs in accepts the vendor's terms. The Claude and Copilot sign-ins present their requests as Claude Code
and as the Copilot editor (items 10 and 11), which is the case those vendors' terms speak to most directly. Three things
change, none of them in the broker:

- `docs/model-endpoints.md` gives each vendor's terms in the vendor's own sentences, from
  [`docs/research/oss-release-facts.md`](../research/oss-release-facts.md) Part D.
- The Harness panel shows the same text where a sign-in starts, and the Owner ticks an acknowledgement before it starts.
- The README names API keys only; the sign-ins are documented in `docs/model-endpoints.md`.
