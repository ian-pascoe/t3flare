# A Deployment is configured outside the source tree, and the Canonical repository carries no Deployment's values

Status: accepted (2026-11-19, the open-source release's design interview). Refines
[ADR-0010](0010-the-endpoint-is-public-behind-t3s-own-auth.md) (the Owner's email and the Access team),
[ADR-0017](0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md) (the scheduled bump) and
[ADR-0037](0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md)
(the update target and ruleset `main`). Settings and the deploy steps: [`docs/deploy.md`](../deploy.md). Refined by
[ADR-0041](0041-a-deployment-follows-one-t3-track-set-as-a-deployment-setting.md), which adds the required
`T3FLARE_T3_TRACK`.

t3flare was written as one person's deployment: the Access team, the Owner's email, the workers.dev subdomain, `prod`'s
domain and zone, the update target, the infra scripts' repository and the fixture repository were constants or
defaults in the source. The repository is now public as the **Canonical repository**
(`spiritledsoftware/t3flare`, owned by Spirit-Led Software LLC's GitHub organisation), and anyone may deploy their own
**Deployment** from it. A copy that carries a diff of constants conflicts with every sync from the Canonical
repository, and a forgotten default puts the Maintainer's email in another Owner's Access policy.

So every value that differs between Deployments is a **Deployment setting**, read from the environment:

| Setting | Required | What it is |
| -- | -- | -- |
| `T3FLARE_ACCESS_TEAM_DOMAIN` | every deploy | the account's Access team |
| `T3FLARE_OWNER_EMAIL` | every deploy | the Owner, the one person Access admits to the admin routes |
| `T3FLARE_WORKERS_DEV_SUBDOMAIN` | every deploy | the account's workers.dev subdomain |
| `T3FLARE_DOMAIN` | `prod` | `prod`'s custom domain |
| `T3FLARE_DOMAIN_ZONE_ID` | `ci:setup` | the zone of `prod`'s domain |
| `T3FLARE_UPDATE_REPO` | no | the update target: the Deployment repository an Update dispatches |
| `GITHUB_REPOSITORY` | the infra scripts | the Deployment repository they configure |
| `T3FLARE_STANDIN_ZONE` | a stand-in laptop | the zone a test Stage's stand-in gets its hostname in |
| `T3FLARE_FIXTURE_REPO` | the acceptance test | the repository the test clones and pushes to |
| `T3FLARE_LINEAR_SYNC` | no | turns on the Canonical repository's Linear sync |

1. **No defaults; fail closed.** A missing or malformed required setting stops the deploy before anything is built,
   naming the setting and `docs/deploy.md`. `alchemy.run.ts` reads them the same way. `GITHUB_REPOSITORY` is never
   inferred from the git remote: the infra scripts write settings, secrets and tokens to that repository, and a clone of
   the Canonical repository has it as `origin`.
2. **Where they live.** On a laptop, `~/.config/t3flare/dev.env` (`dev.env.example` lists the names, with no values). In
   CI, the Deployment repository's variables, set by `ci:setup`; the Owner's email is a secret there, because a public
   repository's Actions logs are public and a variable prints unmasked.
3. **The update target fails open.** Unset, the Environment advertises no Update (ADR-0023), and a press that reaches
   the refusal is told to deploy again instead. That is the right answer for a Deployment without CI, so
   `deploy-prod.yml` logs whether the target is set rather than refusing.
4. **The Canonical repository is not a Deployment.** The organisation that owns it is not anyone's Cloudflare account.
   The Maintainer's own `prod` is one Deployment among others: its values are in the Maintainer's `dev.env` and in its
   Deployment repository's variables, which for it is the Canonical repository. One value stays in the source: the
   Canonical repository's own URL (the managed policy's support link, the GitHub App's homepage), which is a fact about
   the project.
5. **Two ways to deploy.** A clone deployed from a laptop is the primary path. A fork that runs its own CI works by
   settings alone: GitHub starts a public fork with Actions and scheduled workflows off, and forks no environments,
   secrets or deploy keys, so its Owner turns on what they want. A fork that runs its own bump makes its own pin commits
   and stops fast-forwarding from the Canonical repository's `main`.
6. **`prod` still needs a custom domain** in a Cloudflare zone of the account, for ADR-0010's rate limit on the auth
   routes.

ADRs 0001 to 0037 are records and stay as written. Where they name a value literally (ADR-0010's domain and zone,
ADR-0037 §11's repository), read it as the Maintainer's Deployment's setting.

## Considered Options

- **Keep the constants and let others change them in a fork.** Every sync from the Canonical repository would conflict.
- **A template repository.** It starts unrelated history, so a Deployment could never pull later fixes.
- **Default `GITHUB_REPOSITORY` to the `origin` remote.** A contributor's clone would point the infra scripts at the
  Canonical repository.
- **Look up the workers.dev subdomain and the zone id through Cloudflare's API.** Fewer settings, but the workflow's
  `environment.url` and several scripts need the subdomain without an API call.

## Consequences

- A first deploy needs the settings filled in, and a Deployment with CI needs `ci:setup` run again when one changes.
- The Maintainer's Deployment needs its values set in the Canonical repository's variables before the change that
  removes the constants merges; a missing one fails that deploy and `prod` stays on the previous version. After it, the
  Access policy and the Update button are checked, since the update target alone fails open.
