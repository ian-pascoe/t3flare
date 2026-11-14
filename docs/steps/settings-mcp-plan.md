# Plan: the Settings server, agents change t3flare's settings over MCP

Branch `settings-mcp` (worktree `.worktrees/settings-mcp`), from `origin/main` at 747905d. Stage `psettings` (to be added
to `STAGES` in `apps/environment/scripts/stage.ts`). Evidence in `docs/steps/settings-mcp/`. Decision record:
[ADR-0034](../adr/0034-agents-change-t3flares-settings-through-the-settings-server.md), which supersedes ADR-0026 §8.
Research: [`docs/research/access-managed-oauth.md`](../research/access-managed-oauth.md),
[`docs/research/mcp-elicitation-server.md`](../research/mcp-elicitation-server.md).

Tickets (Linear team SPI): `SPI-1195`, with one child per milestone: `SPI-1196`, `SPI-1197`, SPI-1076 (M2,
reused), `SPI-1198`, `SPI-1199`, `SPI-1200`, `SPI-1201`, `SPI-1202`.

This plan is the whole specification. It was designed in four interview rounds on 2026-11-14; an implementer has none of
that conversation and needs none. Words in **bold** on first use are GLOSSARY.md terms.

## 0. Goal

Everything the **Harness panel** edits becomes changeable by agents through one MCP server, the **Settings server**:

- the **Harness settings** (Pi Durable's extensions and their options, and the **MCP server set**);
- the **Environment settings** (Container size, idle time, budget, **Variables**, **Global mise config**);
- the **Environment skills**.

It has two doors onto one implementation:

1. **t3flare's own agents** (Durable agents; the CLI agents Codex, Claude Code, OpenCode and pi) reach it as a member of
   the MCP server set, in-process in the Environment DO's **MCP host**, with no Access and no OAuth.
2. **Owner clients** (the owner's Claude Code, pi, Cursor and the like on his laptop) reach it at an HTTP endpoint behind
   Cloudflare Access managed OAuth.

A change that widens what agents have or can do is **asked**: it waits for an answer before it applies.

## 1. Settled by the owner (do not reopen)

Verbatim where quoted; otherwise as the interviewer relayed it.

| # | Decision |
| -- | -- |
| O1 | "The whole point is that the agent can modify its own environment": t3flare's own agents get this server, as well as the owner's external clients. This supersedes ADR-0026 §8 (OD-T9, "the agent gets no settings tools"). |
| O2 | Confirmation of risky writes is by MCP elicitation, not a panel-side Proposal, and not only client tool-approval hints. |
| O3 | It must work on every stage, including workers.dev test stages; "skip test stages" is not acceptable. A fallback for an Access collision must work on workers.dev too. "Don't be lazy" about stage coverage. |
| O4 | The pi CLI is in scope. pi has built-in MCP support and the image already pins `@earendil-works/pi-coding-agent` 1.5.2; `docs/steps/tools.md:123` ("the pi CLI has no MCP client") was stale. |
| O5 (E2) | "Make everything configurable by the agent. Since we are using elicitation, it's not a big deal to expose these." Agents get panel parity: there is no panel-only tier. |
| O6 (E1) | Owner clients choose their **Elicitation mode** with a URL query parameter, as executor.sh does: `?elicitation_mode=browser\|native\|model`. The parameter is trusted as sent on every request: no server-side floor, no grant binding; Access owns the grant. |
| O7 | t3flare's own agents are unaffected by any parameter: theirs is always the owner-only t3 card. |
| O8 | Secrets and OAuth sign-ins for **Direct servers** always happen on the **Change page** under the owner's Access identity, never through an agent, a model or a form. |

## 2. What exists today

- **The panel** (`apps/environment/src/harness/panel.ts`): `handleHarness` (:162) serves the page and a JSON API under
  `/_t3flare/harness`. Its handlers validate with the registry and write the store and the audit log inline:
  the extension change (end of `handleHarness`), `changeEnvironment` (:258), `testServer` (:287), `changeMcp` (:306, which
  deletes a removed server's secrets at :317), `addServer` (:336), `beginOAuth` (:366), and the skills routes
  (`apps/environment/src/skills/api.ts`, `SKILLS_WRITE_ROUTES` :195). Its write guard is `unsafeWrite` (:146). No
  handler takes an expected revision. No route sets a header value on an existing server.
- **The registry** (`packages/harness-registry/src`): `EXTENSIONS` (`index.ts:57`), `applyChange` (:395),
  `applyMcpChange` (:295), `McpChange` (:264), `mcpServersOf` (:258), `ENVIRONMENT_SETTINGS` (`environment.ts:84`),
  `applyEnvironmentChange` (:171), `decideCall` (`mcp.ts:15`), `ServerKind` (:29, two kinds),
  `RESERVED_SERVER_NAMES` (:88).
- **The store** (`apps/environment/src/harness/store.ts`): two entities with their own revisions, one audit log of 1,000
  entries (`AuditEntry` :30). Skills live in SQLite (`apps/environment/src/skills/store.ts`), whose `apply` tries up to
  three times when the Environment revision moved (:240; its comment says "once").
- **The MCP host** (`apps/environment/src/mcp/host.ts`): `view()` (:298) and `call()` (:328) reach every server through
  the engine Worker. `EnvironmentDO.mcpCall` (`environmentDO.ts:479`) carries server, tool, args, judged class and an
  asker, and **no caller identity**.
- **The relay** (`apps/environment/src/mcp/relay.ts`): a hand-written, stateless JSON-RPC server for CLI agents. It is
  stateless because it never sends an elicitation. `McpRelayInput` (`mcp.ts:108`) carries `workspace`, `thread`, `cli`.
- **Server questions** (`apps/environment/src/mcp/elicitation.ts`, ADR-0028's SPI-1079 refinement): a zero-field form
  becomes an `approval` card (`formOrApproval` :173), which t3's `t3_pending_request` cannot answer at all. Cards are
  shown through an `McpAsker` (`packages/session-protocol/src/index.ts:420`, `ask` and `withdraw`): the Session's
  (`apps/agents/src/extensions/mcpQuestions.ts`) or the CLI wrapper's (`cliQuestionAsker`,
  `apps/environment/src/provider/cli/cliAsk.ts:89`).
- **Access** (`apps/environment/src/access.ts`, `worker.ts`): one Access application per stage on `<host>/_t3flare`
  (`alchemy.run.ts:137`). `verifyHarnessRequest` (:208) admits the owner's assertion alone on the panel's paths;
  `verifyAdminRequest` (:226) needs the admin token as well. The panel has no local-mode branch; only the generic
  `/_t3flare/*` branch has one (`worker.ts:76`).
- **The pi CLI** (`apps/environment/src/agents/cliProfiles.ts`, `piLaunch` :279): gets t3's own tools only. Its context
  already holds the relay's handle and server list (`cliProcess.ts:110`), unused.

## 3. Design

### D1. One transport-free module holds every Settings change

New `apps/environment/src/harness/ops.ts`. The panel's handlers move into it as functions over the same dependencies
(`HarnessStore`, `McpHost`, `HarnessSecrets`, `HarnessOAuth`, the skills API), with no `Request` or `Response` in their
signatures. Each takes the change, an optional `expectedRevision`, and an **actor** (who asked, through which door, and
what answered), and returns an outcome with the new revision. The panel and both doors of the Settings server call these
and nothing else. A **Settings change** is one such call.

- `expectedRevision` is optional for the panel (its form and existing scripts keep working) and required from the
  Settings server (D15).
- Not offered through the Settings server, and not moved: the per-Project `overrides` seam, every `/_t3flare` admin
  route outside the panel, and reading any secret.
- New op, for the panel too: set the header value of an existing header-auth Direct server
  (`POST /_t3flare/harness/api/mcp/secret` `{ server, value }`). It writes the secret, audits `mcp.secret.set` with the
  mark, and bumps no revision (the host reads secrets per call).

### D2. The Settings server is a third kind of MCP server, served in-process

- `ServerKind` gains `"settings"`. `RESERVED_SERVER_NAMES` gains `settings`. The server's name is `settings`; a Durable
  agent sees `mcp__settings__<tool>`.
- Its entry is implied, as Commissary's is: `mcpServersOf` adds
  `settings: { kind: "settings", enabled: true, exposure: "deferred", writes: true }` until a change stores one.
  So it is on, deferred and read-write on every stage including prod, with no migration.
- `McpServerSetting` gains `writes?: boolean` (kind `settings` only; absent reads as true). The panel shows `enabled` and
  `writes` as one three-way control: off, read-only, read-write. It governs both doors.
  - Off: the server is not in `view()`; the Owner-client endpoint lists no tools and refuses every call, naming the panel.
  - Read-only: write tools are not listed and are refused if called.
- `applyMcpChange` on the `settings` entry: `server` (with `enabled`, `exposure`, `toolExposure`, `writes`) is allowed;
  `remove` is refused as Commissary's is; `class` is refused for everyone (its tools' classes are fixed). This is the
  same for the panel, so it is parity, not a carve-out.
- `McpHost.view()` builds the entry's tools from static definitions ("The tools" below): no engine, no inventory, no
  credential, `state: "available"`. `McpHost.call()` branches on the kind before any inventory or pausing logic and
  calls the Settings server module directly with the caller (D3) and the asker.
- New module `apps/environment/src/settings/server.ts` (pure over its deps): the tool definitions, the judge (D7), the
  tier (D5), the Open change handling (D8), and the two doors' entry points. `apps/environment/src/settings/` also holds
  the Open change store, the diff renderer and the Owner-client endpoint.
- Rejected: agents calling a public endpoint with a credential (a credential in a Container, ADR-0016, and the origin
  could not tell which thread called); a "builtin" kind as an abstraction (a class of one).

### D3. The caller is derived by the Environment, and fails closed

`mcpCall` gains `thread: string` (the Session passes the thread id it was opened with). The relay already has
`thread`, `cli` and `workspace`. From the thread the Environment DO derives everything else itself:

| Fact | Durable agent | CLI agent |
| -- | -- | -- |
| agent kind | `piDurable` (only Sessions call `mcpCall`) | `input.cli` |
| runtime and interaction mode | a per-thread record the adapter writes when it calls `open` and `submitTurn` (`provider/adapter.ts:314`, `:449`), cleared when the provider session unregisters | `cliThreadState(thread)` (`cliAsk.ts:56`) |
| **Linked work** | new `threadLinkOf(thread)`: `"own"`, `"linked"` or `"unknown"` | the same |

- `threadLinkOf` is new, beside `linkedWorkOf` (`adapter.ts:83`). `linkedWorkOf` returns null when the thread has no
  projection row, which reads as the owner's own work: that is fail-open for this purpose. `threadLinkOf` answers
  `"unknown"` for a missing row and `"linked"` for a malformed origin.
- Linked or unknown: reads run, every write is refused ("This thread is Linked work; the owner changes settings from his
  own thread, the Harness panel, or an Owner client."). The server stays listed for linked threads, as every enabled
  server is (ADR-0028, back to stock).
- No mode record (an Environment restart mid-turn): writes are refused, reads run.
- Delegated children of the owner's own threads are ordinary callers with their own thread id; their cards go on the
  child's thread. A child of a linked thread carries the link's origin and is Linked work.
- Rejected: trusting the Session's kept `linked` and mode (the same values, a turn stale); t3's projection for modes (a
  new lean on t3's internals where the adapter's own inputs suffice).

### D4. The pi CLI gets the relay's servers (SPI-1076), in this work

`piLaunch` uses `context.relay` as the other profiles do:

- It writes `${home}/agent/mcp.json` (the per-process agent directory `PI_CODING_AGENT_DIR`, where it already writes
  `models.json` and `settings.json`) with one entry per relay server:

  ```json
  { "mcpServers": { "<server>": {
      "url": "http://computer.internal/t3flare/mcp/<server>",
      "headers": { "Authorization": "Bearer ${T3FLARE_TOOL_HANDLE}" },
      "timeout": 900,
      "exposure": "deferred"
  } } }
  ```

  `url` is `relayUrl(server)`; `timeout` is `CLI_TOOL_TIMEOUT_SEC`; the variable is `TOOL_HANDLE_ENV`.
- It sets `T3FLARE_TOOL_HANDLE` in the process's environment. The handle is never written to a file (ADR-0028, review
  H2). pi's commands can probably read their own handle from the environment (Codex hides it with
  `shell_environment_policy.exclude`, `cliProfiles.ts:134`; no such switch was found for pi). ADR-0028 already accepts a
  handle read inside its own Container: it is judged as its own thread.
- The fork launch (`--no-extensions`, `forking` at :304) gets no `mcp.json`: that flag disables pi's built-in MCP.
- A repository's `.pi/mcp.json` cannot replace, disable or redirect an entry: it is trust-gated, every launch ends with
  `--no-approve` (:342), and `PI_SETTINGS` sets `defaultProjectTrust: "never"` (:243). t3flare grants pi no project
  trust and the profile refuses any extension but t3's. This is pinned by a test and by stage evidence (§5, T-pi-2).
- All relay servers, not only `settings`: Commissary and Direct servers reach pi too. This closes SPI-1076.
- pi threads already get the relay's cards: `piDriver.ts:124` wraps the adapter with `wrapCliAdapter`, which registers
  the thread's asker.
- **Patch** (ADR-0001: no Layer exists, since the profile requires the extension's content to be t3's own; a Shadow of
  the module drifts more). Outside full access, t3's pi extension asks "Allow <tool>?" for every tool it does not know
  as read-only (`t3code/packages/provider-pi/src/server/mcpExtensionSource.ts:361`). Relay tools are not in that set, so
  a relay read would ask and a relay write would ask twice. Patch `patches/0006-pi-relay-tools-are-judged-by-the-relay.patch`
  makes the hook return early for tools that come from pi's built-in MCP client. How pi labels such a tool's source is
  an M0 probe (P16). If the Patch cannot be made safely, ship without it: the extension only asks more, never less.
  Record the Patch in `docs/upstream-fragility.md`.

### D5. Two Change tiers, by direction, failing closed

A **Change tier** is `free` or `asked`. There is no panel-only tier (O5). A registry entry the panel cannot change
(`locked`, or `default: "always"` for its switch) stays unchangeable for everyone.

The tier is a pure function in `packages/harness-registry/src/tiers.ts`:

```ts
tierOf(input: { entity; stored; change; hintedClass?: (server, tool) => "read" | "write" | undefined })
  : { tier: "free" | "asked"; reasons: string[]; needsPage?: "secret" | "sign-in" | "skills" }
```

Registry additions: `ExtensionEntry.guard?: true` (set on `guardian` and `permissions`); `SettingEntry.tier?: "free" |
"down-free"` and the same on `EnvironmentSettingEntry` (absent means asked). `down-free` means a boolean set to false or
an integer lowered is free, and the other direction is asked.

| Change | Tier |
| -- | -- |
| **Extension switch** off to on | asked |
| Extension switch on to off | free; asked when the entry is a **Guard** |
| Any setting of a Guard entry (`guardian.*`) | asked |
| `codemode.inlineBudget`, `offered-tools.preset`, `context.rolloverOnCompaction`, `termctrl.cols`, `termctrl.rows` | free |
| `web.search`, `termctrl.backgroundBash`, `advisor.correctiveTurns` | down-free |
| Every other extension setting (`web.searchModel`, `advisor.model`, `advisor.reviewEvery`, `advisor.thinkingLevel`, and any entry added later without a tier) | asked |
| **MCP**: any change to the `settings` entry itself, narrowing included | asked |
| MCP: `add`; `remove` (it deletes the server's secrets at once) | asked |
| MCP: `server` with `enabled` false to true | asked |
| MCP: `server` with `enabled` true to false | free |
| MCP: Exposure moved up the order `hidden` < `codemode` < `deferred` = `direct` (server-wide or one tool, against the tool's current effective Exposure; `null` compared the same way) | asked |
| MCP: Exposure moved down or sideways | free |
| MCP: `class` to `read` | asked |
| MCP: `class` to `write` | free |
| MCP: `class` to `null` | asked when the tool's own hint is read and its current class is write, or when the hint is unknown; else free |
| MCP: set a header value; start an OAuth sign-in | asked, needs the page |
| **Environment**: `containerIdleMinutes` | free |
| Environment: `containerBudget` | down-free |
| Environment: `containerSize`, `variables`, `globalMiseConfig` | asked |
| **Skills**: install, update, enable, remove | asked |
| Skills: disable | free |

- A call that moves several things is asked when any part is.
- A change that moves nothing is answered `unchanged` and has no tier.
- Why direction: turning something down never widens what agents can reach, spend or run; the exceptions are a Guard
  (turning it off removes a check), a destructive removal, and the server's own entry.
- Why `variables` and `globalMiseConfig` are asked although an agent is root in its own Container: both reach every
  Workspace of every Project, so a change in one thread runs in another Project's Container, which holds that
  Project's **Container token**.
- Rejected: every write asked (the owner's "risky writes" implies a tier); a static per-setting flag (it cannot tell
  lowering the budget from raising it).

### D6. A change "needs the page" in four cases

`needsPage` is set when the change takes a secret (`add` with `auth.kind: "header"`, or setting a header value), starts
an OAuth sign-in, installs or updates Environment skills (`skills`: only the page shows each skill's `SKILL.md` text and
files, so a card would offer Approve on text it cannot show; SPI-1199 review), or its rendered text would be cut by
`cardText` (`CARD_TEXT_MAX`, 16 KiB; `packages/harness-registry/src/cardText.ts`). The last is decided by the renderer,
not by `tierOf`.

Such a change is answered only on the Change page, for every caller and in every Elicitation mode: the card is
link-only, and an Owner client gets the page's link whatever its mode. The owner never approves text he cannot see, and
no secret or authorization URL passes through an agent, a model, a tool argument, a tool result or a form.

### D7. One judge, one card, and the thread's mode

The Settings server judges every write itself. The Session's `mcp` extension
(`apps/agents/src/extensions/mcp.ts:70`) and the relay (`relay.ts:94`) keep `decideCall`'s plan refusal for this
server, skip their own write card (`askOwner`, `deps.ask`) for it, and pass the call through. Every tool's class is
fixed: reads are `read`, writes are `write`.

| | plan | approval-required, auto-accept-edits | full access | Owner client |
| -- | -- | -- | -- | -- |
| read | runs | runs | runs | runs |
| free change | refused (`PLAN_REFUSAL`) | asks | runs | runs |
| asked change | refused | asks | asks | asks, in its Elicitation mode |

- The tier is what full access does not skip. An asked change always asks, in every mode (as an elicitation does,
  ADR-0028 SPI-1079 §4). There is no "accept for the session".
- Order of checks for a write: the access switch (D2); Linked or unknown (D3); plan; validation by the registry; the
  expected revision (D15); the caps (D16); then run or ask.
- pi has no plan mode; `piDriver.ts` already refuses plan turns.
- Rejected: full access skipping the card; the generic write card followed by a second card.

### D8. The Open change

An **Open change** is an asked Settings change waiting for its answer. One record, the same in every mode:

```ts
interface OpenChange {
  id: string;                    // "chg_" + 32 random bytes, base64url
  entity: "harness" | "environment";      // whose revision
  expectedRevision: number;
  tool: string;                  // the write tool's name
  args: unknown;                 // the call's arguments, canonical JSON, without a secret (none is ever in them)
  hash: string;                  // SHA-256 of tool + the change as its planner normalized it (only the fields the
                                 // change takes; SPI-1199 review), canonical, without expectedRevision; an add's URL
                                 // as a URL parser spells it, an install's source as its repo, folder and skill
                                 // (SPI-1200 review), so a respelling is the same change
  shown: ChangeView;             // what the card and the page render: before, after, reasons, when it applies (D10)
  needsPage?: "secret" | "sign-in" | "skills" | "oversize";
  mode: "card" | "browser" | "native" | "model";
  caller: { door: "own" | "owner"; key: string; principal: "agent" | "owner" | "service-token";
            thread?: string; agent?: string; client?: { name: string; source: string } };
  createdAt: number; expiresAt: number;   // 10 minutes (QUESTION_WAIT_MS, host.ts:41)
  state: "open" | "applying" | "applied" | "declined" | "withdrawn" | "expired" | "moved" | "failed";
  closed?: { at: number; by: "card" | "page" | "client" | "agent" | "stop"; revision?: number; error?: string;
             cut?: true };  // `cut`: a `native` stream the client ended unanswered (D12), in its close line
  // `stop`: the caller's Stop, turn end or going away withdrew it (D9); `agent` is model-mode `resume` alone
}
```

- **Kept in the Environment DO's SQLite**, table `t3flare_settings_changes` (one row per change, the record as JSON,
  indexed by caller key and hash). Memory is not enough: the Environment resets after about 60 s idle (ADR-0003), which
  falls between an Owner client's first call and the click. Rows are pruned lazily, on every read and write of the table
  two hours after they close or expire (SPI-1199 review; it was one hour: the longest a cap looks back is a run of
  strikes and the lock after it), and an expiry there writes its log line. No alarm is added (ADR-0003: one alarm).
- **One answer.** `answerOpenChange(id, { by, answerer, action, secret? })` moves `open` to `applying` in the same
  synchronous block that checks expiry, the answerer and the revision, so a second answer finds it closed. Then it
  applies through `ops.ts` with `expectedRevision`, audits, and closes the record. A moved revision closes it as
  `moved`; nothing is applied. A close without an answer (a decline or cancel from the client, a Stop, a timeout) that
  lands while another answer is applying the change waits for that answer's outcome and reports it (`closeOrSettle`,
  at most `APPLYING_WAIT_MS`, 30 s; an apply a reset stranded is the table's to close; SPI-1200 review).
- **Who may answer**:

  | By | Which changes | Answerer |
  | -- | -- | -- |
  | card | mode `card` | the owner, by construction (an approval card) |
  | page | every Open change | an admitted owner assertion; for an Owner-door change the same `sub` as the caller (the email if M0 shows `sub` differs across applications); a service-token change by the service token with the admin token |
  | client (the form) | mode `native` | the same `sub` |
  | agent (`resume`) | mode `model` | the same `sub` |

- A retry or `resume` in a different mode from the change's is refused. This is coherence, not a floor: the client can
  ask again in the other mode.
- **In-memory waiters.** A held call (an own agent's card, an Owner client's hold) waits on a per-id promise the answer
  resolves. With no waiter (after an Environment restart the call is gone, ADR-0028 SPI-1079 §3) the record still stands
  until it expires and the page can still apply it.
- Skill installs: at ask time the server previews the source at the named commit and keeps each skill's digest in
  `shown`; apply fetches at that commit and refuses a different digest. The fetched files are not kept in the record.
- Not a Proposal queue (O2): the record lives exactly as long as its question, 10 minutes.

### D9. Own agents: an owner-only approval card, with the page beside it

For t3flare's own agents an asked change raises a **Server question** on the calling thread, built by the Settings
server itself (not through `planQuestion`) and shown through the call's `McpAsker`:

- An `approval` card (`McpQuestionCard.kind: "approval"`, id from `newCardId()`), options Approve / Decline / Cancel.
  An agent cannot answer an approval card at all (ADR-0028 SPI-1079 §4). It never has a field.
- The prompt, through `cardText`, is written by the server, never by the agent: what changes (before and after as
  resolved), the entity and revision, when it applies (D17), which thread and agent kind asked (the plan also named
  the script, when the call is nested in code mode, as other cards name it; **deviation, accepted in the SPI-1199
  review: the card names no script, since the MCP host carries no such fact for a nested call**), the reasons from `tierOf`, a fixed line for a Guard ("This turns
  off the Guardian, which reviews risky tool calls."), a fixed line for a new server ("Its tools' own read-only hints are
  trusted: a tool it marks read runs without a card."), the Change page's link, and the agent's call (tool and
  arguments).
- When the change needs the page (D6) the card has "Opened it" / Decline / Cancel instead, and "Opened it" only keeps
  the call waiting for the page.
- The call waits up to 10 minutes on a race of the card and the page. When the page answers first, the server calls
  `asker.withdraw(card.id)`, the path a timeout already takes; the card closes as cancelled, and the tool result and the
  audit entry say the change was answered on the Change page. A Stop or a turn's end withdraws the Open change
  (closed `by: "stop"`), also after "Opened it": Workers RPC carries no cancellation, so the Session names its call to
  `EnvironmentDO.cancelAsk` (the id it passed as `mcpCall`'s `stopId`), and the relay's call runs under the CLI's
  `askId`, which the Workspace DO names when the CLI's request goes away (`mcp/callStops.ts`; SPI-1199 review). Only
  writes register a stop; a second call under a running id shares its signal and never aborts it; a stop that arrives
  before its call registers (the Stop raced the RPC) is remembered for `EARLY_STOP_MS` (a minute), at most
  `EARLY_STOPS_MAX` (256) ids, oldest dropped first, and the call then starts stopped (SPI-1200 review).
- ADR-0028's rule that a page on the t3 host is declined unseen governs third-party servers' questions
  (`planQuestion`); this card is the host's own and is not subject to it.
- Rejected: page only (it loses one tap and the phone, ADR-0025); a form card (an agent can be stopped from answering
  it only by `refuseOwnerOnly`, where an approval card cannot be answered at all).

### D10. The Change page

Under the panel's path, so `verifyHarnessRequest` admits it with no Worker change:

- `GET /_t3flare/harness/changes/<id>`: the page. Server-rendered, every non-literal escaped, under the panel's
  hash-only CSP (`pageCsp`), with the panel's security headers.
- `POST /_t3flare/harness/api/changes/<id>` `{ action: "approve" | "decline", value?: string }`: behind `unsafeWrite`
  (JSON, `Origin` equal to the configured host, `Sec-Fetch-Site: same-origin`, the CSRF token for the owner; the admin
  token for the service token). **This POST applies the change.**
- `GET /_t3flare/harness/api/changes`: the open changes. The panel's page gains an "Open changes" section listing them,
  each linking to its page (an own agent's also names its thread).

What the page renders, by kind (server-side; no script computes a diff):

| Kind | Shown |
| -- | -- |
| scalar settings | name, before, after |
| Variables | a table of added, changed and removed names with values |
| `file` and `text` settings (Global mise config, the Guardian's policy texts) | a line diff of the whole text |
| MCP `add` | name, the whole URL as it will be stored (query included: the caller wrote it, and the owner approves exactly that; SPI-1199 review) with its host set apart, the sign-in kind, the hint-trust line; for a header sign-in a password field (`autocomplete="off"`) |
| MCP switches, Exposure, class | the server or tool, before, after |
| a header value | the server and header name, whether one is set now, a password field |
| an OAuth sign-in | the server and its URL; Approve starts `oauth.begin` and the page's script sends the browser to the authorization URL, as the panel's own sign-in does |
| skills | source, ref, commit, each skill's name, file count and bytes, its `SKILL.md` text, its files with GitHub links at the commit |

Every page also shows who asked (thread and agent kind, or the Owner client's label marked unverified), the mode, when
it applies, the reasons, a Guard's fixed line, and the time left. A closed or unknown id shows its outcome or "gone".

A secret value goes from the POST's body straight to `HarnessSecrets.put`; it is never stored in the Open change,
logged or echoed. After an approve, the page shows the result (applied with the new revision, moved, or the error).

### D11. The Owner-client endpoint

`EnvironmentDO.settingsMcp(request, caller)`, an RPC as `harness(request, caller)` is, called by a Worker that has
already verified Access (D13). It never boots t3. Hand-written JSON-RPC in the Environment Worker
(`apps/environment/src/settings/endpoint.ts`); the SDK stays in the MCP Worker (`apps/mcp-worker/test/sdk-isolation.test.ts`).

- **Versions**: `2026-07-28`, `2025-11-25`, `2025-06-18`, and for tools without elicitation `2025-03-26` and
  `2024-11-05`. The version only decides how a question is delivered (D12).
- **Methods**: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, and a client's JSON-RPC
  response to an elicitation (2025). On 2026-07-28 also `server/discover`, the per-request `_meta` and `resultType` on
  every result. Take the 2026 shapes from the spec's `schema.ts` (URL in the research file), cross-checked against the
  vendored client's types (`vendor/cloudpid/mcp/src/connection.ts`) and a real client's traffic captured in M0. Anything
  else answers `-32601`.
- **Stateless.** No stored session.
  - 2026: capabilities come on each request in `params._meta["io.modelcontextprotocol/clientCapabilities"]`.
  - 2025: capabilities and `clientInfo` come once, at `initialize`. The response sets `Mcp-Session-Id` to a signed
    token carrying `{ sub, protocolVersion, elicitation: { form, url }, client: { name, version }, iat }`. Later requests
    present it; a missing, invalid or other-`sub` token reads as "no elicitation declared". An empty `elicitation: {}`
    means form only.
- **Signed tokens** (the session id, `requestState`, the 2025 elicitation request id) are
  `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA-256)>` under a key kept in the DO
  (`t3flare:settings:state-key`, made on first use as `csrfKey` is). Each payload has a `kind` so one cannot stand in
  for another.
- **Guards**, before the body is parsed:

  | Check | Answer |
  | -- | -- |
  | method other than `POST` (`GET`, `DELETE`, `OPTIONS`) | 405 |
  | `Content-Type` other than `application/json` | 415 |
  | any `Origin` header, or any `Sec-Fetch-Site` header | 403 |
  | body over 256 KiB | 413 |
  | `elicitation_mode` unknown, repeated or mis-cased | 400, naming the three values |

  No CORS header is ever sent. `Sec-Fetch-Mode` is not a reason to refuse (some non-browser HTTP clients are believed to
  send it; M0 records what each client sends). Every response is `cache-control: no-store`.
- **Caller**: `{ kind: "owner", subject }` or `{ kind: "service-token" }`, from the Worker. The caller key for caps is
  the `sub` (`service-token` for the token).
- **The client label** in the audit is display only and never trusted: from the 2026 request's `_meta` client info if
  the spec carries one, else the session token's `clientInfo`, else `User-Agent`; cut to 60 characters and escaped, with
  its source.
- **Tool results** carry text and `structuredContent`:
  `{ status: "applied" | "unchanged" | "waiting" | "declined" | "withdrawn" | "expired" | "moved" | "refused", revision?,
  appliesAt?, changeId?, url? }`. `isError` is true for every status but `applied`, `unchanged` and `waiting`.
- Rejected: the SDK's server in the MCP Worker (`vendor/cloudpid/mcp/src/server/handler.ts` shows the shape). It needs
  `@modelcontextprotocol/server`, which is not in the workspace (a relock), an inbound entrypoint in a Worker that has
  none by design, and every op passed back over RPC. Revisit only if the hand-written 2026 handling fails with a named
  client.

### D12. Elicitation modes (Owner clients only)

Read from the request's URL on every request: `?elicitation_mode=browser|native|model`. Absent means `browser`.
(If M0 P15 shows a query parameter breaks Access's OAuth discovery, the mode moves to the request header
`X-T3flare-Elicitation-Mode` with the same values and rules; record which in the M0 report.)

| Mode | Who answers | What applies the change |
| -- | -- | -- |
| `browser` | the owner, on the Change page | the page's POST |
| `native` | whatever answers the client's form | the client's `accept` |
| `model` | the client's agent | its `resume` call |

Fallbacks always move toward `browser`:

| Case | Result |
| -- | -- |
| parameter absent | `browser` |
| `native`, and the client declared no form elicitation | `browser` for that request |
| a change that needs the page (D6), in any mode | the page: a page elicitation when the client declared one, else the link in the result; in `model` it is a link, never a Pause |
| `browser`, and the client declared no page elicitation (2025-06-18 and older, pi) | the link in the result |
| unknown, repeated or mis-cased value | HTTP 400 |

Below, `M` is the server-written text of the change (the card's text without the agent's call), `U` is
`https://<T3FLARE_HOST>/_t3flare/harness/changes/<id>`, and `W` is the "waiting" result:
`{ content: [{ type: "text", text: "Waiting for the owner at <U>. It applies when he approves it there. Do not repeat
this call; read the settings to check." }], structuredContent: { status: "waiting", changeId, url: U } }`.

#### `browser`

- **2026-07-28**, first call, answered at once:

  ```json
  { "jsonrpc": "2.0", "id": 1, "result": {
      "resultType": "input_required",
      "inputRequests": { "change": { "method": "elicitation/create",
        "params": { "mode": "url", "message": "<M>", "url": "<U>" } } },
      "requestState": "<signed: kind=state, change id, sub, expiry, digest of the call's arguments>" } }
  ```

  The retry carries the same `name` and `arguments`, `params.inputResponses.change` and `params.requestState`.
  `accept` means only "opened it". The server verifies the state (signature, `sub`, expiry, digest; a mismatch is a
  tool error and applies nothing), then holds up to **45 s** for the page's answer and answers `applied`, `declined`, or
  `W`. A `decline` or `cancel` in `inputResponses` withdraws the Open change.
- **2025-11-25**, page elicitation declared: the response to `tools/call` is `text/event-stream`. The server writes

  ```json
  { "jsonrpc": "2.0", "id": "<signed: kind=elicit, change id, sub, expiry>", "method": "elicitation/create",
    "params": { "mode": "url", "message": "<M>", "url": "<U>", "elicitationId": "<change id>" } }
  ```

  then holds up to **45 s** for the page's answer and writes the call's result (`applied`, `declined` or `W`) and ends
  the stream. The client's response arrives as its own POST (`{ "jsonrpc": "2.0", "id": "<that id>", "result":
  { "action": … } }`) and is answered 202 with no body: `decline` or `cancel` withdraws the Open change if it is still
  open, even after the call ended; `accept` is ignored.
- **Otherwise**: `W` at once.
- Why 45 s and not 10 minutes: client tool timeouts are 60 s or unknown, a cut stream reads as a failure and invites a
  repeat, and since the page applies, ending early loses nothing. If M0 shows a client mishandles a call that ends with
  its prompt still open, that client's version gets `W` with no elicitation.

#### `native`

- **2026-07-28**, first call, answered at once:

  ```json
  { "jsonrpc": "2.0", "id": 1, "result": {
      "resultType": "input_required",
      "inputRequests": { "change": { "method": "elicitation/create",
        "params": { "mode": "form", "message": "<M>",
                    "requestedSchema": { "type": "object", "properties": {} } } } },
      "requestState": "<signed, as above>" } }
  ```

  The retry's `inputResponses.change.action`: `accept` applies (`answerOpenChange` by `client`); `decline` closes it as
  declined; `cancel` withdraws it. A retry without a response asks again on the same Open change. No hold anywhere.
- **2025-06-18 and 2025-11-25**, form elicitation declared: the response to `tools/call` is `text/event-stream`. The
  server writes

  ```json
  { "jsonrpc": "2.0", "id": "<signed: kind=elicit, change id, sub, expiry>", "method": "elicitation/create",
    "params": { "mode": "form", "message": "<M>", "requestedSchema": { "type": "object", "properties": {} } } }
  ```

  (on 2025-06-18 omit `mode`, which that version does not have), then holds **until the client's response POST, the
  stream's end, or the Open change's expiry**. It sends `notifications/progress` every 15 s when the call carried a
  `progressToken`, and an SSE comment every 15 s otherwise. The response POST (202, no body) with `accept` applies;
  `decline` and `cancel` close it. The call's result is then written and the stream ends.
  **A stream that ends unanswered withdraws the Open change**; a response that arrives later finds it gone and applies
  nothing.
- Why hold here: the client carries the answer, and ending the call may close its dialog. Why withdraw on a cut stream:
  a client that gives up at 60 s can then ask again at once, and nothing is ever written with nobody watching the result.

#### `model`

Executor's shape exactly, as `pauseOf` (`mcp/elicitation.ts:235`) and `isPausingServer` (:228) read it, so that any
host with ADR-0028's pausing rule hides this server's `resume` and asks its own owner:

- The write tool's result, at once (every version):

  ```json
  { "content": [{ "type": "text", "text": "<M>\n\nThis change waits for approval. Show it to the user, then call resume with requestId and their answer." }],
    "structuredContent": { "status": "approval-required", "requestId": "<change id>",
      "elicitation": { "mode": "form", "message": "<M>", "requestedSchema": { "type": "object", "properties": {} } },
      "expiresAt": "<ISO 8601>" } }
  ```

- `resume`, listed only on the Owner-client endpoint and only when the request's mode is `model`:

  ```json
  { "name": "resume", "inputSchema": { "type": "object", "required": ["requestId", "response"], "properties": {
      "requestId": { "type": "string" },
      "response": { "type": "object", "required": ["action"], "properties": {
        "action": { "enum": ["accept", "decline", "cancel"] }, "content": { "type": "object" } } } } } }
  ```

  It checks the `sub`, that the change's mode is `model`, expiry and revision. `accept` applies (by `agent`);
  `decline` and `cancel` close it. A closed, expired or unknown id is a tool error telling the agent to call the
  original tool again.
- The in-process server for t3flare's own agents never lists `resume` and never returns a Pause, whatever any parameter.

In every mode the Change page can also answer the Open change; the first answer wins.

### D13. The endpoint has its own Access application; the layout follows M0

- **(A) is out**: managed OAuth on the existing `/_t3flare` application. A managed-OAuth token is valid for its whole
  application, so an Owner client's token would get the owner's assertion at `/_t3flare/harness`, where
  `verifyHarnessRequest` admits it alone; the client could fetch the page, read its CSRF token and drive the panel and
  the Change page. The endpoint needs its own application and its own `aud`.
- **(B), if M0 is clean**: a second application `SettingsAccess` on `<host>/_t3flare/mcp` with managed OAuth; the
  `/_t3flare` application untouched; the cookie-path attribute on both. Endpoint `https://<host>/_t3flare/mcp`. In
  `worker.ts` its branch sits before the generic `/_t3flare` branch (:73) and verifies against the new audience
  (`T3FLARE_ACCESS_SETTINGS_AUD`) with a new `verifySettingsRequest` in `access.ts`. "Clean" means all of: Access does
  not answer the host's root well-known documents (P2), the more specific path wins and cookies do not collide (P8), a
  path-scoped `resource` is accepted (P6), and the MCP application's token gets no admitted assertion at the panel's
  path (P12). With (B), the acceptance run also asserts that the root well-known documents are still t3's: Access is in
  beta, and drift there would break t3's own `/mcp` sign-in.
- **(C), otherwise, on every stage including prod**: a Worker `t3flare-settings-<stage>` (`apps/settings-worker`) on
  its own workers.dev host, with its own Access application and managed OAuth on the whole host. Endpoint
  `https://t3flare-settings-<stage>.<subdomain>.workers.dev/mcp`. It verifies its own audience with the shared
  `access.ts` and calls `EnvironmentDO.settingsMcp` through a cross-Worker Durable Object binding (as the agents Worker
  reaches the Environment). It serves nothing else, so ADR-0010's one-host rule for prod's rate limit is untouched. No
  per-stage branches.
- Either way the DO takes an already-verified caller, so moving between (B) and (C) costs only the clients' URL.
- `verifySettingsRequest`: the owner's assertion alone (a `sub` required), or the stage's service token with the admin
  token; in local mode on loopback, the admin token alone (as `verifyAdminToken`), as the service-token caller. Refused
  requests answer 404 and log `settings-refused` with the reason, as admin routes do.
- **Managed-OAuth settings** (`oauthConfiguration` on the alchemy resource): dynamic client registration on;
  `allowAnyOnLocalhost` and `allowAnyOnLoopback` true; `allowedUris` exactly the custom-scheme redirect URIs M0 records
  for the named clients (Cursor), kept in one constant; no https redirect (claude.ai is not a named client);
  `accessTokenLifetime: "15m"`; `sessionDuration: "168h"`. Policies as on the admin application: the owner's email, and
  the stage's service token as `non_identity`.
- The stage's credentials file gains the endpoint's URL.

### D14. Secrets and reads

- No tool argument or result ever carries a secret value or an authorization URL (O8, D6).
- Reads show a secret as `{ set, setAt }` (no fingerprint) and an OAuth sign-in as its status.
- A Direct server's URL is shown without its query string, in the server list and in audit entries read through the
  server: `directUrlProblem` (`index.ts:280`) allows a query, an owner may have put a key there, and `McpView`
  deliberately carries no URL. One helper redacts both.
- The audit log is readable (newest first, 20 by default, 50 at most per call, paged), with the redaction above and the
  owner's Access subject dropped. Variables' values appear, as they do on the page; a Variable is never a credential.
- The registry's refusals (Variable names and values, `directUrlProblem`, sizes) apply unchanged.

### D15. Concurrency and audit

- Every write tool requires `expectedRevision`, the revision of the entity it changes (Harness for extensions and the
  MCP server set; Environment for its settings and for skills). A mismatch is refused with the current revision; the
  agent reads again. Skills pass it to `store.apply`, which must not retry when it is given (`skills/store.ts:240`).
- Every result carries the new revision, so writes can be chained without a read.
- `AuditEntry` gains optional fields; an entry without `via` reads as the panel's:

  | Field | Value |
  | -- | -- |
  | `via` | `"panel"` or `"mcp"` |
  | `caller` (existing) | `agent:<thread>`, `owner:<sub>`, `service-token`, `oauth` |
  | `thread`, `agent` | the calling thread and agent kind (own agents) |
  | `client` | `{ name, source }`, unverified (Owner clients) |
  | `tier` | `"free"` or `"asked"` |
  | `mode` | the Open change's mode, for an asked change |
  | `answeredBy` | `"card"`, `"page"`, `"client"` or `"agent"`; absent for a free change |
  | `change` | the Open change's id |

- The one Workers Logs line per change gains `via`, `tier`, `mode` and `answeredBy`, and still no value.
- Refusals, declines and expiries are log lines, not audit entries: a change's own end (applied, expired) is a
  `settings-change` line with its `outcome`, and a refusal, decline, withdrawal, move or failure a `settings-refused`
  line (one builder, `closedLine` in `settings/changes.ts`; SPI-1200 review).
- No revert tool: the audit log has before and after, and the owner reverts on the panel.

### D16. Caps

All time-based, since the Environment sees no turn boundary for CLI threads. Counted from the changes table (a free
change through the server is recorded there as an already-closed row).

| Cap | Value |
| -- | -- |
| Open changes per own-agent thread | 1; a second asked call is refused, not queued |
| Open changes per Owner `sub` | 2 |
| Open changes across the Environment | 16 (a storage bound; children spawned by `delegate_task` are new callers) |
| The same change (by hash) after a decline, per caller | refused for 10 minutes |
| Three in a row declined or unanswered (own agents), or declined (Owner clients), within an hour of each other | that caller's asked changes are refused for 1 hour from the third |
| Applied changes of any tier, per caller | 30 per hour |

- The caller key is the thread id, or the Access `sub` for every Owner client (the client label is unverified, so
  keying on it would let a client rotate labels).
- In `model`, a refusal for "one already open" names its `requestId`, so the agent can resume or cancel it.
- No extra limit for `model` (O6).
- A refusal for the Environment-wide cap names the panel's Open changes list.
- The open caps are checked again in the same synchronous block as the insert (SPI-1199 review): describing an asked
  change awaits (a skill's preview reads GitHub), so parallel calls could otherwise each pass the first check.
- An install's or update's preview reads GitHub, so it counts toward the network read cap (20 per hour) as
  `preview_skills` does, before it reaches GitHub (SPI-1199 review).

### D17. When a change applies, and the server's surroundings

- Every write result says when it applies:

  | Entity | Text |
  | -- | -- |
  | Harness settings | "Applies at each thread's next turn, this one included. A CLI agent's server list changes at its next process." |
  | Environment settings | "Applies when each Workspace's Container next starts. Not in a Container that is running now, this one included; do not retry to see it." |
  | Environment skills | "Files at each thread's next turn; the listing at the next context window; the composer at once." |

- No apply-now tool: a CLI agent's own process lives in the Container it would restart (ADR-0032 rejected restarts).
- **Code mode**: allowed and judged the same (ADR-0027 §2). A script's second asked change is refused by the one-open
  cap, so scripts sequence them.
- **Safe mode**: the Owner-client endpoint and the Change page answer, as the panel does; none boots t3.
- **Local mode**: the endpoint is admitted with the admin token on loopback (D13). The panel has no local-mode branch
  today and the Change page gets none.
- **Idle**: every held call (a card's wait, the 45 s hold, the `native` stream) counts as open work
  (`Idle.requestStarted`), as `mcpCall` does.
- **What agents are told**: the server's `instructions` and its tool descriptions, and nothing else. They say these are
  t3flare's Harness and Environment settings, not t3's preferences (`t3_environment_preferences_update`), and that some
  changes wait for the owner. No prompt section urges their use.
- **Cutting off a client**: the access switch, or revoking the grant in the Access dashboard. Documented, not built.
- **Interim, M3 only**: until M4 ships, an asked change answers a tool error naming the panel.

### The tools

Thirteen, plus `resume` (D12). Names are the upstream names. Input schemas are generated from the registry (enums for
extension ids, setting names, sizes, Exposures), except that server and skill names are validated at call time, so the
list changes only with a deploy. `tools/list` sets `readOnlyHint` from the class.

| Tool | Class | Input | Answers |
| -- | -- | -- | -- |
| `get_settings` | read | `{ entity: "harness" \| "environment" }` | revision, every setting resolved, each one's limits and tier rule; for the Environment, the running Containers and costs |
| `list_mcp_servers` | read | `{ server?: string }` | the Harness revision and the set (D14's redactions); one server's tools with class, hint and Exposure when named |
| `list_skills` | read | `{ name?: string }` | the Environment revision and the kept skills; one skill's `SKILL.md` and files when named |
| `get_status` | read | `{}` | the panel's Status, the access switch, and this caller's open changes |
| `read_audit` | read | `{ limit?: 1..50, before?: number }` | audit entries, newest first |
| `test_mcp_server` | read | `{ server }` | the panel's test: lists the server now |
| `preview_skills` | read | `{ source }` | the candidates at the resolved commit, with digests |
| `check_skill_updates` | read | `{ names?: string[] }` | per skill: current, or the commit to update to |
| `change_extension` | write | `{ expectedRevision, extension, enabled?, settings? }` | D11's result |
| `change_mcp` | write | `{ expectedRevision, change }`, where `change` is an `McpChange` (`server` with `enabled?`, `exposure?`, `toolExposure?`, `writes?`; `class`; `add` with `url` and `auth: none \| header (with the header's name) \| oauth`; `remove`) or `{ op: "header-value", server }` | D11's result |
| `start_mcp_sign_in` | write | `{ expectedRevision, server }` | D11's result; the sign-in starts in the owner's browser |
| `change_environment` | write | `{ expectedRevision, settings: { … } }` | D11's result |
| `change_skills` | write | `{ expectedRevision, op: "install", source, commit, folders }`, `{ …, op: "update", name, commit }`, `{ …, op: "enable" \| "disable" \| "remove", name }` | D11's result |

No argument is ever a secret: `add` with a header sign-in names the header, and the value is typed on the Change page.

## 4. Milestones

Every push to `main` deploys prod, so each milestone is safe alone. M1 and M2 can run in parallel.

| | Ticket | Content | Exit criteria | Evidence |
| -- | -- | -- | -- | -- |
| M0 | `SPI-1196` | The spike (§6) on a throwaway stage. Its probe code stays on the spike branch; only evidence and the two research files merge. | Every probe has a recorded answer; (B) or (C) chosen; the mode's carrier chosen (query or header); the redirect allowlist fixed; pi's facts known. | `m0-access-oauth.json`, `m0-clients.json`, `m0-pi.json` |
| M1 | `SPI-1197` | D1 (`ops.ts`), D5 (`tiers.ts`, registry fields), D15 (optional `expectedRevision`, audit fields), the set-header op, the URL redaction. No new surface. | The panel behaves as before; the panel's tests pass unchanged except where they gain cases; T-tier, T-ops pass. | a rerun of `m3-panel-safety.json` as `m1-panel-safety.json` |
| M2 | SPI-1076 | D4: pi's relay entries, and the Patch if M0 allows it. | pi lists and calls Commissary and a Direct server through the relay in every runtime mode; T-pi pass. | `m2-cli-pi.json` |
| M3 | `SPI-1198` | D2, D3, D7, D14, D16's applied cap, D17: the Settings server for own agents with reads and free changes; asked changes refused with the panel's link. | Durable and each CLI read and make a free change; plan, linked and unknown-thread refusals hold; T-own, T-caller pass. | `m3-settings-own.json`, `m3-settings-cli-{codex,claude,opencode,pi}.json` |
| M4 | `SPI-1199` | D6, D8, D9, D10, D16: Open changes, the card, the Change page with every diff kind, the secret field and the sign-in start, the panel's list. | An own agent's asked change is approved by card and by page, declined, expired and moved; a secret and a sign-in go through the page; T-open, T-card, T-page pass. | `m4-settings-asked.json`, `m4-change-page-safety.json` |
| M5a | `SPI-1200` | D11, D13, D12's `browser`: the endpoint, its Access application, managed OAuth. | A named client signs in on a workers.dev stage, reads, makes a free change and an asked change approved on the page; T-endpoint, T-guards, T-state pass. | `m5a-settings-owner-browser.json` |
| M5b | `SPI-1201` | D12's `native` and `model`. | Both modes on 2026-07-28 and on a 2025 version, with every fallback of D12's table; T-modes pass. | `m5b-settings-owner-modes.json` |
| M6 | `SPI-1202` | Hostile evidence, the report (`docs/steps/settings-mcp.md`), ADR and doc corrections from what was built. | §5's hostile list recorded; `pnpm run check` passes; the report states every deviation. | `m6-settings-hostile.json` |

## 5. Tests

Unit tests live beside the existing ones (`apps/environment/test`, `packages/harness-registry/src/*.test.ts`,
`apps/agents/test`). Each line is a case that must exist.

**T-tier** (`tiers.test.ts`)
- Every extension switch, every extension setting, every `McpChange` shape, every Environment key and every skills op
  has an expected tier; the test fails when a registry entry or key is not covered.
- A setting with no declared tier is asked.
- A Guard's switch off is asked; every Guard setting is asked.
- Every change to the `settings` entry is asked, `enabled: false` included.
- `class` to read is asked; to write is free; to null follows the hint, and an unknown hint is asked.
- Exposure up is asked and down is free, per tool against its effective Exposure.
- A multi-key Environment change is asked when any key is.
- `needsPage` is `secret` for a header `add` and a header value, `sign-in` for a sign-in start.

**T-ops** (`settingsOps.test.ts`)
- The same change through the panel's handler and through the Settings server gives the same stored state and the same
  audit entry but for `via` and the actor fields.
- `expectedRevision`: a stale one is refused with the current revision; skills do not retry when it is given.
- The set-header op stores the value, audits the mark, and returns nothing of the value.
- A removed server's secrets are gone.

**T-caller** (`settingsCaller.test.ts`)
- A thread with no projection row is `unknown` and its write is refused.
- A linked thread's read runs and its write is refused; a child of a linked thread likewise.
- No mode record: writes refused.
- The mode record follows `open` and `submitTurn` and is cleared at unregister.

**T-own** (`settingsServer.test.ts`, `mcpHost.test.ts`, `mcpRelay.test.ts`, `apps/agents` `mcp` extension test)
- The mode table of D7, every cell, for a Durable and a relayed caller.
- The Session's extension and the relay raise no card of their own for `settings` and still do for every other server.
- The access switch: off removes the server from the view; read-only removes write tools and refuses a write call.
- `resume` is never in the in-process tool list; no result is a Pause.
- Reads never contain a secret value, a fingerprint, a URL's query or an authorization URL.
- A code mode nested call is judged as a direct one.

**T-open** (`openChanges.test.ts`)
- Single use: two answers, one applies.
- Expiry at 10 minutes; lazy pruning two hours after closing (`CLOSED_KEPT_MS`, SPI-1199 review).
- Each answerer rule of D8's table, and a wrong `sub`.
- A moved revision closes as `moved` and applies nothing.
- Two changes open against one revision: the first accept applies, the second is `moved`.
- The record survives a new store instance (an Environment reset between ask and answer).
- A skill install whose digest changed at apply is refused.
- Every cap of D16, and that a dropped stream or an expiry is not a strike for an Owner client.

**T-card** (`settingsCard.test.ts`)
- The card is an `approval` card with no field, and its id carries the marker `refuseOwnerOnly` matches.
- The prompt has the server-written parts and the Guard and hint-trust lines when they apply.
- A change that needs the page has no Approve.
- The page answering first withdraws the card and the call returns `applied`.
- A Stop withdraws the Open change.

**T-page** (`changePage.test.ts`, with `harnessPage.test.ts`)
- Each kind of D10's table renders escaped; a hostile value (`<script>`, a bidi control) is inert.
- The POST is refused without JSON, with a wrong `Origin`, without the CSRF token, and for a GET.
- The secret value appears in no response, log line, audit entry or stored record.
- The sign-in's authorization URL goes only in the page's own response.
- The page's CSP is hash-only and its script hash matches.

**T-endpoint**, **T-guards**, **T-state** (`settingsEndpoint.test.ts`)
- Version negotiation for each supported version; an unsupported method is `-32601`.
- 2026: capabilities read from `_meta` on each request; 2025: from the session token; a forged, other-`sub` or missing
  token reads as no elicitation.
- Each guard of D11's table; `Sec-Fetch-Mode` alone is not refused.
- The panel's audience at the endpoint and the endpoint's audience at the panel are both refused.
- `requestState`, the session token and the elicitation id: tampered, expired, another `sub`, another `kind`, and a
  retry whose arguments differ are all refused and apply nothing.

**T-modes** (`settingsModes.test.ts`)
- `browser`: the 2026 `input_required` shape; the 45 s hold answering `applied`, `declined` and `waiting`; a late
  `decline` POST on 2025 withdraws; the link-in-result fallback.
- `native`: the 2026 form round trip; a retry without a response asks again; the 2025 held stream with `accept`,
  `decline`, `cancel`; progress when a token was sent; a cut stream withdraws and a later `accept` applies nothing;
  2025-06-18 has no `mode` in the params.
- `model`: the Pause's exact shape (`pauseOf` reads it as a pause); `isPausingServer` is true of a tool list that
  includes this `resume`; `resume` with each action; another `sub`'s, another mode's, an expired and an unknown id.
- Every row of D12's fallback table, and `elicitation_mode=natve` answering 400 at `initialize`.
- A change that needs the page, in `native` and in `model`, gets the link and no form or Pause.

**T-pi** (`cliProfiles.test.ts`)
- T-pi-1: `mcp.json` has one entry per relay server with the URL, header, timeout and Exposure of D4; the handle is in
  the environment and in no file; the fork launch has no `mcp.json`.
- T-pi-2 (stage): a repository whose `.pi/mcp.json` names `settings` at another URL with `${T3FLARE_TOOL_HANDLE}`; pi
  still lists the relay's server and nothing reaches the other URL.

**Stage, hostile** (`m6-settings-hostile.json`)
- An injected agent asking repeatedly is stopped by the caps; 17 children leave the 17th refused.
- An agent in a Container, and in the Preview browser, opening the Change page's URL gets Access's login, not the page.
- A leak scan finds a typed secret nowhere but the secret store.
- An Owner client's token presented at the panel's path is refused.
- In `model`, an agent approving its own change is applied and audited with `answeredBy: "agent"`.
- t3flare's own agents, by Session and by each CLI, see no `resume` and no Pause from this server.
- A parent agent cannot answer a child's card (`t3_pending_request` refused).
- Turning the access switch off through the server: the next call finds no server, and only the panel turns it back.

## 6. M0: the spike

On a throwaway workers.dev stage, never `prod`. No credential file is read; tokens pass through the environment and are
never printed. The stage serves a debug echo at the candidate endpoint paths that prints header names, redacted values
and the decoded claims of `Cf-Access-Jwt-Assertion`.

**From `docs/research/access-managed-oauth.md` (run as written there):**

| Probe | Question |
| -- | -- |
| P1 | Baseline before managed OAuth: the 302 and the origin's well-known answers. |
| P2 | Which URLs Access answers once managed OAuth is on: the root and path-inserted well-known documents, `/cdn-cgi/access/*`, and the 401's `resource_metadata` and its `resource`. |
| P3 | How Access classifies a non-browser client (Accept, `Sec-Fetch-*`, User-Agent). |
| P4 | A browser with no cookie still gets the 302. |
| P5 | The service token still works; 401 or 403 for a bad one. |
| P6 | The OAuth flow end to end with each `resource` variant; token lifetime; refresh-token rotation. |
| P7 | What the origin receives: `Authorization`, the assertion's claims, any OAuth-specific claim. |
| P8 | Two applications on one host: which wins per path, and the cookies' names and paths. |
| P9 | P2 and P6 on a workers.dev host. |
| P10 | Whether the authorization server supports Client ID Metadata Documents. |
| P11 | The bounds of the two lifetimes. |

**Added by this design:**

| Probe | Question | Decides |
| -- | -- | -- |
| P12 | Does a token issued for the endpoint's application get an admitted assertion at `/_t3flare/harness`? | (B) is allowed only if not |
| P13 | Is `sub` the same in an OAuth-derived assertion and the same user's browser assertion on the other application? | the page's answerer check (`sub` or email) |
| P14 | Each named client (Claude Code, Cursor, pi 1.5.2, Codex, OpenCode) end to end: the protocol version it negotiates; its redirect URI, exactly; whether it sends `Origin`, `Sec-Fetch-Site`, `Sec-Fetch-Mode`; which elicitation kinds it declares; its tool-call timeout; what it does when a call ends with its page prompt still open; what it does on a 45 s hold; what it does with a form on a held stream and when that stream is cut; whether it retries an `input_required` | the allowlist, the guards, D12's holds and fallbacks |
| P15 | Does `?elicitation_mode=…` on the endpoint's URL survive each client's discovery, registration, authorization and token exchange under Access (RFC 9728's `resource` must equal the URL used)? If not, does a configured request header reach the origin? | the mode's carrier |
| P16 | pi in the image, under its profile: does `PI_OFFLINE=1` stop MCP connects; does `--mode rpc` load built-in MCP; is `mcp.json` read from `PI_CODING_AGENT_DIR`; does `${T3FLARE_TOOL_HANDLE}` expand in a header; does a 900 s held call finish; does pi's `bash` see the handle; how does pi label a built-in MCP tool's source to an extension's `tool_call` hook | D4, the Patch |
| P17 | A real 2026-07-28 client's requests, captured: `server/discover`, the `_meta` keys, `resultType`, whether client info travels per request | D11 |

If `PI_OFFLINE=1` stops MCP connects, drop it from the profile and confirm in the same probe that pi then reaches
nothing but the model proxy and the relay (ADR-0012).

## 7. Files

New:
- `apps/environment/src/harness/ops.ts`
- `apps/environment/src/settings/server.ts`, `tools.ts`, `openChanges.ts`, `render.ts`, `endpoint.ts`, `tokens.ts`
- `apps/environment/src/harness/changePage.ts` (and its script constant beside `pageScript.ts`)
- `packages/harness-registry/src/tiers.ts`
- `apps/settings-worker/` (layout (C) only)
- `patches/0006-pi-relay-tools-are-judged-by-the-relay.patch` (if M0 allows)
- the test files named in §5

Changed:
- `packages/harness-registry/src/index.ts`, `mcp.ts`, `environment.ts`, `fields.ts` (kind, reserved name, implied
  entry, `writes`, `guard`, `tier`)
- `apps/environment/src/harness/panel.ts`, `page.ts`, `pageScript.ts`, `store.ts`
- `apps/environment/src/skills/store.ts` (the expected revision)
- `apps/environment/src/mcp/host.ts`, `relay.ts`
- `apps/environment/src/environmentDO.ts` (`mcpCall`'s `thread`, `settingsMcp`)
- `apps/environment/src/provider/adapter.ts` (`threadLinkOf`, the mode record)
- `apps/environment/src/access.ts`, `worker.ts`, `alchemy.run.ts`
- `apps/environment/src/agents/cliProfiles.ts`
- `apps/agents/src/extensions/mcp.ts`, `apps/agents/src/session/SessionDO.ts`, `apps/agents/src/environment.ts`
- `apps/environment/scripts/stage.ts` (the stage, the endpoint's URL in the credentials file)

Docs, at M6 unless already done with this plan:
- done with this plan: ADR-0034; refinement notes on ADR-0026, 0028, 0032, 0033; GLOSSARY.md; the stale pi lines of
  `docs/steps/tools.md`;
- a second ADR after M0 for the endpoint's Access application (it refines ADR-0010 and ADR-0026 §1–2, and ADR-0014 if
  (C)): done as ADR-0035 (layout (B), pending owner step 1; SPI-1200 review);
- `docs/upstream-fragility.md`: pi's `mcp.json` shape and trust flags, the Patch, Access managed OAuth's beta behaviour,
  the 2026-07-28 shapes the endpoint hand-writes: done as U66-U69 with M2-M5b;
- both research files updated with M0's answers: done at M6 ("M0's answers" in each);
- the report `docs/steps/settings-mcp.md`, including how to connect a client: done at M6, its evidence owed.

The hostile list's map (each line to its tests and its stage item) is in the report; what the stage run records is
`docs/steps/settings-mcp/m6-stage-run.md`.

## 8. Facts an implementer must check

Each was read on `origin/main` at 747905d; check it still holds before building on it.

| Fact | Where |
| -- | -- |
| The panel's handlers and their order of validate, save, audit | `apps/environment/src/harness/panel.ts:162`, `:258`, `:287`, `:306`, `:336`, `:366` |
| The panel's write guard, and that the owner needs `Origin` and CSRF | `panel.ts:146` |
| A removed server's secrets are deleted at once | `panel.ts:317` |
| `mcpOverview` returns a secret's mark with its fingerprint | `panel.ts:76`; `apps/environment/src/harness/secrets.ts` |
| The audit entry's shape, the 1,000 kept, the log line | `apps/environment/src/harness/store.ts:22`, `:30` |
| The CSRF key's pattern for a DO-held key | `store.ts:86` |
| The registry's change functions and types | `packages/harness-registry/src/index.ts:57`, `:258`, `:264`, `:280`, `:295`, `:395` |
| `guardian` and `permissions` entries | `index.ts:152`, `:210` |
| The Environment schema and its change function | `packages/harness-registry/src/environment.ts:84`, `:171` |
| `decideCall`, `ServerKind`, reserved names, the server-name pattern, the relay's input | `packages/harness-registry/src/mcp.ts:15`, `:29`, `:88`, `:90`, `:108` |
| `CLI_TOOL_TIMEOUT_SEC`, `TOOL_HANDLE_ENV` | `mcp.ts:102`, `:105` |
| `cardText` and its bound | `packages/harness-registry/src/cardText.ts` |
| The host's `view`, `call`, question wait, pausing logic | `apps/environment/src/mcp/host.ts:41`, `:298`, `:328`, `:463`, `:492` |
| The relay's judge and its tool filter | `apps/environment/src/mcp/relay.ts:43`, `:94` |
| A zero-field form is an approval card; card ids; the pause detection | `apps/environment/src/mcp/elicitation.ts:59`, `:173`, `:228`, `:235` |
| An agent cannot answer a card of ours | `apps/environment/src/mcp/ownerOnly.ts`; `environmentDO.ts:296`, `:934` |
| `McpAsker` (`ask`, `withdraw`), `McpQuestionCard`, the marker | `packages/session-protocol/src/index.ts:385`, `:399`, `:420` |
| The Session's asker and its `withdraw` | `apps/agents/src/extensions/mcpQuestions.ts:88` |
| The Session's `mcp` extension judges and asks | `apps/agents/src/extensions/mcp.ts:70`, `:79`, `:94` |
| The Session calls `mcpCall` with no thread | `apps/agents/src/session/SessionDO.ts:485`; `apps/environment/src/environmentDO.ts:479` |
| The Session's mode and link come from the adapter at `open` and `submitTurn` | `SessionDO.ts:154`, `:734`, `:755`; `apps/environment/src/provider/adapter.ts:314`, `:449` |
| `linkedWorkOf` returns null for a missing row | `adapter.ts:83` |
| CLI thread state, the relay's cards, the question asker, the 10-minute wait | `apps/environment/src/provider/cli/cliAsk.ts:39`, `:45`, `:56`, `:62`, `:89` |
| The wrapper registers each CLI thread's asker; pi goes through it | `apps/environment/src/provider/cli/wrapper.ts:272`; `piDriver.ts:124` |
| pi's launch, its agent directory, `PI_OFFLINE`, the fork launch, `--no-approve`, its settings | `apps/environment/src/agents/cliProfiles.ts:243`, `:279`, `:304`, `:312`, `:314`, `:342` |
| The relay's context reaches every profile; pi's handle | `cliProfiles.ts:55`, `:59`; `apps/environment/src/agents/cliProcess.ts:92`, `:110` |
| Codex's relay entries and its hidden handle | `cliProfiles.ts:95`, `:134` |
| The image's pi and its MCP package | `apps/sandbox-image/image/cli/package.json:6`; `package-lock.json:469` |
| pi's MCP configuration, trust and flags | pi 1.5.2's `docs/mcp.md`, `docs/security.md`, `docs/cli.md`, `docs/settings.md` (the laptop's install of the same version) |
| t3's pi extension asks for every tool it does not know as read-only | `t3code/packages/provider-pi/src/server/mcpExtensionSource.ts:29`, `:346`, `:361` |
| Access: the guard, the panel's check, the admin check, the local-mode token | `apps/environment/src/access.ts:94`, `:197`, `:208`, `:226` |
| The Worker's routing, and that only the generic admin branch has local mode | `apps/environment/src/worker.ts:32`, `:59`, `:63`, `:76` |
| The Access application and service token per stage, the configured host | `apps/environment/alchemy.run.ts:112`, `:133`, `:137`, `:286` |
| The panel RPC never boots t3 | `apps/environment/src/environmentDO.ts:378` |
| Skills: the write routes, the request budget, the retry on a moved revision | `apps/environment/src/skills/api.ts:12`, `:195`; `apps/environment/src/skills/store.ts:240` |
| The SDK stays in the MCP Worker | `apps/mcp-worker/test/sdk-isolation.test.ts` |
| The 2026-07-28 client-side shapes in the vendored core | `vendor/cloudpid/mcp/src/connection.ts` (`input_required`, `inputResponses`, `requestState`, `resultType`) |
| Executor's three modes and its pause shape | `docs/steps/spi-1079-plan.md` §0; `docs/upstream-fragility.md` (Executor's pause) |
| The stage list and the credentials file | `apps/environment/scripts/stage.ts:32` |

## 9. Not verified, and what each would change

| Not verified | If it is false |
| -- | -- |
| Access leaves the host's root well-known documents alone, prefers the more specific path, and accepts a path-scoped `resource` (P2, P6, P8) | layout (C) |
| A token for one application is refused at another's path (P12) | (B) is out; with (C) the hosts differ, so it holds by construction |
| `sub` is the same across applications (P13) | the page checks the email |
| A query parameter survives OAuth under Access (P15) | the mode travels in a header |
| The named clients declare the elicitation kinds the research file lists, and tolerate D12's holds (P14) | per-client fallbacks to the link in the result |
| An empty `requestedSchema` is shown as accept and decline by the named clients | `native` needs a one-boolean form; decide in M5b from P14 |
| pi's built-in MCP runs under the profile (`PI_OFFLINE`, `--mode rpc`) (P16) | drop `PI_OFFLINE`; if RPC mode cannot load it, stop and report |
| pi's commands can read `T3FLARE_TOOL_HANDLE` | nothing changes; it is the accepted residual either way |
| How pi labels a built-in MCP tool's source (P16) | no Patch; pi asks more |
| The 2026-07-28 shapes beyond those quoted in the research file (`server/discover`, complete results' `resultType`, per-request client info) (P17) | follow the spec's `schema.ts` |
| Non-browser HTTP clients send `Sec-Fetch-Mode` but neither `Origin` nor `Sec-Fetch-Site` (P14) | narrow or widen D11's refusal per the record |
| A child thread of a linked thread carries the link's origin (GLOSSARY, Linked work) | T-caller's child case fails; treat any thread whose parent is linked as linked |

## 10. Risks

- **`model` and `native` do not prove the owner answered** (O6). Whatever holds an Owner client's token can make every
  Settings change except typing a secret or completing a sign-in, with no person involved. ADR-0034 records it. The
  audit's `mode` and `answeredBy` are the only trace.
- **A token read over an Outbound link.** A cloud agent that reaches the Laptop Environment could read an Owner
  client's stored token there and use `model`. The owner-only card holds only while no agent of ours can obtain such a
  token.
- **Access managed OAuth is in beta.** Its discovery behaviour may change under (B); the acceptance assertion on the
  root well-known documents detects it within a day.
- **The hand-written 2026-07-28 handling** rests on a new spec version. M0's capture and T-endpoint bound it; D11 names
  the fallback.
- **The Patch** touches t3's pi extension and may not survive a nightly bump; without it pi only asks more.
- **Card fatigue.** Every widening asks. The caps bound the count, not the owner's attention.
