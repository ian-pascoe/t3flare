# Contributing to t3flare

Thanks for your interest. t3flare is one Maintainer's working Deployment, published so others can run their own. Outside
pull requests are welcome; review is careful and can be slow, for the reason under [Merging](#merging).

- **Questions** go to [Discussions, Q&A](https://github.com/spiritledsoftware/t3flare/discussions/categories/q-a).
- **Bugs and feature requests** go to [Issues](https://github.com/spiritledsoftware/t3flare/issues/new/choose).
- **Vulnerabilities** go through private reporting: see [`SECURITY.md`](SECURITY.md).
- A bug in the stock T3 Code clients or in unmodified t3code belongs to
  [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Open an issue first for anything beyond a small fix, so we can agree on the approach before you write it. Read
[`GLOSSARY.md`](GLOSSARY.md) for the terms, and the [ADRs](docs/adr/) that touch the area you are changing. A change that
leans on t3code's internals starts with [`docs/upstream-fragility.md`](docs/upstream-fragility.md).

## Licence

t3flare is [MIT](LICENSE). By opening a pull request you agree that your contribution is licensed under the same MIT
licence (inbound = outbound). There is no CLA and no DCO sign-off.

## Set up

```sh
git clone https://github.com/spiritledsoftware/t3flare.git
cd t3flare
git submodule update --init t3code
mise install                     # Node, pnpm and vp at the versions in mise.toml
pnpm install --frozen-lockfile
pnpm run check
```

Without mise, install Node and pnpm at the versions in `mise.toml` and `export NPM_CONFIG_WORKSPACE_DIR=$PWD` in the
repository's root before running pnpm.

## Rules

The rules in [`AGENTS.md`](AGENTS.md) are written for coding agents, and they apply to people too. The ones that trip
people up most:

- **Never run pnpm or `vp` inside `t3code/`.** It installs t3code as its own workspace and repoints t3's packages. Run
  t3's package scripts from the root: `pnpm --filter <name> run <script>`.
- **The `t3code` submodule stays as pinned.** Change t3code's behaviour by Layer, then Shadow, then Patch
  ([ADR-0001](docs/adr/0001-t3code-is-a-pinned-submodule-changed-by-layer-then-shadow-then-patch.md)).
- **Never edit `pnpm-workspace.yaml` or `pnpm-lock.yaml` by hand.** They are generated from t3code's: change them with
  `node scripts/relock.ts` ([ADR-0030](docs/adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md)).
- **Test deploys go to a throwaway Stage of a Deployment of your own,** through
  [`apps/environment/scripts/stage.ts`](apps/environment/scripts/stage.ts). Deployment settings, and how to deploy, are in
  [`docs/deploy.md`](docs/deploy.md). The stage scripts in `apps/environment/scripts/` write their evidence under
  `.evidence/<name>/`, which git ignores; put the values that decide a change in its pull request.
- **The Workspace image is never published.** Each Owner builds it
  ([ADR-0040](docs/adr/0040-the-workspace-image-is-built-by-each-owner-and-never-published.md)).

## Checks

`pnpm run check` runs the patch, workspace and lock checks, the `node:fs` coverage check (`check:fs`), the typechecks,
lint and tests. It must pass before you open a pull request.

Every pull request runs [`ci.yml`](.github/workflows/ci.yml): `check` (that same command, required to merge) and
`secrets` (a gitleaks scan of the PR's commits). CI gets no secrets and a read-only token, so it never deploys anything
([ADR-0039](docs/adr/0039-outside-changes-are-checked-without-secrets-and-a-maintainers-merge-is-the-deploy.md)). An
outside contributor's runs wait for a Maintainer to approve them.

## Pull requests

- Keep a pull request to one change, and say what it changes and why. If it closes an issue, say which.
- Explain anything you could not test, such as a change only a deployed Stage shows.
- New domain terms go in `GLOSSARY.md`; a decision that is hard to reverse gets an ADR in `docs/adr/`.

### Merging

Pull requests are squash-merged into `main`. Merging to the Canonical repository's `main` deploys the Maintainer's
`prod` (ADR-0039), and outside changes have run no stage gate before that, so a Maintainer reviews every change
before it merges.

## `SPI-####` ids

Comments, ADRs and docs cite ids such as `SPI-1262`. They are the Maintainer's Linear issue ids, kept as written. Linear
is not public, so treat one as a label for a past decision, and read the ADR or the code around it for the reason.
