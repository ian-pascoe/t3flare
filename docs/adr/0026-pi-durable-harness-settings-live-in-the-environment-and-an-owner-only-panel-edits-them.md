# Pi Durable harness settings live in the Environment, and an owner-only panel edits them

Status: accepted (tools step, 2026-11-12). Plan: [`docs/steps/tools-plan.md`](../steps/tools-plan.md) §6, with its review changelog (H4, M4, LOW CSRF, LOW secret hashes).

Pi Durable's harness has things the owner should switch: code mode, which tools are offered without a search, tool search, and the MCP servers whose tools agents get. t3 has no surface for any of them. A Shadow or Layer on t3's settings would be the wrong layer (ADR-0001): t3's contracts have no such fields, and its clients would show nothing.

So t3flare has its own **Harness panel**:

1. **Its own host.** The panel is served only by the Environment Worker's named entrypoint `HarnessAdmin`, which a small forwarder Worker `t3flare-admin-<stage>` reaches over a service binding. It has its own hostname (`<first label>-admin.<rest of T3FLARE_DOMAIN>`, or the forwarder's workers.dev host on a domain-less stage) and its own Access application (the owner's email and the stage's service token). The t3 host never serves `/_t3flare/harness*`: one hostile page or script on t3's origin cannot reach it.
2. **Access verified by the Worker**, never assumed (ADR-0010's `classifyAssertion`). The owner's browser is admitted on the Access assertion alone, since a browser cannot send the admin token. Every state-changing call then needs:
   - a CSRF token: an HMAC of the assertion's subject and the hour (the previous hour accepted);
   - `Origin` equal to the configured admin host, never the request's own;
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

- **The panel under `/_t3flare/harness` on t3's own host** (the plan's first draft). Rejected (review H4): t3's web client and the panel would share an origin, so script on t3's origin could drive the owner's panel.
- **A t3 settings Layer or Shadow.** Rejected: t3 has no fields for this and its clients would show nothing (ADR-0001).
- **Deploy-time configuration** (a JSON in `dev.env`). Rejected: no OAuth sign-ins, and more secrets in CI.
- **Agent settings tools** (cloudpid's ADR-0019). Deferred: read-only `harness_mcp_list`/`harness_status` later, and changes only with the owner's Approval.

## Consequences

- One more Worker per stage (the forwarder) and one more Access application, plus the OAuth bypass application (ADR-0010's tools refinement).
- An owner assertion without the admin token now reaches something. That is only the harness routes; every other admin route still needs the token (`m3-panel-safety.json`).
- The panel is the place where later pi-harness ports (`docs/pi-parity.md`) get their switches, without panel work.
