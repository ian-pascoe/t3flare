# Open-source release facts: CLI licences, terms, fork behaviour, the name, and subscription sign-ins

Research date: 2026-11-19. Four questions, for deciding how to release t3flare (the licence was not yet chosen when Part A was written; it is now MIT):

- **Part A.** What licence or terms govern each coding-agent CLI the image installs; whether a repo whose Dockerfile installs them at the deployer's build time, or a prebuilt image the project might publish, redistributes them; whether the terms restrict headless, automated or subscription use in a container on the deployer's own account.
- **Part B.** How GitHub Actions behaves for forks, `pull_request` and `pull_request_target`, approvals, environments, templates, and private vulnerability reporting.
- **Part C.** Whether T3 Tools Inc. restricts third-party names containing "t3" or the use of its marks.
- **Part D.** Whether the Copilot, OpenAI and Anthropic terms allow an Owner's own paid plan to be held by a server-side broker for their own harnesses.

Conventions:
- Every claim cites a primary URL: a licence file in the project's repo or npm tarball, the vendor's own legal or docs page, or docs.github.com. Quotes are verbatim.
- **(derived)** = my inference from cited statements, not stated verbatim in a source.
- **(interpretation)** = a reading of vendor terms that the vendor does not state. Treat it as a question for counsel or for the vendor.
- **UNCONFIRMED** = not verified in a primary source I could reach.
- Downloaded packages were inspected in `/tmp/oss-research/` (outside the repo). Nothing in the repo was changed except this file.

---

## What the Dockerfile installs (`apps/sandbox-image/image/Dockerfile`)

| CLI | How the Dockerfile installs it | Pinned version | Upstream repo, licence file |
|---|---|---|---|
| OpenAI Codex CLI | Release tarball from `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz`, checked by SHA-256 | `CODEX_VERSION=0.167.2` | `https://github.com/openai/codex`, Apache-2.0 |
| OpenCode | Release tarball from `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz`, checked by SHA-256 | `OPENCODE_VERSION=2.2.7` | `https://github.com/anomalyco/opencode`, MIT |
| pi CLI | `npm ci` from `cli/package.json`: `@earendil-works/pi-coding-agent` | `1.5.2` | `https://github.com/earendil-works/pi`, MIT |
| Claude Code (over ACP) | `npm ci` from `claude/package.json`: `@agentclientprotocol/claude-agent-acp`, which depends on `@anthropic-ai/claude-agent-sdk`; the Dockerfile tests that `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` exists | `0.106.0` (ACP) | `https://github.com/agentclientprotocol/claude-agent-acp`, Apache-2.0 (ACP); SDK and `claude` binary: proprietary, see A.1 |

Notes:
- The OpenCode release is from `anomalyco/opencode`, not `sst/opencode`. `https://github.com/sst/opencode` answers `HTTP/2 301` with `location: https://github.com/anomalyco/opencode` (checked 2026-11-19).
- The ACP package's own `package.json` declares `"@anthropic-ai/claude-agent-sdk": "0.3.322"` (npm: `https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.106.0`). The lock in `claude/package-lock.json` decides what is actually installed; I did not read it (UNCONFIRMED for the resolved SDK version). The npm `latest` SDK at fetch time was 0.3.328 (`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest`).
- Codex `latest` on npm was 0.170.0 (`https://registry.npmjs.org/@openai/codex/latest`). The Dockerfile pins 0.167.2 from GitHub Releases, not from npm.

---

## Part A. CLI licences and terms

### A.1 Licence that governs the CLI package

**Claude Code (`@anthropic-ai/claude-code`) and the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`): proprietary, not open source.**
- Package `LICENSE.md`, inside `@anthropic-ai/claude-code@2.1.328` (tarball `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.328.tgz`, file `package/LICENSE.md`):
  > "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."
- The npm `license` field is `"SEE LICENSE IN README.md"` (`https://www.npmjs.com/package/@anthropic-ai/claude-code`). The README has no licence section (checked `package/README.md` in the tarball). The licence text is in `LICENSE.md`, so the npm pointer is wrong.
- The same LICENSE.md text is in `@anthropic-ai/claude-agent-sdk@0.3.328` (`package/LICENSE.md`, tarball `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.328.tgz`). Its npm `license` field is `"SEE LICENSE IN README.md"`.
- The platform package that holds the `claude` binary, `@anthropic-ai/claude-agent-sdk-linux-x64`, has `"license": "SEE LICENSE IN LICENSE.md"` (`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/0.3.328`).
- **Version drift:** the GitHub repo's `LICENSE.md` on `main` reads differently: "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)." (`https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md`). The npm 2.1.328 file points to the legal page instead. Both say "All rights reserved".

The governing terms, per the vendor's legal page (`https://code.claude.com/docs/en/legal-and-compliance`, section "License"):
> "Your use of Claude Code is subject to: [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) - for Team, Enterprise, and Claude API users; [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) - for Free, Pro, Max, and Ultra users"

**Claude Code over ACP (`@agentclientprotocol/claude-agent-acp`, the adapter in the image): Apache-2.0.**
- `LICENSE` in `@agentclientprotocol/claude-agent-acp@0.106.0` (tarball `https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/-/claude-agent-acp-0.106.0.tgz`) is the Apache License, Version 2.0 text. npm `license`: `"Apache-2.0"` (`https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.106.0`).
- Its licence covers only the adapter. The SDK and the `claude` binary it depends on are under the proprietary terms above (derived from the dependency list).

**OpenAI Codex CLI (`@openai/codex`, and the Rust binary the Dockerfile fetches): Apache-2.0.**
- `LICENSE` at the pinned tag `rust-v0.167.2` (`https://raw.githubusercontent.com/openai/codex/rust-v0.167.2/LICENSE`) is "Apache License Version 2.0, January 2004".
- npm `license`: `"Apache-2.0"` (`https://registry.npmjs.org/@openai/codex/0.167.2`).
- OpenAI's Terms of Use say the same thing about OpenAI software: "Our software may include open source software that is governed by its own licenses that we've made available to you." (`https://openai.com/policies/terms-of-use/`, section "Software"). This covers the open-source CLI. It does not cover OpenAI's hosted Services.

**OpenCode (`anomalyco/opencode`): MIT.**
- `LICENSE` at tag `v2.2.7` (`https://raw.githubusercontent.com/anomalyco/opencode/v2.2.7/LICENSE`): "MIT License. Copyright (c) 2025 opencode."
- No separate CLI terms were found for OpenCode. Its provider docs cover model-provider sign-in (A.3).

**pi (`@earendil-works/pi-coding-agent`): MIT.**
- npm `package.json` field: `"license": "MIT"` (`https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.5.2`).
- `LICENSE` at tag `v1.5.2` (`https://raw.githubusercontent.com/earendil-works/pi/v1.5.2/LICENSE`): "MIT License. Copyright (c) 2025 Mario Zechner."
- **The npm tarball has no LICENSE file.** Its root holds `CHANGELOG.md`, `README.md`, `dist`, `docs`, `examples`, `schemas`, `package.json` (checked `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz`). An image that bundles pi should carry the MIT notice itself.
- `dist/bundle/cli.js` is a bundle. I did not check whether third-party dependency licences inside it need carrying (UNCONFIRMED).

### A.2 Does a Dockerfile that installs at build time redistribute the CLI? Does any term restrict a prebuilt image?

**The repo as the project would publish it contains no CLI binary or package tarball.** The Dockerfile downloads each CLI at the deployer's build time, and the lock files record package names, versions and integrity hashes. (derived from `apps/sandbox-image/image/Dockerfile`, `cli/package.json`, `claude/package.json`.) Under that model the project does not redistribute anything, and each deployer's build is a copy made for their own account.

**Apache-2.0 (Codex, ACP) and MIT (OpenCode, pi): a prebuilt image is a redistribution, and the licences attach conditions, not use restrictions.**
- Apache-2.0 §4 (`https://raw.githubusercontent.com/openai/codex/rust-v0.167.2/LICENSE`): "You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:" The conditions include:
  > "(a) You must give any other recipients of the Work or Derivative Works a copy of this License; and"
  > "(d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file…"
  §4(d) applies only when the work ships a NOTICE file; whether `openai/codex` or `agentclientprotocol/claude-agent-acp` ships one was not checked (UNCONFIRMED).
- MIT (OpenCode `v2.2.7` and pi `v1.5.2` LICENSE files): "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."
- Neither licence limits where or for whom the software runs.

**Claude Code: a prebuilt image the project publishes would redistribute proprietary software under the Anthropic terms, which have explicit conditions for "preinstalling or running" it.**
- `https://code.claude.com/docs/en/legal-and-compliance`, section "Can customers offer Claude Code in their products?":
  > "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our [Commercial Terms of Service] and complying with the conditions below:"
  > "The Claude Code binary must not be modified. Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key)."
  > "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential…"
- Trademark, same section:
  > "You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo…"
- The image's Claude launcher installs managed settings that the profile writes into `/etc/claude-code` (`apps/sandbox-image/image/t3flare-claude-agent-acp`, lines 1–8). I did not read the profile's settings, so I cannot say whether they restrict a sign-in method (open item, see Part A.3).
- **Reading (interpretation):** a prebuilt image that bakes in the `claude` binary is a "preinstalled" copy, so the project would need Commercial Terms for it. A deployer building the image for their own account is the "running" case the same paragraph covers when they serve others. The text does not say whether a self-build by one deployer for their own use needs Commercial Terms.

### A.3 Headless, automated, and subscription use in a container on the deployer's own account

**Claude Code / Claude subscriptions.**
- Consumer Terms, section "3. Use of our Services" (`https://www.anthropic.com/legal/consumer-terms`), a prohibition:
  > "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."
- The same section bars sharing: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." (section 2, `https://www.anthropic.com/legal/consumer-terms`).
- Legal page, OAuth scope (`https://code.claude.com/docs/en/legal-and-compliance`, "Authentication and credential use"):
  > "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  > "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." (section "Acceptable use")
  > "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens"
  > "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above."
- Usage Policy (`https://www.anthropic.com/legal/aup`, "Do Not Abuse Our Platform"; page shows "Effective Nov 12, 2026"):
  > "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used"
- Commercial Terms (`https://www.anthropic.com/legal/commercial-terms`, D.4 Use Restrictions): "access the Services to build a competing product or service, including to train competing AI models or resell the Services except as expressly approved by Anthropic".

**Reading (interpretation):**
- Headless Claude Code run by a deployer, for that deployer alone, on the deployer's own subscription: the legal page's OAuth scope and its "end user… with their own Claude subscription" sentence point towards allowed. The Consumer Terms' automation ban still applies unless the access is via an API key or "explicitly permit[ted]". No explicit permission for headless automation was found. Anthropic's own wording that the Agent SDK is used under subscription limits "assume ordinary, individual usage" is the closest thing to an explicit permission. The safe default for automated runs is an API key.
- Multi-tenant or hosted use of any subscription login (one shared token, or many users' tokens routed through the project's service): prohibited by the AUP and the legal page's intermediation rule.
- The project itself must not collect, store or route a user's Claude subscription credentials if it serves anyone other than that user.

**Codex / ChatGPT.**
- Codex auth page (`https://developers.openai.com/codex/auth`):
  > "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted or public environments."
  > "Access tokens are intended for trusted scripts, schedulers, and private CI runners. For general OpenAI API calls, continue to use Platform API keys." (section "Use Codex access tokens for enterprise automation", ChatGPT Enterprise only)
- Codex CI/CD auth page (`https://developers.openai.com/codex/auth/ci-cd-auth`):
  > "The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account."
  > "This is an advanced workflow for enterprise and other trusted private automation. API keys are still the recommended option for most CI/CD jobs."
  > "Do not use this workflow for public or open-source repositories."
- OpenAI Terms of Use (`https://openai.com/policies/terms-of-use/`, "Registration"): "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account."
- OpenAI Services Agreement, section 3.1 (`https://openai.com/policies/services-agreement/`). Its scope line: "This OpenAI Services Agreement only applies to use of OpenAI's APIs, ChatGPT Enterprise, ChatGPT Business, ChatGPT for Clinicians, and other services for customers who are businesses and developers, and does not apply to OpenAI services used by consumers or individuals unless specified above." Section 3.1: "Customer will not share Account access credentials or individual login credentials between multiple users. Customer may not resell or lease access to its Account or any End User Account."
- OpenAI Usage Policies (`https://openai.com/policies/usage-policies/`): the page shows "Effective: November 20, 2026", one day after this research date, with the prior version in force until then. I did not find a Codex-specific automation prohibition in it.

**Reading (interpretation):** OpenAI names API keys as the supported way to run Codex headless in CI, and limits ChatGPT-login reuse to trusted private automation, not public or open-source repos. A deployer running Codex in their own container on an API key is inside the stated guidance. A ChatGPT login copied into containers, or shared across users, is not.

**OpenCode.**
- Provider docs (`https://opencode.ai/docs/providers/`): "## ChatGPT — Use a ChatGPT Plus or Pro plan instead of an OpenAI API key. Connect **OpenAI**, then choose **Sign in with ChatGPT** or one of the legacy **Codex** sign-in methods."
- The same page has no Anthropic subscription sign-in. Its Anthropic mentions are only in the Vertex section. The page is the V2 docs (it says "The old `google-vertex-anthropic` provider ID is unavailable in V2").
- OpenCode's own licence (MIT) imposes no use restriction. The model providers' terms (above) govern what a subscription login may be used for.

**pi.**
- Providers doc (`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md`): the table row "Anthropic | `ANTHROPIC_API_KEY`". The page also says "Sign in through a browser or device flow backed by OAuth." and "On a remote or headless machine, an OAuth callback may not reach the local process."
- The page does not say whether `/login` offers a Claude subscription sign-in for Anthropic, and it links to no Anthropic subscription flow. (UNCONFIRMED: whether pi's `/login` can reach Claude Pro/Max OAuth. If it can, Anthropic's rules in this section apply to its use.)
- pi has no use restriction of its own (MIT).

**Open item for the Claude launcher.** The image's Claude launcher installs managed settings the profile writes (`apps/sandbox-image/image/t3flare-claude-agent-acp`). The legal page forbids removing or restricting "any authentication method built into" the binary. Check the profile's managed-settings content against that sentence (not read in this pass).

---

## Part B. GitHub Actions and repo behaviour for forks

### B.1 Scheduled workflows on forks

- Events page (`https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows`, `schedule`): "This event will only trigger a workflow run if the workflow file exists on the default branch." and "Scheduled workflows will only run on the default branch." and "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days."
- Disable/enable page (`https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows`): "When a public repository is forked, scheduled workflows are disabled by default."
- Events page, forked repositories: "Workflows don't run in forked repositories by default. You must enable GitHub Actions in the **Actions** tab of the forked repository."
- **How to enable (docs.github.com, same disable/enable page, "Enabling a workflow"):** "1. On GitHub, navigate to the main page of the repository. 2. Under your repository name, click **Actions**. 3. In the left sidebar, click the workflow you want to enable." Steps 4+ (the enable button) were not read in full.

### B.2 `pull_request` vs `pull_request_target` from a fork

**`pull_request` from a fork** (`https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows`, "Workflows in forked repositories"):
> "With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a forked repository."
> "The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories."
- Secrets page (`https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions`) says the same.
- Settings page (`https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository`), fork policy: "**Run workflows from fork pull requests** - Allows users to run workflows from fork pull requests, using a `GITHUB_TOKEN` with read-only permission, and with no access to secrets." "**Send write tokens to workflows from pull requests** - Allows pull requests from forks to use a `GITHUB_TOKEN` with write permission." "**Send secrets to workflows from pull requests** - Makes all secrets available to the pull request."
- Workflow syntax, `permissions` (`https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax`): "You can use the `permissions` key to add and remove read permissions for forked repositories, but typically you can't grant write access. The exception to this behavior is where an admin user has selected the **Send write tokens to workflows from pull requests** option in the GitHub Actions settings."
- **Environments:** an environment's secrets are "only available to workflow jobs that use the environment. Additionally, workflow jobs that use this environment can only access these secrets after any configured rules (for example, required reviewers) pass." (`https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments`). Since they are secrets, the fork-PR rule above covers them (derived). Environment-scoped secrets are not passed to a fork's `pull_request` run.
- **Default `GITHUB_TOKEN` permission** for a same-repo `pull_request`: the repo's "Workflow permissions" setting, either "read and write access for all permissions (the permissive setting), or just read access for the `contents` and `packages` permissions (the restricted setting)" (settings page above). The page does not say which one is the default for new repos (UNCONFIRMED).

**`pull_request_target`** (events page, `#pull_request_target`):
> "This event runs in the context of the default branch of the base repository, rather than in the context of the merge commit, as the `pull_request` event does. This prevents execution of unsafe code from the head of the pull request that could alter your repository or steal any secrets you use in your workflow. This event allows your workflow to do things like label or comment on pull requests from forks."
- Workflow syntax, `permissions`: "...for the `pull_request_target` event, the `GITHUB_TOKEN` is granted read/write repository permission, even when it is triggered from a public fork."
- Hardening guide (`https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions`): "The `pull_request_target` and `workflow_run` workflow triggers, when used with the checkout of an untrusted pull request, expose the repository to security compromises. These workflows are privileged, which means they share the same cache of the main branch with other privileged workflow triggers, and may have repository write access and access to referenced secrets." It also says: "Avoid using the `pull_request_target` workflow trigger if it's not necessary."

**Security difference (summary, from the above):** `pull_request` runs the fork's code with no secrets and a read-only token. `pull_request_target` runs the base branch's workflow file with secrets and a read/write token, so any step that checks out or runs the fork's code gives that code those secrets. The docs' own warning is about that checkout.

### B.3 Does a fork inherit upstream environments, secrets, variables, deploy keys, or rulesets?

**Expected: no, for environments, secrets, variables and deploy keys. Confirmed for the settings-level statement; the rest is derived.**
- About forks (`https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-forks`): "A fork is a separate repository with its own settings and collaboration space. Each fork can have its own: Branches; Members and discussions; Issues and pull requests; Actions and projects; Tags, labels, and wikis." Also "A fork has its own settings and permissions but stays connected to the upstream repository."
- Deploy keys (`https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys`): "a deploy key, which is an SSH key that grants access to a single repository. GitHub attaches the public part of the key directly to your repository". A fork is a different repository, so it has no upstream deploy key (derived).
- Environments and secrets are per-repository, so a fork starts without them (derived from the "own settings" statement and the environment page above). The docs do not list fork-copy exceptions for them.
- **Rulesets, exception:** push rulesets do propagate. "About push rulesets for forked repositories: Push rules apply to the entire fork network for a repository… if you fork a repository that has push rulesets enabled, the same push rulesets will also apply to your forked repository." (`https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets`). Branch and tag rulesets are not stated to propagate. They follow "own settings" (derived).

### B.4 Approval for workflow runs from first-time or outside contributors

- Settings page, fork policy: "By default, all first-time contributors require approval to run workflows." (`https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository`).
- The settings page offers a choice of approval scopes. The only label I read verbatim is "Require approval for first-time contributors who are new to GitHub" ("the first two settings" in the warning below are the first-time-contributor options). The other labels were not read in full (UNCONFIRMED).
- Settings page warning: "When requiring approvals only for first-time contributors (the first two settings), a user that has had any commit or pull request merged into the repository will not require approval. A malicious user could meet this requirement by getting a simple typo or other innocuous change accepted by a maintainer…"
- Approval page (`https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks`): "Workflow runs triggered by a contributor's pull request from a fork may require manual approval from a maintainer with write access." "Workflow runs that have been awaiting approval for more than 30 days expire and are marked as failed."
- Settings page: "Workflows triggered by `pull_request_target` events are run in the context of the base branch. Since the base branch is considered trusted, workflows triggered by these events will always run, regardless of approval settings."

### B.5 Private vulnerability reporting and SECURITY.md

- Owners and admins of public repos enable it: "Owners and administrators of public repositories can enable private vulnerability reporting on their repositories." (`https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability`).
- Enablement (`https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository`): "Under 'Advanced Security', to the right of 'Private vulnerability reporting', click **Enable** or **Disable**." It is a repository-level setting.
- Interaction with SECURITY.md (same privately-reporting page): "Private vulnerability reporting is separate from a repository's `SECURITY.md` file. You can only report vulnerabilities privately for repositories where this feature is enabled. If the repository has a security policy, the policy is displayed above the reporting form so you can review the maintainer's guidance before submitting. If a public repository has private vulnerability reporting enabled, anyone can submit a private vulnerability report to the repository maintainers."
- SECURITY.md is a separate file, created through "Security policy → Start setup" (`https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository`). It is displayed on the reporting form when present. It does not turn on the reporting feature.
- Forks: each fork has its own settings (B.3), so PVR is per repository (derived).

### B.6 Template repositories vs forks

- Template (`https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template`):
  > "Creating a repository from a template is similar to forking a repository, but there are important differences: * A new fork includes the entire commit history of the parent repository, while a repository created from a template starts with a single commit."
  > "Branches created from a template have unrelated histories, which means you cannot create pull requests or merge between the branches."
  > "Optionally, to include the directory structure and files from only the default branch of the template repository or to include all branches."
- Template creation (`https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository`): a new repo is "based on the template with the same directory structure, branches, and files."
- **What is copied:** the directory structure, the files (including `.github/workflows/`, which are files; derived), and branches. Settings, secrets, environments, variables, deploy keys, rulesets, and Actions enablement are not listed among the copied items on either page (derived from that absence; the docs do not state it).
- **Pulling later upstream changes:** a template-created repo has no shared history with the template, so PRs and merges between them are not possible (quote above). The docs describe no sync feature for templates. A manual `git merge --allow-unrelated-histories` (`https://git-scm.com/docs/git-merge`: "By default, git merge command refuses to merge histories that do not share a common ancestor. This option can be used to override this safety when merging histories of two projects that started their lives independently.") or cherry-picking is possible but not a supported flow (derived).
- Forks keep history and can be synced: "Sync a forked repository with its upstream repository using the web interface, GitHub CLI, or command line." (`https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork`).

---

## Facts that bear on the release design

- **Licences by CLI:** Codex (`openai/codex`, Apache-2.0), claude-agent-acp (`agentclientprotocol/claude-agent-acp`, Apache-2.0), OpenCode (`anomalyco/opencode`, MIT), and pi (`earendil-works/pi`, MIT). Claude Code and the Claude Agent SDK are proprietary ("Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."). Sources: `https://raw.githubusercontent.com/openai/codex/rust-v0.167.2/LICENSE`; `https://raw.githubusercontent.com/anomalyco/opencode/v2.2.7/LICENSE`; `https://raw.githubusercontent.com/earendil-works/pi/v1.5.2/LICENSE`; `https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/-/claude-agent-acp-0.106.0.tgz` (`LICENSE`); `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.328.tgz` (`package/LICENSE.md`).
- **The repo's licence choice does not change the CLIs' terms.** An MIT or Apache-2.0 licence on t3flare covers only t3flare's own code. Claude's binary stays under Anthropic's terms whatever t3flare's licence is (derived from the licence texts above).
- **Build-time install keeps the project out of redistribution.** Each deployer's build downloads the CLIs; the repo holds no binaries (derived, `apps/sandbox-image/image/Dockerfile`). A prebuilt image the project publishes would redistribute the Claude binary, which needs Commercial Terms and "must not be modified" (`https://code.claude.com/docs/en/legal-and-compliance`, "Can customers offer Claude Code in their products?").
- **Apache-2.0 notice duty for Codex and ACP** in any prebuilt image: a copy of the licence, and NOTICE text if the work ships one (`https://raw.githubusercontent.com/openai/codex/rust-v0.167.2/LICENSE`, §4(a), §4(d)).
- **MIT notice duty for OpenCode and pi:** the copyright and permission notice goes in "all copies or substantial portions of the Software" (`…/opencode/v2.2.7/LICENSE`, `…/pi/v1.5.2/LICENSE`). The pi npm tarball does not carry its LICENSE file (`https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz`), so a prebuilt image must include it.
- **Naming:** a product may say it "runs Claude Code" but may not use "Claude Code" or Anthropic names or logos in its own product, feature or company name (`https://code.claude.com/docs/en/legal-and-compliance`, trademark paragraph). Check the project's name and any logo before release.
- **Headless Claude:** Consumer Terms bar automated access "except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it" (`https://www.anthropic.com/legal/consumer-terms`, §3). Default headless Claude Code runs to an API key. Subscription OAuth is for "ordinary use" by the subscriber (`https://code.claude.com/docs/en/legal-and-compliance`). This is the most restrictive point for any hosted or multi-user release.
- **No subscription credential intermediation:** "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" and "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf" (`https://code.claude.com/docs/en/legal-and-compliance`); AUP: "services that route requests through consumer subscriptions" are prohibited (`https://www.anthropic.com/legal/aup`). The release must not route one user's Claude or ChatGPT login through the project or to other users.
- **Codex headless:** OpenAI names API keys as the way to run Codex in CI/CD; ChatGPT `auth.json` reuse is for "trusted private automation" and "Do not use this workflow for public or open-source repositories" (`https://developers.openai.com/codex/auth`; `https://developers.openai.com/codex/auth/ci-cd-auth`). Note the OpenAI Usage Policies revision effective 2026-11-20 (`https://openai.com/policies/usage-policies/`).
- **Forks have no Actions by default and scheduled workflows are off:** "When a public repository is forked, scheduled workflows are disabled by default." A deployer must enable Actions in the fork's Actions tab and then each scheduled workflow (`https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows`; `https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows`).
- **Fork PRs get no secrets and a read-only token:** "With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a forked repository." and "The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories." (`https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows`).
- **`pull_request_target` runs base-branch code with secrets and a write token,** so checking out a fork's code under it is the known risk: "may have repository write access and access to referenced secrets" (`https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions`; `https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax`, `permissions`, "pull_request_target ... read/write repository permission").
- **First-time contributors need approval by default** (`https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository`, fork policy). The approval rule is weaker than it looks: a user with any previously merged commit or PR is not treated as first-time (same page, warning).
- **Forks start without the upstream's environments, secrets, variables, deploy keys, or branch rulesets** (derived from `https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-forks`: "A fork has its own settings and permissions"; deploy key: `https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys`). **Push rulesets do propagate to the fork network** (`https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets`).
- **Private vulnerability reporting is a per-repo switch and independent of SECURITY.md.** Enable it under Code security and analysis → Advanced Security; a SECURITY.md is shown above the form but does not enable the feature (`https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability`; `https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository`).
- **Template repos have unrelated history and no upstream sync.** A repo from a template starts with a single commit and "you cannot create pull requests or merge between the branches" (`https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template`). A fork keeps history and has "Sync fork" (`https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork`). If the release should let deployers take later upstream changes, a fork fits and a template does not.

---

## Items I could not confirm (UNCONFIRMED)

1. Whether the Claude Agent SDK version the lock resolves matches 0.3.322 (the ACP package's declared dependency) or the npm `latest` 0.3.328. The lock was not read.
2. The contents of the managed-settings file the profile writes for Claude Code, and whether it restricts any sign-in method (`apps/sandbox-image/image/t3flare-claude-agent-acp`; Anthropic legal page rule quoted in A.2).
3. Whether pi's `/login` offers Claude Pro/Max OAuth (A.3).
4. Whether `openai/codex` or `anomalyco/opencode` ship a NOTICE file in their releases (Apache §4(d)).
5. Whether third-party dependencies bundled into pi's `dist/bundle/cli.js` need their licence texts carried.
6. Which default `GITHUB_TOKEN` permission setting new repos get ("restricted" or "permissive"). The settings page describes both and does not state the default.
7. The enable button's label on the "Enabling a workflow" page (B.1 step 4+ not read).
8. Whether a branch or tag ruleset propagates to a fork. The rulesets page says only push rulesets do.
9. Anthropic's position on a self-built image run by one deployer for their own use (A.2 interpretation). The legal page covers "preinstalling or running ... in your products or services" and "end users" but does not say whether one deployer's own use is covered.
10. Whether Claude's consumer-terms automation ban, read with the legal page's OAuth scope, allows headless use on one's own subscription (A.3 interpretation). Vendor clarification would settle it.
11. The `claude-code` npm licence pointer (`SEE LICENSE IN README.md`) and the GitHub `main` LICENSE.md text differ from the 2.1.328 `LICENSE.md` (A.1). Which text governs the version in the image is UNCONFIRMED; the image uses the npm copy.

---

## Sources checked (primary)

Licences (package tarballs and repo files at the pinned versions):
- `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.328.tgz` (`package/LICENSE.md`, `package/README.md`); `https://www.npmjs.com/package/@anthropic-ai/claude-code`; `https://registry.npmjs.org/@anthropic-ai/claude-code/latest`
- `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.328.tgz` (`package/LICENSE.md`); `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest`; `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/0.3.328`
- `https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.106.0`; `https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/-/claude-agent-acp-0.106.0.tgz`
- `https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md`
- `https://raw.githubusercontent.com/openai/codex/rust-v0.167.2/LICENSE`; `https://registry.npmjs.org/@openai/codex/0.167.2`
- `https://raw.githubusercontent.com/anomalyco/opencode/v2.2.7/LICENSE`; `https://github.com/sst/opencode` (301 to `anomalyco/opencode`)
- `https://raw.githubusercontent.com/earendil-works/pi/v1.5.2/LICENSE`; `https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.5.2`; `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz`

Vendor terms and docs:
- Anthropic: `https://code.claude.com/docs/en/legal-and-compliance`; `https://www.anthropic.com/legal/consumer-terms`; `https://www.anthropic.com/legal/commercial-terms`; `https://www.anthropic.com/legal/aup`
- OpenAI: `https://openai.com/policies/terms-of-use/`; `https://openai.com/policies/services-agreement/`; `https://openai.com/policies/usage-policies/`; `https://developers.openai.com/codex/auth`; `https://developers.openai.com/codex/auth/ci-cd-auth`
- OpenCode: `https://opencode.ai/docs/providers/`
- pi: `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md`

GitHub and git:
- `https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows`
- `https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows`
- `https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks`
- `https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions`
- `https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions`
- `https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax`
- `https://docs.github.com/en/actions/tutorials/authenticate-with-github_token`
- `https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository`
- `https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments`
- `https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-forks`
- `https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork`
- `https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets`
- `https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys`
- `https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability`
- `https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository`
- `https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository`
- `https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template`
- `https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository`
- `https://git-scm.com/docs/git-merge`

Repo files read: `apps/sandbox-image/image/Dockerfile`; `apps/sandbox-image/image/cli/package.json`; `apps/sandbox-image/image/claude/package.json`; `apps/sandbox-image/image/t3flare-claude-agent-acp` (lines 1–8). Not read, per instructions: `~/.config/t3flare/dev.env`, `~/.alchemy/**`, `apps/environment/.alchemy/stages/*`.

---

## Part C: T3 name and trademark

Research date: 2026-11-19. Question: does T3 Tools Inc. publish a trademark or brand policy, hold a US mark on "T3", "T3 Code" or "T3 Chat", restrict third-party names containing "t3" or use of logos, and what precedent exists for community "t3" projects?

Short answer: no published policy restricts "t3" names or logo use in the t3code repo or on t3.codes. The one brand clause found is in the T3 Chat (t3.chat) Terms, and it covers that service, not t3code. A USPTO record for PING LABS exists but is reported dead. I could not query the USPTO directly, so I have not confirmed the absence of a live "T3", "T3 Code" or "T3 Chat" registration or application.

### USPTO

- **Not verified against the USPTO.** The search and status pages return only a JavaScript shell to my tools: https://tmsearch.uspto.gov/ and https://tsdr.uspto.gov/#caseNumber=97294243&caseType=SERIAL_NO&searchType=statusSearch. The GitHub and USPTO query URLs I tried also failed (404 for a TESS-style URL; 401 for GitHub code search). A search of the owner "T3 Tools Inc." and of the words "T3", "T3 CODE" and "T3 CHAT" on https://tmsearch.uspto.gov/ must be run by hand before any release decision.
- **One application found, reported dead.** PING LABS, serial 97294243, standard character mark, owner T3 Tools Inc. (San Francisco), filed 2022-03-03, Classes 9 and 42 (online video recording and streaming software), first use 2022-02-09, not registered. It was abandoned 2025-06-03 for failure to respond to an office action, after a final refusal on 2025-02-17. Sources: https://markinton.com/trademark/ping-labs-97294243 (last updated 2026-01-07) and https://www.trademarkelite.com/trademark/trademark-detail/97294243/PING-LABS. Both are third-party mirrors of USPTO data, not primary sources. Justia also lists this mark under T3 Tools Inc. (https://trademarks.justia.com/owners/t3-tools-inc-5120066), but the page returned HTTP 403 to my fetch, so I cite only the search snippet.
- **No record found for "T3", "T3 Code" or "T3 Chat"** in any source I could reach. These searches were not run against the USPTO itself, so absence is not established.
- **Third-party "T3" marks exist.** A 2009 WIPO UDRP decision records that Future Publishing Limited held Community Trademarks for T3 in Classes 9, 16, 35, 36 and 41, used for its T3 gadget magazine. Source: https://www.wipo.int/amc/en/domains/decisions/html/2009/d2009-1349.html. That is a 2009 record and its current status is not checked here. It is context for how crowded "T3" is, not a finding about today's register.

### Company and corporate identity

- The t3code LICENSE reads "Copyright (c) 2026 T3 Tools Inc." (https://github.com/pingdotgg/t3code/blob/main/LICENSE).
- The company is styled "Ping Labs" on https://t3.tools/. That page lists T3 Code and T3 Chat as its products and links a /brand/ asset path (https://t3.tools/). I found no usage terms there.
- Aventure lists the company's other names as "T3 Tools, Inc.", "Ping.gg", "Ping Labs", "t3gg" and "T3 Tools" (https://aventure.vc/companies/t3-chat-san-francisco-ca-us). Crunchbase gives the legal name as "T3 Tools, Inc" (https://www.crunchbase.com/organization/t3-chat).

### Published policies, checked

- **t3code repo root** (https://api.github.com/repos/pingdotgg/t3code/contents/, default branch main). Files include LICENSE, README.md, CONTRIBUTING.md, SECURITY.md, AGENTS.md and CLAUDE.md. There is no TRADEMARK, BRAND, NOTICE or trademark-policy file.
- **README.md** (https://github.com/pingdotgg/t3code/blob/main/README.md). It says "Open. MIT licensed. If you don't like something, fork it." It has no naming, trademark or logo-use section.
- **LICENSE** (https://github.com/pingdotgg/t3code/blob/main/LICENSE). Standard MIT text. The notice requirement applies: "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software." The text says nothing about trademarks, names or logos.
- **CONTRIBUTING.md** (https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md). Covers PR rules and vouching only. No naming or brand rules.
- **assets/README.md** (https://github.com/pingdotgg/t3code/blob/main/assets/README.md). Describes the Icon Composer sources and export steps for the T3 mark. It gives no usage permission or restriction for the logo.
- **docs/user/faq.md** (https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/faq.md). Says "Truly 100% open source. If we go the wrong direction, fork it." and "you can always fork it, self host". It says nothing about names or logos.
- **t3.codes homepage** (https://t3.codes/). The CTA "Steal our code (legally)" links to the repo. The page says "Ship your own build. Self-host it or distribute it as your own." and "MIT licensed". No trademark terms.
- **t3.codes/terms** returned HTTP 404 (https://t3.codes/terms). I did not find a T3 Code terms page.
- **T3 Chat Terms of Service** (https://t3.chat/terms-of-service, last updated 2025-11-15). Defines "T3 Chat" as T3 Tools, Inc. §4: "Nothing in these Terms authorizes you to use any of T3 Chat's trademarks, logos, domain names, or other distinctive brand features except as otherwise permitted by law." §5 bars user content that infringes "trademark, service mark, trade name ... or T3 Chat" rights. §15 names a DMCA agent. These terms govern the T3 Chat service only. They do not govern t3code or its forks.
- **create-t3-app** (https://github.com/t3-oss/create-t3-app) is MIT and lives in the t3-oss GitHub org, not pingdotgg. Its README calls the "T3 Stack" "a web development stack made by Theo". I did not verify from a primary page that T3 Tools owns the org or the repo. Its README has no trademark or naming policy.

### Precedent: community projects named or built on T3

- **Synara (formerly DP Code)**, a fork of T3 Code by Emanuele Di Pietro (trySynara). He wrote on 2026-07-12: "I decided to abort every T3 reference in the code because this is no longer 'just a fork of T3 Code'" (https://x.com/emanueledpt/status/2076309459589116168). Synara 0.5.0 states "No more legacy T3Code or t3tools references" (https://x.com/trySynara/status/2076305478192164891). Synara's comparison page says it "is a fork of T3 Code, cloned from the T3 Code repository at the end of March 2026" under the MIT license (https://www.trysynara.com/compare/t3-code). The rename was self-initiated as far as the posts show. No demand letter or trademark claim appears in any source I found.
- **Theo's public complaint about Synara** (2026-08-03): "trySynara by @emanueledpt is a T3 Code fork that illegally stripped all credit and copyright. I would request Emanuele restore the copyright notices from our work" (https://x.com/theo/status/2084197114348028281). The complaint is about copyright notices and credit, not the name. It is a public request, not a legal action that I could find.
- **ImZoomBoy/t3code**, a fork that kept the repo name "t3code". Issue #59, opened 2026-08-10, asked to make the fork visually distinct from official T3 Code (app icon, sidebar wordmark, window title). It was closed as completed in #105 on 2026-09-08 (https://github.com/ImZoomBoy/t3code/issues/59). The fork's commit f6e1761 is titled "fix(desktop): assert the fork's identity, not upstream's (#94)". I found no rename request from T3 Tools against this fork.
- **Not found:** any t3-* community project that was asked to rename by T3 Tools, any published T3 Tools request to rename a project, or any "t3" trademark dispute. I did not search npm, Discord or the T3 Code issue tracker for these, so their absence is not confirmed.

### Limits

- I did not reach USPTO TSDR, TESS or the Trademark Search API. Mirror sites (Markinton, TrademarkElite) and a Justia snippet are secondary sources.
- The GitHub code search API returned HTTP 401, so I could not search the t3code repo for "trademark" or "brand" beyond the directory listings and the files named above.
- This is a fact-finding note, not legal advice.

### Facts that bear on the release design

- No published T3 Tools policy restricts a third-party project name containing "t3" or the use of a logo. The t3code repo, README, CONTRIBUTING, FAQ, assets README and t3.codes homepage are silent on both (URLs above).
- The MIT notice requirement applies to copies of the software. Keeping the t3code copyright notice in the t3flare LICENSE or NOTICE file is what the license requires. Theo's Synara complaint is about exactly that (https://x.com/theo/status/2084197114348028281).
- The LICENSE does not say whether it covers the logos in assets/. I found no separate license for them. Avoid reusing the T3 Code logo or the "T3 Code" wordmark in t3flare's own branding. The published sources do not license it.
- The only trademark clause is T3 Chat's ToS §4, and it covers the T3 Chat service. A t3code Environment on Cloudflare does not use T3 Chat, so the ToS does not apply to t3flare on its face. Do not state that T3 Chat is involved unless it is.
- Before release, run a manual USPTO search on tmsearch.uspto.gov for owner "T3 Tools" and for "T3", "T3 CODE" and "T3 CHAT", including pending applications. The only record I found is PING LABS, which is dead. A live "T3" filing would change the risk assessment.
- Precedent suggests that T3 Tools objects to lost credit and copyright notices (the Synara case), not to a "t3" name alone. ImZoomBoy's fork kept the name and drew no public objection. Forks that dropped T3 references did so themselves.
- Describe t3flare as a t3code Environment on Cloudflare, and say it is not affiliated with T3 Tools Inc. Keep the upstream copyright notice intact. Do not use the T3 logo as the project mark.

---

## Part D: Subscription sign-in terms (Copilot, OpenAI, Anthropic)

Question: may the Owner's own paid plan (GitHub Copilot, ChatGPT, or Claude) be held by a server-side broker and attached to requests from coding-agent harnesses in the Owner's own cloud account, including non-vendor harnesses (pi, OpenCode) and headless use?

Research date: 2026-11-19. Conventions as in Part A: quotes are verbatim from the fetched text. **Interpretation (mine):** marks my reading, which the vendor does not state. OpenAI's incoming Usage Policies take effect 2026-11-20, one day after this research date; the current version applies until then.

### D.1 GitHub Copilot

**Which terms govern an individual plan.**
- GitHub Terms for Additional Products and Features, version effective 2026-08-27, section "GitHub Copilot" (`https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features`):
  > "For all other GitHub Copilot users, your use of GitHub Copilot is governed by Section J (AI Features) of the GitHub Terms of Service."
- Copilot Product Specific Terms (`https://github.com/customer-terms/github-copilot-product-specific-terms`, banner: "deprecated effective 5 March 2026"):
  > "These terms only apply to Copilot Business and Copilot Enterprise, and only when purchased directly from GitHub."
  > "If you purchase GitHub Copilot Individual, these terms do not apply to you and your use of GitHub Copilot is instead governed by the GitHub Terms of Service..."
- GitHub Generative AI Services Terms (`https://github.com/customer-terms/github-generative-ai-services-terms`, version March 2026): "If you do not purchase GitHub under a volume licensing agreement, this document does not apply to you."
- So the Owner's personal plan is governed by the GitHub Terms of Service (`https://docs.github.com/en/site-policy/github-terms/github-terms-of-service`, effective 2026-04-27) and the GitHub Acceptable Use Policies (`https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies`).

**Third-party clients and tokens.** I found no primary GitHub text that names third-party clients or restricts using a Copilot subscription token from one. I found no approved-client list, no Copilot-token policy, and no partner program for a third-party client to use a personal subscription token.

- Strongest restriction in the terms, AUP §6 "Services Usage Limits" (`https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies`):
  > "You will not reproduce, duplicate, copy, sell, resell or exploit any portion of the Service, use of the Service, or access to the Service without our express written permission."
  **Interpretation (mine):** read broadly, this reaches a broker that makes the Owner's Copilot access available to other programs. Read narrowly, it targets resale. GitHub has not said which. Treat it as unresolved.
- ToS §C (`https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#c-acceptable-use`): "You agree that you will not under any circumstances violate our Acceptable Use Policies or Community Guidelines."

**Routes GitHub does document.**
- Copilot SDK authentication (`https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate`): the methods table lists "Environment Variables | CI/CD, automation, server-to-server | Yes" (Copilot subscription required). Its OAuth section says: "Your app receives a user access token (`gho_` or `ghu_` prefix)." Its supported-token list excludes "`ghp_` - Classic personal access tokens (deprecated)".
- Copilot SDK GA changelog (`https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/`): "The GitHub Copilot SDK is available to all existing GitHub Copilot subscribers, including Copilot Free for personal use, and to non-Copilot users via BYOK."
- Server-to-server tokens (`https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens`): for services outside Actions, "Create a GitHub App with the **Copilot Requests** organization permission", and "Usage is attributed and billed to the organization that owns the GitHub App installation." **Interpretation (mine):** this route needs an organization, so a personal subscription cannot use it.
- Third-party coding agents (`https://docs.github.com/en/copilot/concepts/agent-capabilities/about-agents/about-third-party-coding-agents`, public preview): "The Anthropic Claude coding agent uses the Claude Agent SDK and can be powered by your existing Copilot subscription." The same holds for the OpenAI Codex coding agent. These run on GitHub and are installed as GitHub Apps. They are not token reuse.
- pi's provider doc lists "GitHub Copilot | `COPILOT_GITHUB_TOKEN`" (`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md`). That is pi's statement, not GitHub's approval.

**Interpretation (mine).** GitHub documents personal-token use in automation through its own runtime (the SDK or CLI) and through OAuth App user tokens that the app obtains itself. None of the pages describes a server that holds a subscriber's token and forwards model requests for a different vendor's client. That is the t3flare pattern, and it is not on the documented list.

**Headless and automated use on a server.** The sources do not restrict it by name for an individual plan. Two lines bear on it:
- AUP §4: "using our servers for any form of excessive automated bulk activity, to place undue burden on our servers through automated means."
- ToS §B.3 (`https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#b-account-terms`): "A machine account is used exclusively for performing automated tasks."

**Sharing.**
- ToS §B.3: "Your login may only be used by one person — i.e., a single login may not be shared by multiple people."
- ToS §H (API Terms): "You may not share API tokens to exceed GitHub's rate limitations."
**Interpretation (mine):** a single-Owner broker that serves one person's harnesses fits §B.3. A multi-user deployment does not.

**Excluded lead.** A GitHub issue (`https://github.com/anomalyco/opencode/issues/12258`) reports a GitHub response that PAT authentication is "not currently supported for third-party tools like OpenCode." That is a user's secondhand report, not a primary source, so I did not rely on it. GitHub should be asked directly.

### D.2 OpenAI (ChatGPT plan and Codex)

**Usage Policies, current and incoming.**
- Current, in force until 2026-11-20 (`https://openai.com/policies/usage-policies/revisions/2025-10-29/`, "Effective: October 29, 2025"): no clause on subscription credentials, account sharing, or model-access intermediaries. The "Protect people" list includes "circumventing our safeguards."
- Incoming (`https://openai.com/policies/usage-policies/`, "Effective: November 20, 2026 | Previous Version"; changelog: "2026-10-21: ... These changes are effective November 20, 2026."). New clause:
  > "**Providing access to our models.** If you operate a model-access intermediary platform or other service that enables third parties to directly access OpenAI models, you must obtain our prior review and approval. This requirement does not apply solely because an application integrates OpenAI models to power its features or functionality."
  The same version adds a training restriction ("You must not use OpenAI models or their outputs to generate, prepare, select, or supply training material or signals for models that are intended as alternatives to or substitutes for OpenAI models or services."), which does not govern access.
  **Interpretation (mine):** a broker serving only the Owner's own harnesses is not obviously "a model-access intermediary platform." Whether pi or OpenCode count as "third parties", and whether a broker shipped to other deployers counts, is open. Ask OpenAI before release.

**Terms of Use** (`https://openai.com/policies/terms-of-use/`, "Published: January 1, 2026"). Scope: "These Terms of Use apply to your use of ChatGPT, DALL·E, and OpenAI's other services for individuals". Quotes:
  > "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account."
  > "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services."
  > "Modify, copy, lease, sell or distribute any of our Services."
  The same page says: "Our Business Terms govern use of ChatGPT Enterprise, our APIs, and our other services for businesses and developers." **Interpretation (mine):** a Plus or Pro login falls under these Terms, not the Services Agreement.

**(a) Codex on a remote or headless server the user owns.** Codex auth docs (`https://developers.openai.com/codex/auth`):
- "Codex supports two ways for a person to sign in when using OpenAI models: Sign in with ChatGPT for subscription access; Sign in with an API key for usage-based access"
- "If you are signing in to ChatGPT with the Codex CLI, there are some situations where the browser-based login UI may not work: You're running the CLI in a remote or headless environment."
- Fallback, documented with a Docker example: "If you can complete the login flow on a machine with a browser, you can copy your cached credentials to the headless machine."
- "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted or public environments."
- Custom providers: "Set `requires_openai_auth = true` to use OpenAI authentication. You can then sign in with ChatGPT or an API key. This is useful when you access OpenAI models through an LLM proxy server."

CI/CD guide (`https://developers.openai.com/codex/auth/ci-cd-auth`), the passage in full:
  > The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account.
  >
  > This is an advanced workflow for enterprise and other trusted private automation. API keys are still the recommended option for most CI/CD jobs.
  >
  > Treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it, paste it into tickets, or share it in chat. Do not use this workflow for public or open-source repositories.

The guide's conditions include: "the runner is trusted private infrastructure" and "only one machine or serialized job stream will use a given `auth.json` copy."

**Interpretation (mine):** OpenAI documents Codex with ChatGPT-managed auth on a headless machine the user runs. The guide calls that advanced, conditional on trusted private infrastructure and one job stream per `auth.json`, with API keys as the default. A container in the Owner's own cloud account running Codex on the Owner's `auth.json` fits the documented pattern. A broker that exposes that login to other clients does not.

**(b) Non-OpenAI clients.** OpenAI's documented route for them is Sign in with ChatGPT:
- `https://learn.chatgpt.com/docs/sign-in-with-chatgpt` lists "Open-source integrations: OpenClaw, OpenCode, Pi, T3."
- `https://developers.openai.com/siwc/quickstart`: "For open-source developers: Let users run AI workloads in your tools with their ChatGPT plan, without requiring them to provide an API key. The open-source sign-in flow registers your client and issues OAuth credentials for eligible Responses API requests, without a client secret or partner API key." It also says "ChatGPT plan usage is available to all open-source partners and selected private clients."
- `https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites`: "Supported open-source tools remain available to all ChatGPT users." and "Only sign in to apps and sites you trust."

**Interpretation (mine).** OpenAI names pi, OpenCode, and T3 as open-source integrations with a sanctioned sign-in and plan flow. A harness that signs in itself is therefore a documented path. Not documented: a broker reusing a Codex-issued `auth.json` (Codex's own client) or another client's token to serve other harnesses. The "registers your client" step suggests plan usage is tied to a registered client. Ask OpenAI.

### D.3 Anthropic (Claude subscription)

**Consumer Terms** (`https://www.anthropic.com/legal/consumer-terms`), §3(7) and §2, re-verified in D.4: the automation ban has the exception "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it". §2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else."

**Usage Policy** (`https://www.anthropic.com/legal/aup`, "Effective Nov 12, 2026"), "Do Not Abuse Our Platform":
  > "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used"

**Claude Code legal page** (`https://code.claude.com/docs/en/legal-and-compliance`, section "Authentication and credential use"):
  > "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  > "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  > "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above."
  > "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
  The same page, section "Can customers offer Claude Code in their products?": "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf."

**Owner-run Claude Code with a long-lived token** (`https://code.claude.com/docs/en/authentication.md`, "Generate a long-lived token"):
  > "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`"
  > "This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan."

**Newer statements.**
- Agent SDK overview (`https://code.claude.com/docs/en/agent-sdk/overview.md`; no date in the fetched copy): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."
- Help Center (`https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`), the most recent dated update (October 7, 2026): "Nothing changes for your plan: when you're signed in with your Claude plan, the Claude Agent SDK and claude -p still draw from your subscription limits." The June 15, 2026 update says: "Claude Agent SDK, claude -p , and third-party app usage still draw from your subscription limits."
  **Interpretation (mine):** "third-party app usage" describes metering, not permission. It does not override the Claude Code legal page's ban on offering Claude.ai login or routing plan credentials for others. The page does not say which apps it means.

**Interpretation of the t3flare pattern (mine).**
- A broker that holds the Owner's Claude subscription credential and attaches it to pi or OpenCode requests falls within "collect, store, or intermediate Claude.ai credentials" and "route requests through ... plan credentials" on the text. The carve-out covers only the unmodified Claude Code binary signing in with the user's own subscription, and pi and OpenCode are not Claude Code. Treat it as prohibited.
- The Owner running unmodified Claude Code on their own login in their own container falls within the carve-out and the `setup-token` pattern. Open items: the managed-settings file (Part A, open item 2) and whether the broker's storage of the token counts as "store".
- Whether pi's `/login` offers Claude subscription OAuth remains unconfirmed. pi's provider doc (`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md`) says only that "Anthropic also recognizes `ANTHROPIC_OAUTH_TOKEN` as an API credential."

### D.4 Re-verification of Part A quotes (2026-11-19)

- Consumer Terms §3(7), `https://www.anthropic.com/legal/consumer-terms` ("Effective Oct 8, 2025"): verbatim match to Part A. ✔
- Usage Policy, `https://www.anthropic.com/legal/aup` ("Effective Nov 12, 2026"): verbatim match, "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions…" ✔
- Claude Code legal page, `https://code.claude.com/docs/en/legal-and-compliance`: the Part A quotes ("Can customers offer…" bullets, the trademark paragraph, the license line) match. ✔
- Codex auth and CI/CD quotes in Part A (`https://developers.openai.com/codex/auth`, `https://developers.openai.com/codex/auth/ci-cd-auth`): match. ✔
- OpenAI Terms of Use, Registration: "You may not share your account credentials…" matches (Jan 1, 2026 version). ✔
- Pi providers doc, Part A quotes: match. ✔
- Not re-verified in this pass: the OpenAI Services Agreement quotes and the OpenCode provider doc quote.

### Facts that bear on the per-vendor warnings

- **GitHub Copilot.** Strongest restriction: "You will not reproduce, duplicate, copy, sell, resell or exploit any portion of the Service, use of the Service, or access to the Service without our express written permission." (`https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies`, §6.) No approved-client list or third-party-token policy found. The documented routes are the Copilot SDK auth methods (`https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate`) and the organization GitHub App route (`https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens`). **Interpretation (mine):** the warning should say GitHub has not approved a third-party client using a personal token, and that AUP §6 may reach brokering.
- **OpenAI (ChatGPT plan).** Strongest restriction: "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account." (`https://openai.com/policies/terms-of-use/`, Registration.) From 2026-11-20, conditional: "If you operate a model-access intermediary platform or other service that enables third parties to directly access OpenAI models, you must obtain our prior review and approval." (`https://openai.com/policies/usage-policies/`.) **Interpretation (mine):** the account rule is the firmer constraint for a broker used by other programs. The intermediary rule may need OpenAI's review.
- **Anthropic (Claude subscription).** Strongest restriction: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens" (`https://code.claude.com/docs/en/legal-and-compliance`). **Interpretation (mine):** a broker holding the token for pi or OpenCode falls inside this sentence. An Owner-run, unmodified Claude Code falls inside the carve-out.
