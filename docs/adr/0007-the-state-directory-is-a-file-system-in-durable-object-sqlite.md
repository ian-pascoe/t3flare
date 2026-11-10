# The State directory is a file system in Durable Object SQLite

t3 writes its State directory (attachments, generated files) with synchronous `node:fs` from plain functions in core (`attachmentStore.ts` and its callers), not through a service. workerd's `node:fs` is a per-request virtual file system. We provide a synchronous `node:fs` subset and an Effect `FileSystem` Layer over DO SQLite, whose API is synchronous: one row per file up to 4 MiB, and above that the bytes in 4 MiB rows of a chunk table (the row limit is 8 MB); ranges read only the chunks they cover. Paths under `/w/` reached through Effect `FileSystem` go to the Workspace DO; reached through synchronous `node:fs` they fail with `ENOENT` and are logged as Shadow candidates.

The alias applies only to t3's own modules, so dependencies keep workerd's `node:fs` for `/bundle`. It is a `transform` of t3's modules in our own build (ADR-0020), rewriting their `node:fs`, `fs`, `node:fs/promises` and `fs/promises` imports (46 specifiers in 40 modules at the spike), and `node:module` likewise, because t3 `createRequire`s native packages at module scope.

## Considered Options

- **A Rolldown `resolveId` hook**: Cloudflare's Rolldown plugin claims `node:*` builtins in a `"pre"` hook first, so a plain hook never sees them.
- **R2 now**: asynchronous, so it would mean patching core callers. R2 can become a tier for large files behind the same shim.
