# M4 (SPI-1199): what the stage run must record

M4's code and unit tests (T-open, T-card, T-page) landed without a deploy. Its two evidence files need a deployed stage
(`psettings`, or any throwaway stage from `apps/environment/scripts/stage.ts`; never `prod`). Record each item below with
the commit deployed, the stage, timestamps, and the thread, change and card ids. Never record a header value, an
authorization URL, a token or a cookie; record a secret's presence as `{ set, setAt }` only.

**Stay under the opened cap** (plan D16, `OPENED_CAP`): a caller opens at most 6 asked changes an hour, whatever became
of them (declined, withdrawn, expired and applied all count), and the own door counts per thread. Run each item below on
a new thread, so no thread opens more than six (items 3 and 9 open three each). A seventh in a thread's hour is refused
`opened-cap` with no card, which is not what these items record. The cap has no test-only override, and none may be
added; `m6-stage-run.md` item 1.4 records the cap itself.

## `m4-settings-asked.json`

An own agent's asked change, end to end, for a Durable thread and for at least one CLI thread (Codex), in
`approval-required` and in `full-access` (an asked change asks in both):

1. **Approved by card**: `change_environment` raising `containerBudget`. The card is an `approval` card (no field) with
   the server-written prompt and the Change page's link; Approve applies it. Record the tool result
   (`status: applied`, `revision`, `changeId`), the audit entry (`via: mcp`, `tier: asked`, `mode: card`,
   `answeredBy: card`, `change`), and the `settings-change` log lines (`open`, then `applied`).
2. **Approved by page**: the same kind of change answered on the Change page while the card is open. Record the card
   closing as withdrawn (t3 shows it cancelled), the tool result naming the Change page, and `answeredBy: page`.
3. **Declined** on the card and on the page: `status: declined`, no revision moved; the same call again within 10 minutes
   is refused (`declined-repeat`).
4. **Expired**: no answer for 10 minutes; `status: expired`; the page then shows "Expired" and its POST answers 409.
5. **Moved**: two threads each ask a change against one revision; approving the first applies, approving the second
   closes it `moved` with the new revision and applies nothing.
6. **A secret through the page**: `change_mcp` `{ op: "header-value" }` on a header Direct server; the card offers only
   "Opened it" / Decline / Cancel; the value typed on the page reaches the server (its next call authenticates), and a
   leak scan (`/_t3flare/check/peer-leak`) finds it in no audit entry, log line, Open change row or tool result. The
   scan reads the Container and the Sessions itself; the rest goes in its `text` (Workers Logs, the panel's
   `/api/audit` and `/api/changes`, the tool results), as `m6-stage-run.md` item 3 does.
7. **A sign-in through the page**: `start_mcp_sign_in` on an OAuth Direct server; "Approve and sign in" sends the browser
   to the authorization server, the sign-in completes, and the agent's result and the logs carry no authorization URL.
8. **The panel's list**: the Open changes section and `GET /_t3flare/harness/api/changes` list an open change with its
   thread and link; `get_status.openChanges` lists it for its own thread only.
9. **Caps**: a second asked call on a thread with one open is refused naming the open one; three in a row declined or
   expired lock the thread's asked changes for an hour.
10. **A Stop**: interrupting the turn while the card is open withdraws the Open change (`closed.by: stop`; `agent` is
    model-mode `resume`'s alone, SPI-1199 review) and the card; also after "Opened it" on a change that needs the page.
11. **Restart**: the Environment idles out (or is restarted) between the ask and the page's Approve; the page still
    applies it (the record is in SQLite).

## `m4-change-page-safety.json`

1. The page's response headers: the hash-only CSP (`script-src 'sha256-…'` equal to the deployed `CHANGE_SCRIPT`'s hash,
   no `'self'` or `unsafe-inline`), `x-frame-options: DENY`, `cache-control: no-store`, `referrer-policy: no-referrer`.
2. Without Access (no cookie, a curl from outside): the page and its API get Access's login, never the page.
3. The POST refused (403) with a wrong `Origin`, with `Sec-Fetch-Site: cross-site`, without the CSRF token, and as a form
   post (`Content-Type` other than JSON); a GET to the POST's path is 404. The service token with the admin token cannot
   approve an own agent's change (403).
4. A hostile change rendered inert: an agent asks to add a server whose URL path holds `<script>` and a bidi override
   (U+202E), and to set a Variable whose value holds the same; the page shows them escaped and the override as
   `\u{202e}`, and the browser runs no script but the page's own (a CSP report shows none refused).
5. A closed and an unknown change id: the closed one shows its outcome without Approve; the unknown one is "gone" (404).
