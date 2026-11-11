# Terminals run through the platform's PTY exec beside computer, and end with their Environment

t3's own `TerminalManager` and setup-script runner stay stock; t3flare supplies only the PTY under them (a Layer of
`PtyAdapter`, and `TerminalManager.makeWithOptions` with our options). A shell is a bash the Workspace DO starts in its
Container with the platform's `ctx.container.exec(…, { pty })`, beside `@cloudflare/computer`, which has no PTY. Output
is pushed from the Workspace DO to the Environment DO in batches over DO RPC (as ADR-0005's Sessions push), input,
resize and close go back as RPC, and nothing holds a connection open. The Workspace DO syncs files for its shells
(pull when a prompt returns or output goes quiet, push its own writes every 2 s), following cloudpid's ADR-0012, which
designed this and never built it.

## Consequences

- **A terminal ends with its Environment** (owner decision D1). The adapter heartbeats each Workspace's terminals every
  30 s; a terminal without one for 90 s, or one the Environment answers as unknown in a push, is killed. Closing every
  client therefore ends the shells in about 2–3 minutes, and the Container stops after them. After an Environment
  restart t3 re-attaches with `resume`: a new shell in the same cwd with the old scrollback, as on a laptop after a
  server restart (ADR-0004: a restart costs the process, never the history).
- **Signals are part 2's marker kill script, never `ExecProcess.kill()`.** Each shell carries `T3FLARE_EXEC=term-<key>`;
  a close kills its whole session by marker. The markers are kept in the Workspace DO's storage, and orphans of an
  earlier instance (a shell outlives `ctx.abort()`) are killed at its next open.
- **The foreground comes from the shell.** The rc file prints two OSC markers (`PS0`: a command runs; `PROMPT_COMMAND`:
  the prompt is back) that the Workspace DO strips; t3's subprocess inspector answers from them, so `closeIdle` (run on
  settle) keeps a terminal running `npm run dev` and closes an idle one, and t3 never spawns `ps`.
- **Only input holds the Container** (30 minutes from the last input), so a noisy terminal cannot keep it forever.
  Terminal output pushes are not activity for the Environment's idle reset (ADR-0003).
- **Defence in depth for secrets:** the Workers run with `nodejs_compat_do_not_populate_process_env`, the terminal's base
  env is fixed (never `process.env`), and the adapter allowlists the env it passes.
- Output is never dropped: a failed push goes back to the front of the queue, because a lost frame can be a setup
  script's sentinel.
- **A terminal outside every Workspace says so and exits 1.** t3's "No project" folder (`/t3/scratch`) is in the state
  directory, not a Workspace, so it has no Container to run a shell in (step 2a left scratch threads without one). The
  adapter never fails that spawn: t3 sends a spawn error as an event before `terminal.attach` subscribes, so the
  client got only an `error` status and showed a blank terminal (the prod hang after 2b). Every refusal is therefore
  output in the terminal, then an exit.
- Every deploy of `main` restarts the Environment (immediate code update), which kills running terminals and setup
  scripts; their scrollback stays.

## Considered Options

- **A returned stream per terminal (or per Workspace)**: held connections pin the Environment DO and count against the
  6 simultaneous outgoing connections; push met the latency targets (echo p50 73 ms, p95 95 ms).
- **`script -qfc` under a plain exec, or a PTY server in the image** (R1's fallbacks): the platform PTY worked in
  production, with resize, exit codes, sessions and job control.
- **Terminals that outlive their clients**: they would keep the Environment and the Container awake (an ADR-0003 change
  and Container cost); the owner chose not to (D1).
