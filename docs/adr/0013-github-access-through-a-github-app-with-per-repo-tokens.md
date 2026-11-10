# GitHub access through a GitHub App with per-repo tokens

A dedicated `t3flare` GitHub App mints one-hour installation tokens, each scoped to the Workspace's one repo with an explicit permission list (ported from cloudpid's ADR-0025, tightened). Git network operations run in the Container through a credential helper; t3's PR features call the GitHub GraphQL API from the Environment DO, with the minted token supplied where t3 reads `GH_TOKEN`. A token pasted into t3's settings still works, as stock t3.

## Considered Options

- **A fine-grained PAT as a Worker secret**: no code, but a year-long token an agent can read.
- **Sharing cloudpid's App**: the two systems should revoke separately.
