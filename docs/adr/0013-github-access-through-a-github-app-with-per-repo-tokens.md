# GitHub access through a GitHub App with per-repo tokens

A dedicated `t3flare` GitHub App mints one-hour installation tokens, each scoped to the Workspace's one repo with an explicit permission list (ported from cloudpid's ADR-0025, tightened). Git network operations run in the Container through a credential helper; t3's PR features call the GitHub GraphQL API from the Environment DO, with the minted token supplied where t3 reads `GH_TOKEN`. A token pasted into t3's settings still works, as stock t3.

## Considered Options

- **A fine-grained PAT as a Worker secret**: no code, but a year-long token an agent can read.
- **Sharing cloudpid's App**: the two systems should revoke separately.

## Refinement (step 2a)

How part 1 implements it, with evidence in `docs/steps/step-2a/` (`m4-pr.json`, `m5-agent-push.json`):

- **Three permission lists** (`packages/github-app/src/permissions.ts`): the App asks for everything any token may need; a **Container token** is the Workspace's one repo with `contents` and `pull_requests` write; `workflows: write` is added only for a Workspace the owner opted in (a registry flag, off by default; the push of `.github/workflows/…` was refused by GitHub without it and accepted with it). An **Environment token** (t3's PR features) has the App's read permissions plus `pull_requests: write`, for the repos of the Environment's Projects in one installation.
- **t3's PR features read the Environment token from `gh auth token`**, which the Environment's process router answers; t3 then calls GitHub's REST API itself. t3 needs no other `gh` command (R6 settled). Not `GH_TOKEN`, which t3 reads only from a static environment.
- **Git network operations in the Container use a credential helper** that holds no token: for t3's own push, fetch and pull the router passes the Workspace's Container token in that one command's environment; for the agent's own `git push`/`fetch` from its shell, the helper asks the Workspace DO at that moment (through computer's egress host), which asks the Environment DO, the only minter. Nothing is written to disk or kept in the agent's shell, and the agent gets the same scoping as t3 (one repo; `workflows` only when opted in): its push to another installed repo failed with "Repository not found".
- **The Environment's GitHub client is the only minter**; the private key is a secret of the environment Worker alone.

## Refinement (step 3: pushes from linked work, owner decision D1)

Work started over a Peer link may `git push` the project's repo, but **every push needs its own approval**, which "accept for the session" never covers, in any mode. The gate is where the token is handed out, since a remote task runs in the project's shared checkout and the Container token is per Workspace: a Session whose thread carries a `linkOrigin` notes, before each of its commands, that linked work is active in its Workspace (for 30 minutes). While it is, the credential helper says what git is doing (its git ancestor: push, fetch or unknown). A fetch gets a **read-only token** (`contents: read`), so claiming "fetch" for a push only makes the push fail; anything else asks the owner on the linked thread (an approval titled "Allow git push?", showing the command) and gets the write token only if approved; with no live linked turn to ask, or no answer in 10 minutes, no token. Proved on the fixture (`docs/steps/step-3/m3-push.json`): the fetch asked nothing, a declined `git push origin HEAD:main` left the remote `main` unchanged, an approved one pushed once, the next asked again although the one before was accepted "for the session".

**Residual risk, accepted for step 3:** an approved push hands git a write token that a hostile agent could capture (by wrapping the helper) and reuse until it expires (at most an hour). The fix is filed as a high-priority ticket, "Link-started pushes: keep the write token out of the Container": the Workspace DO's egress adds the auth header per approved push, so the token never enters the Container. Also residual: a detached process a linked thread started more than 30 minutes before its push is not counted as linked work.

## Refinement (SPI-1004): GitHub is the App's identity, and GitHub only (owner decision D2)

t3's GitHub features act as the **App**, not as the owner. They call GitHub with an installation token, so GitHub attributes what they do (a pull request opened, a comment, a review) to the App's bot account, and pushes use App tokens.

Some features need an owner's user token, and they are missing by this decision, not by a bug:
- "my PRs" filters
- starred repositories
- publishing a new repository

A token pasted into t3's settings still works as in stock t3, at the owner's choice. There is no owner token held by t3flare.

Other hosts (GitLab, Bitbucket, Azure DevOps, Forgejo) are out of scope for now: cloning works for public repos only, and t3's discovery reports their CLIs "not found". A later decision may add an owner token or a host, each with its own ADR.

## Refinement (SPI-992, SPI-1040): no write token in any Container; pushes go through the push gateway

Supersedes step 3's residual risk and the write half of step 2a's Container token. Evidence in `docs/steps/spi-992/`; the report is `docs/steps/spi-992.md`.

- **The Container token is read-only code** (`contents: read`, `pull_requests: write`, `metadata: read`): it clones and fetches, and lets an agent's `gh pr create`/`view` work, since a pull request carries no code. The credential helper (protocol `v=2`) answers only `https://github.com`, so it never hands a token to a `pushurl` on another host (a finding of the plan: the old helper did).
- **Every push to github.com goes through the push gateway**: the image's system gitconfig rewrites it (`pushInsteadOf` to `http://computer.internal/t3flare/git/`), and the agents Worker's outbound handler forwards it to GitHub with a **gateway token** (`contents: write`, plus `workflows: write` for an opted-in Workspace) that never enters a Container or a Session. Before forwarding, the gateway parses the receive-pack command list strictly, re-serialises it from what it parsed (no parser differential), and asks the Workspace DO's policy (`pushDecision`) about the exact ref updates:
  - **allow** when every update matches an **expectation** (t3's own push: the process router registers the updates of t3's push argv before the command and removes them after, review M2), or when the Workspace has no **taint**;
  - **ask** while the Workspace is tainted: on the linked thread whose work it is (its card says which link), else on the one owner thread pushing (a Durable Session with a command running, or one owner CLI process in a turn); the card carries its own buttons: an owner's card offers "Allow this push once" and, under t3's "more" menu with a warning, "Allow and trust this Workspace again (clears the linked-work mark)", the only answer that clears the taint (never t3's default "Always allow this session" wording); a linked card offers only "Allow this push" and "Decline", and never trusts;
  - **refuse** otherwise, with a named message (`t3flare: this Workspace ran linked work …`).
- **Taint** outlives the 30-minute linked-work window, Container stops and DO restarts (review H1): a planted `core.fsmonitor`, hook or detached loop that later runs as the owner still meets the ask. The owner clears it with the admin `workspace-trust` route or an owner card.
- **CLI threads are asked too (SPI-1040)**: the Environment DO's `approvePush` reaches the thread's CLI wrapper, which raises t3's "Allow git push?" card on its live turn and answers it itself (U37). Without a live turn the push is refused.
- **Who may call the policy.** `authorizePush` is called only by the gateway (`WorkspaceProxy`, in the agents Worker, on the Container's egress); `expectPush`/`unexpectPush` only by the Environment's process router (Environment DO → Workspace DO RPC). Neither is reachable from a Container (its egress reaches the DO only through `WorkspaceProxy`'s paths) or from a Session.
- **A card shows GitHub's truth** (the tips GitHub advertised, the exact refs and ids) beside what the Workspace reports (commit subjects, fast-forward), labelled as the Workspace's claim (review M6). A card whose git went away is withdrawn (review M7).

Accepted costs and residual risks:
- **100 MiB per push.** Cloudflare caps a request body through an outbound handler at 100 MiB (P3: 90 MiB landed, 110 MiB got 413). A bigger push fails; split it. A ticket asks Cloudflare to raise the cap.
- **Git LFS** uploads go to GitHub's LFS API, not receive-pack; with a read-only token they fail. Ticketed.
- **GitHub Actions.** An approved push can still change `.github/workflows` in an opted-in Workspace, and any pushed branch runs the repo's existing workflows with their secrets: approving a push is approving what CI will run. Recommended for the owner's repos: default workflow permissions read-only (`GITHUB_TOKEN`), and branch protection on the default branch.
- **What the gateway cannot see.** It sees refs and object ids, not intent. Expectations are bound to `{ref, new}` for 30 minutes, so a hostile process that makes the same update t3 is about to push races t3 and wins nothing it was not getting. The helper's host check keeps git from sending a token to a foreign `pushurl`, but it does not stop a hostile process, which can ask the helper's endpoint itself: what closes that is that every token the endpoint issues is read-only.
