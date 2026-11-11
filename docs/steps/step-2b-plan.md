# Step 2b: plan (terminal, setup scripts, worktree Workspaces, deletion and sweep)

Date: 2026-11-11. Branch `step-2b`, from `main` at 590ccd1. t3code pinned at `v0.1.9-nightly.20261111.4515`
(24e7747). `@cloudflare/computer` 0.9.0. cloudpid read at `b8097ff0` (`~/src/cloudpid`, read only).

This is a plan to review, not a report; nothing in it is built yet. Owner decisions and actions are at the end; one
decision is asked, and it does not block the start.

**Exit criterion (from `docs/plan.md`).** A worktree thread provisions and runs its setup script; the terminal works;
deleting the thread frees the Workspace.

**In one paragraph.** t3's own `TerminalManager` and `ProjectSetupScriptRunner` stay stock. We supply the PTY
underneath them: a `PtyAdapter` Layer in the Environment DO whose processes are shells that the Workspace DO starts
in its Container with the platform's `ctx.container.exec` and a PTY. computer has no PTY, so the Workspace DO also
syncs the files for those shells, the way cloudpid's ADR-0012 designed and never built. Setup scripts are terminals
in t3, so they come with the PTY. A worktree is a Workspace of its own, a full clone at `/w/.wt/<project>/<dir>`. The
process router gives t3's `git worktree add`, `list` and `remove` their cloud meaning. Deletion is a small state
machine in the Workspace registry, with a daily sweep, a 7-day grace and a reference check. No new Patch or Shadow
is expected.

## Changelog: the independent review (Fable), and the owner's D1

These override the sections below where they conflict. Each is checked against the code when its milestone reaches it;
a finding found wrong is recorded with its evidence in the report, not followed.

- **D1 (owner):** terminals do not outlive clients (§2.7's default). ADR-0003 is unchanged.
- **F0 (security, M0's first commit).** At our compatibility date `process.env` holds the Worker's string bindings,
  secrets included, and t3 copies `process.env` into terminals (`Manager.ts:1529`) and ACP spawns. Both Workers get
  `nodejs_compat_do_not_populate_process_env`; every runtime read of `process.env` is checked first, and the stage
  must boot and work with it. §2.1's two layers stay (the base env is never `process.env`; the allowlist). M1's leak
  check compares secret *values* inside the DO, not names.
- **F1 (HIGH, M1).** `closeOnSettle` → `closeIdle` closes every running terminal whose inspector reports no
  subprocess, so §2.8's v1 would kill `npm run dev` on settle. Foreground reporting moves into M1: the rc file emits
  `PS0`/`PROMPT_COMMAND` markers that `TerminalHost` strips from the output; the inspector answers from them. The
  same markers drive pull-on-prompt (§2.6) and the release of input buffered during start-up.
- **F2 (HIGH, M1).** `ExecProcess.kill()` after the process exited raises an uncaught internal error in the DO, and
  t3 sends SIGKILL 1 s after SIGTERM unless it saw the exit, which reaches us later by push. Signals go only through
  part 2's marker kill script, never `ExecProcess.kill()`. M0 probes kill and resize after exit.
- **F3 (HIGH, M4).** The sweep fails closed: any read error aborts the whole run (unlike `host/idle.ts`'s `[]`);
  references match by `toWorkspace(path).id`, not path equality (a project may sit in a subdirectory); prod's sweep is
  a dry run unless an env switch turns purging on.
- **F4 (HIGH, M4).** A purged Workspace can be resurrected: Sessions reach the Workspace DO by name, bypassing the
  registry, and `fileOperation` → `ready()` may recreate storage after `deleteAll`. Sessions are destroyed or detached
  before the Workspace; `destroy()` leaves a marker that every RPC except provisioning refuses. Budget holders are hex
  DO ids, so the cost guard compares `idFromName(id).toString()`.
- **F5 (HIGH, M2/M4).** Path reuse: a worktree's directory is deterministic from the branch, and t3 re-creates a
  missing worktree at the same path on the next turn or rollback. `worktree add` on a tombstone restores it; on
  `deleting` it finishes the purge, then provisions; `deleting` rows are retried within minutes.
- **F6 (MEDIUM, M2).** The PR review guide runs `git -c core.hooksPath=/dev/null worktree add --detach --quiet
  <path> <sha>` at `/w/.wt/review-guide-*/checkout` after a temp directory in `worktreesDir`. Supported or refused
  with a clear message; the argv is in `gitRoutes.test.ts`.
- **F7 (MEDIUM, M2).** `--not --remotes` trusts stale remote-tracking refs: the bundle excludes the new clone's actual
  tips, or falls back to a full bundle.
- **F8 (MEDIUM, M4).** Carry-home carries every unreachable `refs/heads/*` and `refs/stash`; if any step cannot run
  (two Containers under a budget of 3), the Workspace is tombstoned and never purged.
- **F9 (MEDIUM, M1).** Sync: `Workspace.pull()` names `CONTAINER_BACKEND`; a sync starts a stopped Container and takes
  a lease, so it is guarded on `ctx.container.running`; serialisation is per block, not per pull; empty pulls back off.
- **F10 (MEDIUM).** Only input resets the 30-minute hold (or an absolute cap), so a noisy terminal cannot hold a
  Container forever. `registerTerminalProcesses` (synthetic pids feed port discovery) and
  `resolveProviderInstanceEnvironment` (may carry credentials, ADR-0016) are omitted from our Layer.
- **F11 (LOW).** The adapter learns that the Workspace DO restarted and lost its handles (an epoch on every answer).
  Every push to `main` restarts the Environment (immediate code update), which kills running setup scripts: documented.

---

## 1. What t3 does today (read in the pinned submodule)

### 1.1 The terminal

- **The seam** is `PtyAdapter` (`packages/shared/src/PtyAdapter.ts`). `spawn({ shell, args, cwd, cols, rows, env })`
  returns an Effect of a `PtyProcess` with a numeric `pid`, a synchronous `write`, `resize` and `kill(signal)`, and
  `onData` and `onExit` callbacks. Ours today fails every spawn (`apps/environment/src/platform/services.ts:27`;
  `composition.ts:419`).
- **`TerminalManager`** (`apps/server/src/terminal/Manager.ts`, 3,500 lines) owns everything above the seam:
  - Sessions are keyed by thread and terminal id, and live in memory.
  - Viewers share one PTY sized to the smallest grid. The client streams I/O over the WebSocket with
    `terminal.attach` (a stream), `terminal.write`, `terminal.resize`, `terminal.clear` and `terminal.close`
    (`ws.ts:3224…`).
  - **Scrollback** is a `BoundedTerminalHistory`: 5,000 lines and 8 MiB in memory. It is written to the State
    directory (`terminalLogsDir`), the whole file every 250 ms while output flows.
  - On **re-attach with `resume`** after a server restart, no session exists. A new shell starts in the same cwd,
    with the old history read back from the file and its terminal modes neutralised (`openWithWorkspaceLease`,
    `:2832`).
  - Kill escalates from SIGTERM to SIGKILL after 1 s.
  - A **subprocess poll** reads a process table every 1 s: t3's native telemetry binary, else
    `ps -eo pid=,ppid=,comm=` through `ProcessRunner`. Quiet sessions are polled every 30 ticks, and failures back off
    to 60 s with a warning each time (`:2636–2800`).
  - **The shell's environment** is `options.env ?? process.env` minus a small blocklist, plus the runtime env
    (`createTerminalSpawnEnv`, `:1356`). The shell comes from `$SHELL` or `bash`, then a candidate list (`:612`).
  - `Manager.make` is a thin wrapper. The exported `makeWithOptions` takes `env`, `ptyAdapter`, `historyLineLimit`,
    `historyByteLimit`, `subprocessInspector`, `processTable` and `maxRetainedInactiveSessions` (`:1404–1514`).
- **A leak to close.** The environment Worker runs `nodejs_compat` at compatibility date 2026-11-01, so workerd fills
  `process.env` with the Worker's string bindings, secrets included. Stock, every terminal would get them.

### 1.2 Setup scripts

- **Where they are defined.** A project's scripts (`project.scripts`), or the settings' `defaultProjectScripts` and
  per-project overrides (`resolveProjectScripts`, `packages/shared/src/projectScripts.ts`). The setup script is the
  one marked `runOnWorktreeCreate`; a settle script is marked `runOnSettle`.
- **When they run.** `ProjectSetupScriptRunner.runForThread` (`apps/server/src/project/ProjectSetupScriptRunner.ts`)
  is called:
  - by `ThreadLaunchService` after it creates a worktree, with stages `fetch → checkout → setup-script → agent` in
    `WorktreeSetupTracker` and the output tail shown;
  - by `WorktreeMcpService` (the agent's own worktree tool);
  - by `GitManager` (`:2875`, a PR thread's worktree);
  - by `ThreadSettlementService` (settle scripts).
- **How they run: in a terminal.** The terminal id is `setup-<scriptId>`, the cwd is the worktree, and the env is
  `T3CODE_PROJECT_ROOT`, `T3CODE_WORKTREE_PATH`, `NO_COLOR=1` and an empty `COLORTERM`.
  - The runner waits for the line editor to enable bracketed paste. If the terminal stays quiet for 3 s and the
    subprocess poll says it is not busy, it goes ahead anyway.
  - It types the command wrapped as `( cmd ); printf '\n__T3_SETUP_DONE__<token>:%s\n' "$?"`, and reads the exit
    code from the output.
  - It closes the terminal with `closeIdle` on success.
  - The script is `async` by default: a failure marks the stage, and a non-async failure fails the launch ("Setup
    script exited with N").
- So setup scripts need nothing of their own beyond a working PTY, the right paths and the right env.

### 1.3 Worktrees

- **Creation.** `GitVcsDriverCore.createWorktree` (`:4250`) puts a worktree at
  `<worktreesDir>/<basename(project cwd)>/<branch prefix ≤23 bytes>-<16 hex>`. `worktreesDir` comes from
  `ServerConfig`, or from Settings → Worktrees when the owner sets a location.
  - It first runs `git branch` in the project (`createBranchAt`), then
    `git -c checkout.workers=0 worktree add -- <path> <ref>`.
  - It then reads `<path>/.gitmodules` and `<path>/t3.json` through `FileSystem`.
  - `isManagedWorktreePath` (`worktreesDirectory.ts`) accepts only paths exactly two segments below a managed root.
- **Removal** is `git -c status.showUntrackedFiles=normal worktree remove [--force] -- <path>`, with the project as
  cwd.
  - The `removeLeftoverLinks`/`removeEmptyDirectory` cleanup (synchronous `node:fs`, flagged in step 2a's audit) runs
    only if the path still exists afterwards.
  - "Already gone" plus a missing path becomes `git worktree prune`.
  - Listing is `git worktree list --porcelain -z` (`listWorktreePaths`).
- **The fast checkout cache** (`worktreeCheckoutCache.ts`, `node:fs` in step 2a's audit) is used only when the
  setting `fastWorktreeCheckout` is on. Our descriptor strips that capability.

### 1.4 Deletion and archival

- **Deleting a thread.** The client (`apps/web/src/hooks/useThreadActions.ts:495–690`):
  1. asks the server which threads occupy the worktree;
  2. if this is the last thread, asks "Delete the worktree too?", or applies the setting `worktreeOnDelete` instead;
  3. stops the session, deletes the thread, then calls `vcs.removeWorktree({ cwd: project root, path, force: true })`.
  - The server closes the thread's terminals with their history (`ResourceCleanupService`).
  - `ThreadLaunchService`'s cancel path removes a worktree that its thread still names, then clears the thread's
    `worktreePath`.
- **Archiving a project** keeps "threads and files" (`ProjectUpdatePayload.archived`, `packages/contracts/src/project.ts`).
- **Deleting a project** deletes its threads and never touches files (`ProjectService.delete`).
- **t3's own `StorageCleanup`** (`storageCleanup.ts`) sweeps worktrees hourly by policy (age, merged, on delete,
  unchanged). Every policy is off by default.

### 1.5 What the platform and computer offer

- **computer 0.9.0 has no PTY.** Its exec takes a one-shot stdin (`WorkspaceRuntimeExecOptions`). It syncs files
  only around its own commands: a push before, a pull after. It does expose `Workspace.pull()` and `push()`.
- **The platform's Durable Object Container API has a PTY.** `ctx.container.exec(argv, { pty: { cols, rows }, stdin:
  "pipe", env, cwd, user })` returns an `ExecProcess` with a stdin `WritableStream`, a stdout stream, `pid`,
  `resize()`, `kill()` and `exitCode` (`@cloudflare/workers-types` `ContainerExecOptions`).
  - It does not start a stopped Container.
  - The process gets only the env it is given, plus `PATH`.
- **cloudpid's ADR-0012** chose exactly this, with the Workspace DO syncing for the shells: pull after 1 s of quiet
  output (at most every 2 s) and when a shell exits; push the DO's writes at most every 2 s; pull before an idle
  stop. cloudpid has not built it, so there is no code to copy, only the design and `notify.ts`'s use of
  `container.exec`.

---

## 2. The terminal

### 2.1 Shape

```
client ⇄ /ws ⇄ Environment DO: TerminalManager (stock code, our Layer) → PtyAdapter (ours)
                       ⇅ DO RPC (input, resize, kill, heartbeat ↓ · output, exit ↑ pushed)
         Workspace DO: TerminalHost (ours) → ctx.container.exec([...], { pty }) → bash in the Container
```

- **`TerminalManager` Layer (ours).** We restate `Manager.make`'s 30 lines as our Layer and call the exported
  `makeWithOptions` with these options:
  - `env`: a fixed base (`TERM=xterm-256color`, `LANG=C.UTF-8`, `SHELL=/bin/bash`), never `process.env`. This closes
    the leak in §1.1 at its source.
  - `ptyAdapter`: ours.
  - `subprocessInspector`: ours (§2.8), so t3 never spawns `ps`.
  - `historyByteLimit`: 1 MiB, and `maxRetainedInactiveSessions`: 16, so scrollback fits the 128 MB isolate.
  - The rest as `make` does: logs directory, port discovery, provider-instance env.

  This is a Layer, not a Shadow, and `TerminalManager.layer` is no longer used.
- **`PtyAdapter` Layer (ours, `apps/environment/src/terminal/`).**
  - **Paths.** `spawn` finds the Workspace of `cwd` (`locate`; an unlisted path fails as `ENOENT`, so t3 tries the
    next shell and then reports the error). It accepts `bash`, `/bin/bash`, `sh` and `/bin/sh`, and fails
    `zsh`/`fish` as not found, so t3 falls through to bash.
  - **Env.** It filters `env` through an allowlist as defence in depth: `TERM`, `COLORTERM`, `LANG`, `LC_*`,
    `NO_COLOR`, `FORCE_COLOR`, `T3CODE_*`, and the keys a provider instance adds that are not in the base. Anything
    named like a credential (`*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`) is dropped and logged by name.
  - **Process.** It returns a `PtyProcess` at once with a synthetic, unique `pid`. The real Container pid stays in
    the Workspace DO: pids of two Containers can collide.
- **`TerminalHost` (ours, in `WorkspaceDO`).** It holds each terminal's `ExecProcess` in memory, keyed by a terminal
  key (hash of Environment, thread and terminal id). It runs the shell through a wrapper script shipped with the
  agents Worker, as part 2's `kill.ts` is (`apps/sandbox-image/src/terminal.ts`), run with `bash -c`, so no image
  rebuild is needed.

### 2.2 Transport: pushed, nothing held open (as ADR-0005)

- **Output, Workspace → Environment.** The Workspace DO reads each shell's stdout and pushes batches to the
  Environment DO with one RPC, `terminalOutput({ workspace, frames })`.
  - A batch closes after 16 ms or 32 KiB. A frame carries the key, a sequence number, bytes or an exit.
  - One push is in flight per Workspace. While it is, the Workspace DO stops reading stdout beyond 1 MiB buffered, so
    a flood blocks the shell as a real terminal does instead of growing memory.
- **Input, Environment → Workspace.** `write` appends to a per-terminal queue that flushes in a microtask, one
  `terminalWrite` RPC in flight per terminal, so keystrokes keep their order. `resize` and `kill` are separate RPCs.
- **Liveness.**
  - The adapter sends one `terminalHeartbeat(keys)` per Workspace every 30 s. A terminal without one for 90 s is
    killed: its Environment is gone.
  - The push's answer lists keys the Environment does not know (it restarted), and those are killed at once.
- **Pushes are not activity.** `terminalOutput` never boots t3, and it is excepted from the idle host's "request in
  flight", as admin routes are (ADR-0003). A chatty shell with no client therefore cannot keep the Environment awake.
- **Why push, not a returned stream.** ADR-0005 avoids held connections: they pin the Environment DO and count
  against the 6 simultaneous outgoing connections. M0 still measures a streamed RPC beside it. If push loses badly on
  latency, the stream is the fallback, with one multiplexed stream per Workspace (at most 3, the Container budget).

### 2.3 Opening a terminal, and a stopped Container

Opening a terminal is a user action, like opening a diff (ADR-0009), so it may start the Container.

- `terminalOpen` in the Workspace DO:
  1. runs a no-op computer command on the Container backend, which takes the budget lease, starts the Container
     (about 17–18 s cold), runs computer's bootstrap and pushes the DO's pending writes;
  2. runs `ctx.container.exec(["bash", "-c", terminalCommand(...)], { pty: { cols, rows }, stdin: "pipe", env })`.
- While the Container starts, the Workspace DO pushes one dim status line ("Starting the Workspace's Container…"). The
  adapter buffers keystrokes until the shell is up. A setup script's command typed during start-up is therefore
  delivered to the shell, not lost, and bash reads it once readline starts.
- **A refused start** (the budget's 3 Containers, or an image failure) prints the reason in the terminal and exits
  with code 1. t3 shows "exited" and offers a restart, and the reason stays in the scrollback.

### 2.4 cwd, paths and environment

- **The wrapper** (`terminalCommand({ id, parent, cwd })`):
  1. bind-mounts `/workspace/repo` at the Workspace's t3 path, `/w/<id>`. M0 of step 2a showed `mount --bind` works
     there ("link: bind"); the wrapper falls back to a symlink. t3's cwd `/w/<id>/sub`, `$T3CODE_WORKTREE_PATH`,
     `pwd` and git's paths are then the same strings in the terminal as in t3.
  2. In a worktree Workspace, also links `/w/<project>` to the project-root view (§4.2).
  3. Exports the marker `T3FLARE_EXEC=term:<key>`, so part 2's kill script finds the terminal's processes.
  4. `cd`s to the cwd and runs `exec bash --rcfile <rc> -i`.
- **The rc file** (written by the wrapper):
  - unsets `BASH_ENV`;
  - runs `eval "$(mise activate bash)"` with the image's mise config (`COMMAND_ENV`, `containerEnv`), so the
    terminal sees the same toolchains as the agent's `bash`;
  - sets a short prompt;
  - keeps bash's history in `/workspace/.t3flare/terminal/history`, which is synced, so it survives Container
    restarts.
- **Env** is `COMMAND_ENV` without `BASH_ENV`, plus the allowlisted runtime env, plus the marker. `ctx.container.exec`
  passes only `PATH` besides what it is given.
- **Git credentials.** `git push` in the terminal uses the repo's credential helper, which asks the Workspace DO
  through computer's egress host, as the agent's git does (ADR-0013). M1 proves this from a PTY process.

### 2.5 Resize, kill, exit, scrollback and reconnect

- **Resize.** `resize(cols, rows)` becomes `ExecProcess.resize`. t3 already shares one grid among viewers.
- **Kill.** `kill(SIGTERM|SIGKILL)` becomes `ExecProcess.kill(signo)`. After the shell exits, `killExecs(["term:<key>"])`
  sends SIGHUP and then SIGKILL to what the terminal left in its session (part 2's script, with the group rule).
  Processes that detached and cleared the marker are left to the Container's idle stop.
- **Exit.** `exitCode` becomes `onExit({ exitCode, signal: null })`.
- **Scrollback** is t3's: in memory up to 1 MiB, and persisted to the State directory, which is DO SQLite.
- **Reconnect.**
  - *After a client drops, the Environment still up:* stock re-attach to the live PTY, snapshot plus live output.
  - *After an Environment restart* (deploy, idle reset, eviction): t3's own behaviour. The client re-attaches with
    `resume`, and a new shell starts in the same cwd with the old scrollback, as on a laptop after a server restart.
    The old shell was killed by the heartbeat or the push's answer, so it never lingers. This matches ADR-0004:
    a restart costs the live process, never the history.

### 2.6 Files: the Workspace DO syncs for the shells

computer syncs only around its own commands, so for terminals the Workspace DO syncs explicitly, following cloudpid's
ADR-0012:

- **Pull** (`Workspace.pull()`, serialised with computer's own syncs):
  - 1 s after a terminal's output goes quiet, at most every 2 s;
  - when a shell exits;
  - before the idle stop.

  A `git commit` typed in the terminal thus reaches the DO's change log. t3's status, the read cache and the write
  journal (ADR-0009) see it within about 2 s, and checkpoints include it.
- **Push** (`Workspace.push()`): while a terminal is open, the DO's change-log revision is checked every 2 s, and a
  change is pushed. An agent's edit or a client edit therefore reaches `cat` in the terminal within about 2 s.
- **Conflicts** follow computer's rule: when both sides changed a file between syncs, the Container's write wins.
  A shell's writes not yet pulled are lost only if the Container dies outright; the idle stop pulls first.
- Inotify-based watchers in the Container do not hear DO-side writes. cloudpid's `notify.ts` solves that; it is
  deferred.

### 2.7 The Container's lifetime, and cost guardrails

- **Terminals hold the Container while used.** A terminal's input or output counts as Container use, throttled to one
  update per 10 s. The alarm stops the Container when no command runs, the last use is older than 2 min, and no
  terminal has had I/O for `TERMINAL_IDLE_MS` (30 min; an env override shortens it on the stage). An idle prompt
  therefore keeps the Container at most 30 minutes. The stop pulls first, and the shells end with the Container: t3
  shows "exited", and re-opening starts it again.
- **Terminals end with their Environment.** ADR-0003's keep-awake set is unchanged:
  1. the last client disconnects;
  2. 60 s later the Environment resets;
  3. within about 90 s the heartbeat lapses and the shells are killed;
  4. 2 minutes later the Container stops.

  So closing every client costs at most about 4 minutes of Container time. This differs from a laptop, where a
  `npm run dev` left in t3's terminal survives closing the window; owner decision D1 asks whether that is wanted.
- **The 3-Container budget is unchanged.** A refusal is visible in the terminal (§2.3).
- **At most 8 terminals per Workspace**, as the Workspace DO's in-memory handles. The ninth fails with a message.
- **Deploys reach a Workspace DO only when its Container stops** (step 2a), and terminals can hold the Container for up
  to 30 minutes. Every evidence run stops Containers first (admin `workspace-stop`).

### 2.8 Subprocess information

- t3 uses `hasRunningSubprocess` for:
  - the terminal's activity label;
  - `closeIdle`, which closes a setup terminal only when it is idle;
  - the setup runner's "busy" check during start-up;
  - `StorageCleanup`'s protection of worktrees with running terminals.
- **v1 (M1):** our `subprocessInspector` answers from memory, and says a shell has no running subprocess. Consequences:
  - no activity label;
  - `closeIdle` after a successful setup script closes it, which is right, since the command has finished;
  - the runner relies on bracketed paste, which bash 5 emits.
- **Optional (M5, if time):** the wrapper starts a sidecar that reports the PTY's foreground process group when it
  changes (`ps -o tpgid=`). The Workspace DO forwards it as a frame, and the inspector answers from it, still without
  an RPC per poll.

### 2.9 Not in 2b

The terminal is not an agent tool (the Durable agent keeps `bash`). Port previews from terminal processes (t3's
`PortDiscovery`, `PreviewManager`) are not built. Inotify signals for DO-side writes are not built.

---

## 3. Worktree Workspaces (ADR-0008)

### 3.1 The address

- `ServerConfig.worktreesDir` is `/w/.wt`. This is our config, a Layer. t3 then places a worktree of project
  `/w/<p>` at `/w/.wt/<p>/<dir>`, two segments below the root as `isManagedWorktreePath` requires. The path cannot
  collide with a project: `.wt` is not a valid Workspace id.
- **The Workspace id is its path below `/w`**: `<p>` for a project, `.wt/<p>/<dir>` for a worktree.
  - `toWorkspace` learns the second form. `/w/${id}` stays correct everywhere, including `adapter.ts:148`,
    `permissions.ts:228` and `fromWorkspaceText`, and the DO name is the id.
  - `isWorkspaceId` keeps its grammar for projects. Worktree ids accept a `<dir>` that is one safe path segment
    (no `/`, NUL, `.`, `..`; at most 100 bytes), because t3 builds `<dir>` from any branch name.
- **The file system.** `/w` lists projects only. The routing file system answers `/w/.wt` and `/w/.wt/<p>` as
  directories listed from the registry, so t3's `realPath` walks and `StorageCleanup`'s listing work.
- **A worktree location outside `/w/.wt`.** If the owner sets one in Settings → Worktrees, the router refuses
  `worktree add` there: `fatal: t3flare: worktrees live under /w/.wt in the Cloud Environment; clear Settings →
  Worktrees → Location`. The router keeps refusing nested destinations for a clone (step 2a). For a worktree it
  accepts only `/w/.wt/<cwd's own project id>/<one segment>`.

### 3.2 Separate clones, not git worktrees

ADR-0008 already decided this ("a `worktree` thread gets its own Workspace"; "One Workspace with git worktrees inside:
cloudpid tried and superseded it"). cloudpid's ADR-0016 gives the reasons: git's locks do not hold across computer's
sync, the Worker Shell's isomorphic-git does not follow `commondir`, and processes and ports collide. So each
worktree Workspace is its own Workspace DO, its own **full clone** in its own file system, and its own Container.

**Provisioning: the router's `git worktree add -- <path> <ref>`** (cwd: the project). t3 has already made `<ref>` in
the project with `git branch`, an action that starts the project's Container.

1. Check the destination (§3.1). Register `.wt/<p>/<dir>` as `provisioning`, of kind `worktree`, with the project as
   `parent`, the `ref` and the parent's remote fields, so its Container token names the same repo. An existing id
   answers git's own "already exists".
2. **In the project's Container:**
   - resolve `<ref>` to a commit;
   - write `git bundle create /workspace/.t3flare/tmp/wt-<hash>.bundle <ref> --not --remotes`, which holds only the
     commits the remote does not have; none is written when it would be empty;
   - with no remote (a New project), bundle `<ref>`'s whole history;
   - read `git config --get-regexp '^branch\.<ref>\.'`.

   computer's pull after the command brings the bundle into the project DO.
3. **The new Workspace DO's `provisionWorktree(...)`:**
   - reads the bundle straight from the project's Workspace DO, one DO calling the other in the agents Worker,
     streamed in chunks and never through the Environment;
   - in its own Container: clones the remote with the Container token (`--no-checkout`), or runs `git init` with no
     remote; fetches the bundle; runs `git checkout -B <ref> <commit>`;
   - sets the identity, the credential helper and the copied `branch.<ref>.*` config;
   - checks that `HEAD` is the commit;
   - fills the project-root view (§4.2) from the project DO's files.
4. Mark the Workspace `ready` and answer git's usual output (`Preparing worktree (new branch '<ref>')`, exit 0).

On any failure, the Workspace goes to `deleting` (§5) and the answer is git's failure with the reason. t3 then deletes
the branch it made and reports the failed stage.

**Cost.** A worktree costs one clone: about 33 s per 9,000 files of sync into its DO (step 2a, cloudpid #170), plus a
Container start. t3 shows the `checkout` stage meanwhile. t3's checkout-progress percentages arrive only at the end,
because the router answers with all stderr at once. Spare Workspaces stay deferred (`docs/plan.md`); cloudpid's
`spare.ts` is the design to take when creation time matters.

### 3.3 What is shared and what is not

- **Shared:** the remote, the GitHub App scoping (the same repo, the `workflows` opt-in copied from the parent at
  creation), the image and its toolchains.
- **Not shared:** objects, refs, the index, files, processes, ports.
- **Branches move between Workspaces through the remote, or at removal.**
  - **Removal carries the branch home.** If the worktree's branch tip is not in the project's repo, and the project's
    branch of that name is an ancestor of it, the tip is bundled back and fast-forwards the project's branch. Without
    a fast-forward it goes to `refs/t3flare/worktrees/<dir>/<branch>`. Committed work then survives removal, as it
    does with a real git worktree (the branch lives in the shared repo).
  - **Uncommitted work under `--force`** is not lost silently: see the tombstone in §5.
- **`git worktree list --porcelain -z` in the project** is answered from the registry: one record per `ready` worktree
  of that parent, with `HEAD` and `branch` read by the worktree DO's isomorphic-git without its Container, then the
  project's own real entry. t3's branch list therefore shows which branches are checked out in worktrees, and
  `StorageCleanup` sees them.
- **What does not carry over:** the project's own copy of the worktree branch does not advance while the worktree
  lives. Checking that branch out in the project shows the old tip until the worktree is removed or pushed. This is
  documented, and recorded in ADR-0008's refinement.

### 3.4 Consequences for git-dir, object store, checkpoints and stale reads

- Each worktree Workspace has a real `.git` directory at `/workspace/repo/.git`, not a `.git` file with
  `gitdir:`/`commondir`. The Workspace DO's isomorphic-git code (`gitRepo.ts`, `staleReads.ts`, `readCache.ts`,
  checkpoints, the write journal) therefore works unchanged per Workspace. This is the main reason for clones over
  linked worktrees.
- The guard (2,000 tracked files, 16 MB of packs; ADR-0014) applies per Workspace. Above it, captures alias or run in
  that Workspace's Container, as today.
- **Full clones, not partial or shallow.** A partial clone (`--filter=blob:none`) would leave promisor blobs that
  isomorphic-git cannot read in the DO, which breaks DO checkpoints and stale patches. A shallow clone breaks
  merge-base reads.
- **Storage:** each worktree holds a full copy of the objects in its DO's SQLite. Bounding that is the sweep's job
  (§5). t3's checkpoint refs (`refs/t3/checkpoints/…`) live in each Workspace's own repo and go with it.
- **The first passive reads** of a fresh worktree run real git: the Container is still up from provisioning. They
  seed the read cache, so stale reads work after the idle stop.
- `rev-parse --git-common-dir` in a worktree answers its own `.git`. t3 keys only config locks and caches by it, and
  M2's router trace looks for any other use.

### 3.5 Router and registry changes

| t3's argv (cwd) | Router |
|---|---|
| `clone … <name>` (`/w`) | as step 2a; nested destinations still refused |
| `worktree add -- <path> <ref>` (project) | provisioning above; any other destination refused with the message in §3.1 |
| `worktree list --porcelain [-z]` (project) | emulated, passive: registry plus each worktree DO's HEAD and branch; never starts a Container |
| `worktree list` (a worktree) | that Workspace's real answer (a single entry) |
| `[-c …] worktree remove [--force] -- <path>` (project) | the removal in §5.3; an unknown path answers git's "is not a working tree", which t3 treats as already gone |
| `worktree prune` (project) | success, no-op; the registry has no stale links |
| `worktree move`, `lock`, `repair` | refused with a message (t3 does not use them) |

**Registry (`t3flare_workspaces`).** New columns, added idempotently:

| Column | Meaning |
|---|---|
| `kind` | `project` or `worktree` |
| `parent` | the project Workspace of a worktree |
| `branch` | the worktree's branch |
| `unreferenced_since` | when the sweep first found nothing referencing it (§5) |
| `deleted_at`, `purge_after` | set by a removal or a tombstone |
| `last_error` | the last failure, for the admin listing |

`state` gains `deleting` and `tombstoned`. Only `ready` (and `provisioning`, for the provisioning steps themselves)
resolves for t3's paths, the router, the file system and the Session. Every other state is "No such file or
directory", so a removed Workspace disappears for t3 at once.

### 3.6 The other worktree paths in t3

- **`WorktreeMcpService`, `GitManager`'s PR threads, `PullRequestReviewGuideService`'s review checkouts** use the
  same `createWorktree`/`removeWorktree`, so the same router verbs.
- **`fastWorktreeCheckout`:** the capability is stripped, and our seeded settings pin it off. M2 checks it cannot be
  turned on from the client; if it can, the router refuses the cache's commands and t3 falls back to `worktree add`.
- **`StorageCleanup`** works through `worktree list` and `worktree remove`, so the owner's policies apply to cloud
  worktrees as on a laptop. The "merged" rule fetches, which starts Containers hourly; the docs warn against turning
  it on.

---

## 4. Setup scripts

### 4.1 Running them

Nothing of t3's changes: `ProjectSetupScriptRunner` opens terminal `setup-<id>` in the worktree, types the wrapped
command and reads the sentinel. It runs in the worktree Workspace's Container through §2's PTY. `WorktreeSetupTracker`
shows the stages, the output tail (`onOutputLine`, cleaned of control codes), and a link to the setup terminal; the
client can attach to it live.

| Case | What t3 shows |
|---|---|
| Script succeeds | `setup-script` done; the terminal closes (`closeIdle`) |
| Script fails, `async` (the default) | the stage fails with its exit code; the agent already runs |
| Script fails, not `async` | the launch fails: "Setup script exited with N." |
| The Container cannot start (budget) | the reason in the setup terminal; exit without a sentinel, so "no exit code" |
| The Environment restarts mid-script | the shell is killed (§2.5); the setup run was in t3's memory, so the stage ends as t3 ends it after a server restart; the setup terminal's scrollback is kept |
| A thread from a below-full-access Peer link | skipped by t3 (`skipped-for-link`) |

Settle scripts (`runOnSettle`) take the same path with `trigger: "settle"`.

### 4.2 Paths and the project-root view

- The script's cwd and `T3CODE_WORKTREE_PATH` are `/w/.wt/<p>/<dir>`, which is the bind-mounted repo in the
  worktree's Container (§2.4).
- `T3CODE_PROJECT_ROOT` is `/w/<p>`, the project, whose files are in another Workspace. The commonest setup script
  (`cp "$T3CODE_PROJECT_ROOT/.env" .`) copies files git does not track. So at provisioning:
  - the worktree DO copies the project's **untracked files, gitignored ones included**, outside the Container-only
    paths (`CONTAINER_IGNORE`), into `/workspace/.t3flare/project-root/`;
  - the copy is capped at 1,000 files and 20 MB, and the cap is logged;
  - the wrapper links `/w/<p>` to it in the worktree's Container.
- Tracked files are not copied: the worktree has them at its own commit. A script that reads a tracked file through
  `$T3CODE_PROJECT_ROOT` gets "No such file". This is documented, with the copy's contents listed in the setup
  terminal's first line.
- The project's files are read from its DO, so the project's Container does not need to run for this.

---

## 5. Deletion and sweep

### 5.1 States

```
provisioning ─ok→ ready ─removed, nothing to lose→ deleting → (gone)
     │              │  └─removed, uncommitted work→ tombstoned ─grace→ deleting
     └─failed→ deleting      └─unreferenced 7 days (sweep)→ deleting
```

### 5.2 What references a Workspace

The sweep never purges a Workspace that any of these references:

1. a project not deleted (archived included) whose `workspaceRoot` is its path;
2. a thread not deleted (archived included) whose `worktreePath` is its path, or whose project's root is its path;
3. a Session turn running in it (the Session's `workspaceId`, and the Environment's open runs);
4. a terminal open in it (`TerminalHost` keys);
5. a removal or provisioning in progress (state `provisioning` less than 1 h old).

(1) and (2) are read from t3's projection tables by SQL, as `host/idle.ts` already reads them, plus a check in the
acceptance test so a bump that renames them fails loudly. (3) and (4) are asked of the agents Worker.

### 5.3 Triggers

| Event | Action |
|---|---|
| t3's `git worktree remove [--force]` (client delete with "Delete the worktree too?", `worktreeOnDelete`, `StorageCleanup`, launch cancel, MCP) | Leave `ready` at once: t3 sees the path gone. Kill its terminals. Ask its Session to abort a running turn (part 2's kill). Carry the branch home (§3.3). If the tree is clean, purge now (§5.4). If it has uncommitted changes and `--force`, tombstone for 7 days. Without `--force`, refuse with git's own "contains modified or untracked files, use --force". |
| `thread.deleted` (t3 domain event) whose worktree no other live thread names | Stop its Container. Record `unreferenced_since`. The sweep purges it after the grace unless a removal comes first. |
| `project.deleted` | Stop the Containers of the project and its worktrees. Same unreferenced path. Re-adding `/w/<p>` within the grace makes it referenced again: a project deleted by mistake keeps its files for 7 days. |
| `project.updated` with `archived: true` | Stop the Containers of the project and its worktrees. Files stay, as t3's contract says. |
| `thread.archived` | Stop the worktree's Container if no other live thread uses it. |
| Daily sweep (§5.5) | Purge what is due. |

The events are observed by a small Layer of ours in the Environment DO, subscribed to t3's domain event stream as
`StorageCleanup` is. It is a reactor, not a Patch.

**The launch-cancel case.** t3 removes a worktree that the thread still names, then clears the name. An explicit
`git worktree remove` is honoured even when referenced: on a laptop t3 owns that call, and the work is protected by
the carry and the tombstone, not by refusing. The strict reference rule binds the sweep, which acts on its own.

### 5.4 Purge (ordered, idempotent, registry last)

1. Registry → `deleting` (in one Environment DO turn, after re-checking §5.2 for a sweep purge).
2. The Workspace DO's new `destroy()`:
   - kill terminals;
   - stop the Container (`ctx.container.destroy()`);
   - release the budget lease;
   - delete the alarm;
   - `ctx.storage.deleteAll()`, which takes computer's file system, the read cache and the change log with it;
   - `ctx.abort()`, so no in-memory computer state outlives the storage.
3. Delete the Session DOs of deleted threads that worked in it (a new `destroy()`: abort, part 2's kill, delete the
   alarm, `deleteAll`).
4. Delete the registry row.

A crash at any step leaves the row in `deleting`, and the sweep drives it again. The registry stays the only index:
DO instances cannot be listed, so the row goes last. An id without a row never reaches a DO (step 2a's rule), so a
purged Workspace cannot be woken by a stale client.

### 5.5 The sweep

- **When.** Daily, through the Environment DO's one alarm: "next sweep" joins the due times in `idle.ts`'s `nextDue`
  (ADR-0003). It also runs after a removal and from an admin route. `T3FLARE_SWEEP_GRACE_MS` shortens the grace on
  the stage.
- **What it does.**
  - Records or clears `unreferenced_since` per row.
  - Purges rows unreferenced for 7 days, `tombstoned` past `purge_after`, `deleting`, and `provisioning`/`failed`
    rows older than 1 h.
  - Purges Session DOs of threads deleted more than 7 days ago (ADR-0008: "deletes unreferenced Workspaces and
    Sessions").
- **The cost guard.** It reads the `ContainerBudget`'s leases and stops any Container whose holder is not a `ready`
  Workspace. Containers already bound themselves (the idle stop, the 30-minute terminal hold, leases that expire after
  10 minutes unrenewed); this catches a holder the registry no longer knows.
- **What it never does.** It never deletes a GitHub branch (ADR-0008). It never purges a referenced Workspace. It
  never acts on a Workspace it cannot read: an agents Worker error skips it, logged.
- **Report.** `GET /_t3flare/agents/sweep?dry=1` returns what it would do, with reasons. The last run's report is
  kept for the admin listing.

### 5.6 Admin routes

- `agents/workspaces` gains the state, kind, parent, references and dates.
- New:
  - `agents/sweep[?dry=1]`;
  - `agents/workspace-purge?id=` (refused while referenced unless `force=1`);
  - `agents/workspace-restore?id=` (a tombstone back to `ready`).
- Step 2a's `workspace-remove` (which dropped the row and left the DO's files) becomes a purge, so it no longer leaks
  storage. The Workspaces it orphaned during step 2a were on destroyed stages, so nothing on `prod` is known to have
  leaked.

---

## 6. Sub-milestones

All run on a throwaway stage **`step2b`**, added to `STAGES` in `apps/environment/scripts/stage.ts` when
implementing (not in this plan's commit), and destroyed at the end. `prod` is never deployed, run against or
destroyed.

- Evidence goes to `docs/steps/step-2b/`: the scripts' own JSON and screenshots. Never a token, and never a value from
  `process.env`: key names only.
- Each milestone ends with `bun run check` passing and a commit.
- Containers are stopped before each test of new Workspace code (§2.7).

### M0. The PTY, the sync and the transport, settled first (about one day)

The riskiest unknowns. A throwaway admin route, `agents/terminal-probe`, works on a scratch Workspace of the fixture
repo. Nothing in it is built for keeps.

| Probe | Question |
|---|---|
| **PTY** | Does `ctx.container.exec(["bash","-i"], { pty, stdin: "pipe" })` work in production: prompt, echo, `stty size` before and after `resize`, `vim` drawing, Ctrl-C reaching the foreground job, `exit` giving `exitCode`? |
| **Session and group** | Does the PTY make the shell a session leader? Do part 2's markers and kill script reach a `sleep 600 &` started in it? |
| **Files** | Does a file written in the PTY under `/workspace/repo` reach the DO only after `Workspace.pull()`? How long does a no-op pull take, and a pull after `git commit`, on the fixture and on a 2,000-file repo? Does a pull concurrent with a computer exec stay correct? Does a DO write reach the PTY after `push()`? |
| **Paths and env** | Does the bind mount at `/w/<id>` work from the wrapper? What env does the exec get (key names only)? Does mise activate? Does `git push` through the credential helper work from the PTY? |
| **Transport** | Echo round-trip p50/p95 from a headless client through `/ws`, the Environment DO, the Workspace DO and the Container. Throughput and memory under `yes \| head -c 20M`. The push design against a streamed RPC; seven streamed RPCs at once, to see the 6-connection limit. |
| **Lifetime** | What happens to the exec'd shell when (a) the Workspace DO is aborted (`ctx.abort()`), (b) an idle Workspace DO is left without requests for 5 minutes while the shell sits at a prompt, (c) the Container is destroyed? This is also step 4a's open check. |
| **t3 in workerd** | With a fake adapter: does `agentScope.wrap` pass `bash` through without spawning? Does `HostProcess.Platform` say linux? Does `makeWithOptions` boot with our options? Which keys does `process.env` hold (names only)? |

**Exit evidence:** `m0-pty.json`, `m0-sync.json`, `m0-transport.json`, `m0-lifetime.json`, `m0-t3.json`, and a
decision written into this plan's §2 (push or stream; sync timings; any change). If the platform PTY fails in
production, stop and report with the fallback in R1 before M1.

### M1. The terminal

- **Built:** §2. The `TerminalManager` Layer, the `PtyAdapter` Layer and the Environment DO's `terminalOutput` RPC
  (not activity, never boots t3). `TerminalHost` in the Workspace DO with heartbeat, idle hold and sync. The wrapper
  and rc in `apps/sandbox-image/src/terminal.ts`, and the in-memory subprocess inspector.
- **Exit evidence** (`m1-terminal.json`, `m1-*.png`), from the stock web client paired with the stage:
  - **The basics.** With the Container stopped, open a terminal in a project thread: the status line, then a prompt
    within about 25 s. Then `pwd` shows `/w/<id>`, `ls`, `git status`, a `vim` session, and a resize shown by
    `stty size`.
  - **Sync.** `echo hi > t.txt` appears in t3's file tree and diff within 3 s. An agent's `write` is seen by `cat`
    within 3 s.
  - **Credentials.** `git push` to a branch of the fixture succeeds; the branch is deleted afterwards.
  - **No leak.** `env` in the terminal shows none of the Worker's secret names, checked by script against the stage's
    binding names.
  - **Close.** Closing the terminal leaves no marked process within 3 s (`ps` through `workspace-call`).
  - **Environment restart** (admin `restart`): the client re-attaches and shows the old scrollback and a new prompt;
    the old shell is gone.
  - **Clients gone.** Close all clients: the shell is gone within 3 minutes of the Environment's idle reset, and the
    Container stops after that.
  - **Idle hold** (shortened to 2 minutes on the stage): the Container stops, the pull runs first (a file written just
    before survives), and t3 shows "exited".
  - **Budget.** With 3 Containers held, a fourth Workspace's terminal shows the refusal.
- **Tests:**
  - *Unit:* the adapter's env allowlist (secret-named keys dropped, base never `process.env`), write batching and
    order, frame encoding, unknown-key kills, heartbeat expiry, idle-hold arithmetic, sync scheduling (debounce, the
    2 s cap, pull before stop).
  - *workerd:* `TerminalHost` with a fake `ExecProcess` (open, write, resize, kill, exit, Environment gone,
    9th-terminal refusal, alarm with terminals). The Environment DO's `terminalOutput` neither boots t3 nor counts as
    activity.
  - *Node with real processes:* t3's real `makeWithOptions` and the real `ProjectSetupScriptRunner` over our adapter.
    The adapter talks to a fake Workspace host that runs a real `bash` under a PTY (`node-pty` from t3's
    dependencies, else `script -qfc`). It covers open, attach, write, resize, scrollback and the setup sentinel flow
    with exit codes 0 and 3.
  - *Docker* (`ubuntu:26.04`, skipped without Docker): the wrapper (bind mount and symlink fallback, marker, rc with
    mise), and the kill script on a PTY's session.

### M2. Worktree Workspaces

- **Built:** §3.
  - The id grammar in `workspace-client`, the registry migration and states, the `/w/.wt` directories.
  - `ServerConfig.worktreesDir`.
  - The router's worktree verbs; provisioning (bundle, clone, branch config); the `worktree list` emulation; the
    carry-home helper.
  - `fastWorktreeCheckout` pinned off. The Session and adapter paths for `.wt` ids.
- **Exit evidence** (`m2-worktree.json`, `m2-*.png`), from the web client:
  - **Provisioning.** A new thread in worktree mode on the fixture project provisions `.wt/<p>/<dir>`: the stages
    `fetch → checkout → agent` and the timings.
  - **Work in the worktree.** Its agent edits and runs `bash`; the checkpoint diff comes from the worktree's DO
    (`checkpoint-trace` `by: do`); status reads are served stale after the idle stop; push and PR come from the
    worktree.
  - **Two at once.** A second worktree thread runs at the same time in its own Container.
  - **Branch view.** The project's branch list shows both as checked out in worktrees.
  - **Local commit.** A worktree from a branch with a local-only commit has that commit (the bundle).
  - **No remote.** A worktree of a New project with no remote works.
  - **Wrong location.** A worktree location outside `/w/.wt` is refused with the message.
  - **Trace audit.** The router trace from the runs lists every `worktree`/`--git-common-dir` argv t3 sent.
- **Tests:**
  - *Unit:* `toWorkspace`/`isWorkspaceId` for both forms, every `worktree` argv shape (`gitRoutes.test.ts`),
    destination checks, the `worktree list` porcelain writer (compared with real git's output on a real worktree).
  - *Node with real git:* the provisioning script's three cases (remote only, local-only commits, no remote), and the
    carry-home bundle (fast-forward and diverged). Then `staleReads.test.ts`/`gitPatch.test.ts` cases run on a clone
    made this way.
  - *workerd:* the registry migration on a step-2a-shaped table; routing of the `/w/.wt` listings.

### M3. Setup scripts

- **Built:** §4. The project-root view (copy at provisioning, link in the wrapper), the `T3CODE_*` env passing, and the
  first-line listing.
- **Exit evidence** (`m3-setup.json`, `m3-*.png`):
  - The fixture project gets a setup script through t3's own project settings: `cp "$T3CODE_PROJECT_ROOT/.env" . &&
    mise install && echo ready`, with a `.env` written into the project first.
  - **The exit criterion's first half.** A new worktree thread shows `setup-script` running, then done, with the tail.
    Its terminal shows the output. `.env` is in the worktree.
  - **Failing script.** A script that exits 3 shows as failed with the exit code, both `async` and not.
  - **Settle.** A settle script runs on settle.
  - **Budget.** With the budget full, the refusal shows in the setup terminal.
- **Tests:** *Node with real processes* (M1's harness): the runner's sentinel with `T3CODE_*` set, the readiness wait
  when the shell starts late (keystrokes buffered), and the failure codes. *Unit:* the project-root view's file
  selection and caps.

### M4. Deletion and the sweep

- **Built:** §5.
  - States and the `destroy()`s; the removal flow with carry-home and tombstone.
  - The domain-event reactor, the sweep in the alarm, and the cost guard against budget leases.
  - The admin routes; `workspace-remove` becomes a purge.
- **Exit evidence** (`m4-delete.json`, `m4-*.png`):
  - **The exit criterion's last part.** Delete the worktree thread from the web client and answer "Delete the
    worktree too?" with yes. Within 30 s:
    - the budget no longer lists it and its Container is stopped (`containerState`);
    - its DO's storage is empty (`info`: not provisioned, revision 0);
    - its registry row is gone;
    - its terminals are gone;
    - its branch, with an unpushed commit, is in the project's repo (carry-home).
  - **Dirty, forced.** A worktree with uncommitted changes is tombstoned, restorable with `workspace-restore`, and
    purged by the sweep after the stage's shortened grace.
  - **Declined.** Answering "no" leaves it unreferenced, purged by the sweep after the grace.
  - **References hold.** An archived thread's worktree is never purged. A Workspace with a running turn or an open
    terminal is skipped by the sweep (`sweep?dry=1` gives the reason).
  - **Projects.** Archiving a project stops its Containers and keeps its files. Deleting a project purges after the
    grace; re-adding it within the grace keeps it.
  - **Cost guard.** A lease held by an unknown holder, injected through the budget's test hook, is stopped by the
    sweep.
- **Tests:**
  - *Unit:* the reference computation from projection rows, the state machine, grace arithmetic, the carry decision,
    `nextDue` with the sweep.
  - *workerd:* `WorkspaceDO.destroy()` wipes storage and the alarm, releases the lease and refuses later RPCs until
    re-created; `SessionDO.destroy()`; the registry-last ordering on injected failures (each step failing once,
    then the sweep finishing it).
  - *Node with real git:* the dirty and clean detection, and the carry bundle.

### M5. Acceptance, documents and close

- **The acceptance test** (`acceptance.ts --terminal --worktree`, also run by the nightly bump):
  - a headless client opens a terminal, runs `echo t3flare-$RANDOM` and reads it from `terminal.attach`;
  - creates a worktree thread whose project has a setup script, and waits for the setup stage;
  - removes the worktree through `vcs.removeWorktree` and checks the registry and the budget;
  - runs `sweep?dry=1` (which checks the projection columns it reads).
  - The bump then catches drift in t3's terminal, setup runner, worktree verbs and projection tables.
- **Optional** if time is left: §2.8's foreground-process reporting.
- **Documents:** the report `docs/steps/step-2b.md`; the ADRs and glossary (§9); README status; `docs/plan.md`'s row
  marked done.
- **Close:** `bun scripts/stage.ts destroy step2b`. The fixture's test branches are deleted.

---

## 7. Risks

| # | Risk | Settled by | Fallback |
|---|---|---|---|
| R1 | The platform's PTY exec is missing, unreliable or behaves differently in production (stdin streaming, resize, exit codes) | M0, before anything is built | `script -qfc bash` under a plain `exec` with stdin piped (a PTY made inside the Container), with resize by a second exec running `stty -F <pty> rows R cols C` and `kill -WINCH`; else a small PTY server in the image reached through `getTcpPort` (cloudpid ADR-0012's considered option) |
| R2 | DO-driven sync is slow on large repos, or a pull races computer's own syncs | M0 timings; M1 tests | Pull only on exit, before stop and before t3's passive reads of that Workspace; the debounce lengthens with repo size |
| R3 | An exec'd shell dies when an idle Workspace DO is evicted, or survives it as an orphan | M0 lifetime probe | The heartbeat RPC every 30 s keeps the Workspace DO active while its terminal lives; orphans are killed by marker at the next open or alarm |
| R4 | Push latency or throughput is poor | M0 transport | A streamed RPC multiplexed per Workspace (at most 3 at once) |
| R5 | Secrets in `process.env` reach a terminal | M0 lists key names; M1's leak check | Base env never `process.env`, plus the adapter's allowlist and name filter: two independent layers |
| R6 | Terminals keep Containers running and cost money | M1 idle hold and clients-gone evidence | The 30-minute hold is an env value; the budget caps 3; the sweep's lease check |
| R7 | A clone per worktree is slow on large repos | M2 timings on the fixture and a 9,000-file public repo | Spare Workspaces (deferred, cloudpid `spare.ts`) or a DO-to-DO copy of the project's files as the seed |
| R8 | t3 relies on a shared git common dir somewhere we did not see | M2's router trace audit; the acceptance test | Emulate that argv in the router, as `worktree list` |
| R9 | Setup scripts read tracked files through `$T3CODE_PROJECT_ROOT`, or symlink the project's `node_modules` | M3; documented | Widen the project-root view (tracked files at the base commit), or a read-only copy of more |
| R10 | Deletion purges something still needed (a TOCTOU, a crash mid-purge, an event missed while the Environment slept) | M4 tests with injected failures; the sweep's re-check | `deleting` is re-driven; the tombstone; the sweep re-derives references from t3's tables, not from events |
| R11 | t3's terminal, setup-runner or projection internals change on a bump | the extended acceptance test in the nightly bump | The bump stays unpinned and reports (ADR-0017) |
| R12 | A client that re-attaches with `resume` to an open terminal panel starts a stopped Container on every page load | M1 | It is the user's open terminal, and the idle hold bounds it; if it proves costly, the adapter starts the Container on a resume only when the client sends input |
| R13 | Scrollback memory in the 128 MB isolate (t3 keeps 8 MiB per session by default) | M1 measures heap with 8 busy terminals | 1 MiB per session and 16 retained inactive sessions through our Layer's options |

## 8. Budget: Patches, Shadows, Layers

- **Expected: Patches 2 → 2, Shadows 1 → 1, Build shims 6 → 6.**
- **New Layers:** `PtyAdapter`, `TerminalManager` (restated `make` with options), `ServerConfig.worktreesDir`, the
  routing file system's `/w/.wt` directories, the process router's worktree verbs, the domain-event reactor, and the
  seeded `fastWorktreeCheckout: false`.
- `removeEmptyDirectory` and `worktreeCheckoutCache` from step 2a's `node:fs` audit need no Shadow: the first runs
  only if a removed worktree's path still exists, and ours never does; the second runs only with the fast checkout,
  which stays off.
- If M0 or M2 shows a Shadow or Patch is needed after all, it is reported to root before it is added.

## 9. ADR and glossary changes (written with the report)

- **New ADR-0021, "Terminals run through the platform's PTY exec beside computer, and end with their Environment".**
  It covers the push transport, DO-driven sync, the idle hold, and that a restart costs the shell but not the
  scrollback. It cites cloudpid ADR-0012.
- **ADR-0008 refinement:**
  - the worktree address `/w/.wt/<project>/<dir>`, with the id being the path below `/w`;
  - full clones seeded by a bundle;
  - `worktree list` emulated;
  - the branch carried home at removal, and the tombstone;
  - the states, the reference rule and the sweep as built.
- **ADR-0009 refinement:** a worktree Workspace has its own `.git`, so checkpoints, stale reads and the guard are per
  Workspace.
- **ADR-0003 refinement:** terminal pushes are not activity, and the sweep's due time is in the alarm.
- **ADR-0014:** heap with terminals, if M1's measurement says anything new.
- **GLOSSARY:** **Terminal** (t3's, served by a PTY in the Container), **Worktree Workspace**, **Project-root view**,
  **Tombstone**, **Sweep**.

## 10. Owner decisions and actions

**Decision** (does not block the start; the default is built unless you say otherwise):

- **D1. Do terminals outlive the clients?** Default: no. A terminal ends when the Environment idles out, about 1–4
  minutes after the last client disconnects. Re-opening gives a fresh shell with the old scrollback, as t3 does after
  a server restart. The alternative is t3-on-a-laptop behaviour, where a `npm run dev` left in a terminal keeps
  running with no client. That needs a terminal with a running foreground process to keep the Environment DO awake
  (a change to ADR-0003) and its Container running, up to a cap you choose (for example 4 hours). On `cpu-1` that
  costs about 3¢ per idle Container-hour (memory and disk), plus CPU while the process works. Say if you want it, and
  with which cap.

**Defaults chosen** (here for review, not asked):

- A forced removal of a worktree with uncommitted changes is tombstoned for 7 days, not purged at once.
- An unpushed branch is carried into the project's repo at removal.
- An idle terminal holds the Container 30 minutes.
- A deleted project keeps its files for the 7-day grace.
- Archiving stops Containers and keeps files.

**Actions:**

1. Review this plan and say "go" (and answer D1 if you want the alternative).
2. At the end, optionally try the stage with the desktop client, as in step 2a. I add the stage under Settings →
   Environments and remove it afterwards.

Nothing else is needed: the GitHub App's permissions, the fixture repo (`ian-pascoe/t3flare-fixture`) and the model
proxy are as step 2a left them. Test branches pushed to the fixture are deleted by me.
