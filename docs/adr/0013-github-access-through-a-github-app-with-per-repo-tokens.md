# GitHub access through a GitHub App with per-repo tokens

A dedicated `t3flare` GitHub App mints one-hour installation tokens, each scoped to the Workspace's one repo with an explicit permission list (ported from cloudpid's ADR-0025, tightened). Git network operations run in the Container through a credential helper; t3's PR features call the GitHub GraphQL API from the Environment DO, with the minted token supplied where t3 reads `GH_TOKEN`. A token pasted into t3's settings still works, as stock t3.

## Considered Options

- **A fine-grained PAT as a Worker secret**: no code, but a year-long token an agent can read.
- **Sharing cloudpid's App**: the two systems should revoke separately.

## Refinement (step 2a)

How part 1 implements it, with evidence in `docs/steps/step-2a/` (`m4-pr.json`, `m5-agent-push.json`):

- **Three permission lists** (`packages/github-app/src/permissions.ts`): the App asks for everything any token may need; a **Container token** is the Workspace's one repo with `contents` and `pull_requests` write; `workflows: write` is added only for a Workspace the owner opted in (a registry flag, off by default; the push of `.github/workflows/…` was refused by GitHub without it and accepted with it). An **Environment token** (t3's PR features) has the App's read permissions plus `pull_requests: write`, for the repos of the Environment's Projects in one installation.
- **t3's PR features read the Environment token from `gh auth token`**, which the Environment's process router answers; t3 then calls GitHub's REST API itself. t3 needs no other `gh` command (R6 settled). Not `GH_TOKEN`, which t3 reads only from a static environment.
- **Git network operations in the Container use a credential helper** that holds no token: for t3's own push, fetch and pull the router passes the Workspace's Container token in that one command's environment; for the agent's own `git push`/`fetch` from its shell, the helper asks the Workspace DO at that moment (through computer's egress host), which asks the Environment DO, the only minter (ADR-0018). Nothing is written to disk or kept in the agent's shell, and the agent gets the same scoping as t3 (one repo; `workflows` only when opted in): its push to another installed repo failed with "Repository not found".
- **The Environment's GitHub client is the only minter**; the private key is a secret of the environment Worker alone.
