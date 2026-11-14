# M5b (SPI-1201): what the stage run must record

M5b's code and unit tests (T-modes' `native` and `model` cases and every fallback of D12's table,
`apps/environment/test/settingsModes.test.ts`) landed without a deploy. Its evidence, `m5b-settings-owner-modes.json`,
needs a deployed workers.dev stage (`psettings`; never `prod`) on which M5a's run passed (`m5a-stage-run.md`: layout
(B) confirmed, the owner signed in), and the owner at the keyboard: an Accept in a client's form is his to press (M0:
a scripted terminal could not submit Claude Code's dialogs). Record each item with the commit deployed, the stage,
timestamps, the client and its version, the protocol version it negotiated, the query it was configured with, and the
change ids. Never record a token, a cookie, an authorization code or a header value.

For each change, record from the server's side: the Open change's `mode`, `state` and `closed.by` (the panel's Open
changes list, then `read_audit` or the Change page once closed), the audit entry (`via: mcp`, `tier: asked`, `mode`,
`answeredBy`, `change`) and the `settings-change` / `settings-refused` log lines. From the client's side: what it
showed (a screenshot or its transcript) and the tool result it got (`structuredContent`).

## Before the run

1. `node scripts/stage.ts deploy psettings` (from `apps/environment`) at M5b's commit. Record the deployed commit.
2. Read `get_settings` (environment) and note `containerBudget` and the revision; every asked change below raises
   `containerBudget` by one from the revision just read (each needs its own `expectedRevision`).

## `m5b-settings-owner-modes.json`

### `native` on 2026-07-28 (Claude Code 2.1.322, `<settingsMcpUrl>?elicitation_mode=native`)

1. **Discovery**: `server/discover` and `tools/list` list the thirteen tools and no `resume`; the instructions carry the
   `native` sentence.
2. **Accept**: an asked change. Record the `input_required` result's shape (`mode: "form"`, `requestedSchema` with no
   properties, `requestState` as "present"), what Claude Code showed (expected: Accept / Decline), the retry's
   `inputResponses.change.action: "accept"`, and the result `applied` with the revision. Audit: `mode: native`,
   `answeredBy: client`. The call must not have held (record its duration).
3. **Decline**: the same with Decline: result `declined`, `closed.by: client`; then the same change again is refused
   `declined-repeat`.
4. **Escape (cancel)**: result `withdrawn`, `closed.by: client`, no strike (a fresh change opens right after).
5. **The page first**: an asked change, then approve it on the Change page before answering the form; then Accept:
   the result is `applied` by `page` (the page's answer won), and nothing applies twice (one audit entry).

### `native` on a 2025 version (OpenCode 2.2.7 at 2025-11-25, or Claude Code forced to 2025-11-25)

6. **Accept on the held stream**: the response to `tools/call` is `text/event-stream` with `elicitation/create`
   (`mode: "form"`, no `elicitationId`); the client's answer arrives as its own POST (answered 202, no body); the stream
   then carries the result `applied`. Record heartbeat lines seen while it held (progress with OpenCode's
   `progressToken`, or `: waiting for the form's answer`). Note: OpenCode under `permission: allow` accepts the empty
   form itself (M0); record whether it did here, since that is ADR-0034's accepted risk made visible.
   - **The Environment stays alive for a long hold**: once more, answering only after 10 minutes less a few seconds
     (the change's whole life; with a client whose timeout allows it, or Claude Code, which backgrounds the call).
     Record that the stream kept its heartbeat to the end, that no `settings-refused` line with `no-live-stream`
     appeared (the Environment DO did not reset under the stream: an idle reset would end it, ADR-0003, plan D17's
     `Idle.requestStarted`), and that the answer applied. If the DO reset mid-hold, the accept is withdrawn by `stop`
     (SPI-1201 review): record that instead, with the time the stream ended.
7. **Decline** and **cancel** on the held stream: `declined` and `withdrawn`, `closed.by: client`.
8. **A cut stream**: start an asked change and end the call from the client (Ctrl+C, or quit the client) before
   answering. Record that the change closes `withdrawn` with `closed.by: stop` and its one `settings-refused` log line
   carrying `cut: true`; then answer the still-open dialog if the client keeps it (Claude Code did in M0): the POST is
   202 and nothing applies (revision unchanged). **The cut must reach the Environment DO**: record the time from the
   client's Ctrl+C to the close's log line (seconds, not the change's 10 minutes). If the change stays open until it
   expires, Cloudflare did not pass the client's disconnect through the Worker's RPC to the DO's stream: record it as a
   failure for `docs/upstream-fragility.md` and the report.
   - Two calls on the same change (the client retried while the first still held): cutting one leaves the other's
     question standing (no close line), and cutting both withdraws it once (SPI-1201 review).
9. **2025-06-18** (if a named client negotiates it): the `elicitation/create` params have no `mode` key, and the client
   shows the form.

### `model` (Claude Code 2.1.322 at 2026-07-28; then a 2025 client, `?elicitation_mode=model`)

10. **Discovery**: `tools/list` has fourteen tools including `resume` (input `requestId`, `response.action`).
11. **The Pause**: an asked change answers at once (no `input_required`, no stream) with `structuredContent`
    `{ status: "approval-required", requestId, elicitation: { mode: "form", message, requestedSchema }, expiresAt }`,
    the message ending with the Change page's URL. Record what Claude Code's agent did (M0: it showed the change and
    asked the user, and did not call `resume` itself).
12. **resume accept**: the owner tells the agent to approve; it calls `resume` with `accept`. Result `applied`; audit
    `mode: model`, `answeredBy: agent`. This is plan §5's hostile line "in `model`, an agent approving its own change is
    applied and audited with `answeredBy: "agent"`" as well (M6 records it again from a script).
13. **resume decline** and **resume cancel**: `declined` and `withdrawn`, `closed.by: agent`.
14. **Refusals**: `resume` with an expired id (wait 10 minutes, or use one from an earlier run), with a made-up id, and
    with the id of a change the same client opened in `browser` (open it from a second configuration of the client
    without the query): each is a tool error and applies nothing; the browser one names `elicitation_mode=browser`.
15. **The cap names the requestId**: with two model-mode changes open, a third is refused `open-owner` and its result
    names a `requestId` to resume.
16. **A 2025 client in `model`**: the same Pause from a client at 2025-11-25 (no stream), and `resume` works.

### D12's fallbacks

17. **`native` without form elicitation**: pi 1.5.2 (roots only) with `?elicitation_mode=native` makes an asked change:
    the result is `waiting` with the link and the sentence that the client declared no form elicitation; the change is
    `browser`-mode and the page applies it.
18. **A change that needs the page, in `native`**: `change_mcp` `add` with `auth: header` from Claude Code with
    `?elicitation_mode=native`: the client shows the URL elicitation (not a form); the change is `browser`-mode with
    `needsPage: secret`; the page takes the header value and applies it.
19. **A change that needs the page, in `model`**: the same from `?elicitation_mode=model`: the result is `waiting` with
    the link and the reason (no Pause, no question); `resume` on its id is refused; the page applies it.
20. **`elicitation_mode=natve`**: 400 at `initialize` and at `server/discover`, naming the three values.
21. **The access switch in `model`**: read-only: `tools/list` has no `resume` and a `resume` call is refused; off:
    refused naming the panel. Back on afterwards.

## After the run

Write `m5b-settings-owner-modes.json` beside the M5a evidence, with a `verdict` per item (pass, fail, or not run with
why). A failure in items 2, 6, 8 or 11 that comes from the client, not the endpoint, goes to
`docs/upstream-fragility.md` U69 and to the report's deviations (M6), with that client's version.
