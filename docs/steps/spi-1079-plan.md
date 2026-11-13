# Plan: SPI-1079, MCP elicitation and approval requests reach the owner as t3 cards

Branch `spi1079` (worktree `.worktrees/spi1079`), from `main` at 6c4aa4c. Stage `spi1079`. Refines ADR-0028 (its item 9,
"Elicitation is not declared", and OD-T7/OD-T11 of `docs/steps/tools-plan.md`).

## 0. Goal

The owner wants Executor's **"Through your agent"** (`model`) and **"In your client"** (`native`) approval modes, so an
MCP server's question must reach him as a t3 card on the calling thread, and only his answer may go back. Neither the
Durable agent nor a CLI agent may answer it, resume it, or see the id that would let it.

What each Executor mode needs (Executor's docs, `executor.sh/docs/mcp`, and its MCP host's tests):

| Mode | What the server does | What t3flare must do |
| --- | --- | --- |
| `native` ("In your client") | sends `elicitation/create` (form) on the open `call`/`execute` request; no `resume` tool; `call` is marked destructive, so the client's confirmation of `call` is the approval | declare elicitation on agent calls and answer it from a card (case 1). `call` is already a write tool: the existing card is its approval |
| `model` ("Through your agent", the default) | `call`/`execute` return `structuredContent: { status: "approval-required" \| "input-required", requestId, elicitation: { mode: "form", message, requestedSchema, _meta? }, expiresAt }`; the agent is told to show it and call `resume({ requestId, response })` | t3flare recognises the pause, raises the card itself and calls `resume` on the owner's behalf; the agent never sees the `requestId` and cannot call `resume` (case 2) |
| `browser` (today's) | the result carries an `approvalUrl`; `resume({ requestId })` waits for the owner's answer in Executor's page | unchanged |

## 1. What stock t3 does (the shape to copy)

- **Codex** (`CodexAdapterV2.ts` `mcpServer/elicitation/request`, `CodexMcpElicitation.ts`): an approval-shaped
  elicitation becomes an `approval_request` card of t3's own `requestKind: "mcp-elicitation"`, buttons Cancel / Decline /
  Approve; a URL or a form it cannot fill is declined.
- **ACP** (`provider-acp/src/server/elicitationForm.ts` `parseElicitationForm`): a form becomes a `user_input` card, one
  question per field (choices as options, booleans as true/false, text and numbers as a custom answer); a URL goes to the
  flavor's `onUrlElicitation`.
- Elicitation always asks, in every runtime mode (it is the server's question, not a tool permission).
- `t3_pending_request respond` answers `user_input` requests only ("cannot approve a permission request"); a delegated
  child's question wakes the parent agent and tells it to answer (`DelegatedTaskQuestionReactor`).

So the cards are t3's own: `mcp-elicitation` approval cards for confirmations and pages, `user_input` cards for forms.
The one gap against the owner's rule is that an agent can answer a `user_input` card.

## 2. Design

**D1. One live path in the MCP host.** `McpHost.call` takes the caller's `ask` and makes every agent call with
`ctx.answers = { elicitation: true, inputWaitMs: 10 min }` and an `onInput` hook (the vendored core's Legacy and
Modern questions, answered live while the call waits; no `defer`, so no `ResumeState` is kept). The host turns each
question into a **card spec** (D5's checks first) and back into the server's `ElicitResult`. Both callers only render
cards and return the owner's answer. The panel's test and inventory lists declare nothing.

- Limits: the engine pauses the call's 270 s bound while a question waits; a question waits 10 minutes (cloudpid's
  Legacy wait, = the CLI card's `CLI_ASK_MS`); at most 10 questions per call (the core's cap). A Worker or DO waiting on
  I/O has no wall-clock limit while its caller is connected; CLI tool timeouts are 900 s (ADR-0028). Commissary's 240 s
  cap (SPI-1083) does not apply to a question: Commissary's own approval questions are Modern rounds, each a new
  request, and Commissary forwards no upstream elicitation.
- A Session or Environment restart ends a waiting call (its RPC chain breaks): the card closes as cancelled, a read is
  run again by pi-durable's replay (and asks again), a write answers "cut off" as today. No durable Modern resume
  (cloudpid's `defer`) in this step.
- `-32042` (URL required, Legacy) stays the server's error; a ticket for `livePages`.

**D2. Card kinds** (pure module `packages/harness-registry/src/elicitation.ts`, used by both Workers):

- a **form with no fields** (a confirmation gate) and an **Executor `approval-required`** → `mcp-elicitation` approval
  card: Approve / Decline / Cancel;
- a **URL** → `mcp-elicitation` approval card that shows the page's link and host: "Opened it" (accept) / Decline /
  Cancel. Stock declines URLs; showing the link is SPI-1079's ask;
- a **form with fields** and an **Executor `input-required`** → `user_input` card, one question per field, as
  `parseElicitationForm` builds them (re-implemented over the vendored normalizer, since provider-acp does not export
  it). The answers are typed by field and checked with the core's `validateElicitation`; an invalid answer is a
  `cancel` with a note.
- Every card's text goes through `cardText` and names the server, the tool and the call's arguments.

**D3. Durable agent.** The `mcp` extension passes an `ask` function with `mcpCall` (Workers RPC carries it); the host
calls it per question. The Session raises the card from memory, not from its durable stores: a pending
`mcp-elicitation` approval or a multi-question `PendingQuestion` (session-protocol gains `kind: "mcp-elicitation"`
and `questions`), pushed as today; the differ renders them; the adapter's answer reaches the waiting `ask`. The answer
is never written to the Session's storage. Stop, a turn's end and a restart withdraw the card.

**D4. CLI agents.** The relay passes an `ask` that raises the card through `cliAsk.ts` on the calling thread's live
turn, as tool cards are. The asker grows a `user_input` card (runtime request `user_input`, item `user_input_request`,
the answer's `answers`) and an approval card's `requestKind`. The CLI's HTTP request is held meanwhile; the relay still
declares nothing to the CLI and never forwards an elicitation.

**D5. cloudpid ADR-0041's rules, as ported.**

| Rule | Ported? | Why |
| --- | --- | --- |
| Only the owner answers; the agent has no way to answer, list or decline | **yes** | the owner's own requirement. Approval cards already cannot be answered by `t3_pending_request`. A `user_input` card raised for an MCP question carries the marker `t3flare-elicit` in its id, and the Environment refuses a `t3_pending_request` `respond` (and `read`) naming it, on `/mcp` and on the Durable `mcp()` RPC, before t3 sees it. Executor's `resume` is hidden (D6) |
| Declared on every agent call, no per-server switch | **yes** | a server that finds no elicitation may take it as consent (MongoDB's and Relativity's servers do) |
| A form whose field ends in a credential word is declined unseen | **yes** | the spec forbids it, and t3's event log keeps every `user_input` answer (platform: we cannot keep it out) |
| A page not on HTTPS, on a private or local host, or on t3flare's own host is declined | **yes** | the owner's browser cannot reach a server's private host; our own host would pass the panel's same-origin checks |
| The answer is never kept | **partly** | t3flare keeps none (D3, D4: memory only; logs name fields, never values). t3 keeps the card's answer in its event log, as for every question (platform) |
| Values checked against the Session's Secrets | **no** | t3flare Sessions hold no Secrets |
| Malformed or over-bound forms refused | **yes** | the core's normalizer, as-is |

Not taken as a reason anywhere: prompt injection alone (owner's stance).

**D6. Executor-style pauses ("Through your agent").** Server-agnostic, in `McpHost.call`:

- A server is **pausing** when it lists a `resume` tool whose input has both `requestId` and `response` (Executor's model
  mode; browser mode's `resume` takes only `requestId`, so it is untouched).
- A result whose `structuredContent` is a pause (`status` `approval-required` or `input-required`, a `requestId`, a
  form `elicitation`) is turned into a card (D2: approval or form, with Executor's message, its `_meta`, and the agent's
  call: tool and arguments), and t3flare calls `resume({ requestId, response })` with the owner's answer (an approval as
  a bare `{ action: "accept" }`), until the result is not a pause (at most 16 rounds). The agent gets only the final
  result; a pause it cannot answer (no live turn) comes back as an error without the `requestId`.
- A pausing server's `resume` is **hidden** from agents (the view and the relay's `tools/list`), and a call of it is
  refused: t3flare performs it on the owner's behalf.
- The owner's answer is the only way in: full access does not skip the card (an elicitation always asks, as in stock).
  `call` and `execute` still follow the thread's mode as write tools.

Considered: refusing the agent's `resume` until an owner's card was answered (an "unlock" per `requestId`). Rejected:
the agent still holds and relays the request, the `requestId` reaches the model, and a second round needs a second
unlock; performing `resume` in the host is one loop and matches how `native` mode feels.

**D7. Who pays.** Nothing new runs per call without a question: the host's extra work is a `structuredContent` check
on results of pausing servers only. No new Worker, binding, secret or storage.

## 3. Fixture and stage proof

`fixtureMcp.ts` (stage-only Worker) grows, answering Legacy questions over SSE on the `tools/call` response (the
client's answer is a POST correlated by id, held in its Durable Object):

- `fixture_ask` (form: a choice, a text and a boolean; records what it got in its log), `fixture_confirm` (empty form),
  `fixture_page` (URL mode), `fixture_password` (credential field: must be declined unseen);
- `/executor-mcp`: `call` (write), `execute` (write), `resume` (`requestId` + `response`): `call` returns a model-mode
  pause, `resume` with `accept` appends a line to the log, `decline` appends nothing.

`scripts/spi1079.ts` (stage harness, like `tools.ts`), evidence in `docs/steps/spi-1079/`:

1. Durable thread: `fixture_ask` approve (the card's answers reach the fixture's log), decline (nothing recorded);
   `fixture_confirm` approve; `t3_pending_request respond` on the card refused.
2. Codex thread: the same pair through the relay.
3. URL: `fixture_page` shows its link (Durable); `fixture_password` declined without a card.
4. Executor-style: Durable (and Codex if quick) `call` → t3flare card with app, tool and arguments → accept → `resume`
   ran once (log line); decline → no line; the agent's `resume` refused and absent from its tools.

Stage `spi1079` added to `STAGES`, destroyed at the end.

## 4. Files

- `packages/harness-registry/src/elicitation.ts` (+ test): card specs, answer conversion, URL check, Executor pause
  parsing.
- `apps/environment/src/mcp/host.ts`: `ask`, `onInput`, the pause loop, `resume` hidden; `mcp/relay.ts`: the relay's
  `ask`; `provider/cli/cliAsk.ts`, `wrapper.ts`: `user_input` and `mcp-elicitation` cards; `environmentDO.ts`:
  `mcpCall` takes `ask`, the `t3_pending_request` fence; `provider/differ.ts`, `adapter.ts`: multi-question and
  `mcp-elicitation` views.
- `packages/session-protocol`: `PendingApproval.kind` `mcp-elicitation`, `PendingQuestion.questions`.
- `apps/agents/src/extensions/mcp.ts`, `session/SessionDO.ts`: the Session's live asks.
- Tests: `mcpHost.test.ts`, `mcpRelay.test.ts`, `cliCard.test.ts`, `mcpExtension.test.ts`, differ tests, a fence test.
- Docs: ADR-0028 refinement ("Elicitation, SPI-1079"), GLOSSARY, fragility (U37 grows; new entries for the
  `t3_pending_request` fence and Executor's pause contract), `docs/steps/spi-1079.md`.

## 5. Risks

- t3's web card for `mcp-elicitation` with custom options, and `user_input` with several questions from a non-ACP
  provider, are untested here: stage by eye on the web client, with the projection as evidence.
- The fence parses JSON-RPC at our edge: a batch or a renamed tool (U42) would pass it. A bump test pins the tool's name
  and `respond`'s shape.
- Executor's real pause and `_meta` are known from its docs, tests and pi-mcp-adapter, not from a live run (the owner is
  away): the fixture mirrors them; a real run is a follow-up ticket.
