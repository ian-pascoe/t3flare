// Versioned schemas for t3flare's own tables in the Environment DO's SQLite (after cloudpid's
// `@cloudpid/effect-durable/sqlite`). t3's tables are t3's: its migrations run from our composition.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

/** One schema step. Steps are numbered by position: never edit, reorder or drop a released one. */
export type Migration = (sql: SqlStorage) => void;

export interface MigrationStorage {
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(closure: () => T) => T;
}

/**
 * Brings the schema named `name` up to the end of `migrations`. Each step and its version record run in
 * one transaction, so a step that fails partway leaves no trace and is retried whole.
 */
export const migrate = (storage: MigrationStorage, name: string, migrations: ReadonlyArray<Migration>): number => {
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS t3flare_schema_versions (name TEXT NOT NULL, version INTEGER NOT NULL)");
  const current =
    sql
      .exec<{ version: number | null }>(
        "SELECT MAX(version) AS version FROM t3flare_schema_versions WHERE name = ?",
        name,
      )
      .toArray()[0]?.version ?? 0;
  for (let version = current + 1; version <= migrations.length; version++) {
    storage.transactionSync(() => {
      migrations[version - 1]!(sql);
      sql.exec("INSERT INTO t3flare_schema_versions (name, version) VALUES (?, ?)", name, version);
    });
  }
  return migrations.length;
};
