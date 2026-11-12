# Scope audit: where t3flare goes beyond stock t3

Almost all of the agent-added scope sits in three places: the push gateway cluster on `main`, the CLI agents' repository-config locks, and the gates woven into the unmerged `tools` branch. The rest is either platform-forced or cheap enough to keep. Nothing was edited.

**How far this was checked**
- Nothing was run; line counts are `wc -l` and my own estimates for partial files.
- I verified stock behaviour in the submodule for only three things: Codex's mode table, the ACP permission policy, and Pi's `auto` mode. Other "stock does X" statements come from t3flare's own docs and comments.
- ADRs 0001–0009, 0014 and 0017–0021 were grep-skimmed, not read in full; every hit was platform or cost. Step reports were grepped for decisions only.
- The `tools` branch was read from its plan and report plus greps, not its full code. Linear tickets were not read.

**State of the tree**
- `docs/steps/spi-1061-plan.md` is modified but uncommitted: it is already the rescoped, stock version.
- `docs/adr/0029-…-capped-at-supervised-…md` on disk is still the gated design, and the plan links to a renamed ADR file that does not exist yet.
- `tools` is not merged, so its gates are the cheapest to cut.

**Decision ids collide**, so I qualify them: parity D1–D5 (`docs/parity.md` §5), step-3 D1 (`docs/steps/step-3-plan.md:15`), SPI-992 OD-1…8 (`docs/steps/spi-992-plan.md:231-252`, taken at `:306`), 4a OD-3 (`docs/steps/step-4a-plan.md:16`), and the tools decisions (`origin/tools:docs/steps/tools-plan.md:14-21`, `:593`).

Classes: **P** platform-forced, **O** owner decision, **A** agent-added caution, **C** cost or reliability.

## Ranked: drop or ask, biggest win first

| # | What t3flare does | Class | Stock t3 instead | Cost of dropping | Carries | Rec. |
|---|---|---|---|---|---|---|
| 1 | Push gateway, read-only Container token, Expectations, Taint, per-push cards on Durable and CLI threads | O: step-3 D1 and SPI-992 OD-1…6. The plan's own default for D1 was "yes, as t3" (`step-3-plan.md:625-630`); Taint is review H1 | The agent's shell pushes with the owner's git credential; the thread's mode is the only gate | A one-repo `contents: write` token (≤1 h) is readable in the Container during a push. Linked work pushes under its mode, with no card of its own | About 1,000 source lines, 650 of tests, a 555-line stage script. Fragility U37, U38, U39. A 100 MiB cap per push and no LFS upload (`docs/adr/0013…md:53-54`) | **Ask** (drop) |
| 2 | CLI agents ignore the repository's own configuration: hooks, MCP servers, agents, skills, plugins, marketplaces, permission rules | A: step 4b reviews F5, F6 | Each CLI honours the project's `.claude/` or OpenCode config | A cloned repo's hooks and MCP servers run in the Container as they would on a laptop | `acpProfiles.ts:106-115` (Claude), `:174-187` (OpenCode). Most of U35. Closes part of parity gap G10 | **Drop**; keep row K5's endpoint and key pinning |
| 3 | `tools`: t3's own tools reach CLI agents through a relay that swaps a per-process handle for t3's bearer, judges by the strictest mode in the Workspace (M7), and refuses an owner handle in a tainted Workspace (H1) | O for withholding the bearer (4a OD-3); A for M7, H1 and per-process handles (H2) | t3 hands its per-thread MCP bearer to the CLI's process | A 24 h, per-thread bearer in the Container; t3's own `/mcp` auth, fence and mode ceiling still apply | `mcp/t3Relay.ts` (174 lines; refusal at `:111`), `mcp/relay.ts:44-46`, `:82`, handle issue and revoke; U42 | **Ask** (stock hand-off for t3's tools; keep the relay for third-party servers, whose credentials are real secrets) |
| 4 | `tools`: tool classes pinned by definition hash; a direct server's tools are write until the owner marks each read | A: review H3 | No direct analogue; t3 trusts a tool's `readOnlyHint` | A server that mislabels a write as read runs it unasked. The owner added that server himself | `mcp/host.ts:111`, `:264-288`, panel class overrides, the pin store, the `fixture_flip` case | **Drop**: trust the annotation, as t3's Pi bridge does for t3's tools |
| 5 | `tools`: a linked thread's every MCP write asks per call, full access included; each server is "offered to linked threads" off by default (M13); a tainted Workspace is judged as linked | O: tools decision 3 and the M13 choice. Both extend step-3 D1 | The link's access and the thread's mode govern | Linked work calls write tools under its mode | `host.ts:299`, `:331`; `relay.ts:44-46`; `decideCall`'s linked branch; a panel switch | **Ask** (falls with row 1) |
| 6 | `tools`: the Harness panel on its own admin host, via a forwarder Worker and a second Access application | O: owner chose "dedicated host" on review H4 | Not applicable; the panel is ours | The panel shares an origin with t3's web client, which renders agent output. Access still fronts it | Worker `t3flare-admin-<stage>`, an Access app, a custom domain, the `HarnessAdmin` entrypoint, ADR-0026 | **Ask** (serve under `/_t3flare/harness`, behind the existing Access) |
| 7 | `T3_TOOL_ALLOWLIST` fails closed at 41 tools; the guidance filter needs every backticked name in t3's instructions classified | A: "decided here, not asked" (`step-3-plan.md:632`) | Agents get whatever t3 lists for their credential; t3 already hides browser and device tools by setting | A tool a nightly adds is offered before anyone looks at it | `apps/agents/src/extensions/t3-mcp.ts:33-79`, `t3-guidance.ts` (147 lines), U5, U49; a bump chore for every new tool | **Drop** to a short denylist of tools that cannot work here (`t3_attachment_*`, `html_*`, `t3_worktree_*` until its git is routed); filter by that list |
| 8 | SPI-1061 residue: Pre-B's refusal Layers, the link tools withheld, glossary terms for the gated design | A, already dropped by the owner | t3's own link dialog and card | None | `apps/environment/src/t3/peerLinks.ts` (77 lines), a 115-line test, U45; `GLOSSARY.md` entries Registered machine, Outbound work, Outbound send, Send permit | **Drop** (in progress; fix the dangling ADR-0029 link in the same change) |
| 9 | CLI mode table differs from t3's: `auto` runs as approval-required (Claude's auto mode disabled, a session offering it is ended); no "for the session" on ACP cards; auto-accepted edits contained to the cwd; a session that drifts from its pinned mode is ended; a plan turn on the Pi CLI is refused | A: step 4a/4b reviews F1, F2, F4, F6 | Codex `auto` is on-request with its `auto_review` reviewer (`CodexAdapterV2.ts:745-750`); ACP auto-accept-edits allows any edit (`clientPolicy.ts:174-183`); cards offer session accept | Fewer prompts, more unasked actions inside the Container. `auto` would need the reviewer to work through the proxy (unverified) | `acpFlavor.ts:31-102`, `:165-300`; `codexGuard.ts:61-68`; `acpProfiles.ts:106-107`; `wrapper.ts:92`, `:269`; U33 and a 304-line test | **Drop** the deviations; keep the pinned asking mode itself, which is how the flavor implements t3's modes |
| 10 | Codex request guard: allowlists for app-server methods and thread config keys; `feedback/*` and `account/*` refused | A: 4a review F5 | t3's adapter talks to Codex directly | A new method reaches Codex unreviewed | `codexGuard.ts:7-39`, U29. The allowlist is what breaks on a bump: a new method fails where it is called | **Drop** the two allowlists; keep the provider pin and the no-sandbox fallback |
| 11 | T3 Connect is publish-only: four relay-initiated routes refused twice, and the mint key deleted after each link | A in design (ADR-0010, ADR-0025); P for the tunnel, which a Worker cannot run | A managed link: the relay can mint a pairing credential, so the owner's signed-in apps connect without a pairing link | t3.codes could mint a session on the Cloud Environment, as it can on his laptop. Whether a tunnel-less link supports this is unverified | `host/relayRoutes.ts` (31 lines), `composition.ts:790`, about 320 lines of tests, U28 | **Ask** (keep; restoring it adds scope) |
| 12 | Keys typed into t3 are refused: custom text generators locked empty, cloud voice stripped, `request_secret` withheld | O: parity D5, "for now", already excepted once for MCP servers; the second exception (E2) is void | The owner types the key into t3's settings | A vendor key in the Environment's secret store; `request_secret` hands a secret to a shell in a Container | `managedPolicy.ts:22`, `capabilities.ts:86`, the allowlist entry | **Ask** (lift) |

All paths in rows 3–6 are on `origin/tools`. Row 1's code: `apps/agents/src/workspace/pushGateway.ts` (312), `linkedPush.ts` (88), `pushCard.ts` (105), `WorkspaceDO.ts:173-174`, `:1508-1533`, `:1587-1588`; `apps/agents/src/session/SessionDO.ts:243-297`; `apps/environment/src/provider/cli/wrapper.ts`, `linkedPushAsk.ts` (64); `apps/environment/src/agents/gitRoutes.ts`; `packages/github-app/src/permissions.ts:28-47`.

On "auto-decline" from your list: it existed only in the gated SPI-1061 design (three declines in a row, and over-long messages), which is already dropped. The `tools` build chose a marked truncation instead (`cardText.ts`, review M2).

## Ranked: keep

| # | What t3flare does | Class | Why keep | Where |
|---|---|---|---|---|
| K1 | Capability flags stripped, and device, guest-link and scratch settings locked | P (host-bound or not built) | t3's own mechanism; the alternative is clients offering controls that fail. Guest links are A in origin (ADR-0010), but lifting them means building routes | `capabilities.ts:34-86`, `managedPolicy.ts:16-20`; U4 |
| K2 | Product analytics off | O: parity D1 | One line | `managedPolicy.ts:30` |
| K3 | GitHub as the App only; vendor-login CLIs refused; Claude and OpenCode over ACP | O: parity D2, D3; 4b OD-1 | Each follows from the model proxy decision or from what a Durable Object can run | ADR-0013, ADR-0015 |
| K4 | Key helper for the model proxy key | O: ADR-0016 A′ | Built and working. The per-nonce grant counts are A and already cause a re-ask problem after a 401 (SPI-1045); drop them if it bites | `apps/agents/src/workspace/modelKey.ts` (49), image helpers |
| K5 | CLI profile: fixed environment, fresh homes, proxy as the only endpoint, Claude's redirect variables pinned empty | P, plus A for the pinned variables (review F3) | The Worker's `process.env` holds deploy secrets, and a repo setting could send the proxy key to another host. No model misbehaviour needed for either | `cliProfiles.ts:63`, `acpProfiles.ts:42-102` |
| K6 | Sync guard: scan before each pull, quarantine, kill, flag the key | A (4a plan) | Stops a credential an agent wrote to a file from reaching the Workspace's files, checkpoints and pushes | `apps/sandbox-image/src/leakscan.ts` (109), `WorkspaceDO.ts:385-438` |
| K7 | `workflows: write` only for an opted-in Workspace | A (step 2a) | One column; without it an agent can change what CI runs with its secrets | `apps/environment/src/agents/workspaces.ts:23-24` |
| K8 | Armed pairing window, redacted boot log, WAF rate limit, admin routes behind Access | P and C | The endpoint is public and Workers Logs are remote; floods wake the DO | `host/pairing.ts:14-32`, `alchemy.run.ts:216-231` |
| K9 | Idle compaction locked off, automatic fetch off, Container, turn and shell limits | C | Each would start or hold a Container | `managedPolicy.ts:25`, `composition.ts:433` |
| K10 | Pi Durable enforces handed-down modes; plan is read-only | P | This is our own provider implementing t3's modes; `auto` as approval-required matches stock Pi (`mcpInjection.ts:311`) | `packages/session-protocol/src/index.ts:23`, `permissions.ts:296-299` |
| K11 | `tools`: MCP Worker with strictly public fetch, caps on tools and schemas, 8 pending asks per script | A and C | One flag and a few constants; guards against SSRF and heap blowups | ADR-0028 on `origin/tools` |
| K12 | Prod discards the T3 Connect account token after linking | O: step 3+ D2 | Explicit, and costs nothing | ADR-0025 |

One thing I could not explain: `features.multi_agent=false` for Codex (`cliProfiles.ts:98`). If it is only caution, it belongs in row 9.

## Questions for the owner

"Yes" accepts my recommendation.

1. **Pushes (row 1).** May pushes go back to stock, with a write token from the credential helper and the thread's mode as the only gate, dropping the gateway, Taint, Expectations and push cards? If no, the fallback keeps the gateway as a token-holder that always allows; that retires the cards and U37–U39 but keeps the 100 MiB cap and the LFS gap.
2. **Linked work and MCP tools (row 5).** Should linked threads follow their own mode for MCP writes and see every enabled server, with no per-call rule and no "offered to linked threads" switch?
3. **t3's tools for CLI agents (row 3).** May a CLI agent get t3's per-thread bearer directly, as stock t3 does, instead of the handle-swapping relay?
4. **Panel host (row 6).** May the Harness panel be served on the t3 host under `/_t3flare/harness`, behind the existing Access application, dropping the admin Worker and its domain?
5. **T3 Connect (row 11).** Is publish-only still what you want: notifications only, with your apps reaching the cloud by pairing link and never through the relay?
6. **Typed keys (row 12).** Should parity D5 be lifted so t3's own typed-key settings work as stock, starting with custom text generators?
