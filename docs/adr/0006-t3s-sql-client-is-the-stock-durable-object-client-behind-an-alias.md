# t3's SQL client is the stock Durable Object client behind an alias

t3 reaches SQLite through `@t3tools/shared/nodeSqliteClient` (`node:sqlite`, a throwing stub in workerd), imported directly across core including `readOnly` at 40+ call sites. We Shadow that module with a thin wrapper over the stock `@effect/sql-sqlite-do`, created with `storage` so that `withTransaction` works through `storage.transaction()`. The wrapper also proxies `SqlStorage.exec` to inline escaped literals when a statement has more than 100 bound parameters, the DO limit, which t3 exceeds (unchunked `sql.in(...)` in `ProjectionStore`, `ProjectionMaintenance`, `AuthSessions`).

## Consequences

Reads wait behind an open transaction, where t3's Node client used a separate reader. The spike measures the latency.
