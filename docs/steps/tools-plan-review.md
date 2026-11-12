# Review: `docs/steps/tools-plan.md` (Commissary tools, code mode, harness panel)

**Verdict: go with changes.** Part 1 (code mode and tool search) is sound and can proceed through M0–M2 with M6, M8 and the summary-cut part of M2 below. Parts 2–4 and the panel need H1–H4 fixed in the plan before M3/M5 build.

I did not run anything; all findings are from reading code and docs. Four points are flagged "unverified" where I could not confirm a platform or CLI fact.

## What checks out

- **Nested calls hit the wrapped tool.** A script's call goes through `api.executeTool(call.name, …, { key: "c<id>" })` (`pi-durable/dist/codemode/codemode.js`, `callTool`), which creates a real `ToolTask`. Nested call ids are `<parentCallId>/<key>` (`dist/harness/tool.js:716`).
- **No "approve A, run B" on replay.** A key reused with another tool or other arguments throws (`tool.js`, `startNestedCall`: "already made with another tool or other arguments").
- **`codemode` and `tool_search` are model-only.** Both declare `callers: ["model"]`. `tool_search` searches only `agent.deferred`, which is already filtered by `callers` (`dist/harness/agent.js:221-225`), so it cannot load a scripts-only tool.
- **The patch does what §2.4 says.** `progressed` resets the restart count up the owner chain (`patches/deps/@earendil-works__pi-durable@1.5.0.patch`, scheduler hunk).
- **Linked status is sticky** on a Session (`SessionDO.ts:505`).
- **Settled decisions are honoured**, except the one contradiction in M1 below.

## HIGH

### H1. A stolen owner handle on `/t3flare/mcp/t3` escapes the link fence

- **Evidence.** §4 swaps a handle for the thread's t3 bearer inside the Environment DO. §3.2 and R9 admit a linked process can read an owner CLI's handle in a shared checkout, and mitigate with "tainted Workspace → writes ask". Reads stay free.
- **Problem.** t3's link fence is enforced per credential (ADR-0022: "t3's own auth, tool access, link fence and mode ceiling run unchanged"). With an owner thread's handle, linked work gets the owner's unfenced t3 read tools: other threads, projects, PR data.
- **Why it matters.** ADR-0022 rejected the bearer in a Container for exactly this reason ("Every process the agent starts could read and reuse it"). Inside the Workspace the handle is equivalent to the bearer.
- **Fix.** While a Workspace is tainted, `/t3flare/mcp/t3` refuses owner-thread handles entirely, or serves them only the linked fence's view. Do not rely on `decideCall`, since reads never ask. Add this to M5 case 4, which today only tests a write.

### H2. Per-spawn handles in Container-wide files cross threads

- **Evidence.** §3.2's table puts the handle in Claude's managed settings and in `/etc/opencode/opencode.json`. Both are one file per Container, overwritten by every launch:
  - `apps/sandbox-image/image/t3flare-claude-agent-acp:11-13`
  - `apps/sandbox-image/image/t3flare-opencode:8-10`
- **Problem.** Today those files are identical per spawn, so the overwrite is harmless. With a handle inside:
  - Thread A's process picks up thread B's handle on its next settings read. The relay then applies B's mode and linked flag to A's calls, so an approval-required thread writes silently through a full-access thread's handle.
  - A's MCP breaks when B exits and its handle is revoked.
- **Fix.** Keep the system files handle-free (URL allowlist only). Deliver the handle per process:
  - Claude and OpenCode: through ACP `session/new` `mcpServers`, injected by `acpDriver` as part 3 already does for t3's server; or a helper that reads the per-home nonce, like `t3flare-claude-key`. Unverified: whether Claude's MCP config supports a headers helper; check in P8.
  - Add an M5 case with two same-CLI threads in one Workspace in different modes.
- **Related.** Codex's handle is on argv (`-c …http_headers`), which contradicts §12's "never the environment". That is harmless given root, but state it honestly.

### H3. Tool class comes from live, untrusted hints, so a server can turn a write into a read

- **Evidence.** §3.1 and §5.3 take class from `annotations.readOnlyHint === true`. Commissary takes it from the upstream MCP tool's hint too: "Upstream annotations are untrusted hints" (Commissary ADR-0038, line 19). The inventory relists every 10 minutes.
- **Problem.** An upstream server (Route A toolkit or Route B) that starts sending `readOnlyHint: true` removes every card at the next refresh. That includes the linked per-call rule. R7 accepts this, but it defeats the settled "unknown counts as write" intent.
- **Fix.**
  - Route B: every tool is write until the owner marks it read in the panel. The hint is only shown as a suggestion.
  - Both routes: pin class by (server, exact upstream name, definition hash). A write→read change, or a changed definition under a read override, stays write until the owner confirms it in the panel.
  - Key classes by exact upstream name, and refuse tools whose sanitised names collide.
  - Add a fixture tool that flips its hint mid-run.

### H4. The panel shares an origin with t3's web client, and the browser path drops the admin token

- **Evidence.** §6.1 admits the owner on the Access assertion alone. The Environment Worker serves t3's web client on the same host (`worker.ts:25`, ADR-0010 "the web client is served by the Environment itself").
- **Problem.** CSRF and Origin checks stop other origins only. Any script running in t3's web app can fetch the panel, read the CSRF token, and add a server or re-class tools. That app renders agent and linked-peer content; I did not audit it for XSS. Today such a script cannot reach admin routes, because they need the bearer (`access.ts` header comment).
- **Fix that keeps the settled path.** Serve `/_t3flare/harness` only on a dedicated admin hostname with its own Access application, and refuse it on the t3 host. On workers.dev-only stages, use a tiny Worker that forwards over a service binding.
- **If a separate host is refused**, require a typed step-up (the admin token, held in page memory only) for security-weakening changes: add a server, set class to read, set Exposure to direct, start OAuth. Record the residual risk in ADR-0026.
- **Either way.**
  - HTML-escape all server-supplied strings (tool names, descriptions, server info, test errors), and test with hostile values.
  - Tighten the CSP to a hash or exact script path. `script-src 'self'` covers the whole t3 origin.

## MEDIUM

### M1. §3.2 contradicts the linked-write decision
"write tools dropped for a linked caller" in the `tools/list` bullet conflicts with §3.3, M5 and the settled rule that linked threads get write tools with a card per call. Delete the clause.

### M2. Cards can hide what is approved
- §3.3 cuts arguments to 2 000 characters and §3.1 says 16 KiB; the two disagree. `summaryOf` cuts `bash` at 2 000 too (`permissions.ts:39,196`).
- A script-built command or JSON with benign leading fields is approved unseen.
- Fix: one rule. Show the full text up to a cap; past the cap, auto-decline, or show size plus hash with an explicit "truncated" warning. Escape control and bidi characters, as SPI-992 M6 did for refs.

### M3. `McpRelayServer` creates a binding cycle and a trust problem
- **Cycle.** The Environment binds the engine, and the relay server in the MCP Worker must call `EnvironmentDO.mcpCall`. cloudpid ADR-0038 avoided this deliberately: "Cloudflare rejects a binding to a script or class that does not exist yet". §3.0's deploy order (mcp before environment) fails on a fresh stage, and P11 does not test it.
- **Trust.** The Worker that parses Container-controlled bytes also asserts caller identity and shares isolates with engine calls that carry credentials.
- **Fix.** Route `WorkspaceProxy` → `EnvironmentDO.mcpRelay({ workspace, handle info, request })` over the existing binding. The Environment calls the MCP Worker's relay entrypoint with callbacks (cloudpid's pattern). The MCP Worker then has no bindings. §12's alchemy row is missing these bindings either way.

### M4. OAuth cannot work as placed
- CIMD at `https://<host>/_t3flare/mcp/client.json` is behind Access, so an authorization server cannot fetch it.
- cloudpid ADR-0035 moved the document and the callback outside Access for this reason and for cookie and re-login failures.
- The callback is a state-changing GET, which conflicts with §6.4's "GET never changes state".
- Fix:
  - Public exact-match paths with an Access Bypass application. Avoid t3's own `/oauth/mcp/*` routes.
  - Single-use 256-bit `state`, PKCE, and the `iss` check.
  - An ADR-0010 refinement for the new public surface.
  - An M0 probe. None covers OAuth, yet M6 case 7 depends on it.

### M5. SSRF guard is a denylist and misses the platform's real hole
- cloudpid's `packages/mcp/src/public-fetch.ts:4-6` notes that a Worker's fetch to its own hosts is refused "or sends it to the origin past Access", and gives its MCP Worker `global_fetch_strictly_public`.
- The plan has no such flag, and §5.3 has the Environment DO refreshing tokens itself.
- Server-supplied URLs (OAuth metadata, token and registration endpoints, redirects) are the real vector, not the owner's typed URL.
- Fix:
  - Set the flag on the MCP Worker.
  - Make every outbound MCP and OAuth request from the MCP Worker, including the panel's "test" and token refresh.
  - Apply the guard to every discovered URL and hop: HTTPS, no userinfo, no account zones or workers.dev subdomain, `redirect: "manual"`.
  - Port cloudpid's `apps/mcp-worker/src/scrub.ts` so an echoed header or token is redacted before it reaches a Session or t3's projection. The hash scan only detects after the fact.

### M6. Losing the sandbox DO fails the script, and no probe covers it
- **Evidence.** A rejected `target.execute` becomes `events.failure({ kind: "sandbox" })` (`pi-codemode/dist/runtime/remote.js`, `remoteLauncher`). `codemode.js` commits that as the call's outcome and aborts the nested calls. Only a host-side close is treated as "not an outcome".
- **Effect.** A sandbox Worker deploy, runtime restart, CPU-limit reset or isolate OOM during an hours-long approval wait ends the script and withdraws the card. This fails closed, but §2.4 implies otherwise.
- **Memory.** "All VMs in one isolate share its 128 MB" (pi-codemode README, Limits). At 32 MiB each, about four concurrent Sessions' scripts can reset them all. `delegate_task` fan-out makes that plausible.
- **Fix.**
  - An M0 probe that redeploys or kills the sandbox mid-approval and runs N concurrent memory-heavy scripts.
  - Lower the VM cap to 8–16 MiB.
  - Either accept "script failed, completed calls listed" in the text, or budget a patch to rerun on sandbox loss. The latter changes the "patch unchanged" claim.

### M7. Handles let owner threads borrow each other's mode
- R9 covers linked theft only.
- In an untainted Workspace, a thread in approval-required (or its `bash` once commands are accepted for the session) can use a live full-access CLI thread's handle and write through MCP with no card. MCP reach goes beyond the repo, unlike the existing shared-Workspace trust.
- Fix: the relay decides with the strictest mode among live agent threads in the Workspace. Or document the acceptance in ADR-0027.

### M8. Concurrent asks can overflow one storage value
- All pending requests live in one KV array (`permissions.ts:88-91`).
- A `Promise.all` of many writes, each with a 16 KiB argument and a 600-character script excerpt, can exceed the per-value limit and bloat every push. Unverified: I recall the SQLite-backed DO limit as about 2 MiB.
- Fix: cap pending asks per `codemode` call (for example 8, the rest queue), store the script excerpt once per parent, and add an H2 case with 200 concurrent writes.

### M9. Conflicts with the SPI-992 asker
- `approveCliPush` refuses when `input.linked && !asker.linked` (`.worktrees/spi-992/apps/environment/src/provider/cli/linkedPushAsk.ts`). The plan's "tainted Workspace → treated as linked, asked on the owner's thread" would be refused as "not linked work". Add a separate `perCall` flag.
- A tool card must never carry the push card's "accept for the session = trust this Workspace again" option (Review changelog H1).
- After the prefix rename, keep recognising `t3flare-push` ids so a stale card is closed, not forwarded to t3's adapter.
- Count a held `mcpCall` as open work for the Environment's idle reset, as SPI-992 M7 did for pushes.

### M10. Gaps in the decision rule
- `tools/call` must refuse `hidden` and scripts-only tools, not only drop them from `tools/list`.
- State whether the linked per-call rule applies to t3's own write tools. §4 applies `decideCall` to them on CLI threads, while §2.3 leaves Durable threads to t3's fence. Pick one.
- `decideCall` must check `linked` before `accepted`, because an acceptance stored as `mcp-tool:<name>` persists.

### M11. CLI timeout is shorter than the worst case
660 s is less than the 600 s approval wait plus the 270 s call. A late approval yields a client timeout while the write proceeds, and the model may retry. Set about 900 s, or cap the approval wait at 660 − 270 s.

### M12. Inventory size
- `t3flare:mcp-build` as one Session KV value, plus per-Session tool registrations in isolates shared with Workspaces (ADR-0014), is unbounded.
- Cap tools per server and schema bytes, chunk the stored build, and measure Session heap in P3 with 500 tools.

### M13. Linked reads are free with the owner's key
- This honours the decision, but a linked laptop's agent can read anything the tools key reaches, and the results travel back over the link.
- §6.2 mentions "link access" in settings while §6.3 says it is fixed. Pick one.
- Suggest a per-server "offered to linked threads" switch, default off for direct servers, and say so under OD-T1.

## LOW

- **Reserved names.** Reserve `t3` as a direct-server name; `/t3flare/mcp/t3` collides. §5.3 only reserves `t3-code` and `commissary`.
- **OpenCode allow rule.** `allow("tool.use", "commissary_*")` and the flavor's auto-allow match by name prefix. Confirm in P9 that a repo cannot define a tool with that prefix, and match on MCP origin instead.
- **CSRF token.** The HMAC over the hour needs to accept the previous hour. Compare Origin to the configured host, not the request's.
- **Secret hashes.** Use an HMAC with a DO key rather than plain SHA-256, since owner-typed header values may be low-entropy.
- **Fixture bearer.** §7 says "generates per run" and also "the owner adds it once"; these conflict.
- **Plan mode.** `codemode` writes its overflow output to a temp dir through `env.writeFile` (`codemode.js`, `outputFiles`). This is a write outside `guarded` in plan mode; note it.
- **Evidence files.** Redact handles and the fixture bearer in `docs/steps/tools/*.json`.
- **Renames.** A session acceptance keyed by tool name survives a Commissary rename to a different upstream tool. Clear acceptances when a definition hash changes.

## Owner decisions

| OD | View | Reason |
|---|---|---|
| T1 key scope | Agree, named toolkits | Linked reads use this key (M13), so "every tool" is too wide. |
| T3 no Commissary rules | Agree | One asking place; the text fallback is still readable if rules are kept. |
| T4 `modelTools` B | Agree | Keeps diffs and commands as today, and guards are path-independent. |
| T5 alchemy bundling | Agree | Port cloudpid's `sdk-isolation.test.ts` so the SDK cannot enter the agents or Environment bundle. |
| T6 "call again" fallback | Agree, with conditions | The grant must be bound to thread + tool + argument hash, single-use, 10 minutes, never widened by taint. |
| T7 elicitation later | Agree | Nothing needs it under T3 and T11. |
| T9 no settings tools | Agree | Given H3 and H4, an agent editing its own server set is the wrong direction now. |
| T10 copy `@cloudpid/mcp` | Agree | It also pulls `@cloudpid/protocol`, `effect`, `@earendil-works/pi-mcp` 1.5.0 and `tldts` (`packages/mcp/package.json`); the plan lists only the SDK. |
| T11 Executor `browser` | Agree | `model` mode would let the agent approve itself. |
| T12 stdio refused | Agree | No secrets in Containers makes them pointless. |
| T13 four Workers | Agree | Give the MCP Worker no bindings and the strictly-public flag (M3, M5). |
| T14 stage and fixtures | Agree | Fix the bearer contradiction, and add the probes from M4 and M6 plus the H2 two-thread case. |
