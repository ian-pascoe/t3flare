// @effect-diagnostics nodeBuiltinImport:off
// A `SqlStorage`-shaped view of Node's own SQLite, so the adapter and the idle queries are tested on Node
// against a real SQLite (DO SQLite's own limits are tested in workerd: test/*.workerd.test.ts).
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export const nodeSqlStorage = (db: DatabaseSync = new DatabaseSync(":memory:")): SqlStorage & { readonly db: DatabaseSync } => {
  const exec = (query: string, ...params: Array<unknown>) => {
    const statement = db.prepare(query);
    const reader = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i.test(query) || /\bRETURNING\b/i.test(query);
    if (!reader) {
      statement.run(...(params as Array<never>));
      return { columnNames: [], raw: () => [][Symbol.iterator](), toArray: () => [], rowsRead: 0, rowsWritten: 0 };
    }
    statement.setReturnArrays(true);
    const rows = statement.all(...(params as Array<never>)) as unknown as Array<Array<unknown>>;
    const columnNames = statement.columns().map((column) => column.name);
    return {
      columnNames,
      raw: () => rows[Symbol.iterator](),
      toArray: () => rows.map((row) => Object.fromEntries(columnNames.map((c, k) => [c, row[k]]))),
      rowsRead: rows.length,
      rowsWritten: 0,
    };
  };
  return { exec, db, databaseSize: 0 } as unknown as SqlStorage & { readonly db: DatabaseSync };
};
