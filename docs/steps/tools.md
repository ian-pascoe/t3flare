# Tools step: report (code mode, Commissary and owner-added MCP tools, t3's tools for CLI agents, the Harness panel)

Date: 2026-11-12. Branch `tools`, rebased on `origin/main` at e5cd0a2 (SPI-992/1040 and SPI-1061's pre-items). t3code
pinned at 24e7747 and untouched (Shadows 2, Patches 3). Throwaway stage `tools`, added to `STAGES`. Plan:
`docs/steps/tools-plan.md`. Its "Review changelog" (Fable review H1–H4, M1–M13, LOW items) and the owner's decisions at
implementation override its body. Evidence: `docs/steps/tools/`. Stage harness: `apps/environment/scripts/tools.ts`.

## What was built

- **Code mode and tool search for the Durable agent (ADR-0027).**
  - Scripts run in pi-codemode's QuickJS VM in a sandbox Worker, `t3flare-codemode-<stage>`, through
    `RemoteCodemodeSandbox`. The VM is capped at 16 MiB.
  - Every nested call goes through the same guarded tool as a direct call. Modes, linked threads and the push gateway
    apply unchanged.
  - A card raised by a script names the script. At most 8 asks per script are pending at once (M8).
  - Approvals inside a script survive Session restarts.
  - Nested calls show in t3's thread as child items (`LiveSlim.nestedTools`, the differ's children, omitted calls).
  - Every card follows one text rule (`cardText.ts`, M2): full text up to 16 KiB, then a marked truncation, with controls
    and format characters escaped.
  - Default preset: core tools + code mode + tool search (OD-T4).
- **The Harness panel (ADR-0026).**
  - Served only on its own admin host. The `HarnessAdmin` entrypoint is reached from a forwarder Worker,
    `t3flare-admin-<stage>`, behind its own Access application. The t3 host answers 404 (H4).
  - Shows extensions (live toggles), MCP servers (add, test, sign in, remove, exposure, class overrides, the "offered to
    linked threads" switch, default off per M13) and an audit log.
  - Protected by CSRF and Origin checks against the configured host. Its CSP allows only the page's hashed script.
  - Header secrets are write-only. Fingerprints are HMACs.
- **The MCP host and engine (ADR-0028).**
  - The Environment DO's `McpHost` keeps inventories, protocol state, class pins and credentials.
  - Every list and call goes through the MCP Worker `t3flare-mcp-<stage>`. It runs the vendored cloudpid MCP core
    (`packages/mcp`, at 93ba45a3), has no bindings, sets `global_fetch_strictly_public`, uses manual redirects and
    scrubs credentials.
  - Caps per server: 200 tools, 256 KiB of schemas.
  - Classes are pinned by definition hash (H3):
    - A direct server's tools are write until the owner marks them read.
    - A Commissary hint that flips under a changed definition stays write until the owner confirms.
- **Commissary as a tool source.**
  - One server entry with the Workers' proxy key (`MODEL_PROXY_API_KEY`, read through one accessor; decision 1).
  - No Commissary approval rules (OD-T3).
- **Direct servers (decision (b)): the D5 exception for MCP servers only, recorded in ADR-0012.**
  - Header sign-in, or OAuth: DCR or CIMD, PKCE, single-use 256-bit state, `iss` check, one refresh in flight.
  - The callback and the client document are on public exact paths under an Access Bypass application (M4,
    ADR-0010 refinement).
- **The `mcp` extension (Durable).**
  - Tools are named `mcp__<server>__<tool>`, with per-server and per-tool Exposure (`direct`, `deferred`, `codemode`,
    `hidden`). Code mode has namespaces.
  - `decideCall`, one function for every caller:
    - reads run;
    - writes follow the mode (plan refuses, full access runs, otherwise ask);
    - a linked thread's every write asks, for that call only (decision 3, M10);
    - a write cut off by a restart is never sent again.
- **The CLI relay (parts 2 and 3, SPI-1039).**
  - The route is `computer.internal/t3flare/mcp/<server>` in `WorkspaceProxy`.
  - Each process gets its own tool handle, issued at `processStart` and revoked at exit. No handle is in a
    Container-wide file (H2).
  - The Environment's relay server is hand-written: `initialize`, `ping`, `tools/list`, `tools/call`.
  - Calls are judged by the strictest mode among the Workspace's live threads (M7).
  - A tainted Workspace is judged as linked, and t3's own tools refuse a tainted owner handle (H1).
  - A write's card is raised on the CLI thread by the wrapper (SPI-1040's asker, generalised). It never offers the push
    card's trust answer (M9).
  - CLI tool timeouts are 900 s (M11).
  - Who gets what: Codex, Claude Code and OpenCode get t3's tools, Commissary and direct servers. The pi CLI gets t3's
    tools only: it has no MCP client in the image (SPI-1076).
- **t3's guidance for CLI agents (SPI-1060's rule).** It moved to `packages/harness-registry/src/t3Guidance.ts`, and the
  relay's t3 `tools/list` applies it.
- **Fixtures, test stages only.**
  - A fixture MCP Worker with `fixture_echo`, `fixture_note`, `fixture_unknown`, `fixture_inject`, `fixture_slow`,
    `fixture_elicit` and `fixture_flip`, plus a fixture OAuth authorization server.
  - The owner added `fixture` as a Commissary toolkit once.

## Exit criteria

| Criterion (plan §7 as changed by the review) | Result | Evidence |
|---|---|---|
| **M0 P1** codemode Worker deploys (alchemy bundle) and runs scripts | **pass** | `m1-codemode.json` (every later script case) |
| **M0 P2** subrequest depth: nested `bash`, Commissary reads, CLI relay | **pass, implied**: every nested and relay case ran with no depth error; no dedicated 50-in-a-row run | m1, m2, m4, m5 files; SPI-1078 |
| **M0 P3** cost per nested call | **reported**: 338 ms per nested call in 100 sequential calls (gate 150 ms). Breakdown: read 267 ms, `bash true` 194 ms, a t3 read 77 ms; two Workspace RPCs per read. The recommendation stands | `m0-p3-cost.json`, `m0-p3-breakdown.json`; SPI-1066 |
| **M0 P4** token counts of the presets | **pass** (informs the default): code-mode-only 3.9k, core 21.7k, everything 21.7k input tokens | `m0-p4-tokens.json` |
| **M0 P5** approval inside a script across two Session restarts | **pass**: 2 restarts, 1 card, the command ran once | `m0-p5-restart.json` |
| **M0 P6** t3 shows nested child items | **pass on web, by eye** (and in m1's item tree); desktop not checked | `m1-codemode.json` `childrenNested`; SPI-1078 |
| **M0 P7** Claude Code tool search through Commissary for a non-Claude model | **not run** | SPI-1078 |
| **M0 P8** each CLI accepts its MCP entry; 10-minute held call | **entries pass** (all four CLIs list and call through the relay); **10-minute hold not run** (timeouts set to 900 s) | `m5-cli-*.json`; SPI-1078 |
| **M0 P9** a repo `opencode.json` cannot replace the system entry | **not run** (the handle is never in the repo; OpenCode allows the relay's tools by MCP origin) | SPI-1078 |
| **M0 P10** Commissary's MCP fidelity (eras, progress, 240 s cap) | **partly**: reads, writes and annotations through Commissary pass; the 240 s cap and progress were not measured | `m4-commissary-durable.json`; SPI-1078 |
| **M0 P11** vendored MCP core in workerd | **pass, implied**: every Commissary, direct and OAuth case runs through it | m4, m6 files |
| **M0 P12** t3's adapters take the relayed `McpProviderSessionConfig` | **pass** for Codex, Claude Code, OpenCode, Pi (`t3_thread_list`) | `m5-cli-*.json` |
| **M0 P13** OAuth's public paths | **pass**: only the callback and the client document are public on the admin host | `m6-oauth.json` |
| **M0 P14** sandbox lost mid-approval; concurrent memory-heavy scripts | **pass**: the script fails closed (the command cancelled, never run); 4 concurrent scripts hit the 16 MiB cap as a script error | `m0-p14-sandbox-loss.json`, `m0-p14-memory.json` |
| **M1** unit (§2.3 table per row, replay across restart, differ children) and stage (read, grep, edit, test in one script; parent and children; checkpoint has the edit) | **pass** | `apps/agents/test/codemodeGuards.test.ts`, `apps/environment/test/differNested.test.ts`; `m1-codemode.json` |
| **M2** hostile scripts H1 (plan), H2 (caps, 200 concurrent writes, session acceptance), H3 (bypass), H6 (self-approval), H7 (restart) | **pass** (7/7) | `m2-hostile-script.json`, `m2-h6-proof.json` |
| **M2** H4 linked writes from a script | **pass** under M5's linked-writes run (Durable at a full-access link: a card per write, one acceptance covers one call) | `m5-linked-writes.json` |
| **M2** H5 linked taint and nested `git push` | **not run as a script case** (the gateway and taint are SPI-992's, unchanged; nested `bash` is the guarded `bash`) | SPI-1078 |
| **M3** unit: registry schema, settings, CSRF and Origin, no-echo, audit masking | **pass** | `packages/harness-registry/src/*.test.ts`, `apps/environment/test/harnessPanel.test.ts` |
| **M3** panel safety on stage | **pass** (10/10): service token with and without the admin token, Access at the edge, forged assertion, t3 host 404 on both paths, t3 session cookie refused on both hosts, cross-origin and form-encoded refused, CSP | `m3-panel-safety.json` |
| **M3** panel safety from a Container, a linked laptop's MCP bearer, a Worker Shell `fetch` | **not run** (the panel is not on the t3 host or `computer.internal`: the t3 host 404 covers the route) | SPI-1078 |
| **M3** exit: the panel lists extensions, adds the fixture server and tests it | **pass**: 6 tools shown, 49 ms | `m6-direct-setup.json` |
| **M4** Commissary for Durable: read runs; write asks (approval-required, auto-accept-edits), runs (full access), refused (plan); unknown class asks; injection writes nothing | **pass** (7/7) | `m4-commissary-durable.json` |
| **M4** inventory rename; Commissary unreachable; 401 names the key; key-leak scan | **not run** (unit-tested: `mcpHost.test.ts`) | SPI-1078 |
| **M4** OAuth for direct servers: sign-in, single-use state, `iss`, list, refresh once | **pass** (5/5) | `m6-oauth.json` |
| **M5** unit: handle (wrong Workspace, revoked, replayed), relay `tools/list` and `tools/call` decisions, card inject and withdraw, CLI profiles | **pass** | `apps/agents/test/{mcpRelayRoute,processHost}.test.ts`, `apps/environment/test/{mcpRelay,cliToolAsk,acpProfiles}.test.ts` |
| **M5** per CLI: read, write approve and decline, full access, plan, t3's tools | **pass**: Codex, Claude Code and OpenCode 6/6 each; pi 1/1 (t3's tools only) | `m5-cli-{codex,claude,opencode,pi}.json` |
| **M5** linked writes (D1): Durable and Codex at a full-access link, a card per write, one acceptance covers one call, declined writes nothing | **pass** (2/2) | `m5-linked-writes.json` |
| **M5** relay hostile: no or forged handle 401; stolen owner handle (accepted risk) and taint asks per call; t3's tools 403 on a tainted handle; replay after exit 401 | **pass** (5/5) | `m5-relay-hostile.json` |
| **M5** `m5-key-exfil.json`, `m5-injection.json` on CLI and linked threads, two same-CLI threads in different modes | **not run** | SPI-1078 |
| **M6** direct servers (Durable): the same seven cases as M4 | **pass** (7/7) | `m6-direct-durable.json` |
| **M6** classes: owner marks read; a direct server's read hint stays write; a flipped Commissary hint stays write until confirmed | **pass** (3/3) | `m6-direct-classes.json` |
| **M6** disable mid-turn; secret hash absent from scans | **not run** (write-only and no-echo unit-tested) | SPI-1078 |
| **M6** Executor (direct, owner-attended; owner decision: added in the panel, not through Commissary) | **pending**: waiting for the owner's sign-in | `m6-executor.json` (to come) |
| **M7** ADRs, GLOSSARY, parity, fragility, model-proxy, README, this report | **pass** | see Documents |
| **M7** `acceptance --tools` in the bump job | **not done** | SPI-1077 |
| `bun run check` | **pass** at the branch head | — |
| Stage destroyed | **pending** (after Executor; the owner removes Commissary's `fixture` toolkit) | — |

## Findings worth keeping

- **A nested call costs ~340 ms**, mostly in two Workspace RPCs per `read`. Code mode still wins on tokens (P4) and turns.
  SPI-1066.
- **The pi CLI has no MCP client** in the image, so it gets t3's tools only. SPI-1076.
- **Codex's linked full-access run** was read once before its turn ended. The harness now waits for four quiet polls
  before it counts a linked thread as settled (`tools.ts`).
- **A stolen owner handle** (root in the Container reads `/proc`) is judged as that owner thread. This is the accepted
  risk of plan §3.2. Once the Workspace is tainted, the handle's writes ask per call and t3's tools refuse it (H1).
- **Results are text only.** Image blocks become `[image content]` placeholders, and resources are not listed.
  SPI-1082.

## Deviations from the plan

- **The tools key is the Workers' proxy key** (owner decision 1), not `COMMISSARY_TOOLS_API_KEY`.
- **Executor is a direct server added in the panel** (owner decision at wrap-up), not a Commissary toolkit (§5.5's
  Route A). OAuth uses DCR at `app.executor.sh` in `browser` elicitation mode (OD-T11).
- **The relay's MCP server is hand-written in the Environment**, not the SDK's `McpRelayServer` in the MCP Worker. The
  MCP Worker keeps no inbound entrypoint.
- **Evidence files are split** into `m6-direct-setup`, `m6-direct-durable` and `m6-direct-classes` instead of one
  `m6-direct.json`.
- **Unrun stage cases** are listed in the table and ticketed (SPI-1078). Their logic is unit-tested.

## Counts (ADR-0001)

t3code untouched at 24e7747. Shadows 2, Patches 3 (unchanged). No Build shim: the MCP SDK and QuickJS live in Workers
of our own. New reliance on t3 internals: U40 (code mode and pi-codemode), U41 (nested items), U42 (t3's MCP through
the relay), U43 (the CLIs' MCP configuration), U44 (the MCP SDK pin, the vendored cloudpid core, Commissary's
contract), and U49's new path (t3's guidance in harness-registry).

## Tickets

- New:
  - SPI-1076 pi CLI: MCP servers other than t3's.
  - SPI-1077 `acceptance --tools` in the bump job.
  - SPI-1078 the stage cases left unrun.
  - SPI-1079 MCP elicitation as t3 cards (OD-T7).
  - SPI-1080 read-only harness tools (OD-T9).
  - SPI-1081 per-Project harness overrides.
  - SPI-1082 MCP resources and non-text content.
  - SPI-1083 MCP tasks for calls over 240 s.
  - SPI-1084 defer t3's own tools (~8k tokens).
  - SPI-1085 sync the vendored cloudpid MCP core.
- Existing: SPI-1066 (nested-call latency).
- Commented, to close when `tools` lands: SPI-1039 (done), SPI-1001 (MCP half done; skills stay deferred), SPI-1037
  (its MCP item done).

## Documents

- ADR-0026 (the Harness panel), ADR-0027 (code mode), ADR-0028 (the MCP host).
- Refinements to ADR-0010, 0012, 0014, 0015, 0016, 0020, 0022 and 0024.
- GLOSSARY "Tools".
- `docs/parity.md`, `docs/pi-parity.md`.
- `docs/upstream-fragility.md`: U40–U44, and U49's path.
- `docs/model-proxy.md` "MCP tools".
- README.

## Code review (vs `origin/main`, two axes)

The implementer did the review, one axis after the other.

**Correctness and security.**

- One decision function (`decideCall`) serves the Durable `mcp` extension, t3's tools, the relay's servers and t3's
  relay. Linked is checked before an acceptance, so a stored acceptance never lets a linked write through.
- **Fixed in review:** a Durable "accept for the session" on an MCP tool was keyed by tool name only. The relay's key
  includes the definition hash. Now both are keyed by hash: `PendingApproval.definition` and `acceptanceKeyOf`, with a
  test in `mcpExtension.test.ts`. A changed definition asks again (H3's LOW "Renames").
- **Fixed in review:** the panel's add-server took an unknown `auth.kind` as `none` and a header sign-in without a
  header name. Both are refused now (`harnessPanel.test.ts`).
- Credentials:
  - They leave the Environment Worker only inside the engine call that uses them, and the engine scrubs them from what
    comes back.
  - Header secrets are write-only, and OAuth tokens are never shown.
  - The tools key never enters a Container: CLI processes hold only handles, which fail outside their Workspace and
    after exit (`m5-relay-hostile.json`).
- Writes:
  - A write is memoed before it is sent. After a restart it answers "cut off" and is not sent again.
  - A failed or timed-out write is not retried, and its message says it may have run.
  - The host refuses a call judged read whose class is now write, so it is asked again.
- **Executor's two-step write.**
  - The owner marks `skills`, `search`, `describe` and `resume` read. `call` and `execute` stay write, so they raise
    t3flare's card.
  - An approved write then waits for Executor's own browser approval, which the agent cannot answer.
  - `resume` (a read) waits for and returns the outcome of a paused call. The mutation runs only after the owner
    approves it in Executor's page, so marking `resume` read adds no unasked write.
- **Residuals, all documented:**
  - a full-access link answers cards (t3's exception);
  - a stolen owner handle before taint;
  - results are text only;
  - unrun stage cases (SPI-1078).

**Design and maintainability.**

- Each module has one job:
  - the registry (`packages/harness-registry`): schema, settings, classes, `decideCall`, card text, t3's guidance;
  - the host: inventory, pins, calls;
  - the engine: the vendored core;
  - the relay: protocol only.
- The Durable extension and the relay share the registry's functions, not each other's code.
- `host.ts` and the agents' `McpView` repeat the view's type across the Worker boundary. This mirrors
  `session-protocol`, and a later move into `harness-registry` would remove the copy. Not blocking.
- **Tidied in review:** a redundant ternary in `McpHost.#list`.
- `scripts/tools.ts` (~1.2k lines) is a stage harness, not acceptance. SPI-1077 folds it in.
- No blocking findings remain.

## Branch

`tools`, pushed (never `main`). The stage `tools` is still up for Executor's cases.
