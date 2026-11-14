# SPI-1195: the Settings server, agents change t3flare's settings over MCP

Report for SPI-1195 and its milestones SPI-1196 to SPI-1202, with SPI-1076 as M2. Plan, with every review's changes
recorded in place: [`settings-mcp-plan.md`](settings-mcp-plan.md). Decision records:
[ADR-0034](../adr/0034-agents-change-t3flares-settings-through-the-settings-server.md) (the server, its tiers, its
modes) and [ADR-0035](../adr/0035-owner-clients-reach-the-settings-server-at-t3flare-mcp-behind-an-access-application-of-its-own.md)
(where the Owner-client endpoint lives). Evidence: [`settings-mcp/`](settings-mcp/).

**State, 2026-11-14: built and unit-tested through M6 on branch `settings-mcp`, rebased on `origin/main` at 96ee913;
nothing pushed, deployed or run on a stage after M0.** Every milestone's stage evidence is owed (the "Evidence"
section), and two owner steps gate parts of it. Prod is deployed without the Owner-client endpoint until owner step 1
passes and M5a's stage evidence is recorded, and the nightly job's `bump` stage without it for good (ADR-0035; one
switch, `OWNER_ENDPOINT_EXCLUDED_STAGES`).

## What was built

### M0 (SPI-1196): the spike

On stage `psettings`, on the spike branch `settings-mcp-m0-spike` (41b823a), which is never merged: its probe code
(`apps/environment/scripts/settings-spike/`, the `T3FLARE_SETTINGS_SPIKE` switches) stays there. Its evidence
(`m0-access-oauth.json`, `m0-clients.json`, `m0-pi.json`) is copied into [`settings-mcp/`](settings-mcp/) unchanged
(scanned for secrets first; the spike had already cut cookies, JWTs and session values to a prefix or `[redacted]`).
The owner's steps, [`settings-mcp-m0-owner-steps.md`](settings-mcp-m0-owner-steps.md), are copied here too (their
commands still run on the spike branch). Its answers are summarised in both research files' "M0's answers" sections
([`access-managed-oauth.md`](../research/access-managed-oauth.md#m0s-answers-spi-1196),
[`mcp-elicitation-server.md`](../research/mcp-elicitation-server.md#m0s-answers-spi-1196)).

Decisions: layout (B), conditional on owner step 1; the Elicitation mode in the URL's query; the redirect allowlist any
`localhost` and loopback URI plus `cursor://anysphere.cursor-mcp/oauth/callback` (pending owner step 2); `PI_OFFLINE`
kept (it does not stop pi's MCP); pi's built-in MCP tools carry `sourceInfo.path: "builtin:mcp"`, so the Patch is
possible.

### M1 (SPI-1197): one module for every Settings change

- `apps/environment/src/harness/ops.ts`: the panel's handlers as functions over the same dependencies, called by both
  doors, each taking an actor and an optional `expectedRevision`. The panel calls them and nothing else; it takes
  `expectedRevision` in a body (stale 409, malformed 400, absent as before), skills routes included.
- The set-header op, for the panel too: `POST /_t3flare/harness/api/mcp/secret` `{ server, value }`, audited as
  `mcp.secret.set` with the mark, no revision bump.
- `packages/harness-registry/src/tiers.ts`: `tierOf`, the Change tier and `needsPage`, with `guard` on `guardian` and
  `permissions` and `tier` on the registry's settings (absent is asked).
- Audit entries gain `via`, `thread`, `agent`, `client`, `tier`, `mode`, `answeredBy`, `change`; the Workers Logs line
  gains `via`, `tier`, `mode`, `answeredBy`. Skills take an `expectedRevision` and never retry with one
  (`skills/store.ts`, which retries up to three times without one; the plan first said once).
- `withoutQuery` for a Direct server's URL in reads outside the panel.

### M2 (SPI-1076): the pi CLI gets the relay's servers

- `piLaunch` writes `$PI_CODING_AGENT_DIR/mcp.json`, one entry per relay server (the relay's URL,
  `Authorization: Bearer ${T3FLARE_TOOL_HANDLE}`, timeout 900, Exposure `deferred`), and sets the handle and
  `T3FLARE_RELAY_SERVERS` in the process's environment. The fork launch (`--no-extensions`) gets neither.
- **Patch 0006** (`patches/0006-pi-relay-tools-are-judged-by-the-relay.patch`): t3's pi extension does not ask "Allow
  …?" for a tool of pi's built-in MCP client whose server is one the relay serves this process; the relay judges and
  asks. Recorded in ADR-0001's counts (Patches 6) and `docs/upstream-fragility.md` U67.
- Tests: `cliProfiles.test.ts` (T-pi-1), `piRelayPatch.test.ts` (the Patch applied to t3's extension source and run).
  `scripts/tools.ts` `cli-mcp` gained pi.

### M3 (SPI-1198): the Settings server for t3flare's own agents

- The `settings` kind of MCP server (`packages/harness-registry`): the name reserved, the entry implied (on, deferred,
  read-write), `writes` its own switch, a stored server under its name or kind ignored (and dropped with its secrets by
  the next change to the set). The panel shows the access switch as off / read-only / read-write.
- `apps/environment/src/settings/server.ts` (tools in `tools.ts`): thirteen static tools, reads, free changes through
  `ops.ts`, D7's table (one owner-only card outside full access), served in-process by `McpHost` with no engine call.
- The caller (D3): the Session passes its thread to `mcpCall`; `provider/threadCaller.ts` derives Linked work
  (`threadLinkIn`, reading the thread projection's `linkOrigin` and `lineage.parentThreadId`, U66) and the Durable mode
  record (`durableModeRecord`, noted at `open` and `submitTurn`, forgotten at unregister); a CLI's modes are its live
  session's. Linked, unknown and mode-less callers read only.
- The Session's `mcp` extension and the relay keep plan mode's refusal for this server and raise no card of their own.
- Reads (D14): no secret value or fingerprint, no URL query of a Direct server, no authorization URL; the audit log
  without the owner's subject.

### M4 (SPI-1199): Open changes, the card, the Change page

- `settings/changes.ts`: the table `t3flare_settings_changes` in the Environment DO's SQLite (and
  `t3flare_settings_reads` for the read caps), lazy pruning, the one close log line (`closedLine`).
- `settings/openChanges.ts`: one answer (`answerOpenChange`), D8's answerer table, expiry at 10 minutes, a moved
  revision, every cap of D16, and `closeOrSettle` (a decline, Stop, cancel or timeout that lands while another answer
  applies the change waits for its outcome).
- The owner-only approval card for an own agent's asked change, written by the server (`settings/render.ts`);
  "Opened it" / Decline / Cancel for a change that needs the page.
- The Change page (`harness/changePage.ts`, `changePageScript.ts`) under the panel's path and guards, every diff kind
  of D10, the secret field and the sign-in start; the panel's Open changes list; `get_status.openChanges`.
- A Stop reaches the server (`mcp/callStops.ts`): the Session names its call to `EnvironmentDO.cancelAsk` by its
  `stopId`, and the relay's call runs under the CLI's `askId`.
- Skills preview at a named commit, and an install or update refused when the fetched digest differs from the one shown.

### M5a (SPI-1200): the Owner-client endpoint, `browser`

- `settings/endpoint.ts`: hand-written JSON-RPC, `2026-07-28` (`server/discover`, per-request `_meta`, `resultType`,
  `input_required` with a signed `requestState`) and `2025-11-25` to `2024-11-05` (a signed session id, the page
  elicitation on the call's stream); D11's guards; the 45 s hold for the Change page; the link in the result as every
  fallback. Signed tokens in `settings/tokens.ts`.
- `EnvironmentDO.settingsMcp`; the server's owner door (`settingsOwnerCall`), Open changes keyed by the Access `sub`.
- Layout (B) (`settings/endpointLayout.ts`, `worker.ts`, `alchemy.run.ts`): `SettingsAccess` on `<host>/_t3flare/mcp`
  with managed OAuth, the path-cookie attribute on both applications, `T3FLARE_ACCESS_SETTINGS_AUD`,
  `verifySettingsRequest`, the endpoint's URL (`settingsMcpUrl`) in the stage's credentials file; stage `psettings` in
  `STAGES`. On every stage but prod and `bump`: prod gets none of it until owner step 1 passes, `bump` none at all
  (`OWNER_ENDPOINT_EXCLUDED_STAGES`), so their admin applications are as on `main` and `/_t3flare/mcp` answers 404
  `not_configured`. `scripts/acceptance.ts`
  step 2b, and `scripts/smoke.ts` on every prod deploy, assert the host's root OAuth documents are still t3's.

### M5b (SPI-1201): `native` and `model`

- `native`: a form with no fields. 2026: `input_required`, answered by the retry, no hold. 2025-11-25 and 2025-06-18
  (without `mode`): `elicitation/create` on the call's stream, held until the response POST, the stream's end or the
  change's expiry, with progress or an SSE comment every 15 s; a cut stream withdraws the change.
- `model`: Executor's Pause at once on every version; `resume` listed in `model` alone; another sub's, another mode's,
  closed and unknown ids refused; the access switch refuses it.
- D12's fallbacks toward `browser`, each with its reason in the `waiting` result.
- **What `native` and `model` may approve.** Every asked change that does not need the page, including turning a Guard
  off or changing its settings, marking a tool `read`, and changing the Settings server's own entry: ADR-0034 §8 and
  its first consequence, and plan D6, which makes only a secret, a sign-in, a skills install or update, and text too
  long to show page-only. Whatever holds an Owner client's token can therefore turn the Guardian off through `model`
  with no person involved; the audit's `mode` and `answeredBy` are the only trace. This is the owner's decision (O5,
  O6), not a gap.
- The SPI-1201 spec review then changed (each tested):
  - a close that gave up waiting on an applying answer answers `waiting`, not "the change failed"; an own agent's
    close waits `OWN_APPLYING_WAIT_MS` (the skills request budget and 15 s) for it;
  - a 2025 `native` answer POSTed with no live stream on its change (the Environment reset since) withdraws it by
    `stop` and applies nothing;
  - live held streams are counted per change and per caller: only the last one cut withdraws the change, and at most
    2 per change and 8 per caller hold (past either, `W` saying why);
  - Patch 0006 asks for a tool whose name only starts like a relayed server's (`settings--x`, `settings__x`,
    `settings-`, `commissary_`);
  - an Owner client's `oversize` is judged on the message actually sent in its mode, not the change's text alone;
  - the declined-repeat hash drops a URL's fragment and empty query, takes an install's source as its repo alone and
    its folders as a set;
  - a 2026 `MCP-Protocol-Version` header with no version in `_meta` is `-32020`;
  - caps, open changes and reads are keyed by door (`own:`, `owner:`), and `get_status` lists the calling door's own
    changes.

### M6 (SPI-1202): the hostile list, this report, the docs

- `apps/environment/test/settingsHostile.test.ts` and a case in `workerRouting.test.ts` (the map below).
- [`settings-mcp/m6-stage-run.md`](settings-mcp/m6-stage-run.md): what the hostile stage run records.
- Docs brought in line with what was built (the "Docs" section).

## The hostile list

Plan §5, line by line: where each is tested now, and what the stage run adds.

| Hostile case | Unit tests | Stage (`m6-stage-run.md`) |
| --- | --- | --- |
| An injected agent asking repeatedly is stopped by the caps | `settingsHostile.test.ts`: "one thread: a repeat of a declined change is refused, and the third decline in a row locks it out without a card"; `openChanges.test.ts`: "D16's caps" (every cap), "the strike lock runs an hour from the third strike, not the first", "a second asked call on the same thread is refused while one is open, naming it", "D16's caps under parallel calls"; `settingsServer.test.ts`: the applied cap; `settingsHostile.test.ts`: "40 asks each dropped by a Stop, or cancelled on the card: past 6 in an hour the rest are refused" (the opened cap, SPI-1195 review) | items 1.1 (Durable), 1.2 (Codex) |
| 17 children leave the 17th refused | `settingsHostile.test.ts`: "17 children asking at once: 16 wait for the owner, the next is refused naming the panel's list, with no card"; `openChanges.test.ts`: "at most 16 across the Environment …" | item 1.3 |
| An agent in a Container, and in the Preview browser, opening the Change page's URL gets Access's login | `workerRouting.test.ts`: "the Change page and its API: nothing but the panel's own assertion reaches them" (behind the edge only; the login is Access's, at the edge) | item 2 (stage only) |
| A leak scan finds a typed secret nowhere but the secret store | `settingsHostile.test.ts`: "after a header value is typed on the Change page: no SQLite row, no other kept key, no result, card, log line or audit entry holds it"; `changePage.test.ts`: "a secret typed on the page reaches the secret store and appears in no response, log line, audit entry or record"; `settingsServer.test.ts`: reads carry no secret | item 3 |
| An Owner client's token presented at the panel's path is refused | `workerRouting.test.ts`: "refuses the panel's audience at the endpoint, and the endpoint's at the panel"; `access.test.ts`: `verifySettingsRequest` both ways | item 4; M5a item 1 (owner step 1, the gate of layout (B)) |
| In `model`, an agent approving its own change is applied and audited with `answeredBy: "agent"` | `settingsModes.test.ts`: "resume with accept answers it, closed by agent" | item 5; M5b item 12 |
| Own agents, by Session and by each CLI, see no `resume` and no Pause | `settingsHostile.test.ts`: "a Durable Session: …" and "a CLI (codex, claudeCode, opencode, pi) through the relay: …" (every mode; approved, declined, cancelled; a change that needs the page; `resume` by name); `settingsServer.test.ts`: "on: … resume never", the reads' "no result is a Pause"; `apps/agents/test/mcpExtension.test.ts` | item 6 |
| A parent agent cannot answer a child's card | `settingsHostile.test.ts`: "the child's asked change raises its card on the child's thread alone; the parent's t3_pending_request on it is refused"; `settingsCard.test.ts`; `mcpElicitation.test.ts`: `refuseOwnerOnly` | item 7 (t3's own refusal to answer an approval card is stage only) |
| Turning the access switch off through the server; only the panel turns it back | `settingsHostile.test.ts`: "off: the next call by any door finds no server, nothing reaches it to turn it on, and the panel does", "read-only: no agent's write turns writes back on, through either door"; `settingsServer.test.ts`, `settingsEndpoint.test.ts`, `settingsModes.test.ts` (the switch in `model`) | item 8 |

**Bugs found by the hostile tests: none.** Every new case passed against the code as it stood at ecb5477. Two errors
in the stage-run docs were found and fixed: `m4-stage-run.md` item 10 expected a Stop to close a change `by: agent`
(the code, and the plan since the SPI-1199 review, say `stop`), and its item 6 implied `peer-leak` reads the audit log
and Open change rows (it reads the Container and the Sessions; the rest must be passed in its `text`).

**Bugs the SPI-1201 spec review found, all fixed with tests** (the M5b section lists each): a 2025 `native` answer
applied after an Environment reset with nobody holding the result; one cut stream withdrew a change another stream
still showed, and held streams were unbounded; a close that gave up on an applying answer said "the change failed";
an Owner client's form or Pause could carry a cut message without the change being page-only; a thread whose id equalled
an Access `sub` shared that client's caps and showed in its `get_status`; Patch 0006 let a tool of a look-alike server
(`settings--x`) through unasked; respellings slipped past the declined-repeat hash; a 2026 header without a body
version answered the wrong error code.

**Bugs the whole-branch review (SPI-1195) found, all fixed with tests**: a failed apply's error quoting a Direct
server's URL kept its query (where a key may be) in the change's record, its log line and every door's result; the
Owner door listed and ran a tool the owner hid on the Settings server's entry; an agent could ask and drop (Stop, card
Cancel) without end, since a withdrawn change neither strikes nor applies (deviation 29); and the panel's Settings deps
loaded the provider modules on a cold Environment (`m1-stage-run.md` item 4 checks it on a stage).

## Deviations from the plan

Changes the reviews made are recorded in the plan itself; each is listed here with its reason.

1. **A second Access application** contradicts ADR-0026 §1 and its "Back to stock" (no second application). It is
   recorded there as a refinement pointing at ADR-0035: an Owner client's managed-OAuth token on the `/_t3flare`
   application would be admitted at the panel and the Change page, so the endpoint needs an application of its own.
2. **Layout (B) is conditional** (D13, ADR-0035). M0 showed Access routing `/_t3flare/mcp` and `/_t3flare` apart and
   leaving the root well-known documents alone, but that one application's token is refused at the other's paths was
   tested with a service-token stand-in only. The OAuth bearer case is owner step 1 (M5a items 1-4); if it fails, the
   layout moves to (C). No `apps/settings-worker` was built.
3. **Cursor's redirect is from third-party reports** (D13): `cursor://anysphere.cursor-mcp/oauth/callback` is in the
   allowlist pending owner step 2; Cursor was not installed where M0 ran.
4. **Access lifetimes are set explicitly** (D13): M0's P11 showed the applications API stores any value unvalidated, so
   the 15-minute token and 168-hour session are written by t3flare, and the token's actual `expires_in` is a stage check
   (M5a item 1).
5. **More modules than §7 listed**: `settings/changes.ts` (the table, the read table, the caps' constants, the close
   line), `settings/caller.ts`, `settings/endpointLayout.ts`, `settings/types.ts`, `provider/threadCaller.ts`,
   `mcp/callStops.ts`, `mcp/canonical.ts`, `harness/keys.ts`, `harness/paths.ts`, `harness/changePageScript.ts`. Reason:
   the reviews asked for one write path for both doors, one close line, shared keys and paths, and a host and relay that
   import no `settings/server.ts`.
6. **The Linked-work check reads the parent too** (D3, §9's last row): `threadLinkIn` treats a child of a linked thread
   as linked even without the origin, and a parent id that is present but not a thread id as unknown (SPI-1198 review).
7. **Patch 0006 is narrower than D4 wrote** (SPI-1199 and SPI-1200 reviews): it lets a built-in MCP tool through unasked
   only when its server is one the relay serves this process (`T3FLARE_RELAY_SERVERS`, set by `piLaunch`), matched as pi
   names its tools (`mcp__<server>__` with every character but letters, digits and `_` replaced; `my-docs` is
   `mcp__my_docs__`). Reason: a server from anywhere else, or a look-alike name, must still be asked.
8. **Reads are capped and not audited** (not in the plan; SPI-1198 review): reads through the server write no audit
   entry and are capped per caller per hour (240 in all; 20 that reach GitHub or an MCP server: `test_mcp_server`,
   `preview_skills`, `check_skill_updates`, and an install's or update's preview). Reason: an agent in a loop would fill
   the 1,000-entry audit log and spend the GitHub limit. `preview_skills` is refused to a caller that may not write
   (Linked, unknown, mode-less, plan).
9. **Only the MCP server set is scrubbed of URL queries** (D14, SPI-1198 review): Variables, the Global mise config and
   a `SKILL.md` read as they are, so writing back what was read is `unchanged`.
10. **A card-approved free change is audited with `mode: card` and `answeredBy: card`** (D15 said `answeredBy` is absent
    for a free change; SPI-1198 review, ADR-0034 §11). Reason: outside full access a free change is answered on a card,
    and the audit says what answered. In full access a free change has neither.
11. **Skill install and update need the page** (D6, SPI-1199 review): only the page shows each skill's `SKILL.md` and
    files.
12. **The card names no code-mode script** (D9; accepted in the SPI-1199 review): the MCP host carries no such fact for
    a nested call.
13. **A Stop closes a change `by: stop`** (D8, D9, SPI-1199 review), through `cancelAsk` and `mcp/callStops.ts`; `agent`
    is model-mode `resume`'s alone. The registry registers writes only, shares a running id rather than aborting it, and
    remembers a stop that arrives before its call for a minute (256 at most). A Stop closes the change before it
    withdraws the card (SPI-1200 review).
14. **The declined-repeat hash is of the normalized change** (D8, SPI-1199 and SPI-1200 reviews): junk keys, a respelled
    add URL and an install source spelled another way are the same change.
15. **Closed rows are kept two hours, not one** (D8): the longest a cap looks back is a run of strikes and the lock
    after it. **The strike lock runs an hour from the third strike** (D16; the first cut ran it from the first).
16. **The open caps are checked again at insert** (D16): describing an asked change awaits (a skill preview reads
    GitHub), so parallel calls could each pass the first check.
17. **An answer racing an applying answer waits for it** (`closeOrSettle`, SPI-1200 review): the card, an Owner client's
    retry, a held stream and `resume` report `applied` rather than a stale `withdrawn`.
18. **The access switch is checked again after a card** (D2, SPI-1198 review): a switch turned off or read-only while a
    card waited applies nothing. A 2026 retry is refused naming the panel when the server is off or read-only.
19. **The endpoint is stricter than D11's table** (SPI-1200 review, checked against the 2026-07-28 spec; accepted in the
    SPI-1201 spec review, since the specs mandate it; a 2026 header with no version in `_meta` is `-32020` too): on 2026
    `MCP-Protocol-Version`, `Mcp-Method` and, on `tools/call`, `Mcp-Name` are required and must equal the body (400,
    `-32020`); an unsupported version is 400 with `-32022`; an unsupported method is `-32601`, 404 on 2026 and 200 on
    2025; on 2025 an unknown `MCP-Protocol-Version` is 400 and a missing one is `2025-03-26`; `initialize` at 2026 or an
    unknown version answers `2025-11-25`. Other query parameters are ignored (OpenCode appends `codemode=false`, M0).
20. **Prototype-safe lookups** (SPI-1198 review): a user-supplied key never reads `Object.prototype` in the registry,
    the tiers, the renderer or the panel page.
21. **The interim of D17** (an asked change refused naming the panel) existed only between the M3 and M4 commits; it
    never shipped.
22. **M2's first commits were swept into two SPI-1198 review commits** (ced70d4, fb946e9) by a concurrent commit;
    a5ddaf1 and af45e15 add the Patch and ADR-0001's counts. History only; the tree is as intended.
23. **`W` says why, and `native` and `model` messages say how to answer** (D12; accepted in the SPI-1201 spec review).
    The waiting result adds the fallback's reason (no form declared, a change that needs the page, too many held calls),
    and the message `M` in `native` and `model` ends with how it is answered and the Change page's link, which the
    plan's `M` (the card's text without the agent's call) did not have; `oversize` is judged on that whole message.
24. **A JSON-RPC error in place of a 2025 form's answer withdraws the change** (D12 named `accept`, `decline` and
    `cancel` only; accepted in the SPI-1201 spec review): the client could not ask, so the held call ends rather than
    waiting out the change.
25. **Additions the plan did not name, accepted in the SPI-1201 spec review**: `OWNER_MODE_INSTRUCTIONS` (the server's
    instructions say which mode the client asked in); the cap's refusal in `model` names a `requestId` to resume (D16
    named it for "one already open" only); the call-stop registry's early-stop memory (a flood of over 256 early stops
    only drops the oldest, which restores the behaviour without the memory: a Stop that raced its call is lost).
26. **Behaviour the SPI-1201 spec review added beyond the plan**: held streams counted and capped (2 per change, 8 per
    caller), the last cut alone withdrawing; a native answer with no live stream withdrawn by `stop`; caps keyed by
    door; the own door's longer wait for an applying answer and `waiting` when any wait runs out; the hash's further
    canonicalisation; Patch 0006's rest-of-name rule. Each is recorded in the plan (D4, D6, D8, D12, D16) and U67.
27. **Prod, and `bump`, are deployed without the Owner-client endpoint** (D13, ADR-0035; SPI-1195 review): the plan
    put layout (B) on every stage. Until owner step 1 passes and M5a's evidence is recorded, `OWNER_ENDPOINT_EXCLUDED_STAGES` holds
    `prod`: no `SettingsAccess`, the admin application exactly as on `main`, no `T3FLARE_ACCESS_SETTINGS_AUD`, so
    `/_t3flare/mcp` answers 404 `not_configured`. Enabling prod is removing it from that list. Reason: (B) is unproven,
    and a prod deploy is not where to find that out. The switch is unit-tested; `alchemy.run.ts` itself needs
    Cloudflare's providers to run, so that it reads the switch is checked by reading it, and by M5a item 4c on prod.
    Expected on prod while it is excluded: `/_t3flare/mcp` gets the admin application's Access login (its `kid` the
    admin application's AUD) with no `resource_metadata` challenge, and the first prod deploy's output shows no
    `SettingsAccess` and `AdminAccess` unchanged. `bump` is excluded too, for good: the nightly job deploys it with the
    CI token `t3flare-ci-bump`, which is not known to be allowed to create a managed-OAuth Access application, and a
    failure there would break the nightly job; its acceptance run never calls the endpoint.
28. **The smoke check boots t3** (SPI-1195 review): `scripts/smoke.ts`, which every prod deploy runs, now asserts the
    root `/.well-known/oauth-*` documents are still t3's (acceptance step 2b's two assertions), so drift in Access is
    caught at the next deploy, not only by an acceptance run. Those two requests are t3's, so the smoke check now boots
    t3 in the Environment DO (still no Container); before, it booted nothing. So a deploy whose t3 does not boot can,
    through the smoke check's retries, put the Environment in safe mode after three failed boots in a row
    (`SAFE_MODE_AFTER_FAILURES`, `host/bootState.ts`), as the owner's first use after that deploy would have; the
    owner turns it off on the admin routes once a fixed deploy is out.
29. **Asked changes opened are capped at 6 per caller per hour, whatever their outcome** (D16; SPI-1195 review): a
    change withdrawn by a Stop, a cancelled card or a cut stream neither strikes nor applies, so nothing else bounded
    an agent asking and dropping. Refused naming the Harness panel, for each door (own thread, Owner `sub`).

## Evidence

Only M0's files exist on this branch, copied from the spike branch. Every other file is owed from a stage run.

| Milestone | File | How | State |
| --- | --- | --- | --- |
| M0 | `m0-access-oauth.json`, `m0-clients.json`, `m0-pi.json` | the spike's probes on `psettings` | **done** (on the spike branch, 41b823a; copied here unchanged) |
| M1 | `m1-panel-safety.json` | [`m1-stage-run.md`](settings-mcp/m1-stage-run.md): `scripts/tools.ts panel` re-run, written as `m1-…`: the panel behaves as before, with `expectedRevision` and the set-header route, and answers on a cold DO | **owed** |
| M2 | `m2-cli-pi.json` | `scripts/tools.ts cli-mcp` with pi: pi lists and calls Commissary and a Direct server through the relay in every runtime mode; T-pi-2 (a repository's `.pi/mcp.json` naming `settings` at another URL changes nothing, and nothing reaches that URL); a relay read with no ask from t3's extension (the Patch) | **owed** |
| M3 | `m3-settings-own.json`, `m3-settings-cli-{codex,claude,opencode,pi}.json` | a Durable thread and each CLI read and make a free change; plan, linked and unknown-thread refusals hold | **owed** |
| M4 | `m4-settings-asked.json`, `m4-change-page-safety.json` | [`m4-stage-run.md`](settings-mcp/m4-stage-run.md) | **owed** |
| M5a | `m5a-settings-owner-browser.json` | [`m5a-stage-run.md`](settings-mcp/m5a-stage-run.md); items 1-4 are owner step 1 and gate layout (B) | **owed** |
| M5b | `m5b-settings-owner-modes.json` | [`m5b-stage-run.md`](settings-mcp/m5b-stage-run.md); the owner at the keyboard | **owed** |
| M6 | `m6-settings-hostile.json` | [`m6-stage-run.md`](settings-mcp/m6-stage-run.md) | **owed** |

No stage harness for M1-M6 was written on this branch; the run that produces these files writes it (`scripts/tools.ts`
and `scripts/spi1079.ts` are the patterns). `pnpm run check` passes at the PR's head.

<!-- Placeholder: when the runs are done, put each file's commit and verdicts in the State column, and add any
failure to "Deviations from the plan". -->

## Owner steps still open

From [`settings-mcp-m0-owner-steps.md`](settings-mcp-m0-owner-steps.md) (copied from the spike branch, where its
commands run):

1. **Step 1, the OAuth flow end to end** (P6, P7, P12, P13, P15, P11 in part). **Gates layout (B)**: an Owner client's
   OAuth token must be refused at `/_t3flare/harness` and `/_t3flare/echo`, and the token exchange must work for the
   path `resource`. If either fails, ADR-0035 is superseded by one for layout (C). It also decides the page's answerer
   check (`sub`, or the email if `sub` differs across applications, P13). Taken over by M5a items 1-4. Prod gets the
   endpoint only after it passes (`OWNER_ENDPOINT_EXCLUDED_STAGES`).
2. **Step 2, Cursor**: confirms the `redirect_uri` Cursor registers. If it is neither
   `cursor://anysphere.cursor-mcp/oauth/callback` nor a `localhost` one, change `SETTINGS_OAUTH_REDIRECT_URIS` (one
   constant) and ADR-0035. M5a item 4b.
3. Step 3, Claude Code's Accept and "I'm done, continue" by hand (neither submitted from a scripted terminal): refines
   M5b items 2 and 7.
4. Step 4, Codex's tool calls (M0 had no model key for Codex): refines D12's holds for Codex.
5. Step 5, a real browser's two `CF_Authorization` cookies: confirms P8 only.

## How to connect an Owner client

The endpoint is `https://<host>/_t3flare/mcp`: on a stage, `settingsMcpUrl` in its credentials file; on prod
`https://t3.ianpascoe.dev/_t3flare/mcp`, once prod is enabled after owner step 1 (until then it answers 404). Add
`?elicitation_mode=browser|native|model` to choose who answers an asked change; without it the mode is `browser`. The
first call sends the client to sign in through Access (dynamic registration, a `localhost` or loopback redirect) as the
owner. For example:

- Claude Code: `claude mcp add --transport http t3flare-settings 'https://<host>/_t3flare/mcp?elicitation_mode=browser'`
- Codex: `codex mcp add t3flare-settings --url 'https://<host>/_t3flare/mcp'`
- pi: an entry in its `mcp.json`, `{ "mcpServers": { "t3flare-settings": { "url": "https://<host>/_t3flare/mcp" } } }`.
  pi declares no elicitation, so every asked change answers with the Change page's link.
- OpenCode: `"mcp": { "t3flare-settings": { "type": "remote", "url": "https://<host>/_t3flare/mcp" } }` in its config.
  Under `permission: allow` OpenCode accepts an empty form by itself (M0), so `native` there answers without a person.
- Cursor: a server with the URL in its MCP settings, after owner step 2.

What each mode means is ADR-0034 §8, and its first consequence: `native` and `model` do not prove the owner answered.
To cut every client off at once, set the Settings server off or read-only on the Harness panel; to cut one off, revoke
its grant in the Access dashboard.

## Docs

- With the plan and through the milestones: ADR-0034; ADR-0035 (layout (B), conditional); refinements of ADR-0001
  (Patch 0006), ADR-0010 (two Access applications), ADR-0026 (agents' changes; and, from the SPI-1201 review, the
  SPI-1200 refinement that flags `SettingsAccess` as contradicting its §1 and "Back to stock", one Access
  application), ADR-0028, ADR-0032 and ADR-0033; `GLOSSARY.md` (Settings server, Door, Owner client, Settings change,
  Change tier, Open change, Change page, Elicitation mode, Guardian, Guard, and the MCP server, Direct server, Pause
  and Pausing server entries); `docs/steps/tools.md`'s stale pi lines; `docs/upstream-fragility.md` U66-U69.
- At M6: ADR-0034's status; both research files' "M0's answers"; `docs/parity.md` and `docs/pi-parity.md` (the pi
  CLI's relay servers, the Settings server); `README.md`'s pi line; `m4-stage-run.md` items 6 and 10.
- At the SPI-1195 review: ADR-0035, ADR-0010's refinement, the plan (D13, D16, §10), U68 and `m5a-stage-run.md` (prod
  excluded until owner step 1; `scripts/smoke.ts` as the detection; U68's dependence on Access's `sub`);
  `m1-stage-run.md`; M0's evidence copied here; ADR-0001's Patch 0006 entry; ADR-0034's consequences.
