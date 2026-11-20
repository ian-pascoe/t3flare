# Upstream is tracked by nightly tag, with an automated bump

Refined by [ADR-0041](0041-a-deployment-follows-one-t3-track-set-as-a-deployment-setting.md): the track a Deployment's
bump follows, stable or nightly, is now a Deployment setting, and the Maintainer's follows stable.

Stock clients and the laptop server update themselves while the cloud is pinned, so version skew is ongoing. The owner runs t3's nightly channel, so we track t3code's nightly tags (`v<version>-nightly.<yyyymmdd>.<run>`, several a day), not stable releases or `main`. A scheduled job pins the newest nightly tag in the submodule, re-applies Shadows and Patches, typechecks, and runs the acceptance test (a headless client pairs, creates a project and opens a thread) against a deployed stage. A bump that fails stays unpinned and is reported, and the cloud keeps the last good tag. A DO SQLite point-in-time bookmark is taken before t3's migrations run, because they only go forward. Version-coupled extras (the Claude ACP adapter that t3's registry expects) move in the same job.

The job is `pnpm run bump` (`scripts/bump.ts`), run nightly by `.github/workflows/bump.yml`: newest tag, submodule, regenerated workspace and lock (seeded from t3's, ADR-0030), the whole `pnpm run check` (`git apply --check`, typecheck, lint and tests), then a deploy of the `bump` stage and the acceptance test against it (pairing, a `/ws` client, turn-item fixtures and t3's heavy queries, the twice-in-one-isolate boot check). Any failure restores the submodule and the generated files, so the pin is unchanged; a pass is pushed as a `bump/<tag>` branch with a pull request for the owner to merge. The point-in-time bookmark belongs to the deploy of a stage that holds real data; the `bump` stage holds only fixtures, so it takes none.

## Considered Options

- **Stable release tags**: fewer bumps, but the owner's clients run nightly, so the cloud would lag the protocol his clients speak.
- **`main`**: untagged commits include ones nightly CI rejected.

## Refinement (in-app updates, ADR-0037, 2026-11-17): land mode, the hourly schedule, and the bookmark

- **Land mode.** `bump.yml` takes `land`, `gate` and `update_id`. A stock client's server Update dispatches it with
  `land: true` and the Update gate (`bump.ts --gate update`); a pass goes to a trusted job that checks it, pushes
  `bump/<tag>` and marks it proven, and the reusable land workflow (`land.yml`) fast-forwards `main` to it with the `land`
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

## Refinement (2026-11-19): what stops failing the bump

Of the 63 bump runs that failed between 11-10 and 11-19, most were not upstream changes that needed porting. They were
differences of configuration, flags waiting to be classified, flakes, or the hourly job running a failure again that
nothing had changed. Four rules now keep those from failing it, or from failing it again:

- **Type errors in t3's own files do not fail the typecheck.** `apps/environment`'s typecheck
  (`scripts/typecheck.ts`) prints them apart and passes. t3 checks them under its own configuration, and this program's
  differs (the DOM lib, other packages' global types). Errors in t3flare's files still fail (fragility U10).
- **A new capability flag is stripped until classified**, instead of failing typecheck (ADR-0023's refinement,
  fragility U4). The report, the pin's commit message and the bump PR name it.
- **The acceptance test runs once more on the Full gate** when it fails. A pass on its second attempt keeps the first
  attempt's failures in the report, and the PR says the pass may be luck. The Update gate does not retry: its run must
  fail within 20 minutes (ADR-0037, D7).
- **The hourly job stops retrying a failure nothing has changed since.** When the two newest hourly attempts tried the
  newest nightly on the current commit of main, and both failed the move, the lock check or `pnpm run check`, the plan
  skips. The install and every later step can fail by chance, so those are retried. A commit on main, a newer nightly
  or a run by hand tries again.

## Refinement (ADR-0038, 2026-11-19): the scheduled bump is per Deployment repository

"The owner" above is the Owner of the Maintainer's Deployment; the bump belongs to a Deployment repository, not to
t3flare as a whole ([ADR-0038](0038-a-deployment-is-configured-outside-the-source-tree.md)).

- **Each Deployment repository runs its own bump, or none.** The hourly bump proposes pins to the `main` of the
  repository it runs in, with that repository's `bump` environment and its own fixture repository
  (`T3FLARE_FIXTURE_REPO`, a Deployment setting with no default). GitHub starts a public fork with its scheduled
  workflows off, so an Owner's fork bumps only once they turn it on.
- **A bump that lands makes the fork diverge.** Its pin commits are its own, so its `main` stops fast-forwarding from
  the Canonical repository's. An Owner who follows the Canonical repository's `main` leaves the bump off, pulls `main`
  and deploys (`docs/deploy.md`, Updating).
