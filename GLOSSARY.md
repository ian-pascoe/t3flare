# t3flare

t3flare runs a t3code Environment on Cloudflare, so the stock t3 clients can orchestrate self-hosted cloud agents alongside the owner's laptop.

## Environments

**Environment**:
One t3 server and everything it owns: projects, threads, providers, files and state. Used in t3's sense.
_Avoid_: server, host, instance

**Cloud Environment**:
The Environment t3flare runs on Cloudflare.
_Avoid_: remote, cloud server

**Laptop Environment**:
The owner's stock t3 Environment on his own machine.
_Avoid_: local server, desktop

**Environment DO**:
The Durable Object that is the Cloud Environment's control plane.
_Avoid_: orchestrator DO, server DO

**Peer link**:
A sign-in from one Environment to another's MCP endpoint, letting its agents delegate work there.
_Avoid_: link, bridge, connection

**Linked work**:
Threads a Peer link started in the Environment it signed in to, and the work derived from them; each carries the link's
`linkOrigin` (its client session, label and access).
_Avoid_: remote threads, foreign work

**Link fence**:
What Linked work from a link paired below full access may not do: change the owner's threads, projects, settings or
schedules, or use that Environment's own links (t3's), exceed the modes the link hands down, or `git push` without an
approval each time (ours). A full-access link is not fenced.
_Avoid_: sandbox, isolation

**Remote task**:
A delegated task whose child thread runs in another Environment over a Peer link; the parent's Environment follows it
and completes the task with the child's last reply.
_Avoid_: remote subagent, cloud task

**T3 Connect**:
The hosted relay at `t3.codes` that T3's mobile apps register with; it pushes an Environment's published thread
phases to the owner's phone (ADR-0023).
_Avoid_: the cloud, the relay service, push service

**Publish-only link**:
The Cloud Environment's link to T3 Connect: a `manual` link scoped to agent-activity notifications, made once from
an admin route, with which the Environment publishes and T3 Connect can never call back.
_Avoid_: Connect link, tunnel link, Peer link (that is laptop-to-cloud)

## Work

**Project**:
One repo, as t3 shows it, in the Cloud Environment.
_Avoid_: repo (for the t3 concept), Environment (cloudpid's sense)

**Workspace**:
The files of one Project or worktree thread: a file system that is the source of truth, plus a Container when needed.
_Avoid_: sandbox, worktree (for the cloud resource)

**Container**:
The Linux machine a Workspace starts only to run real binaries. A synced copy of the Workspace's files, never their source of truth.
_Avoid_: sandbox, VM, box

**Container-only path**:
A path of a Workspace kept on its Container's disk alone, never in its files: dependency and build caches (`node_modules`, `.next`, …) and the repo's submodules with their git directories. Gone when the Container stops; the command that made it makes it again.
_Avoid_: ignored path (that is git's), local-only

**Worker Shell**:
The shell that runs commands in a Worker, without a Container.

**Session**:
One Durable agent's conversation, kept in its own Durable Object.
_Avoid_: thread (that is t3's), run

**Durable agent**:
An agent running on pi-durable in a Session, mostly on Workers. t3 shows its provider as **Pi Durable**.
_Avoid_: Mode 2, cloud agent, Pi (cloud)

**Pi Durable**:
The Durable agent provider as t3 lists it, under the driver kind `piDurable`. Not the pi CLI.
_Avoid_: Pi (cloud), cloud Pi, Pi (that is the CLI agent)

**Approval**:
A Durable agent's tool call waiting for the owner's Approve or Decline, kept in the Session's storage so it survives the Session restarting. The runtime mode decides which calls ask.
_Avoid_: permission prompt, confirm

**Write journal**:
The paths written in a Workspace since a given revision of its files, read from computer's change log; what a stale git read is patched with.
_Avoid_: change feed, dirty list

**Stale read**:
A passive git read answered while the Container is stopped: its last real answer, patched with the Write journal where its shape allows. A passive read never starts the Container.
_Avoid_: cached status, emulated git

**Terminal**:
t3's terminal, whose shell is a bash under the platform's PTY in the Workspace's Container. It ends with its Environment.
_Avoid_: shell session, console, PTY (that is the seam under it)

**Worktree Workspace**:
The Workspace of a `worktree` thread: a full clone of its project's repo at `/w/.wt/<project dir>/<dir>`, with its own Container. Not a git worktree.
_Avoid_: git worktree (for the cloud resource), linked worktree

**Project-root view**:
A Worktree Workspace's copy of its project's untracked files, at the project's path in its Container, for a setup script's `$T3CODE_PROJECT_ROOT`.
_Avoid_: project mount, shared root

**Tombstone**:
A removed Workspace whose files are kept for the grace (uncommitted work, or a removal step that could not run): gone for t3, restorable.
_Avoid_: trash, soft delete

**Sweep**:
The Environment's daily pass over the Workspace registry that purges what nothing references past the grace, and stops Containers no Workspace holds.
_Avoid_: garbage collection, cleanup job

**CLI agent**:
A stock coding-agent CLI (Codex, Claude Code, OpenCode, pi) running as a process in a Container, through t3's own provider for it.
_Avoid_: Mode 1, container agent

**Pi**:
The stock pi coding agent CLI as a CLI agent, through t3's built-in Pi provider, which shows it as "Pi". Not a Durable agent.
_Avoid_: Pi Durable (that is the Durable agent provider), pi CLI agent

## Credentials

**Provider instance**:
One configured way to reach an agent or model provider, with its own credentials. Used in t3's sense.

**Model proxy**:
The HTTP endpoint every model call goes to, for every agent (Durable agents' and CLI agents' turns, generated titles and commit text, the model list), set by `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY`. It holds the owner's Subscriptions and provider keys; t3flare holds only its URL and keys. It speaks the Anthropic Messages API, lists its models at `GET /v1/models` and translates to other providers; t3flare is built against Commissary. See `docs/model-proxy.md`.
_Avoid_: gateway, LLM router

**Subscription**:
The owner's own signed-in plan with a model vendor (Claude, ChatGPT), as opposed to an API key. Connected in the Model proxy, never held by t3flare.
_Avoid_: Subscription login (t3flare holds none), OAuth, account

**Container token**:
A GitHub installation token for one Workspace's one repo, handed to git in its Container per command or on the credential helper's request; never stored there.
_Avoid_: repo token, deploy key

**Environment token**:
The GitHub installation token t3's own PR features use, answered to `gh auth token`; it never reaches a Container or a Session.
_Avoid_: gh token, PAT

**Handle**:
An opaque stand-in for a credential, given to one CLI agent process and redeemed only by an intercept outside the Container. Whether CLI agents get one, or the proxy key itself, is open (ADR-0016).
_Avoid_: placeholder, fake token

**Safe mode**:
The Environment DO's state where it does not start t3, and only the admin routes answer; entered by hand or after three boots in a row fail.
_Avoid_: maintenance mode, recovery mode

**Pairing window**:
The minutes, opened by an admin route, during which t3's bootstrap grant exists and the bootstrap token pairs a client.
_Avoid_: bootstrap mode

## Upstream

**State directory**:
The directory where t3 keeps its own files, apart from Projects.

**Shadow**:
A whole t3 module replaced by ours at bundle time.
_Avoid_: override, monkeypatch

**Patch**:
A line-level change to t3's source, kept as a patch file.
_Avoid_: fork change, hack

**Build shim**:
A bundle-time substitute for a Node builtin or a dependency that cannot load in workerd, applied only to the modules that need it.
_Avoid_: polyfill, Shadow
