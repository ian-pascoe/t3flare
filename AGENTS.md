# t3flare

## Rules

- Run `pnpm run check` before you push a change for review: it is the required `check` on every pull request.
- Test deploys go to a throwaway Stage of your own Deployment, from `apps/environment/scripts/stage.ts`. `prod` belongs to its Deployment repository's CI.
- Credential files stay unread and unprinted: `~/.config/t3flare/dev.env`, `~/.alchemy/**`, `apps/environment/.alchemy/stages/*`, the gh config.
- A Deployment's values (emails, domains, account and zone ids, repository names) stay out of the source: they are Deployment settings ([ADR-0038](docs/adr/0038-a-deployment-is-configured-outside-the-source-tree.md)).
- Never run pnpm or `vp` with a working directory inside `t3code/`: they install it as its own workspace and repoint t3's packages. Run t3 package scripts from the repo root (`pnpm --filter <name> run <script>`); mise exports `NPM_CONFIG_WORKSPACE_DIR` as a guard.
- The workspace and the lock are generated from t3code's: change them with `node scripts/relock.ts`, never by hand ([ADR-0030](docs/adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md)). Relock keeps t3flare's own resolutions; `node scripts/relock.ts --refresh` is the one way to re-resolve them.
- oxlint's type-aware backend is tsrs's `tsrs-lint`, which oxlint finds by itself. An `OXLINT_TSGOLINT_PATH` in your environment overrides it, so unset a stale one ([ADR-0030](docs/adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md)).
- The `t3code` submodule tree stays as pinned. Change t3code behaviour by Layer, then Shadow, then Patch ([ADR-0001](docs/adr/0001-t3code-is-a-pinned-submodule-changed-by-layer-then-shadow-then-patch.md)).
- A failed t3 bump, or a change to code that leans on t3's internals: read [`docs/upstream-fragility.md`](docs/upstream-fragility.md) first.

## Maintainer

These apply only with the Maintainer's access: write access to the Canonical repository, `spiritledsoftware/t3flare`, and its Linear project.

- A pull request squash-merged into the Canonical repository's `main` deploys the Maintainer's `prod` through `.github/workflows/deploy-prod.yml` ([ADR-0039](docs/adr/0039-outside-changes-are-checked-without-secrets-and-a-maintainers-merge-is-the-deploy.md)).
- An in-app Update lands by itself: `land.yml` fast-forwards `main` with a deploy key, whose push starts `deploy-prod.yml` ([ADR-0037](docs/adr/0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md)). Never dispatch `bump.yml` with `land`, `cli-bump.yml` without `dry_run`, or `land.yml` without `dry_run` by hand: each deploys prod.
- Issues are worked in Linear (team SPI, project t3flare); GitHub Issues sync one-way into it. See `docs/agents/issue-tracker.md`.

## Agent skills

### Issue tracker

Contributors use GitHub Issues through `gh`; the Maintainer works them in Linear. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
