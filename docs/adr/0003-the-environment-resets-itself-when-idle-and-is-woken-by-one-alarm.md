# The Environment resets itself when idle and is woken by one alarm

t3 runs many in-process timers (a 5 s Scheduler tick, `Schedule.spaced` reactors). Any pending `setTimeout` keeps a Durable Object from being evicted, so left alone the Environment DO would stay resident forever. Instead, when there is no client socket, no in-flight request, no open run or provider session and no claimable outbox effect for about 60 s, the DO host reads the next due time (outbox, scheduled tasks, usage-limit resets), sets one alarm for it, and calls `ctx.abort()`. That is the same reset an eviction or a deploy performs, so idling exercises exactly the restart path t3 must survive anyway (ADR-0004). The next request or alarm boots t3 again.

## Consequences

- **Module state can outlive a reset.** The step 0 spike found that a warm isolate keeps module-level state across `ctx.abort()`: boot then skips module evaluation (0.2–0.5 s, against 2.5 s cold). Node never shows t3 this, because a restarted process starts empty. Any t3 module-level mutable singleton therefore persists across an Environment restart, whether from idling, eviction or deploy. Each nightly bump runs a check that boots t3 twice in one isolate and compares behaviour, and module-level state that matters is a Patch candidate.
- PR watch and sync polling do not run while idle; GitHub webhooks are the later answer.

## Considered Options

- **Disposing only the Effect runtime in place**: the first design. It is not a clean restart either (module state survives) and it leaves the DO resident until eviction, so it buys nothing over `ctx.abort()`.
