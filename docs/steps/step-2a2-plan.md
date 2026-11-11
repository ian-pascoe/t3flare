# Step 2a, part 2: plan (Subscription logins for Durable agents)

Date: 2026-11-11. Branch `step-2a2`, from `main` at 544f328. t3code pinned at `v0.1.9-nightly.20261111.4515`.
pi-ai and pi-durable 1.5.0 (as installed). cloudpid read at `b8097ff0`.

This is a plan to review, not a report. It works inside ADR-0012, 0016 and 0018 and the plan's row for 2a part 2.
Where it refines an ADR, it says so in [Refinements to the ADRs](#refinements-to-the-adrs). Owner actions are
collected at the end. There is one sitting of about 10 minutes, at the end of M0.

**Exit criterion (from `docs/plan.md`).** A Durable agent turn runs on each Subscription login: Claude through a
pasted `claude setup-token` token, and ChatGPT through managed sign-in. The proxy key stays as an option.

**Also in this step.** The process-group kill for an aborted `bash` call (part 1's report, ADR-0004). It also
picks up the usage-limit classification deferred from part 1.

---

## 1. What reading the code settled

These facts were read from the code; M0 confirms them on the real services from a Worker.

| Question | Answer from the code | Where |
|---|---|---|
| Does pi-ai take a `setup-token` token? | Yes. A key containing `sk-ant-oat` switches pi-ai's `anthropic-messages` to OAuth mode: `Authorization: Bearer`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `user-agent: claude-cli/2.1.280`, `x-app: cli`, a first system block "You are Claude Code, Anthropic's official CLI for Claude.", and tool names mapped to Claude Code's casing and back (`read`→`Read`, `bash`→`Bash`, …). No refresh: the token is long-lived (a year, by Anthropic's docs). | `pi-ai/dist/api/anthropic-messages.js` 44–75, 767–801, 858, 911–925 |
| What is t3's "managed ChatGPT" token? | OpenAI's **Sign in with ChatGPT token sharing**: OAuth code + PKCE with a dynamically registered client (`dynamic_agent_client` → `oaiapp_…`), scope `… offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, `ext_agent_host_id=urn:uuid:<environmentId>`. The access token is a plain Bearer for the **public Responses API** (`api.openai.com/v1/responses`). It is not the `chatgpt.com/backend-api/codex` path, and it needs no account-id header. Refresh rotates the refresh token, and `earliest_refresh_at` throttles refreshes. | `t3code/apps/server/src/provider/CodexChatGptAuth.ts`, `CodexManagedRuntime.ts:24–26` (`wire_api="responses"`, `base_url="https://api.openai.com/v1"`) |
| Does pi-ai take that token? | Yes, as the `apiKey` of its `openai` provider (`openai-responses`). pi-ai 1.5.0 ships the same flow (`auth/oauth/openai-chatgpt.js`: "OpenAI Responses API token sharing through Sign in with ChatGPT"), whose `toAuth` is `{ apiKey: access }`. | `pi-ai/dist/providers/openai.js`, `auth/oauth/openai-chatgpt.js` |
| How does t3 surface sign-in? | A provider instance may carry an `auth: ProviderAuthController` (`provider-core/server/auth.ts`). The stock client's generic **Account** row (`ProviderAuthenticationSection.tsx`) drives it with `start`/`respond`/`complete`/`cancel`/`logout`, for any driver whose snapshot says `setup.canAuthenticate`. It renders a **credentials** interaction as a form with password fields, and a **browser** interaction with `acceptsCallback` as *Open browser* plus "If the final localhost page does not load, paste its full URL here". *Sign out* asks for confirmation, and t3's `ProviderAuthService` then stops the sessions that share the sign-in. | `contracts/src/providerSetup.ts`, `apps/server/src/provider/ProviderAuthService.ts`, `apps/web/src/components/settings/ProviderSettingsPanel.tsx:1363–1376` |
| Can t3's ChatGPT controller run in the cloud? | With `callbackMode: "client"` it opens no loopback listener: the redirect URI is `http://127.0.0.1:<random port>/auth/callback`, and the owner's client returns the callback URL through `complete`. Its single-writer refresh (`access`: semaphore, uninterruptible, `withChatGptSessionLock`, which is a no-op without a secrets directory, as ours has none) and its revocation on `logout` are what ADR-0018 asks for. | `CodexChatGptAuth.ts:520–640, 790–866`, `CodexChatGptSessionLock.ts` |
| Which client path signs in for our driver? | The generic Account row. Codex's own card (`CodexSetupSection`, with the laptop-side "primary handoff") is shown only for `driver === "codex"`. With the generic row each Environment signs in itself (ADR-0018), and the cost is one paste of the localhost URL per sign-in. | `ProviderSettingsPanel.tsx:1342`, `CodexSetupSection.tsx:71–89` |
| Usage-limit pause in t3 | A failure of class `usage_limit` with `resetAt` sets `usageLimitResetAt`, and `UsageLimitRecoveryWorker` resumes the thread then. The Environment's idle alarm already wakes for it (ADR-0003). | `contracts/src/orchestrationV2.ts:1473–1494`, `orchestration-v2/UsageLimitRecoveryWorker.ts`, `host/idle.ts` |
| pi-ai retry on 429 | It retries 408/409/429/5xx with the SDK's policy, but a `retry-after` over 60 s throws at once. So a subscription limit that resets in hours does not spin. | `pi-ai/dist/utils/provider-retry.js` |
| An instance switch inside a thread | With the same driver kind **and** the same continuation key, t3 handles an instance change as `restart_and_resume` (the same provider thread, so the same Session). Different kinds get `create_with_handoff`. | `orchestration-v2/ProviderSessionTransitionPolicy.ts:44–74` |

cloudpid's `packages/extensions/src/secrets/vault.ts` (AES-256-GCM under an HKDF key from a Worker-secret master
key, bound to the record's name as additional data, WebCrypto only) is what we copy for encryption at rest.

---

## 2. Provider instances and the sign-in surfaces

**One driver kind, three instances.** The kind stays `piDurable`, now with `supportsMultipleInstances: true` and a
config field `modelAccess: "proxy" | "claude" | "chatgpt"`:

| Instance id | Display name | Model access | Sign-in |
|---|---|---|---|
| `piDurable` (the default instance, as today) | Pi (cloud) | the proxy (`MODEL_PROXY_URL` and key) | none. Enabled only when the proxy secrets are set. |
| `piDurableClaude` | Pi · Claude | Claude subscription, direct to `api.anthropic.com` | paste a `claude setup-token` token |
| `piDurableChatGpt` | Pi · ChatGPT | ChatGPT subscription, direct to `api.openai.com/v1` (Responses) | Sign in with ChatGPT |

- **Created by seeding.** The stock client cannot add an instance of a driver it does not know (its *Add instance*
  dialog lists only its compiled-in drivers). So our composition adds the two subscription instances to t3's
  `providerInstances` setting through `ServerSettingsService` once, and records `t3flare/seeded-instances/v1` in DO
  storage, so that an instance the owner deletes stays deleted. Layer level, no Shadow.
- **A shared continuation key.** All three use `piDurable:cloud`, so a thread can move between Claude, ChatGPT and
  the proxy and keep its Session and history (`restart_and_resume`; pi converts across providers). This is checked
  in M2, but it is not part of the exit gate.
- **Models per instance.** These are static, in pi's `models.json` shape (ADR-0012).
  - The proxy and Claude instances list the `anthropic` block, with the same slugs.
  - The ChatGPT instance lists a new `openai` block (`api: "openai-responses"`). Its ids are the models that both
    the token-sharing catalog (`GET /v1/models`, read once in M0) and pi-ai's `OPENAI_MODELS` know. No live
    catalog read at run time.
- **The snapshot** sets `setup: { canAuthenticate: true }` on the subscription instances. Its `auth` is
  `{ status: "authenticated" | "unauthenticated", email?, label, canLogout: true }`, refreshed when the
  controller's state changes. An unauthenticated instance stays listed, and the composer shows t3's usual "sign in"
  state.
- **Text generation per instance** (titles, commit messages, PR text): each instance uses its own access.
  - Proxy: as today.
  - Claude: one Messages request with pi-ai's OAuth shape. A Node test builds pi-ai's request with a fake `fetch`
    and compares the header set and the system prefix with ours, so a pi-ai bump that changes them fails the check.
  - ChatGPT: one Responses request.
  - The environment bundle still does not take pi-ai (part 1's R8).

**Controllers** (`apps/environment/src/provider/auth/`):

- **ChatGPT** reuses t3's `makeCodexChatGptAuth({ instanceId })`, imported as a module (no Shadow).
  - Our wrapper always passes `callbackMode: "client"`, because workerd cannot open the loopback listener and the
    generic row sends no `callbackMode`.
  - Its credentials and registration live in t3's `ProviderCredentialStore` keys (`provider-auth-<sha256>`), inside
    our sealed store (below).
  - The owner's flow is *Sign in* → *Open browser* → sign in to ChatGPT (token sharing on) → the browser lands on an
    unreachable `127.0.0.1` page → paste its URL into the card → *Continue*.
- **Claude** is ours, about 150 lines on t3's `ProviderAuthFlow.make`.
  - It has one method, "Paste a token from `claude setup-token`". It sets a `credentials` interaction with one
    secret field.
  - On `respond`, it checks the shape (`sk-ant-oat01-…`) and verifies the token with the cheapest call M0 finds
    (candidates: `GET /api/oauth/profile`, which would also give an email, or `POST /v1/messages` with
    `max_tokens: 1` on the smallest model).
  - It stores `{ token, addedAt, verifiedAt, email? }` under `ProviderCredentialStore.make("claude-setup-token",
    instanceId)`.
  - `logout` deletes the record and stops the instance's sessions. The token itself is revoked only on Anthropic's
    side; the card says so.
  - Every error text is fixed; no token or vendor body is ever echoed.

**Budget:** 0 new Patches, 0 new Shadows expected. The `builtInDrivers.ts` Shadow is unchanged in shape. One Shadow
is allowed if R3's fallback is needed (`CodexChatGptSessionLock.ts`, about 40 lines).

---

## 3. The Credential broker (ADR-0018)

**Where it lives.** It is a `CredentialBroker` service in the Environment DO's composition, keyed by provider
instance id. It does not own the sign-in state; it reads the instances' controllers:

| Access | `get(instanceId)` |
|---|---|
| `chatgpt` | t3's `auth.access` (single-flight: the controller's semaphore, uninterruptible, 20 s timeout). It refreshes at 60 s or less left, never before `earliest_refresh_at`. A refresh answered with `invalid_grant`/`refresh_token_*` signs the instance out. Returns the access token and its `expiresAt`. |
| `claude` | the stored token. There is no refresh. `expiresAt` is unknown, so it is treated as `addedAt + 365 d`. |
| `proxy` | not brokered. It stays a Worker secret of the agents Worker, as in part 1. |

**Encryption at rest.** Our `ServerSecretStore` Layer seals every key under `provider-auth-*` (t3's ChatGPT records,
its registrations, our Claude records):

- AES-256-GCM under `HKDF-SHA256(T3FLARE_CREDENTIALS_KEY, info "t3flare/provider-auth/v1")`, with the storage key as
  additional data (cloudpid's `openKeptVault`, copied).
- The key is a new per-stage Worker secret that `stage.ts` generates with the bootstrap and admin tokens (in
  `.alchemy/stages/<stage>.env.json`, 0600). `prod` gets one at its next deploy, with nothing for the owner to do.
- A missing or short key makes `set` fail ("this Environment has no credential key"). Subscription credentials are
  never stored in plaintext.
- A record the key cannot open reads as signed out. Losing or rotating the key means signing in again.
- DO storage is also encrypted by the platform. The seal keeps a storage dump or a stray admin route from showing a
  usable token.

**How a Session gets a credential.** It asks at use time over DO RPC (ADR-0005's direction rule: the Session is the
caller):

```ts
// EnvironmentDO, reachable only through the agents Worker's binding
modelCredential(input: { sessionId: string; instanceId: string; refetch?: boolean }): Promise<
  | { ok: true; apiKey: string; baseUrl: string; expiresAt: number | null }
  | { ok: false; code: "signed_out" | "rejected" | "refresh_failed" | "not_subscription" | "unavailable"; message: string }
>;
```

- It counts as activity for the idle check, boots t3 if needed and waits for command readiness, as `sessionPush`
  does.
- It refuses an instance that is not a subscription instance or is disabled.
- It logs the instance, the session, the outcome and the expiry, never the value.

**In the Session**, a `credentials` client:

- It caches each instance's answer **in memory only**, until `min(expiresAt − 5 min, now + 10 min)`.
- It drops the cache on `close`, on a new RPC `dropCredentials(instanceId)` (called by our adapter when t3's sign-out
  stops the instance's sessions), and on a 401.
- It retries an unavailable Environment 3 times over about 30 s, then fails the model request as a transport error.
- pi-ai's provider `resolve` calls it for every model request, so a long turn picks up a refreshed ChatGPT token at
  its next request. A single stream that started with a valid token is not cut off.
- The token never enters pi-durable's storage, the push, a Workspace or a Container. A storage scan in the tests
  proves it.

**Refresh concurrency.** One Environment DO, one isolate, and t3's semaphore around `access`: concurrent Sessions
share one refresh, and the others read its result. The Sessions' own caches mean a refresh happens about once per
token lifetime, not per request. Residual risk: a deploy that resets the DO between the refresh response and its
`save` loses the rotated refresh token, and the owner signs in again. This is rare, because the environment Worker's
deploys wait for idle (ADR-0004).

**Sign-out and revocation.**

- t3's `logout` stops the sessions that share the binding. Our adapter answers that with `close` and
  `dropCredentials` to each open Session.
- ChatGPT's `logout` revokes the refresh token at OpenAI (t3's code).
- Claude's `logout` forgets the token. Revoking it is the owner's step at Anthropic, and the card text says so.

**Expiry or rejection mid-turn, and usage limits.** The Session classifies the failed response itself, because it
sees the status, the headers and the error type. It records them through pi-ai's `fetch` option, injected by
wrapping the provider's API in `models.ts`. The push carries `failure: { class, code, resetAt? }` for the turn. The
differ prefers it and keeps today's regex only for the proxy.

| Signal | t3 failure |
|---|---|
| Anthropic 429 with `anthropic-ratelimit-unified-status: rejected` (or a `rate_limit_error` carrying a unified reset header) | `usage_limit`, `resetAt` = the unified reset, retryable |
| OpenAI 429 `usage_limit_reached` / `insufficient_quota` (`resets_at`, `resets_in_seconds`, or `x-ratelimit-reset-*`) | `usage_limit`, `resetAt` from the body or headers |
| a 429 with only a short `retry-after` that still surfaces after pi-ai's retries | `usage_limit`, `resetAt` = now + retry-after |
| 401, or 403 `permission_error` (revoked, "only authorized for Claude Code") | `provider_error`, code `auth_required`, not retryable. The Session refetches once (`refetch: true`) before it fails. A second rejection marks a Claude instance `rejected` (the card asks for a new token). For ChatGPT, t3's refresh state decides. |
| 5xx, 529 `overloaded_error` | `provider_error`, retryable. Today's regex calls "overloaded" a usage limit; that is fixed here. |

At a usage limit t3 pauses the thread and resumes it at `resetAt`. **It never falls back to the proxy key**
(ADR-0012). Error text pushed to t3 passes through a redactor first: `sk-ant-…`, JWT-shaped `eyJ…`, `Bearer …`. The
same patterns are added to the Environment's redacting Console and to `logs-check.ts`.

**The Container never sees a subscription token.** Durable agent model calls happen in the Session DO, and the
agent's shell has no route to the broker. ADR-0016's Handles are step 4a's.

---

## 4. Session changes (`apps/agents/src/session/`)

- **`models.ts`.** The Session builds one pi-ai `Models` with two providers:
  - `anthropic` resolves per turn: the proxy URL and key for `modelAccess: "proxy"`, or `https://api.anthropic.com`
    and the broker's token for `"claude"`.
  - `openai` resolves to `https://api.openai.com/v1` and the broker's token for `"chatgpt"`.
  - Both wrap the provider's API to inject the recording `fetch`. Per-turn `resolve` keeps one Harness per Session
    whatever the instance.
- **`session-protocol`.** `OpenInput` and `SubmitTurnInput` gain `instanceId` and `modelAccess`, stored with the
  submission (not secret; the access of the running turn survives a Session restart). `TurnStatus` gains
  `failure?`. There is a new `dropCredentials`.
- **The adapter** (`makePiDurableAdapter(instanceId)`) passes its instance's access, and calls
  `close`/`dropCredentials` from `stopSession`.

---

## 5. The abort fix: kill the process group

Part 1 saw an aborted `bash` call's `sleep` still running in the Container. `computer-env`'s `exec` asks computerd to
`killExec(id)`, which stops the command's shell, but not the children it started.

- **Each Container command is its own process group.** `inBash` (`packages/computer-env/src/shell.ts`) runs the
  command under `setsid --wait`. It writes `/run/t3flare/exec/<execId>` (a tmpfs, never synced) with the group id
  and the owner (`<sessionId>:<submissionId>`), and removes the file on exit (`trap`).
- **On abort or timeout**, after `killExec`, one more exec on the same backend runs
  `kill -TERM -- -<pgid>; sleep 2; kill -KILL -- -<pgid>`. It runs detached, so `exec` still returns within its
  500 ms grace.
- **A sweep for lost callers.** There is a new Workspace RPC `killOwned(owner, keep)`. The Session calls it on a
  turn's abort (Stop, orphan, deadline) and after a restart, with the exec ids it still has live. The Workspace DO
  kills every listed group of that owner that is not kept. This covers the part 1 case (an Environment restart
  mid-`bash`, then the continuation), where the aborting caller had lost its in-memory `running` set.
- **Not covered, by design:** a process the agent detaches itself (`setsid`, `nohup … &` with its own session). A
  normal exit leaves background children alone, as now.

---

## 6. Sub-milestones

Everything happens on the stage **`step2a2`** (added to `STAGES` in `apps/environment/scripts/stage.ts`). It is
deployed from this branch and destroyed at the end, after ChatGPT's sign-out. `prod` is never deployed, run against
or destroyed. Evidence goes to `docs/steps/step-2a2/` as the scripts' own JSON plus screenshots. Each milestone ends
with `bun run check` passing and a commit.

### M0. The sign-in surfaces, and the spike on the real services (timebox: 1 day)

- The stage; `T3FLARE_CREDENTIALS_KEY`; the sealed store; the driver with `modelAccess`, multiple instances and the
  shared continuation key; seeding; both controllers (§2); the snapshot's `setup`/`auth`.
- **A workerd test (R3):** t3's `CodexChatGptAuth` loads in the Environment's test pool. Its `node:http` import,
  `proper-lockfile`, effect's `SecureRandom`/`Digest`/`Signature` and jose all work. Against a fake OpenAI
  (discovery, token and JWKS answered by a fetch mock, the id_token signed with a test key), the test runs
  `start(client)` → `complete(callbackUrl)` → `access` → refresh → `logout`.
- **UI check (R4), with no credentials,** in the web client paired with the stage:
  - both cards show the Account row with *Sign in*;
  - Claude's shows the token form;
  - ChatGPT's shows *Open browser* and the paste field;
  - the composer lists the three instances with their models;
  - the stock usage and status surfaces do not break.
- **Probes**, stage-gated (they refuse on `prod`) and removed in M4:
  - `POST /_t3flare/spike/probe { instanceId, model, case }`: the Environment takes the credential from the
    instance's controller and calls a stage-gated Session RPC `probe`, which runs **pi-ai** with it. Cases:
    - `text`;
    - `thinking`;
    - `tools`: a full tool round, with pi's names mapped to Claude Code's and back;
    - `stream`: at least 60 s, with idle gaps;
    - `bad-token`: the 401/403 shape.
  - `GET /v1/models`: ids only, for the ChatGPT model list.
  - Claude's verification-call candidates.
  - **ChatGPT refresh:** the stored record's `expiresAt` is set to now (through the sealed store) → `access`. It
    records `expires_in`, `earliest_refresh_at`, whether the refresh token rotated, and that a second `access`
    reuses the result.
  - Every probe reports status, latency and response **header names** (rate-limit header names included); never
    values or bodies.
- **Owner sitting (about 10 minutes, the only one; see the end).** Claude's token goes into my masked prompt (for the
  probes and tests, stored only in `~/.config/t3flare/dev.env`) and into the Pi · Claude card. Then *Sign in with
  ChatGPT* in the Pi · ChatGPT card. Both logins then serve the rest of the step.
- **Exit evidence:**
  - `m0-spike.json`: the probes. This answers plan.md's unknown: whether a `setup-token` token and the managed
    ChatGPT token work through pi-ai from a Worker, with each one's lifetime and refresh behaviour.
  - `m0-cards.png`, `m0-claude-signed-in.png`, `m0-chatgpt-signed-in.png`, the build report counts.
- **Gate:** I report to root before M1. If a vendor refuses Worker-origin traffic or pi-ai's request shape (R1, R2),
  I stop there with the evidence and the fallbacks in §8.

### M1. The broker, and a Claude turn

- The broker; `modelCredential`; the Session's `credentials` client, its cache and `dropCredentials`; the protocol
  changes; `models.ts` per access; the Session's failure classification and the differ's use of it; the redactor;
  Claude's text generation.
- Stage-gated **fault injection** in the Session's recording `fetch` (`/_t3flare/agents/fault`): the next model
  response for an instance becomes a vendor-shaped 401 or 429.
- **Exit evidence** (`m1-claude.json`, `m1-*.png`):
  - In the web client, on Pi · Claude, a turn edits a file and runs `bash` in the Container, and the thread gets a
    generated title.
  - The storage scan of the Session (pi-durable's tables and ours) and of the Workspace finds no token. The
    Workers-logs check finds none.
  - *Sign out* stops the instance's session, and the next turn fails with the sign-in message. Pasting again makes
    it work.
  - An injected 401 refetches once, then fails as `auth_required`, and the card asks for a token.

### M2. A ChatGPT turn

- The broker over t3's `access`; the `openai` provider in the Session; the ChatGPT model list from M0;
  ChatGPT's text generation.
- **Exit evidence** (`m2-chatgpt.json`, `m2-*.png`):
  - On Pi · ChatGPT, a turn edits a file and runs `bash`.
  - With the stored expiry forced to 2 minutes, a turn that runs past it makes exactly one refresh, and the turn
    completes.
  - Two Sessions asking at the same moment cause one refresh (the broker's refresh counter).
  - Not gated: a thread switches from Pi · Claude to Pi · ChatGPT and back with its history (the same Session).

### M3. Aborts kill the process group

- §5: `inBash` with `setsid`, the group kill, `killOwned` and the Session's sweep.
- **Exit evidence** (`m3-abort.json`):
  - Stop during `bash -c 'sleep 600 & sleep 600'` leaves no process of that group within 3 s (`ps -eo pgid,args`
    in the Container).
  - `turns.ts restart --tools` five times in a row: the continuation never finds the previous run's `sleep` (the
    part 1 case).
  - A Node test with real bash: a grandchild dies, and a `nohup setsid` child survives.

### M4. Usage limits, acceptance, report

- **Usage limit end to end, on each subscription.** An injected 429 with the vendor's reset headers, reset at now
  + 2 min.
  - t3 shows "Usage limit reached", and the thread is `usage_limited` with `usageLimitResetAt`.
  - The Environment idles and its alarm wakes it at the reset.
  - `UsageLimitRecoveryWorker` resumes the thread, and the resumed turn completes **on the subscription**. The
    proxy's request counter shows 0 calls (`m4-usage-limit.json`).
- **`scripts/acceptance.ts --subscriptions`** (run by hand on `step2a2`, never in CI):
  - The headless client pastes Claude's token from `dev.env` through `respondProviderAuth`, the same server path
    as the card.
  - It reuses the ChatGPT login.
  - It runs one tool turn per subscription on the smallest model, then the storage and log scans.
- **The bump job** gains only an auth-surface check: the subscription instances are listed as unauthenticated with
  `setup.canAuthenticate`, and the Claude credentials interaction is offered. It holds no tokens and runs no
  subscription turns.
- **The exit run, from the stock client:** a turn on each Subscription login, with screenshots
  (`m4-claude-turn.png`, `m4-chatgpt-turn.png`). I drive the web client; the desktop app is optional (see owner
  actions).
- **Close:** remove the probe routes; `docs/steps/step-2a2.md`; ADR and GLOSSARY updates; ChatGPT *Sign out* (which
  revokes at OpenAI); `bun scripts/stage.ts destroy step2a2`.

### Tests

- **Unit (Node):**
  - The sealed store: round trip; a wrong key or a moved record fails; a missing key refuses `set`.
  - The Claude controller: shape check, verification mocked, no token in any error.
  - The failure classification on fixtures for every row of §3's table.
  - The redactor patterns.
  - Claude's text-generation request against pi-ai's (headers and system prefix).
  - The Session's credential cache: TTL, drop on `close` and `dropCredentials`, refetch on 401, retry when the
    Environment is unavailable.
  - The models' per-turn resolve.
  - `inBash` and the group kill with real bash.
- **workerd:**
  - t3's ChatGPT controller in the Environment pool against a fake OpenAI (M0), plus single-flight: 5 concurrent
    `get`s → 1 token request.
  - `modelCredential` refuses a non-subscription instance.
  - The Session with pi-durable's faux provider asserting the `apiKey` it is handed, then a storage scan for it.
  - Seeding runs once and respects a deletion.
- **Deployed:** the probes (M0); `acceptance.ts --subscriptions`; `turns.ts` with `abort` and `restart --tools`;
  `logs-check.ts` extended with the token patterns.

---

## 7. Guardrails

**Cost and subscription use**

- Test turns use the smallest model of each vendor (Claude Haiku; the smallest ChatGPT model the catalog lists)
  with bounded output.
- At most about 30 real turns per subscription in the whole step, counted in the evidence.
- No subscription turn in CI or the bump job.
- Usage limits are injected, never provoked.
- Containers: part 1's limits are unchanged (3 at once, 2 idle minutes, 2 h turns).

**Secrets**

- No token is printed, logged, committed or put in evidence. Probes and admin routes return booleans, expiries,
  header names and short hashes.
- `bun run check` gains a scan of `docs/` and staged files for `sk-ant-` and JWT shapes.
- The test token lives only in `~/.config/t3flare/dev.env` (0600) as `T3FLARE_TEST_CLAUDE_SETUP_TOKEN`. Scripts read
  it there, as `stage.ts` reads the deploy secrets, without echo.
- ChatGPT's login exists only in the stage's sealed store, and it is revoked before the destroy.
- Fault injection and probes refuse on `prod`.

---

## 8. Risks and how each is settled early

| # | Risk | Settled by | Fallback |
|---|---|---|---|
| R1 | Anthropic refuses a `setup-token` token from Worker egress, or pi-ai's pinned Claude Code identity (`claude-cli/2.1.280`, the betas, the system prefix, the tool names) is out of date. This is the main **technical detection risk**: the requests must keep looking like Claude Code's, and they come from Cloudflare's datacenter addresses. | M0 probes: text, tools, stream, from the deployed Session | A `patches/deps` patch of pi-ai's identity constants (not a t3 Patch). If Anthropic refuses it outright, I **stop and ask the owner** (Claude on the proxy only, or wait). |
| R2 | `auth.openai.com` (behind bot management) refuses the code exchange or refresh from a Worker | M0 sign-in and the forced refresh | Run the token-endpoint POSTs through the Workspace Container's egress, with the Environment DO still the only writer. If that also fails, ask the owner. |
| R3 | t3's `CodexChatGptAuth` does not load or run in workerd (`node:http`, `proper-lockfile`, the crypto services) | M0 workerd test | One Shadow of `CodexChatGptSessionLock.ts`; or our own controller from pi-ai's `openai-chatgpt.js` flow (about 300 lines) |
| R4 | The stock client does not render the Account row for an unknown driver kind, or hides *Sign out* | M0 UI check with no credentials | Set the snapshot fields it keys on (`auth.canLogout`, `installed`, `enabled`). Last resort: the kind `pi`, as part 1's R1 fallback. |
| R5 | Seeded instances conflict with t3's settings hydration or its client's settings editor | M0 | Separate driver kinds with default instances (no shared continuation; switching then hands off) |
| R6 | Vendors' usage-limit shapes differ from §3's table (especially token sharing's) | Fixtures; real header names from the M0 probes; a real 429 if one ever happens | Unknown 429s are classified as `usage_limit` with `resetAt` = now + retry-after (or none, which t3 shows without auto-resume) |
| R7 | A vendor error echoes a credential into `errorMessage` | The redactor at every exit (push, Console, logs-check) and the scan | — |
| R8 | A DO reset between a refresh and its save loses a rotated refresh token | Accepted; deploys wait for idle | Sign in again (the card shows it) |
| R9 | `setsid --wait` changes how computerd streams output or reports exit codes | M3 Node and deployed tests | Write the group id from inside the command with `set -m` and a subshell instead |
| R10 | ChatGPT token sharing reaches only some models, or their metadata differs from pi-ai's | M0 `/v1/models` | List only what is in both catalogs |

The ToS posture is the owner's settled call (ADR-0012) and is not reopened here. The only part treated as risk is
technical detection (R1). The ChatGPT path is OpenAI's own third-party token-sharing flow, shown to the owner as
"T3 Code" on the consent screen. Its detection risk is low.

---

## Refinements to the ADRs

To be written with the step's report:

- **ADR-0012:**
  - One driver kind, three instances (proxy, Claude, ChatGPT), seeded once, with a shared continuation key so a
    thread can change access mid-conversation.
  - Each instance's text generation uses its own access.
  - The ChatGPT login is token sharing on the public Responses API, through pi-ai's `openai` provider.
  - Usage limits are classified in the Session from the vendor's headers, with no proxy fallback.
- **ADR-0018:**
  - The broker as built: t3's `CodexChatGptAuth` reused with the client callback, our Claude paste controller, and
    the `provider-auth-*` keys sealed with a per-stage Worker-secret key.
  - `modelCredential` over DO RPC, and the Session's in-memory cache (at most 10 minutes, dropped on `close` and
    sign-out).
  - Each Environment signs in through its own card, never the laptop's primary handoff.
- **ADR-0004:** an aborted tool call's Container process group is killed, and a restarted Session sweeps what its
  aborted calls left.
- **GLOSSARY:** **Model access** (an instance's proxy, Claude or ChatGPT), if the term earns its place in the report.

Deferred, with their triggers: usage meters in the client from the vendors' rate-limit headers (t3's `usageLimits`
snapshot), if the owner wants to see them; sharing the ChatGPT login with step 4a's Codex instance (t3's
`credentialBinding`); other pi-ai Subscription logins (already in plan.md's deferred list).

---

## Owner decisions and actions

**Decisions:** none to start. One arises only at the M0 gate, if a vendor refuses Worker-origin traffic (R1, R2).

**Actions:**

1. **Review this plan** and say "go".
2. **End of M0, one sitting, about 10 minutes.** I message root when the stage is ready, and I add `step2a2` to your
   T3 Code (Nightly) desktop app under Environments, as part 1 did.
   1. Run `claude setup-token` on your laptop (it needs your Claude subscription).
   2. Paste the token twice: into the masked prompt I open (it is saved only to `~/.config/t3flare/dev.env`, for
      the probes and acceptance runs), and into Settings → Providers → **Pi · Claude** → *Sign in* on `step2a2`.
   3. In **Pi · ChatGPT** → *Sign in* → *Open browser*, sign in to ChatGPT and leave token sharing on. The browser
      ends on a `127.0.0.1` page that does not load. Copy its full address into the card's field and press
      *Continue*.
3. **Optional, end of M4 (2 minutes):** send one message to a Pi · Claude thread and one to a Pi · ChatGPT thread in
   the desktop app, if you want desktop screenshots beside the web client's.
4. **After the step:** the test token stays in `dev.env` for later runs. Revoke it at Anthropic if you prefer. The
   ChatGPT login is revoked when the stage is destroyed.
