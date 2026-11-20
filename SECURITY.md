# Security policy

t3flare is published by Spirit-Led Software LLC and maintained by one person, on a best-effort basis.

## Supported versions

Only the tip of `main` is supported. t3flare has no releases: `main` follows t3code's stable releases and deploys
continuously, so a fix lands on `main` and nowhere else.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/spiritledsoftware/t3flare/security/advisories/new). If you
cannot use GitHub, email social@spiritledsoftware.com.

Please do not open a public issue, discussion or pull request for a vulnerability.

Include what you can of:

- the affected route, component or file, and the commit of `main` you tested;
- the steps to reproduce it, against a Deployment of your own;
- what an attacker gains, and what they need first (a paired client, a Workspace, Access, nothing).

Test only against a Deployment you own. Never test against the Maintainer's Deployment or anyone else's.

## What to expect

- We aim to acknowledge a report within 7 days.
- Disclosure is coordinated, with a 90-day default from the report: we publish a GitHub security advisory once a fix is
  on `main`, or when the 90 days end, whichever comes first, unless we agree another date with you.
- We credit you in the advisory if you want to be credited.
- There is no bug bounty.

## Scope

In scope, as t3flare builds and configures them:

- the public endpoint and the t3 auth routes t3flare mounts ([ADR-0010](docs/adr/0010-the-endpoint-is-public-behind-t3s-own-auth.md));
- the Access-guarded `/_t3flare` routes: the admin routes, the Settings page and the Settings server;
- Container isolation, and the rule that no vendor credential enters a Container
  ([ADR-0016](docs/adr/0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md));
- the GitHub App's tokens and their scoping ([ADR-0013](docs/adr/0013-github-access-through-a-github-app-with-per-repo-tokens.md));
- the Credential broker, Model endpoints and the Model relay;
- t3flare's Patches and Shadows of t3code;
- the CI chain that proves and lands an Update
  ([ADR-0037](docs/adr/0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md)).

Out of scope:

- unmodified t3code and the stock T3 Code clients: report those to [pingdotgg/t3code](https://github.com/pingdotgg/t3code);
- the CLI agents themselves (Codex, Claude Code, OpenCode, pi) and Cloudflare's platform: report those to their publishers;
- a Deployment's own misconfiguration;
- anything that first needs Owner-equivalent access, including the residual ADR-0037 §6 records for a Workspace opted
  in to changing CI;
- volumetric or cost denial of service.

## Known limits

- Ruleset `main` on the Canonical repository requires no approving review, so a Container token for it (contents and
  pull requests write), held by a Workspace of the Maintainer's Deployment, could likely open and merge its own pull
  request once `check` passes. This is tracked as SPI-1262.
