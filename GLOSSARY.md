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

**Inbound link**:
A Peer link another Environment made to the Cloud Environment; what it starts here is Linked work.
_Avoid_: laptop link, incoming connection

**Outbound link**:
A Peer link the Cloud Environment made to another Environment, today the Laptop Environment. Made and governed as
on stock t3: by the owner or at an agent's asking, at the access the owner picks.
_Avoid_: reverse link, cloud-to-laptop link, laptop tunnel

**Route**:
One https address at which an Environment can be reached, and the kind of tunnel behind it (T3 Connect, Tailscale
Funnel, or the owner's own Cloudflare Tunnel). Used in t3's sense.
_Avoid_: transport, endpoint, tunnel (for the address)

**Linked work**:
Threads a Peer link started in the Environment it signed in to, and the work derived from them; each carries the link's
`linkOrigin` (its client session, label and access).
_Avoid_: remote threads, foreign work

**Link fence**:
What Linked work from a link paired below full access may not do: change the owner's threads, projects, settings or
schedules, or use that Environment's own links (t3's), or exceed the modes the link hands down (t3's). Pushes and MCP
tools follow the linked thread's own mode (owner, 2026-11-12, back to stock: no push gateway, no per-push card).
_Avoid_: sandbox, isolation

**Remote task**:
A delegated task whose child thread runs in another Environment over a Peer link; the parent's Environment follows it
and completes the task with the child's last reply.
_Avoid_: remote subagent, cloud task

**T3 Connect**:
The hosted relay at `t3.codes` that T3's mobile apps register with; it pushes an Environment's published thread
phases to the owner's phone (ADR-0025), and gives an Environment that asks for one a public address.
_Avoid_: the cloud, the relay service, push service

**Publish-only link**:
The Cloud Environment's link to T3 Connect: a `manual` link scoped to agent-activity notifications, made once from
an admin route, with which the Environment publishes and T3 Connect can never call back.
_Avoid_: Connect link, tunnel link, Peer link (that is between two Environments)

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

**Process channel**:
How a CLI agent's process, spawned by t3 in the Environment, runs in its Workspace's Container: the Workspace DO starts it under the platform's exec, the Environment writes its stdin and reads its output with a long poll.
_Avoid_: process bridge, remote spawn

**CLI profile**:
What a CLI agent's process gets whatever t3 asked: the image's binary, an allowlisted environment, the model proxy as its only provider, and a home built fresh on the Container's disk with only its session directory synced.
_Avoid_: CLI config

**Key helper**:
The command a CLI agent runs for its model proxy key (`t3flare-model-key`), which asks the Workspace DO only while a CLI process lives there; the key is never in an environment or on disk.
_Avoid_: token helper (Codex's managed mode), credential helper (that is git's)

**ACP flavor**:
What t3flare passes to t3's generic ACP adapter (`makeAcpAdapterV2`) to run Claude Code or OpenCode under t3's kinds: the agent's spawn through the process channel, the pinned asking mode, t3flare's answer to each permission request, the approval card, the model ids and the proxy's failures (`provider/cli/acpDriver.ts`, `acpFlavor.ts`).
_Avoid_: ACP driver, registry agent (t3's ACP Registry driver is another thing, refused)

**Managed settings**:
Claude Code's highest settings source, `/etc/claude-code/managed-settings.json`, written per process by the image's launcher: the proxy as the only endpoint, the key helper, and the permission, hook, MCP and plugin locks a repository's `.claude/` cannot override. OpenCode's counterpart is its **system configuration**, `/etc/opencode/opencode.json`.

## Tools

**Harness panel**:
The owner's page for Pi Durable's harness, at `/_t3flare/harness` on the t3 host: extensions and their settings, the MCP server set,
Status and the audit log. Changes apply at a thread's next turn.
_Avoid_: settings page, dashboard, admin UI

**Code mode**:
The Durable agent's `codemode` tool: one short script that calls the agent's tools as functions, each nested call
judged exactly as a direct one.
_Avoid_: scripting, eval

**MCP server**:
A remote MCP endpoint whose tools t3flare's agents may call: Commissary's, or a Direct server.

**Direct server**:
An MCP server the owner adds in the Harness panel, with its own sign-in kept by t3flare, as opposed to one reached
through Commissary.
_Avoid_: custom server, Route B (the plan's word)

**MCP server set**:
Every MCP server the Environment offers, with each one's switches (enabled, Exposure) and the owner's Tool class
overrides.

**MCP host**:
The Environment DO's part that holds the MCP server set, its inventory and credentials, and makes every MCP call through
the MCP engine.
_Avoid_: MCP proxy, gateway

**MCP relay**:
The `computer.internal/t3flare/mcp/<server>` routes through which CLI agents call Commissary's and Direct servers'
tools, with a Tool handle. t3's own tools reach a CLI as stock t3 hands them, with t3's bearer.
_Avoid_: MCP proxy, bridge

**Exposure**:
How a Durable agent is offered an MCP tool: `direct` (in its tool list), `deferred` (found by a search), `codemode`
(from scripts only) or `hidden`.

**Tool class**:
Read or write: the tool's own `readOnlyHint` (true is read; anything else, write), unless the owner overrides it in
the Harness panel. A read runs; a write follows the thread's mode, Linked work included.
_Avoid_: permission level

**Tool handle**:
An opaque per-process bearer a CLI agent sends to the MCP relay; useless outside its Workspace and after its process.
_Avoid_: token, nonce

**Server question**:
What an MCP server asks the owner during an agent's call: an elicitation (a form, or a page to open), or a Pause.
The MCP host makes it a t3 card on the calling thread; only the owner answers it, in a t3 client.
_Avoid_: prompt, approval request (a Server question may ask for input)

**Pause**:
A tool result in which a server stops a call until someone answers (Executor's `approval-required` or
`input-required`), to be continued with the server's `resume`. On a Pausing server t3flare raises the card and calls
`resume` itself; the agent never sees the request.
_Avoid_: pending interaction

**Pausing server**:
An MCP server that lists a `resume` taking a `requestId` and a `response` (Executor's "Through your agent" mode). Its
`resume` is t3flare's to call, never an agent's.

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
A GitHub installation token for one Workspace's one repo (code and pull requests write; `workflows` only when the Workspace is opted in), handed to git in its Container on the credential helper's request; never stored there. The agent's own git pushes with it (owner, 2026-11-12, back to stock).
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
