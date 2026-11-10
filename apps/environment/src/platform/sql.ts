// t3's SQL client on Durable Object SQLite (ADR-0006): the stock `@effect/sql-sqlite-do` client, created
// with `storage` so `withTransaction` runs through `storage.transaction()`, over the DO SQLite adapter
// (./sqlAdapter.ts).
import type { DurableObjectStorage } from "@cloudflare/workers-types/index.ts";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";

import { adaptSqlStorage } from "./sqlAdapter.ts";

/** The storage view the client sees: the adapted `sql`, the real `transaction`. */
export const storageForClient = (storage: DurableObjectStorage): DurableObjectStorage =>
  ({
    sql: adaptSqlStorage(storage.sql),
    transaction: storage.transaction.bind(storage),
  }) as unknown as DurableObjectStorage;

export const layer = (storage: DurableObjectStorage) =>
  SqliteClient.layer({
    storage: storageForClient(storage),
    spanAttributes: { "db.name": "environment", "service.name": "t3flare-environment" },
  });
