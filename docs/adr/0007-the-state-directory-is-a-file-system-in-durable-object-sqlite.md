# The State directory is a file system in Durable Object SQLite

t3 writes its State directory (attachments, generated files) with synchronous `node:fs` from plain functions in core (`attachmentStore.ts` and its callers), not through a service. workerd's `node:fs` is a per-request virtual file system. We provide a synchronous `node:fs` subset and an Effect `FileSystem` Layer over DO SQLite, whose API is synchronous: one row per file up to about 4 MiB, chunked above (the row limit is 8 MB). The `node:fs` alias applies only to imports from t3's own code, through a Rolldown `resolveId` plugin, so dependencies keep workerd's `node:fs` for `/bundle`. Paths under `/w/` reached through Effect `FileSystem` go to the Workspace DO; reached through synchronous `node:fs` they fail with `ENOENT` and are logged as Shadow candidates.

## Considered Options

- **R2 now**: asynchronous, so it would mean patching core callers. R2 can become a tier for large files behind the same shim.
