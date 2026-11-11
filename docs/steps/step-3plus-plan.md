# Step 3+: plan (a publish-only T3 Connect link: the owner's phone hears when a cloud run ends or waits)

Date: 2026-11-11. Written on `main` at 25b8b11 (step 3 done), t3code pinned at `v0.1.9-nightly.20261111.4515`.
Planning only: nothing here is built. Row 3+ of [`docs/plan.md`](../plan.md): "Publish-only T3 Connect link — mobile
notification when a cloud run ends or waits on the owner".

**Paths:** `srv/` = `t3code/apps/server/src/`, `con/` = `t3code/packages/contracts/src/`, `relay/` =
`t3code/infra/relay/src/` (T3 Connect's relay is open source and sits in the submodule), `env/` =
`apps/environment/src/`.

## Changelog: review findings (Fable) and owner decisions, 2026-11-11

These override the sections below wherever they disagree. Each was checked against the pin as it was reached; the
verdict and the evidence are given. The report records how each was built.

**Owner decisions.** D1 yes, D3 accept (plus the upstream ask), D4 yes, as defaulted. **D2 changed:** the stage keeps
the account token; **prod discards it right after the link** (sign-out stays available, and works without the token
for the local part). If the relay accepts the token for broad client-group operations, discarding is mandatory (it
does: finding 5).

1. **HIGH, security: `health` and `mint-credential` have no scope check, and a DO 404 is one layer only.**
   *Verified.* `srv/cloud/http.ts:153-163` calls `answerHealthRequest` and `mintCredential` with no
   `requireEnvironmentScope`; mint needs only a proof signed with the stored mint key and returns a 2-minute pairing
   credential with `AuthStandardClientScopes` (`CloudLink.ts:1522-1625`). Also verified: our first-pairing sessions
   have subject `desktop-bootstrap` (`auth/PairingGrantStore.ts:334-336`), the one subject `linkProof` lets sign a
   proof from a non-loopback host (`CloudLink.ts:628-643`). Built:
   - **Refusal at the service.** `CloudHttp.layer` gets a `CloudLink` whose `linkProof`, `applyRelayConfig`,
     `answerHealthRequest` and `mintCredential` fail, as t3's policy variant does (`CloudLink.ts:1635-1657`). Our
     Connect service keeps the real one. Both are built in `layerMakeServer` from one `CloudLink.layer` value, since
     `CloudLink` is provided only to the routes there.
   - **`cloud-mint-ed25519-public-key` is deleted after every link.** Publishing never reads it
     (`AgentAwarenessRelay.ts` reads URL, issuer and environment credential only); without it, mint and health fail
     even if reached, and `RelayDeliveryProof` (mounted with the webhook route) verifies nothing.
   - **The DO 404 stays,** for any method, tested with trailing-slash, case and percent-encoded variants. The refusals
     are verified on prod before its sign-in (A3).
   - **The ADR reasons are corrected:** `relay-config` accepts any https relay URL and any well-formed mint key from a
     `relay:write` session while no account is linked; a `manual` link proof lets another account link this
     environment, receive its pushes and, by relinking, revoke our credential.
2. **HIGH: a relink can fall back to a managed tunnel.** *Verified.* Unlink removes the desired-link mark, and its
   absence reads as `managed` (`srv/cloud/CliState.ts:29-42`; `managedTunnelsEnabled = mode !== "publish_only"`,
   `CloudLink.ts:852`). Built: every link operation writes `publish_only` itself, asserts the mode the reconcile
   returns, and unlinks if `cloud-endpoint-runtime-config` exists afterwards. Test: relink after unlink.
3. **MEDIUM: the drain does not cover retries or the 5 s confirmation.** *Verified.* `drain` waits for queued and
   in-flight items only; retries and the confirmation are forked sleeps (`AgentAwarenessRelay.ts:794-817`, `:904`).
   The worst case (five retries with 10 s timeouts) is about 91 s, longer than the 60 s idle window. Built instead of
   the drain: the recorder counts threads with a deferred or a failed-not-exhausted publish, and `idleVerdict` holds
   while any exist, capped at 120 s. No await is added between `setAlarm` and `abort` (`environmentDO.ts`
   `checkIdle`). **Accepted loss:** a deploy (or eviction) has no hook, so a publish pending at that moment is lost.
4. **MEDIUM: a restart's mapping has gaps.** Recovery runs before the relay starts; catch-up skips threads whose state
   is null; `cancelled` maps to null. A restart while an approval waits has no continuation (ADR-0004), so the relay
   keeps "Approval needed"; a completion inside the 5 s hold at a restart is lost. Built: M2 cases
   restart-while-approval and restart-while-`ask_user`; then either tombstones after boot for threads the recorder
   last saw live, or the gap recorded as accepted (decided on the M2 evidence). Pairing is never armed during a
   sign-in (an in-place restart kills the sign-in fiber): arm refuses while a sign-in is pending.
5. **MEDIUM: D2 and R8 understate the account token.** The relay accepts it as `clerk_oauth_bearer` on the whole
   client group: it can unlink environments, delete the laptop's tunnel and link an attacker's environment. Built:
   prod discards it after the link (above); P6 decides by status code, not by body; ADR-0025 states the
   single-holder rule and that this is the first account credential the DO holds.
6. **MEDIUM-LOW: admin exposure.** The stage's Access service token is admitted, and CI holds it with the admin token.
   Built: on prod, Connect mutations and the R1 token import require the owner's Access identity (an Access assertion
   with the owner's email), never the service token. The Worker tells the DO which kind of caller it admitted.
7. **LOW: public config.** *Verified:* all three values are in `t3code/.env.example:9,11,22`, public, and account
   constants rather than per-release values. Built: inlined as build defines (no JSON file, no executable read); a
   test compares them with `.env.example`, so the bump fails on a change. A change requires a prod re-sign-in
   (documented).
8. **LOW: 401s.** t3 retries 5 times and never marks a publish-only link revoked. Built: the recorder classifies a
   failure's status from the `Cause.pretty` text (redacted) and the status route reports `rejected`. M2 case: remove
   the environment in the app, then publish.
9. **LOW: privacy.** Thread and project titles reach APNs/FCM in the alert. Stated in the docs and in D1.

**Milestones, re-ordered.** The real device-code approval (A1) moves to the end of M0: a throwaway link and one
publish on the stage, so the token poll, the relay accepting the bearer, the real link and the publish proof are
proven before the rest is built. If Clerk blocks Worker IPs, the R1 fallback (a headless CLI token import) is used,
which implies D2 = discard everywhere.

## 0. The answer in one paragraph

Our composition already holds every piece t3 uses for this: `CloudLink`, `CliTokenManager`, `AgentAwarenessRelay`
(started by t3's runtime startup) and the `/api/connect` routes. Nothing ever signs in or links, and our build leaves
out the three public values t3 needs to find T3 Connect. So step 3+ adds no Patch and no Shadow. It adds:

- those public values as build defines;
- an admin-route sign-in that runs t3's own device flow inside the Environment DO;
- t3's own `publish_only` link step (`CloudLink.reconcileDesiredLinkIfStillDesired`), run once at sign-in rather than
  at every boot;
- a recorder that keeps the outcome of each publish;
- refusals for the relay routes that only a tunnel or a client-driven link would use.

t3 then publishes on its own whenever a thread's awareness phase changes, and the relay pushes to the phone. The
Environment is already awake whenever a run is open, so the publish happens live and the idle alarm needs no change.

## 1. What the research claimed, checked against the pin

| Claim | Verdict | Where |
|---|---|---|
| The phone attaches directly to `https://t3.ianpascoe.dev` by pairing link | Taken as given (the owner's report); nothing here changes it | — |
| Push goes only through T3 Connect | **True.** The phone registers its APNs/FCM token with the relay under a Clerk login. The relay delivers each publish to every device of every account linked to that environment | `apps/mobile/src/features/agent-awareness/remoteRegistration.ts:360-420`; `relay/agentActivity/AgentActivityPublisher.ts` |
| `AgentAwarenessRelay` is composed but publishes only with relay URL, environment credential and publish flag stored | **True.** It is composed at `env/t3/composition.ts:564` and started by `srv/serverRuntimeStartup.ts:554`. Each publish re-reads the three secrets | `srv/cloud/config.ts:52-79`; `srv/relay/AgentAwarenessRelay.ts:480-498` |
| Upstream starts the link at server startup; our composition replaces that step | **True.** The startup block is `srv/server.ts:1055-1175`, and `reconcileDesiredCloudLinkWith` is `srv/cloud/CloudLink.ts:837-907`. Our `layerMakeServer` has no such block (`composition.ts:743`) | |
| The publish-only link is `manual`, scope `agent_activity_notifications`, no tunnel | **True** | `srv/cloud/linkChecks.ts:124-130`; `CloudLink.ts:852-871`; `srv/cli/connect.ts:580-618,642-660` (the CLI also sets the publish flag) |
| Sign-in is a CLI device flow (`publicConfig.ts:170-215`) | **True, with a gap.** `publicConfig.ts` only derives the Clerk endpoints. The flow is `deviceAuthorizationLogin` (`srv/cloud/CliTokenManager.ts:438`). Its inputs (relay URL, Clerk publishable key, CLI OAuth client id) are build-time defines (`__T3CODE_BUILD_*`, `t3code/apps/server/vite.config.ts:128-138`). **Our `build.ts` defines none of them**, so today `hasCloudPublicConfig` is false and the relay URL config fails | `apps/environment/build.ts:288` |
| A link takes one of the account's 3 free machine slots | **False for publish-only.** The limit counts managed-tunnel allocations only. A link with `managedTunnelsEnabled: false` provisions nothing, and the relay even deprovisions any old tunnel for it | `relay/environments/ManagedTunnelLimits.ts`; `relay/environments/EnvironmentLinker.ts:291-322` |
| `CloudHttp.layer` is mounted (SPI-1005) | **True** (`composition.ts:701`). §5 decides route by route | |

Six facts the claims did not have:

1. **The environment credential does not expire.** A relink revokes the previous one
   (`relay/environments/EnvironmentCredentials.ts`). Removing the environment in the T3 apps revokes the link, and its
   publishes are then refused. So nothing needs refreshing on a timer.
2. **t3's `CloudLink.unlink` is local only.** The relay-side unlink is the client API
   `DELETE /v1/client/environment-links/:environmentId`, called with the account's token (`con/relay.ts:1117`).
3. **The web or mobile client cannot link the cloud.** t3 signs a link proof only for a loopback origin
   (`linkChecks.ts:98-113`), so only the server-side step works, with a loopback origin as upstream's laptops use.
   For a `manual` link the relay records that origin as metadata only (`EnvironmentLinker.ts:316`: "publish-only links
   route out of band").
4. **The relay alerts on transitions.** A move into `waiting_for_approval` or `waiting_for_input` alerts. So does a
   move into `completed` or `failed`, but only if `updatedAt` is within 2 minutes of the relay's clock. The device's
   per-phase preferences decide which of these alert (`relay/agentActivity/agentActivityAlerts.ts`).
5. **A usage-limit pause is a `failed` run** (`env/provider/differ.ts:609-653`). The phone says "Agent failed", and the
   relay forces the detail to "The agent run failed." (`AgentAwarenessRelay.ts:198-210`).
6. **`/api/t3-connect/mint-credential` lets the relay mint a 2-minute session** with the standard client scopes for
   any client the relay vouches for (`CloudLink.ts:1522-1625`). For a publish-only link the relay never reaches it,
   because the endpoint it records is loopback. §5 refuses it.

## 2. Sign-in

### 2.1 The flow (admin routes, t3's device flow in the Environment DO)

1. **`POST /_t3flare/connect/sign-in`** (Access plus the admin token, like every `/_t3flare` route) forks t3's
   `deviceAuthorizationLogin` in the Environment's runtime scope. Its `showPrompt` callback completes a Deferred that
   the route awaits. The route answers `{ userCode, verificationUri, verificationUriComplete, expiresIn }`. Nothing
   in the answer is secret: the device code stays in the fiber's memory and is never stored.
2. While the fiber polls, it **holds the Environment awake**: a counter that `idleVerdict` reads, like
   `activity.inFlight`, released when the flow ends or after `expiresIn`. Otherwise the idle reset would kill the poll
   60 s after the route returns.
3. **The owner** opens the URL, signs in to T3 Connect with the account their phone uses, and approves the code (§9,
   A1).
4. When t3's poll gets a token, the fiber does four things, all through t3's own services:
   - stores the token (`CliTokenManager.store`);
   - sets the desired link to `publish_only` (`CliState.setCliDesiredCloudLink(true, "publish_only")`);
   - sets `cloud-publish-agent-activity` to `true`, as `t3 connect link --publish-only` does;
   - runs `CloudLink.reconcileDesiredLinkIfStillDesired("http://127.0.0.1:<ServerConfig.port>")`. That call asks the
     relay for a challenge, signs the proof (`manual`, `agent_activity_notifications`), links, and stores the relay
     URL, issuer, environment credential, cloud user id and mint key. It also calls
     `awarenessRelay.requestCatchUp()`, so publishing starts at once.
5. **`GET /_t3flare/connect/status`** reports:
   - the flow (`idle | pending | linked | failed`, with t3's error tag);
   - t3's `linkState()`, which holds no secret values;
   - with `?relay=1`: the relay's `GET /v1/environments` and `GET /v2/client/devices`, called with the stored token and
     reduced to environment ids, endpoint kinds, device platforms and preferences;
   - the publish recorder (§4.4).

   A script `apps/environment/scripts/connect.ts <stage> sign-in|status|publish on|off|relink|sign-out` wraps these
   routes. The sign-in subcommand prints the code and URL, then polls the status route until it reports linked.

Why the device flow in the DO, and not the laptop's existing T3 Connect sign-in: a rotating credential has one holder,
and is never copied from the laptop to the cloud (the rule kept from ADR-0018). The browser-PKCE variant
(`CliTokenManager.login`) needs a loopback callback server, which a Worker cannot run.

### 2.2 Where the credentials live, and idle resets

t3 writes everything to its `ServerSecretStore`, which in t3flare is DO key-value storage
(`env/platform/secretStore.ts`), apart from SQL:

- `cloud-cli-oauth-token`: the Clerk access token and refresh token, with scopes `openid profile email
  offline_access`. This is an account-level token: with it the holder can link and unlink environments and list
  devices.
- `cloud-relay-environment-credential`: a publish-only bearer.
- The relay URL, issuer, cloud user id and mint key, and the desired-link mark.

The store is the same one that holds t3's environment signing key, which is the more powerful secret. Cloudflare
encrypts DO storage at rest; the application adds no envelope encryption. Adding one (a Worker-secret key that wraps
these values) protects nothing the signing key would not already give away, so the plan does not add it. Owner
decision D2 is about keeping the account token at all.

The values survive an idle reset (`ctx.abort()` keeps storage) and a deploy. At each boot, `AgentAwarenessRelay.start`
reads them and logs "agent activity publishing enabled". A second later it publishes the active threads (its own
catch-up). **No relink at boot.** Upstream relinks on every server start. Here that would be a relay round trip and a
revoked-then-reissued credential on every wake, many times a day, and it would undo an unlink the owner made in the
app.

The peer-leak check (`POST /_t3flare/check/peer-leak`) gains these two secrets, by name. The step's exit includes a
check that neither appears in a Container, a Session's state, `/_t3flare/agents/session` or Workers Logs (the
redacting Console already redacts bearer values).

### 2.3 Refresh

- **Environment credential:** never expires, so no refresh. If the relay starts refusing publishes (the owner removed
  the environment in the app, or the relay revoked it), the recorder shows the 401/403. The status route reports
  `rejected`, and the owner relinks (`connect.ts relink`, which runs the reconcile step again with the stored account
  token). **Nothing relinks automatically**, because an automatic relink would override the owner's removal.
- **Account token:** t3's `CliTokenManager.getExisting` refreshes it when it is used and close to expiry, holding a
  lock, and persists the rotated refresh token. The cloud is the token's only holder, so no other refresher competes.
  If the refresh is refused (a dead refresh token), relink and sign-out report it, and a new device sign-in replaces
  it.

### 2.4 Sign-out and unlink

`POST /_t3flare/connect/sign-out`:

1. Calls the relay's `DELETE /v1/client/environment-links/<environmentId>` with the account token. This is best
   effort; a failure is reported, and the owner can remove the environment in the app.
2. Runs t3's `CloudLink.unlink()`, which removes the relay secrets and the publish flag and clears the desired link.
3. Runs `CliTokenManager.clear`.

The status route then shows `linked: false` and no token. `POST /_t3flare/connect/unlink` does steps 1 and 2 and
keeps the token, ready for a relink. The web client's Disconnect (`/api/connect/unlink`, kept in §5) remains a
local-only alternative.

## 3. The link at boot or wake, and the alarm

### 3.1 No link step at boot

The link is made once (§2.1) and lives in storage. The Layer added in this step does nothing at boot, beyond what t3's
`AgentAwarenessRelay.start` already does. Every wake publishes with the stored credential. The Layer is a small
service in `env/connect/` that owns the routes' Effects, the sign-in fiber and its idle hold, the recorder and the
idle drain (§3.3).

### 3.2 Is the Environment awake when a run ends or waits?

Yes, in every case this step needs:

- **Open runs keep the Environment awake.** `idleVerdict` counts a run in `preparing | queued | starting | running |
  waiting`, and an open provider session, as work (`env/host/idle.ts:39-40`). From a Durable agent turn's start to its
  end, the Environment never resets, whether or not a client is connected. The running and waiting transitions
  (approval, `ask_user`, a linked push's `git-push` approval, an MCP-tool approval) are published live.
- **A turn that ends with no client connected:** the Session's last push is a DO RPC, so the Environment is up while t3
  projects it. t3's relay sees the domain event and holds a completion for its 5-second confirmation
  (`AgentAwarenessRelay.ts:604-630`), then publishes. The idle reset needs 60 s without a request and without open
  work, so the publish lands with time to spare.
- **An Environment restart mid-turn** (a deploy, an eviction): when the Session next pushes, the Environment boots
  again. t3's relay starts with an empty published-state map, and its catch-up republishes active threads. When the run
  ends, `terminalWorkSinceStart` holds (the completion is projected after the boot), so the completion is published.
  The relay still has the thread's earlier `running` row, so it alerts on the move.
- **Usage-limit pause and resume:** the turn ends `failed` and is published at once. The Environment then idles and
  resets. The existing usage-limit alarm wakes it at the reset time (`nextDue`), t3 resumes the thread, and the new run
  is published again (`running`, later `completed`). This step adds no alarm.

### 3.3 The remaining gap, and its mitigation

t3 retries a failed publish 5 times (1, 2, 4, 8 and 16 s, each with a 10 s timeout). If the relay is down for longer
than the 60 s idle window, a reset can drop the last retry. To narrow that window, the idle path calls t3's
`AgentAwarenessRelay.drain` (bounded to 15 s) before `ctx.abort()`. A publish that still fails is lost; the recorder
shows the failure. This is accepted (§8, R6).

## 4. What gets published

### 4.1 The mapping

t3 publishes one state per top-level thread (`projectThreadAwarenessV2`, `packages/shared/src/agentAwareness.ts`).
The events that trigger it are listed at `AgentAwarenessRelay.ts:78-138`. Our runs map as follows:

| Our run | t3's state the differ produces | Phase published | Phone alert (device preferences) |
|---|---|---|---|
| A Durable agent turn starts or runs | run `starting`/`running` | `starting`, `running` | none (Live Activity card on iOS if enabled) |
| A tool call needs approval (`permission`, `mcp-tool`, `git-push` kinds) | `pendingRuntimeRequest` | `waiting_for_approval` | "Approval needed" (`notifyOnApproval`) |
| `ask_user` | `user_input` request | `waiting_for_input` | "Waiting for input" (`notifyOnInput`) |
| The turn ends with an answer | run `completed` | `completed`, held 5 s, published if no continuation starts | "Agent finished" (`notifyOnCompletion`) |
| The turn fails, including a usage limit (`Usage limit reached`) | run `failed` | `failed`, detail replaced by "The agent run failed." | "Agent failed" (`notifyOnFailure`) |
| The owner stops the turn | `interrupted` / stop requested | none (tombstone) | none |
| A linked (laptop-delegated) cloud thread | the same, on that thread | the same | the same |

There is one test of ours. The differ's fixtures (step 2a's, step 3's question and approval kinds, part 2's usage
limit) are run through t3's `projectThreadAwarenessV2`, and the test asserts each row of this table. If a bump changes
the mapping, the test fails.

### 4.2 Privacy: what leaves for `t3.codes`

- **At link:** the environment's descriptor (environment id, label, `platform.machine: "cloud"`, server version,
  capabilities) and its public signing key. The endpoint sent is loopback (`http://127.0.0.1:<port>`). The public host
  is never sent.
- **Per publish:** environment id, thread id, **project title, thread title**, phase, a fixed headline, a fixed detail,
  the **model id**, `updatedAt` and a deep link (`/threads/<environmentId>/<threadId>`). No message text, tool input or
  output, diff, file name or failure text; t3 replaces failure details.
- **Not sent:** t3's relay-client traces. They need build-time OTLP defines that we do not set. Product analytics stay
  off (D1 of the parity audit, SPI-995).

A thread title is generated from the first prompt and can carry what it names (a customer, a bug). The owner decides
whether that is acceptable (D1).

### 4.3 The owner's control

- **Everything off:** `connect.ts publish off` (t3's `updatePreferences`, `publishAgentActivity: false`). This is also
  available from any client that shows the link state for the environment: `/api/connect/preferences` stays mounted.
  The relay keeps the link, and nothing more is sent.
- **Per kind of alert:** the phone app's notification preferences (approval, input, completion, failure) are stored
  on the relay per device.
- **Stop the link:** sign-out (§2.4), or remove the environment in the T3 apps.

### 4.4 The publish recorder

`AgentAwarenessRelay` calls the relay through its own `FetchHttpClient`, so nothing of ours sees the response. It does
log each outcome: "agent activity publish completed" with `ok` and delivery statistics, "agent activity publish
failed" with the cause, and the deferrals. A Logger Layer of ours, beside the redacting Console, keeps the last 100 of
these log events: thread id, phase, reason, `ok`, deliveries (total, queued, successful, failed, kinds, reasons), and
for failures the HTTP status. They are held in DO memory and mirrored to DO storage, so they survive a reset, and the
status route shows them. This is the phone-less evidence, read as t3 reads it. The log messages it matches are a new
fragility entry (§10).

## 5. Routes

| Route | Decision | Why |
|---|---|---|
| `GET /api/connect/link-state` | **Keep** | The web client's MCP "Use in another app" dialog and the Connect dialog read it (`apps/web/src/components/mcp/UseInAnotherAppDialog.tsx:254`); scope `relay:read` |
| `POST /api/connect/preferences` | **Keep** | The owner's on/off switch from a client (§4.3); scope `relay:write` |
| `POST /api/connect/unlink` | **Keep** | The web client's Disconnect; local only |
| `POST /api/connect/reachability` | **Keep** | The same dialog calls it. With no managed tunnel, t3's check makes no outbound call and answers "not linked/no tunnel" (`srv/cloud/ConnectReachability.ts:274-292`) |
| `POST /api/connect/link-proof` | **Refuse** (404 in the Environment DO, before t3, as the bootstrap refusals do) | Only our admin path links, and it calls `CloudLink` directly. A request crafted from a `desktop-bootstrap` session could get a proof for a `cloudflare_tunnel` link (`linkChecks.ts:98-113` and `CloudLink.ts:628-643` waive the loopback request host for that subject) |
| `POST /api/connect/relay-config` | **Refuse** | Only our admin path writes relay config. A client-supplied `cloudflare_tunnel` runtime would try to start `cloudflared`, which the image does not have |
| `POST /api/t3-connect/health` | **Refuse** | The relay calls it only through a managed tunnel; a publish-only link records a loopback endpoint |
| `POST /api/t3-connect/mint-credential` | **Refuse** | It would let `t3.codes` mint 2-minute client sessions on the cloud Environment. The cloud's sessions come only from its own pairing (ADR-0010) |

**SPI-1005.** That ticket asks either to refine ADR-0010 or to refuse these routes, and the parity batch may land it
first. Either way, the end state after 3+ is the table above. If SPI-1005 refuses all eight, 3+ reopens the four kept
routes. If it documents them, 3+ adds the four refusals. The 3+ branch rebases on whichever has landed.

**The ADR-0010 refinement (written with the report):** "T3 Connect, publish-only. The cloud links outward to
`relay.t3.codes` with a `manual` link scoped to agent-activity notifications, signed in by the owner through t3's
device flow from an admin route. It sends thread and project titles, phases and model ids, never content. It answers no
relay-initiated route: `/api/t3-connect/*`, `link-proof` and `relay-config` are refused in the Environment DO, so
T3 Connect can neither reach the Environment nor mint a session on it. No tunnel, no `cloudflared`, no machine slot."
The paragraph's 'no relay routes' line becomes "relay routes only for link state, preferences, unlink and the
reachability answer".

A new ADR-0025 records the hard-to-reverse choice: "Mobile notifications come from t3's own publisher over a
publish-only T3 Connect link, signed in once by device flow and never relinked at boot". The options it considers:
t3's startup relink (rejected: churn, and it undoes the owner's unlink); our own push service (rejected: the mobile app
registers only with the relay); a managed tunnel (rejected: ADR-0010).

## 6. Sub-milestones (riskiest first)

All deploys go to a throwaway stage `step3plus`, added to `STAGES` in `apps/environment/scripts/stage.ts` in M1's first
commit and destroyed at the end. `prod` is never deployed, linked or run against until the merge. Evidence goes in
`docs/steps/step-3plus/`.

### M0. Settle the unknowns (no owner, about half a day)

- **P1, public config.** Read the relay URL, Clerk publishable key and CLI OAuth client id from the pinned release's
  executable (the values every t3 client ships; today `https://relay.t3.codes` and a `pk_live_…` key). Check them in as
  `env/t3/connectPublicConfig.json` and define them in `build.ts`. A workerd test asserts `hasCloudPublicConfig`,
  `relayUrlConfig` and `cloudCliOAuthConfig` resolve. (`m0-public-config.json`)
- **P2, Clerk and the relay from workerd.** On `step3plus`, an admin probe:
  - `GET https://relay.t3.codes/health` from the DO;
  - starts a device authorization against Clerk and discards the code without anyone approving it, which proves the
    client id accepts the device grant from a Worker.

  (`m0-reachability.json`)
- **P3, the phase mapping.** The §4.1 test on the differ's fixtures. (`m0-phases.json`, kept as a unit test)
- **P4, the link step against a fake relay.** A workerd test with t3's `CloudLink` and a fake relay (challenge, link,
  publish endpoints). It asserts the proof (`providerKind: "manual"`, scopes exactly `["agent_activity_notifications"]`,
  loopback origin, `managedTunnelsEnabled: false`), the stored secrets, and that a publish carries the environment
  credential and a valid signed proof.
- **P5, policy and reachability.** `ManagedLimits.allowsConnect` holds in our composition (no policy document), and
  `/api/connect/reachability` answers without an outbound call.
- **P6 (optional), the relay's view without a phone.** Whether the account token is accepted as the `subject_token`
  of `/v1/client/dpop-token`. If it is, `GET /v1/mobile/agent-activity` returns the relay's stored rows, a second
  phone-less proof of what the relay accepted. If not, the recorder alone is the evidence.

Exit: the JSON files, and a one-paragraph decision for each fallback taken (§8).

### M1. The machinery on the stage (no owner)

The work:

- Build defines (P1).
- `env/connect/`: the routes' Effects, the sign-in fiber with its idle hold, relink, publish on/off, unlink, sign-out
  (§2).
- The publish recorder Logger (§4.4).
- The idle drain (§3.3).
- The four route refusals in the Environment DO (§5).
- The peer-leak check's new secret names.
- `scripts/connect.ts`.

Unit tests: the refusal path set, the idle hold and its release on success, failure and expiry, and the recorder's
parsing of t3's log annotations. Workerd tests: P4 extended to sign-out (relay `DELETE` called, secrets gone, desired
link cleared) and to relink.

Exit on `step3plus` (`m1-stage.json`):

- `connect.ts sign-in` returns a code. It is left to expire, and the hold is released afterwards: `/_t3flare/health`
  shows the Environment resetting within 2 minutes of expiry.
- The four refused routes answer 404, and the four kept ones answer as t3 does unlinked.
- `status` reports `linked: false`.
- `bun run check` passes.

### M2. The real link, proved without a phone (owner: A1, about 3 minutes)

1. `connect.ts step3plus sign-in`. **The owner approves the code (A1).** `status?relay=1` shows the link: the relay
   lists the environment with a `manual` endpoint, and with publishing on.
2. Scripted runs on `step3plus`, from the stock web client's protocol as the step 2a and 3 scripts drive it:
   - **(a)** a turn that completes, its client disconnected before the end;
   - **(b)** an approval-required `bash`, answered after 30 s;
   - **(c)** an `ask_user` question, answered after 30 s;
   - **(d)** a proxy-fault usage limit (part 2's `proxy-fault`);
   - **(e)** a Stop mid-turn;
   - **(f)** an admin `restart?mode=abort` mid-turn, then completion;
   - **(g)** publishing off, then one turn.
3. Checks, read from the recorder:
   - (a) `running` then `completed`, `ok: true`;
   - (b) `waiting_for_approval`;
   - (c) `waiting_for_input`;
   - (d) `failed`;
   - (e) no alertable phase;
   - (f) a `completed` publish after the boot;
   - (g) no publish at all.
4. After the last run, the Environment resets when idle (health), and the next wake publishes nothing new.
5. The leak check: 0 for both new secrets. Workers Logs contain no environment credential and no token.

Exit: `m2-link.json`, `m2-publishes.json` (each run's recorder rows), `m2-leak.json`, and the relay's rows from P6 if
available.

Deliveries go to every device registered to the account. If the owner's phone is already signed in to T3 Connect, it
buzzes during M2. The recorder's `deliveries` then shows the APNs/FCM results; that is extra evidence, and the owner is
told in advance (A0).

### M3. The owner's phone (owner: A2, about 15 minutes; the exit criterion)

1. The owner's phone is signed in to T3 Connect with the same account, with notifications allowed (A0).
2. Optionally, the phone pairs to `step3plus` with a pairing link I give, so that tapping a notification opens the
   thread.
3. I start two runs on `step3plus` with no client attached: one that completes, and one that calls `ask_user`.
4. The owner confirms:
   - "Agent finished" arrived for the first run, and "Waiting for input" for the second;
   - (optionally) tapping the second opens the thread, and the owner answers from the phone;
   - screenshots.
5. The recorder for the same runs shows deliveries with `successful ≥ 1` (APNs) or `queued` (FCM).

Exit: `m3-phone-*.png` and `m3-deliveries.json`. **This is the plan row's exit criterion:** the owner's phone is
notified when a cloud run ends and when one waits on them.

### M4. Close (no owner)

- `connect.ts step3plus sign-out`: the relay no longer lists the environment (`status?relay=1` before the token is
  cleared), and the secrets are gone (`m4-sign-out.json`).
- The bump job runs P1's check: the public config matches the new release's executable; a mismatch fails the bump.
  It also runs the workerd fake-relay test (part of `bun run check`). The bump job never signs in.
- Documents:
  - the report `docs/steps/step-3plus.md`;
  - ADR-0025 and ADR-0010's refinement (§5);
  - GLOSSARY: **T3 Connect** (the hosted relay at `t3.codes` that pushes to the owner's phone) and **Publish-only
    link**;
  - `docs/parity.md` (Mobile push → W);
  - README status;
  - the plan row;
  - `docs/upstream-fragility.md` U28 (§10);
  - the upstream asks (§11).
- Destroy `step3plus`. If the phone paired to it, the owner removes it there.

## 7. Tests, summarised

| Kind | What |
|---|---|
| Unit | refusal paths; idle hold; recorder parsing; the §4.1 phase table on the differ's fixtures |
| workerd | public config resolves; `CloudLink` link, relink, sign-out against a fake relay; publish carries credential and proof |
| Stage, no owner | M1 (sign-in starts, hold released, refusals), M2 (every row of §4.1 published to the real relay and accepted), M4 sign-out |
| Owner, once | A1 (approve one device code), A2 (the phone) |
| Bump job | public config matches the release; the workerd tests through `bun run check` |

## 8. Risks and unknowns

| # | Risk | Settled by | Fallback |
|---|---|---|---|
| R1 | Clerk refuses the CLI client's device grant from a Worker (IP reputation, bot checks) | M0 P2 | The owner runs `t3 connect login --headless` once on a throwaway `T3CODE_HOME` on the laptop, and an admin route imports that token, which then lives only in the cloud. The ADR-0018 rule holds: there is one holder from then on, and the laptop copy is deleted |
| R2 | Our build lacks the public config, and a value changes upstream | M0 P1; bump check | Pin it in the JSON; the bump fails loudly |
| R3 | The mobile app lists the publish-only cloud environment from the relay beside the directly paired one, and the relay copy has a loopback endpoint | M3 | Upstream's publish-only laptops look the same. If the app misbehaves, an upstream ask; the notification still arrives |
| R4 | Tapping a notification does not open the thread, even with the environment paired directly (environment id match) | M3 | Notifications still arrive; upstream ask |
| R5 | A usage-limit pause reads "Agent failed" | by design (t3) | Owner decision D3; upstream ask for a paused phase |
| R6 | A relay outage longer than the idle window loses the last publish | §3.3 drain | Accepted; the recorder shows it |
| R7 | t3's relay retries or confirmations change on a bump | U28; M2 rerun on bumps by hand | — |
| R8 | The account token, if the Environment were compromised, can link and unlink environments and list devices on the owner's T3 Connect account | D2 | Discard the token after linking (D2 alternative) |
| R9 | T3 Connect's terms or availability change (a beta service; no fee today) | the terms, read 2026-11-11 | Publishing off; nothing else depends on it |
| R10 | SPI-1005 lands a different route decision first | coordination | Rebase; §5's end state |

## 9. Owner decisions and actions

### Decisions (defaults are built if nothing is said)

- **D1. Use T3 Connect at all, given what it sends.** Thread and project titles, phases and model ids go to
  `t3.codes` (§4.2). The terms (effective 2026-07-15) allow personal use of T3 Connect from your own environment;
  nothing in them forbids a self-hosted server linking. **Default: yes.**
- **D2. Keep the T3 Connect account token in the cloud after linking.** If kept, relink and the relay-side unlink work
  without a new sign-in, and the status route can list the relay's view. If discarded, least privilege: only the
  publish credential stays, and a relink or relay unlink needs a new device sign-in (or the app). **Default: keep**,
  removed by sign-out.
- **D3. Usage-limit pauses.** They notify as "Agent failed", which is t3's phase. Accept it (with failure alerts
  switchable on the phone), or suppress them, which needs a Shadow of the publisher and is not recommended. **Default:
  accept**, plus the upstream ask.
- **D4. Linked work notifies.** Cloud threads started by the laptop's delegation are ordinary threads and publish like
  any other. **Default: yes, as t3.**

Corrected, not a decision: the link uses **no** machine slot (§1).

### Actions

- **A0 (any time before M2, about 2 minutes).** Tell me:
  - which T3 Connect account to use;
  - whether your phone runs iOS or Android.

  Then sign in to T3 Connect in the T3 Code mobile app with that account and allow notifications. Expect test
  notifications from `step3plus` during M2.
- **A1 (M2, about 3 minutes, when I ask).** Open the URL I send, sign in to T3 Connect with that account, and approve
  the code shown.
- **A2 (M3, about 15 minutes).**
  - Optionally, pair the phone to `step3plus` from the link I send.
  - Watch for the two notifications, take screenshots, and tap the "Waiting for input" one.
  - Afterwards, remove `step3plus` from the phone if you paired it.
- **A3 (after the merge to `main`, about 3 minutes).** Prod's sign-in: approve one device code for `t3.ianpascoe.dev`.
  I run `connect.ts prod sign-in` with your go-ahead; it writes only prod's own secret store. You can also run it
  yourself.

## 10. Budget and fragility

- **Patches 2, Shadows 1: unchanged.**
- **New Layers or services:**
  - the Connect service (sign-in fiber, idle hold, routes);
  - the publish recorder Logger;
  - the idle drain.
- **New code of ours:**
  - four refusals in the Environment DO;
  - build defines;
  - `scripts/connect.ts`;
  - the leak check's names.
- **U28 (new register entry), "T3 Connect":** we rely on these t3 internals, each covered by a test or a bump check:
  - secret names in `srv/cloud/config.ts` and `CliState.ts`;
  - `CloudLink.reconcileDesiredLinkIfStillDesired`, `linkState`, `unlink`, `updatePreferences`;
  - `CliTokenManager.deviceAuthorizationLogin`, `store`, `getExisting`, `clear`;
  - `AgentAwarenessRelay.drain` and its log messages and annotations, which the recorder matches;
  - the `__T3CODE_BUILD_*` define names;
  - the relay's client and server endpoints;
  - the loopback-origin rule.

## 11. Upstream asks (drafted with the report, for the owner to send)

1. **A paused phase for usage limits**: a run that ends on a usage limit with auto-resume armed should not read
   "Agent failed".
2. **`CloudLink.unlink` should also unlink on the relay** when an account token is present, as the web client's
   Disconnect does.
3. **A hosted server's publish-only link**: a supported way to link without a loopback origin, or to say "no endpoint",
   for servers that are reached out of band.
