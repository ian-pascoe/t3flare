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
