# Plan

The decisions behind this plan are in [`docs/adr/`](adr/); the terms are in [`GLOSSARY.md`](../GLOSSARY.md); the platform facts are in [`docs/research/`](research/).

## Milestones

| Step | Scope | Exit criteria |
|---|---|---|
| 0. Spike ✅ GO with conditions ([report](spike/step-0.md)) | t3's orchestration core and auth in the Environment DO, with stub file system and VCS Layers and no provider | On a real deploy, the stock t3 web client (served as static assets) pairs, creates a scratch project and opens a thread with live streams. Startup is under 1 s. A DO restart is survived and the client reconnects with state intact. `withTransaction` with rollback and queries over 100 parameters work. The import-scoped alias plugin works through alchemy. At most about 10 Patches and 15 Shadows. Timebox one day, with a "bundles and boots" check at midday, extendable to two. Otherwise stop and report. |
| 1. Platform ✅ ([report](steps/step-1.md)) | Harden the spike's `apps/environment` into the platform: our own build with `bundle: false` (ADR-0020); the DO SQLite adapter (ADR-0006) with deployed-stage tests on fixtures that have turn items; the State directory in 4 MiB chunks (rows are limited to 8 MB); secret store; bootstrap pairing armed by an admin route, pairing log suppressed, auth descriptor `remote-reachable`; idle reset by alarm plus `ctx.abort()` (ADR-0003) and the twice-in-one-isolate boot check; admin routes behind Access plus a token, with safe mode and a boot counter; lockfile pinning from t3's `pnpm-lock.yaml` (ADR-0019); `effect-tsgo tsrs` typecheck and tests (Vitest on Node, workerd pool); the nightly bump job | With no client the DO resets and wakes on its alarm; safe mode works; no pairing token in Workers Logs; the descriptor reports `remote-reachable`; the bump job pins the newest nightly and runs the acceptance test against a deployed stage. Upstream asks drafted for the owner to send. |
| 2a. Durable agents, part 1 | agents Worker, Session and Workspace DOs, Container, GitHub App, clone, the state differ, approvals, runtime modes, models on the proxy key, text generation | From the stock desktop client: clone a repo, run a turn that edits files and runs `bash`, approve a tool call, see the diff, push and open a PR. An Environment restart mid-turn recovers by continuation. |
| 2a. Durable agents, part 2 | Credential broker, Claude `setup-token` paste, ChatGPT managed sign-in for Durable agents | A Durable agent turn runs on each Subscription login. |
| 2b. Terminal and setup | PTY adapter, terminal, setup scripts, worktree Workspaces, deletion and sweep | A worktree thread provisions and runs its setup script; the terminal works; deleting the thread frees the Workspace. |
| 3. Peer links | Laptop-to-cloud link; t3's MCP tools in Sessions | A laptop agent delegates to the cloud, follows the task and gets the result; the cloud child can report and ask; the link fence holds. |
| 3+. T3 Connect | Publish-only T3 Connect link | Mobile notification when a cloud run ends or waits on the owner. |
| 4a. CLI agents, Codex | Process channel, readiness wrappers, Handles and HTTPS intercepts, Codex managed mode | A Codex turn on the ChatGPT login runs in two Containers at once and resumes after Container sleep; no credential is ever on synced disk. |
| 4b. CLI agents, ACP | Claude and OpenCode over ACP | Both run a turn with approvals; Claude on the Subscription login. |

## Checks per step

- **Step 1:** the alchemy plugin bug drafted as an upstream issue with the spike's evidence, for the owner to file; t3's heavy queries (thread window, shell snapshot, search) on a deployed stage with turn items; module-level state after a reset in a warm isolate.
- **Step 0 (done):** bundle size against 64 MiB; startup time; heap after boot against 128 MB; cold-boot cost; the list of streams the client subscribes to at connect, each of which must emit a first value; read latency behind open transactions; the bootstrap grant's scope for a first pairing.
- **Step 2a:** pi-durable version rule: run cloudpid's `effect-durable` tests against upstream unpatched; use upstream if they pass, otherwise pin exactly what cloudpid runs. How entangled cloudpid's extension slices are. Whether a `setup-token` token and the managed ChatGPT token work through pi-ai.
- **Step 4a:** a streaming model call (30 min or more, with idle gaps) through the intercept handler; each CLI trusts the ephemeral CA; intercepts registered before every Container start; Claude starts with only a Handle and no prompt; which hosts the Claude CLI sends its token to and whether it checks the token's shape; `bwrap` user namespaces in the image (otherwise Codex runs `danger-full-access`); what happens to an exec'd process when its Workspace DO resets; Codex managed sign-in against the Cloud Environment end to end.

## Deferred, each on its own trigger

Hibernatable sockets (a month over 400k GB-s), spare Workspaces, PR watch by webhook, cloud-to-laptop links, moving threads between Environments, subagents and rollback for Durable agents, more pi-durable extensions, an egress allowlist (`enableInternet: false` plus an allowlisting intercept), GitHub tokens through the intercept, other pi-ai Subscription logins, traces over OTLP.
