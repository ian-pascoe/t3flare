# pi ports 1: web tools, todo and context management for the Durable agent (report)

Date: 2026-11-13. Branch `ports`, from `main` at 854cc9e. Tickets: SPI-1054 (web), SPI-1055 (todo), SPI-1056
(context). t3code is untouched (pinned at d8f3feff). Port source: cloudpid@93ba45a3 `packages/extensions/src/`
(`web*`, `todo*`, `context*`), cited in every file header. Evidence: [`pi-ports-1/`](pi-ports-1/). Stage harness:
`apps/environment/scripts/ports.ts`. Throwaway stage `ports`, added to `STAGES` and destroyed at the end. Parity rows:
[`docs/pi-parity.md`](../pi-parity.md). Fragility: [U53](../upstream-fragility.md#u53-the-pi-harness-ports-in-t3s-thread-and-web-search-through-the-proxy-spi-1054-spi-1055-spi-1056).

## What was built

Three harness-registry entries. Each shows in the Harness panel with no panel work (ADR-0026), and the Session installs it
from the resolved settings before code mode and tool search, so their namespaces and deferral cover the new tools. Each
port is cloudpid's code as plain pi-durable tools and hooks: cloudpid's are Effect tools, and t3flare's extensions are
Promise code (`coding-tools.ts`, `files.ts`). Rules, limits and texts are unchanged except where noted.

| Entry | Default | Settings | Tools | In t3 |
| --- | --- | --- | --- | --- |
| `web` (SPI-1054) | on | `search` (off), `searchModel` (`claude-haiku-5-5`) | `web_fetch`; `web_search` when `search` is on | t3's `web_search` item: the query or URL as `patterns`, each page as a result |
| `todo` (SPI-1055) | on | none | `todo` | `todo_list` rows and the turn's `todo_list` plan (parity G5) |
| `context` (SPI-1056) | on | `rolloverOnCompaction` (on) | `context_notes`, `context_history`, `context_rollover` | tool items titled by what they did (`Notes: write "plan"`, `History: search`, `Context rollover: …`) |

The core preset of offered tools now includes all six, so they are direct. Code mode gets two namespaces: `web`
(`web_`) and `context` (`context_`). `context_rollover` is model-only, as in cloudpid.

### Web (SPI-1054)

- **`web_fetch`** is cloudpid's: the Worker's own `fetch` through cloudpid's SSRF guard (every hop checked, hosts
  resolved over Cloudflare's DoH, redirects by hand, 5 MiB bound), HTML to Markdown through htmlparser2 (added with
  `relock`), and line paging. It is free and on by default. Browser Rendering was not needed: plain fetch is already a
  Cloudflare service of the Worker, and costs nothing.
- **`web_search` provider, in the order asked:**
  1. **Commissary first.** Commissary has no built-in search toolkit. Its built-ins are the browser and the sandbox,
     and catalog toolkits such as Exa or Tavily need the org's own keys. It does serve search-capable models: an
     Anthropic Messages request with the server tool `web_search_20250305` is passed to a Claude upstream, or
     translated to a Codex upstream's own `web_search` (`translator/codex/claude/request.ts`). Either way the answer
     comes back as `web_search_tool_result` blocks.
  2. **Chosen.** `web_search` asks that search-capable model through the model proxy, with the Workers-only
     `MODEL_PROXY_API_KEY` the agents Worker already holds. It never enters a Container (ADR-0016), and the owner adds
     no secret.
  3. **Output.** The results are written in Exa's `Title:`/`URL:` shape, so cloudpid's result budget applies as-is
     (`shaping.ts`), followed by the model's cited summary. The call's token usage goes on the result.
- **Off by default.** Each search is a model request on the proxy's spend. The owner turns it on in the panel; see
  [For the owner](#for-the-owner).

### Todo (SPI-1055)

- **The list** is a pi-durable conversation document (`t3flare.todo`) in the Session DO's storage, with cloudpid's limits:
  200 Tasks, all-or-nothing batches, at most 20,000 characters as the model reads it. A compaction or rollover leaves it
  where it is.
- **cloudpid's projection hooks** put it back in front of the model: once per Context Window, the same bytes on every
  request. After a script's nested calls, it is appended to the script's result. A note is added when the list shown is
  stale.
- **In t3.** The Session pushes `todo {rev, tasks}` with its state (`SessionState.todo`). The differ emits each change as
  a `todo_list` row and a `plan.updated` of kind `todo_list`, in OpenCode v2's shape:
  - step ids are `todo:<task id>`, so t3's ingestor times each step;
  - an `active` Task is t3's `running`;
  - the `todo` calls themselves are not shown unless they fail.

  Capabilities: `emitsTodoList` and `emitsPlanUpdated` are now true.

### Context management (SPI-1056)

- **Notes** are a pi-durable document (`t3flare.context`) in the Session DO's storage. They are bounded tighter than
  cloudpid's, because the document is one stored value: 64 Notes of 32,000 characters, 256,000 characters in all, and a
  Handoff of at most 32,000.
- **History** reads the Session's stored entries in pages of 200, each page its own read:
  - `windows` and `list` keep one line per entry;
  - `search` stops once its page of matches is full;

  so a long thread is never held in memory whole. `read` returns 2,000 characters of the entry's JSON at a time.
- **No `lineage` scope.** A Durable agent has no subagents in its Session; t3's delegated threads are Sessions of their
  own.
- **Rollover** is cloudpid's: `context_rollover` alone in its round saves the Handoff and returns `control.handoff`.
  pi-durable then writes a `pi.reset` and continues the run, steered with "continue from the Handoff".

**Reconciling the compactions:**

- pi-durable's compaction stays the mechanism: its thresholds, its cut, and its overflow recovery.
- With `rolloverOnCompaction` on, the `beforeCompact` hook changes only the summary:
  - a background threshold compaction is declined, and the agent is asked once per window to update its Notes and roll
    over;
  - a blocking or overflow compaction is an Emergency Rollover from the last saved Handoff;
  - a manual compaction keeps pi-durable's summary.
- With the setting off, or the extension off, pi-durable summarizes as before.
- t3's idle compaction is locked off for every provider (K9) and never reaches the Session.
- **Changed from cloudpid:**
  - There is no owner `/rollover`, since t3 has no surface for it.
  - The steers the hook and the tool submit carry `whenIdle: "reject"`, so they never start a run t3 did not start.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm run check` (32 tasks: typecheck, lint, tests of every package, workspace and lock) | **pass** | the run at f30b1a4, before the stage work |
| Unit: web (`apps/agents/test/web/*`: cloudpid's content, SSRF, output and JSON tests copied; `tools.test.ts` for fetch through the guard, the challenge retry, bounds, paging, and search through the proxy, key redaction and failures) | **pass** | 161 tests |
| Unit: todo (`test/todo.test.ts`: batches in a real Harness, revisions, bounds, the window projection and stale note) | **pass** | 4 tests |
| Unit: context (`test/context.test.ts`: Notes in a real Harness and their bounds; rollover, then History across the Handoff; not-alone refusal; the compaction hook's four decisions) | **pass** | 6 tests |
| Unit: differ (`apps/environment/test/differPorts.test.ts`, every item and the plan decoded with t3's own schemas) | **pass** | 5 tests |
| Unit: registry and panel (`index.test.ts`, `harnessPage.test.ts` and its snapshot) | **pass** | |
| Stage: harness API turns web search on; the resolved settings show the three entries | **pass** | [`settings.json`](pi-ports-1/settings.json) |
| Stage: a Durable turn uses `web_search` (through Commissary) and `web_fetch`; t3 shows two `web_search` items with the pages | **pass** | [`turns.json`](pi-ports-1/turns.json) `web` |
| Stage: a turn adds three Tasks and updates them three times; t3 shows four `todo_list` rows (`ppp rpp crp ccc`) and one plan, completed, with step durations | **pass** | `turns.json` `todo` |
| Stage: a Note is saved in one turn and read back in a later turn, which answers the codeword | **pass** | `turns.json` `note-save`, `note-read` |
| Stage: `context_rollover` hands off (`pi.reset` and `t3flare.context-continue` in the Session); the same turn goes on in the new context, reads the Note and answers | **pass** | `turns.json` `rollover`, `session` |
| Stage: a turn after the rollover searches History from before the Handoff | **pass** | `turns.json` `after-rollover` |
| Stage destroyed | **pass** | `stage.ts destroy ports` exit 0 |

**Not proven on the stage:**

- **Compaction as Rollover.** Its threshold and overflow paths would need a context near its limit. It is unit-tested
  on the hook (SPI-1095).
- **The todo projection after a script's nested `todo` calls.** It is unit-tested only through the pure parts.
- **The panel's rendering.** It is checked by the page test and snapshot, not by a screenshot.

## Code review

Done here in two passes, Standards and Spec, without sub-agents: this agent may not spawn them. The fixes are in the
last commit.

**Standards**

- **Fixed:** none needed beyond lint and the effect diagnostics.
- **Judgement calls, kept:**
  - **Possible Duplicated Code.** `SEARCH_MODELS` restates three ids of `packages/models/src/models.json`. The registry
    takes no dependency on the models package, and an enum needs fixed values.
  - **Primitive Obsession.** The plan id is a long derived string (`plan:piDurable:<session>:todo:<provider turn>`). t3
    takes any non-empty string, and it is stable across re-diffs.
  - **Speculative Generality.** `WebTransport` exists only so tests can answer requests without a network, as in
    cloudpid.
- **Repo standards followed:**
  - cloudpid citations in every file header;
  - no t3code change;
  - the lock changed only through `node scripts/relock.ts`;
  - guards in the tools: these tools need none, since none writes the Workspace.

**Spec**

- **All asked:**
  - registry entries with schemas and defaults;
  - code mode namespaces;
  - the items in t3 through the differ;
  - the provider chosen in the asked order, with no new secret;
  - Notes and History in the Session DO's storage, bounded;
  - the compactions reconciled;
  - unit tests per port;
  - a stage with real turns, then destroyed;
  - parity rows updated.
- **Deviation:** `web_search` is off by default. Each search costs a model request, and the brief says "on unless it
  costs money".
- **Added, not asked:**
  - `rolloverOnCompaction`, so the owner can keep pi-durable's own summary;
  - the `extensionOf` helper: a Session whose stored settings predate a new entry gets that entry's defaults, so a
    deploy is safe before the next settings read.

## For the owner

- **Web search.** It is off by default because each search is a model request on Commissary's spend. Turn it on in the
  Harness panel: Web tools, then Web search. `searchModel` picks the model; Haiku is the default and worked on stage. No
  key is needed.
- **Follow-up filed:** SPI-1095, prove compaction as Rollover (threshold and overflow) on a stage with a small context window.

## Commits

- 5d63ce0 SPI-1054: the web tools
- c61518d SPI-1055: todo
- f30b1a4 SPI-1056: context management
- the stage harness, evidence, docs and this report (the branch head)
