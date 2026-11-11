# t3's SQL client is the stock Durable Object client, with a DO SQLite adapter

Our composition provides t3's `SqlClient` as the stock `@effect/sql-sqlite-do`, created with `storage` so that `withTransaction` works through `storage.transaction()`. No Shadow is needed: importing t3's `nodeSqliteClient` is harmless in workerd (`node:sqlite` is an import-only stub), only its `layer` would fail, and we never build it.

DO SQLite refuses some of what t3's queries do, so the client goes through an adapter in our SQL Layer:

| DO SQLite limit | t3's need | Adapter |
|---|---|---|
| 100 bound parameters | 16 remaining `sql.in(...)` call sites | inline escaped literals above 100 |
| 5 terms per compound `SELECT` | 12 in the thread window | regroup `UNION` chains into nested subqueries of at most 5 |
| About 100 view and subquery expansions per statement, **production only** | the thread window's inlined CTE | on that error, run each CTE as its own statement and pass its rows on as a `json_each` parameter, with no DDL |
| 50-byte `LIKE` patterns | our own prefix matches | key ranges instead |
| PRAGMAs refused | `Sqlite.layerSetup` | run only t3's migrations |
| `PRAGMA auto_vacuum`, `page_count` and `freelist_count` refused | `DatabaseStorage`'s reads every minute | answer their read form with 0 (no automatic vacuum), so its reclaim does nothing; its history compaction still runs |

## Consequences

- An open `storage.transaction()` closes the DO's input gate, so **nothing else runs** until it commits, not just reads. t3's transactions are short and SQL-only; a transaction that awaited I/O would stall the whole Environment.
- Local workerd does not have the production-only expansion cap, so the SQL acceptance tests run against a deployed stage, with fixtures that have turn items. Step 1's fixtures (12 threads × 4 runs, 240 turn items, written through t3's own `EventSinkV2`) took the CTE fallback 24–26 times per acceptance run on production with no failure, and no statement other than t3's PRAGMAs was refused. The adapter's rewrites are also tested for equal results on Node's SQLite and against DO SQLite's limits in local workerd (`apps/environment/test/`).

## Considered Options

- **Shadowing `nodeSqliteClient`**: the first design, unnecessary once the spike showed the import is harmless.
