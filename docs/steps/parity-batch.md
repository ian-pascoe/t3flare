# Parity batch: G7 (review guide), G4 (scratch threads), G12 (webhooks, PR-watch wake), and the W† rows (report)

Date: 2026-11-13. Branch `pbatch`, from `main` at c1b0c9b. Tickets: SPI-998 (G7); G4 and G12 had none. Evidence:
[`parity-batch/`](parity-batch/). Stage harness: `apps/environment/scripts/pbatch.ts`. Throwaway stage `pbatch`, added
to `STAGES`, deployed five times (four for the review guide's Codex run), destroyed at the end. Parity rows:
[`docs/parity.md`](../parity.md). Fragility: [U57](../upstream-fragility.md#u57-scratch-checkouts-codexs-investigation-task-webhooks-origin-and-the-pr-watchs-wake-parity-batch-g7-g4-g12)
(new), U10 and U18 (amended). ADR-0001: counts after the parity batch.

t3code is untouched (pinned at d8f3feff). **Counts: Layers and our own code for G7 and G12; one new Patch for G4
(`0004-scratch-root-is-a-workspace.patch`, one line). Shadows 2 (unchanged), Patches 3 → 4.**

## For the owner

- **Patch 0004 (G4).** t3's No project folder is now `/w/t3-scratch`, a Workspace made on first use. A Layer could
  not do it: `ManagedProjectFolders` is built inside t3's private runtime graph from the one `ServerConfig`, and its
  `baseDir` feeds everything else; a Shadow would freeze 515 lines. If you would rather not carry a fourth Patch,
  revert 6dff6ac and scratch threads go back to M.
- The folder's name is `t3-scratch`, not stock's `scratch`, so a cloned repo named `scratch` cannot become the No
  project by accident (t3's `bootstrap` returns the project already at a root).
- PR-watch wakes cost one boot and one GitHub read per watched pull request every 10 minutes while a watch lasts (t3
  ends a watch when the PR closes or merges, or after 8 failed reads). Stock sweeps every 2 minutes while up; 10 is
  `PR_WATCH_WAKE_MS` in `host/idle.ts`.

## G7: the PR review guide (SPI-998) — PASS

t3's guide (`PullRequestReviewGuideService.checkoutHead`) makes a temporary directory in its worktrees directory
through `FileSystem`, adds a detached worktree there, runs `merge-base` and two `diff`s in it, asks an investigating
text generation to read it, and removes it. What t3 reads through `FileSystem` is only the scratch directory itself
(make, then remove at scope end) and, in `removeWorktree`, `exists` on the checkout after git removed it.

- `agents/scratch.ts` (new): a registry of scratch directories t3 made, bound to a project by t3's
  `worktree add --detach`. `routingFileSystem` answers `makeTempDirectory[Scoped]` in `/w/.wt` with a registered name
  (nothing written) and `remove` of it by forgetting it.
- The router runs t3's `worktree add --detach` and `worktree remove --force` **as written**, in the project's
  Container: the Container sees t3's `/w/…` paths (the process channel binds the repo at `/w/<id>`), so the checkout
  lives at t3's own path on the Container's disk. Git with a cwd in the checkout runs there with `-C`, always as an
  action (never the read cache or stale reads). The repo's `.git/worktrees` is Container-only (`containerOnly.ts`), so
  the checkout's index never syncs into the Workspace DO.
- Codex investigates: our Codex driver's text generation answers `investigate` requests with
  `codex exec --json --ephemeral --skip-git-repo-check -s read-only --model <m> --output-schema <file> -` in the
  checkout's Container (`provider/cli/codexInvestigation.ts`; profile `codexExecLaunch`: the schema copied from the
  State directory, `approval_policy="never"`, no MCP servers). Every other operation keeps the proxy text generation.
- Found on the stage: `spawnCli` never piped a stdin given as a Stream (t3's own `codex exec` call passes its prompt
  that way); Codex waited on stdin until killed. Fixed in `cliProcess.ts`.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit: `test/scratchCheckout.test.ts` — t3's add, `merge-base` in the checkout, remove, each reaching the project's DO as an action with t3's argv; the directory forgotten at scope end; detached worktrees elsewhere and temp dirs elsewhere in `/w` refused; the `codex exec` profile and its refusals; the event parser | pass (7) | |
| Stage: the guide of fixture PR #4 on Codex with `claude-sonnet-5-5`: one stop, an excerpt of `src/sub.sh`, and a question that needed `test.sh` read (the investigation) | **pass** | [`guide.json`](parity-batch/guide.json) |
| Same on Codex with `gpt-6-luna` | **fail**: the proxy refuses Codex's `collaboration.wait_agent` tool in `exec` | SPI-1102 |

Not covered: Claude as the guide's model (t3's "cannot investigate", SPI-1103); Pi Durable answers the same stock
message.

## G4: scratch threads — PASS

Patch 0004 roots t3's scratch probe at `/w/t3-scratch`. `projects.ensureScratch` makes the folder, which the routing
file system turns into a Workspace; each scratch thread gets t3's own folder in it (`existing_worktree`). The Durable
agent's Session now opens in that folder (`OpenInput.cwd`, the Workspace-inner path), not the repo root.
`threadProjectFromScratch` is advertised again.

| Check | Result | Evidence |
| --- | --- | --- |
| No project is `/w/t3-scratch`; a Durable and a Codex scratch thread each wrote `hello.txt` in their own folder; "Turn into project" made a project rooted at the Durable thread's folder and moved the thread | **pass** | [`scratch.json`](parity-batch/scratch.json) |

The Durable agent reports its folder as `/workspace/repo/<folder>` (its own path, as in any Workspace), Codex as
t3's `/w/t3-scratch/<folder>`.

## G12: webhook origin and PR-watch wake — PASS

- `ScheduledTaskWebhookOrigin` answers `https://<T3FLARE_HOST>/api/hooks` (`t3/webhookOrigin.ts`), the route t3
  serves itself; stock's relay URL forwards there.
- `host/idle.ts`: `watchedPullRequests` counts watched links on live threads (the reactor's own read). While any
  exists, the reset's next-due time includes a wake `PR_WATCH_WAKE_MS` (10 min) out, stored in DO storage for the
  alarm (with t3 down, the alarm reads the stored wake; none stored means now). The health route shows `prWatch`.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit: the watch query (archived, deleted, unwatched links excluded) and the wake at reset and alarm; the base URL | pass | `test/host.test.ts`, `test/webhookOrigin.test.ts` |
| A webhook task shows `https://<host>/api/hooks/<task>/<token>`; a POST answers 202, the delivery is recorded and the task runs | **pass** | [`webhook.json`](parity-batch/webhook.json) |
| A thread watches PR #4; the forced reset sets the alarm to the PR-watch wake | **pass** | [`prwatch-start.json`](parity-batch/prwatch-start.json) |
| No client: the alarm booted t3 and the reactor set the watch's `checksAwaitedSince` 2 s after the wake (08:24:36 → 08:24:38, `prwatch-check.json`'s first runs); each later reset re-armed the next wake; a remark posted while asleep woke the thread's agent 2 s after the next wake | **pass** | [`prwatch-check.json`](parity-batch/prwatch-check.json) |

The woken Durable agent (full access) answered the remark by pushing a commit to the fixture PR, as stock t3's watch
asks it to. The PR was closed with the stage.

## W† rows — all W

| Row | Result | Evidence |
| --- | --- | --- |
| Queued messages | **pass**: queued behind an active run, run after it; after a stop the next stays queued until `queue.resume` | [`queue.json`](parity-batch/queue.json) |
| Delete, pin, snooze, tags | **pass**: each read back from t3's shell | [`threads.json`](parity-batch/threads.json) |
| Scheduled tasks through the alarm | **pass**: forced reset, alarm at the task's time, `lastBoot.trigger: alarm`, task `succeeded` | [`schedule.json`](parity-batch/schedule.json) |
| Keybindings | **pass**: upserted, read back, kept across a restart in place, removed | [`keys.json`](parity-batch/keys.json) |
| `/mcp` for outside agents | **pass**: discovery, 401 without a bearer, register, pairing code, token, 71 tools, `t3_project_list`, listed, revoked, 401. Finding: preview, device and html tools are listed (SPI-1104) | [`mcp.json`](parity-batch/mcp.json) |
| More devices, sessions, revoke | **pass**: a second device paired by a link, listed, used `/ws`, revoked and signed out; the first stays | [`devices.json`](parity-batch/devices.json) |
| Browser notifications | **pass for what the Environment provides**: HTTPS, the bundle's `requestPermission`, both sounds served, a finished run on the shell stream. The browser's prompt and toast were not driven | [`notify.json`](parity-batch/notify.json) |
| PR list, detail, checks, comment, review (W†/P) | **pass**, as the App (D2): list, detail, checks, a comment and a comment-only review, read back | [`prs.json`](parity-batch/prs.json) |

## Tickets filed

- SPI-1102: review guide on Codex with `gpt-6-luna`: the proxy refuses `codex exec`'s collaboration tools.
- SPI-1103: review guide on Claude: our ACP driver cannot investigate a checkout.
- SPI-1104: outside agents' `/mcp` lists preview, device and html tools.

## Code review (two axes, run in this session: no sub-agents are available here)

Fixed point `main` (c1b0c9b). Standards: AGENTS.md, ADR-0001, ADR-0030, the fragility register's rules, the smell
baseline. Spec: the task brief and SPI-998.

### Standards

- ADR-0001 order respected: G7 and G12 are Layers and our code; G4's Patch is one line, justified in ADR-0001's new
  counts and U10. No pnpm or `vp` inside `t3code/`; the submodule is clean.
- Fragility: every new coupling to t3 internals is in U57 (the guide's argv, Codex's `exec` flags and `--json` events,
  `ScheduledTaskWebhookOrigin`, the watch's payload path), with its test.
- Possible Duplicated Code (judgement): `processRouter.ts` finds a checkout's scratch directory with a regex
  (`isScratchDir(path.replace(…))`) while `scratch.ts` `bindScratchCheckout` checks the same one-segment shape.
  Left: the router only selects the route; the binding is the check.
- Possible Primitive Obsession (judgement): the scratch registry keys by directory name strings; the module is small
  and owns them.
- `host/admin.ts` now reads `nextDue` with the stored wake (as the alarm does). That display change was made after the
  last deploy and is covered by unit tests only.

### Spec

- G7: "a real detached checkout inside the project's Container, routed by our git routes" — done, with t3's own argv.
  "Check whether t3 reads the scratch path through FileSystem" — it makes and removes the directory and calls
  `exists` on the removed checkout; all three answered. Partial: the guide needs an investigating model; Codex works
  on Anthropic models, not `gpt-6-luna` (SPI-1102), Claude not yet (SPI-1103).
- G4: done by a Patch, recorded for the owner as asked. Scope beyond the letter: the Durable Session's cwd
  (`OpenInput.cwd`), needed for "each thread in its own folder".
- G12: done; interval 10 minutes (C). Scope beyond the letter: the stdin piping fix in `spawnCli` (needed by G7).
- W†: every row now W with evidence; notifications only for the server's part.

Summary: Standards 2 judgement calls, no hard violations; Spec 1 partial (G7's model coverage), ticketed.

## Pass/fail

| Item | Result |
| --- | --- |
| G7 review guide (SPI-998) | PASS (Codex + Anthropic model); gpt-6-luna and Claude ticketed |
| G4 scratch threads | PASS (Patch 0004) |
| G12 webhook origin | PASS |
| G12 PR-watch wake | PASS |
| Queued messages | PASS |
| Delete, pin, snooze, tags | PASS |
| Scheduled tasks through the alarm | PASS |
| Keybindings | PASS |
| `/mcp` for outside agents | PASS (SPI-1104 finding) |
| More devices, sessions | PASS |
| Browser notifications | PASS (server side; client prompt not driven) |
| PR list/detail/checks/comment/review | PASS (as the App) |
| `pnpm run check` | PASS at the branch head |
| Stage `pbatch` destroyed, fixture PR #4 closed | see the last commit |
