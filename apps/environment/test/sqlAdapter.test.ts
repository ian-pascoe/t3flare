// The DO SQLite adapter's rewrites, checked for equal results against Node's SQLite (which has none of DO
// SQLite's limits, so the original and the rewritten statement can both run).
import { describe, expect, it } from "vitest";

import {
  MAX_BOUND_PARAMETERS,
  adaptedExec,
  inlineParameters,
  materializeCtes,
  rewriteCompoundSelects,
  splitWith,
  sqlLiteral,
} from "../src/platform/sqlAdapter.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const rows = (sql: ReturnType<typeof nodeSqlStorage>, query: string, ...params: Array<unknown>) =>
  Array.from(sql.exec(query, ...params).raw());

const seeded = () => {
  const sql = nodeSqlStorage();
  sql.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, kind TEXT, label TEXT)");
  for (let id = 1; id <= 40; id++) sql.exec("INSERT INTO items (id, kind, label) VALUES (?, ?, ?)", id, `k${id % 7}`, `it's ${id}`);
  return sql;
};

describe("sqlLiteral and inlineParameters", () => {
  it("escapes strings, numbers, booleans, nulls and blobs", () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral(3)).toBe("3");
    expect(sqlLiteral(10n)).toBe("10");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(new Uint8Array([0, 255]))).toBe("X'00ff'");
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });

  it("replaces placeholders but not question marks in strings or comments", () => {
    expect(inlineParameters("SELECT '?', ? -- why?\n, ? /* ? */", [1, "a'b"])).toBe("SELECT '?', 1 -- why?\n, 'a''b' /* ? */");
    expect(() => inlineParameters("SELECT ?, ?", [1])).toThrow("More placeholders");
    expect(() => inlineParameters("SELECT ?", [1, 2])).toThrow("More parameters");
  });

  it("returns the same rows inlined as bound, above the parameter limit", () => {
    const sql = seeded();
    const ids = Array.from({ length: MAX_BOUND_PARAMETERS + 20 }, (_, i) => i + 1);
    const query = `SELECT id, label FROM items WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`;
    expect(rows(sql, inlineParameters(query, ids))).toEqual(rows(sql, query, ...ids));
    expect(Array.from(adaptedExec(sql, query, ids).raw())).toHaveLength(40);
  });
});

describe("rewriteCompoundSelects", () => {
  const union = (n: number, op = "UNION ALL") =>
    Array.from({ length: n }, (_, i) => `SELECT id, label FROM items WHERE kind = 'k${i % 7}'`).join(` ${op} `);

  it("leaves compounds of up to five terms alone", () => {
    expect(rewriteCompoundSelects(union(5))).toBe(union(5));
  });

  it.each([6, 12, 25])("regroups %i terms into subqueries of at most five, with equal results", (n) => {
    const sql = seeded();
    const query = `${union(n)} ORDER BY id LIMIT 30`;
    const rewritten = rewriteCompoundSelects(query);
    expect(rewritten).not.toBe(query);
    for (const level of rewritten.split(/\(|\)/)) {
      expect((level.match(/\bUNION\b/g) ?? []).length).toBeLessThanOrEqual(4);
    }
    expect(rows(sql, rewritten)).toEqual(rows(sql, query));
  });

  it("keeps a leading WITH and mixes of UNION and UNION ALL", () => {
    const sql = seeded();
    const query = `WITH small AS (SELECT * FROM items WHERE id < 20) ${Array.from({ length: 9 }, (_, i) => `SELECT id FROM small WHERE id % 9 = ${i}`).join(" UNION ")} ORDER BY id`;
    expect(rows(sql, rewriteCompoundSelects(query))).toEqual(rows(sql, query));
  });

  it("rewrites a long compound nested inside a subquery", () => {
    const sql = seeded();
    const query = `SELECT COUNT(*) AS n FROM (${union(11)})`;
    expect(rows(sql, rewriteCompoundSelects(query))).toEqual(rows(sql, query));
  });
});

describe("splitWith and materializeCtes", () => {
  it("splits a WITH statement into its CTEs and main statement", () => {
    const split = splitWith("WITH a AS NOT MATERIALIZED (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b");
    expect(split?.ctes.map((c) => c.name)).toEqual(["a", "b"]);
    expect(split?.main).toBe("SELECT * FROM b");
    expect(splitWith("WITH RECURSIVE r(n) AS (SELECT 1) SELECT * FROM r")).toBeNull();
    expect(splitWith("SELECT 1")).toBeNull();
  });

  it("returns the rows of the original statement, with CTEs read through json_each", () => {
    const sql = seeded();
    const query = `WITH
      chosen AS NOT MATERIALIZED (SELECT id, kind, label FROM items WHERE id <= 25),
      counted AS (SELECT kind, COUNT(*) AS n FROM chosen GROUP BY kind)
      SELECT c.id, c.label, counted.n FROM chosen c JOIN counted ON counted.kind = c.kind
      WHERE c.id IN (SELECT id FROM chosen WHERE id % 2 = 1)
      ORDER BY c.id`;
    const fallback = materializeCtes(sql, query);
    expect(fallback).not.toBeNull();
    expect(fallback!.columnNames).toEqual(["id", "label", "n"]);
    expect(Array.from(fallback!.raw())).toEqual(rows(sql, query));
    expect(fallback!.toArray()[0]).toEqual({ id: 1, label: "it's 1", n: 4 });
  });

  it("declines CTEs with column lists", () => {
    expect(materializeCtes(seeded(), "WITH a(x) AS (SELECT 1) SELECT * FROM a")).toBeNull();
  });
});
