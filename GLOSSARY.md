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

**Worker Shell**:
The shell that runs commands in a Worker, without a Container.

**Session**:
One Durable agent's conversation, kept in its own Durable Object.
_Avoid_: thread (that is t3's), run

**Durable agent**:
An agent running on pi-durable in a Session, mostly on Workers.
_Avoid_: Mode 2, cloud agent

**Approval**:
A Durable agent's tool call waiting for the owner's Approve or Decline, kept in the Session's storage so it survives the Session restarting. The runtime mode decides which calls ask.
_Avoid_: permission prompt, confirm

**Write journal**:
The paths written in a Workspace since a given revision of its files, read from computer's change log; what a stale git read is patched with.
_Avoid_: change feed, dirty list

**Stale read**:
A passive git read answered while the Container is stopped: its last real answer, patched with the Write journal where its shape allows. A passive read never starts the Container.
_Avoid_: cached status, emulated git

**CLI agent**:
A coding-agent CLI (Codex, Claude Code, OpenCode) running as a process in a Container.
_Avoid_: Mode 1, container agent

## Credentials

**Provider instance**:
One configured way to reach an agent or model provider, with its own credentials. Used in t3's sense.

**Model proxy**:
The HTTP endpoint every model call goes to (the agents' turns, generated titles and commit text, the model list), set by `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY`. It speaks the Anthropic Messages API, lists its models at `GET /v1/models` and translates to other providers; t3flare is built against Commissary. See `docs/model-proxy.md`.
_Avoid_: gateway, LLM router

**Subscription login**:
The owner's own signed-in plan with a model vendor (Claude, ChatGPT), as opposed to an API key.
_Avoid_: OAuth, account

**Credential broker**:
The single holder and refresher of Subscription logins.
_Avoid_: vault, keychain

**Container token**:
A GitHub installation token for one Workspace's one repo, handed to git in its Container per command or on the credential helper's request; never stored there.
_Avoid_: repo token, deploy key

**Environment token**:
The GitHub installation token t3's own PR features use, answered to `gh auth token`; it never reaches a Container or a Session.
_Avoid_: gh token, PAT

**Handle**:
An opaque stand-in for a credential, given to one CLI agent process and redeemed only by the broker's intercept.
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
