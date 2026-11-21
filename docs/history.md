# History

What t3flare's milestones delivered, and what stays deferred. The decisions are in [`docs/adr/`](adr/).

The working record of how each piece was built is archived at the tag `docs-archive-1`, not on `main`: the step and
issue reports, the plans and their reviews, the step 0 spike, the early research, the 2026-11-16 scope audit and the
milestone plan this page replaces (`docs/plan.md`). The raw evidence those reports cite is at `steps-evidence-1`. See
[`docs/steps/README.md`](steps/README.md) for how to read both.

## Milestones

Report links are to `docs-archive-1`.

| Step | What it delivered | Report |
| --- | --- | --- |
| 0. Spike | t3's orchestration core and auth in one Durable Object; the stock web client pairs, creates a project and opens a thread. GO with conditions | [`spike/step-0.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/spike/step-0.md) |
| 1. Platform | Our own build uploaded with `bundle: false` (ADR-0020), the DO SQLite adapter (ADR-0006), the State directory, the idle reset by alarm (ADR-0003), admin routes, the nightly bump | [`steps/step-1.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-1.md) |
| 2a. Durable agents, part 1 | The agents Worker, Session and Workspace DOs, the Container, the GitHub App; clone, a turn that edits and runs `bash`, approvals, the diff, push and PR; an Environment restart mid-turn continues | [`steps/step-2a.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-2a.md) |
| 2a. Durable agents, part 2 | Usage limits and refused keys as t3's failures; an aborted command's processes killed | [`steps/step-2a-part2.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-2a-part2.md) |
| 2b. Terminal and setup | t3's terminal, setup scripts, worktree Workspaces, deletion and sweep | [`steps/step-2b.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-2b.md) |
| 3. Peer links | A laptop agent delegates to a cloud Durable agent, which uses t3's own MCP tools | [`steps/step-3.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-3.md) |
| 3+. T3 Connect | A publish-only T3 Connect link: a phone notification when a cloud run ends or waits on the owner | [`steps/step-3plus.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-3plus.md) |
| 4a. CLI agents, stdio | Codex and the pi CLI in a Workspace's Container, each resuming its own conversation after the Container slept | [`steps/step-4a.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-4a.md) |
| 4b. CLI agents, ACP | Claude Code and OpenCode over t3's ACP adapter, with approvals and plan turns | [`steps/step-4b.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/step-4b.md) |
| Tools | Code mode, owner-added MCP servers, t3's tools for every CLI agent, the Settings page | [`steps/tools.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/tools.md) |
| Settings server | Agents and the owner's own MCP clients ask for changes to t3flare's settings (ADR-0035) | [`steps/settings-mcp.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/settings-mcp.md) |
| The hard cut | The Model proxy removed; every agent runs on the owner's Model endpoints (ADR-0034, SPI-1176) | [`steps/spi-1176.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/spi-1176.md) |

Steps 2a to 4b first ran on the since-removed Model proxy (ADR-0012, superseded by ADR-0034). The parity work that
followed is tracked feature by feature in [`parity.md`](parity.md); each Linear issue's report is at the tag as
`docs/steps/spi-<number>.md`.

## Deferred, each on its own trigger

Hibernatable sockets (a month over 400k GB-s), spare Workspaces, PR watch by webhook, moving threads between
Environments, native subagents inside a Durable Session (rollback and fork are done: SPI-987, SPI-997), more
pi-durable extensions, an egress allowlist (`enableInternet: false` plus an allowlisting intercept), GitHub tokens
through the intercept.
