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
