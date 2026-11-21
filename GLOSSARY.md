# t3flare

t3flare runs a t3code Environment on Cloudflare, so the stock t3 clients can orchestrate self-hosted cloud agents alongside the Owner's laptop.

## Deployments

**Owner**:
The one person who deploys and uses a Deployment, in a Cloudflare account they own: they pair its clients, answer its
Approvals and change its settings. A person may own several Deployments.
_Avoid_: user, admin, operator, deployer, maintainer

**Deployment**:
One Owner's t3flare in one Cloudflare account: its Stages and its Deployment settings ([docs/deploy.md](docs/deploy.md)).
_Avoid_: instance, install, tenant

**Deployment settings**:
The values that differ from one Deployment to the next, such as its Owner's email and its domain, set outside the
source tree.
_Avoid_: config, owner constants

**Stage**:
One named copy of t3flare's Workers within a Deployment, running exactly one Cloud Environment: `prod` (the one the
Owner works in), `bump` (CI's proving stage), or a throwaway one.
_Avoid_: environment (that is t3's), instance, deployment

**Maintainer**:
A person with write access to the Canonical repository, who decides what lands on its `main`.
_Avoid_: owner, author

**Canonical repository**:
The public repository t3flare is developed in, `spiritledsoftware/t3flare`, which every other copy follows.
_Avoid_: upstream (informally t3code), source (that is a Skill source), origin, the repo

**Deployment repository**:
The GitHub repository whose CI deploys one Deployment: its `main` is what `prod` runs, and its workflows are what an
Update dispatches. For the Maintainer's Deployment it is the Canonical repository; for another Owner's, their fork or
clone. A Deployment deployed only from a laptop has none.
_Avoid_: the repo, update target (the setting that names it)

**Update target**:
The Deployment repository `prod`'s in-app Updates dispatch CI on (`T3FLARE_UPDATE_REPO`); only `prod` takes one. A Stage
without one updates only by being deployed again.
_Avoid_: update repo, release channel

## Environments

**Environment**:
One t3 server and everything it owns: projects, threads, providers, files and state. Used in t3's sense.
_Avoid_: server, host, instance

**Cloud Environment**:
The Environment a Stage runs on Cloudflare.
_Avoid_: remote, cloud server

**Laptop Environment**:
The Owner's stock t3 Environment on their own machine.
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
on stock t3: by the Owner or at an agent's asking, at the access the Owner picks.
_Avoid_: reverse link, cloud-to-laptop link, laptop tunnel

**Route**:
One https address at which an Environment can be reached, and the kind of tunnel behind it (T3 Connect, Tailscale
Funnel, or the Owner's own Cloudflare Tunnel). Used in t3's sense.
_Avoid_: transport, endpoint, tunnel (for the address)

**Linked work**:
Threads a Peer link started in the Environment it signed in to, and the work derived from them; each carries the link's
`linkOrigin` (its client session, label and access).
_Avoid_: remote threads, foreign work

**Link fence**:
What Linked work from a link paired below full access may not do: change the Owner's threads, projects, settings or
schedules, or use that Environment's own links (t3's), or exceed the modes the link hands down (t3's). Pushes and MCP
tools follow the linked thread's own mode.
_Avoid_: sandbox, isolation

**Remote task**:
A delegated task whose child thread runs in another Environment over a Peer link; the parent's Environment follows it
and completes the task with the child's last reply.
_Avoid_: remote subagent, cloud task

**T3 Connect**:
The hosted relay at `t3.codes` that T3's mobile apps register with; it pushes an Environment's published thread
phases to the Owner's phone (ADR-0025), and gives an Environment that asks for one a public address.
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

**Preview browser**:
The Browser Run browser t3's server browser drives for one Workspace's tabs, its `localhost` routed to that Workspace's Container (ADR-0031). HTML renders use a route-less one.
_Avoid_: headless Chrome (stock's, on its host), remote browser

**Container preview**:
A preview browser's request to `http://<port>.t3flare.internal/`, answered from that port of the Workspace's Container, which it never starts (ADR-0031).
_Avoid_: port proxy, tunnel, preview URL (t3's configured URL)

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
A Durable agent's tool call waiting for the Owner's Approve or Decline, kept in the Session's storage so it survives the Session restarting. The runtime mode decides which calls ask.
_Avoid_: permission prompt, confirm

**Write journal**:
The paths written in a Workspace since a given revision of its files, read from computer's change log; what a stale git read is patched with.
_Avoid_: change feed, dirty list

**Stale read**:
A passive git read answered while the Container is stopped: its last real answer, patched with the Write journal where its shape allows, or, for one file's review diff with no last answer, an answer computed from the Workspace's own git facts. A passive read never starts the Container.
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
A removed Workspace whose files are kept for the Grace (uncommitted work, or a removal step that could not run): gone for t3, restorable.
_Avoid_: trash, soft delete

**Sweep**:
The Environment's pass over the Workspace registry, daily and after a project or thread is deleted, that purges what nothing references past the Grace, and stops Containers no Workspace holds.
_Avoid_: garbage collection, cleanup job

**Purge**:
The destruction for good of a Workspace: its files, its Container and its deleted threads' Sessions. The Sweep purges past the Grace; the Owner purges at once, on the Settings page or by answering an agent's asking. Nothing but the admin route starts a Purge of a Workspace something references.
_Avoid_: delete (t3's, of a project or thread, which removes no files), remove (t3's worktree removal, which may leave a Tombstone), wipe

**Grace**:
How many days the Environment keeps a Workspace nothing references, a Tombstone, and a deleted thread's Session before the Sweep purges them, or that it never does; an Environment setting, 7 days unless the Owner changes it.
_Avoid_: retention, trash period, TTL

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
What a CLI agent's process gets whatever t3 asked: the image's binary, an allowlisted environment, the Model endpoints whose API it speaks as its only providers (through the Model relay, with its Handle), and a home built fresh on the Container's disk with only its session directory synced. Without such an endpoint it is refused.
_Avoid_: CLI config

**ACP flavor**:
What t3flare passes to t3's generic ACP adapter (`makeAcpAdapterV2`) to run Claude Code or OpenCode under t3's kinds: the agent's spawn through the process channel, the pinned asking mode, t3flare's answer to each permission request, the approval card, the model ids and a failed prompt's failure (`provider/cli/acpDriver.ts`, `acpFlavor.ts`).
_Avoid_: ACP driver, registry agent (t3's ACP Registry driver is another thing, refused)

**Managed settings**:
Claude Code's highest settings source, shared by every Claude process in a Container: where its requests go and how it gets its key, and the permissions a repository's `.claude/` cannot override. Its requests go to the Model relay's Model-routed URL with the process's Handle as its key. OpenCode's counterpart is its **system configuration**, `/etc/opencode/opencode.json`: where its requests go, the Model relay's per-endpoint URLs.

## Tools

**Settings page**:
The Owner's page at `/_t3flare/settings` on the t3 host for t3flare's own settings: the Harness settings and the
Environment settings, with the Workspaces and their Purges, Status, the audit log and the Open changes waiting for the Owner. It was the Harness panel, at
`/_t3flare/harness`, until 2026-11-20; that path redirects here.
_Avoid_: Harness panel, dashboard, admin UI

**Harness settings**:
What agents are offered and how Pi Durable's loop runs: each tool's Exposure, its extensions with their options, and the
MCP server set.
_Avoid_: harness config, settings (alone)

**Environment settings**:
What the Cloud Environment gives every Workspace and its Container, and how long it keeps one: the Container size, idle
time and budget, the Global mise config, the Environment skills, the Variables and the Grace. t3flare's own, not t3's
server settings.
_Avoid_: environment config, server settings, Container settings

**Variable**:
A plain `NAME=value` every command in a Workspace starts with, kept in the Environment settings. Agents can read it; it
is never a credential.
_Avoid_: env var, environment variable (it reads as the Environment's own), secret

**Global mise config**:
The Owner's mise configuration that every Container's commands get, under a repository's own.
_Avoid_: Toolchains (cloudpid's word), global tools

**Container size**:
The vCPU, memory and disk a Workspace's Container starts with, picked by name.
_Avoid_: instance type, plan

**Container budget**:
How many Containers may run at once across the Cloud Environment.
_Avoid_: max instances, slots

**Code mode**:
The Durable agent's `codemode` tool: one short script that calls the agent's tools as functions, each nested call
judged exactly as a direct one.
_Avoid_: scripting, eval

**MCP server**:
An MCP endpoint whose tools t3flare's agents may call: a Direct server, or the Settings server.

**Direct server**:
A remote MCP server added to the MCP server set by the Owner on the Settings page, or at an agent's asking, with its
own sign-in kept by t3flare.
_Avoid_: custom server, Route B (the plan's word)

**MCP server set**:
Every MCP server the Environment offers, with each one's switches (enabled, Exposure) and the Owner's Tool class
overrides.

**MCP host**:
The Environment DO's part that holds the MCP server set, its inventory and credentials, and makes every MCP call through
the MCP engine.
_Avoid_: MCP proxy, gateway

**MCP relay**:
The `computer.internal/t3flare/mcp/<server>` routes through which CLI agents call Direct servers' tools, with a
Tool handle. t3's own tools reach a CLI as stock t3 hands them, with t3's bearer.
_Avoid_: MCP proxy, bridge

**Exposure**:
How a Durable agent is offered a tool: `direct` (in its tool list), `deferred` (found by a search), `codemode`
(from scripts only) or `hidden`. Every tool has one: an MCP server's tools, t3's own, and the built-in tools, whose
extension runs while any of its tools is not `hidden` (ADR-0042). A preset sets every tool that is not hidden and is not a switch (`codemode`, `tool_search`) at once, t3's and MCP servers' included (an MCP server's code-mode-only tools excepted).

**Tool class**:
Read or write: the tool's own `readOnlyHint` (true is read; anything else, write), unless the Owner overrides it in
the Settings page. A read runs; a write follows the thread's mode, Linked work included.
_Avoid_: permission level

**Tool handle**:
An opaque per-process bearer a CLI agent sends to the MCP relay; useless outside its Workspace and after its process.
_Avoid_: token, nonce

**Server question**:
What an MCP server asks the Owner during an agent's call: an elicitation (a form, or a page to open), or a Pause.
The MCP host makes it a t3 card on the calling thread; only the Owner answers it, in a t3 client.
_Avoid_: prompt, approval request (a Server question may ask for input)

**Pause**:
A tool result in which a server stops a call until someone answers (Executor's `approval-required` or
`input-required`), to be continued with the server's `resume`. When t3flare's agents call a Pausing server, t3flare
raises the card and calls `resume` itself; the agent never sees the request.
_Avoid_: pending interaction

**Pausing server**:
An MCP server that lists a `resume` taking a `requestId` and a `response` (Executor's "Through your agent" mode). When
t3flare's agents reach one, its `resume` is t3flare's to call, never theirs. The Settings server is one only to an Owner
client in the `model` Elicitation mode.

**Settings server**:
t3flare's own MCP server for the Harness settings, the Environment settings and the Environment skills, and for asking
to purge a Workspace. t3flare's agents reach it as a member of the MCP server set; Owner clients reach it at its own
endpoint.
_Avoid_: admin MCP, builtin MCP, config server, Harness server

**Door**:
One of the Settings server's two ways in, over one implementation: the own agents' door (t3flare's own agents, in-process
through the MCP host, Owner-only cards) and the Owner-client door (Owner clients, at its endpoint behind Access). A
change records the door it came through.
_Avoid_: entrypoint, channel (a Process channel is another thing), transport

**Owner client**:
An MCP client outside t3flare, such as Claude Code or Cursor on the Owner's own machine, that the Owner signed in to the
Settings server through Access. Its Elicitation mode is the Owner's setting for it on the Settings page, by its own
name, which is a label, never proof of which client calls.
_Avoid_: external agent, laptop client (the Laptop Environment is t3's), remote client

**Settings change**:
One validated change to the Harness settings, the Environment settings or the Environment skills, made on the Harness
panel or through the Settings server. Linked work makes none.
_Avoid_: Proposal, edit, mutation

**Change tier**:
Whether a Settings change through the Settings server waits for an answer: `free` (one that narrows) or `asked` (one
that widens, spends, adds text or code agents will meet, destroys something, turns off a Guard, or touches the Settings
server's own entry). In full access a free change runs unasked; an asked change always asks.
_Avoid_: risk level, permission level, direct (that is an Exposure), confirmation tier

**Open change**:
An asked Settings change, or a Purge asked through the Settings server, waiting for its answer, kept for at most 10
minutes and answered once.
_Avoid_: Proposal (cloudpid's, a queue), pending request (t3's), draft

**Change page**:
A page under the Settings page for one Open change, where the Owner reads it and answers. It is the only place a secret is
typed or a Direct server's sign-in is started for a change an agent asked.
_Avoid_: confirm page, approval page

**Elicitation mode**:
How an Owner client's asked change is answered: `browser` (the Owner, on the Change page), `native` (a form in the
client) or `model` (the client's agent, by calling `resume`). Executor's names and meanings. Set per Owner client on the
Settings page (`browser` until the Owner changes it); `?elicitation_mode=` on the URL overrides it, for clients that keep
a query. t3flare's own agents have none: theirs is always a Server question.
_Avoid_: approval mode, form mode, URL mode (an elicitation is a form or a page)

**Guardian**:
Pi Durable's `guardian` extension: a reviewer model that judges risky tool calls before they run, beside the thread's
Approvals and never instead of them.
_Avoid_: reviewer (the Advisor is one too), guard (that is the wider term)

**Guard**:
A Pi Durable extension that judges agents' calls: the Guardian, and `permissions`, which nothing can turn off. Turning
a Guard off, or changing its settings, is an asked change.
_Avoid_: safety extension, policy

## Skills

**Skill**:
A directory with a `SKILL.md` (name, description, instructions) and supporting files, which an agent reads when a task matches its description or the Owner names it.
_Avoid_: plugin, command, extension

**Repo skill**:
A Skill kept in a repository's own files; each Workspace has those of its checkout. It is instructions only and grants no permission.
_Avoid_: project skill, workspace skill

**Skill root**:
A directory in which an agent looks for Skills, such as a repository's `.agents/skills`. Each CLI agent has its own, and a Repo skill outside them is not that agent's.
_Avoid_: skills folder, skill path

**Environment skill**:
A Skill installed into the Cloud Environment by the Owner, or at an agent's asking, offered to every agent in every Project: Durable agents and CLI agents alike.
_Avoid_: global skill (cloudpid's Global), owner skill, personal skill

**Skill source**:
Where an Environment skill was installed from: a GitHub repository, the Skill's folder, the ref named and the commit it is pinned to.
_Avoid_: upstream, origin

**Skill mention**:
A `$name` in the Owner's message that names a Skill; t3's composer writes one when a Skill is picked.
_Avoid_: skill chip, invocation

**Slash command**:
A `/name` starting a message that runs an action or starts the message from a Prompt template. Used in t3's sense.
_Avoid_: command (alone)

**Prompt template**:
A Markdown file in a repository whose Slash command expands into a message with its arguments filled in. Used in pi's sense.
_Avoid_: prompt, snippet, MCP prompt

## Credentials

**Provider instance**:
One configured way to reach an agent or model provider, with its own credentials. Used in t3's sense.

**Model endpoint**:
One of the Owner's own ways to reach models: where to send requests, with an API key, a sign-in or none, and the models it serves. Every model call t3flare makes goes to one. Set up on the Settings page.
_Avoid_: provider (that is t3's or pi-ai's), connection, backend

**Model relay**:
How a CLI agent reaches a Model endpoint without holding its credential: the agent presents a Handle, and the endpoint's own credential is used in its place.
_Avoid_: model proxy, gateway, intercept

**Model-routed URL**:
The Model relay's one base URL for every Model endpoint a process may use: the endpoint is chosen per request, from the model the request names. For a CLI agent that takes one base URL per process.
_Avoid_: router, catch-all endpoint, wildcard endpoint

**Usage record**:
t3flare's own count of one model answer's tokens on a Model endpoint, with its agent, endpoint, model, time and cost when known, made by a Session, text generation or the Model relay for t3's Usage page; never a key, a Handle, a prompt or an answer's text. On the page, Pi Durable's turns, text generation and Pi's all count in one Pi row, told apart by their source.
_Avoid_: usage log, telemetry, request log

**Limit reading**:
The usage windows one Model endpoint answer reported in its vendor's rate-limit headers (ChatGPT's primary and secondary, Claude's five-hour and weekly): for each, the share used and when it resets, with when the answer came. Never a token or an account.
_Avoid_: quota report, usage record (that counts tokens)

**Subscription**:
An Owner's own paid plan with a model vendor (ChatGPT, Claude Pro or Max, GitHub Copilot), signed in to as a Model endpoint on the Settings page, as opposed to an API key. It belongs to one Owner and one Deployment and is never shared.
_Avoid_: Subscription login, OAuth, account

**Credential broker**:
The Environment DO in its role as the one holder and refresher of every Subscription's tokens. A Session asks it for an access token when it needs one, and the Model relay at every request it carries for a CLI agent.
_Avoid_: token service, auth server

**Container token**:
A GitHub installation token for one Workspace's one repo (code and pull requests write; `workflows` only when the Workspace is opted in), handed to git in its Container on the credential helper's request; never stored there. The agent's own git pushes with it.
_Avoid_: repo token, deploy key (the repo's one deploy key is `land.yml`'s, ADR-0037 §7)

**Environment token**:
The GitHub installation token t3's own PR features use, answered to `gh auth token`; it never reaches a Container or a Session.
_Avoid_: gh token, PAT

**Handle**:
An opaque stand-in for a Model endpoint's credential (the model handle), given to one CLI agent process and good only at the Model relay, for that process's endpoints, while the process lives.
_Avoid_: placeholder, fake token, Tool handle (that one is for the MCP relay)

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

**t3 track**:
Which of t3's releases a Deployment follows, `stable` or `nightly`: a Deployment setting.
_Avoid_: release channel, channel, update track (t3's client setting)

**t3 pin**:
The t3 release tag the `t3code` submodule is at, named by its tag on the Deployment's t3 track.
_Avoid_: t3 version, upstream version

**Server version**:
The t3 pin without its `v`: the version the Cloud Environment and its web client report to the stock clients.
_Avoid_: app version, t3 version

**t3 bump**:
Moving the t3 pin forward to a newer tag on the t3 track and proving it on the `bump` stage.
_Avoid_: upgrade, sync

**Upstream fingerprint**:
The hashes of the t3 code our files restate or emulate, the literals t3 must still contain, and the watched files' blob ids, each recorded at the t3 commit last reviewed. A change holds a t3 bump for a person to review our named files: it does not land by itself.
_Avoid_: snapshot, upstream hash

**CLI pin**:
A CLI agent's version in the Workspace image.
_Avoid_: CLI version

**CLI bump**:
The job that moves one CLI pin to its newest version, proves it and lands it.
_Avoid_: CLI upgrade

**Proposed pin**:
A pin that passed a gate but is not on `main`, recorded with the gate it passed.
_Avoid_: candidate, pending bump

**Update gate**:
The short proof an Update waits on: the checks, a deploy to the `bump` Stage, and the core acceptance test with one agent turn (for a CLI bump, that CLI's turn).
_Avoid_: fast gate, smoke

**Full gate**:
The scheduled t3 bump's whole proof, every CLI agent's turn included; a landed Update gets it afterwards.
_Avoid_: full test, slow gate

**Land**:
Fast-forward the Deployment repository's `main` to a proposed pin, then deploy `prod`.
_Avoid_: merge, release

**Update**:
A bump and land an Owner requests from a stock client's Update button, in their Deployment repository, of either kind:
the server's (a t3 bump) or a CLI's (a CLI bump).
_Avoid_: self-update, upgrade

**Workspace image**:
The Container image every Workspace runs: git, the CLI agents at their CLI pins, and the tools.
_Avoid_: sandbox image
