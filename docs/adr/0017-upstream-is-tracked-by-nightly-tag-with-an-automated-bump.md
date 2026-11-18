# Upstream is tracked by nightly tag, with an automated bump

Stock clients and the laptop server update themselves while the cloud is pinned, so version skew is ongoing. The owner runs t3's nightly channel, so we track t3code's nightly tags (`v<version>-nightly.<yyyymmdd>.<run>`, several a day), not stable releases or `main`. A scheduled job pins the newest nightly tag in the submodule, re-applies Shadows and Patches, typechecks, and runs the acceptance test (a headless client pairs, creates a project and opens a thread) against a deployed stage. A bump that fails stays unpinned and is reported, and the cloud keeps the last good tag. A DO SQLite point-in-time bookmark is taken before t3's migrations run, because they only go forward. Version-coupled extras (the Claude ACP adapter that t3's registry expects) move in the same job.

The job is `pnpm run bump` (`scripts/bump.ts`), run nightly by `.github/workflows/bump.yml`: newest tag, submodule, regenerated workspace and lock (seeded from t3's, ADR-0030), the whole `pnpm run check` (`git apply --check`, typecheck, lint and tests), then a deploy of the `bump` stage and the acceptance test against it (pairing, a `/ws` client, turn-item fixtures and t3's heavy queries, the twice-in-one-isolate boot check). Any failure restores the submodule and the generated files, so the pin is unchanged; a pass is pushed as a `bump/<tag>` branch with a pull request for the owner to merge. The point-in-time bookmark belongs to the deploy of a stage that holds real data; the `bump` stage holds only fixtures, so it takes none.

## Considered Options

- **Stable release tags**: fewer bumps, but the owner's clients run nightly, so the cloud would lag the protocol his clients speak.
- **`main`**: untagged commits include ones nightly CI rejected.

## Refinement (in-app updates, ADR-0037, 2026-11-17): land mode, the hourly schedule, and the bookmark

- **Land mode.** `bump.yml` takes `land`, `gate` and `update_id`. A stock client's server Update dispatches it with
  `land: true` and the Update gate (`bump.ts --gate update`); a pass goes to a trusted job that checks it, pushes
  `bump/<tag>` and marks it proven, and the reusable land workflow (`land.yml`) fast-forwards `main` to it with the `prod`
  environment's deploy key `T3FLARE_LAND_DEPLOY_KEY`, whose push deploys prod (ADR-0037 has the trust split and what the checks prove). Everything else stays a
  pull request for the owner to merge. The run is named by `run-name` (`Nightly bump`, `Update <id>`, `Verify <what>`),
  checks out the tip of `main` when it starts, and queues in the `bump` group with `queue: max`.
- **Hourly, with pre-proving.** The schedule is hourly. A trusted first job skips the run when the newest nightly is
  already pinned, or proposed with the Full gate's proof (`t3flare/proven`); otherwise it gets the Full gate and a pull
  request, which closes the older bump pull requests. An Update to a tag proven on top of main skips the bump and only
  lands; one main already pins only deploys. After any landed Update a verify run puts main through the Full gate and
  opens an issue when it does not pass.
- **The bookmark is not taken.** The first paragraph says a DO SQLite point-in-time bookmark is taken before t3's
  migrations run. No code takes one. Recovery from a bad nightly on prod is Safe mode and a revert by the owner; a
  pre-migration bookmark and an admin restore route are a follow-up (plan D15).
