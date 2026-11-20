# Pi Durable harness settings live in the Environment, and an owner-only panel edits them

Status: accepted (tools step, 2026-11-12). Plan: [`docs/steps/tools-plan.md`](../steps/tools-plan.md) §6, with its review changelog (H4, M4, LOW CSRF, LOW secret hashes).

Pi Durable's harness has things the owner should switch: code mode, which tools are offered without a search, tool search, and the MCP servers whose tools agents get. t3 has no surface for any of them. A Shadow or Layer on t3's settings would be the wrong layer (ADR-0001): t3's contracts have no such fields, and its clients would show nothing.

So t3flare has its own **Harness panel**:

1. **At `/_t3flare/harness` on the t3 host**, behind the existing `/_t3flare` Access application (the owner's email and the stage's service token). Owner, 2026-11-12, back to stock: there is no separate admin Worker, forwarder, admin domain or second Access application (see "Back to stock" below).
2. **Access verified by the Worker**, never assumed (ADR-0010's `classifyAssertion`). The owner's browser is admitted on the Access assertion alone, since a browser cannot send the admin token. Every state-changing call then needs:
   - a CSRF token: an HMAC of the assertion's subject and the hour (the previous hour accepted);
   - `Origin` equal to the configured t3 host (`T3FLARE_HOST`, set at deploy), never the request's own;
   - `Sec-Fetch-Site: same-origin`;
   - a JSON body.

   Scripts send the service token's assertion and the admin token, as on every admin route.
3. **A page with no framework and nothing third-party.** It is server-rendered HTML. Every string that is not a literal is escaped. Its one script and one stylesheet are constants, allowed by their SHA-256 hashes in the CSP; there is no `'self'` and no inline allowance. Every action is a call to a JSON API that scripts use too.
4. **Settings live in the Environment DO** with a revision. A Session reads the revision with the resolved, secret-free view at a turn's start, so a change applies at a thread's next turn. The relay reads the MCP server set per request. The settings take cloudpid's scope shape (its ADR-0027): Global is the Cloud Environment now, with an empty per-Project override map kept for later.
5. **An extension registry with settings schemas** (`packages/harness-registry`), imported by both Workers. The panel renders a form from each entry, the API validates against it, and the Session builds from the resolved settings. Core extensions are listed locked; `permissions` can never be turned off here.
6. **Secrets are write-only.** A direct MCP server's header value and its OAuth tokens go into the Environment DO's secret store (ADR-0012's tools refinement). The API answers `set`, `setAt` and a fingerprint: an HMAC under a key only the DO holds. The leak scans use the same HMAC. No route, page, log, push, Session or Container gets a value back. Removing a server deletes its secrets at once.
7. **An append-only audit log** in the Environment DO keeps 1 000 entries, with secrets masked, plus one log line per change, without values.
8. **The agent gets no settings tools** (OD-T9). cloudpid lets its agent change settings as recorded, revertable changes. Here linked work and prompt injection make an agent that edits its own MCP set a larger target, and t3 has no surface for such changes.

## Considered options

- **A dedicated admin host** (review H4, built first): a forwarder Worker `t3flare-admin-<stage>` on its own hostname and Access application, so no script on t3's origin shares the panel's. Removed (owner, 2026-11-12, back to stock): the CSRF token, the Origin check, escaping and the hash-only CSP stay, and the second host, Worker and Access applications were not worth their cost.
- **A t3 settings Layer or Shadow.** Rejected: t3 has no fields for this and its clients would show nothing (ADR-0001).
- **Deploy-time configuration** (a JSON in `dev.env`). Rejected: no OAuth sign-ins, and more secrets in CI.
- **Agent settings tools** (cloudpid's ADR-0019). Deferred: read-only `harness_mcp_list`/`harness_status` later, and changes only with the owner's Approval.

## Consequences

- The panel shares t3's origin. A script running on t3's web origin with the owner's Access session could call the panel's API; it would still need the CSRF token, which only the panel's page carries (H4's residual, accepted by the owner).
- The direct servers' OAuth callback and client document are public paths outside `/_t3flare` (`/t3flare/oauth/callback`, `/t3flare/oauth/client.json`), like `/mcp`, with no Access application of their own (ADR-0010's tools refinement).
- An owner assertion without the admin token now reaches something. That is only the harness routes; every other admin route still needs the token (`m3-panel-safety.json`).
- The panel is the place where later pi-harness ports (`docs/pi-parity.md`) get their switches, without panel work.

## Back to stock (owner, 2026-11-12)

The owner chose to stay close to stock t3 (`docs/scope-audit.md`). Removed from this decision, each "owner, 2026-11-12, back to stock":

- the dedicated admin host: the `HarnessAdmin` entrypoint, the forwarder Worker `t3flare-admin-<stage>`, the admin domain, the harness Access application and the OAuth Bypass application. The panel is `/_t3flare/harness` on the t3 host behind the `/_t3flare` Access application. Re-checked on stage in `m3-panel-safety.json` (12/12), including the Container, linked-laptop and code mode cases.
- the per-server "offered to linked threads" switch (ADR-0028).

Kept: CSRF, the Origin check against the configured host, escaping, the hash-only CSP, write-only secrets, and the audit log.

## Refinement: Environment settings (SPI-1149, 2026-11-13)

The page now edits two entities. What this ADR calls the harness settings are the **Harness settings**; beside them the
**Environment settings** (the Container's size, idle time and budget) live under their own key and revision, are read by
each Workspace DO before a Container start, and share this page, its guards and its audit log, whose entries now carry
an `entity`. See [ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md).

## Refinement: agents ask for changes through the Settings server (ADR-0035, 2026-11-14)

§8 ("the agent gets no settings tools", OD-T9) is superseded by
[ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md) (owner, 2026-11-14: "the whole point is
that the agent can modify its own environment"). Everything this panel edits is changeable through the Settings server,
by t3flare's own agents and by Owner clients.

- The owner is no longer the only one who drafts a change. He is still the only one who answers on a page of this panel:
  an asked change of an agent's is answered on its t3 card or on the panel's Change page
  (`/_t3flare/harness/changes/<id>`), which sits behind this panel's guards (§2).
- §6 stands: secrets are write-only. A header value an agent asked for is typed on the Change page, and an OAuth
  sign-in an agent asked for starts there; neither passes through an agent.
- §7's audit entries gain who asked, through which door, the change's tier, and what answered it.
- The panel's handlers move into one module that the panel and the Settings server both call.

## Refinement: a second Access application, for the Owner-client endpoint (SPI-1200, 2026-11-14)

Contradicts §1 and "Back to stock" ("no … second Access application"), deliberately. The panel itself is unchanged: it
stays `/_t3flare/harness` behind the `/_t3flare` Access application, admitted as §2 says. What is new is the Settings
server's Owner-client endpoint at `/_t3flare/mcp`, which needs managed OAuth; a managed-OAuth token is good for its whole
application, so on the `/_t3flare` application an Owner client's token would be admitted at this panel and its Change
page on the owner's assertion alone. The endpoint therefore gets an Access application of its own, `SettingsAccess`, on
that narrower path, and the Worker verifies its audience apart from the panel's.
[ADR-0036](0036-owner-clients-reach-the-settings-server-at-t3flare-mcp-behind-an-access-application-of-its-own.md)
records the layout, the conditions it rests on (one still pending the owner's sign-in), and its fallback, a Worker on a
host of its own. The back-to-stock reasons (no forwarder, no admin host) still hold for the panel.

## Refinement: the Settings page at `/_t3flare/settings` (owner, 2026-11-20)

Contradicts §1's path, deliberately. The panel is now the **Settings page**, at `/_t3flare/settings` on the t3 host:
"Harness" named only half of what it edits since the Environment settings joined it
([ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md)). Everything
else holds: the same `/_t3flare` Access application, §2's checks, and its Change pages below it. The old
`/_t3flare/harness` paths answer a 308 to the same path under `/_t3flare/settings`, only after that same Access check, so
bookmarks, refusals already shown and Change links already sent still land. The sections above keep the old name and
path as written.
