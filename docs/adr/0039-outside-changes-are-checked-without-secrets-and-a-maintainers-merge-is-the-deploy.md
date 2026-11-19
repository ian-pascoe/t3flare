# Outside changes are checked without secrets, and a Maintainer's merge is the deploy

Status: accepted (2026-11-19, the open-source release's design interview). Refines
[ADR-0037](0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md) §7
(ruleset `main`). The contributor's side: [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

The Canonical repository is public and takes pull requests from anyone. It is also the Maintainer's Deployment
repository: every push to its `main` deploys the Maintainer's `prod` (`deploy-prod.yml`, docs-only pushes aside). Before
`ci.yml`, no workflow ran on a pull request, so nobody could see whether a change passed before it merged.

1. **`ci.yml` checks every pull request, with nothing worth stealing.** It runs on `pull_request`, never
   `pull_request_target`, so a fork's code runs with no secrets and a read-only token; the workflow asks for
   `contents: read` alone and names no environment. Two jobs:
   - `check` runs `pnpm run check` on the PR's merge commit, with the submodule. It neither restores nor saves the pnpm
     store cache, which `deploy-prod.yml` restores with `prod`'s secrets in the job (ADR-0037 §4). It is a required
     status check of ruleset `main`.
   - `secrets` runs gitleaks, a checksum-verified binary, over the PR's commits, with the base branch's allowlists, so
     a PR cannot widen them for itself. It is not required yet.

   No path filters: a required check that never runs would block a docs-only PR forever.
2. **Outside contributors' runs wait for approval.** The repository requires a Maintainer's approval before a workflow
   runs for any outside contributor, not only a first-time one: GitHub's default stops asking after one merged change,
   however small.
3. **Merging is the deploy.** Ruleset `main` takes only squash-merged pull requests, with no approving review, and the
   required `check`. The stage gates (a deploy to the `bump` Stage and the acceptance test) need secrets, so they never
   run on an outside change before it merges; the first deploy of that change is `prod`'s. The Maintainer's review is
   therefore the gate, and an outside change merges only after a Maintainer has read it.
4. **The bypasses stay as ADR-0037 set them.** `land.yml`'s deploy key and repository admins skip the ruleset, the
   required check included; the two GitHub Apps skip it only when merging a pull request. A bump's pull request is
   opened with the workflow's own token, which starts no `pull_request` run, so `check` never reports on it; it merges
   through a bypass or lands through `land.yml`, and its proof is the Full gate, which runs `check` and more.
5. **Actions settings.** Only GitHub's own actions and `voidzero-dev/setup-vp` may run, and every action is pinned to a
   commit SHA (enforced). The default workflow token is read-only.

## Considered Options

- **`pull_request_target`, to run the stage gates with secrets.** It runs with a write token and the base repository's
  secrets; checking out a fork's code under it hands that code the Cloudflare token and the GitHub App's key.
- **Issues only, pull requests by invitation.** Safest where a merge deploys, but it tells outsiders the code is not
  really open, and a PR check without secrets already contains the risk.
- **A required approving review.** It would block the Maintainer's own pull requests, and in a one-Maintainer repository
  it adds a click, not a check.
- **Approval for first-time contributors only** (GitHub's default). One merged typo would let a contributor's next
  workflow change run unasked.

## Consequences

- The review burden falls on the Maintainer alone. Outside pull requests may wait.
- A contributor who wants their change tried on a deployed Stage does so on a Deployment of their own; the Canonical
  repository's CI never deploys anything for a pull request.
- A change to a workflow file, or anything else outside `docs/` and Markdown, deploys `prod` when it merges.
