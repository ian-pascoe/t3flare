# Settings server M0 (SPI-1196): the steps only the owner can run

Spike branch `settings-mcp-m0-spike` only. The agent ran everything that did not need a person: see
`docs/steps/settings-mcp/m0-access-oauth.json`, `m0-clients.json` and `m0-pi.json`. Each step below says which probe it
closes and what to send back. Nothing here reads or prints a credential: tokens stay in the scripts' memory and the
clients' own stores.

The stage `psettings` was left up for these steps. It serves the spike's probe MCP server (tools `spike_echo`,
`spike_hold`, `spike_ask_url`, `spike_ask_form`, `spike_pause`, `resume`) at:

| Name | URL | Access |
| -- | -- | -- |
| B | `https://t3flare-environment-psettings.ian-g-pascoe.workers.dev/_t3flare/mcp` | application "settings (spike B)" on that path, managed OAuth |
| C | `https://t3flare-sprobe-psettings.ian-g-pascoe.workers.dev/mcp` | application "settings (spike C)" on the whole host, managed OAuth |
| public | `https://t3flare-spub-psettings.ian-g-pascoe.workers.dev/mcp` | none (client behaviour only) |
| A echo | `https://t3flare-environment-psettings.ian-g-pascoe.workers.dev/_t3flare/echo` | the stage's existing `/_t3flare` application (no OAuth) |

`spike_echo` answers what the server saw: the protocol version, the client's capabilities, the query, the header names
and the decoded claims of the Access assertion (never its signature). Every request is also logged; the agent reads the
log with `node scripts/stage.ts run psettings settings-spike/log <label>`.

Allow about 30 minutes. Steps 1 and 2 matter most (they confirm the layout and the carrier); 3 to 5 refine D12.

## 1. The OAuth flow end to end (P6, P7, P12, P13, P15; and P11 in part)

From the repo root's `apps/environment` on the spike branch:

```sh
node scripts/stage.ts run psettings settings-spike/oauth-owner
```

1. Your browser opens at Access's sign-in for **B**. Sign in as yourself (ian.g.pascoe@gmail.com). The tab then says
   "Signed in; return to the terminal."
2. It opens again for **C**. Sign in again if asked.
3. The terminal asks for P13: open `https://t3flare-environment-psettings.ian-g-pascoe.workers.dev/_t3flare/echo` in the
   same browser (sign in if asked). The page is JSON; copy the value of `claims.sub` and paste it at the prompt.
4. Send back `/tmp/m0/results/owner-oauth.json` (it holds no token: statuses, `expires_in`, claim values, booleans).

What it answers:

- P6: the token response's fields (`expires_in`, `resource`, `scope`, a refresh token), the code's single use, refresh
  rotation and reuse of the old refresh token.
- P7: the claims of an OAuth-derived assertion at the origin, and whether `Authorization` reaches it.
- P12: B's token at `/_t3flare/echo` and `/_t3flare/harness` (application A) and at C. (B) stays allowed only if every
  one of those is refused (302/401, not 200).
- P13: whether `sub` is the same in B's OAuth assertion and A's browser assertion.
- P15 (superseded by deviation 30 of `settings-mcp.md`: Claude Code cannot sign in with a query, and the mode is now set on the panel): B's token used at `…/_t3flare/mcp?elicitation_mode=native`; C's flow asks with the query inside `resource`, as
  OpenCode does.
- P11 in part: `expires_in` under the stage's `15m`.

## 2. Cursor (P14, P15; the redirect allowlist)

Cursor is not installed on the machine the agent used.

1. (Superseded by deviation 30 of `settings-mcp.md`: a real client is added with the plain URL, and its mode is set on the
   panel; this step is the spike's.) In Cursor's MCP settings add a server named `psettings-b` with URL
   `https://t3flare-environment-psettings.ian-g-pascoe.workers.dev/_t3flare/mcp?elicitation_mode=native`.
2. Click Connect / Authenticate. **Before signing in**, copy the address of the Access sign-in tab and keep its
   `redirect_uri=` parameter (decode it). If Cursor shows an error instead ("redirect_uri is not allowed" or
   `invalid_client_metadata`), copy the error text: it means Cursor registered a redirect URI the allowlist does not
   hold (the stage allows any `localhost`/`127.0.0.1` URI and `cursor://anysphere.cursor-mcp/oauth/callback`).
3. Sign in. In a chat with agent mode, ask in turn, waiting for each:
   - "Call spike_echo and show its whole result."
   - "Call spike_ask_form with no arguments." When a form appears, press its accept/confirm button. Note what it showed.
   - "Call spike_ask_url with no arguments." Note what it shows; choose the option that does not open a browser if
     there is one, else open it and press Approve on the page.
   - "Call spike_hold with seconds 50." Note whether it finishes or times out, and after how long.
   - "Call spike_ask_form with hold_seconds 300 and cut_after 15." Leave the form open for 30 s, then decline. Note what
     Cursor shows when the server cuts the call at 15 s.
4. Send back: the redirect URI, Cursor's version, and your notes. The agent reads the server's side from the log
   (label `cursor`).

## 3. Claude Code: the accept button (P14)

In the agent's run, Claude Code 2.1.322's form dialog for an empty `requestedSchema` (and the URL dialog's "I'm done,
continue") did not submit on Enter from a scripted terminal, while Decline did. Check it by hand:

```sh
mkdir -p /tmp/cc-spike && cd /tmp/cc-spike
printf '%s' '{"mcpServers":{"spike":{"type":"http","url":"https://t3flare-spub-psettings.ian-g-pascoe.workers.dev/mcp?case=owner-cc"}}}' > mcp.json
claude --mcp-config mcp.json --strict-mcp-config --allowedTools "mcp__spike__*"
```

Ask: "Call mcp__spike__spike_ask_form with no arguments and show its result." Press Accept (Enter, or click). Then ask
"Call mcp__spike__spike_ask_url with no arguments" and choose "I'm done, continue". Note whether each result says
`accept`, and what you pressed.

## 4. Codex (P14)

Codex needs a model the agent had no key for. In Codex CLI (any recent version):

```sh
codex mcp add psettings-pub --url 'https://t3flare-spub-psettings.ian-g-pascoe.workers.dev/mcp?case=owner-codex'
codex
```

Ask, in turn: "Call spike_echo and show its result", "Call spike_ask_form with no arguments" (accept the prompt),
"Call spike_ask_url with no arguments", "Call spike_hold with seconds 50", "Call spike_hold with seconds 90". Note what
each showed and the Codex version. Then `codex mcp remove psettings-pub`.

## 5. The panel's Access cookies after a browser sign-in (P8, confirmation)

Sign in to `https://t3flare-environment-psettings.ian-g-pascoe.workers.dev/_t3flare/echo` in a browser, then open
`…/_t3flare/mcp` in the same browser. In the browser's developer tools (Application → Cookies) note each
`CF_Authorization` cookie's Path. Expected: one with Path `/_t3flare` and one with Path `/_t3flare/mcp`, and both
pages answering. The agent already showed with service-token cookies that Access reads only the first `CF_Authorization`
sent and that a browser's order (longer path first) gives each application its own.

## When done

Tell the agent (or SPI-1196) the files and notes. The stage is then destroyed with
`node scripts/stage.ts destroy psettings` from `apps/environment`, which removes its Workers and its three Access
applications. Claude Code, Codex and Cursor keep a client registration for each test server: remove the servers from
each client (and `claude mcp remove` where you added one).
