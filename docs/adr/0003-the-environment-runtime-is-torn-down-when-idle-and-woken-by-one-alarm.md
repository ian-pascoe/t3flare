# The Environment runtime is torn down when idle and woken by one alarm

t3 runs many in-process timers (a 5 s Scheduler tick, `Schedule.spaced` reactors). Any pending `setTimeout` keeps a Durable Object from being evicted, so left alone the Environment DO would stay resident forever. Instead, when there is no client socket, no in-flight request, no open run or provider session and no claimable outbox effect for about 60 s, the DO host reads the next due time (outbox, scheduled tasks, usage-limit resets), sets one alarm for it, and disposes the whole Effect runtime. The next request or alarm boots it again, which t3 treats as an ordinary restart.

## Consequences

- PR watch and sync polling do not run while idle; GitHub webhooks are the later answer.
- Boot must be cheap and idempotent; the spike measures it.
