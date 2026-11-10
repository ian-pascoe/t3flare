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

**CLI agent**:
A coding-agent CLI (Codex, Claude Code, OpenCode) running as a process in a Container.
_Avoid_: Mode 1, container agent

## Credentials

**Provider instance**:
One configured way to reach an agent or model provider, with its own credentials. Used in t3's sense.

**Subscription login**:
The owner's own signed-in plan with a model vendor (Claude, ChatGPT), as opposed to an API key.
_Avoid_: OAuth, account

**Credential broker**:
The single holder and refresher of Subscription logins.
_Avoid_: vault, keychain

**Handle**:
An opaque stand-in for a credential, given to one CLI agent process and redeemed only by the broker's intercept.
_Avoid_: placeholder, fake token

## Upstream

**State directory**:
The directory where t3 keeps its own files, apart from Projects.

**Shadow**:
A whole t3 module replaced by ours at bundle time.
_Avoid_: override, monkeypatch

**Patch**:
A line-level change to t3's source, kept as a patch file.
_Avoid_: fork change, hack
