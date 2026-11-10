# Mode 1 and tooling facts

Research date: 2026-11-10. Sources are primary only: developers.cloudflare.com, developers.openai.com and github.com/openai/codex, code.claude.com, the npm registry (package metadata), the alchemy-run/alchemy GitHub source, v2.alchemy.run / alchemy.run docs, and local repos (`/Users/ianpascoe/src/cloudpid`, `/tmp/ref/t3code`).

Labels: **CONFIRMED** = read in a primary source. **UNCONFIRMED** = not verified. **INFERRED** = follows from confirmed facts, but no source states it directly.

---

## 1. Cloudflare Containers outbound interception

**Sources**
- DO Container API: https://developers.cloudflare.com/containers/api/durable-object-container/ (last updated Nov 9, 2026)
- Handle outbound traffic: https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- Limits: https://developers.cloudflare.com/containers/platform/limits/

**Findings**

- CONFIRMED. `interceptOutboundHttp(addr, Fetcher)` handles plain HTTP. `interceptOutboundHttps(addr, Fetcher)` handles HTTPS on port 443 by default. `interceptAllOutboundHttp(Fetcher)` handles HTTP on port 80 only. A `*` target on `interceptOutboundHttps` covers all HTTPS on 443. (DO API page; outbound-traffic page, "HTTPS traffic" section.)
- CONFIRMED. Handlers are `WorkerEntrypoint` classes from `this.ctx.exports`. They run in the Workers runtime, outside the container, and have access to Workers bindings. Props can carry per-instance data. (outbound-traffic: "Define outbound handlers"; "Securely inject credentials".)
- CONFIRMED. **Header injection is the documented pattern.** The example handler checks the hostname and protocol, then does `new Request(url, request)`, calls `headers.set("x-auth-token", this.env.SECRET)`, and `fetch(requestWithAuth, { redirect: "manual" })`. The docs say "No token is exposed to the container." (outbound-traffic: "Securely inject credentials".) Applying this to `api.anthropic.com` means setting `x-api-key` (or `Authorization`) in the handler. The Anthropic header name is INFERRED from Anthropic's API convention. It is not checked against a Cloudflare page.
- CONFIRMED. Security caveat from the docs: "The intercept matches the TLS server name, but the request URL comes from the `Host` header, which code in the container controls." So the handler must check `url.hostname` and `url.protocol` before adding a credential.
- CONFIRMED. Intercepts are per container lifetime. "An intercept lasts until the container stops. Register intercepts each time the Durable Object starts the container." Re-registering a target replaces its handler; open connections keep working. You cannot remove an intercept while the container runs, so swap in a deny handler instead. (DO API + outbound-traffic "Change policies at runtime".)
- CONFIRMED. `enableInternet: false` blocks all public egress. Only intercepted HTTP/HTTPS leaves the container. DNS for hostnames not covered by intercepts times out. (outbound-traffic: "Block outbound traffic", "Non-HTTP traffic".)
- CONFIRMED. `ctx.exports` needs compatibility date `2025-11-17` or later, or the `enable_ctx_exports` flag.

**CA / trust (HTTPS interception)**

- CONFIRMED. When an HTTPS intercept is active, an ephemeral CA file is created at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. The intercept terminates TLS with a cert this CA signs. You must register HTTPS intercepts **before** `start()`, so the file exists when the entrypoint runs. (outbound-traffic: "HTTPS traffic".)
- CONFIRMED. The container must trust that CA. Do not bake it into the image, because it only exists at runtime. Instead the start `entrypoint` copies it into the distro trust store and refreshes it. Examples given:
  - Debian/Ubuntu: `cp ... /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates && exec node server.js`
  - RHEL-style: `cp ... /etc/pki/ca-trust/source/anchors/ && update-ca-trust`
  - Alpine/Wolfi-style: `trust extract-compat`
  - The docs note "If your runtime uses its own CA bundle, point it at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` directly, for example with `NODE_EXTRA_CA_CERTS` or `REQUESTS_CA_BUNDLE`."
- UNCONFIRMED. Whether a Node process started by Claude Code trusts the system store without `NODE_EXTRA_CA_CERTS`. Node's default CA set is historically Mozilla's bundle, not the system store. Setting `NODE_EXTRA_CA_CERTS` to the ephemeral CA path is the safe choice. The docs do not state the Node behaviour.

**Limits**

- CONFIRMED. 128 intercept entries per container, shared by all three methods. A hostname target costs 2 entries (IPv4 + IPv6). A hostname for both HTTP and HTTPS costs 4. A container holds at most 64 hostname targets. Going over throws `You can't configure more than 128 egress interceptors`. (DO API: "Intercept limit".)
- CONFIRMED. Outbound HTTP request **body** size is capped at 100 MiB by default. This is a documented limit, which can be raised by contacting Cloudflare. (limits page: "Outbound HTTP request body size"; outbound-traffic: "Troubleshoot outbound uploads".)
- UNCONFIRMED. **Streaming behaviour (SSE / long responses / WebSocket) through an outbound handler.** None of the three pages (DO API, outbound-traffic, limits) mentions WebSocket, SSE, or response-streaming limits, or a response idle timeout. The Anthropic Messages API streams SSE, so a real test is needed. Per the DO API page's `interceptOutboundHttps` text, a handler is a normal `fetch()` that returns a `Response`, so streaming bodies should pass through, but this is not documented.
- CONFIRMED. "Only HTTP and HTTPS traffic can be intercepted." Other protocols are not intercepted. (outbound-traffic: "Non-HTTP traffic".)
- CONFIRMED. `wrangler dev` supports outbound interception through a sidecar using TPROXY. (outbound-traffic: "Local development".)

**Local references**

- CONFIRMED. `/Users/ianpascoe/src/cloudpid/docs/research/container-backends/code-coupling.md` line 34. The computer library (`index.js:793-799`) calls `interceptAllOutboundHttp` / `interceptOutboundHttps`, **only** for `egress: http-gateway`. Cloudpid uses `egress: {mode: "direct"}` (`ws/Workspace.ts:480`). So the http-gateway egress mode of computer is the existing code path for the proposed pattern. The computer code itself is not in this repo, so it is not read here.

---

## 2. `claude-agent-acp` (Zed's Claude Code ACP adapter)

**Package name (CONFIRMED)**

- The **old** name `@zed-industries/claude-agent-acp` is deprecated on npm. Last version 0.23.1. The npm page says: "This package has been renamed to @agentclientprotocol/claude-agent-acp. Please migrate." (https://www.npmjs.com/package/@zed-industries/claude-agent-acp)
- The **current** name is `@agentclientprotocol/claude-agent-acp`. `dist-tags.latest` = 0.104.1; `preview` = 0.104.1-preview.3. Bin: `claude-agent-acp` → `dist/index.js`. Engines: `node >=22`. (https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp; https://raw.githubusercontent.com/zed-industries/claude-agent-acp/main/package.json — the repo's package.json already has the new name and version 0.104.1.)

**Bundles or depends on Claude Code? (CONFIRMED for the dependency; UNCONFIRMED for the contents)**

- CONFIRMED. Runtime `dependencies` of 0.104.1: `@agentclientprotocol/sdk` 2.5.0, `@anthropic-ai/claude-agent-sdk` 0.3.322, `diff` 9.0.0, `zod` 4.6.7. (package.json, GitHub main.)
- CONFIRMED. `@anthropic-ai/claude-agent-sdk` 0.3.322 declares `"claudeCodeVersion": "2.1.322"` and `optionalDependencies` on per-platform packages: `@anthropic-ai/claude-agent-sdk-linux-x64`, `-linux-arm64`, `-linux-x64-musl`, `-linux-arm64-musl`, `-darwin-*`, `-win32-*`. (https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest.)
- CONFIRMED. README: "Each holds two files: `claude-agent-acp`, and the Claude CLI (`claude`) it runs." This is for the **standalone executables**. (https://raw.githubusercontent.com/zed-industries/claude-agent-acp/main/README.md, "Standalone executables".)
- CONFIRMED. `CLAUDE_CODE_EXECUTABLE` replaces the bundled Claude CLI with one you already have. (same README.)
- UNCONFIRMED. The per-platform SDK packages contain the native `claude` binary. This is the usual design and fits `claudeCodeVersion`, but I did not download the tarballs.

**Linux x64 support**

- CONFIRMED. Standalone release archives exist for "Linux (glibc and musl), macOS and Windows, on x64 and arm64". On Alpine, install `libgcc` and `libstdc++`. (README.)
- CONFIRMED. The SDK declares Linux x64 (glibc and musl) optional binaries. (SDK registry metadata above.)
- INFERRED. The npm install path works on Linux x64 with Node 22+.

**Authentication**

- CONFIRMED. The adapter README does not document `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_BASE_URL`. Its only auth-related text is the `CLAUDE_CODE_EXECUTABLE` line. Auth is handled by the Claude Code CLI underneath.
- CONFIRMED. Claude Code auth (code.claude.com/docs/en/authentication): `ANTHROPIC_API_KEY` set in the environment lets Claude Code skip the login prompt, if the user approves the key. `CLAUDE_CODE_OAUTH_TOKEN` is a long-lived token from `claude setup-token`, for CI and scripts. It "authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan."
- UNCONFIRMED. Whether `claude-agent-acp` forwards `ANTHROPIC_API_KEY` to the CLI without the approval prompt. In a non-interactive container, that prompt matters. Needs a test, or a read of the adapter's `src/` for how it spawns the SDK.

**ANTHROPIC_BASE_URL**

- CONFIRMED. Claude Code env var reference (code.claude.com/docs/en/env-vars): `ANTHROPIC_BASE_URL` "Override the API endpoint to route requests through a proxy or gateway." The authentication page says to use it for a custom endpoint.
- UNCONFIRMED. Whether `claude-agent-acp` / the Agent SDK passes the parent environment through to the spawned CLI, so `ANTHROPIC_BASE_URL` takes effect. The README does not say. Needs a test or source read (`src/` is not fetched here).
- INFERRED. If the spawned CLI inherits `process.env`, then `ANTHROPIC_BASE_URL` pointing at an intercepting host works. Combined with section 1, an intercept on `api.anthropic.com` would be reached without a base-URL change. Setting `ANTHROPIC_BASE_URL` is not required for that case.

**`opencode acp`**

- CONFIRMED. OpenCode supports ACP. "To use OpenCode via ACP, configure your editor to run the `opencode acp` command. The command starts OpenCode as an ACP-compatible subprocess ... over JSON-RPC via stdio." (https://opencode.ai/docs/acp/)
- CONFIRMED. The Zed custom-agent config is `{"type":"custom","command":"opencode","args":["acp"]}`. (same page.)

---

## 3. Codex CLI Linux sandbox

**Sources**
- Sandbox: https://developers.openai.com/codex/concepts/sandboxing
- Agent approvals & security: https://developers.openai.com/codex/agent-approvals-security
- Config reference: https://developers.openai.com/codex/config-reference
- `codex-rs/linux-sandbox/README.md`: https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/README.md

**Mechanism**

- CONFIRMED. "**Linux** uses `bwrap` plus `seccomp` by default." (agent-approvals-security, "OS-level sandbox".)
- CONFIRMED. Codex uses the first `bwrap` on `PATH`. If none is found, it falls back to a bundled helper, "but that helper requires support for unprivileged user namespace creation." Codex warns at startup when `bwrap` is missing or the namespace can't be created. (sandboxing; linux-sandbox README.)
- CONFIRMED. `seccomp` installs `PR_SET_NO_NEW_PRIVS` and syscall filters. The legacy Landlock filesystem implementation is retained. (linux-sandbox README.)
- CONFIRMED. The sandbox uses **unprivileged** user namespaces. The docs describe no root requirement. Install `bubblewrap` via apt/dnf.
- CONFIRMED. Ubuntu 24.04+: AppArmor can block unprivileged user namespaces. Fixes are the `bwrap-userns-restrict` profile or `kernel.apparmor_restrict_unprivileged_userns=0`. (sandboxing.)
- CONFIRMED. WSL1 is not supported. (linux-sandbox README.)

**Running in a Firecracker microVM container as non-root**

- CONFIRMED (docs say so explicitly). "When you run Linux in a containerized environment such as Docker, the sandbox may not work if the host or container configuration blocks the namespace, setuid `bwrap`, or `seccomp` operations that Codex needs. In that case, configure your Docker container to provide the isolation you need, then run `codex` with `--sandbox danger-full-access` (or the `--dangerously-bypass-approvals-and-sandbox` flag) inside the container." (agent-approvals-security.)
- UNCONFIRMED. Whether a Firecracker guest kernel and Cloudflare's container runtime allow unprivileged user namespaces and the seccomp filters `bwrap` needs. This depends on the guest kernel config (`CONFIG_USER_NS`, `unprivileged_userns_clone`-style settings) and the runtime's seccomp profile. No primary source found for Cloudflare Containers here. Must be tested: `bwrap --unshare-user --ro-bind / / true` as the non-root user.
- INFERRED. As non-root, bwrap works if unprivileged userns is enabled and no AppArmor/seccomp policy blocks it. Outer isolation is then the microVM itself.

**No-sandbox mode for already-sandboxed environments**

- CONFIRMED. `sandbox_mode` accepts `read-only | workspace-write | danger-full-access`. "`danger-full-access`: The agent runs without sandbox restrictions." (config-reference; sandboxing.)
- CONFIRMED. "Full access means using `sandbox_mode = "danger-full-access"` together with `approval_policy = "never"`." (sandboxing.)
- CONFIRMED. CLI flags: `--sandbox danger-full-access`, or `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`). The docs list it as "No sandbox; no approvals (not recommended)". (agent-approvals-security.)
- CONFIRMED. `default_permissions` also accepts the built-in profile `:danger-full-access`, and must not be combined with `sandbox_mode`. (config-reference.)
- CONFIRMED. Dev Containers are documented as an outer isolation boundary: "Devcontainers provide substantial protection, but they do not prevent every attack." (agent-approvals-security, "Run Codex in Dev Containers".)

---

## 4. alchemy v2 (beta) Cloudflare Worker bundling

**Versions (CONFIRMED)**
- npm `alchemy`: `dist-tags.latest` = 2.0.0-beta.85; `next` = 2.0.0-beta.72. (https://registry.npmjs.org/alchemy.)
- `@alchemy.run/cloudflare` and `@alchemy.run/cloudflare-runtime`: both 2.0.0-beta.85. `cloudflare-runtime` exports `./rolldown`, `./rolldown/options`, `./rolldown/plugins`. The `cloudflare()` Rolldown plugin takes `compatibilityDate`, `compatibilityFlags`, `moduleRules`, `exports`, `main`, etc. (`packages/cloudflare-runtime/src/rolldown/options.ts`, GitHub main.)

**Docs**
- CONFIRMED. The v2 Worker docs (https://alchemy.run/providers/cloudflare/workers/worker.md) say: "`main` is bundled with rolldown at deploy time." There is a `build` prop:
  - `build: { pure: { packages: [...] } }` marks packages as side-effect free for tree-shaking. `pure: false` disables it.
  - **Node module stubs:** "Use Rolldown's `build.input.resolve.alias` for module replacements. Aliases apply to imports and static `require()` calls before Node compatibility shims. Use absolute paths for file replacements." Example: `build: { input: { resolve: { alias: { module: stub, "node:module": stub } } } }`.
  - "Keep bundling enabled: `bundle: false` uploads files unchanged and does not apply aliases. Alternatively, apply aliases in your external build before uploading its output with `bundle: false`."
- CONFIRMED (source). `WorkerProps.build` is `WorkerBuildOptions`, which extends `Bundle.BundleConfig`. `BundleConfig.input` is `Partial<rolldown.InputOptions>` and `output` is `Partial<rolldown.OutputOptions>`. (`packages/alchemy/src/Bundle/Bundle.ts`; `packages/alchemy/src/Workers/Workerd/Bundle.ts`.)
- CONFIRMED (source). The bundler passes user plugins through: `rolldown.rolldown({ ...input, plugins: [inputOptions.plugins, await builtInPlugins(extra)] })`. So `build.input.plugins` (rolldown plugins) reaches rolldown. The docs do not show a plugin example. The `input.resolve.alias` override is documented; plugins are source-confirmed only. Note the source also re-checks aliases for the `builtin:esm-external-require` plugin, so custom aliases are supported.
- CONFIRMED. `bundle?: boolean` (default `true`). With `bundle: false`, "The entry and every file around it matching `rules` are uploaded byte-for-byte — no bundling, no minification, no transformation." "Durable Object and Workflow classes must be exported by the prebuilt entry itself — `exports` is not applied when `bundle` is `false`." (`packages/cloudflare/src/Workers/Worker.ts`.)
- CONFIRMED. `rules?: ModuleRule[]` picks files to upload as their own Worker modules (`.wasm`, `.txt`, `.sql`, etc.). (Worker.ts; Sources/Rolldown.ts.)
- CONFIRMED. `isExternal` props exist for externally-bundled Workers. Used by `workerBundleOptions` (`Sources/Rolldown.ts`).
- **Discrepancy (CONFIRMED):** https://v2.alchemy.run/providers/cloudflare/worker shows a **v1-style** API (`entrypoint`, `noBundle: true`, `rules`, `dev.tunnel`). Do not use it for v2. The v2 source uses `bundle` and `build`, not `noBundle` or `entrypoint`.

**Local usage**

- `/Users/ianpascoe/src/cloudpid/infra/alchemy.run.ts`: no Worker-level `build`, alias, or plugin config. It uses `Alchemy.Stack`, `Cloudflare.providers()`, `Cloudflare.state()`, and `Server` / `Workspaces` / `AppSandbox` resources from `@cloudpid/server` and `@cloudpid/app-sandbox`. The Worker is defined inside those packages (not read here).
- `/Users/ianpascoe/src/cloudpid/apps/mcp-worker/src/resource.ts`: `Cloudflare.Worker("McpWorker", { main: new URL("./worker.ts", import.meta.url).href, compatibility: { date: "2026-08-31", flags: ["global_fetch_strictly_public"] }, ... })`. No `build` prop. Its `vitest.config.ts` says "`entry` bundled as alchemy bundles a Worker at deploy (rolldown with its Cloudflare plugins)". It calls `rolldown({...})` with `@alchemy.run/cloudflare-runtime/rolldown` directly, to build test fixtures.
- `/tmp/ref/t3code/infra/relay/src/worker.ts` (lines ~114-130): `export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}`, then `Api.make(... { main: import.meta.filename, compatibility: { date: "2026-05-22", flags: ["nodejs_compat"] }, placement: { region: "aws:us-west-2" }, domain })`. No `build`, alias, or plugin config.
- `/tmp/ref/t3code/infra/relay/alchemy.run.ts`: `Alchemy.Stack("T3CodeRelay", { providers, state: Cloudflare.state() }, ...)`, and `RelayWorker.Api` comes from `src/worker.ts`. It uses `Effect.provide(RelayWorker.layer)`.
- **Conclusion (INFERRED):** neither repo sets `build.input.resolve.alias` or a prebuilt bundle. Both use plain `main` + `compatibility`. To alias `node:fs` for some importers, add `build: { input: { resolve: { alias: {...} } } }` on the Worker. A prebuilt bundle needs `bundle: false` plus `main` pointing at the artifact, and then aliases must be applied in the external build step.

**Unconfirmed**
- UNCONFIRMED. Whether `alias` can target only *some importers* (the docs show global aliases). Rolldown's `resolve.alias` is global by spec. Per-importer rewriting would need a custom plugin in `build.input.plugins`, which is source-supported but untested.

---

## Summary of open items (need a test)

1. Streaming (SSE) through an outbound handler: UNCONFIRMED.
2. Whether a Firecracker/Cloudflare container allows non-root `bwrap` (userns + seccomp): UNCONFIRMED.
3. Whether `claude-agent-acp` forwards `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` into the CLI: UNCONFIRMED (adapter `src/` not read).
4. Whether the per-platform `@anthropic-ai/claude-agent-sdk-linux-x64` tarball contains the native `claude` binary: UNCONFIRMED (not downloaded).
5. Node trust of the ephemeral CA without `NODE_EXTRA_CA_CERTS`: UNCONFIRMED.
