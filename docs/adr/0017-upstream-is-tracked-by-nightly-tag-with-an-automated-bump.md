# Upstream is tracked by nightly tag, with an automated bump

Stock clients and the laptop server update themselves while the cloud is pinned, so version skew is ongoing. The owner runs t3's nightly channel, so we track t3code's nightly tags (`v<version>-nightly.<yyyymmdd>.<run>`, several a day), not stable releases or `main`. A scheduled job pins the newest nightly tag in the submodule, re-applies Shadows and Patches, typechecks, and runs the acceptance test (a headless client pairs, creates a project and opens a thread) against a deployed stage. A bump that fails stays unpinned and is reported, and the cloud keeps the last good tag. A DO SQLite point-in-time bookmark is taken before t3's migrations run, because they only go forward. Version-coupled extras (the Claude ACP adapter that t3's registry expects) move in the same job.

The job is `pnpm run bump` (`scripts/bump.ts`), run nightly by `.github/workflows/bump.yml`: newest tag, submodule, regenerated workspace and lock (seeded from t3's, ADR-0030), the whole `pnpm run check` (`git apply --check`, typecheck, lint and tests), then a deploy of the `bump` stage and the acceptance test against it (pairing, a `/ws` client, turn-item fixtures and t3's heavy queries, the twice-in-one-isolate boot check). Any failure restores the submodule and the generated files, so the pin is unchanged; a pass is pushed as a `bump/<tag>` branch with a pull request for the owner to merge. The point-in-time bookmark belongs to the deploy of a stage that holds real data; the `bump` stage holds only fixtures, so it takes none.

## Considered Options

- **Stable release tags**: fewer bumps, but the owner's clients run nightly, so the cloud would lag the protocol his clients speak.
- **`main`**: untagged commits include ones nightly CI rejected.
