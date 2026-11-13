# t3flare

## Rules

- Merging is a fast-forward push to `main`. Every push to `main` deploys prod through `.github/workflows/deploy-prod.yml`, so push only what has passed `pnpm run check`.
- Test deploys on a throwaway stage from `apps/environment/scripts/stage.ts`. Stage `prod` belongs to CI.
- Credential files stay unread and unprinted: `~/.config/t3flare/dev.env`, `~/.alchemy/**`, `apps/environment/.alchemy/stages/*`, the gh config.
- Never run pnpm or `vp` with a working directory inside `t3code/`: they install it as its own workspace and repoint t3's packages. Run t3 package scripts from the repo root (`pnpm --filter <name> run <script>`); mise exports `NPM_CONFIG_WORKSPACE_DIR` as a guard.
- The workspace and the lock are generated from t3code's: change them with `pnpm run relock`, never by hand ([ADR-0030](docs/adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md)).
- The `t3code` submodule tree stays as pinned. Change t3code behaviour by Layer, then Shadow, then Patch ([ADR-0001](docs/adr/0001-t3code-is-a-pinned-submodule-changed-by-layer-then-shadow-then-patch.md)).
- A failed nightly bump, or a change to code that leans on t3's internals: read [`docs/upstream-fragility.md`](docs/upstream-fragility.md) first.

## Agent skills

### Issue tracker

Issues live in Linear (team SPI, project ian-pascoe/t3flare); GitHub Issues are the public intake and sync one-way into it. Reach Linear through Executor's Linear app, falling back to the `linear` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
