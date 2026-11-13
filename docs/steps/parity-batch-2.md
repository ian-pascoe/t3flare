# Parity batch 2: stale rows, G8 (usage and limits), G13 (ACP registry), the Storage page, OTLP export (report)

Date: 2026-11-13. Branch `pbatch2`, from `main` at 8b398f3. Tickets: SPI-999 (G8), SPI-1003 (G13); filed SPI-1105 to
SPI-1108. Evidence: [`parity-batch-2/`](parity-batch-2/). Stage harness: `apps/environment/scripts/pbatch2.ts`, with a
probe Worker (`scripts/pbatch2/probe.ts`: a stand-in for Commissary's management API and an OTLP receiver). Throwaway
stage `pbatch2`, added to `STAGES`, **deployed once** (with `T3FLARE_PROBE=1`), destroyed at the end (10 resources,
the probe included). Parity rows: [`docs/parity.md`](../parity.md). Fragility: [U58](../upstream-fragility.md) (search "U58")
(new), U8 and U11 (amended). ADRs: 0001 (counts), 0012 and 0016 (refinements).

t3code is untouched (pinned at d8f3feff, `v0.1.10-nightly.20261112.4606`). **Counts: Shadows 2, Patches 4, both
unchanged.** Everything new is a Layer over a t3 service (`UsageLimitSources`, `AcpRegistryCatalog`,
`DatabaseStorage`), `ServerConfig` fields built with t3's own parser, our usage readers in the existing
`builtInDrivers` Shadow, and our own code.

## For the owner

1. **Commissary's management API (G8, SPI-1105).** The Usage page and the limit meters stay empty until you set
   `COMMISSARY_MANAGEMENT_URL` (the app host), `COMMISSARY_MANAGEMENT_KEY` and, on a self-hosted Commissary,
   `COMMISSARY_ACCESS_CLIENT_ID`/`_SECRET` (an Access service token admitted for `/v9/management`); optionally
   `COMMISSARY_MANAGEMENT_ORG`. Stages read them from `~/.config/t3flare/dev.env`; `deploy-prod.yml` passes them from
   the `prod` environment (vars for the URL, org and client id; secrets for the key and the client secret). They are
   bound to the Environment Worker only.
   - **Least privilege: org admin is the minimum.** Commissary has owner, admin and member, no read-only role. A
     member-role management key has no member id: Commissary filters a member's usage to "own records" by member id
     or principal, so the key reads none of t3flare's API keys' records, and `GET /credentials` gives a member only
     their own private accounts, which a key has none of. An admin key can also change accounts, routing and keys
     (never download a credential or issue keys). Records served by a member's *private* accounts stay hidden from
     any management key. Issue one for t3flare alone and revoke it in the panel.
   - Proved only against a stand-in that serves the v9 shapes; check once against the real Commissary (SPI-1105).
2. **ACP registry agents that read their key from the environment (G13, SPI-1106).** Refused under ADR-0016 A′. If
   you admit them (Gemini CLI, Qwen Code, goose, Mistral Vibe, Kilo, …), the cost and the risk:
   - *How they get in:* not the image (ADR-0024's pin would grow per agent and per release). At runtime, in the
     Workspace's Container, at each process start: `npx -y <package>@<registry version>` (npm's own integrity
     check), `uvx`, or the registry's binary archive checked against its `sha256`. The Container's disk is
     ephemeral, so every Container start downloads again: tens to hundreds of MB and seconds to a minute of cold
     start per agent, unless a cache is kept on the synced Workspace (which then holds third-party binaries).
   - *Security:* code from npm, PyPI or a GitHub release runs in the Container beside the key helper; the agent's key
     sits in its environment, so every command it runs can read it (`env`, `/proc`), with no grant count, and the
     sync guard scans only files. Exposure stays bounded by the key's own spend limit, expiry and revocation.
   - The four agents that already fit A′ (Claude Agent, Codex, OpenCode, pi) are built in.
3. **OTLP endpoints receive everything t3 traces.** As on a laptop: span names and attributes of every request and
   SQL statement (about 400 KB per 1,000 spans at boot). Point them only at a collector you trust.

## M1: stale parity rows — PASS

Checked against the code and the step 3, 3+, 4a, 4b, tools and SPI-1061 reports, with evidence paths:

| Row | Was | Now |
| --- | --- | --- |
| Structured questions | M today | W: `ask_user` → t3's `user_input` (step 3 m3/m4, step 3+ rows c and i, SPI-1079) |
| Subagents, `delegate_task` | M today | W through t3's orchestrator (step 3 `m2-stage.json` `delegate`; SPI-1061 `delegate.json`); native Durable subagents *def* |
| t3's tools in Sessions | W, thin evidence | W with the denylist named (SPI-1060) and step 3's calls |
| Laptop-to-cloud link | in progress | W (step 3 `m4-e2e-*`, the owner's desktop `m5-desktop-*`) |
| Mobile push | prod pending A3 | W, prod linked 2026-11-12 (SPI-1036) |
| HTML replies, MCP apps, account sign-in, provider settings | stale evidence or step | updated |

The header's pin moved to `v0.1.10-nightly.20261112.4606`. "More devices" was already W from the first batch.

## M2: G8, the Usage page and limit meters (SPI-999) — PASS (stand-in), optional

**Finding.** Commissary has no usage or quota route for API keys: both are on the management API, on the app host,
behind Access, and refuse `cms_` keys. t3's `cliproxy` source speaks CLIProxyAPI's `/v0/management` (`auth-files`,
the token-substituting `api-call`), which Commissary deliberately did not port. So the lead (`con/settings.ts:913`)
cannot point at Commissary.

- **Limit meters:** `usage/limitSources.ts`, a Layer over t3's `UsageLimitSources`: t3's own sources unchanged, plus
  a source `commissary` ("Commissary") from `GET /v9/management/credentials` (each enabled account's
  `quota_report.windows`, mapped to t3's driver kinds: `claude`→`claudeAgent`, `codex`, `antigravity`,
  `xai`→`grok`, `opencode-go`→`opencode`; others skipped). Read at t3's refresh and every 5 minutes while t3 runs.
  A failed account check shows as t3's "probe failed"; a refused key as the source's error. Resets are claimed in
  Commissary's panel (SPI-1107).
- **Usage page:** `usage/readers.ts`, scan readers on four of our drivers in the Shadow's `BUILT_IN_USAGE_DRIVERS`
  (Pi, Codex, Claude, OpenCode), sharing one read of `GET /v9/management/observability/usage/records` per minute,
  filtered to t3flare's two keys (`key:<id>` of `MODEL_PROXY_API_KEY` and of `COMMISSARY_CONTAINER_API_KEY`, the
  latter computed at deploy), successful model records only, following the cursor up to 25 pages per key.
  Attribution by Commissary's session identities: `codex:` or the Responses API → Codex, `claude:` → Claude Code,
  `affinity:` → OpenCode, the rest → Pi (SPI-1108 to split the Durable agent, text generation and the pi CLI).
  Commissary's own cost is passed as t3's provider-reported cost; unpriced models fall to t3's rate table.
- **Key:** the management key lives in the Environment Worker alone (never the agents Worker, never a Container).

| Check | Result | Evidence |
| --- | --- | --- |
| Unit: settings off unless URL and key; principals; account and window mapping, a failed check, a skipped provider; record attribution and tokens; failed and tool records dropped; the client's URL, headers, paging; a refusal and Access's redirect name no secret; the Layer adds the source beside t3's and refreshes both; resets refused; readers share one read | pass (16) | `test/commissaryUsage.test.ts`, `test/commissaryLimits.test.ts` |
| Stage: the web client's `subscribeServerConfig` (opted in) shows source Commissary with the Claude account's 5-hour and weekly windows and the Codex account's failed check; the Kimi account is skipped | **pass** | [`usage.json`](parity-batch-2/usage.json) `limitSources` |
| Stage: `server.getUsageSummary` has four `commissary://` sources, records for Pi, Codex, Claude and OpenCode (two each: both keys), the failed attempt left out, the cursor followed; every management call carried the key and the service token | **pass** | [`usage.json`](parity-batch-2/usage.json) |

## M3: G13, ACP registry agents (SPI-1003) — PASS, as a refusal

**Finding.** The registry lists 45 agents (fetched 2026-11-13). Of those, only four take the proxy's base URL through
their own setting *and* their key from a helper on demand, which ADR-0016 A′ requires: `claude-acp`, `codex-acp`,
`opencode`/`opencode-v2` and `pi-acp`. Each is already a built-in provider of t3's own kind, running the same agent
in the Workspace's Container (4a, 4b). The rest sign in with their vendor (D3: Cursor, Antigravity, Kiro, Grok Build,
Amp, Auggie, Copilot, Devin, Droid, Junie, Qoder, CodeBuddy, Cortex, Poolside) or read their key only from their
environment or a settings file. That classification is from each agent's documentation, not a run.

- `provider/acpRegistry.ts`, a Layer over t3's `AcpRegistryCatalog` in place of `layerFromHost`: `search` is t3's
  (it reads the registry), each agent's description led by its standing ("Built in here: add the Claude provider…",
  "Not available in t3flare: it signs in with its vendor's account… (D3)", "Not available in t3flare yet: it takes
  its model key only from its environment… (ADR-0016)"); `prepare`, `inspect` and `resolve` refuse with that text,
  so no `acpRegistry` instance is made that could not run; a custom ACP command is refused (it would run on the
  Environment's host). An agent the registry adds tomorrow defaults to the last standing.
- **Binaries:** none installed, at runtime or in the image; ADR-0024's pin is unchanged. The runtime path, if the
  owner admits env-key agents, is costed above.
- t3's own search hides npx and uvx agents when the host has no `npm` or `uvx`, as on a laptop without them: the
  stage listed the 23 with a Linux binary.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit: standings, the annotated list, the 1,024-character limit, every install refused | pass (4) | `test/acpRegistry.test.ts` |
| Stage: `server.searchAcpRegistry` listed 23 agents with their standings; preparing `claude-acp`, `gemini` and `cursor` was refused with each reason | **pass** | [`registry.json`](parity-batch-2/registry.json) |

## M4: the Storage page — PASS

**Finding.** Inspection no longer failed: the SQL adapter already answers the refused PRAGMAs with 0 (U8). So the
page showed a 0-byte database with t3's offline `doctor` repair.

- `t3/databaseStorage.ts`, a Layer over t3's `DatabaseStorage`: the size from `SqlStorage.databaseSize`, every minute;
  nothing reclaimable; `incrementalVacuumEnabled` (no repair recommended); `canReclaim: false`; a reclaim request
  answers that Cloudflare manages Durable Object storage. t3's six-hourly history compaction runs as stock.
- Storage cleanup (the page's other half) works as stock: its report came back, with nothing to clean.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit: the status and the refusal | pass (2) | `test/databaseStorage.test.ts` |
| Stage: `server.getDatabaseStorage` 3,059,712 bytes (the health route's `databaseSize`); `server.reclaimDatabaseSpace` refused with the reason; `server.getStorageCleanupReport` a report; no SQL errors | **pass** | [`storage.json`](parity-batch-2/storage.json) |

## M5: OTLP export — PASS

- `t3/otlp.ts`: at each boot, `layerConfig` reads the owner's saved `settings.json` and builds `ServerConfig`'s
  `otlp*` fields with t3's own `parsePersistedServerObservabilitySettings` and `resolveSignalEndpoint` (source
  `settings`), as `cli/config.ts` does on a laptop; a change applies after the Environment's next restart. t3's
  `Observability.layer` (already composed) then exports with `fetch` from the DO. t3's browser-trace forwarder
  (`/api/observability/v1/traces`) is mounted. No `T3CODE_OTLP_*` or `OTEL_*` variables: settings are the source.
- **Workers limits:** paid Workers allow 10,000 subrequests per invocation (raised from 1,000 on 2026-02-11), a
  long-lived DO's WebSocket included; t3 exports every 10 s per signal, about 12 a minute. Six simultaneous outgoing
  connections: exports are sequential per signal. The Environment's idle reset ends the exporters (they flush at
  shutdown).

| Check | Result | Evidence |
| --- | --- | --- |
| Unit: URLs and source from settings; none from no file, bad JSON or blanks | pass (2) | `test/otlp.test.ts` |
| Stage: traces and metrics URLs saved, Environment restarted in place: `server.getConfig` shows both from `settings`; the receiver got 4 trace exports (`t3code-server`, 828 and 1,000 spans) and 3 metric exports (`t3_rpc_requests_total`, …) within 25 s | **pass** | [`otlp.json`](parity-batch-2/otlp.json) |
| Stage: URLs cleared, restarted: no export in the next 25 s | **pass** | [`otlp-off.json`](parity-batch-2/otlp-off.json) |

## Tickets filed

- SPI-1105: provision Commissary's management API (owner), then check against the real Commissary.
- SPI-1106: decide whether env-key ACP registry agents may run (ADR-0016 A′).
- SPI-1107: claim Commissary's Claude reset grants from t3.
- SPI-1108: tell the Durable agent, text generation and the pi CLI apart in Commissary's log.
- Commented: SPI-999, SPI-1003.

## Code review (two axes, run in this session: no sub-agents are available here)

Fixed point `main` (8b398f3). Standards: AGENTS.md, ADR-0001, ADR-0030, the fragility register's rules, the smell
baseline. Spec: the task brief, SPI-999, SPI-1003.

### Standards

- ADR-0001: Layers first, no new Shadow or Patch; the existing Shadow gained readers (U11 amended). No pnpm or `vp`
  inside `t3code/`; the submodule is clean. ADR-0030: the lock and workspace untouched.
- Fragility: every new coupling (t3's three services, the usage reader contract, the OTLP settings parser,
  Commissary's v9 contract) is in U58 with its tests.
- Credentials: the management key and service token are bound to the Environment Worker only; evidence redacts the
  probe key and t3flare's key ids; no credential file was read.
- Fixed in review: Access's sign-in redirect (a 3xx under `redirect: "manual"`) read as an HTTP error, now as a
  refusal (test added); Duplicated Code: `alchemy.run.ts` parsed the key id itself, now uses `principalOfApiKey`.
- Possible Primitive Obsession (judgement): Commissary principals and provider names are strings; they are the wire's.
- Possible Speculative Generality (judgement): `COMMISSARY_MANAGEMENT_ORG` and `COMMISSARY_USAGE_PRINCIPALS` beyond
  the minimum; both are cheap and a multi-org Commissary needs the first.
- Judgement: t3's own `DatabaseStorage` still runs its minute-by-minute PRAGMA reads (answered 0) under the Layer:
  two cheap SQL calls a minute, kept so its compaction stays stock.

### Spec

- M1: done, every named row with evidence.
- G8: "feed `BUILT_IN_USAGE_DRIVERS` so the Usage page and meters show real numbers, Workers-only key" — done, but
  real numbers need owner provisioning (SPI-1105); proved against a stand-in, as directed. Partial: attribution of
  Pi-family traffic (SPI-1108); resets not claimable from t3 (SPI-1107).
- G13: "stock-like for agents that can use the proxy through a base-URL setting" — no registry agent outside the
  four built-ins can, under ADR-0016's key rule; the brief's "base-URL setting" alone would admit more, so this is a
  narrower reading, recorded for the owner (SPI-1106). Vendor-login agents listed as refused (D3). Binaries: decided
  (none), costs recorded.
- Storage page: done with a Layer; the cleanup half verified as stock.
- OTLP: done; limits checked; proved against a throwaway receiver on the stage.
- Scope beyond the letter: `deploy-prod.yml` and `stage.ts` pass the optional settings (needed for prod); t3's
  browser-trace forwarder mounted (part of "the proxy route is unmounted").

Summary: Standards 2 fixed, 3 judgement calls, no hard violations; Spec 2 partial (G8's real-Commissary check and
attribution; G13's narrower reading), each ticketed.

## Pass/fail

| Item | Result |
| --- | --- |
| M1 stale parity rows | PASS |
| M2 G8 limit meters | PASS (stand-in); real Commissary: SPI-1105 |
| M2 G8 Usage page | PASS (stand-in); attribution refinement SPI-1108 |
| M3 G13 ACP registry | PASS as a refusal (listed, installs refused); env-key agents SPI-1106 |
| M4 Storage page | PASS |
| M5 OTLP export | PASS |
| `pnpm run check` | PASS (32/32) at the branch head |
| Stage `pbatch2` | deployed once, destroyed (`stage.ts destroy pbatch2` exit 0, 10 resources) |
