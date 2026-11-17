# Stock clients' Update buttons land a bump: the DO dispatches CI, which proves and fast-forwards main

Status: accepted (owner, 2026-11-17, after a four-round design interview). Plan:
[`docs/steps/in-app-updates-plan.md`](../steps/in-app-updates-plan.md) (D1–D23). Facts:
[`docs/research/github-actions-dispatch-and-do-deploy.md`](../research/github-actions-dispatch-and-do-deploy.md). Refines
[ADR-0017](0017-upstream-is-tracked-by-nightly-tag-with-an-automated-bump.md) (the bump can land),
[ADR-0023](0023-the-cloud-environment-tells-clients-only-what-it-does.md) (a third classification),
[ADR-0024](0024-host-bound-features-are-refused.md) (provider update is no longer refused on prod) and
[ADR-0013](0013-github-access-through-a-github-app-with-per-repo-tokens.md) (a fourth permission list).

The owner's stock clients run t3's nightly track; the Cloud Environment is pinned. Until now the clients said the cloud
was out of date even when it was not (our build never stamped t3's version: the manifest said `0.1.10`), offered only a
manual update, and the provider cards' update button was refused. Now the stock buttons work, and they do it by asking
CI, never by updating the Environment in place:

1. **The Server version is stamped.** The build reads `git -C t3code describe --tags --exact-match HEAD` and serves
   t3's server manifest with that version (`apps/environment/build.ts`, `serverVersion.ts`), so every reader of
   `packageJson.version` reports the pin; the web client gets it as `APP_VERSION`. Prod deploys only an exact tag.
2. **An Update** is a bump and land requested from a stock client's button, of either kind:
   - the **server Update** (`serverSelfUpdate: "respawn"`, advertised by t3flare, prod only): our `ServerSelfUpdate`
     (`apps/environment/src/updates/selfUpdate.ts`, a Layer in place of t3's) checks the target (an exact nightly,
     strictly newer, no track switch, no staging) and dispatches `bump.yml` with `tag`, `land`, `gate: update` and
     `update_id`;
   - a **CLI update** (the pi CLI, Codex, Claude Code; prod only): the drivers' maintenance capabilities carry a real
     `update`, the command `t3flare-cli-update <cli>`, which t3's `ProviderMaintenanceRunner` runs through the process
     router; the router dispatches `cli-bump.yml` and blocks while it follows the run.
   Pi Durable has no update; it is ours. OpenCode stays manual (its 2.x line is not on npm).
3. **Two gates.** The **Full gate** is the nightly bump's whole suite. The **Update gate** (`bump.ts --gate update`,
   about 5 minutes) keeps relock, the lock check, `pnpm run check`, the `bump` stage deploy and the acceptance test's
   core with one Durable agent turn; a CLI bump's gate is the check, the stage deploy with the new image, and the core
   plus that CLI's sub-test.
4. **Trust: upstream code never holds a writing token.** Only the job that runs the bump (`bump.yml`'s and
   `cli-bump.yml`'s `bump`) runs upstream and dependency code, and its token reads contents and nothing else. It hands
   its one commit to the next job as an artifact: a git bundle and its report. The trusted jobs (`plan`, `publish`,
   `verify-issue`, `land.yml`) run on fresh runners with plain Node and main's own scripts (`scripts/updates-ci.ts`,
   `scripts/land-check.ts`), install nothing but `yaml` at main's locked version for a t3 bump, read the report as
   untrusted input (every field against a strict pattern, a t3 report's tag equal to the requested one), and check the
   commit before they push it as `bump/*`, mark it proven, open its pull request or land it.
5. **What the land check proves** (`land-check.ts`), with the pin taken from the caller's inputs, never the report:
   - the shape: one commit on `origin/main`, only its kind's files (a t3 bump: `t3code`, `package.json`,
     `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `mise.toml`; a CLI bump: the image's pinned files and `clis.ts`), and a
     t3 gitlink equal to the requested tag's commit on t3code's origin. Every other file, the check's own scripts
     included, is therefore main's own;
   - a CLI bump's content: only that CLI's Dockerfile ARG defaults, its `clis.ts` fields and its own package.json
     dependency moved, with values of their shape; then the pin is made again from main's files (the release tarballs
     downloaded and hashed, the npm lock resolved with `--package-lock-only --ignore-scripts`, which runs no package
     code) and the proposal must equal it byte for byte;
   - a t3 bump's content: `package.json` moves only `packageManager` and `engines.node`; in a worktree of the candidate
     with t3code at the tag (data: none of it runs), `gen-workspace.ts --check` regenerates `pnpm-workspace.yaml`,
     those two fields and `mise.toml` from t3code and requires them equal, and `verify-lock.ts` checks the lock's t3
     closures, its one `effect`, the patches and the vendored links. The lock itself is not regenerated: `pnpm install`
     resolves t3flare's own packages against the registry, which is neither deterministic nor free of dependency code.
     The narrowest check instead: every package entry is one main's lock or t3's lock at the tag holds exactly, or a
     plain registry entry (`resolution: {integrity}` alone) whose integrity the npm registry confirms for that
     name@version. Accepted: such an entry is still a version the bump job's resolution chose.
6. **Proof** (`t3flare/proven`). The trusted publish job sets a commit status on the proven commit naming its gate
   (`gate=update` or `gate=full`). Container tokens hold `contents: write` but no `statuses`, so an agent can push a
   `bump/*` branch but cannot mark it proven; the status counts only when GitHub Actions set it. An Update lands a
   branch only with either gate's proof; the hourly bump treats a branch with the Update gate's proof alone as not yet
   proposed, and puts it through the Full gate.
7. **Land** (`land.yml`, reusable by both kinds) runs the land check, fast-forwards `main` with `GITHUB_TOKEN`,
   dispatches `deploy-prod.yml` with `checked_sha` (a `GITHUB_TOKEN` push starts no workflow), and follows that run: its
   conclusion is the Update's. It is idempotent: when main already holds the pin (or a newer one), it pushes nothing and
   deploys main's tip, so a press after a land whose deploy failed recovers, with or without its branch. The server
   Update's plan lands (deploy-only) a tag main already pins; a CLI update sends the version prod runs, and a run that
   finds main's pin newest but prod older deploys. Then it deletes the landed `bump/*` branches (named and parsed in
   one place, `pins.ts`) and dispatches the **verify run**: the Full gate on main, which opens an issue when it does not
   pass for any reason. No automatic revert: migrations only go forward; recovery is Safe mode and a revert by the
   owner.
8. **Pre-proving.** The nightly bump runs hourly, exits before setup when the newest nightly is pinned or proposed, and
   proposes a new one through the Full gate as a pull request (scheduled runs never land; a newer proposal closes the
   older ones). An Update to a tag already proven on top of main skips the bump and only lands.
9. **Queueing.** `bump.yml` and `cli-bump.yml` share the concurrency group `bump` with `queue: max`: runs wait in order,
   none is cancelled for a newer one. Every run checks out the tip of `main` when it starts.
10. **State and outcome.** The Environment DO keeps one record per target (`t3`, one per CLI) in its storage, and finds
   the run by its `run-name` (`Update <id>`, `CLI update <id>`). The same target pressed again joins the run in flight;
   another is refused. A record has failed 60 minutes after its run started (a run waiting its turn in the `bump` group
   is not counted until it starts; 3 hours queued, or 15 minutes unlisted, has failed). A fiber in t3's runtime follows the run while the
   DO is awake (no alarm), and settles lazily at boot and at the next press. Success is the new build booting:
   `prepareTrial` of our `ServiceLauncherClient` reports the update committed when the stored target is the stamped
   version. Failure is `ready` published again with its original `at` and a failed `updateOutcome` naming the failed
   step and the run's URL. Pressing again is the retry.
11. **Credential.** The existing GitHub App, with `actions: write` added to what it asks for, and a fourth permission
   list, `UPDATE_DISPATCH_GITHUB_PERMISSIONS` (`actions: write`, `metadata: read`), minted by the DO for
   `ian-pascoe/t3flare` per dispatch and per poll, then dropped. It never reaches a Container. The update target is set
   on prod only (`T3FLARE_UPDATE_REPO`): a press on any other stage would land on main, which deploys prod.
12. **Authorization** is t3's: `environment:maintain` for the server Update, `providers:manage` for a CLI update. There is
   no MCP tool and no Settings-server door, so Peer links and Durable agents cannot start either. Other t3 paths spawn
   commands a client sets (a custom text generator, setup scripts, the editor), so the process router answers
   `t3flare-cli-update <cli>` only with this isolate's token in the spawn's environment, which only the update
   capability carries and no client sees.

## Considered Options

- **Deploy prod from the bump job.** Rejected: prod's secrets would sit in a job that ran upstream code.
- **Run alchemy inside a DO or a Container.** Rejected: the deploy's credentials and toolchain belong to CI.
- **`boot-service` instead of `respawn`.** Rejected: the client then waits on an accepting `ready` baseline, and an idle
  reset during the update reads as its failure.
- **Override only the descriptor's `serverVersion`.** Rejected: about 20 other readers of the manifest stay wrong.
- **`return_run_details` on the dispatch.** Rejected: the REST reference does not document the request parameter.

## Consequences

- An Update takes about 5 minutes of gate plus the land and prod deploy; a CLI update about 14–18 minutes. Running
  turns are not warned or refused: the restart costs a re-prompt (ADR-0004). A running Container keeps its old CLI until
  it restarts.
- A t3 bump that raises a CLI's minimum fails `check` with "bump the CLI in clis.ts": press that CLI's update first.
- The owner accepts the App's new `actions: write` on its installation, which must include `ian-pascoe/t3flare`.
- What leans on t3 internals is in `docs/upstream-fragility.md` (U7, U87–U90, U92).
- **Couplings to GitHub, not t3** (kept here, as the fragility register is about following t3):
  - `queue: max` on `concurrency` (documented; actionlint does not know the key yet);
  - `run-name` from inputs, read back as a run's `display_title` by the DO (`updates/actions.ts`) and by `land.yml`
    (`gh run list … displayTitle`), and `run_started_at` for a record's window;
  - a `GITHUB_TOKEN` push starts no workflow, so `land.yml` dispatches `deploy-prod.yml`;
  - commit statuses and their `creator`, for the proof;
  - the hourly plan reads t3's tags with `git ls-remote` against `pins.ts`'s tag pattern.
  A change in any of these shows in the trial runs (plan D16) and in an Update that fails to start or report: one whose
  run the DO never finds fails after 15 minutes.
