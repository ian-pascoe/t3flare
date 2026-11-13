# pi ports 2: Terminals, the Guardian and the Advisor for the Durable agent (report)

Date: 2026-11-13. Branch `ports2`, from `main` at fe6aedb. Tickets: SPI-1057 (termctrl), SPI-1058 (guardian), SPI-1059
(advisor). t3code is untouched (pinned at d8f3feff).

- **Port source.** The owner's extensions, ian-pascoe/pi-extensions@a5e15d1: `packages/pi-termctrl`, `pi-guardian`,
  `pi-advisor` and `pi-utils/evidence.ts`, cited in every file header. cloudpid has no code for any of the three
  (cloudpid@93ba45a3 `docs/architecture/agent-capabilities.md` lists them as v2 or impossible without a PTY), so
  there is no cloudpid commit to cite.
- **Evidence:** [`pi-ports-2/turns.json`](pi-ports-2/turns.json).
- **Stage harness:** `apps/environment/scripts/ports2.ts`. Throwaway stage `ports2`, added to `STAGES` and destroyed
  at the end.
- **Parity rows:** [`docs/pi-parity.md`](../pi-parity.md).
- **Fragility:** [U54](../upstream-fragility.md#u54-the-second-pi-harness-ports-agent-terminals-the-guardian-and-the-advisor-spi-1057-spi-1058-spi-1059).

## What was built

Three harness-registry entries, which appear in the Harness panel. The Session installs them from the resolved
settings before code mode and tool search, as in pi-ports-1. Each is the owner's code adapted to plain pi-durable
tools and hooks. Rules, limits and texts are pi's, except where noted.

| Entry | Default | Settings | What it adds | In t3 |
| --- | --- | --- | --- | --- |
| `termctrl` (SPI-1057) | on | `backgroundBash` (on), `cols` 120, `rows` 40 | `terminal_start`, `terminal_send`, `terminal_stop`, `terminal_list`, `terminal_wait`; `bash`'s `background` | `command_execution` items ("Terminal t1", "Typed into t1") with the screen; titled tool items for read, stop, list and wait; exit notices |
| `guardian` (SPI-1058) | off | `model` (Haiku), `thinkingLevel` (off), `tools`, `commands`, `policy` | a `beforeTool` hook | the blocked call fails; a "Guardian blocked bash" notice gives the risk and reason |
| `advisor` (SPI-1059) | off | `model` (inherit), `reviewEvery` (turn), `thinkingLevel` (high), `correctiveTurns` (1) | `afterTools` and `onYield` hooks, a private Advisor Session | "Advisor nit/concern/blocker" notices; the agent reads "Advisor concern: …" |

**Other changes:**

- **Panel.** The registry has a new setting type, `text` (with `multiline`), for the Guardian's rules and Security
  Policy, typed as pi-guardian's `/guardian` menu takes them (`git push=deny, npm test=allow`). The panel draws it as an
  input or a text area.
- **Code mode.** It gets a `terminal` namespace (`terminal_`).
- **Offered tools.** The core preset now offers the five terminal tools directly.
- **Notices.** The differ shows the ports' own entries (`t3flare.advice`, `t3flare.guardian`, `t3flare.terminal-exit`)
  as t3's `system_notice` on a `system` node, as t3's Pi provider shows its notices.

### Terminals (SPI-1057)

- **Where they run.** A Terminal is a PTY in the Workspace's Container, under a second instance of t3flare's
  `TerminalHost` (ADR-0021): the platform's PTY exec, a `term-agent-<session>-t1` marker, the kill script, and the
  Container hold measured from input.
- **What changes from t3's terminals.**
  - The host's output goes to `AgentTerminals` in the Workspace DO (`workspace/agentTerminals.ts`), not to t3's terminal
    adapter. It renders each entry's screen with a headless xterm, which plays the role of termctrl's driver.
  - Nothing heartbeats these entries. They end when the agent stops them, when the Container stops (its idle stop, once
    input is older than the hold), or when the Workspace DO restarts.
  - Input is not held until a prompt (`holdFirstInput: false`).
  - The wrapper runs `bash -c <command>` (`terminalCommand`'s new `command` form).
- **Kept from pi-termctrl:**
  - parameters, defaults and clamps (2 s, 500 ms, 30 s, 5 min);
  - settle reasons and `wait_for_text` (a literal, or `/regex/`);
  - the key names;
  - the result text: the first line, the Screen Delta, "screen unchanged", scrolled-off lines without repeats, cut to
    100 lines or 16 KB with the first and last kept, and the gap notice;
  - exits that stay readable until stopped;
  - `terminal_list`'s sections and `terminal_wait`'s reasons;
  - exit-notification texts;
  - `bash`'s `background: true`: it waits 2 s, then answers as `bash` or returns "Command moved to the background as b2",
    with a log in the Container at `/tmp/t3flare-jobs/`.
- **The wait runs in slices.** It runs in the Workspace DO, in 5 s slices, so a wait costs a few RPCs. Between slices the
  tool checks the conversation's inbox, so a queued steer ends the wait as `steered` (the Steer Yield).
- **Approvals follow the thread's mode, as `bash`'s do** (`permissions.ts`):
  - `terminal_start` and a `terminal_send` that types are commands, so `approval-required` and plan mode ask;
  - a poll, `terminal_stop`, `terminal_list` and `terminal_wait` never ask.
- **Exit notifications.** An exit the agent has not seen is told after the next tool round, as a steer with
  `whenIdle: "reject"`. After the answer it becomes a note, which the next turn reads. It never starts a run: pi-termctrl
  would start a turn when idle, but t3 owns the runs here.
- **Limits.**
  - **Cap.** At most 8 entries run at once per Workspace (ADR-0021's cap, separate from t3's own 8), against termctrl's
    16 per process.
  - **Container start.** Nothing starts a Container until a Terminal or job starts, so the extension is on by default.
- **Not ported:**
  - the `/ps` panel and its footer (SPI-1098);
  - Ctrl+B, and moving a running `bash` to the background on a steer;
  - full-output files on the Worker: a cut result says to use `bash` or redirect;
  - the `shellPath` settings.

### Guardian (SPI-1058)

- **Where it sits.** A pi-durable `ToolTask` `beforeTool` hook. It runs before the call's intent, and so before any t3
  approval card (`permissions.ts` wraps the tool inside the call). It sees code mode's nested calls (`call.parent`),
  each judged with its issuing script as context. It sits beside t3's approvals and replaces nothing: a call the
  Guardian allows still asks the owner when the mode says so.
- **Kept from pi-guardian:**
  - the Tool Policy precedence: a `deny` Command Rule, then the configured Tool Policy, then the built-in default, then
    a read-only tool, else review;
  - the allowed and reviewed lists, with the Durable agent's own read-only tools added (`ask_user`, `terminal_list`,
    `terminal_wait`, a `terminal_send` poll, MCP read tools, t3 tools with `readOnlyHint`);
  - Safe Commands with their argument checks, and Command Rules (longest prefix, wrappers, the quote-agnostic deny),
    with `shell-syntax.ts` copied unchanged;
  - Sensitive Path names;
  - the built-in policy prompt (copied);
  - reasoning-blind evidence: trusted user messages and untrusted tool calls;
  - the Reviewed Call with its arguments' SHA-256, its batch and its issuer;
  - the corrective retry, the Decision Table, and the Escalation Pass before a Rejection stands;
  - pi-guardian's rejection text to the agent;
  - fail-closed handling: a Review Failure blocks, and invalid settings block everything but the read-only built-ins.
- **Changed for t3flare:**
  - **The model.** It is reached through the Session's own proxy models (`api.models.completeSimple`), so no key is
    needed. The default is Haiku with thinking off, as pi-guardian's README recommends.
  - **Memo.** A review is memoized per call, so a restart does not ask again.
  - **Audit.** A block writes a data-only `t3flare.guardian` entry (never sent to the model), which t3 shows as the
    notice.
  - **Paths.** Sensitive Paths are judged lexically against `/workspace/repo`.
  - **Linked threads.** A linked thread's user messages are untrusted, as a Child Agent's are.
  - **The Advisor's continuation** is never trusted as the user's.
- **Not ported (SPI-1096):**
  - **`cd`.** No `cd` is proved harmless: pi-guardian checks the file system synchronously, so every `cd` is reviewed.
  - **Allow once** (`onDeny: "ask"`). t3's cards are the owner's interactive gate.
  - Also: the classifier First Pass, pre-reviews of parallel calls, the Rejection Streak, User Overrides and
    delegations, and token calibration. Evidence is bounded at 96,000 characters, the newest untrusted entries first.

### Advisor (SPI-1059)

- **The Advisor Session.** It is a conversation of its own in the Session's Harness. Its agent has:
  - the Advisor model (`inherit` follows the thread's);
  - pi-advisor's default Advisor Prompt;
  - only the coding, file and permission extensions, with `read`, `grep`, `find` and `ls`;
  - 8 investigative rounds.

  The Advisor's own hooks are not selected there, so it cannot observe itself. Its first Review gets a Context Seed:
  the original request, then the newest turns within 150,000 characters, never splitting a turn. Later Reviews get only
  new entries, as pi-advisor's Review Evidence, with refs and tool results capped at 4,000 characters.
- **Cadence (`afterTools`).**
  - `turn` reviews after each round that is not read-only.
  - `N` reviews every N rounds.
  - `request` reviews only at the end.
  - An errored tool result starts a Review at once.
  - Reviews run one at a time in the background.
  - A backlog of 3 makes the agent wait up to 30 s for the Review under way.
- **The final drain (`onYield`).** It runs while the run is still open: the Review under way finishes, then the rest of
  the backlog is reviewed, so the findings land in the turn t3 shows.
- **Findings.**
  - Each must cite a ref the Advisor was given, or a quote.
  - At most 4 per Review.
  - Nits are capped at 3 per request.
  - A repeat is delivered again only at a higher severity.
  - A Concern waits out a 3-turn cooldown.
- **Delivery, as pi-advisor's:**
  - **A Concern or Blocker during the run** steers it, as `Advisor concern: …`, with `whenIdle: "reject"`.
  - **A Nit, or a finding after the answer,** is a note: a pi-durable write, which never starts a run.
  - **A Blocker found at the end** continues the same run once (`correctiveTurns`), through `onYield`'s `continue`.
    This is pi-advisor's Corrective Turn, inside the run t3 started.
- **Failures.** A failed Review pauses the Advisor until its settings change, with an "Advisor paused" notice. The agent
  keeps running.
- **Record.** Each Review is recorded as a data-only `t3flare.advisor-review` entry (pi-advisor's status entry).
- **Changed: the report is a final JSON answer, not an `advisor_report` tool.** pi-durable selects every installed
  extension for the thread by default, so the tool would also be offered to the agent.
- **Not ported (SPI-1097):**
  - `advisor_ask` consultations;
  - Superseded Findings' re-validation;
  - token calibration;
  - Advisor Session compaction: a Session past about 300,000 characters starts over from a seed;
  - Child Agents.

  The Advisor Session's cost is not in t3's usage.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm run check` (32 tasks) | **pass** | at 9104acb. An earlier run hit a timing flake in `apps/mcp-worker/src/engine/results.test.ts` (`byteStream`), a package this branch does not touch; the rerun passed |
| Unit: Terminals' Workspace half (`test/agentTerminals.test.ts`: settle reasons, cursor, scrolled-off lines, exit, stop, wait, cap, jobs and their log, unseen exits once, the `bash -c` wrapper on a real bash) | **pass** | 5 tests |
| Unit: Terminal tools on a real Harness (`test/termctrl.test.ts`: start, type, poll, a timed-out pattern with a Screen Delta, stop; `bash` background quick and long; an exit told after the round; approvals ask for start and typing, not a poll) | **pass** | 4 tests |
| Unit: Guardian (`test/guardian.test.ts`: pi-guardian's Safe Command, Command Rule and Sensitive Path cases; the hook on a real Harness: Rejection with escalation and audit entry, escalation that allows, Safe Command unreviewed, `deny` rule, Review Failure, invalid settings, a script's nested call) | **pass** | 43 tests |
| Unit: Advisor (`test/advisor.test.ts`: a `turn` Review steers the running agent; `request`: a Nit note, and a Blocker continues the same run once; unsupported findings dropped; a failed Review pauses without stopping the agent) | **pass** | 4 tests |
| Unit: differ (`test/differPorts2.test.ts`, every item decoded with t3's schemas), registry (`index.test.ts`), panel (`harnessPage.test.ts` and its snapshot) | **pass** | |
| Stage: a Durable thread starts the Node REPL with `terminal_start`, types `6*7`, types `.exit`, waits and stops; t3 shows "Terminal t1", "Typed into t1" ×2, "Waited for…", "Stopped t1", and the reply says 42 | **pass** | `turns.json` `terminal` |
| Stage: the Guardian is switched on through the panel API (`POST /_t3flare/harness/api/extensions`, 200); `rm -rf --no-preserve-root /` is reviewed by Haiku and rated critical (destruction) with high authorization, which the Decision Table rejects whatever the authorization (the Escalation Pass that follows a would-be Rejection is not recorded in the entry), so it is blocked; t3 shows the failed command and "Guardian blocked bash" with the risk and reason; the agent quotes the rejection | **pass** | `turns.json` `guardian`, `session.guardian` |
| Stage: the Advisor is switched on through the panel API (Sonnet, `turn`); after a tool round, a nit appears in t3 as "Advisor nit", citing the call's ref and quoting the command | **pass** | `turns.json` `advisor`, `session.main.ports` |
| Stage destroyed | **pass** | `stage.ts destroy ports2` exit 0 |

**What the stage run taught:**

- **The Guardian's thread is approval-required.** The agent refused, twice, to send `rm -rf /` when nothing but the
  Guardian stood in the way. In approval-required mode, with the harness declining every card, it did send the call.
  The Guardian blocked it before any card was raised.
- **The output check was moved.** t3's wire projection leaves a command's output out (`outputOmitted`). The stage
  therefore checks the rejection in the Session's tool result and in the agent's reply, not in the item's output.
- **The Advisor reported nothing until there was a real defect.** It stayed silent through three prompts where the
  agent behaved well, or did exactly what the user asked. Each silence is recorded as `t3flare.advisor-review` with
  `reported: 0`. It spoke once the agent chained commands the user had not asked for.

**Not proven on the stage:**

- a Concern or Blocker steering a live run, and the corrective continuation (unit-tested);
- Background jobs and exit notifications in a real Container (unit-tested over a fake PTY host);
- the Steer Yield, and the Guardian on a code mode script's nested call (unit-tested).

## Code review

Done here, in two passes (Standards, then Spec), without sub-agents: this agent may not spawn them.

**Standards**

- **Fixed in review:**
  - The Guardian trusted the Advisor's corrective continuation, which pi-durable places as a user message. It is now
    untrusted (`guardian/evidence.ts`; pi-guardian never trusts an Advisor).
  - A lint fix: the text field no longer stringifies an object.
  - An unused parameter.
- **Judgement calls, kept:**
  - **Possible Duplicated Code.** `policy.ts` restates pi-guardian's `lexWords` and program table instead of copying
    `safe-command.ts`, whose `cd` and environment logic does not apply here. `shell-syntax.ts`, `prompt.ts` and the
    assessment are copies, so a sync from pi-guardian stays a diff.
  - **Feature Envy.** `SessionDO.#readOnlyTool` reads the MCP view and t3's catalog for the Guardian. Those are the
    Session's stores, and the extension stays free of them.
  - **Primitive Obsession.** Tool Policies and Command Rules are text in the panel, parsed by `parseEntries`. This is
    the owner's own menu syntax, and it keeps the panel generic.
  - **Middle Man.** `backgroundJobs` adapts the terminal host to `coding-tools`' `bash`. It exists so the permissions
    wrap stays outside `bash` (codingTools is reinstalled in place).
- **Repo standards followed:**
  - source citations in every file header;
  - no t3code change;
  - the lock changed only through `node scripts/relock.ts` (`@xterm/headless` 6.0.0, MIT);
  - the fragility entry and parity rows updated;
  - follow-up tickets filed with the `linear` CLI.

**Spec**

- **All asked:**
  - the owner's five terminal tools and Background jobs as PTYs under t3flare's terminal host;
  - approvals that follow the mode;
  - command items in t3;
  - termctrl on by default, since nothing starts until used;
  - the Guardian as a pi-durable hook covering nested calls, blocking with the reason in t3, off by default, with the
    model and reviewed tools set in the panel, beside the approvals;
  - the Advisor as a background reviewer on a proxy model, with attributed advice as notices plus steers or notes, off
    by default, with model and frequency settings, never a run t3 did not start;
  - unit tests per port;
  - the stage with all three checks, then destroyed;
  - parity rows.
- **Deviations, each reasoned above:**
  - the Terminal cap is 8 per Workspace, not 16;
  - no `cd` proving and no Allow once for the Guardian;
  - the Advisor reports as a final JSON answer, not with `advisor_report`;
  - no `advisor_ask`.
- **Added, not asked:**
  - the `text` setting type;
  - the `t3flare.advisor-review` record;
  - the reviewers' decision logs;
  - the "Advisor paused" notice.
- **Decisions taken here:**
  - **Advice shows as a notice item, not as a user message.** pi-advisor's Interventions are attributed custom
    messages with an "Advisor" label, not user text. The agent still reads the steer or note.
  - **The Guardian defaults to Haiku with thinking off.** pi-guardian's README measured Haiku at about 1.4 s per review,
    against Opus at 6–17 s.
  - **The Advisor's corrective continuation is kept,** inside the run t3 started.

## For the owner

- **Guardian.** Turn it on in the Harness panel: Guardian, then the switch.
  - **Default model.** Haiku reviewed in a few seconds on stage.
  - **Rule syntax.** Rules are `name=allow|review|deny` pairs, as in your `/guardian` menu.
  - **Hard limits.** Put limits that must not depend on a model in Command Rules, for example `git push=deny`.
- **Advisor.** Turn it on in the panel. Each Review is a model request on the proxy's spend.
  - `request` is the cheapest cadence.
  - `turn` finds problems sooner.
  - Its usage is not counted in t3's token meter.
- **Follow-ups filed:**
  - SPI-1096: Guardian `cd` proving and Allow once through t3's card.
  - SPI-1097: Advisor consultations and the rest of pi-advisor.
  - SPI-1098: show agent Terminals in t3; test the xterm internals.

## Commits

- 420f601 SPI-1057: Terminals and Background jobs
- 8e86e1a SPI-1058: the Guardian
- 7d33d0c SPI-1059: the Advisor
- 8fa4ce7 the stage harness and stage `ports2`
- faf12c5 the Guardian never trusts the Advisor's continuation; parity rows; fragility U54
- 9104acb stage evidence; the Advisor's review record; decision logs
- the branch head: this report
