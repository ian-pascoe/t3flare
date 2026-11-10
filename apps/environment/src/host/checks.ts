// @effect-diagnostics globalDate:off globalDateInEffect:off anyUnknownInErrorContext:off
// SQL checks through t3's own SQL client (ADR-0006), run by the admin route `/_t3flare/check/sql`:
// withTransaction rollback (and a nested savepoint rolled back alone), more than 100 bound parameters through
// the adapter's inlining, and how reads behave behind an open transaction.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sqlStats } from "../platform/sqlAdapter.ts";

class Rollback {
  readonly _tag = "Rollback";
}

export const sqlChecks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const results: Record<string, unknown> = {};
  yield* sql`DROP TABLE IF EXISTS t3flare_probe`;
  yield* sql`CREATE TABLE t3flare_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;

  // 1. withTransaction with rollback, and a nested savepoint rolled back on its own.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO t3flare_probe (id, label) VALUES (1, 'rolled back')`;
      return yield* Effect.fail(new Rollback());
    }),
  ).pipe(Effect.catchTag("Rollback", () => Effect.void));
  const afterRollback = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM t3flare_probe`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO t3flare_probe (id, label) VALUES (2, 'outer kept')`;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO t3flare_probe (id, label) VALUES (3, 'inner rolled back')`;
            return yield* Effect.fail(new Rollback());
          }),
        )
        .pipe(Effect.catchTag("Rollback", () => Effect.void));
    }),
  );
  const afterNested = yield* sql<{ id: number }>`SELECT id FROM t3flare_probe ORDER BY id`;
  results.transactionRollback = {
    rowsAfterRolledBackTransaction: afterRollback[0]?.n,
    rowsAfterNestedSavepointRollback: afterNested.map((row) => row.id),
    ok: afterRollback[0]?.n === 0 && afterNested.length === 1 && afterNested[0]?.id === 2,
  };

  // 2. More than 100 bound parameters: a 150-row insert and a 150-id IN list.
  const before = sqlStats.statementsInlined;
  const ids = Array.from({ length: 150 }, (_, i) => 1000 + i);
  yield* sql`INSERT INTO t3flare_probe ${sql.insert(ids.map((id): Record<string, unknown> => ({ id, label: `row '${id}' ?` })) as unknown as Record<string, unknown>)}`;
  const found = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM t3flare_probe WHERE id IN ${sql.in(ids)}`;
  const quoted = yield* sql<{ label: string }>`SELECT label FROM t3flare_probe WHERE id = ${1007}`;
  results.overHundredParameters = {
    parameters: ids.length * 2,
    found: found[0]?.n,
    labelRoundTrip: quoted[0]?.label,
    statementsInlined: sqlStats.statementsInlined - before,
    ok: found[0]?.n === 150 && quoted[0]?.label === "row '1007' ?",
  };

  // 3. Read latency behind an open transaction: a read issued while a 50 ms transaction
  // is open waits for it (no separate reader, unlike t3's Node client).
  const reads: Array<number> = [];
  const seen: Array<string> = [];
  const order: Array<string> = [];
  const wall0 = Date.now();
  const t0 = performance.now();
  yield* Effect.all(
    [
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE t3flare_probe SET label = 'locked' WHERE id = 2`;
          yield* Effect.sleep("50 millis");
          order.push(`tx-body-end@${Date.now() - wall0}`);
        }),
      ).pipe(Effect.tap(() => Effect.sync(() => order.push(`tx-committed@${Date.now() - wall0}`)))),
      Effect.gen(function* () {
        yield* Effect.sleep("5 millis");
        const start = performance.now();
        order.push(`read-issued@${Date.now() - wall0}`);
        const row = yield* sql<{ label: string }>`SELECT label FROM t3flare_probe WHERE id = 2`;
        order.push(`read-done@${Date.now() - wall0}`);
        reads.push(performance.now() - start);
        seen.push(row[0]?.label ?? "");
      }),
    ],
    { concurrency: "unbounded" },
  );
  const dirty: Array<string> = [];
  yield* Effect.all(
    [
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE t3flare_probe SET label = 'uncommitted' WHERE id = 2`;
            yield* Effect.sleep("30 millis");
            return yield* Effect.fail(new Rollback());
          }),
        )
        .pipe(Effect.catchTag("Rollback", () => Effect.void)),
      Effect.gen(function* () {
        yield* Effect.sleep("5 millis");
        const row = yield* sql<{ label: string }>`SELECT label FROM t3flare_probe WHERE id = 2`;
        dirty.push(row[0]?.label ?? "");
      }),
    ],
    { concurrency: "unbounded" },
  );
  const final = yield* sql<{ label: string }>`SELECT label FROM t3flare_probe WHERE id = 2`;
  results.isolation = { concurrentReadSaw: dirty[0], afterRollback: final[0]?.label };
  const baseline = performance.now();
  for (let i = 0; i < 20; i++) yield* sql`SELECT label FROM t3flare_probe WHERE id = 2`;
  results.readBehindTransaction = {
    readWaitMs: reads[0],
    labelSeenByConcurrentRead: seen[0],
    order,
    totalMs: performance.now() - t0,
    uncontendedReadMs: (performance.now() - baseline) / 20,
  };
  yield* sql`DROP TABLE t3flare_probe`;
  return results;
});

