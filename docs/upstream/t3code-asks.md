# Asks for t3code (draft, not sent)

For the owner to send to t3code (pingdotgg/t3code), as issues or one discussion. Each ask removes a Patch,
a Build shim or a piece of our composition. Pinned at `v0.1.9-nightly.20261110.4478`; paths are from that tag.
Context: we run t3's server core unchanged inside a Cloudflare Durable Object (workerd), with our own
composition root and platform Layers (step 0 report: `docs/spike/step-0.md`; step 1: `docs/steps/step-1.md`).

## 1. No randomness or timers at module scope

workerd forbids random values and timers while it evaluates modules, even ones loaded with `await import()`.

- `apps/server/src/preview/ServerBrowserPage.ts` calls `randomUUID()` at module scope (the browser-ref
  namespace). We carry a 3-line Patch (`patches/0001-lazy-server-browser-ref-namespace.patch`) that makes it
  lazy. **Ask:** make it lazy upstream.
- `@anthropic-ai/claude-agent-sdk` generates a session id with `randomUUID()` at module scope; t3 imports it
  statically, so we stub the whole package at bundle time. **Ask:** import the Claude SDK lazily (or report it
  to Anthropic's SDK).

## 2. Load native packages lazily

`apps/server/src/workspace/WorkspaceSearchIndex.ts` (and other modules) call
`createRequire(import.meta.url)(name)` for native packages (`@ff-labs/fff-node`, `node-pty`, …) at module scope.
No bundler can follow it, and it runs even where the feature is never used. We alias `node:module` for t3's
modules to a shim that returns throwing stand-ins. **Ask:** resolve native packages on first use.

## 3. Keep SQL within what other SQLite hosts allow

Durable Object SQLite refuses more than 5 terms in one compound SELECT, more than 100 bound parameters,
LIKE patterns over 50 bytes, and (on production only) more than about 100 view/subquery expansions in one
statement. We rewrite t3's statements in an adapter (`apps/environment/src/platform/sqlAdapter.ts`).

- `orchestration-v2/ProjectionStore.ts`'s thread window unions 12 sections in one statement, and inlines a
  `NOT MATERIALIZED` CTE into many references, which trips the expansion cap on production (the stock web
  client's thread view failed there until our fallback). **Ask:** at most 5 compound terms per SELECT, and
  `MATERIALIZED` (or fewer references) for that CTE.
- 16 `sql.in(...)` call sites can exceed 100 parameters (`ProjectionStore`, `ProjectionMaintenance`,
  `EffectOutbox`, `AuthSessions`, `ProjectStore`, `ScheduledTaskService`). Most id lists already go through
  one `json_each(?)` parameter. **Ask:** the same for the rest.

## 4. PRAGMAs that a host may refuse

`persistence/Sqlite.ts`'s `layerSetup` sets six PRAGMAs, and the storage inspection
(`persistence/DatabaseStorage.ts`) reads others; DO SQLite refuses them (`SQLITE_AUTH`), so we run only
`runMigrations()` and t3 logs "Database storage inspection failed" at every boot. **Ask:** make the PRAGMAs
optional (or tolerate refusal), and skip the inspection when its PRAGMAs are refused.

## 5. An option not to print the startup pairing URL

`serverRuntimeStartup.ts` (`announceStartupPairingUrl`) prints a fresh one-time pairing URL, token
included, at every boot in `web` mode, and issues that token whether or not anyone reads it. In a hosted
environment the log is a log store. We drop the line in a redacting `Console`. **Ask:** a `ServerConfig`
option (or `startupPresentation: "none"`) that neither issues nor prints a startup pairing token.

## 6. A bootstrap grant with a bounded life, or one we can seed and revoke

`auth/PairingGrantStore.ts` seeds the `desktopBootstrapToken` as a grant with unbounded uses that expires 24 h
after **each boot**. We seed it only while an admin route has armed pairing (15 minutes by default), which
means restarting t3 in place to arm and again to disarm, and we refuse the token at our front door outside
the window. **Ask:** a TTL / use count for the seeded grant, or a service method to seed and revoke a
bootstrap grant at runtime.

## 7. Export the server's layer graph

`apps/server/src/server.ts`'s layers are module-private, so our composition root
(`apps/environment/src/t3/composition.ts`, ~760 lines) restates the graph to swap the Node platform for the
Durable Object's. Every bump risks drift. **Ask:** export a `makeServerLayer(options)` (or the named pieces)
with the platform services (file system, process spawner, PTY, HTTP server, SQL client, secret store) as
inputs.

## 8. One "next due time" for hosts that sleep

To let the Environment sleep when idle we compute the next time t3 has work due from its tables (outbox
`available_at`, `scheduled_tasks.next_run_at`); usage-limit reset times are held in memory, not persisted, so
we cannot wake for them. **Ask:** a service method returning the next due time across all of t3's schedulers
(and persisted usage-limit resets), so a host can set one alarm and stop.

## 9. Turns that survive a host restart

At startup t3's recovery assumes every provider process died and re-prompts the agent (ADR-0004). Our agents
run elsewhere and keep running across a restart of the Environment. **Ask:** a capability for provider
adapters to report a live turn on recovery, so it is re-attached instead of cancelled.

## 10. Module-level state (for information)

A warm isolate keeps module state across our resets (Node never shows t3 this). Our twice-in-one-isolate boot
check found two module-level values that outlive a runtime: `packages/shared/src/observability.ts`
`generatedServiceInstanceId` (kept, harmless) and `apps/server/src/mcp/McpSessionRegistry.ts`
`activeMcpSessionRegistry` (replaced on the next boot; between a reset and the next boot it points at the
disposed registry). **Ask:** keep mutable state in services rather than modules, so a runtime rebuilt in the
same process starts clean.
