# Step 2a, part 2: plan (usage limits from the proxy, and killing aborted commands)

Date: 2026-11-11. Branch `replan`, from `main` at 475d922. t3code pinned at `v0.1.9-nightly.20261111.4515`.
Commissary read at `dfb35035` (`~/src/commissary`, read only). pi-ai and pi-durable 1.5.0 (as installed).

This is a plan to review, not a report; nothing in it is built yet. It replaces the shelved Subscription-login plan
(branch `step-2a2`, `docs/steps/step-2a2-plan.md`): after [ADR-0012](../adr/0012-all-model-access-goes-through-the-model-proxy.md)
every model call goes through the model proxy, so part 2 keeps only two things. Owner actions are at the end.

**Exit criterion (from `docs/plan.md`).** On a throwaway stage, from the stock web client: a turn the proxy answers
with Commissary's 429 (reset in 2 minutes) ends as "Usage limit reached" with that reset time after at most 4 proxy
requests, and with auto-resume on the thread resumes by itself at the reset and completes; a turn the proxy refuses
(401, the key revoked) ends with the key error after 1 request and no pause. Stop during
`bash -c 'sleep 600 & sleep 600'` leaves no process of it in the Container within 3 s, and after an Environment
restart mid-`bash` the continuation finds none.

---

## 1. What the proxy sends

Read in Commissary's source. Turns and text generation use its Anthropic Messages entry, so every error body is
Anthropic's shape, `{"type":"error","error":{"type","message"}}` (`packages/models/src/http/errors.ts:233-255`),
except the gate's refusals, which are flat `{"error":"…"}` (`packages/auth/src/refusal.ts:52-62`).

| # | When | Status, headers, body | Where |
|---|---|---|---|
| 1 | Every account that serves the model is cooling down (rate- or quota-limited); no upstream call is made | 429, `retry-after: <s>`, `error.type` `rate_limit_error`, message `All credentials for model <m> are cooling down via provider <p> (reset after 1h2m3s)` | `credentials/selection/failures.ts:61-87`; `executor/control-plane-picker.ts:67-82`; `http/errors.ts:209-227` (the hint, a Go duration) |
| 2 | The request that exhausts the last account: the upstream's own 429 is passed through | 429, the upstream body; `retry-after` only when Commissary knows when an account recovers | `handlers/conductor.ts:597-610`, `:755-780`, `withRetryAfter` `:292-309`; Claude marks a unified-limit 429 credential-scoped, `executor/claude/executor.ts:204-222` |
| 3 | A Spend limit on the key, member, team or org has no room | 429, `retry-after`, `rate_limit_error`, message `The <period> Spend limit of <subject> is reached; it resets at <ISO time>` | `failures.ts:94-117`; `packages/state/src/spend/message.ts:22-25` |
| 4 | Commissary Cloud's per-org request rate (hosted only) | 429, `retry-after: 60`, flat `{"error":"Rate limit exceeded"}` | `packages/billing/src/rate-limit.ts:87-88`, `plan.ts:97`; `refusal.ts:83-89` |
| 5 | The key is wrong, revoked or expired, or missing | 401, flat `{"error":"Invalid API key"}` / `"Missing API key"` | `packages/auth/src/api-key.ts:90`, `gate.ts:91-94`, `refusal.ts:74-76` |
| 6 | The key's member may not use the client API | 403, flat `{"error":"Forbidden"}` | `refusal.ts:77-79` |
| 7 | An upstream account was refused and no other served the request | 401/403 in Anthropic's shape (`authentication_error`, `permission_error`) | `http/errors.ts:121-129` |
| 8 | No account serves the model at all, or none is usable now | 503, `no auth available` (`auth_not_found`; `auth_unavailable` with `retry-after` when a recovery time is known) | `failures.ts:40-59`; `conductor.ts:285-286` |
| 9 | Overload, upstream 5xx | 529 `overloaded_error`, 5xx `api_error` | `http/errors.ts:121-145` |
| 10 | Any of these after the stream started | SSE `event: error` with the same Anthropic body, no status | `handlers/framing.ts:112-126` |

Upstream headers other than `retry-after` are not passed on (`passthrough-headers` is off by default,
`config/schema.ts:130`; `handlers/respond.ts:102-113`).

## 2. How a failure reaches t3 today, and the gaps

1. pi-ai's Anthropic client (SDK retries off: `anthropic-messages.js:446-448`) throws the SDK's `APIError`, whose
   message is `<status> <JSON body>` (`@anthropic-ai/sdk` `core/error.js:18-27`). **The headers are lost**, so
   `retry-after` never reaches us (gap 1).
2. pi-durable retries a failed generation when pi-ai's pattern calls it transient (`429`, `rate.?limit`,
   `overloaded`: pi-ai `utils/retry.js:29-40`; `harness/generation.js:622-652`), 3 times with backoff from 2 s
   (`SessionDO.ts:138`). Then the input settles `unanswered` with `model_error` and the text as `detail`.
3. The Session pushes the turn with `reason` and the first 2,048 characters of `detail` (`SessionDO.ts:413-421`).
4. The differ's `failureOf` (`apps/environment/src/provider/differ.ts:427-447`) calls any 429, and anything that
   says "overloaded", a `usage_limit` with **no `resetAt`** (gap 2; overload is wrong, gap 3), and every other
   status a `provider_error`; a refused key is not told apart (gap 4).
5. t3 arms and runs recovery only for a `usage_limit` with a `resetAt` later than the run's end
   (t3code `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:17-79`, `Orchestrator.ts:11415-11440`), once per run and reset. It resumes on its
   own only when the `autoResumeLimitedThreads` setting is on (default off, t3code `packages/contracts/src/settings.ts:1430`);
   otherwise the client offers the resume per thread. The Environment's idle alarm already wakes at a recovery's
   reset (`host/idle.ts:109-123`).

## 3. (a) The classification

**A pure classifier, `packages/models/src/proxyFailure.ts`** (the proxy's contract already lives in
`packages/models`), used by the differ and by text generation. Input: the `detail` text, the recorded response
(below) if any, and the turn's settle time. Output: t3's `OrchestrationV2ProviderFailure`, with fixed messages:
never the raw body.

| Rows of §1 | t3 failure | `resetAt` |
|---|---|---|
| 1 | `usage_limit`, code `proxy_cooldown`, retryable | settle time + the `(reset after …)` hint (t3's Claude adapter parses the same text: `ClaudeAdapterV2.ts:4099-4110`, `:4190`), else `retry-after` |
| 2 | `usage_limit`, code `proxy_rate_limited`, retryable | the recorded `retry-after`; none: no `resetAt` (t3 shows the limit and does not auto-resume; the next request gets row 1 with its hint) |
| 3 | `usage_limit`, code `proxy_spend_limit` | the ISO time in the message, else `retry-after` |
| 4 | `usage_limit`, code `proxy_request_rate` | `retry-after` |
| 5, 6 | `permission_error` (t3's class for a sign-in failure, `ProviderTurnStartService.ts:593`), code `proxy_key_rejected`, not retryable: "The model proxy refused this Environment's key (HTTP 401). Check `MODEL_PROXY_API_KEY`." | — |
| 7 | `permission_error`, code `proxy_account_rejected`: "The proxy's account for this model was refused; reconnect it in the proxy." | — |
| 8 | `provider_error`, code `proxy_no_account`: "The model proxy has no usable account for this model." | — |
| 9 | `provider_error`, retryable (no longer a usage limit) | — |
| 10 | by the body, as the row it matches | as that row |

`resetAt` is held to at least 30 s and at most 7 days after the settle time, so a `retry-after: 0` cannot make an
instant resume. An unknown 429 is a `usage_limit` with `retry-after` or no reset.

**The Session records the proxy's response** (`apps/agents/src/session/models.ts`). `proxyModels` wraps the
provider's API so each request gets a recording `fetch` (pi-ai `StreamOptions.fetch`, `types.d.ts:58`, handed to
the client at `anthropic-messages.js:424`). For a response of 400 or more it stores
`{ status, retryAfterSeconds?, at }` for the running submission (DO storage, so a Session restart keeps it), and it
counts requests per submission for the evidence. The pushed `TurnState` (`packages/session-protocol`) gains an
optional `proxy` field with that record; old pushes without it still classify from `detail`.

**No spend loop.**

- **pi-durable's retries of a limited turn are answered in the Session.** After a 429 of rows 1-4 with a reset,
  the recording `fetch` answers the same submission's next requests with the stored 429 until the reset, without
  calling the proxy. Scoped to the submission, so a new turn or t3's resume always asks the proxy and a stale record
  can block nothing. Even without it, Commissary answers row 1 from its cooldown state with no upstream call
  (`conductor.ts:601-609`), so at most 4 cheap requests; the gate makes it 1 in practice, and M1 counts.
- **t3 resumes once per run and reset** (`UsageLimitRecoveryWorker.ts:40-78`), and never for a reset not after
  the run's end (`:33-39`). A limit that persists costs one request per window.
- A 401/403 is not retried: pi-ai's pattern does not match it.
- No fallback to another model or key.

**Text generation** (`apps/environment/src/provider/textGeneration.ts:40-43`) uses the classifier's message for
the status and body it gets (only the message: text generation has no pause).

## 4. (b) Killing an aborted call's processes

**Today.** The Session's `bash` runs through `ComputerExecutionEnv` (`SessionDO.ts:188-194`) and
`packages/computer-env/src/exec.ts`: `workspace.runtime.exec(...)` on the Container backend, wrapped as
`exec bash -c '<cmd>'` for computerd's `/bin/sh -c` (`shell.ts:9`, `env.ts:82`). An abort or timeout calls
`killExec(id)` for up to 500 ms (`exec.ts:240-260`), and the environment's `cleanup()` kills what it still tracks
in memory (`env.ts:443`). Part 1 saw a `sleep` outlive an abort (`docs/steps/step-2a.md`; ADR-0004's refinement).
Three causes fit, and M0 tells them apart:

1. computerd's kill reaches only the process it started, not its children (or not its process group);
2. the abort never reached `exec` (the tool call was cancelled without its signal);
3. the Session restarted mid-call (eviction, the heartbeat's wake), so nothing in memory knew the exec any more.

**Design.** It covers all three, so it does not depend on which one it was.

- **Markers.** Every Container command of a Session runs with `T3FLARE_EXEC=<execId>` and
  `T3FLARE_OWNER=<sessionId>` in its environment (`ComputerExecutionEnv`'s `containerEnv` already passes an
  environment, `env.ts:375-378`). Children inherit them.
- **Its own process group.** If M0 shows computerd does not start each command as a group leader, the wrapper
  becomes `exec setsid --wait bash -c '<cmd>'`.
- **A kill script in the image**, `t3flare-kill --exec <id>… | --owner <id> --except <id>…`. It finds the processes
  whose `/proc/<pid>/environ` carries the marker and signals their process groups, then any marked process left
  outside them: `TERM`, then `KILL` after 2 s. It never signals a group whose leader is unmarked, so computerd, the
  supervisor and t3's own git commands are safe.
- **A Workspace DO RPC, `killExecs({ execs } | { owner, except })`.** It does nothing if the Container is not
  running (`WorkspaceDO.containerRunning`, `:240`): a stopped Container has no processes, and a kill must never
  start one. Otherwise it runs the script through its own `exec` as a passive command.
- **When.**
  - On abort or timeout, `exec` calls it for the exec after its `killExec` loop, without waiting past its grace.
  - The Session keeps the ids of its running execs in DO storage (added at start, removed at end). When it opens,
    before `Harness.open` resumes any tool (`SessionDO.ts:131-140`), it kills the stored ones: those were running
    when it last died. `#abortTurn` (`:325-340`) does the same for the turn's execs.
  - A background process started by a call that **completed** is left alone, as now. One started by an aborted call
    is killed with it.
- **Not covered, by design:** a process that clears its environment and starts its own session (`env -i setsid …`).

## 5. Sub-milestones

All on a throwaway stage **`step2a2`**, added to `STAGES` in `apps/environment/scripts/stage.ts` when implementing
(not in this plan's commit) and destroyed at the end. `prod` is never deployed, run against or destroyed. Evidence
goes to `docs/steps/step-2a-part2/` as the scripts' JSON plus screenshots; no key or body with a key in it. Each
milestone ends with `bun run check` passing and a commit. Deploys reach a Workspace DO only when its Container stops
(step 2a's report), so Containers are stopped before each test of new Workspace code.

### M0. The facts (half a day)

- **The proxy's shapes, live.** `curl` against the owner's Commissary: a bogus key on `/v1/messages`, streaming and
  not (row 5: status, headers, body). If the owner made the spend-limited test key (owner actions), a turn that
  exceeds it (row 3), streaming and not. Rows 1, 2 and 4 cannot be provoked without exhausting real accounts; their
  fixtures are made by calling Commissary's own `modelCooldown`, `claudeErrorBody` and `errorResponse` from a
  scratch script outside both repos (Commissary unchanged), and diffed against the live row 3.
- **pi-ai's view of them.** A Node test runs each fixture through pi-ai's real Anthropic client with a fake
  `fetch`, and records the `errorMessage` and whether pi-durable's pattern retries it.
- **The Container's processes.** Through the admin `agents/workspace-call` exec: `ps -eo pid,ppid,pgid,sid,args`
  while a Session runs `bash -c 'sleep 600 & sleep 600'`, before and after Stop. Then part 1's case,
  `turns.ts restart --tools`, and `agents/session-restart` mid-`bash`: which of the three causes it is.
- **Exit evidence:** `m0-proxy-shapes.json`, `m0-processes.json`; the fixtures committed under
  `packages/models/test/fixtures/proxy/`.

### M1. Usage limits and key errors

- §3: the classifier and its fixture tests; the recording `fetch`, the per-submission gate and `TurnState.proxy`;
  the differ; text generation.
- A stage-gated fault route, `POST /_t3flare/agents/proxy-fault?thread=<id>` (refuses on `prod`): the Session's
  next proxy response becomes a named fixture, with `retry-after` and the hint set to a given reset.
- **Exit evidence** (`m1-limits.json`, `m1-*.png`), in the web client paired with the stage:
  - row 1 with a reset 2 minutes ahead: "Usage limit reached" with the reset time; the Session's request counter
    for the turn is at most 4 (1 expected);
  - with `autoResumeLimitedThreads` on: the Environment goes idle, its alarm wakes it at the reset, the thread
    resumes by itself, and the resumed turn completes on a real proxy model;
  - row 5: the key error, 1 request, no pause; row 9: a provider error that pi-durable retried;
  - row 3 live, if the test key exists: the same pause with the spend limit's reset time.

### M2. Aborts kill the call's processes

- §4: the markers, `setsid` if M0 asks for it, `t3flare-kill` in the image, `killExecs`, the Session's stored execs.
- **Exit evidence** (`m2-abort.json`):
  - Stop during `bash -c 'sleep 600 & sleep 600'`: no marked process within 3 s (`ps` in the Container);
  - `turns.ts restart --tools` five times in a row: the continuation never finds the previous run's `sleep`;
  - `agents/session-restart` mid-`bash`: the reopened Session kills the call's processes;
  - a background process started by a completed call survives a later Stop;
  - with the Container stopped, a kill does not start it (the Workspace's container state before and after).

### M3. Close

- The report, `docs/steps/step-2a-part2.md`; `docs/model-proxy.md` gains a "Usage limits" section and troubleshooting
  rows for rows 1-8; ADR-0004's refinement (§7); the fault route stays stage-gated or goes.
- `bun scripts/stage.ts destroy step2a2`.

## 6. Tests

- **Unit (Node):** the classifier on every fixture and row of §3 (status, class, code, `resetAt`, clamping, no raw
  text in the message); each fixture through pi-ai's real client (so a pi-ai or SDK bump that changes the message
  fails the check); the recording `fetch` and its gate (scoped to a submission, released at the reset); the
  differ's terminal events for a limited turn; text generation's messages.
- **The kill script:** run in the sandbox image with Docker (skipped without Docker): a grandchild in the group
  dies; a marked process that left the group dies; an unmarked group leader is never signalled.
- **workerd:** the Session stores and clears its running execs and kills the stored ones on open (a fake Workspace);
  `killExecs` does nothing while the Container is stopped.
- **Deployed:** M1's fault runs and M2's `turns.ts` runs (`turns.ts` gains `abort-group` and `limit` scenarios).

## 7. Risks

| # | Risk | Settled by | Fallback |
|---|---|---|---|
| R1 | A live Commissary (or Commissary Cloud) answers differently from its source at `dfb35035` | M0 live rows 3 and 5 | An unknown 429 is a `usage_limit` with `retry-after` or no reset; the fixtures are refreshed from the live answers |
| R2 | Row 2 carries no `retry-after`, so the first limited turn has no reset | Fixtures and M1 | t3 shows the limit without auto-resume; a resume by hand gets row 1, which has a reset |
| R3 | pi-durable retries more than expected, or the gate misses one path (compaction's own model calls, `compaction.js:141`) | M1's request counter | The gate sits in `fetch`, under every path that uses the Session's `Models` |
| R4 | computerd runs commands in its own process group, so a group kill would hit it | M0 `ps` | The script never signals an unmarked group leader; `setsid` gives each command its own group |
| R5 | `setsid --wait` changes how computerd streams output or reports the exit code | M2 deployed runs | Start the group from inside the command (`set -m` and a subshell) instead |
| R6 | Markers do not reach every process (a tool that clears its environment) | M2 | Group kill still catches it; one that also starts its own session is out of scope, as by design |
| R7 | Part 1's leak has a fourth cause | M0 | Reported to root before M2 is built |

## Refinements to the ADRs

To be written with the report:

- **ADR-0012:** usage limits as built: the classes and codes of §3, the Session's gate, `resetAt` from the proxy's
  hint, spend-limit time or `retry-after`.
- **ADR-0004:** an aborted tool call's Container processes are killed by marker and process group, and a reopened
  Session kills what its calls left when it died.

## Owner decisions and actions

**Decisions** (none blocks the start):

1. **Auto-resume.** t3's `autoResumeLimitedThreads` is off by default; with it off the client offers the resume per
   thread. Default: leave it to the owner's own setting (the stage turns it on only for M1's run). Say if every
   Cloud Environment should start with it on.

**Actions:**

1. Review this plan and say "go".
2. Optional, 2 minutes, before M0: in Commissary, create an API key named `t3flare-step2a2-limit` with the smallest
   daily spend limit it accepts, and give it through the masked prompt I open (stored only in
   `~/.config/t3flare/dev.env`). It gives a live row 3. Without it, rows 1-4 come from Commissary's code only.
   Revoke it after the step.
