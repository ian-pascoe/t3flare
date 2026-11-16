# No vendor credential enters a Container, and CLI agents reach the model proxy

Revised 2026-11-11, after [ADR-0012](0012-all-model-access-goes-through-the-model-proxy.md) (all model access goes through the model proxy); the original is kept under [History](#history).

A CLI agent (Codex, Claude Code, OpenCode, pi) is configured with the model proxy's base URL and a proxy key, through the CLI's own base-URL setting. It is never given a vendor credential or a Subscription login: t3flare holds none. No credential is written to the Workspace file system. The CLI's session-state directories sit beside the repo, outside any t3 path, and are synced; they hold no secrets. GitHub access is unchanged ([ADR-0013](0013-github-access-through-a-github-app-with-per-repo-tokens.md)): Container tokens per command or on the credential helper's request, never stored.

Of the original Handles and HTTPS intercepts, the only possible use left is the proxy key's way into the Container, and whether it needs them is open.

## Open question for step 4a: the proxy key in the Container, or injected by an intercept?

Closed by step 4a: A′ (the decision above). The options as they were weighed:

**A. A revocable, models-only proxy key in the CLI's environment.** A Commissary API key can be revoked, can carry an expiry (`expires_at`), can have an empty tool scope, which gives it no tools and leaves only models, and can have its own spend limit (Commissary `packages/contract/src/api-keys.ts`, `spend.ts`).

- For: no intercept and no ephemeral CA for each CLI to trust; long streams do not pass through an intercept handler (the riskiest of step 4a's checks); each CLI uses its stock base-URL setting, the same way for all four.
- Against: anything in the Container can read the key (the agent's own shell, a dependency's install script, a prompt-injected command) and send it out. Its exposure is then bounded by its spend limit, its expiry and revocation, not by the Container. A Durable agent's shell may share the Container with a CLI agent (one Container per Workspace).
- Costs to settle: a key per spawn or per Container start needs Commissary's API to mint keys with an expiry, and a key that can mint keys is itself a secret of the Workers; a key made by hand is shared by every Container and is rotated by hand.
- Possible mitigations: a key for CLI agents only, with its own spend limit and a short expiry; the Durable agents' key never enters a Container; credentialed CLIs run under a second user ID so a Durable agent's shell cannot read their environment.

**B. A Handle in the CLI's environment, swapped for the real key by an HTTPS intercept.** The original design, narrowed to one host: the proxy's.

- For: the real key never enters the Container. A Handle is useless outside it and is revoked at the CLI's exit.
- Against: intercepts registered before every Container start; an ephemeral CA every CLI must trust (Node, Bun and Codex's Rust TLS stack each differ); long streaming calls (30 minutes and more, with idle gaps) through the handler, not yet verified. While the Handle lives, any process in the Container can spend through it, so it stops the key leaving, not its misuse.

**A variant of A: a helper that fetches the key at use time.** Codex's model-provider `auth` command (t3's managed mode already uses one: `CodexManagedRuntime.ts`) and Claude Code's `apiKeyHelper` can ask the Workspace DO for the key when they need it, as the git credential helper asks for a Container token. The key is then in no environment and on no disk, but any process that can run the helper can get it, and OpenCode and pi have no such hook that is known yet.

Either way: an intercept checks the URL's host (the Host header is container-controlled), and each CLI is spawned with an explicit environment.

## Decision (step 4a, 2026-11-12): A′, a key helper, built

The owner chose A′. The CLI agents' key is `COMMISSARY_CONTAINER_API_KEY`, never the Workers' `MODEL_PROXY_API_KEY`, bound to the agents Worker alone.

- **The helper.** `/opt/t3flare/bin/t3flare-model-key` asks the Workspace DO through computer's egress host (`GET http://computer.internal/t3flare/model-key`) and prints the key for the CLI: Codex's model-provider `auth` command (Codex asks twice as it starts, then keeps it), pi's `!command` `apiKey` (once per model request; 17 ms p50 from the Container). It writes nothing and logs nothing.
- **The route** answers only for the nonce of a CLI process that lives in that Workspace (`T3FLARE_MODEL_KEY_NONCE`, issued per spawn), a Codex nonce at most 3 times. Codex's shells never see the nonce (`shell_environment_policy.exclude`); pi's `bash` does, so for pi it is not a boundary. Every grant is logged without the value.
- **CLI homes** are built fresh per spawn on the Container's own disk (`/var/lib/t3flare/cli/<key>`); only the session directories are synced (`/workspace/.t3flare/codex/sessions`, `/workspace/.t3flare/pi/sessions`). Codex's SQLite is Container-local; it resumes from the rollout alone, even after a torn last line. pi trusts no project (`--no-approve`, `defaultProjectTrust: never`), and `PI_CODING_AGENT_SESSION_DIR` overrides a repo's `sessionDir`. A repo's `.codex/config.toml` cannot set the provider (Codex ignores it there).
- **The sync guard.** While a CLI process lives (and once after the last one), the files changed since the last scan are scanned in the Container before each pull, the scanner given each credential's prefix, length and SHA-256, never its value. A hit is moved to `/var/lib/t3flare/quarantine`, the Workspace's CLI processes are killed, and the key is flagged for rotation. Core dumps are off for CLI processes.
- **Evidence** (`docs/steps/step-4a/m6-leak.json`, `m6-egress.json`): after Codex and Pi turns, no credential in the DO's files, the Container's files, or any process's environment or command line; a Pi agent made to write the key into the repo had the file quarantined before the pull, its CLI killed, the key flagged, and the DO's files and the turn's checkpoint stayed clean. Egress with the profiles' settings reaches only the proxy's host.
- **Residual.** Any process that can run the helper with a live nonce can get the key: the CLI's own agent, a prompt-injected command (pi's shells hold the nonce). Exposure is bounded by the key's own scope, spend limit and the guard; the owner rotates it (`docs/model-proxy.md`). computerd's own copy of the Workspace (`/var/lib/computerd/state.db`, Container disk, never synced) keeps a file's bytes written before the guard moved it; it goes with the Container. Not in 4a: a second user ID for CLI processes, a key per Container start.

## Consequences

Not offered: ACP's terminal `/login`, or any vendor sign-in inside a Container, which would write a rotating credential into the synced Workspace.

## History

### 2026-11-10: credentials stay in the broker, and Containers get per-spawn Handles

Revised on 2026-11-11 by the text above. The original:

> No credential enters the Workspace file system, and in the normal path none enters the Container. A CLI agent is given a **Handle**: an opaque placeholder, shaped like a real token, registered at spawn and revoked at exit. The Workspace DO registers HTTPS intercepts for the vendor hosts before each Container start. The handler checks the URL's host (the Host header is container-controlled), swaps the Handle for the real credential, and routes: Subscription traffic goes straight to the vendor, proxy-key traffic is rewritten to the proxy. The CLI's session-state directories sit beside the repo, outside any t3 path, and are synced; they hold no secrets.
>
> If streaming through the intercept handler fails, Containers instead get real access tokens that expire within hours, never refresh tokens or year-long tokens. Credentialed CLIs then run under a second user ID so a Durable agent's shell cannot read their environment. Not offered: ACP's terminal `/login`, which would write a rotating credential into the synced Workspace.

## Refinement (step 4b, 2026-11-12): the key path for Claude Code and OpenCode

- **Claude Code** takes the key from `apiKeyHelper` in its managed settings: `t3flare-claude-key`, which runs 4a's `t3flare-model-key claude` with this process's nonce, read from the process's Container-local home (the launcher moves it there from the environment, so Claude's Bash, hooks and helpers never inherit it). Claude Code's own env scrub was tried and rejected: in 2.1.322 it isolates every command with bubblewrap and leaves empty decoy files (`package.json`, `.gitmodules`, `.env*`) in the repository (M0 P1). `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` is 24 h: one grant per process (M0 P1); the gate allows 2.
- **OpenCode** takes it from a server plugin of ours in the image (`/opt/t3flare/share/opencode-key-plugin`), allowed by absolute path while every other plugin is denied: at load it asks the helper once with the nonce, deletes the nonce from its process environment, and sets `x-api-key` on the `t3flare` provider through `ctx.provider.transform`. No loopback relay was needed (M0 P2). One grant per process; the gate allows 2; a re-ask after a 401 is SPI-1045. (SPI-1169: on the model relay the plugin asks no helper; a handle does not rotate while its process lives, so SPI-1045 is moot there, and the key helper itself goes at the hard cut.)
- Neither CLI is offered a login: Claude's `initialize` lists no auth method under the managed helper; OpenCode lists `opencode-login`, which t3flare never invokes (`authenticateOnAuthRequired: false`), and `integration.connect` is denied. An `auth_required` or a 401 is reported as the deploy's `COMMISSARY_CONTAINER_API_KEY` refused.
- The sentence "OpenCode and pi have no such hook that is known yet" is closed for OpenCode by the plugin.
- Residual risk, unchanged from 4a: the agent runs as root, so `/proc/<pid>/environ` of the launcher (which still holds the nonce) and the managed files are readable and writable by the agent's own commands; the grant count bounds the nonce, and those files defend against a repository's configuration, not against an agent already running commands. A canary planted in the Environment DO's `process.env` reached no CLI process on stage (M5).

## Refinement (SPI-992)

**Superseded** (owner, 2026-11-12, back to stock): the Container token writes code again and pushes go straight to GitHub (ADR-0013's back-to-stock refinement). Model and vendor credentials stay out of Containers as above.

The same holds for GitHub write access: no token that can write code enters a Container. The Container token is read-only; pushes are authorised outside, at the push gateway (ADR-0013's SPI-992 refinement).

## Refinement (tools step): tool handles, and no MCP credential in a Container

CLI agents reach MCP tools with a **tool handle**: an opaque per-process bearer that the Workspace DO issues when the process starts and revokes when it exits. It is passed per process (argv, ACP `session/new`, or a per-home helper), never in a Container-wide file. Outside its Workspace or after its process it is useless, and the relay judges it as its own thread. Commissary's key and direct servers' headers and OAuth tokens never enter a Container: the Environment DO adds them outside (ADR-0028). t3's per-thread MCP bearer does, as stock t3 hands it to a CLI (owner, 2026-11-12, back to stock; ADR-0022's tools refinement): it reaches only t3's tools for that thread. Evidence: `docs/steps/tools/m5-relay-hostile.json`.

## Refinement (parity batch 2, G13): ACP registry agents

t3's ACP registry offers 45 agents. The rule above admits one that takes the proxy's base URL through its own setting **and** its key from a helper on demand (A′). Four do, and each is already a built-in provider of t3's own kind: Claude Agent, Codex, OpenCode and pi. The others either sign in with their vendor (refused, parity D3) or read their key only from their environment or a settings file (Gemini CLI, Qwen Code, goose, Mistral Vibe and most of the rest), which would put the Container key in the agent's environment, readable by every command it runs, with no grant count. They are listed with that reason and refused (`apps/environment/src/provider/acpRegistry.ts`); nothing is installed, at runtime or in the image. Admitting them is the owner's call (`docs/steps/parity-batch-2.md`, "For the owner").

## Refinement (SPI-1152): Variables are never credentials

The owner's Variables (ADR-0032's Variables refinement) reach every command in a Workspace, CLI agent processes
included, so any agent can read them. A Variable is therefore never a credential: a name with a `KEY`, `TOKEN`,
`SECRET`, `PASSWORD` or `CREDENTIAL` segment, the `GIT_`, `GH_`, `GITHUB_` and `SSH_` prefixes, and a value that looks
like a credential are refused. So is every name t3flare sets or pins for a CLI agent, such as `ANTHROPIC_BASE_URL` and
`HTTPS_PROXY`, so a Variable cannot move a CLI's endpoint or route its requests elsewhere; those also win over any
Variable. These are guard rails for the owner, not a boundary against him.

## Refinement (SPI-1167, 2026-11-14): the model relay replaces the key helper for Model endpoints

Part of **Model endpoints** (owner, 2026-11-13; [ADR-0034](0034-model-endpoints-are-the-owners-set-in-the-harness-panel.md)).
Report: [`docs/steps/spi-1167.md`](../steps/spi-1167.md). The key helper (A′ above) stays for the Model proxy until the
hard cut (SPI-1176); for Model endpoints it is replaced by a **model relay**, which is the original design's Handle
(option B) without an intercept or a CA:

1. **The route.** A CLI agent's model provider points at `http://computer.internal/t3flare/model/<endpointId>`, computer's
   egress host, which reaches the agents Worker's `WorkspaceProxy` (`apps/agents/src/workspace/modelRelay.ts`). The path
   below the endpoint's id is appended to the endpoint's base URL; the body and the answer are streamed through
   unchanged, in the Worker entrypoint (no Durable Object holds the stream). No protocol translation: a CLI uses only
   endpoints whose API it speaks. No redirect is followed. A path segment is decoded to its fixed point and refused
   (400) when a decode fails (a malformed escape, so a literal `%` too), it takes more than three decodes to settle,
   or it settles to a dot segment (alone or followed by `;`, `?` or `#`) or holds `/`, `\` or a control character,
   so no decoding upstream walks above the endpoint's base URL.
   **Headers are allowlisted** (`forwardedHeadersOf` in `@t3flare/models/relay`, beside the API's key header): the
   body's type and length, `accept`, and the API's own version headers (`openai-beta`; `anthropic-version`,
   `anthropic-beta`). Every other header the Container sends is dropped, so no header can route the key at a
   header-routed gateway (ADR-0034 §4: the key goes only to its target, headers included). The dropped names are logged.
2. **The model handle.** The Workspace DO makes one per CLI process whose profile names its endpoints (`modelRelay`),
   256 random bits, good only for those endpoints (403 for any other),
   kept in memory beside the process and put only in that process's environment (`T3FLARE_MODEL_HANDLE`); never in
   argv, a file, the Environment DO or a log. It is refused once its process exits, in any other Workspace, and as a
   Tool handle (and a Tool handle is refused as it); handles are compared in constant time. The CLI sends it as its
   key, in any API's key header; the relay never forwards it.
3. **The swap.** For a live handle, the Workspace DO asks the Environment DO (`modelRelayTarget`), which answers from the
   endpoint store's `resolve`: the endpoint's base URL and headers with its key in the header its API takes. The key is
   sent only there. The Workspace DO remembers the key's hash for the sync guard, which now looks for the endpoint
   keys the relay used, and the leak check looks for every endpoint's key. A key shorter than 20 characters is looked
   for only in the DO's files: its unsalted hash, in the scanner's argv, could be reversed by search.
4. **The log.** Every relayed request is logged by the agents Worker with its endpoint, status, method, time and the
   handle's id (its process's key), never a handle, a key or a body.
5. **Codex** gets one model provider per OpenAI Responses endpoint, `t3flare-endpoint-<endpointId>` (the id never
   changes, so a rollout naming it resumes), with the handle as its `env_key`, kept out of its shells. Codex runs a
   thread's turns only on its process's provider ("This chat uses <a>, but your current provider is <b>"), so the
   process's `model_provider` is the session's model's and the request guard names each thread's provider from its
   model's slug. A turn on a model of another provider (another endpoint, or the Model proxy) is refused: Codex cannot
   move a thread between providers, and t3 resumes the thread in the same process rather than restarting the session
   (measured on stage). Such a model needs a new thread. Claude Code, OpenCode and pi follow with their own config
   only (SPI-1168–1170).

**Residual**, as with the key helper and the Tool handle: any process that can read the CLI's environment
(`/proc/<pid>/environ`, the agent runs as root) can spend through the handle while its process lives. It cannot take
the key out of the Container, and it ends with the process. The long-stream risk that sank option B in step 4a is
measured: a stream of over 10 minutes with idle gaps up to 3 minutes completes through the relay
(`docs/steps/spi-1167/p1167.json`). The handle cannot move the key by a header: the relay chooses the target, and
the Container's headers do not reach it. The allowlist covers **headers only**: the body and the query string pass
unchanged by design (no protocol translation), so a gateway that routes on a body or query field (LiteLLM's
`api_base`, say) can be steered from the Container. An endpoint at such a gateway is outside what the relay protects. Look-alikes an upstream would only resolve after
Unicode (NFKC) normalisation or as a Windows path (fullwidth dots and slashes, `..` with a trailing space or dot) are
not refused.

## Refinement (SPI-1168, 2026-11-15): Claude Code through the model relay, and the model-routed URL

Report: [`docs/steps/spi-1168.md`](../steps/spi-1168.md); evidence: `docs/steps/spi-1168/p1168.json`.

1. **One base URL, every endpoint.** Claude Code takes one `ANTHROPIC_BASE_URL` per process (no per-model base URL;
   `modelOverrides` only maps ids), and t3 resumes a thread in the running process on a model change (SPI-1167's
   measurement). So the relay has a **model-routed URL**, `http://computer.internal/t3flare/model/_` (`_` is never an
   endpoint id): the request's JSON body names its model as `<endpointId>/<modelId>`, and the relay sends it to that
   endpoint with the model's own id in its place. The handle is checked first (a forged or revoked handle gets 401 with
   the body unread; a declared length over the cap gets 413 before anyone is asked). The body is then read into one
   buffer of at most 16 MiB (413 over it), its one top-level `model` found by a scan of its bytes (no parse; at most
   512 levels of nesting), and the model's id written over the slug in place, so the relay holds one copy (under twice
   the cap while a buffer with no declared length grows) and passes
   every other byte unchanged. A body with no model, two, or a model without an endpoint is 400. The handle's scope then
   judges the endpoint as it judges one in the path. This is the one place the relay reads a body: routing, not
   protocol translation. A model switch between two Anthropic endpoints stays in the thread's process.
2. **Claude Code's configuration.** With an Anthropic Messages endpoint that lists a model, every Claude Code process runs on those
   endpoints through the relay (not the Model proxy): base URL the model-routed URL, `availableModels` the endpoints'
   slugs, its background model (`ANTHROPIC_DEFAULT_HAIKU_MODEL`) the text-generation model when that is one of their
   models (else their small model), its handle requested for those endpoints (`modelRelay`). Every alias Claude Code
   resolves on its own is pinned to a slug, since the routed URL refuses any other model: `ANTHROPIC_DEFAULT_SONNET_MODEL`
   and `ANTHROPIC_DEFAULT_OPUS_MODEL` are the first model of that family in the owner's order, else the first model
   (Claude Code's own `default` and its subagents' `sonnet`/`opus` resolve through them). A model t3 names that is not
   a slug (t3's stock Claude default `claude-opus-5-5`, an earlier proxy model) is not in the session's model list, and
   t3's ACP adapter refuses it before any request ("The agent did not accept the model"). Until the hard cut
   (SPI-1176, which owns the fallback of old selections to the default model) it is not mapped to another model, so
   the owner is not billed for a model they did not pick. The choice is the
   Environment's, not the session's: the managed settings (`/etc/claude-code`) are the Container's, shared by every
   Claude process in it, so nothing in them is one process's. Without such an endpoint, the Model proxy as before.
3. **Where the handle is.** The Workspace DO puts it in the process's environment (as for Codex). The launcher
   (`t3flare-claude-agent-acp`) execs claude-agent-acp with a preload that deletes it from `process.env` before
   anything runs, so `claude`, its Bash, hooks and helpers do not **inherit** it; the kernel's copy of the start
   environment (`/proc/<pid>/environ`) keeps it. `apiKeyHelper` is `t3flare-claude-handle`, which reads it there by the
   launcher's pid and start time (kept in the process's home; not the handle), after checking that the pid is still
   that claude-agent-acp (its start time and command line). No file holds it.
   **This keeps the handle out of environments and files, not out of reach.** `/proc/<pid>/environ` is readable by any
   process of the same uid, and every process in the Container is root. Claude's Bash keeps `T3FLARE_EXEC`, so a command
   it runs can run `t3flare-claude-handle` and print the handle, or read the launcher's environ itself; it can also set
   `T3FLARE_EXEC` to another Claude process's directory and get that process's handle. This is the same class as
   Codex's (a Codex shell can read its parent's `/proc/<pid>/environ`), not wider: in both, any command in the
   Container can spend through any live process's handle, for that process's endpoints, until it exits, and no command
   can take an endpoint's key out of the Container. Measured on p1168 (and in `test:docker`): only the launch chain
   (`setsid` and claude-agent-acp) holds the handle in its environment; `claude`'s environment, a Bash command's `env`
   and every file in the process homes, `/etc/claude-code`, `/root`, `/tmp` and the repo do not. Claude Code sends the
   handle in both `x-api-key` and `authorization`; the relay takes it from either and forwards neither.
4. **Headers.** Nothing Claude Code needs is dropped: `anthropic-version` and `anthropic-beta` pass; the dropped names
   are its client's own (`x-stainless-*`, `x-app`, `x-claude-code-session-id`, `user-agent`,
   `anthropic-dangerous-direct-browser-access`), and its turns work without them. The allowlist is unchanged.

## Refinement (SPI-1169, 2026-11-16): OpenCode through the model relay

Report: [`docs/steps/spi-1169.md`](../steps/spi-1169.md); evidence: `docs/steps/spi-1169/p1169.json`.

1. **A provider per endpoint, at its own path.** OpenCode takes a base URL per provider, so each endpoint whose API it
   speaks is its own provider, `t3flare-endpoint-<endpointId>` (prefixed as Codex's, so no endpoint id takes one of
   OpenCode's catalog providers), at the relay's per-endpoint URL. The package is the API's: Anthropic Messages
   `@opencode/ai/providers/anthropic-compatible` (base URL `…/<id>/v1`), OpenAI Responses `openai-compatible-responses`
   and OpenAI-compatible Completions `openai-compatible` (base URL `…/<id>`). Other APIs' endpoints are not offered to
   OpenCode. The model-routed URL is not used: the relay reads no OpenCode body. Policies allow exactly those providers.
2. **The choice is the Environment's**, as Claude Code's (item 2 of SPI-1168's refinement): with such an endpoint that
   lists a model, every OpenCode process runs on the endpoints; its model ids are the endpoints' slugs, mapped to
   `t3flare-endpoint-<id>/<model>`; its small model is the text-generation model when that is one of their models. A
   model OpenCode's session does not offer (a stale `t3flare/<id>` proxy model) is refused by t3's adapter before any
   request. Without such an endpoint, the Model proxy as before.
3. **Where the handle is.** The Workspace DO puts it in the process's environment. The launcher (`t3flare-opencode`)
   execs `opencode acp`, which starts its server (`opencode serve --stdio`) as a child with that environment. The
   image's plugin, imported once in that server, reads the handle and deletes it from the server's `process.env` before
   OpenCode starts anything from it (shells, a repository's MCP servers), then sets it as the API key of each endpoint
   provider of the process's own configuration whose base URL is the relay's URL for that endpoint (each package sends
   it in its API's key header). The launcher's watcher and snapshot loop are started without it (`env -u`). No file
   holds it. **As for Codex and Claude Code, this keeps the handle out of environments and files, not out of reach**:
   the start environments of `setsid`, `opencode acp` and `opencode serve` (`/proc/<pid>/environ`) hold it, and every
   process in the Container is root, so a shell OpenCode runs can read them and spend through the handle for that
   process's endpoints until it exits. The same class, not wider; no command can take an endpoint's key out of the
   Container. Measured in `test:docker` and on p1169: the holders are exactly those three; a shell's `env`, a
   repository MCP server's environment and the launcher's loops have no handle; no file in the process homes,
   `/etc/opencode`, `/root`, `/tmp` or the repo holds it.
4. **SPI-1045.** On the relay the plugin asks no key helper: the handle is fixed for the process's life, so the
   proxy key's re-ask after a rotation does not arise.
5. **Headers.** OpenCode's own (`x-opencode-*`, `x-session-*`, `b3`, `traceparent`, `user-agent`) are dropped; its turns
   need none of them. The allowlist is unchanged.
