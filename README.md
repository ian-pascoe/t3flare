# t3flare

A t3code Environment on Cloudflare. The stock t3 clients (web, desktop, mobile) attach to it like any other Environment, and the owner's laptop delegates to it over a Peer link. Its agents run on pi-durable in Durable Objects, or as CLIs (Codex, Claude Code, OpenCode) in Containers started only when needed.

- [`docs/plan.md`](docs/plan.md): milestones and their exit criteria.
- [`docs/adr/`](docs/adr/): the decisions that are hard to reverse.
- [`docs/research/`](docs/research/): platform facts the decisions rest on.
- [`GLOSSARY.md`](GLOSSARY.md): the terms.

## Status

Steps 0 (spike), 1 (platform) and 2a part 1 (Durable agents on the model proxy) are done; step 2a part 2 is next ([plan](docs/plan.md)). What works today, against a deployed stage and the stock web and desktop clients: pair, create a project, clone a repo from GitHub, run a Durable agent turn that edits files and runs `bash`, approve a tool call, see the diff, push and open a PR, and an Environment restart mid-turn that continues ([step 2a report](docs/steps/step-2a.md)). CLI agents, Peer links and the terminal are not built.

## Requirements

Deploying t3flare needs all three:

1. **Cloudflare**: a Workers **Paid** account with **Containers** (the Durable agents' Workspaces run commands in one), and Cloudflare Access (Zero Trust) for the admin routes ([ADR-0010](docs/adr/0010-the-endpoint-is-public-behind-t3s-own-auth.md)). The deploy builds the Container image with local Docker.
2. **A GitHub App** that gives each Workspace a token for its one repo ([ADR-0013](docs/adr/0013-github-access-through-a-github-app-with-per-repo-tokens.md)). `bun run --cwd infra github-app:setup` registers it under your account and stores its id and key.
3. **A model proxy.** t3flare holds no model credentials of its own: every model call, the agents' turns, generated titles and commit text, and the model list, goes to a proxy you run, speaking the Anthropic Messages API and listing its models at `GET /v1/models`. The proxy t3flare is built and tested against is [Commissary](https://github.com/spiritledsoftware/commissary), which you deploy to your own Cloudflare account or buy as Commissary Cloud, and where you connect your Claude, ChatGPT and other subscriptions and provider keys. **[`docs/model-proxy.md`](docs/model-proxy.md)** says exactly what the proxy must provide and how to set it up.

## Deploy your own

This repo is the owner's deployment, and a few of its settings are still the owner's: `apps/environment/alchemy.run.ts` names the Access team (`spirit-led-software`), the owner's email and the account's workers.dev subdomain (the first two can be overridden by `T3FLARE_ACCESS_TEAM_DOMAIN` and `T3FLARE_OWNER_EMAIL`; the subdomain is a constant to change), and `infra/github.ts` defaults to the repository `ian-pascoe/t3flare` (`GITHUB_REPOSITORY`). An outline for your own account:

1. Install the tools: [Bun](https://bun.sh) (the version in `mise.toml`), Docker, `gh` signed in, and `bun install` (the t3code submodule must be checked out).
2. Log in to Cloudflare with alchemy (a `default` profile for deploys; an `admin` profile that may create API tokens, for `infra`).
3. Set up the model proxy ([`docs/model-proxy.md`](docs/model-proxy.md)): put `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY` in `~/.config/t3flare/dev.env`.
4. Run `bun run --cwd infra github-app:setup`, which writes the GitHub App's id and key into the same file.
5. Deploy a stage: `bun run --cwd apps/environment deploy <stage>` ([`apps/environment/scripts/stage.ts`](apps/environment/scripts/stage.ts)). It builds the web client (when it is missing, or with `--web`) and the two Workers, then runs alchemy, which builds and pushes the Container image. The stages it accepts are listed in that file; `prod` deploys only from a clean `main`. A stage's secrets are kept in `apps/environment/.alchemy/stages/` (gitignored).
6. Pair a client: from `apps/environment`, `bun scripts/stage.ts run <stage> admin POST "/_t3flare/arm-bootstrap?minutes=15"`, then open `/pair#token=<T3_BOOTSTRAP_TOKEN>` on the stage's URL (the token is in `.alchemy/stages/<stage>.env.json`).
7. Optionally, the nightly bump of t3code's pin (ADR-0017): `bun run --cwd infra ci:setup` creates the `bump` GitHub environment and its Cloudflare token; the key of the model proxy is set on it by hand (see `docs/model-proxy.md`).
8. Optionally, deploy `prod` on every push to `main` ([`.github/workflows/deploy-prod.yml`](.github/workflows/deploy-prod.yml)): after a first deploy from the laptop, `bun run --cwd infra ci:setup` also creates the `prod` GitHub environment (`main` only) with its own Cloudflare token, the values in `dev.env` and the laptop's prod tokens; run it again after rotating any of them.

`bun run check` runs the typechecks, lint and tests.
