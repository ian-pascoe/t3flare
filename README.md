# t3flare

A t3code Environment on Cloudflare. The stock t3 clients (web, desktop, mobile) attach to it like any other Environment, and the owner's laptop delegates to it over a Peer link. Its agents run on pi-durable in Durable Objects (shown in t3 as "Pi Durable"), or as CLIs (Codex, Claude Code, OpenCode, and the pi CLI, shown as "Pi") in Containers started only when needed. Every model call goes through a model proxy you run.

- [`docs/plan.md`](docs/plan.md): milestones and their exit criteria.
- [`docs/adr/`](docs/adr/): the decisions that are hard to reverse.
- [`docs/research/`](docs/research/): platform facts the decisions rest on.
- [`docs/upstream-fragility.md`](docs/upstream-fragility.md): where following t3code's nightly tags breaks t3flare, and how to triage a failed bump.
- [`GLOSSARY.md`](GLOSSARY.md): the terms.
- Issues: Linear (team SPI, project ian-pascoe/t3flare); GitHub Issues sync into it ([`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)).

## Status

Steps 0 (spike), 1 (platform), 2a (Durable agents, then on the since-removed Model proxy; usage limits and aborted commands), 2b (terminal, setup scripts, worktree Workspaces, deletion and sweep), 3 (Peer links), 3+ (a publish-only T3 Connect link), 4a (Codex and the pi CLI), 4b (Claude Code and OpenCode) and the tools step (code mode, MCP tools, the Harness panel) are done. What works today, against a deployed stage and the stock web and desktop clients: pair, create a project, clone a repo from GitHub, run a Durable agent turn that edits files and runs `bash`, approve a tool call, see the diff, push and open a PR, and an Environment restart mid-turn that continues ([step 2a report](docs/steps/step-2a.md)); open t3's terminal in a Workspace, start a thread in a new worktree that runs its project's setup script, and delete it to free its Workspace ([step 2b report](docs/steps/step-2b.md)); link the laptop's T3 Code to the cloud and have a laptop agent delegate a task to a cloud Durable agent, which can use t3's own tools, ask its question and push only with an approval each time ([step 3 report](docs/steps/step-3.md)); get a phone notification when a cloud run finishes or waits for you, through T3 Connect ([step 3+ report](docs/steps/step-3plus.md); prod needs its one-time sign-in); and run Codex and the pi CLI on the owner's Model endpoints in a Workspace's Container, each resuming its own conversation after the Container slept ([step 4a report](docs/steps/step-4a.md)); and run Claude Code and OpenCode the same way, over t3's ACP adapter, with an approval for each edit and command, a plan turn that edits nothing (Claude's shown as t3's proposed plan), and a hostile repository unable to redirect or loosen either ([step 4b report](docs/steps/step-4b.md)). The Durable agent has code mode and tool search; the Durable agent, Codex, Claude Code and OpenCode can use the MCP servers and Model endpoints the owner adds in the **Harness panel** (at `/_t3flare/harness` on the t3 host, behind Access), with write tools asking by the thread's mode; every CLI agent gets t3's own tools ([tools report](docs/steps/tools.md)). Built and unit-tested, with its stage runs still owed: the pi CLI's MCP servers through the relay, and the Settings server, through which agents and the owner's own MCP clients ask for changes to t3flare's settings ([Settings server report](docs/steps/settings-mcp.md)).

**No product analytics.** Stock t3 sends usage analytics to t3's PostHog (`ingest.t3.codes`) by default. The Cloud Environment never does: t3flare's built-in managed policy sets t3's `telemetry` limit to off, and t3 then drops every event, its own and the ones clients relay ([ADR-0023](docs/adr/0023-the-cloud-environment-tells-clients-only-what-it-does.md)). The same policy shows the settings of features the cloud doesn't do as "Managed by t3flare".

## Requirements

Deploying t3flare needs all three:

1. **Cloudflare**: a Workers **Paid** account with **Containers** (the Durable agents' Workspaces run commands in one), and Cloudflare Access (Zero Trust) for the admin routes ([ADR-0010](docs/adr/0010-the-endpoint-is-public-behind-t3s-own-auth.md)). The deploy builds the Container image with local Docker.
2. **A GitHub App** that gives each Workspace a token for its one repo ([ADR-0013](docs/adr/0013-github-access-through-a-github-app-with-per-repo-tokens.md)). `pnpm --filter @t3flare/infra run github-app:setup` registers it under your account and stores its id and key.
3. **A way to reach models.** Every model call goes to a **Model endpoint** you add in the Harness panel after the first deploy ([ADR-0034](docs/adr/0034-model-endpoints-are-the-owners-set-in-the-harness-panel.md)): any API pi-ai speaks (Anthropic Messages, OpenAI Responses, OpenAI-compatible Completions, Google, Mistral) with an API key, a ChatGPT, Claude or GitHub Copilot sign-in, or no auth. No deploy setting holds a model key. A fresh Environment starts in the setup state until you add one. **[`docs/model-endpoints.md`](docs/model-endpoints.md)** is the guide.

## Deploy your own

**[`docs/deploy.md`](docs/deploy.md)** is the guide: the Deployment settings every deploy needs (your Access team, your email, your account's workers.dev subdomain and the rest, with no defaults in the source; [`dev.env.example`](dev.env.example) lists them), the steps to deploy a test stage and `prod` from a laptop, CI that deploys `prod` on every push to `main`, and how to update a Deployment.

`pnpm run check` runs the typechecks, lint and tests ([ADR-0030](docs/adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md)).

## License

[MIT](LICENSE), Copyright (c) 2026 Spirit-Led Software LLC. Some files come from other projects under their own
licences; [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) lists them.
