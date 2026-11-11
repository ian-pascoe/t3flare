# The Environment resets itself when idle and is woken by one alarm

t3 runs many in-process timers (a 5 s Scheduler tick, `Schedule.spaced` reactors). Any pending `setTimeout` keeps a Durable Object from being evicted, so left alone the Environment DO would stay resident forever. Instead, when there is no client socket, no in-flight request, no open run or provider session and no claimable outbox effect for about 60 s, the DO host reads the next due time (outbox, scheduled tasks, usage-limit resets), sets one alarm for it, and calls `ctx.abort()`. That is the same reset an eviction or a deploy performs, so idling exercises exactly the restart path t3 must survive anyway (ADR-0004). The next request or alarm boots t3 again.

## Consequences

- **Module state can outlive a reset.** The step 0 spike found that a warm isolate keeps module-level state across `ctx.abort()`: boot then skips module evaluation (0.2–0.5 s, against 2.5 s cold). Node never shows t3 this, because a restarted process starts empty. Any t3 module-level mutable singleton therefore persists across an Environment restart, whether from idling, eviction or deploy. Each nightly bump runs a check that boots t3 twice in one isolate and reports the module-level state that survived, and module-level state that matters is a Patch candidate.
- PR watch and sync polling do not run while idle; GitHub webhooks are the later answer.
- **The alarm must be durable before the reset.** On production, an alarm set just before `ctx.abort()` was lost: the reset discarded the not-yet-durable write (local workerd kept it). The host awaits `ctx.storage.sync()` between `setAlarm` and `abort()`, and reads the alarm back for its log (step 1, `docs/steps/step-1.md`).
- **What counts as due** is read from t3's own tables: the earliest pending outbox effect, the earliest enabled scheduled task, and the earliest usage-limit recovery (the query of t3's `ProjectionStoreV2.getLimitRecoveryWakeAt`). What keeps it awake: a client socket, a request in flight (admin routes excepted), a run or provider session in a live status, or an outbox effect claimable now. The host checks every 10 s.
- **What survives in practice.** Step 1's check (`/_t3flare/check/reboot`, run by the acceptance test on every bump) boots t3, disposes it and boots it again in the same isolate, and lists the module bindings that differ from their state at module evaluation. At `v0.1.9-nightly.20261110.4478` there are two, both harmless: `generatedServiceInstanceId` (`packages/shared/src/observability.ts`), and `activeMcpSessionRegistry` (`apps/server/src/mcp/McpSessionRegistry.ts`), which the next boot replaces.

## Considered Options

- **Disposing only the Effect runtime in place**: the first design. It is not a clean restart either (module state survives) and it leaves the DO resident until eviction, so it buys nothing over `ctx.abort()`.

## Refinement (step 2b)

- **Terminal output is not activity.** The Workspace DOs' pushes (`EnvironmentDO.terminalOutput`) never boot t3 and are
  not counted as requests, so a chatty shell with no client cannot keep the Environment awake (ADR-0021).
- **The Workspace sweep's due time joins the one alarm.** An alarm due only for the sweep runs it without booting t3,
  then arms again for t3's own due work (`docs/steps/step-2b.md`).

## Refinement (SPI-1024): the reads of t3's tables fail safe

The idle check reads t3's private tables, which a nightly can rename or reshape ([fragility U2](../upstream-fragility.md#u2-the-idle-reset-reads-t3s-private-tables)). A read that fails now means "don't know", never "no work":

- **No reset on a failed read.** If any idle query errors (a table or column gone), the Environment does not reset; it logs `idle-check-unreadable` as an error and reads again only after 10 minutes. Staying up costs money; resetting under a turn ends the turn (ADR-0004), and a wrong alarm loses a wake.
- **An unknown status is open.** A run or provider session counts as open unless its status is a settled one (runs: `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`; sessions: `ready`, `stopped`, `error`), so a status a nightly adds keeps the Environment up.
- **An alarm that cannot read its due work boots t3** rather than arming for a time it cannot know (`alarm-due-unreadable`).
- The health route shows a failed read as `{ unreadable }` under `openWork` or `nextDue`.
