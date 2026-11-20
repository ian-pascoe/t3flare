# Deploying t3flare

Anyone can deploy t3flare to their own Cloudflare account. Terms used here:

- **Owner**: the person a Deployment belongs to. Access admits only them to its admin routes.
- **Deployment**: one Owner's t3flare: their Cloudflare account, their GitHub App and their Stages (`prod`, and
  throwaway test Stages).
- **Deployment settings**: the Owner's own values a Deployment is made with (listed below). The source holds none of
  them and has no defaults: a deploy without one stops and names it.
- **Canonical repository**: [spiritledsoftware/t3flare](https://github.com/spiritledsoftware/t3flare), where t3flare is
  developed.
- **Deployment repository**: the repository whose CI deploys an Owner's `prod`: a fork or copy of the Canonical
  repository, or the Canonical repository itself for its Maintainer.

The [README](../README.md#requirements) lists what a Deployment needs: a Cloudflare Workers Paid account with
Containers and Access, a GitHub App, and a way to reach models.

## Deployment settings

On a laptop, put them in `~/.config/t3flare/dev.env` (0600, outside the repository; [`dev.env.example`](../dev.env.example)
lists every key). `stage.ts` reads that file itself, and a value already in the environment wins, so one can be given
on the command line (`T3FLARE_OWNER_EMAIL=you@example.com node scripts/stage.ts deploy mystage`). Don't source
`dev.env` into your shell. In CI they are the Deployment repository's variables and secrets, which `ci:setup` sets from
`dev.env` (below).

| Name | Required | Laptop | CI | Shape | What it does |
| --- | --- | --- | --- | --- | --- |
| `T3FLARE_ACCESS_TEAM_DOMAIN` | every deploy | `dev.env` | repository variable | `<team>.cloudflareaccess.com` | The Access team of the account. The Worker checks admin requests against its keys. |
| `T3FLARE_OWNER_EMAIL` | every deploy | `dev.env` | repository **secret** | an email address | The one person Access admits to the admin routes. A secret in CI because Actions logs are public and a variable prints unmasked. |
| `T3FLARE_T3_TRACK` | every deploy, the bump and the land | `dev.env` | repository variable | `stable` or `nightly` | The t3 track: which of t3's releases the Deployment follows ([ADR-0041](adr/0041-a-deployment-follows-one-t3-track-set-as-a-deployment-setting.md)). It names the pin's Server version, the bump takes the newest tag on it (only forward: after a switch to stable, it waits for a stable that contains the nightly pin), and an in-app Update takes only its releases. Keep your stock clients on the same update track. |
| `T3FLARE_WORKERS_DEV_SUBDOMAIN` | every deploy | `dev.env` | repository variable | a DNS label | The account's workers.dev subdomain (the `<x>` in `<x>.workers.dev`): a Stage without a domain is served at `t3flare-environment-<stage>.<x>.workers.dev`. |
| `T3FLARE_DOMAIN` | `prod` only | the shell, for a `prod` deploy | `prod` environment variable | a hostname | `prod`'s custom domain, in a Cloudflare zone of the account. Any other Stage is refused while it is set. `ci:setup` needs it too. |
| `T3FLARE_DOMAIN_ZONE_ID` | `ci:setup` only | `dev.env` | not needed | 32 hex characters | The id of `T3FLARE_DOMAIN`'s zone: `prod`'s CI token gets that zone's permissions. |
| `T3FLARE_UPDATE_REPO` | no | not set | `prod` environment variable | `owner/name` | The update target: the Deployment repository, whose CI an in-app Update dispatches. Unset, the Environment has no update target (see [Updating](#updating)). The one setting that fails open, so `deploy-prod.yml` logs `update target: set` or `update target: unset`. |
| `GITHUB_REPOSITORY` | the `infra` scripts | `dev.env` | set by Actions | `owner/name` | The Deployment repository that `ci:setup` and `github-app:setup` configure. There is no default, not even the git remote. |
| `T3FLARE_STANDIN_ZONE` | a deploy with `T3FLARE_STANDIN=1` | `dev.env` | not needed | a hostname | The zone a test Stage's stand-in laptop gets its hostname in ([outbound-link.md](outbound-link.md)). |
| `T3FLARE_FIXTURE_REPO` | the acceptance test and the stage scripts | `dev.env` | `bump` environment variable | `owner/name` | A small repository the GitHub App is installed on, which the acceptance test clones and pushes branches to. |
| `T3FLARE_LINEAR_SYNC` | no | not used | repository variable | `true` | Turns on `linear-project.yml`, which files new GitHub issues into the Canonical repository's Linear project. Leave it unset elsewhere. |

A missing or malformed setting stops the deploy before anything is built, with a message such as:

```text
t3flare: T3FLARE_OWNER_EMAIL is not set. Deployment settings are listed in docs/deploy.md: put them in ~/.config/t3flare/dev.env, or in the Deployment repository's variables for CI.
```

`alchemy.run.ts` reads them again the same way, so a direct alchemy run is held to the same rules.

The other keys in `dev.env` are not Deployment settings but credentials and options: `T3FLARE_GITHUB_APP_ID` and
`T3FLARE_GITHUB_APP_PRIVATE_KEY` (written by `github-app:setup`), and `T3FLARE_MODEL_ENDPOINT`, the Stages' Model
endpoints ([model-endpoints.md](model-endpoints.md#the-stages-model-endpoints)).

## Deploy

`prod` is served at a custom domain (`T3FLARE_DOMAIN`), and only `prod` has one. alchemy attaches it as a Workers
Custom Domain (DNS record and certificate included), puts the Access application on it, and makes it the Stage's only
URL: the Worker's workers.dev and preview URLs are turned off. It also rate-limits t3's auth routes on that host (10
`POST`s per 10 s per IP, then 429 for 10 s; [ADR-0010](adr/0010-the-endpoint-is-public-behind-t3s-own-auth.md)) in the
zone's `http_ratelimit` phase, which the Stage then owns, so only one Stage per zone may have a domain. `stage.ts`
refuses to deploy `prod` without it, and refuses any other Stage with it, as `alchemy.run.ts` does: another Stage on
`prod`'s domain would take over `prod`'s Access application and rate limit.

1. Install the tools: Node and pnpm at the versions in `mise.toml` (`mise install`; they follow t3code's), Docker, `gh`
   signed in, and `pnpm install` (the t3code submodule must be checked out). Run pnpm and `vp` from the repository,
   never inside `t3code/` ([AGENTS.md](../AGENTS.md)).
2. Log in to Cloudflare with alchemy: a `default` profile for deploys, and an `admin` profile that may create API
   tokens, for `infra`.
3. Copy [`dev.env.example`](../dev.env.example) to `~/.config/t3flare/dev.env` (mode 0600) and fill in the Deployment
   settings. Optionally add the Stages' Model endpoint as `T3FLARE_MODEL_ENDPOINT`
   ([model-endpoints.md](model-endpoints.md#the-stages-model-endpoints)); without it, a Stage deploys in the setup state,
   and you add endpoints in its Harness panel.
4. Run `pnpm --filter @t3flare/infra run github-app:setup`, which registers the GitHub App and writes its id and key
   into the same file. Install it on your fixture repository and on each repository the cloud should work on.
   Optionally, upload [`assets/t3flare-app-icon.png`](assets/t3flare-app-icon.png) as its logo (the app's settings,
   Display information): GitHub takes a logo only there, not from the registration.
5. Deploy a test Stage: `pnpm --filter @t3flare/environment run deploy <stage>`
   ([`apps/environment/scripts/stage.ts`](../apps/environment/scripts/stage.ts); the Stages it accepts are listed
   there). It builds the web client (when it is missing, or with `--web`) and the two Workers, then runs alchemy, which
   builds and pushes the Container image, and then saves the Stage's Model endpoint through the Harness panel's API. A
   Stage's secrets are kept in `apps/environment/.alchemy/stages/` (gitignored). A deploy replaces the Environment's code
   at once (connected clients reconnect), while Cloudflare lets the agents Worker's busy Durable Objects finish their
   work first, for up to five minutes.
6. Deploy `prod` from a clean checkout of `main`: `T3FLARE_DOMAIN=t3.example.com pnpm --filter @t3flare/environment run deploy prod`.
7. Pair your first client, then do the setup step in the Harness panel
   ([model-endpoints.md](model-endpoints.md#the-setup-step)): from `apps/environment`,
   `node scripts/stage.ts run <stage> admin POST "/_t3flare/arm-bootstrap?minutes=15"`, then open
   `/pair#token=<T3_BOOTSTRAP_TOKEN>` on the Stage's URL (the token is in `.alchemy/stages/<stage>.env.json`).
   - Pair every later device (desktop, phone, another browser) with a one-time pairing link from that client: Settings
     → Sharing & access.
   - Don't reuse the bootstrap token for later devices: a second pairing with it signs the first bearer client out
     ([ADR-0010](adr/0010-the-endpoint-is-public-behind-t3s-own-auth.md)).
   - The mobile and desktop apps must speak the orchestration protocol of the t3code release t3flare is pinned to
     (`t3code/`): keep them on the Deployment's t3 track (Settings → About → Update track: Stable for `stable`,
     Nightly for `nightly`). The web client is served by the Stage itself, so it always matches.

### CI (optional)

From the Deployment repository, after a first `prod` deploy from the laptop, run
`T3FLARE_DOMAIN=t3.example.com pnpm --filter @t3flare/infra run ci:setup` ([`infra/github.ts`](../infra/github.ts)). It
reads `dev.env` and sets up:

- the repository variables `T3FLARE_ACCESS_TEAM_DOMAIN`, `T3FLARE_WORKERS_DEV_SUBDOMAIN` and `T3FLARE_T3_TRACK`, and
  the repository secret `T3FLARE_OWNER_EMAIL`;
- the `bump` GitHub environment, for the t3 bump of t3code's pin (ADR-0017, ADR-0041): its Cloudflare token, the account id,
  `T3FLARE_FIXTURE_REPO`, and the secret `T3FLARE_MODEL_ENDPOINT`, the Model endpoints the job's Stage and acceptance
  test set up (one per API, an Anthropic Messages and an OpenAI Responses one, so every CLI agent runs; without it the
  bump's real turn has no model);
- the `prod` GitHub environment (`main` only), for [`deploy-prod.yml`](../.github/workflows/deploy-prod.yml), which
  deploys `prod` on every push to `main`: its own Cloudflare token (which also may attach Worker domains and edit the
  rate limit in `T3FLARE_DOMAIN_ZONE_ID`'s zone), `T3FLARE_DOMAIN`, `T3FLARE_UPDATE_REPO` when `dev.env` has it, the GitHub
  App, `T3FLARE_MODEL_ENDPOINT` (each deploy adds that endpoint to `prod` when `prod` has none of its id, and never
  changes it once there), and the laptop's `prod` tokens;
- the repository setting that lets Actions create pull requests (the bump proposes each new pin as one).

Run it again after changing or rotating any of those. The `land` environment and its deploy key, which an in-app Update
needs, are set by hand ([ADR-0037](adr/0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md) §7).

## Updating

A Deployment runs the commit it was deployed from. To update it, pull the Canonical repository's `main` into your
checkout (or the Deployment repository) and deploy the Stage again, as above. With CI, push the merged `main` to the
Deployment repository and `deploy-prod.yml` deploys `prod`.

When `prod` is deployed by CI with `T3FLARE_UPDATE_REPO` set to the Deployment repository, the stock clients' Update
buttons work too: a press dispatches that repository's bump workflow, which proves the new pin on the `bump` Stage and
lands it on `main`, and the push deploys `prod`
([ADR-0037](adr/0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md)).
The GitHub App must be installed on that repository. Only `prod` takes an update target: a deploy of any other Stage
with `T3FLARE_UPDATE_REPO` set is refused, since a press there would land on `main` and deploy `prod`. Without an update target, a press answers: "This Environment has
no update target. Update it by deploying: pull the Canonical repository's main and deploy this Stage again
(docs/deploy.md, Updating)."
