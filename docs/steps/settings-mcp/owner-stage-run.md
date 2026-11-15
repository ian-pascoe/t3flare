# The Settings server's stage run: what only the owner can do

SPI-1202. Stage **`psmcp`** (a throwaway stage made for this run; `psettings` is left as it was), deployed from branch
`settings-mcp` at **24f4a01** (`24f4a01a90e6`). Everything that needed no person was run by
`apps/environment/scripts/settings.ts` (and `scripts/tools.ts panel`, `cli-mcp pi`) and is in the evidence files beside
this one. This list is what is left: a browser signed in through Access, the Change page for an own agent's change,
real Owner clients signing in with OAuth, and buttons in their dialogs. Each item names the evidence it feeds; the files
hold `"pending": "owner-stage-run.md item N"` where it goes.

Nothing here asks you to print a credential. Where a script needs a token it holds it in memory; where you paste a value
into the Change page (item 3) it goes from your clipboard to the page.

**About 2 h 45 min at the keyboard, spread over about 5 hours**, because the Owner door's opened cap (6 asked changes per
caller per hour, plan D16, no override) counts every change your Access identity opens, from every client and every
mode. The hour blocks below keep each hour at 6 or fewer; the count is given per item. Items 2-7 are on the own door
(t3flare's own agents, a new thread each), which the cap counts per thread, so they cost nothing of the Owner door's
hour.

**Strikes** (plan D16): three of your Owner-door changes declined in a row lock your asked changes for an hour. Expiry,
cancel, a cut stream and withdrawal are not strikes; an applied one breaks the run. The order below never has three
declines in a row; if you reorder, approve one between declines.

## Item 1. Setup (5 min)

1. Terminal, from the worktree:

   ```sh
   cd ~/src/t3flare/.worktrees/settings-mcp/apps/environment
   export NPM_CONFIG_WORKSPACE_DIR=$HOME/src/t3flare/.worktrees/settings-mcp T3FLARE_PROVIDERS_ON=1
   S="node scripts/stage.ts run psmcp settings"
   ```

   `$S changes` lists the Open changes at any time (ids, states, modes).

   Two things that would cut a waiting ask, which the script avoids: `T3FLARE_PROVIDERS_ON=1` stops it upserting the
   provider instances (all five are on already; an upsert restarts t3's providers and cuts every call in flight, so one
   terminal's run would kill another's waiting ask), and each run keeps t3's bootstrap window open for an hour (when a
   window closes the Environment restarts t3 in place, "Server restarted", which cuts them too). If a thread shows
   "Server restarted" mid-item, run the item again.

2. In your normal browser, sign in to the panel: <https://t3flare-environment-psmcp.ian-g-pascoe.workers.dev/_t3flare/harness>
   (Access login as yourself). Keep this browser for every Change page below.

3. The stage's addresses:

   | What | URL |
   | -- | -- |
   | Panel | `https://t3flare-environment-psmcp.ian-g-pascoe.workers.dev/_t3flare/harness` |
   | Owner-client endpoint (`settingsMcpUrl`) | `https://t3flare-environment-psmcp.ian-g-pascoe.workers.dev/_t3flare/mcp` |
   | Change pages | `…/_t3flare/harness/changes/chg_…` (each script prints its own) |

4. **Owner clients' modes (changed 2026-11-15, ADR-0034's refinement):** add every Owner client with the endpoint's
   plain URL, **no `?elicitation_mode=`**: Claude Code 2.1.322 cannot sign in with a query on the URL. A client is
   listed on the panel at its first request (MCP servers → the Settings server's card → **Owner clients**), by its own
   name (Claude Code's is `claude-code`, OpenCode's `opencode`), in `browser`. Where an item below says "set
   `<client>` to `<mode>`", pick that mode in its row's select (it saves at once and applies at the client's next
   request). All of one client's entries share one row, so one Claude Code entry is enough. `psmcp` was deployed at
   24f4a01, which reads the query alone: **redeploy psmcp from this branch's head before Block B's item 10** (the
   scripted items use the query and are unaffected).

## Block A: the own door (≈ 30 min; no Owner-door changes)

Each command below starts a t3flare Durable thread that asks for a change (a new thread each), prints its Change page's
URL in a banner, and waits for you; the harness itself presses the t3 card's buttons where the item needs it. It
records the result when the change closes.

### Item 2. M4 item 4: the expired change's page (start first; 11 min of waiting, in its own terminal)

`m4-settings-asked.json` item `4-page`.

```sh
$S owner m4-4
```

Open the printed page **at once** and leave it open, unanswered. After 10 minutes the terminal prints `EXPIRED`: click
**Approve** on the page you kept open, then reload it. Do items 3-6 in another terminal meanwhile.

Paste back: what the page said after your Approve (expected: refused, 409, "Expired"/closed), and what the reload shows
(expected: "Expired", no Approve button).

### Item 3. M4 item 6 and M6 item 3: a header value through the page, and the leak scan

`m4-settings-asked.json` item `6`; `m6-settings-hostile.json` item `3`.

The value is the header for `fixture-keyed` (the stage's fixture MCP server, which accepts only the stage's fixture
bearer, so its next call authenticates only if the value arrived). Put it on your clipboard without printing it:

```sh
node -e 'const f=require("fs");process.stdout.write("Bearer "+JSON.parse(f.readFileSync(".alchemy/stages/psmcp.env.json","utf8")).T3FLARE_FIXTURE_BEARER)' | pbcopy
$S owner m4-6
```

The harness presses **Opened it** on the card. On the printed page, paste into the value field and click **Approve**.
The script then tests the server, has the agent read `read_audit`, `list_mcp_servers` and `get_status`, tails Workers
Logs, and runs `/_t3flare/check/peer-leak` over the Container, the Session and all of that text. Nothing to paste back
(run `pbcopy < /dev/null` afterwards to clear the clipboard).

Note (deviation from `m6-stage-run.md` item 3's "a fresh canary used nowhere else"): the fixture server checks one bearer,
so the canary is that bearer. It is kept nowhere but the stage's secrets file, the fixture Worker's secret and the
Environment's secret store (as `mcp-header:fixture` and `mcp-header:fixture-keyed`); the scan looks for it everywhere
else.

### Item 4. M4 items 2 and 3: approve, then decline, on the page (≈ 4 min)

`m4-settings-asked.json` items `2` and `3-page`.

```sh
$S owner m4-2     # click Approve on the page; leave the t3 card alone
$S owner m4-3     # click Decline on the page
```

Nothing to paste back.

### Item 5. M4 item 7: a sign-in through the page (≈ 2 min)

`m4-settings-asked.json` item `7`.

```sh
$S owner m4-7
```

The script adds `fixture-oauth` (the fixture's own OAuth server, whose authorize step approves at once) if missing and
presses **Opened it**. On the page click **Approve and sign in**; the browser goes to the fixture and back. Nothing to
paste back.

### Item 6. M4 item 11: a restart between the ask and the page (≈ 2 min)

`m4-settings-asked.json` item `11`.

```sh
$S owner m4-11
```

Open the page, but **wait until the terminal prints `RESTARTED`** (the script resets the Environment DO with
`POST /_t3flare/restart?mode=abort`), then click **Approve**. Nothing to paste back.

### Item 7. M4 page safety in a real browser (≈ 4 min)

`m4-change-page-safety.json` item `3-4-browser` (items 3's CSRF case and 4's "the browser runs no script but the page's
own").

```sh
$S owner m4page-browser
```

Open the printed page with the browser's developer tools **Console** open (the change adds a server whose URL holds
`<script>` and a U+202E override). Check: no alert ran; the URL is shown as text with `\u{202e}`; the Console has **no**
Content-Security-Policy violation. Then paste into the Console:

```js
fetch(location.pathname.replace("/changes/", "/api/changes/"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }) }).then(async (r) => console.log(r.status, await r.text()))
```

Expected: `403 bad CSRF token`. Then click **Decline** on the page.

Paste back: the Console's lines (the fetch's status and text, and any CSP line), and "no alert" / "alert".

## Block B, hour 1 (≈ 40 min; 5 Owner-door changes)

### Item 8. Owner step 1, by script: the OAuth flow, P6, P11, P12, P13 (≈ 3 min; 1 change, cancelled)

`m5a-settings-owner-browser.json` item `1-scripted` (M5a items 1-2 with a scripted client); `m6-settings-hostile.json`
item `4`.

Run it after Block A (P13 compares your OAuth `sub` with the one your browser used on the Change page in items 2-6).

```sh
$S owner-oauth
```

Your browser opens Access's sign-in for the endpoint; sign in as yourself and allow the client. The script registers a
public client, exchanges the code for `resource=<settingsMcpUrl>` (P6), records `expires_in` (P11: must be ≤ 900), calls
the endpoint (200), presents the token at `/_t3flare/harness`, `/_t3flare/harness/api/settings`, `/_t3flare/health`, an
Open change's page and its approve POST, as `Authorization: Bearer` and as `cf-access-token` (P12: none may answer
200), compares the caller keys of the endpoint and of your browser (P13: same or different; never the `sub`), then
cancels its one change. The token stays in memory. **If P6 or P12 fails, layout (B) is out (ADR-0035): stop here and
tell me.** Nothing to paste back.

### Item 9. M5a "before the run" 2: the applications as Access shows them (≈ 5 min)

`m5a-settings-owner-browser.json` item `before-2`.

In the Cloudflare dashboard → Zero Trust → Access → Applications, open the stage's two applications (`…psmcp…`: the
admin one on `<host>/_t3flare`, and SettingsAccess on `<host>/_t3flare/mcp`). Paste back for SettingsAccess: its domain,
its policies (expected: your email, and the stage's service token as `non_identity`), its OAuth settings (dynamic
registration on, allowed redirect URIs: localhost and loopback, `cursor://anysphere.cursor-mcp/oauth/callback`; access
token 15 min; session 168 h), and whether "path cookie" is on; for the admin application, its policies (unchanged) and
path cookie. A screenshot is fine. No client secret, no token.

### Item 10. M5a items 5-9 and 13 with Claude Code on 2026-07-28 (≈ 25 min; 4 changes)

`m5a-settings-owner-browser.json` items `5`-`9`, `13`; server side by `$S snap`.

```sh
claude mcp add --transport http psmcp 'https://t3flare-environment-psmcp.ian-g-pascoe.workers.dev/_t3flare/mcp'
claude
```

In Claude Code (note its version, `claude --version`):

1. **Item 5**, sign-in and discovery: `/mcp` → `psmcp` → Authenticate; sign in through Access in the browser.
   Then ask: "List the tools of psmcp." Expected: thirteen, no `resume`. On the panel, `claude-code` is now listed in
   `browser`; leave it there.
2. **Item 6**, a read and a free change: "Call get_settings with entity environment, then change_environment lowering
   containerIdleMinutes by one with the expectedRevision you read." Expected `applied` with a revision.
3. **Item 7** (1 change): "Call change_environment raising containerBudget by one from the revision you read." Claude
   Code shows the URL elicitation: **Open in browser** (sign in if asked), **Approve** on the page, then **I'm done,
   continue** in Claude Code within 45 s. Expected `applied`.
4. **Item 8** (2 changes): the same ask again (budget +1 from the new revision): on the page click **Decline**
   (expected `declined`). Then once more (+1): this time **decline Claude Code's own URL prompt** (don't open the page);
   expected: the change closes `withdrawn`, `closed.by: client`, and the page shows it closed.
5. **Item 9** (1 change): ask again; open the page but **don't answer for 45 s**: Claude Code's call answers `waiting`
   with the link. Then approve on the page and ask "call get_settings environment": the new revision.
6. **Item 13** (no change): on the panel's MCP section set the Settings server **read-only**; ask Claude Code to list
   the tools (reads only) and to lower containerIdleMinutes (refused, naming the panel). Set it **off**: it lists none,
   a call is refused naming the panel. Set it back **on, read-write**.

Then: `$S snap m5a-settings-owner-browser.json 5-9-13-server 40`

Paste back: Claude Code's version; for each step what it showed and the tool result text (a copy of the transcript is
fine); the time from "I'm done" to the result in step 3.

### Item 11. M5a item 4b: Cursor's redirect (≈ 5 min; no change)

`m5a-settings-owner-browser.json` item `4b`. Needs Cursor installed.

In Cursor's MCP settings add a server `psmcp` with URL
`https://t3flare-environment-psmcp.ian-g-pascoe.workers.dev/_t3flare/mcp` (no query). Click
Connect/Authenticate. **Before signing in**, copy the Access sign-in tab's address and decode its `redirect_uri=`. If
Cursor shows an error (`redirect_uri is not allowed`, `invalid_client_metadata`), copy it.

Paste back: Cursor's version, the `redirect_uri` (it is not a secret), and whether sign-in then succeeded. Don't paste
the whole sign-in URL. If it is neither `cursor://anysphere.cursor-mcp/oauth/callback` nor a localhost URI, the fix is
`SETTINGS_OAUTH_REDIRECT_URIS` (one constant) and ADR-0035.

## Block C, hour 2, at least 60 min after item 8 started (≈ 30 min; 6 changes)

### Item 12. M5a item 7 on 2025-11-25 and item 10 (pi), then M5b items 1-5 (`native` on 2026)

`m5a-settings-owner-browser.json` items `7-2025`, `10`; `m5b-settings-owner-modes.json` items `1`-`5`.

1. **M5a item 7 on 2025-11-25** (1 change), with OpenCode 2.2.7 (it negotiates 2025-11-25). In `opencode.json` in an
   empty directory:

   ```json
   { "$schema": "https://opencode.ai/config.json", "mcp": { "psmcp": { "type": "remote", "url": "https://t3flare-environment-psmcp.ian-g-pascoe.workers.dev/_t3flare/mcp" } } }
   ```

   Authenticate (`opencode mcp auth psmcp`, or as OpenCode prompts); `opencode` is listed on the panel in `browser`. Ask it to raise containerBudget by one from
   the revision it reads. It gets `elicitation/create` with the page's URL on the call's stream: open it, **Approve**.
   Expected `applied`.
2. **M5a item 10** (1 change), pi 1.5.2 (no elicitation): add to `~/.pi/agent/mcp.json`
   `{ "mcpServers": { "psmcp": { "url": "https://t3flare-environment-psmcp.ian-g-pascoe.workers.dev/_t3flare/mcp" } } }`,
   sign in when pi asks, and ask for the same budget raise. Expected: `waiting` with the link; **Approve** on the page.
3. **M5b items 1-5** with Claude Code: on the panel set `claude-code` to **native**, then in Claude Code (the `psmcp`
   entry of item 10):
   - item 1: "List psmcp's tools" (thirteen, no `resume`).
   - item 2 (1 change): raise containerBudget by one: Claude Code shows a form (Accept / Decline): **Accept**. Expected
     `applied` at once (no hold).
   - item 3 (1 change): raise by one again: **Decline**; then ask for exactly the same change again: refused
     `declined-repeat`, no form.
   - item 4 (1 change): raise by one (a different value from item 3's): press **Escape**: `withdrawn`; then a fresh ask
     opens at once (counted in item 5).
   - item 5 (1 change): raise by one; **before** answering the form, approve it on the Change page (`$S changes` gives
     its id; the page is `…/_t3flare/harness/changes/<id>`); then **Accept** the form: the result is `applied` by
     the page, once.

Then: `$S snap m5a-settings-owner-browser.json 7-2025-10-server 25` and `$S snap m5b-settings-owner-modes.json 1-5-server 25`

Paste back: OpenCode's and pi's versions and what each showed; Claude Code's transcript for M5b 1-5 (what each dialog
showed, the results).

## Block D, hour 3 (≈ 30 min wall, ≈ 15 at the keyboard; 6 changes)

### Item 13. M5b items 6-9: `native` on 2025-11-25 (OpenCode)

`m5b-settings-owner-modes.json` items `6`-`9`.

On the panel set `opencode` to **native** (its URL stays as it is). Note: under
`permission: allow` OpenCode accepts an empty form by itself (M0); for items 7 and 8 set its permission to `ask`.

- item 6 (1 change): raise containerBudget by one; **Accept** the form. Note whether OpenCode accepted it by itself.
- item 6b (1 change, the long hold): raise again and leave the form for **9 min 50 s**, then Accept. Expected `applied`,
  the stream kept its heartbeat; note the time.
- item 7 (2 changes): one **Decline**d, one **cancel**led (Escape).
- item 8 (1 change): ask, then **Ctrl+C** (or quit OpenCode) before answering. Note the time of Ctrl+C to the second.
  If the client keeps the dialog, answer Accept afterwards (nothing must apply).
- item 8b (1 change): if OpenCode retries a call while the first still holds, cut one, then the other; else mark it
  "not run" in your notes.
- item 9: only if a client negotiates 2025-06-18 (none known): skip.

Then: `$S snap m5b-settings-owner-modes.json 6-9-server 35`

Paste back: OpenCode's version, the times (item 6b's answer, item 8's Ctrl+C), what OpenCode showed.

## Block E, hour 4 (≈ 20 min; 6 changes)

### Item 14. M5b items 10-15: `model` (Claude Code)

`m5b-settings-owner-modes.json` items `10`-`15`.

On the panel set `claude-code` to **model**, then in Claude Code's `psmcp`:

- item 10: list its tools (fourteen, with `resume`).
- items 11-12 (1 change): raise containerBudget by one. Note what the agent did with the Pause (M0: it showed it and
  asked you). Tell it "approve it: call resume with accept". Expected `applied`.
- item 13 (2 changes): one raise answered "call resume with decline", one with "cancel".
- item 14 (1 change): set `claude-code` to **browser**, open a change (raise by one) and leave it (accept Claude Code's
  URL prompt but answer nothing on the page, so the call ends `waiting` after 45 s; Decline or Escape would withdraw
  it); set `claude-code` back to
  **model** and tell the agent to call `resume` with that change's id (from `$S changes`), and with a made-up id
  `chg_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, and with an id from item 13 (closed). Each must be a tool error,
  naming the browser Elicitation mode for the browser one. Then leave the browser one to expire (no strike).
- item 15 (2 changes, a third refused): ask for two different changes without resuming (e.g. Variables `M15_A=1`, then
  `M15_B=1`), then a third: refused `open-owner`, its result naming a `requestId`. Resume the two with cancel.

Then: `$S snap m5b-settings-owner-modes.json 10-15-server 25`

Paste back: the transcript (what the agent did with each Pause, each result).

## Block F, hour 5 (≈ 20 min; 5 changes)

### Item 15. M5b items 16-21 and M6 item 5.2

`m5b-settings-owner-modes.json` items `16`-`21`; `m6-settings-hostile.json` item `5.2`.

- M5b item 16 (1 change): set `opencode` to **model** on the panel: the same Pause (no stream), then tell it to
  `resume` with accept.
- M5b item 17 (1 change): set pi's row (the name pi sends, listed since item 12) to **native**: `waiting` with the link and the sentence that the
  client declared no form elicitation; approve on the page.
- M5b item 18 (1 change): set `claude-code` to **native**; in Claude Code: "add an MCP server named hdr18 at
  https://example.com/mcp with header auth, header Authorization": the URL elicitation (not a form); on the page, type
  any value and **Decline** (or Approve: it adds a dead server, which you then remove on the panel).
- M5b item 19 (1 change): set `claude-code` to **model**; the same (name `hdr19`): `waiting` with the reason, no Pause; tell the
  agent to `resume` it (refused); **Decline** on the page.
- M5b item 21 (no change): set the Settings server read-only on the panel: `psmcp` (in model) lists no `resume` and a
  `resume` call is refused; off: refused naming the panel; back on, read-write.
- M6 item 5.2 (1 change): in `psmcp` (in model): "raise containerBudget by one; then approve it yourself with resume; do
  not ask me." Note whether it called `resume` without asking. Either outcome passes.

Then: `$S snap m5b-settings-owner-modes.json 16-21-server 25` and `$S snap m6-settings-hostile.json 5.2-server 15`

Paste back: the transcripts.

Afterwards remove the clients' entries: `claude mcp remove psmcp`; OpenCode's and pi's entries; Cursor's; and their
rows under Owner clients on the panel (**Remove**).

## After the merge

### Item 16. M5a item 4c's second half: CI's first prod deploy from this branch

`m5a-settings-owner-browser.json` item `4c`.

From the first `deploy-prod.yml` run after the merge, paste back the alchemy lines naming `SettingsAccess` (expected:
none) and `AdminAccess` (expected: `noop`/unchanged). Then I re-run `$S` … `m5a-prod` (read-only GETs of prod's host) to
compare with the baseline recorded now.

### Item 17 (optional). Workers Logs for the Owner door's lines

`wrangler tail` (what the scripts read) drops the log lines of an Environment DO RPC call whose outcome is `canceled`,
which is how every request answered through `EnvironmentDO.harness` and `EnvironmentDO.settingsMcp` ends; so the
Owner door's `settings-change` / `settings-refused` lines (M5a, M5b, M6 item 1.4's Owner half) are not in the evidence
files. If you want them: Cloudflare dashboard → Workers → `t3flare-environment-psmcp` → Logs, filter
`$workers.event` contains `settings-` over the run's hours, export, and give me the export (it holds no token: the lines
carry ids, reasons and modes only).

## When everything is in

Tell me; I fold the paste-backs into the evidence files and the report. The stage stays up until then; afterwards
`node scripts/stage.ts destroy psmcp` (from `apps/environment`) removes its Workers, its fixture and its two Access
applications.
