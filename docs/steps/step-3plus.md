# Step 3+: report (a publish-only T3 Connect link: the owner's phone hears when a cloud run ends or waits)

Plan: [`step-3plus-plan.md`](step-3plus-plan.md), with the review findings (Fable) and the owner's decisions folded in as
its changelog. Branch `step-3plus`, stage `step3plus`. Evidence: [`step-3plus/`](step-3plus/).

## What was built

No Patch and no Shadow: **Patches 2, Shadows 1, unchanged** (the submodule untouched). t3's own pieces do the work:
the device flow (`CliTokenManager.deviceAuthorizationLogin`), the publish-only link step
(`CloudLink.reconcileDesiredLinkIfStillDesired`) and the publisher (`AgentAwarenessRelay`). Ours, all in
`apps/environment`:

- **Public config** (`src/t3/connectPublicConfig.ts`): the relay URL, Clerk publishable key and CLI OAuth client id
  from `t3code/.env.example`, as t3's `__T3CODE_BUILD_*` defines in `build.ts` and both vitest projects. A test fails
  the bump when `.env.example` changes them.
- **The Connect service** (`src/connect/service.ts`), built in `layerMakeServer` beside t3's routes:
  - sign-in: t3's device flow forked in the runtime's scope; the route answers the user code and URL; an idle hold
    keeps the Environment up while the code is valid;
  - every link writes `publish_only`, asserts the mode t3 returns, and unlinks if a tunnel config was stored
    (finding 2); then deletes the relay's mint key (finding 1) and, unless the stage keeps it, the account token (D2);
  - relink, unlink (the relay's `DELETE` with the token when held, then t3's local unlink), sign-out, publish on/off,
    the R1 token import, a stage-only relay-side unlink (to test a refusal), and a status route;
  - after each boot, the threads the recorder last saw published live are published again as they are now
    (finding 4).
- **A refusing `CloudLink` for t3's routes** (`layerRefusingCloudLink`): `linkProof`, `applyRelayConfig`,
  `answerHealthRequest` and `mintCredential` fail with t3's managed-policy refusal (403), as t3's policy variant does.
- **The DO's 404** for the four relay routes, any method and spelling (`src/host/relayRoutes.ts`).
- **The publish recorder** (`src/connect/recorder.ts`): a Logger beside t3's that keeps the last 100 publish events
  (thread, phase, the relay's delivery counts, a failure's status and whether the relay refused us), mirrored to DO
  storage; and the **idle hold** (finding 3) while a publish is in flight, inside t3's 5 s completion hold, or awaiting
  a retry, capped at 120 s after the last activity (`Idle.hold`, `PUBLISH_HOLD_CAP_MS`). Nothing is awaited between
  `setAlarm` and `abort`.
- **Owner-only Connect mutations on prod** (finding 6): the Worker sets `x-t3flare-admin-caller` to the caller it
  admitted (`owner` or `service-token`, overwriting any sent); on prod (no `T3FLARE_CONNECT_SERVICE_TOKEN`) only
  `owner` may sign in, relink, unlink, sign out, import a token or switch publishing. `scripts/connect.ts --owner`
  sends the owner's own Access token (`cloudflared access token`) instead of the service token.
- **Arming pairing is refused during a sign-in**, and a sign-in while pairing is armed (both restart t3 in place).
- **The leak checks** cover the publish credential and the account token's two parts (`peer-leak`, and a new
  `connect-leak` for text such as Workers Logs; names only).
- **Scripts**: `scripts/connect.ts` (sign-in, status, publish, relink, unlink, sign-out, import-token, probe,
  refusals) and `scripts/connect-m2.ts` (the M2 rows).

## Milestones and evidence

All on the throwaway stage `step3plus` (workers.dev host), linked to the owner's T3 Connect account
(ian.g.pascoe@gmail.com). Prod was never deployed, linked or run against.

### M0: the unknowns, then the real link (A1 moved here)

| Probe | Result | Evidence |
|---|---|---|
| P1 public config | the three values from `.env.example` resolve through t3's own `relayUrlConfig` and `cloudCliOAuthConfig` | `test/connectPublicConfig.test.ts` |
| P2 the relay and Clerk from workerd | relay `/health` 200 (1.3 s cold); Clerk's device authorization 200 with `device_code`, `user_code`, `verification_uri(_complete)`; the code dropped | `m0-reachability.json` |
| P3 the phase mapping | every row of the plan's §4.1 table through t3's `projectThreadAwarenessV2` | `test/connectPhases.test.ts` |
| P4 the link step against a fake relay | t3's real `CloudLink` and signing key: `manual`, scopes exactly `["agent_activity_notifications"]`, origin `127.0.0.1:443`, `managedTunnelsEnabled: false` in both requests; mint key gone; token kept (stage) or discarded (prod); relink after unlink stays publish-only; a tunnel answer is undone; sign-out | `test/connectLink.test.ts` |
| P5 policy | t3flare's managed policy (main's ADR-0023) allows Connect; `reachability` answers 401 unauthenticated and needs a session | `test/refusingCloudLink.test.ts`, `m0-refusals.json` (`kept`) |
| P6 the relay's own view | not needed: the account token lists environments and devices directly (200), so status codes were the evidence | `m0-link.json` (`relay`) |
| **A1, the real link** | the owner approved a code; t3's poll got the token from the Worker (no Clerk block, so no R1 fallback); the relay lists `t3flare` with endpoint `manual` beside the laptop's `cloudflare_tunnel`; desired mode `publish_only`; no mint key, no tunnel config | `m0-link.json` |
| **One publish** | a turn published `starting`, `running`, then `completed` after t3's 5 s hold; the relay answered `ok: true` each time | `m0-first-publish.json` |

### M1: the machinery

- **Refusals:** the four relay routes answer 404 at the DO for GET, POST, PUT and OPTIONS and for trailing-slash,
  doubled-slash and percent-encoded spellings; an upper-case spelling never reaches the DO (the Worker routes `/api`
  case-sensitively and serves the web client). Past the DO's 404, t3's own app refuses mint and health with 403 (the
  refusing `CloudLink`), and link-proof and relay-config with 401 before any session. `m0-refusals.json`.
- **The kept routes** (`link-state`, `preferences`, `unlink`, `reachability`) answer 401 without a session, as t3 does.
- **Sign-in expiry:** a code left unapproved ended `CloudCliAuthorizationTimeoutError` after 10 minutes, the hold was
  released, and the Environment then reset when idle. `m1-sign-in-expiry.json`.
- `bun run check` passes.

### M2: every row against the real relay, no phone

`scripts/connect-m2.ts` on the stage, from the stock client's protocol; read from the publish recorder (the relay's
own answers). `m2-publishes.json` (the run on the final build), `m2-publishes-2.json` (the earlier run of rows e–j).

| Row | What ran | Published (relay `ok: true` for each) | Pass |
|---|---|---|---|
| a | a turn that completes, no socket open | `starting`, `running`, `completed` (after the 5 s hold) | ✅ |
| b | an approval-required `bash`, answered after 30 s | … `waiting_for_approval` while it waited, then `running`, `completed` | ✅ |
| c | an `ask_user` question, answered after 30 s | … `waiting_for_input`, then `running`, `completed` | ✅ |
| d | a proxy-fault usage limit | `starting`, `running`, `failed` (D3: "Agent failed") | ✅ |
| e | Stop during a `bash` | `starting`, `running`, then a tombstone; nothing alertable | ✅ |
| f | `restart?mode=abort` mid-turn | `running`; after the boot the continuation's `starting`, `running`, `completed` | ✅ |
| g | publishing off, one turn | nothing | ✅ |
| h | restart while an approval waits (finding 4) | before: `waiting_for_approval`. After: the run is `cancelled` (ADR-0004, no continuation for an approval) and the after-boot republish sends a **tombstone**, which clears the phone's card | ✅ built, not accepted |
| i | restart while `ask_user` waits (finding 4) | after the boot step 3's re-raise asks again: `waiting_for_input` published; answered, then `completed` | ✅ |
| j | the environment removed on the relay (as the T3 apps' removal), then a turn (finding 8) | every publish refused: `RelayAuthInvalidError`, status 401, `rejected: true`; t3 retried 5 times then gave up; `relink` restored it | ✅ |

- **Idle:** after the runs the Environment reset when idle (no holds left), and a later wake published nothing new.
  `m2-idle-wake.json`.
- **Leaks:** the publish credential and both parts of the account token appear in neither the Workspace's Container
  nor the four Sessions' state (`m2-leak.json`, 0), nor in Workers Logs over the M2 window (`m2-leak-logs.json`).
- **Deliveries were 0** throughout: the relay lists one iOS device (app 2.3.0) with notifications switched off. That is
  the phone's setting, and the relay still accepted every publish.

### M3: the owner's phone (the exit criterion)

The owner switched notifications on in the T3 Code app (the relay then listed the iOS device with
`notifications.enabled: true`). `scripts/connect-m3.ts` ran two threads on the stage with no client attached:

- "Phone check: finishes" → `completed` published at 00:07:30Z, relay `ok: true`, one `push_notification` delivery.
- "Phone check: asks you" → `waiting_for_input` published at 00:07:43Z, relay `ok: true`, one `push_notification`
  delivery. (The phone was paired to prod, not the stage, so the question was answered by the script after 10 minutes;
  tapping to open the thread was not tried: R4 stays open.)

**The owner confirmed both arrived: "Agent finished" and "Waiting for input".** No screenshots were taken; the
evidence is the owner's confirmation and the relay's delivery records (`m3-deliveries.json`). Both deliveries were
APNs `queued`, the relay's answer for a push it handed on.

### M4: close

- **Sign-out** on the stage: the relay's `DELETE /v1/client/environment-links/<id>` answered 200, then t3's local
  unlink and the token's removal; afterwards no link, no desired mark, no publish credential, no mint key, no token.
  `m4-sign-out.json`. (The relay's listing after sign-out could not be read: the token that reads it was gone by
  design. The owner can confirm in the T3 apps that "t3flare" is no longer listed.)
- **The bump check:** `test/connectPublicConfig.test.ts` runs in the bump's "typecheck, lint, test" step
  (`apps/environment`), so a changed value in t3's `.env.example` fails the bump; the fake-relay link test runs there
  too. The bump job never signs in. A changed value means prod's link was made against other values: sign in again.
- **Workers Logs** over the M2 and M3 window (45 minutes, 1371 events, 149 publish lines): none of the publish
  credential or the token's two parts (`m2-leak-logs.json`). The check compares the secrets held at its end: the
  credentials that row j's relinks replaced earlier in the window were not compared (a gap in the evidence, not a
  known leak; the redacting Console redacts bearer values in every line).
- **`step3plus` destroyed.**

## Exit criteria

| Criterion | Result |
|---|---|
| **The owner's phone gets a notification when a cloud run ends** | ✅ "Agent finished", confirmed by the owner; relay `ok`, one push delivery (`m3-deliveries.json`) |
| **…and when one waits on them** | ✅ "Waiting for input", confirmed by the owner; relay `ok`, one push delivery. "Approval needed" was published and accepted in M2 row b (the phone's notifications were off then) |
| Every row of the plan's §4.1 table, against the real relay | ✅ M2 rows a–g |
| Restart while an approval or a question waits (finding 4) | ✅ rows h, i |
| A refused publish is recorded as such, by status (finding 8) | ✅ row j: 401, `rejected` |
| The relay routes refused at the door and inside t3 (finding 1) | ✅ on the stage; **on prod: before A3** |
| No managed tunnel, ever (finding 2) | ✅ unit (relink after unlink; a tunnel answer is undone); the relay lists `manual` |
| No secret in a Container, a Session or Workers Logs | ✅ (see the M4 note on replaced credentials) |
| `bun run check` | ✅ |
| Patches and Shadows | 2 and 1, unchanged; the submodule untouched |

## The review findings: verified, built, or rebutted

| # | Verdict | What happened |
|---|---|---|
| 1 HIGH, mint and health unscoped | **Confirmed** (`cloud/http.ts`, `CloudLink.ts`); and our first-pairing sessions are `desktop-bootstrap`, the subject t3 lets sign a link proof from a public host | Built all four parts: the refusing `CloudLink`, the mint key deleted after every link, the DO's 404 for any method and spelling (tested), the ADR reasons corrected (ADR-0010's refinement). Prod verification is part of A3 |
| 2 HIGH, relink falls back to managed | **Confirmed**: an absent mark reads `managed` | Every link writes `publish_only`, asserts the returned mode, unlinks on a stored tunnel config; tested relink after unlink and a tunnel answer |
| 3 MEDIUM, drain does not cover retries | **Confirmed** | No drain: the recorder's capped hold (120 s) on in-flight, deferred and retrying publishes. Nothing awaited between `setAlarm` and `abort`. A deploy's loss accepted (SPI-1035) |
| 4 MEDIUM, restart mapping | **Confirmed** in M2: an approval cut by a restart is `cancelled` with no continuation | Built the tombstone rather than accepting the gap: after each boot, threads the recorder last saw live are published again (row h clears the card). A completion inside the 5 s hold at a restart is still lost (SPI-1035). Arming is refused during a sign-in, and a sign-in while armed |
| 5 MEDIUM, the token is a whole-account credential | **Confirmed**: with it we read every environment and device on the account | Prod discards it right after the link, failed links included; stated in ADR-0025 as the first account credential in the DO, single holder |
| 6 MEDIUM-LOW, admin exposure | **Agreed** | The Worker passes the admitted caller to the DO; prod's Connect mutations need the owner's own Access identity (`connect.ts --owner`, `cloudflared access token`), never the service token CI holds. A separate owner secret was not needed: Access already proves the owner, and the service token is the only other admitted caller |
| 7 LOW, public config | **Confirmed** | Inlined from `.env.example` (no executable read, no JSON file); the bump test compares them |
| 8 LOW, 401s | **Partly rebutted**: `Cause.pretty` carries no status, only the error's name (`RelayAuthInvalidError: Relay authentication failed: invalid_bearer`) | The recorder maps the relay's declared error to its status (401) and flags `RelayAuthInvalidError` as `rejected`; seen on the stage (row j). No text is kept |
| 9 LOW, privacy | **Confirmed** | ADR-0025 and the plan's changelog say titles reach APNs/FCM in the alert |
