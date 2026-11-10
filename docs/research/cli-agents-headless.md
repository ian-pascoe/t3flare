# Headless coding-agent CLIs in a Cloudflare Container: research notes

Research date: 2026-11-10. Question: can Claude Code, Codex, OpenCode and pi run headless inside a Linux Cloudflare Container, driven by an orchestrator in a Durable Object (no local processes) that reaches the container over HTTP/WebSocket?

Conventions: every claim cites a source. `[t3: path:line]` = the local t3code checkout at `/tmp/ref/t3code` (a reference implementation, not official documentation). `UNCONFIRMED` = not verified against a primary source in this pass.

Versions observed: `@anthropic-ai/claude-agent-sdk` 0.3.322 (npm/unpkg `latest` at fetch time); OpenCode docs are the V1 docs (the site says V2 docs are at `https://opencode.ai/docs/llms.txt`); pi docs from `earendil-works/pi` `main` (the repo the t3 code's docs point to; the local install is pi 1.5.2).

---

## 1. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

### 1.1 Custom spawn hook: yes
- The `spawnClaudeCodeProcess` option exists: `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`. Doc comment: "Use this to run Claude Code in VMs, containers, or remote environments. When provided, this function is called instead of the default local spawn." Source: `https://unpkg.com/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.3.322), and the options table at `https://code.claude.com/docs/en/agent-sdk/typescript` ("Custom function to spawn the Claude Code process. Use to run Claude Code in VMs, containers, or remote environments").
- `SpawnOptions` (from sdk.d.ts): `command: string; args: string[]; cwd?: string; env: {...}; signal: AbortSignal-like` (signal is forwarded after the SDK's stdin-EOF plus ~2 s grace window).
- `SpawnedProcess` (from sdk.d.ts) is Node-typed:
  - `stdin: Writable`, `stdout: Readable` (Node stream types)
  - `readonly killed: boolean`, `readonly exitCode: number | null`, `readonly signalCode?: NodeJS.Signals | null`
  - `kill(signal: NodeJS.Signals): boolean`
  - `on/once/off('exit', (code, signal) => …)` and `on/once/off('error', …)`
- Doc guidance: "If your spawnClaudeCodeProcess runs Claude Code on another machine or in a container, set options.cwd to a directory that exists there." Source: typescript docs, prewarm section.
- Implication: a proxy process can satisfy this contract by bridging stdin/stdout to a WebSocket. But the contract is Node stream objects and `NodeJS.Signals`, so a non-Node runtime needs stream shims. Whether that works inside workerd is UNCONFIRMED.

### 1.2 What t3's ClaudeAdapterV2 uses
- Passes `pathToClaudeCodeExecutable` from settings `binaryPath` [t3: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1882; :1044-1046].
- Launch wrapper: for non-script binaries, `agentScope.wrap({command: binaryPath, args: [] ...})` returns a `launch`; if `launch.args` is non-empty it rewrites `pathToClaudeCodeExecutable = launch.command` and `executableArgs = [...launch.args, ...queryOptions.executableArgs]` [t3: ClaudeAdapterV2.ts:1200-1222]. Script entries (`CLAUDE_SCRIPT_EXTENSIONS`) skip the wrap and run through node.
- Always supplies its own `spawnClaudeCodeProcess` wrapper [t3: ClaudeAdapterV2.ts:1235-1281] which calls `query({ prompt, options: { ...options, spawnClaudeCodeProcess } })` [t3: :1279]. It also tracks the process for port discovery and exit.
- Default spawn on non-Windows is `spawnClaudeProcessGroup` [t3: ClaudeAdapterV2.ts:371-397]: it runs `/bin/sh -c <watch script> t3-claude <command> <args…>` with `detached: true` and four stdio pipes. The watcher kills the CLI's process group on EOF from the pipe, because (per t3's comment) "The CLI keeps working after its pipes close". On Windows it calls `NodeChildProcess.spawn` directly [t3: :1236-1250].
- So t3 does not use a remote or non-Node spawn. It runs the SDK in a Node server and spawns a local `claude`.

### 1.3 Does the SDK need Node APIs at import time?
- Yes, as far as the published bundle shows. `sdk.mjs` (v0.3.322) has static top-level imports of `node:module` (createRequire, with `import.meta.url`), `node:fs`, `fs`, `fs/promises`, `path`, `node:path`, `os`, `node:os`, `child_process`, `net`, `events`, `util`, `crypto`, `async_hooks`, `buffer`, `string_decoder`, `node:process`. Source: `https://unpkg.com/@anthropic-ai/claude-agent-sdk/sdk.mjs` (fetched and inspected; import lines are at the top of the bundle).
- The package declares `"engines": {"node": ">=18.14.0"}` in its `package.json` (same unpkg source).
- Whether these imports resolve in workerd with `nodejs_compat`, and whether `child_process`/`net` are usable, is UNCONFIRMED. Treat "SDK inside a Durable Object" as unproven.
- Cloudflare-side safe default: run the SDK inside the container (Node), and let the DO talk to a container-side server over HTTP/WS.
- Other runtime options: `executable: 'bun' | 'deno' | 'node'` (JS runtime used to run the CLI) and `executableArgs` [typescript docs options table].
- Native binary: the SDK throws `Native CLI binary for <platform>-<arch> not found` when optional deps are skipped; set `pathToClaudeCodeExecutable` to a separately installed `claude` [typescript docs, install note].

### 1.4 Protocol
- The SDK spawns and supervises a `claude` CLI subprocess and "talks to it over stdio" [`https://code.claude.com/docs/en/agent-sdk/hosting`, "The subprocess model"].
- Print-mode flags: `--input-format` (text | stream-json) and `--output-format stream-json` [`https://code.claude.com/docs/en/cli-reference`]. The SDK's exact argv was not confirmed (UNCONFIRMED: which flags the SDK passes internally).

---

## 2. Headless auth per CLI

### 2.1 Claude Code
- Credential precedence (first match wins): 1) cloud provider creds (Bedrock/Vertex/Foundry env flags), 2) `ANTHROPIC_AUTH_TOKEN` (Bearer), 3) `ANTHROPIC_API_KEY` (X-Api-Key), 4) `apiKeyHelper` script output, 5) `CLAUDE_CODE_OAUTH_TOKEN`. Source: `https://code.claude.com/docs/en/authentication`.
- `claude setup-token` generates "a one-year OAuth token"; the token goes in `CLAUDE_CODE_OAUTH_TOKEN` "for CI pipelines and scripts where browser login isn't available". Source: same page ("Generate a long-lived token").
- The SDK hosting page says the subprocess "reads `ANTHROPIC_API_KEY` from its environment", and suggests `ANTHROPIC_BASE_URL` to a proxy that injects the key outside the container. Source: `https://code.claude.com/docs/en/agent-sdk/hosting`, "Auth and secrets".
- Terms (official, `https://code.claude.com/docs/en/legal-and-compliance`):
  - "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below."
  - Conditions include: the binary must not be modified; "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential."
  - "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - **Interpretation (ours, not stated by Anthropic):** a multi-tenant hosted product that runs Claude Code for other people on one shared subscription token is the "intermediate" case the terms forbid. Per-user keys or your own individual use are within the stated terms. Get Commercial Terms if you host it for customers.

### 2.2 Codex
- Two sign-in methods: "Sign in with ChatGPT for subscription access" or "Sign in with an API key for usage-based access". Source: `https://developers.openai.com/codex/auth`.
- API key headless: `printenv OPENAI_API_KEY | codex login --with-api-key` (same page, "Codex CLI").
- Credential storage: `cli_auth_credentials_store = file | keyring | auto | ephemeral`. `file` = `auth.json` under `CODEX_HOME` (default `~/.codex`). `keyring` = OS credential store. Source: `https://developers.openai.com/codex/auth` ("Credential storage"). Also `https://developers.openai.com/codex/config-advanced` ("Config and state locations").
- auth.json portability (CI page `https://developers.openai.com/codex/auth/ci-cd-auth`):
  - "The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account."
  - Pattern: create `auth.json` once on a trusted machine with `codex login`, put it on the runner, let Codex refresh it, keep the refreshed file for the next run.
  - Conditions: "the runner is trusted private infrastructure", "only one machine or serialized job stream will use a given auth.json copy". Applies only to `auth_mode: "chatgpt"`, not API key auth.
  - Implication: a single `auth.json` cannot be shared by concurrent containers. Refresh rotation makes copies diverge.
- Terms: the CI page's "trusted private infrastructure" language is the closest official statement. OpenAI consumer/enterprise ToS on hosted reuse of ChatGPT-login tokens: UNCONFIRMED (not fetched).

### 2.3 OpenCode
- Provider keys are set through `/connect` in the TUI; "For most providers, connect an account first, then select a model." Source: `https://opencode.ai/docs/providers/`. The docs do not document a headless CLI command to set a key (UNCONFIRMED).
- ChatGPT sign-in is available "instead of an OpenAI API key" (`providers` page, "ChatGPT").
- Server auth: `OPENCODE_SERVER_PASSWORD` protects `opencode serve` with HTTP basic auth; username defaults to `opencode`, override with `OPENCODE_SERVER_USERNAME`. Source: `https://opencode.ai/docs/server/`, "Authentication".
- Credential file location (not in the docs; from t3 source): t3 reads `<XDG_DATA_HOME or ~/.local/share>/opencode/auth.json` and also `OPENCODE_AUTH_CONTENT` (env) and an `opencode.db` in the same directory (`OPENCODE_DB` overrides the filename) [t3: packages/provider-opencode/src/server/usageLimits.ts:~104-130]. Note the t3 comment: "OpenCode 2 imports auth.json once". Treat exact V1/V2 behavior as UNCONFIRMED against OpenCode source (the GitHub repo `anomalyco/opencode` moved its paths; I could not confirm the file from the official repo in this pass, but found `packages/core/src/credential.ts` storing credentials in a SQLite `credential` table).

### 2.4 pi
- Credentials: `<agent-dir>/auth.json` holds "Saved API keys and OAuth credentials"; `<agent-dir>/models.json` holds compatible endpoints and models; agent dir defaults to `~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR` [`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/configuration.md`].
- `/login` saves OAuth or API key to `auth.json`. "On a remote or headless machine, an OAuth callback may not reach the local process" (so do login elsewhere and copy `auth.json`, or use API keys). Source: `.../docs/providers.md`.
- `--api-key <key>` gives a non-persistent override for one run (requires `--model`) [`.../docs/cli.md`].
- Env-var names for each provider: UNCONFIRMED (`providers.md` section "Use an API key from the environment" exists, not extracted).
- Containers: "Mounting `~/.pi/agent` exposes your Pi credentials, settings, extensions, and sessions." and "Environment variables passed into a container are available to processes inside it." Source: `.../docs/containerization.md`.

---

## 3. Protocols and stdio vs listen

| CLI | Orchestrator protocol | Stdio-only? | Can listen on a port? | Session survives orchestrator disconnect? | Resume |
|---|---|---|---|---|---|
| Claude Code | SDK `query()` ↔ `claude` CLI, stream-json over stdio | Yes, per docs (`hosting`, "talks to it over stdio"). No listen mode found in `cli-reference` (UNCONFIRMED that none exists). | No (not found) | Per t3 comment, the CLI keeps running after its pipes close, and t3 kills it on EOF from its own pipe [t3: ClaudeAdapterV2.ts:371-376]. Not documented officially. | `resume` option; transcripts on disk (see §4) |
| Codex | `codex app-server`, JSON-RPC | Default stdio: t3 spawns `codex app-server` with stdio pipes [t3: CodexAdapterV2.ts:1603-1609]. Official default: UNCONFIRMED. | **Yes**: `codex app-server --listen ws://IP:PORT`; clients use `codex --remote ws://… ` or `--remote unix://PATH`, with `--remote-auth-token-env <ENV_VAR>` for a bearer token [`https://developers.openai.com/codex/cli/reference`]. Whether `--listen` is marked experimental: UNCONFIRMED. | Multi-thread server; t3 notes a shared app-server serves many threads and needs resume "after restart or idle release" [t3: CodexAdapterV2.ts:7972]. | Thread IDs; `thread/start`, `thread/fork` documented in app-server README (`https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md`). `thread/resume` not found in README; t3 implies it exists (UNCONFIRMED name). |
| OpenCode | `opencode serve` HTTP + SSE (V1 docs); `opencode acp` ACP over stdio | `serve` is HTTP, so no stdio proxy needed. `acp` is stdio JSON-RPC [`https://opencode.ai/docs/acp/`]. | **Yes**: `opencode serve [--port] [--hostname] [--cors]` [`https://opencode.ai/docs/server/`]. t3 runs `serve --hostname=127.0.0.1 --port=…` [t3: packages/provider-opencode/src/server/OpenCodeRuntime.ts:513]. | Server is a separate process; sessions addressable by ID via REST (`GET /session/:id`, `POST /session`, `DELETE /session/:id`) and `GET /global/event` (SSE) [server docs]. | Session ID via REST. Persistence across server restart: UNCONFIRMED for V1. |
| pi | `pi --mode rpc` JSONL on stdin/stdout | **Yes**: "RPC mode runs Pi as a long-lived subprocess controlled through JSON records on stdin and stdout." No listen mode in `rpc.md`. | No (not documented) | Session is a JSONL file on disk; a new process can reopen it (`--session <path>`) [`.../docs/cli.md`]. Whether the process keeps running after stdin closes: UNCONFIRMED. | `--session <path|id>`, `--continue`, `--resume`, `--session-id` [`cli.md`]. `get_state` returns the current session ID and file [`rpc.md`, `json.md`]. |

Sources for pi: `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md`, `.../cli.md`, `.../json.md`. t3's pi driver spawns `pi --mode rpc --no-session` or `--session <path>` [t3: packages/provider-pi/src/server/mcpInjection.ts:273-283].

Key architectural point: Codex (`--listen ws://`) and OpenCode (`serve`) can avoid a stdio proxy. Claude Code and pi need a small in-container bridge that owns the child's stdio and exposes it over WebSocket.

---

## 4. On-disk session state (container disk may be ephemeral)

| CLI | Default location | Override | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` (encoding: replace every non-alphanumeric char of the absolute cwd) | `CLAUDE_CONFIG_DIR` → `$CLAUDE_CONFIG_DIR/projects/` | `https://code.claude.com/docs/en/agent-sdk/sessions` (tip). `CLAUDE.md` memory: `~/.claude/CLAUDE.md`. Hosting doc: "None of them survive a container restart, a scale-down, or a move to a different node." Persist via `SessionStore` adapter (transcripts only). `https://code.claude.com/docs/en/agent-sdk/hosting`, `.../session-storage` (not fetched). |
| Codex | `$CODEX_HOME` (default `~/.codex`): `config.toml`, `auth.json` (if file store), `history.jsonl` (history on by default) | `CODEX_HOME` env | `https://developers.openai.com/codex/config-advanced`. Rollout transcripts at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`: seen only in t3 test fixtures [t3: apps/server/src/project/AgentSessionScanner.test.ts]. Official doc: UNCONFIRMED. |
| OpenCode | Logs: `~/.local/share/opencode/log/opencode.log` [`https://opencode.ai/docs/troubleshooting/`]. Data: `$XDG_DATA_HOME/opencode/` (default `~/.local/share/opencode`) with `auth.json` and `opencode.db` (from t3 source, §2.3). | `XDG_DATA_HOME`, `OPENCODE_DB`, `OPENCODE_DATA_DIR`, `OPENCODE_AUTH_CONTENT` [t3: packages/provider-opencode/src/server/usage.ts:310-318; usageLimits.ts] | Session store is SQLite in the V2 code (`packages/core/src/database/*`, `credential` table) [anomalyco/opencode `dev` branch, fetched via GitHub raw]. V1 session path: UNCONFIRMED. |
| pi | `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`; auth in `~/.pi/agent/auth.json`; models in `~/.pi/agent/models.json` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `--session-dir` (precedence: flag > env > `sessionDir` setting) | `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md`, `sessions.md`, `cli.md`, `configuration.md`. Sessions can be deleted by removing the `.jsonl`. |

Implications for a Durable Object orchestrator:
- All four keep session history as files on disk in the container. A container restart loses them unless you mirror them (Claude: `SessionStore` adapter; others: your own sync to R2/DO storage).
- Keep the agent home directories (`~/.claude`, `$CODEX_HOME`, `~/.local/share/opencode`, `~/.pi/agent`) on a mounted volume or sync them out; that also covers Codex's refreshing `auth.json`.

---

## Summary of decision-relevant findings

1. Claude Agent SDK exposes `spawnClaudeCodeProcess(SpawnOptions) => SpawnedProcess` for "VMs, containers, or remote environments" (sdk.d.ts; typescript docs). The contract is Node `Writable`/`Readable` streams, so a stdio-over-WebSocket bridge needs Node-style streams.
2. t3 runs the SDK in a Node server, sets `pathToClaudeCodeExecutable` from the binary path, wraps native binaries via `executableArgs`, and always supplies its own spawn hook with a detached process group (ClaudeAdapterV2.ts:371-397, 1200-1281).
3. The SDK bundle has static top-level Node imports (`child_process`, `fs`, `net`, `node:module`, …). Running it inside a Durable Object is UNCONFIRMED; the safe default is SDK-in-container.
4. Claude auth: `ANTHROPIC_API_KEY` for hosted use. Subscription OAuth (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) is for ordinary individual use. Anthropic's terms forbid hosting Claude Code for end users on your subscription or intermediating usage; the sanctioned pattern is per-user keys or Commercial Terms.
5. Codex: API key via `codex login --with-api-key`. ChatGPT `auth.json` is documented only for "trusted private infrastructure", one runner per copy, because refresh tokens rotate. Not for concurrent multi-tenant containers.
6. Codex and OpenCode can listen on a port (`codex app-server --listen ws://…`; `opencode serve --port`), so they need no stdio proxy. Claude Code and pi are stdio-only in the docs, so they need an in-container bridge.
7. pi `--mode rpc` is JSONL on stdin/stdout with `--session <path>` resume. Auth is `~/.pi/agent/auth.json` (set `PI_CODING_AGENT_DIR` to relocate). OAuth login callbacks don't work headless.
8. All CLIs keep session state as files under the home dir (`~/.claude/projects`, `$CODEX_HOME`, `~/.local/share/opencode`, `~/.pi/agent/sessions`). Container disk is ephemeral per the Claude hosting docs, so mirror or mount these.
9. OpenCode's docs are V1, but t3 targets OpenCode 2 (`@opencode/client` 2.0.28, SQLite `opencode.db`). Pin a version and re-verify the session/auth paths before building.
10. Open items (UNCONFIRMED): Workers/workerd compatibility of the SDK; Claude CLI listen mode (none found); Codex `thread/resume` name and whether `--listen` is experimental; OpenCode V1 session persistence; whether pi/Claude CLI survive orchestrator disconnect; OpenAI ToS on hosted ChatGPT-login reuse.

---

## Primary sources consulted
- Claude Agent SDK: `https://code.claude.com/docs/en/agent-sdk/typescript`, `.../hosting`, `.../sessions`; `https://unpkg.com/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and `sdk.mjs` (v0.3.322); `https://unpkg.com/@anthropic-ai/claude-agent-sdk/package.json`
- Claude Code: `https://code.claude.com/docs/en/authentication`, `.../cli-reference`, `.../legal-and-compliance`
- Codex: `https://developers.openai.com/codex/auth`, `.../auth/ci-cd-auth`, `.../config-advanced`, `.../cli/reference`; `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md`
- OpenCode: `https://opencode.ai/docs/server/`, `.../providers/`, `.../acp/`, `.../troubleshooting/`; GitHub `anomalyco/opencode` (`dev` branch) `packages/core/src/credential.ts`, `packages/core/src/database/path.ts`
- pi: `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/{rpc,cli,json,configuration,providers,containerization,session-format,sessions,models-configuration}.md`
- t3code (local reference): `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, `packages/provider-opencode/src/server/{OpenCodeRuntime.ts,usage.ts,usageLimits.ts}`, `packages/provider-pi/src/server/mcpInjection.ts`, `packages/provider-acp` (package exports only; its server code was not read in detail)
