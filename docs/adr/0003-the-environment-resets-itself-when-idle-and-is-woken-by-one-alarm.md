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
