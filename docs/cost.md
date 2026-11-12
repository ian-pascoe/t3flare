# Cost

What t3flare costs on Cloudflare, what to look at to know, and when to act. From the cost audit of 2026-11-11, priced
against Cloudflare's pricing pages that day.

## Cost model

At light and moderate use the bill is almost all the **$5 Workers Paid minimum**.

| | Light | Moderate | Heavy |
|---|---|---|---|
| Client connected | 3 h/day | 10 h/day | 24/7 |
| Turns | 5/day | 30/day | 100/day |
| Container-hours a month | 15 | 60 | 360 |
| Containers (memory, disk, CPU) | ≈ $0.20 | ≈ $1.95 | ≈ $16.60 |
| DO duration | 65k GB-s, $0 | 207k GB-s, $0 | 617k GB-s, **$12.50** |
| DO requests | $0 | ≈ $0.15 | ≈ $1.05 |
| **Total a month** | **≈ $5.20** | **≈ $7.10** | **≈ $35** |

What moves the total:

- **Container-hours.** About $0.030 each in memory and disk at the 3 GiB size, plus active CPU, past the free ~8 h.
  Every running Container also keeps its Workspace DO resident: 450 GB-s of DO duration per Container-hour.
- **The DO duration cliff.** 400k GB-s a month are included; anything over rounds up to the next 1M GB-s, $12.50. An
  Environment connected 24/7 is 324k GB-s on its own, and Workspace DOs (Container-hours) and Session DOs (turns) share
  the same allowance.
- **DO rows written** ($1.00 per million past 50 M). Not yet measured: see the checklist.

## Owner's dashboard checklist

1. **Billing → Billable Usage** (current and last period): DO duration (GB-s), DO requests, DO rows read and written, DO
   stored data, Containers (vCPU-s, GiB-s, GB-s), Workers requests and CPU, Dynamic Workers created, Workers Logs.
   This shows where the account sits against each allowance, and how far it is from the 400k GB-s cliff.
2. **Workers & Pages → Durable Objects**, for each namespace (`EnvironmentDO`, `SessionDO`, `WorkspaceDO`,
   `ContainerBudget`, on each deployed stage's scripts): the Requests, Duration, Rows written and Stored data graphs.
   The question is whether `EnvironmentDO` or `SessionDO` rows written come anywhere near 50 M a month.
3. **Containers → WorkspaceContainer** (prod and bump): instance count over time, and memory and CPU use. A Container
   that stays up for hours on deploy days is a terminal hold at work.
4. **Observability → Billable Usage** from 2026-12-01, when Workers Logs is billed per GB: GB ingested against the 50 GB
   included. If it ever comes near, set a head sampling rate on the agents Worker's invocation logs first; per-push RPCs
   dominate its event count.
5. Optionally, the GraphQL Analytics API with an account-scoped read token: `durableObjectsPeriodicGroups` (activeTime,
   rowsRead, rowsWritten by namespace), `durableObjectsStorageGroups` (storedBytes), and
   `workersInvocationsByOwnerAndScriptGroups.uniq.distinctDynamicWorkerCount`.

## What t3flare measures itself

- **`container-idle-stop`** (agents Worker logs): `memoryPeakBytes` and `cpuUsageUsec` from the Container's cgroup, and
  `ranMs` since its start, at every idle stop.
- **`GET /_t3flare/health` → `sql`**: `rowsWritten` and `rowsRead` of t3's statements through the SQL adapter since
  `isolate.startedAt`, and the Environment's `databaseSize`. Divide by the isolate's age for a rate.
- **`GET /_t3flare/agents/workspaces` → `terminals.pushes`**: terminal output batches each Workspace DO pushed since it
  started.

- **`process-started`, `process-exited`, `model-key`, `container-stop-cli`** (agents Worker logs, step 4a): CLI
  agent processes and the key helper's grants. A CLI process holds its Container while its thread is in a turn and
  for 11 minutes after (t3 releases the session at 10, Patch 0003), so an idle CLI session costs at most about
  11 Container-minutes beyond its last turn (about $0.006). The Environment's own idle reset (60 s without a client)
  ends idle CLI processes earlier, at the Workspace's 90 s lapse; a full budget reclaims Containers whose CLI sessions
  sit idle.

## When to act

- **Right-size the Container from 3 GiB to 2 GiB (audit F3)** once at least ~20 idle stops are logged and the p95 of
  `memoryPeakBytes` is under 1.4 GiB, counting CLI-agent turns (an idle Codex app-server is about 160 MB; up to 4
  CLI processes per Workspace). Saves $0.54 a month at moderate use, $3.24 at heavy. The `durable_object`
  scheduling policy allows any size above 1/16 vCPU, 256 MiB and 2 GB.
- **Hibernatable client sockets for the Environment DO (audit F5, ADR-0002)** when a month's DO duration goes over
  400k GB-s (start the plan at about 350k). Saves $12.50 a month, at heavy use only; effort L.
- **Rows written** projecting above 40 M a month: look at the per-namespace split before tuning further.
- **Terminal holds**: if idle stops still show long `ranMs` on days with terminal panels open (more than about 30% of
  Container-hours), spike not starting a re-attached terminal's Container until the first keystroke (ADR-0021).
