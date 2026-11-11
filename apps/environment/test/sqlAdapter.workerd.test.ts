// The DO SQLite adapter (ADR-0006) against DO SQLite's real limits in local workerd. (The ~100-expansion cap
// exists only on production; the deployed acceptance test covers it, scripts/acceptance.ts.)
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { adaptSqlStorage, materializeCtes, sqlStats } from "../src/platform/sqlAdapter.ts";

const union = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS v`).join(" UNION ALL ");

describe("DO SQLite adapter", () => {
  it("DO SQLite refuses six compound terms; the adapter regroups them with equal results", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("compound"), async (_instance, state) => {
      expect(() => state.storage.sql.exec(union(6)).toArray()).toThrow();
      const sql = adaptSqlStorage(state.storage.sql);
      const before = sqlStats.compoundsRewritten;
      const rows = sql.exec(`${union(12)} ORDER BY v`).toArray().map((row) => row.v);
      expect(rows).toEqual(Array.from({ length: 12 }, (_, i) => i));
      expect(sqlStats.compoundsRewritten).toBe(before + 1);
    });
  });

  it("DO SQLite refuses more than 100 parameters; the adapter inlines them", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("params"), async (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)");
      const ids = Array.from({ length: 150 }, (_, i) => i);
      const placeholders = ids.map(() => "(?, ?)").join(", ");
      const values = ids.flatMap((id) => [id, `it's ${id}?`]);
      expect(() => state.storage.sql.exec(`INSERT INTO t (id, label) VALUES ${placeholders}`, ...values)).toThrow();
      const sql = adaptSqlStorage(state.storage.sql);
      sql.exec(`INSERT INTO t (id, label) VALUES ${placeholders}`, ...values);
      const found = sql.exec(`SELECT COUNT(*) AS n FROM t WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids).one();
      expect(found.n).toBe(150);
      expect(sql.exec("SELECT label FROM t WHERE id = ?", 7).one().label).toBe("it's 7?");
    });
  });

  it("the CTE fallback returns what the statement returns, on DO SQLite", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("cte"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, kind TEXT)");
      for (let id = 1; id <= 30; id++) sql.exec("INSERT INTO items VALUES (?, ?)", id, `k${id % 4}`);
      const query = `WITH chosen AS NOT MATERIALIZED (SELECT id, kind FROM items WHERE id <= 20),
        counted AS (SELECT kind, COUNT(*) AS n FROM chosen GROUP BY kind)
        SELECT c.id, counted.n FROM chosen c JOIN counted ON counted.kind = c.kind ORDER BY c.id`;
      expect(Array.from(materializeCtes(sql, query)!.raw())).toEqual(Array.from(sql.exec(query).raw()));
    });
  });

  it("answers t3's storage PRAGMAs, which DO SQLite refuses or t3 reads every minute, without an error (cost audit F8)", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("pragma"), async (_instance, state) => {
      expect(() => state.storage.sql.exec("PRAGMA auto_vacuum").toArray()).toThrow(/not authorized/);
      const sql = adaptSqlStorage(state.storage.sql);
      const errors = sqlStats.errors.length;
      // t3's DatabaseStorage: auto_vacuum 0 (none) means no incremental vacuum, so its reclaim does nothing.
      expect(sql.exec("PRAGMA auto_vacuum").toArray()).toEqual([{ auto_vacuum: 0 }]);
      expect(sql.exec(" pragma AUTO_VACUUM; ").toArray()).toEqual([{ auto_vacuum: 0 }]);
      // Read next for t3's Storage page; DO SQLite refuses both, but answers page_size.
      expect(sql.exec("PRAGMA page_count").toArray()).toEqual([{ page_count: 0 }]);
      expect(sql.exec("PRAGMA freelist_count").toArray()).toEqual([{ freelist_count: 0 }]);
      expect(sql.exec("PRAGMA page_size").one().page_size).toBeGreaterThan(0);
      expect(sqlStats.errors.length).toBe(errors);
      // Setting it is not answered: it still reaches DO SQLite.
      expect(() => sql.exec("PRAGMA auto_vacuum = 2").toArray()).toThrow();
    });
  });

  it("counts the rows t3's statements write and read, as DO SQLite reports them (cost audit F2)", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("counters"), async (_instance, state) => {
      const sql = adaptSqlStorage(state.storage.sql);
      sql.exec("CREATE TABLE c (v INTEGER)");
      const written = sqlStats.rowsWritten;
      sql.exec("INSERT INTO c VALUES (1), (2), (3)");
      expect(sqlStats.rowsWritten - written).toBe(3);
      const read = sqlStats.rowsRead;
      const select = sql.exec("SELECT v FROM c");
      expect(Array.from(select.raw())).toEqual([[1], [2], [3]]);
      expect(sqlStats.rowsRead - read).toBeGreaterThanOrEqual(3);
      expect(sqlStats.rowsRead - read).toBe(select.rowsRead);
      const before = sqlStats.rowsWritten;
      const cursor = sql.exec("UPDATE c SET v = v + 1 RETURNING v");
      for (const _row of cursor) {
        // consumed row by row, as t3's client may
      }
      expect(sqlStats.rowsWritten - before).toBe(3);
    });
  });

  it("nested transactionSync, as the State directory's rename runs inside a remove", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("tx"), async (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE n (v INTEGER)");
      state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO n VALUES (1)");
        state.storage.transactionSync(() => state.storage.sql.exec("INSERT INTO n VALUES (2)"));
      });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS c FROM n").one().c).toBe(2);
    });
  });
});
