# Step 2a, part 2: report (usage limits from the proxy, and killing aborted commands)

Date: 2026-11-11. Branch `step-2a-part2`, from `main` at 2269908. Plan: [`step-2a-part2-plan.md`](step-2a-part2-plan.md), as
amended by the independent review (its ten findings, below). Commissary read at `0ad9d16b` (`~/src/commissary`, read only).
pi-ai and pi-durable 1.5.0. Everything ran on the throwaway stage `step2a2`, destroyed at the end; `prod` was never deployed,
run against or destroyed.

## Exit criteria (`docs/plan.md`, row 2a part 2)

| Criterion | Result | Evidence |
|---|---|---|
| From the stock web client, a turn the proxy answers with Commissary's 429 (reset in 2 minutes) ends as "Usage limit reached" with that reset time | **PASS** | `m1-limit-cooldown.json` (reset +120 s: failure `usage_limit`/`proxy_cooldown`, `resetAt` the proxy's reset); `m1-limit-ui.json` and `m1-limit-paused.png` ("Usage limit reached · Resumes 10:26 AM", reset +240 s for time to screenshot) |
| … after at most 4 proxy requests | **PASS: 1** | `proxy.requests` = 1 in both runs (the Session counts at the recording `fetch`, fault answers included) |
| … and with auto-resume on, the thread resumes by itself at the reset and completes | **PASS** | `m1-limit-cooldown.json`: the Environment reset when idle (`idle.reset: true`, alarm at the reset), the second run started 3.2 s after the reset and completed ("pong"); `m1-limit-resumed.png` |
| A turn the proxy refuses (401, the key revoked) ends with the key error after 1 request and no pause | **PASS** | `m1-key-live.json`, `m1-key-live.png`: the stage deployed with a made-up key, the proxy's own 401, `permission_error`/`proxy_key_rejected` "The model proxy refused this Environment's key. Check `MODEL_PROXY_API_KEY`.", 1 `/v1/messages` request, no `resetAt`. Also through the fault route: `m1-key-fault.json` |
| Stop during `bash -c 'sleep 600 & sleep 600'` (on the Container, its marked processes recorded first) leaves none in the Container within 3 s | **PASS: 0.9 s** | `m2-abort.json` (before: the call's two sleeps and its shells, each carrying an exec id, in their own group; after Stop: gone at the first `ps`) |
| After an Environment restart mid-`bash` the continuation finds none | **PASS, 5 of 5** | `m2-restart-1..5.json`: the old processes were gone before the continuation's turn reached the Session in every run (checked without clocks: each round reads the Session's turns, then `ps`; `seenWithContinuation` empty) |

Further M2 checks of the plan: a Session restart mid-`bash` (the reopened Session killed the call's processes in 0.6 s,
`m2-session-restart.json`); a background process of a call that completed survives a later Stop (`m2-survivor.json`);
with the Container stopped a kill does not start it (`m2-stopped.json`: `running: false`, the Container still stopped).
Also: an overload (529) is retried by pi-durable and ends as a provider error after 4 requests (`m1-overload.json`).

## What was built

### Usage limits and key errors (M1)

- **`packages/models/src/proxyFailure.ts`**: a pure classifier of the proxy's failure answers (status, `retry-after`,
  pi-ai's error text, the answer's time) into t3's class, a code, the plan's row, the reset, and whether a retry can
  help (`stop`). Fixed messages per code, never the proxy's body. Rows and codes: [`docs/model-proxy.md` → Usage
  limits](../model-proxy.md#usage-limits). Codes are chosen so none matches pi-ai's retry pattern.
- **The Session** (`apps/agents/src/session/proxyLimits.ts`, `SessionDO.ts`): every model request goes through a
  recording `fetch` (pi-ai's `StreamOptions.fetch`, injected by `proxyModels`) that keeps the last answer's status,
  `retry-after` and time, and counts the turn's requests. A pi-durable `afterResponse` hook classifies a failed response
  once, records `{class, code, row, resetAt, stop, at}` for the running turn (kept apart from the turns in storage so no
  turn write can lose it), and when `stop` rewrites the message's error text to `t3flare model proxy: <code>`, which no
  retry pattern matches: one request, no backoff (review finding 3's alternative, proved in M0). The pushed `TurnState`
  gains `proxy: { requests, failure? }`.
- **The differ** (`failureOf(turn, now)`): the record first, else the classifier on `detail` counted from the settle time
  (older pushes). `resetAt` is held to at least 30 s after the differ's `now`, with no upper bound, as an ISO string.
  Overload is no longer a usage limit (plan gap 3).
- **Text generation**: the classifier's message and the status for a failed answer.
- **The fault route** `POST /_t3flare/agents/proxy-fault?thread=<id>` `{fixture, resetAt}`: the Session answers its model
  requests with Commissary's answer for `cooldown`, `spendLimit`, `invalidKey`, `overloaded` or `accountUnavailable`
  until the reset, in the proxy's place. Accepted only where the agents Worker has `T3FLARE_FAULTS=1`, which
  `alchemy.run.ts` sets on every stage but `prod`. It stays: the evidence scripts use it.

### Killing an aborted command's processes (M2)

- **Markers and groups** (`packages/computer-env`): each command's environment carries `T3FLARE_EXEC=<execId>` (set in
  `exec.ts`, where the id is made), and a Container command runs as `exec setsid --wait bash -c '…'`, the leader of its
  own session and group. M0 showed computerd starts every command in pgid 1 with the supervisor.
- **The kill script** (`apps/sandbox-image/src/kill.ts`, run by the new `WorkspaceDO.killExecs(execIds)` with `bash -c`):
  by exec id only; a group is signalled whole when its leader is marked or every member is, a marked process alone
  otherwise; TERM, KILL from 2 s, rescanning every 100 ms for at most 3 s; it answers `{signalled, survivors}`.
  `killExecs` does nothing while the Container is not running.
- **The Session's running commands** (`apps/agents/src/session/runningExecs.ts`): `exec` reports start, end and stop to an
  `ExecLedger`; the ids are kept in DO storage. A stopped command is killed at once; a Stop (`#abortTurn`, so also the
  adapter's `abort({all:true})` after an Environment restart and the turn deadline) waits up to 3 s for its run's
  commands to be killed; a Session that opens kills the ids it finds from before (read before `harness.resume()`,
  bounded, never failing the open); an id stays until a kill reports no survivors, retried from the alarm every 5 s and
  given up after 12 attempts. A command that ended by itself is forgotten, so its background processes stay.

## M0, the facts

- **Live shapes** (`m0-proxy-shapes.json`): a made-up or missing key gets 401 `{"error":"Invalid API key"}` /
  `"Missing API key"`, streaming or not, before any stream starts, no `retry-after`. No spend-limited key exists (owner
  decision), so rows 1-4 and 7-10 are Commissary's own code: `packages/models/test/fixtures/proxy.json`, regenerated
  identically by `gen-proxy-fixtures.ts` from `0ad9d16b`.
- **pi-ai's view** (`m0-pi-ai-view.json`): every 429, 503, 529 and 5xx fixture is retryable to pi-ai's pattern, 401/403
  are not; streamed errors lose the status. Now a test (`proxyLimits.test.ts`: every fixture through pi-ai's real client
  is recorded as the classifier reads Commissary's raw answer).
- **`afterResponse`** (`m0-after-response.json`): on a real Harness answering the cooldown fixture, 4 requests without
  the hook, 1 with it, and the rewritten text is the submission's `detail`.
- **Processes** (`m0-abort-before.json`, `m0-restart-before.json`, `m0-session-restart-before.json`, before the fix):
  commands ran in pgid 1 / sid 1 with computerd and the supervisor; after Stop the whole tree stayed (computerd's
  `killExec` was sent, without error, and stopped nothing: cause 1); after a Session restart the call's sleeps lived
  about 2 minutes (cause 3). Cause 2 (the abort not reaching `exec`) was not seen. No fourth cause.

## Review findings

All ten were checked against the code and adopted; none was rebutted. Notes where the adoption differs in detail:

1. **`sleep`/`bash` run in the Worker Shell** (verified, `bash-routing.ts:44-45`). The evidence prompts ask for
   `backend "container"`, each M2 run first checks the call's sleeps carry an exec id (`before.marked`), and
   `docs/plan.md`'s exit wording now says so.
2. **503 `no auth available` with `retry-after`** (verified, `pick.ts:321`, `failures.ts:47-59`): `usage_limit`,
   `proxy_account_unavailable`, with the reset; stops retries. Its fixture is `accountUnavailable`, made by Commissary's
   `authUnavailable`.
3. **Classify once in the Session**: the simpler alternative held (M0) and is what was built; there is no `fetch` gate.
   The record carries row, code and the reset from the answer's time.
4. **`exec` returns 500 ms after an abort and drops the id** (verified): the ids live in the Session's storage until a
   kill reports no survivors, retried from the alarm; `#abortTurn` awaits the kill (3 s bound); the marker is set in
   `exec.ts`. The static `containerEnv` carries no marker (an owner marker was tried and dropped as unused).
5. **Kill by exec id only**: no `--owner … --except`; `m2-survivor.json` shows a completed call's background process
   kept.
6. **Kill on open**: bounded, never fails the open, after `harness.resume()` with the ids read before it.
7. **Own process group always, rescan ≤ 3 s, the group rule**: as built; the Docker tests cover each case.
8. **No 7-day ceiling; the 30 s floor against the differ's `now`** (verified, `UsageLimitRecoveryWorker.ts:33-39`).
9. **`retry-after` first for row 1**: yes. The Go-duration hint is used only when there is no header, which in practice
   is an error inside a stream (row 10) or an older push classified from its text.
10. **Prove auto-resume end to end first**: the fault route and the differ's `resetAt` were built first and the first
   live run proved auto-resume; the `afterResponse` gate was deployed in the same build rather than after it (it is a
   hook of a few lines, and the run proved both). The fault stays on until its reset and requests are counted at the
   route. For the refused key, "1 request" counts the submission's `/v1/messages` requests; the catalog refresh also
   used the key and is not counted.

## Deviations from the plan

- The kill script ships with the agents Worker (`apps/sandbox-image/src/kill.ts`, run with `bash -c`) rather than in the
  image: no image rebuild, and it is versioned with the code that calls it.
- The evidence scenarios are in `apps/environment/scripts/part2.ts` (`abort`, `restart [--session]`, `survivor`,
  `stopped`, `limit`, `key [--live]`, `overload`), not new `turns.ts` scenarios. `turns.ts restart --tools` was not used
  for the five restarts: its `sleep 25` runs in the Worker Shell (finding 1), so `part2 restart` (the Container sleeper)
  was run five times instead.
- The Session's bookkeeping is tested as a unit over a storage fake (`runningExecs.test.ts`), not in workerd; `killExecs`
  with the Container stopped is checked on the stage (`m2-stopped.json`), not in workerd.
- The fixtures stay one file, `packages/models/test/fixtures/proxy.json`.
- After an Environment restart the processes went 47-57 s after it: when t3's recovery opens the continuation's provider
  session (the adapter's abort) or the Session's next push names the turn an orphan, whichever is first; always before
  the continuation's turn reached the Session. Not within 3 s of the restart, which the criterion does not ask.

## Tests

- `apps/environment/test/proxyFailure.test.ts` (seam a): every row and fixture, header before hint, streamed errors,
  unknown answers, fixed messages.
- `apps/environment/test/differ.test.ts` (seam b): the record's reset as ISO, the 30 s floor, no ceiling, no reset, the
  key error, the fallback from `detail`.
- `apps/agents/test/proxyLimits.test.ts` (seam c): a real Harness; 1 request for a cooldown or a refused key, 4 for an
  overload, 2 for an upstream 429 without a reset followed by the cooldown; the fault route; every code's text is not
  retryable to pi-ai; every fixture through pi-ai's client.
- `apps/agents/test/killScript.test.ts` (seam d): real processes in `ubuntu:26.04` with Docker (skipped without it):
  group and grandchild, a marked process in its own group, a marked process under an unmarked leader (signalled alone),
  other ids and unmarked processes left, TERM ignored (KILL within 3 s), computer-env's wrapper leads its own group and
  keeps the exit status.
- `apps/agents/test/runningExecs.test.ts` (seam e): ended vs stopped, survivors and unreachable Workspaces kept and
  retried, the 3 s bound, a reopened instance kills only the old ids, giving up.
- `bun run check` passes.

## Counts

Patches **2**, Shadows **1**, Build shims **6**: unchanged. No new Layer. The t3code submodule is unchanged.

## ADRs

- **ADR-0012**: a refinement, "Usage limits as built".
- **ADR-0004**: a refinement, step 2a part 2: aborted calls' processes killed by marker and process group.

## Code review (since `origin/main`)

Run by this agent on both axes in turn (the skill's sub-agents could not be spawned here).

**Standards** (ADRs 0001, 0019, the repo's effect-diagnostics and oxlint rules, GLOSSARY; the smell baseline):
- Fixed: a nested ternary for `retryable` in the differ; an unused owner marker (Speculative Generality); an
  unhandled rejection path on the stopped command's re-arm; a `Date` lint in the differ.
- Judgement calls left: `SessionDO.ts` grows by about 100 lines for two concerns (Divergent Change, possible): both are
  thin wiring over their own modules (`proxyLimits.ts`, `runningExecs.ts`). The Workspace stub's `killExecs` type is
  written inline in the Session (Duplicated Code with `rpc.ts`'s, possible), as the other Session stubs are.

**Spec** (the plan, the review's findings, `docs/plan.md`):
- Fixed: a 401/403 that is neither the proxy's flat shape nor Anthropic's (an HTML page from something in front of the
  proxy) was called an account refusal; it is now no proxy failure (a generic provider error with the status).
- Partial: compaction's own model requests still retry a limited answer (pi-durable's compaction does not run the
  `afterResponse` hook); rare, and bounded by its 3 retries.
- Deviations above; no scope creep beyond the fault route's `overloaded`/`accountUnavailable` fixtures and the admin
  `workspace-call` `killExecs` used by the evidence.

## Risks and notes

- A stop's kill and the stopped command's own kill can both run (harmless: the second finds nothing).
- `killExecs` checks the Container is running and then runs the script: a Container stopping in between would be
  started by it. The window is one RPC.
- A process that clears its environment and starts its own session is out of reach, by design.
- t3's web client shows a limit or key error twice in the thread (two items, the same text); seen in the screenshots,
  not investigated.
- During M0 the GitHub App's private key from `~/.config/t3flare/dev.env` was printed into this agent's own tool output
  by a redaction that missed a multi-line value. It reached no file, commit or log; it was reported to root.

## Evidence index (`docs/steps/step-2a-part2/`)

M0: `m0-proxy-shapes.json`, `m0-pi-ai-view.json`, `m0-after-response.json`, `m0-abort-before.json`,
`m0-restart-before.json`, `m0-session-restart-before.json`, `gen-proxy-fixtures.ts`.
M1: `m1-limit-cooldown.json`, `m1-limit-ui.json`, `m1-limit-paused.png`, `m1-limit-resumed.png`, `m1-key-fault.json`,
`m1-key-live.json`, `m1-key-live.png`, `m1-overload.json`.
M2: `m2-abort.json`, `m2-restart-1.json` … `m2-restart-5.json`, `m2-session-restart.json`, `m2-survivor.json`,
`m2-stopped.json`.
